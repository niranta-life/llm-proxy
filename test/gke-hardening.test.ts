import { connect } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pools.js';
import { createLogger } from '../src/logger.js';
import {
  configFor,
  createTestApp,
  freePort,
  loadTestDatabase,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForExit,
  waitForReady,
} from './helpers.js';

const db = loadTestDatabase();

function configWith(overrides: Record<string, string | undefined>) {
  return loadConfig(serviceEnv(db, overrides));
}

describe('configuration for deployment', () => {
  it('defaults migration timeouts and the http keep-alive', () => {
    const config = configWith({});
    expect(config.migrationLockTimeoutMs).toBe(60_000);
    expect(config.migrationStatementTimeoutMs).toBe(600_000);
    expect(config.httpKeepAliveTimeoutMs).toBe(620_000);
  });

  it('reads overrides', () => {
    const config = configWith({
      MIGRATION_LOCK_TIMEOUT_MS: '5000',
      MIGRATION_STATEMENT_TIMEOUT_MS: '7000',
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '90000',
    });
    expect(config.migrationLockTimeoutMs).toBe(5000);
    expect(config.migrationStatementTimeoutMs).toBe(7000);
    expect(config.httpKeepAliveTimeoutMs).toBe(90_000);
  });

  it.each([
    ['MIGRATION_LOCK_TIMEOUT_MS', '0'],
    ['MIGRATION_LOCK_TIMEOUT_MS', '3600001'],
    ['MIGRATION_STATEMENT_TIMEOUT_MS', 'abc'],
    ['MIGRATION_STATEMENT_TIMEOUT_MS', '-5'],
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', '999'],
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', '3600001'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => configWith({ [key]: value })).toThrow(
      `${key} must be an integer from 1000 to 3600000 milliseconds`,
    );
  });
});

describe('database pools', () => {
  const pools: { end: () => Promise<unknown> }[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('keeps the 5 s client timeout for runtime and auth, and sets tcp keep-alive delay', () => {
    const config = configFor(db);
    for (const role of ['runtime', 'auth'] as const) {
      const pool = createPool(config, role);
      pools.push(pool);
      expect(pool.options.query_timeout).toBe(5_000);
      expect(pool.options.keepAliveInitialDelayMillis).toBe(10_000);
    }
  });

  it('keeps the 5 s client timeout and no server timeouts for the migrator role used by admin commands', async () => {
    const pool = createPool(configWith({}), 'migrator', undefined, 1);
    pools.push(pool);
    expect(pool.options.query_timeout).toBe(5_000);
    const lock = await pool.query('SHOW lock_timeout');
    expect(lock.rows[0]).toEqual({ lock_timeout: '0' });
  });

  it('gives the migration policy no client timeout and server-side lock and statement timeouts', async () => {
    const config = configWith({
      MIGRATION_LOCK_TIMEOUT_MS: '60000',
      MIGRATION_STATEMENT_TIMEOUT_MS: '600000',
    });
    const pool = createPool(config, 'migrator', undefined, 1, 'migration');
    pools.push(pool);
    expect(pool.options.query_timeout).toBeUndefined();
    expect(pool.options.keepAliveInitialDelayMillis).toBe(10_000);
    const lock = await pool.query('SHOW lock_timeout');
    const statement = await pool.query('SHOW statement_timeout');
    const path = await pool.query('SHOW search_path');
    expect(lock.rows[0]).toEqual({ lock_timeout: '1min' });
    expect(statement.rows[0]).toEqual({ statement_timeout: '10min' });
    expect(path.rows[0]).toEqual({ search_path: 'public' });
  });

  it('lets the migration policy run a query longer than 5 s', async () => {
    const pool = createPool(configWith({}), 'migrator', undefined, 1, 'migration');
    pools.push(pool);
    const result = await pool.query('SELECT pg_sleep(5.5), 1 AS ok');
    expect(result.rows[0]).toMatchObject({ ok: 1 });
  }, 20_000);

  it('fails a migration that waits on the advisory lock past the lock timeout', async () => {
    const pool = createPool(configWith({ MIGRATION_LOCK_TIMEOUT_MS: '1000' }), 'migrator', undefined, 2, 'migration');
    pools.push(pool);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(424242::bigint)');
      await expect(migrate(pool)).rejects.toThrow(/lock timeout/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(424242::bigint)');
      holder.release();
    }
  });

  it('applies the server-side statement timeout to the migration policy', async () => {
    const pool = createPool(
      configWith({ MIGRATION_STATEMENT_TIMEOUT_MS: '1000' }),
      'migrator',
      undefined,
      1,
      'migration',
    );
    pools.push(pool);
    await expect(pool.query('SELECT pg_sleep(3)')).rejects.toThrow(/statement timeout/);
  });
});

describe('http server timeouts', () => {
  it('defaults keep-alive above the Google load balancer and bounds slow headers at 60 s', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    try {
      expect(app.server.keepAliveTimeout).toBe(620_000);
      expect(app.server.headersTimeout).toBe(60_000);
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });

  it('takes the keep-alive from the app dependencies without moving headersTimeout', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db, { keepAliveTimeoutMs: 90_000 });
    try {
      expect(app.server.keepAliveTimeout).toBe(90_000);
      expect(app.server.headersTimeout).toBe(60_000);
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });
});

describe('admission during shutdown', () => {
  function gated() {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { started, startedPromise, released, release };
  }

  it('refuses a request that arrives after shutdown began, but still answers health', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    try {
      const draining = app.drainStreams(50);
      const late = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(late.statusCode).toBe(503);
      expect(late.headers.connection).toBe('close');
      expect(late.headers['retry-after']).toBe('1');
      expect(late.json()).toMatchObject({ error: { code: 'shutting_down' } });
      const live = await app.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      await draining;
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });

  it('closes the connection after a request admitted before shutdown finishes during the drain', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    const gate = gated();
    app.get('/held', async () => {
      gate.started();
      await gate.released;
      return { done: true };
    });
    try {
      const admitted = app.inject({ method: 'GET', url: '/held' });
      await gate.startedPromise;
      const drain = app.drain(2_000);
      gate.release();
      const response = await admitted;
      expect(response.statusCode).toBe(200);
      expect(response.headers.connection).toBe('close');
      expect((await drain).requestsIdle).toBe(true);
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });

  it('does not report idle while an admitted request is still active', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    const gate = gated();
    app.get('/held', async () => {
      gate.started();
      await gate.released;
      return { done: true };
    });
    try {
      const admitted = app.inject({ method: 'GET', url: '/held' });
      await gate.startedPromise;
      const result = await app.drain(50);
      expect(result.requestsIdle).toBe(false);
      gate.release();
      await admitted;
      expect(await app.drainRequests(1_000)).toBe(true);
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });

  it('keeps a request in flight after the client disconnects until its handler settles', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    const gate = gated();
    app.get('/held', async () => {
      gate.started();
      await gate.released;
      return { done: true };
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const socket = connect(address.port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.write('GET /held HTTP/1.1\r\nHost: x\r\n\r\n');
      await gate.startedPromise;
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await app.drainRequests(100)).toBe(false);
      gate.release();
      expect(await app.drainRequests(2_000)).toBe(true);
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });
});

describe('shutdown', () => {
  it('turns readiness to 503 as soon as draining begins', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    try {
      const before = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(before.statusCode).toBe(200);
      const draining = app.drainStreams(50);
      const during = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(during.statusCode).toBe(503);
      expect(during.json()).toEqual({ status: 'not_ready', reason: 'shutting_down' });
      await draining;
      const live = await app.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });

  it('waits for in-flight requests within the drain window and gives up after it', async () => {
    const { app, authPool, runtimePool } = await createTestApp(db);
    let handlerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    app.get('/slow', async () => {
      handlerStarted();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { done: true };
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${address.port}/slow`;

      expect(await app.drainRequests(100)).toBe(true);

      const finished = fetch(url).then((response) => response.json());
      await started;
      expect(await app.drainRequests(50)).toBe(false);
      expect(await app.drainRequests(2_000)).toBe(true);
      expect(await finished).toEqual({ done: true });
    } finally {
      await app.close();
      await authPool.end();
      await runtimePool.end();
    }
  });
});

async function pollReadyUntilNotOk(port: number, deadlineMs = 5_000): Promise<Response> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    if (response.status !== 200 || Date.now() > deadline) return response;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('shutdown of the process', () => {
  it('reports not ready while draining, then closes the pools and exits 0', async () => {
    const port = await freePort();
    const server = spawnServer(serviceEnv(db, { PORT: String(port), STREAM_SHUTDOWN_DRAIN_MS: '3000' }));
    try {
      await waitForReady(port);
      // An unfinished upload is an in-flight request, so it holds the drain window open.
      const held = connect(port, '127.0.0.1');
      held.on('error', () => undefined);
      held.write(
        'POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      server.child.kill('SIGTERM');
      const ready = await pollReadyUntilNotOk(port);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'not_ready', reason: 'shutting_down' });
      expect(await waitForExit(server.child, 15_000)).toBe(0);
      held.destroy();
      expect(server.output()).toContain('"pools":"closed"');
    } finally {
      await stopChild(server.child);
    }
  });
});

describe('logger severity', () => {
  function capture(level: 'debug' | 'info' | 'warn' | 'error') {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    return { logger: createLogger(level, stream), lines };
  }

  it('adds a Cloud Logging severity beside level and msg', () => {
    const { logger, lines } = capture('debug');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => [event.level, event.severity, event.msg])).toEqual([
      ['debug', 'DEBUG', 'a'],
      ['info', 'INFO', 'b'],
      ['warn', 'WARNING', 'c'],
      ['error', 'ERROR', 'd'],
    ]);
  });

  it('still redacts secrets', () => {
    const { logger, lines } = capture('info');
    logger.info('x', { password: 'hunter2-secret' });
    expect(lines[0]).not.toContain('hunter2-secret');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ severity: 'INFO' });
  });

  it('emits the Cloud Logging message beside msg', () => {
    const { logger, lines } = capture('info');
    logger.info('hello');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ msg: 'hello', message: 'hello' });
  });

  it('never lets caller fields overwrite core keys', () => {
    const { logger, lines } = capture('warn');
    logger.warn('real', {
      severity: 'FAKE',
      msg: 'fake msg',
      level: 'fake',
      time: 'fake time',
      message: 'exception detail',
    });
    const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(event).toMatchObject({
      severity: 'WARNING',
      msg: 'real',
      message: 'real',
      level: 'warn',
      error_message: 'exception detail',
      field_severity: 'FAKE',
      field_msg: 'fake msg',
      field_level: 'fake',
      field_time: 'fake time',
    });
    expect(event.time).not.toBe('fake time');
  });

  it('maps a caller severity of critical to Cloud Logging CRITICAL', () => {
    const { logger, lines } = capture('error');
    logger.error('alert', { severity: 'critical' });
    const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(event).toMatchObject({ severity: 'CRITICAL', level: 'error' });
    expect(event).not.toHaveProperty('field_severity');
  });

  it('keeps any other caller severity out of the core severity', () => {
    const { logger, lines } = capture('error');
    logger.error('alert', { severity: 'high' });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ severity: 'ERROR', field_severity: 'high' });
  });
});
