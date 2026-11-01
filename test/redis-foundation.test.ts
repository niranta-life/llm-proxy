import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClient } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { periodStart, windowStart } from '../src/inference/admission.js';
import { createRateLimitStore, PostgresRateLimitStore } from '../src/inference/rate-limit-store.js';
import {
  captureLogger,
  configFor,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForExit,
  waitForReady,
} from './helpers.js';
import { chatPayload, cliEnv, credentialKeyText, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const exec = promisify(execFile);
const db = loadTestDatabase();
const PROXY_PASSWORD = 'local_redis_shadow_pw';
const INSPECTOR_PASSWORD = 'inspector_shadow_pw';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-11a');
const EFFECTIVE = '2025-12-01T00:00:00.000Z';

type RedisReport = {
  mode: string;
  redis: string;
  connectFailures: number;
  reconnects: number;
  pings: number;
  lastError: string | null;
};

function contentOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

function baseEnv(port: number, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return serviceEnv(db, {
    PORT: String(port),
    INFERENCE_ENABLED: 'true',
    PROVIDER_CREDENTIAL_KEY: credentialKeyText,
    OPENAI_BASE_URL: upstream,
    ...overrides,
  });
}

function shadowSettings(url: string, password = PROXY_PASSWORD, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    RATE_LIMIT_STORE: 'redis_shadow',
    REDIS_URL: url,
    REDIS_USERNAME: 'proxy',
    REDIS_PASSWORD: password,
    REDIS_TLS: url.startsWith('rediss:') ? 'true' : 'false',
    REDIS_CONNECT_TIMEOUT_MS: '500',
    REDIS_RECONNECT_TIMEOUT_MS: '500',
    ...extra,
  };
}

let upstream = 'http://127.0.0.1:9/v1';
let plain: StartedTestContainer | undefined;
let tlsRedis: StartedTestContainer | undefined;
let plainUrl = '';
let tlsUrl = '';
let caFile = '';
let wrongCaFile = '';
let mockClose: (() => Promise<void>) | undefined;
const held = new Map<string, import('node:http').ServerResponse>();

async function proxyLines(): Promise<string[]> {
  const inspector = createClient({
    url: plainUrl,
    username: 'inspector',
    password: INSPECTOR_PASSWORD,
    disableClientInfo: true,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: () => false },
  });
  inspector.on('error', () => undefined);
  await inspector.connect();
  try {
    const list = String(await inspector.sendCommand(['CLIENT', 'LIST']));
    return list.split('\n').filter((line) => line.includes('user=proxy'));
  } finally {
    await inspector.quit();
  }
}

async function redisKeys(): Promise<string[]> {
  const inspector = createClient({
    url: plainUrl,
    username: 'inspector',
    password: INSPECTOR_PASSWORD,
    disableClientInfo: true,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: () => false },
  });
  inspector.on('error', () => undefined);
  await inspector.connect();
  try {
    const found: string[] = [];
    let cursor = '0';
    do {
      const reply = (await inspector.sendCommand(['SCAN', cursor, 'COUNT', '100'])) as [string, string[]];
      cursor = String(reply[0]);
      found.push(...reply[1]);
    } while (cursor !== '0');
    const values: string[] = [];
    for (const key of found) {
      const value = await inspector.sendCommand(['GET', key]);
      values.push(`${key}=${String(value)}`);
    }
    return values;
  } finally {
    await inspector.quit();
  }
}

async function readRedis(port: number): Promise<RedisReport> {
  const response = await fetch(`http://127.0.0.1:${port}/health/redis`);
  expect(response.status).toBe(200);
  return (await response.json()) as RedisReport;
}

async function waitRedis(port: number, state: string): Promise<RedisReport> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 20_000) {
    try {
      const report = await readRedis(port);
      last = JSON.stringify(report);
      if (report.redis === state) return report;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`redis ${state} timeout: ${last}`);
}

async function postChat(port: number, tenantId: string, secret: string, content: string, model = 'auto'): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: chatPayload(model, content),
  });
  return { status: response.status, body: await response.text() };
}

function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

describe('optional redis foundation', () => {
  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    const shipped = readFileSync(join(projectRoot, 'docker/redis/users.acl'), 'utf8');
    expect(shipped).toContain('user default off');
    expect(shipped).toContain('-@all');
    expect(shipped).toContain('+ping');
    expect(shipped).toContain('+auth');
    expect(shipped).toContain('+quit');
    expect(shipped).toContain('+evalsha');
    expect(shipped).toContain('+script|load');
    expect(shipped).toContain('+hdel');
    expect(shipped).toContain('+hgetall');
    expect(shipped).toContain('~rl:*');
    expect(shipped).not.toContain('+@all');
    expect(shipped).not.toContain('+set');
    expect(shipped).not.toContain('+get');
    expect(shipped).not.toContain('+config');
    expect(shipped).not.toContain('+acl');
    expect(shipped).not.toContain('+keys');
    expect(shipped).not.toContain('+flush');
    const runtimeAcl = `${shipped.trim()}\nuser inspector on resetpass >${INSPECTOR_PASSWORD} resetkeys ~* &* +@all\n`;
    // Docker assigns a new host port when the published port is ephemeral.
    // A fixed host port keeps the proxy URL valid across stop and restart.
    const plainHostPort = await freePort();
    plain = await new GenericContainer('redis:7')
      .withCopyContentToContainer([{ content: runtimeAcl, target: '/opt/users.acl', mode: 0o644 }])
      .withCommand(['redis-server', '--aclfile', '/opt/users.acl', '--port', '6379', '--appendonly', 'no'])
      .withExposedPorts({ container: 6379, host: plainHostPort })
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(60_000)
      .start();
    plainUrl = `redis://127.0.0.1:${plain.getMappedPort(6379)}`;

    const certDir = mkdtempSync(join(tmpdir(), 'llm-proxy-redis-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-nodes', '-subj', '/CN=redis-ca'], { cwd: certDir });
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-keyout', 'redis.key', '-out', 'redis.csr', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { cwd: certDir });
    execFileSync('openssl', ['x509', '-req', '-in', 'redis.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'redis.crt', '-days', '1', '-copy_extensions', 'copy'], { cwd: certDir });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'wrong.key', '-out', 'wrong.crt', '-days', '1', '-nodes', '-subj', '/CN=wrong-ca'], { cwd: certDir });
    caFile = join(certDir, 'ca.crt');
    wrongCaFile = join(certDir, 'wrong.crt');
    tlsRedis = await new GenericContainer('redis:7')
      .withCopyContentToContainer([
        { content: runtimeAcl, target: '/opt/users.acl', mode: 0o644 },
        { content: readFileSync(join(certDir, 'ca.crt')), target: '/opt/tls/ca.crt', mode: 0o644 },
        { content: readFileSync(join(certDir, 'redis.crt')), target: '/opt/tls/redis.crt', mode: 0o644 },
        { content: readFileSync(join(certDir, 'redis.key')), target: '/opt/tls/redis.key', mode: 0o644 },
      ])
      .withCommand([
        'redis-server',
        '--aclfile', '/opt/users.acl',
        '--port', '0',
        '--tls-port', '6379',
        '--tls-cert-file', '/opt/tls/redis.crt',
        '--tls-key-file', '/opt/tls/redis.key',
        '--tls-ca-cert-file', '/opt/tls/ca.crt',
        '--tls-auth-clients', 'no',
        '--appendonly', 'no',
      ])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(60_000)
      .start();
    tlsUrl = `rediss://127.0.0.1:${tlsRedis.getMappedPort(6379)}`;

    const mock = await startMockUpstream((hit: MockHit, _request, response) => {
      const content = contentOf(hit.body);
      if (content.startsWith('hold-')) {
        held.set(content, response);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', `completion-for-${content}`)));
    });
    upstream = mock.baseUrl;
    mockClose = mock.close;
  }, 180_000);

  afterAll(async () => {
    for (const response of held.values()) {
      if (!response.writableEnded) response.end();
    }
    if (mockClose) await mockClose();
    await plain?.stop();
    await tlsRedis?.stop();
  });

  it('keeps postgres as the default and rejects invalid redis settings without secrets', () => {
    const plainConfig = loadConfig(serviceEnv(db));
    expect(plainConfig.rateLimitMode).toBe('postgres');
    expect(plainConfig.redis).toBeNull();
    const explicit = loadConfig(serviceEnv(db, {
      RATE_LIMIT_STORE: 'postgres',
      REDIS_URL: plainUrl,
      REDIS_USERNAME: 'proxy',
      REDIS_PASSWORD: PROXY_PASSWORD,
      REDIS_CONNECT_TIMEOUT_MS: '0',
    }));
    expect(explicit.rateLimitMode).toBe('postgres');
    expect(explicit.redis).toBeNull();

    const secret = 'redis-shadow-secret-value';
    expect(() => loadConfig(serviceEnv(db, { RATE_LIMIT_STORE: 'redis' }))).toThrow(/RATE_LIMIT_STORE/);
    expect(() => loadConfig(serviceEnv(db, { RATE_LIMIT_STORE: 'redis_shadow' }))).toThrow(/REDIS_URL/);
    expect(() => loadConfig(serviceEnv(db, shadowSettings(plainUrl, secret, { REDIS_CONNECT_TIMEOUT_MS: '0' })))).toThrow(/REDIS_CONNECT_TIMEOUT_MS/);
    expect(() => loadConfig(serviceEnv(db, shadowSettings(plainUrl, secret, { REDIS_RECONNECT_TIMEOUT_MS: '100000' })))).toThrow(/REDIS_RECONNECT_TIMEOUT_MS/);
    expect(() => loadConfig(serviceEnv(db, shadowSettings(`redis://proxy:${secret}@127.0.0.1:6379`, secret)))).toThrow(/credentials/);
    expect(() => loadConfig(serviceEnv(db, shadowSettings(plainUrl, secret, { REDIS_USERNAME: 'default' })))).toThrow(/REDIS_USERNAME/);
    expect(() => loadConfig(serviceEnv(db, shadowSettings(tlsUrl, secret, { REDIS_TLS: 'false', REDIS_TLS_CA_FILE: caFile })))).toThrow(/REDIS_TLS must match/);
    try {
      loadConfig(serviceEnv(db, shadowSettings(`redis://proxy:${secret}@127.0.0.1:6379`, secret)));
      throw new Error('loadConfig accepted a redis URL with credentials');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const text = JSON.stringify({ message: (error as ConfigError).message, errors: (error as ConfigError).errors });
      expect(text).not.toContain(secret);
      expect(text).not.toContain(db.passwords.runtime);
    }
    const valid = loadConfig(serviceEnv(db, shadowSettings(plainUrl)));
    expect(valid.rateLimitMode).toBe('redis_shadow');
    expect(valid.redis?.username).toBe('proxy');
    expect(valid.redis?.tls).toBe(false);
    expect(valid.redis?.connectTimeoutMs).toBe(500);
  });

  it('serves postgres readiness twice when redis is not configured', async () => {
    for (const [index, file] of ['launch-no-redis-1.txt', 'launch-no-redis-2.txt'].entries()) {
      const port = await freePort();
      const before = await proxyLines();
      const started = spawnServer(baseEnv(port));
      try {
        const ready = await waitForReady(port);
        const report = await readRedis(port);
        expect(ready).toEqual({ status: 'ready', database: 'ready' });
        expect(report.mode).toBe('postgres');
        expect(report.redis).toBe('disabled');
        expect(await proxyLines()).toEqual(before);
        const text = [
          `run ${index + 1}`,
          `GET /health/ready ${JSON.stringify(ready)}`,
          `GET /health/redis ${JSON.stringify(report)}`,
        ].join('\n');
        writeFileSync(join(EVIDENCE, file), `${text}\n`);
        console.log(`REDIS_CASE ${JSON.stringify({ case: 'no-redis', run: index + 1, ready, redis: report.redis })}`);
      } finally {
        await stopChild(started.child);
      }
    }
  });

  it('opens no redis client when the mode is postgres', async () => {
    const port = await freePort();
    const before = await proxyLines();
    const started = spawnServer(baseEnv(port, {
      RATE_LIMIT_STORE: 'postgres',
      REDIS_URL: plainUrl,
      REDIS_USERNAME: 'proxy',
      REDIS_PASSWORD: PROXY_PASSWORD,
      REDIS_TLS: 'false',
    }));
    try {
      const ready = await waitForReady(port);
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      const report = await readRedis(port);
      expect(report).toMatchObject({ mode: 'postgres', redis: 'disabled' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await proxyLines()).toEqual(before);
      expect(started.output()).not.toContain(PROXY_PASSWORD);
    } finally {
      await stopChild(started.child);
    }
  });

  it('exits before listen when redis settings are invalid and does not echo the secret', async () => {
    const secret = 'redis-shadow-secret-value';
    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(`redis://proxy:${secret}@127.0.0.1:1`, secret)));
    const code = await waitForExit(started.child, 10_000);
    const output = started.output();
    expect(code).toBe(1);
    expect(output).toContain('invalid configuration');
    expect(output).not.toContain('listening');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(PROXY_PASSWORD);
    await expect(fetch(`http://127.0.0.1:${port}/health/ready`)).rejects.toThrow();
    writeFileSync(join(EVIDENCE, 'connection-failures.txt'), `invalid-config exit ${code}\n${output}\n`);
  });

  it('connects in redis_shadow and keeps postgresql admission', async () => {
    const port = await freePort();
    const tenant = provisionTenant(db, 'Redis Shadow Rate');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-shadow-rate',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1'], cliEnv());
    const started = spawnServer(baseEnv(port, shadowSettings(plainUrl)));
    try {
      const ready = await waitForReady(port);
      const report = await waitRedis(port, 'connected');
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      expect(report.mode).toBe('redis_shadow');
      expect(report.lastError).toBeNull();
      const allowed = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-shadow-allow');
      expect(allowed.status).toBe(200);
      expect(errorCode(allowed.body)).toBeUndefined();
      const denied = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-shadow-deny');
      expect(denied.status).toBe(429);
      expect(errorCode(denied.body)).toBe('tenant_rate_limited');
      const lines = await proxyLines();
      expect(lines.length).toBeGreaterThan(0);
      const probe = createClient({
        url: plainUrl,
        username: 'proxy',
        password: PROXY_PASSWORD,
        disableClientInfo: true,
        socket: { connectTimeout: 1000, reconnectStrategy: () => false },
      });
      probe.on('error', () => undefined);
      await probe.connect();
      await expect(probe.sendCommand(['SET', 'secret', tenant.secret])).rejects.toThrow(/NOPERM/);
      await probe.quit();
      expect(started.output()).not.toContain(tenant.secret);
      expect(started.output()).not.toContain(PROXY_PASSWORD);
      expect(started.output()).not.toContain('prompt-shadow-allow');
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'connected', code: errorCode(denied.body), redis: report.redis })}`);
    } finally {
      await stopChild(started.child);
    }
  });

  it('uses the postgresql rate limit store for allow and deny', async () => {
    const tenant = provisionTenant(db, 'Redis Store Direct');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-store-direct',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-store',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1'], cliEnv());
    const store = createRateLimitStore();
    expect(store).toBeInstanceOf(PostgresRateLimitStore);
    const runtime = createPool(configFor(db), 'runtime', captureLogger().logger, 1);
    try {
      const decision = await withTenant(runtime, tenant.tenantId, async (client) => {
        const ids = await client.query<{
          connection_id: string;
          credential_version: number;
          deployment_id: string;
          config_version: number;
          upstream_model: string;
          api_key_id: string;
        }>(
          `SELECT c.id AS connection_id, c.credential_version, d.id AS deployment_id, d.config_version, d.upstream_model, k.id AS api_key_id
           FROM provider_connections c
           JOIN model_deployments d ON d.tenant_id = c.tenant_id AND d.connection_id = c.id
           JOIN tenant_api_keys k ON k.tenant_id = c.tenant_id
           WHERE c.tenant_id = $1 AND d.name = 'redis-chat'`,
          [tenant.tenantId],
        );
        const row = ids.rows[0];
        if (row === undefined) throw new Error('deployment is missing');
        const request = await client.query<{ id: string }>(
          `INSERT INTO proxy_requests (
             tenant_id, deployment_id, deployment_config_version, connection_id, connection_version, requested_model, status
           ) VALUES ($1, $2, $3, $4, $5, 'redis-chat', 'pending')
           RETURNING id`,
          [tenant.tenantId, row.deployment_id, row.config_version, row.connection_id, row.credential_version],
        );
        const requestId = request.rows[0]?.id;
        if (requestId === undefined) throw new Error('request was not created');
        const attempt = await client.query<{ id: string }>(
          `INSERT INTO model_attempts (
             tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status,
             attempt_ordinal, policy_id, policy_version, trigger_reason, fallback_policy_id, fallback_policy_version
           ) VALUES ($1, $2, $3, $4, $5, 'pending', 1, NULL, 1, 'primary', NULL, NULL)
           RETURNING id`,
          [tenant.tenantId, requestId, row.deployment_id, row.config_version, row.upstream_model],
        );
        const attemptId = attempt.rows[0]?.id;
        if (attemptId === undefined) throw new Error('attempt was not created');
        const now = new Date();
        return store.admit(client, {
          tenantId: tenant.tenantId,
          apiKeyId: row.api_key_id,
          connectionId: row.connection_id,
          deploymentId: row.deployment_id,
          attemptId,
          stream: false,
          now,
          windowStart: windowStart(now.getTime()),
          periodStart: periodStart(now.getTime()),
          tokenBound: null,
          estimate: null,
          estimateKind: 'unknown',
          priceVersionId: null,
        });
      });
      expect(decision).toEqual({ decision: 'allow', reason: 'allowed' });
    } finally {
      await runtime.end();
    }

    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(plainUrl)));
    try {
      await waitForReady(port);
      await waitRedis(port, 'connected');
      const denied = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-store-deny');
      expect(denied.status).toBe(429);
      expect(errorCode(denied.body)).toBe('tenant_rate_limited');
    } finally {
      await stopChild(started.child);
    }
  });

  it('keeps budget and concurrency denials while redis is up and while it is down', async () => {
    const budget = provisionTenant(db, 'Redis Shadow Budget');
    const heldTenant = provisionTenant(db, 'Redis Shadow Lease');
    registerInference(db, {
      tenantId: budget.tenantId,
      apiKey: 'sk-redis-shadow-budget',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-budget',
    });
    registerInference(db, {
      tenantId: heldTenant.tenantId,
      apiKey: 'sk-redis-shadow-lease',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-lease',
    });
    runCli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-redis-shadow-budget',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified',
      '--input-rate', '0.01',
    ], cliEnv());
    runCli(db, ['set-tenant-budget', '--tenant-id', budget.tenantId, '--mode', 'hard', '--monthly-amount', '0'], cliEnv());
    runCli(db, ['set-tenant-limits', '--tenant-id', heldTenant.tenantId, '--mode', 'hard', '--concurrent-requests', '1'], cliEnv());

    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(plainUrl)));
    try {
      await waitForReady(port);
      await waitRedis(port, 'connected');
      const overBudget = await postChat(port, budget.tenantId, budget.secret, 'prompt-budget-up');
      expect(overBudget.status).toBe(429);
      expect(errorCode(overBudget.body)).toBe('budget_exceeded');
      const first = postChat(port, heldTenant.tenantId, heldTenant.secret, 'hold-lease-up');
      const startedHold = Date.now();
      while (!held.has('hold-lease-up')) {
        if (Date.now() - startedHold > 10_000) throw new Error('lease hold did not start');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const blocked = await postChat(port, heldTenant.tenantId, heldTenant.secret, 'prompt-lease-up');
      expect(blocked.status).toBe(429);
      expect(errorCode(blocked.body)).toBe('concurrency_limited');
      const release = held.get('hold-lease-up');
      release?.writeHead(200, { 'content-type': 'application/json' });
      release?.end(JSON.stringify(completionBody('gpt-test', 'completion-for-hold-lease-up')));
      expect((await first).status).toBe(200);

      if (plain === undefined) throw new Error('redis container is missing');
      await exec('docker', ['stop', plain.getId()]);
      const during = await waitRedis(port, 'unavailable');
      const readyDuring = await waitForReady(port);
      expect(readyDuring).toEqual({ status: 'ready', database: 'ready' });
      const overBudgetDown = await postChat(port, budget.tenantId, budget.secret, 'prompt-budget-down');
      expect(overBudgetDown.status).toBe(429);
      expect(errorCode(overBudgetDown.body)).toBe('budget_exceeded');
      const secondHold = postChat(port, heldTenant.tenantId, heldTenant.secret, 'hold-lease-down');
      const downHold = Date.now();
      while (!held.has('hold-lease-down')) {
        if (Date.now() - downHold > 10_000) throw new Error('lease hold did not start while redis was down');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const blockedDown = await postChat(port, heldTenant.tenantId, heldTenant.secret, 'prompt-lease-down');
      expect(blockedDown.status).toBe(429);
      expect(errorCode(blockedDown.body)).toBe('concurrency_limited');
      const releaseDown = held.get('hold-lease-down');
      releaseDown?.writeHead(200, { 'content-type': 'application/json' });
      releaseDown?.end(JSON.stringify(completionBody('gpt-test', 'completion-for-hold-lease-down')));
      expect((await secondHold).status).toBe(200);
      expect(during.redis).toBe('unavailable');
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'redis-down', budget: 'budget_exceeded', lease: 'concurrency_limited', ready: readyDuring.status })}`);
    } finally {
      await stopChild(started.child);
      if (plain !== undefined) {
        await exec('docker', ['start', plain.getId()]).catch(() => undefined);
        const deadline = Date.now() + 20_000;
        let last = 'down';
        while (Date.now() < deadline) {
          try {
            await proxyLines();
            last = 'up';
            break;
          } catch (error) {
            last = error instanceof Error ? error.message : 'down';
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        if (last !== 'up') throw new Error(`redis did not return: ${last}`);
      }
    }
  });

  it('isolates tenant counters and stores no secret, prompt, or response', async () => {
    const alpha = provisionTenant(db, 'Redis Shadow Alpha');
    const beta = provisionTenant(db, 'Redis Shadow Beta');
    const alphaPrompt = `prompt-alpha-${alpha.tenantId}`;
    const betaPrompt = `prompt-beta-${beta.tenantId}`;
    registerInference(db, {
      tenantId: alpha.tenantId,
      apiKey: 'sk-redis-shadow-alpha',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-alpha',
    });
    registerInference(db, {
      tenantId: beta.tenantId,
      apiKey: 'sk-redis-shadow-beta',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-beta',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', alpha.tenantId, '--mode', 'hard', '--requests-per-minute', '1'], cliEnv());
    runCli(db, ['set-tenant-limits', '--tenant-id', beta.tenantId, '--mode', 'hard', '--requests-per-minute', '5'], cliEnv());
    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(plainUrl)));
    try {
      await waitForReady(port);
      await waitRedis(port, 'connected');
      const alphaOk = await postChat(port, alpha.tenantId, alpha.secret, alphaPrompt);
      const alphaDenied = await postChat(port, alpha.tenantId, alpha.secret, `${alphaPrompt}-again`);
      const betaOk = await postChat(port, beta.tenantId, beta.secret, betaPrompt);
      expect(alphaOk.status).toBe(200);
      expect(alphaDenied.status).toBe(429);
      expect(errorCode(alphaDenied.body)).toBe('tenant_rate_limited');
      expect(betaOk.status).toBe(200);
      expect(alphaOk.body).not.toContain(beta.secret);
      expect(alphaOk.body).not.toContain(betaPrompt);
      expect(betaOk.body).not.toContain(alpha.secret);
      expect(betaOk.body).not.toContain(alphaPrompt);
      expect(alphaDenied.body).not.toContain(beta.secret);
      expect(alphaDenied.body).not.toContain(alpha.secret);
      const admin = new (await import('pg')).default.Pool({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.username,
        password: db.password,
        max: 1,
      });
      try {
        const counters = await admin.query<{ tenant_id: string; amount: string }>(
          `SELECT tenant_id, amount::text AS amount
           FROM limit_counters
           WHERE tenant_id = ANY($1::uuid[]) AND scope = 'tenant_requests'`,
          [[alpha.tenantId, beta.tenantId]],
        );
        const alphaAmount = counters.rows.find((row) => row.tenant_id === alpha.tenantId)?.amount;
        const betaAmount = counters.rows.find((row) => row.tenant_id === beta.tenantId)?.amount;
        expect(alphaAmount).toBe('1');
        expect(betaAmount).toBe('1');
      } finally {
        await admin.end();
      }
      const stored = (await redisKeys()).join('\n');
      expect(stored).not.toContain(alpha.secret);
      expect(stored).not.toContain(beta.secret);
      expect(stored).not.toContain(alphaPrompt);
      expect(stored).not.toContain(betaPrompt);
      expect(stored).not.toContain(`completion-for-${alphaPrompt}`);
      expect(stored).not.toContain(`completion-for-${betaPrompt}`);
      expect(started.output()).not.toContain(alpha.secret);
      expect(started.output()).not.toContain(beta.secret);
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'isolation', alpha: 'tenant_rate_limited', beta: 200 })}`);
    } finally {
      await stopChild(started.child);
    }
  });

  it('reports auth failure and still serves postgresql inference', async () => {
    const tenant = provisionTenant(db, 'Redis Shadow Auth');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-shadow-auth',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-auth',
    });
    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(plainUrl, 'wrong-password-value')));
    try {
      const ready = await waitForReady(port);
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      const report = await waitRedis(port, 'unavailable');
      expect(report.mode).toBe('redis_shadow');
      expect(report.lastError).toBe('auth');
      expect(report.connectFailures).toBeGreaterThan(0);
      const allowed = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-auth-still-serves');
      expect(allowed.status).toBe(200);
      expect(started.output()).not.toContain('wrong-password-value');
      expect(started.output()).not.toContain(tenant.secret);
      writeFileSync(join(EVIDENCE, 'connection-failures.txt'), `auth ${JSON.stringify(report)}\n`, { flag: 'a' });
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'auth', redis: report.redis, lastError: report.lastError, chat: allowed.status })}`);
    } finally {
      await stopChild(started.child);
    }
  });

  it('reports tls failure and still serves postgresql inference', async () => {
    const tenant = provisionTenant(db, 'Redis Shadow Tls');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-shadow-tls',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-tls',
    });
    const port = await freePort();
    const good = spawnServer(baseEnv(port, shadowSettings(tlsUrl, PROXY_PASSWORD, { REDIS_TLS_CA_FILE: caFile })));
    try {
      await waitForReady(port);
      const connected = await waitRedis(port, 'connected');
      expect(connected.mode).toBe('redis_shadow');
      const allowed = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-tls-ok');
      expect(allowed.status).toBe(200);
    } finally {
      await stopChild(good.child);
    }

    const badPort = await freePort();
    const bad = spawnServer(baseEnv(badPort, shadowSettings(tlsUrl, PROXY_PASSWORD, { REDIS_TLS_CA_FILE: wrongCaFile })));
    try {
      const ready = await waitForReady(badPort);
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      const report = await waitRedis(badPort, 'unavailable');
      expect(report.lastError).toBe('tls');
      const allowed = await postChat(badPort, tenant.tenantId, tenant.secret, 'prompt-tls-bad-ca');
      expect(allowed.status).toBe(200);
      expect(bad.output()).not.toContain(PROXY_PASSWORD);
      writeFileSync(join(EVIDENCE, 'connection-failures.txt'), `tls ${JSON.stringify(report)}\n`, { flag: 'a' });
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'tls', redis: report.redis, lastError: report.lastError, chat: allowed.status })}`);
    } finally {
      await stopChild(bad.child);
    }
  });

  it('serves readiness when redis is down at startup', async () => {
    const tenant = provisionTenant(db, 'Redis Shadow Down');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-shadow-down',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-down',
    });
    const closed = await freePort();
    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(`redis://127.0.0.1:${closed}`)));
    try {
      const ready = await waitForReady(port);
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      const report = await waitRedis(port, 'unavailable');
      expect(report.mode).toBe('redis_shadow');
      const allowed = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-startup-down');
      expect(allowed.status).toBe(200);
      writeFileSync(join(EVIDENCE, 'connection-failures.txt'), `startup-down ${JSON.stringify({ ready, redis: report })}\n`, { flag: 'a' });
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'startup-down', ready: ready.status, redis: report.redis, chat: allowed.status })}`);
    } finally {
      await stopChild(started.child);
    }
  });

  it('reconnects after a redis restart and closes its client on shutdown', async () => {
    const tenant = provisionTenant(db, 'Redis Shadow Restart');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-shadow-restart',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-restart',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1'], cliEnv());
    const port = await freePort();
    const started = spawnServer(baseEnv(port, shadowSettings(plainUrl)));
    try {
      await waitForReady(port);
      const before = await waitRedis(port, 'connected');
      const allowed = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-before-restart');
      expect(allowed.status).toBe(200);
      if (plain === undefined) throw new Error('redis container is missing');
      await exec('docker', ['restart', plain.getId()]);
      const deadline = Date.now() + 20_000;
      let restored = before;
      while (Date.now() < deadline) {
        restored = await readRedis(port);
        if (restored.redis === 'connected' && restored.reconnects > before.reconnects) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(restored.redis).toBe('connected');
      expect(restored.reconnects).toBeGreaterThan(before.reconnects);
      const denied = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-after-restart');
      expect(denied.status).toBe(429);
      expect(errorCode(denied.body)).toBe('tenant_rate_limited');
      const ready = await waitForReady(port);
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      console.log(`REDIS_CASE ${JSON.stringify({ case: 'restart', reconnects: restored.reconnects, code: errorCode(denied.body) })}`);
    } finally {
      await stopChild(started.child);
    }
    const deadline = Date.now() + 10_000;
    let remaining = await proxyLines();
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      remaining = await proxyLines();
    }
    expect(remaining).toEqual([]);
    console.log('REDIS_CASE {"case":"cleanup","proxyClients":0}');
  });

  it('launches redis_shadow twice and admits from postgresql', async () => {
    const tenant = provisionTenant(db, 'Redis Shadow Launch');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-redis-shadow-launch',
      deployment: 'redis-chat',
      upstreamModel: 'gpt-redis-shadow-launch',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '5'], cliEnv());
    const postgresPort = await freePort();
    const postgresServer = spawnServer(baseEnv(postgresPort, { RATE_LIMIT_STORE: 'postgres' }));
    let postgresCode = '';
    try {
      await waitForReady(postgresPort);
      const denied = await postChat(postgresPort, tenant.tenantId, tenant.secret, 'prompt-postgres-baseline');
      postgresCode = `${denied.status} ${errorCode(denied.body) ?? 'allowed'}`;
      expect(denied.status).toBe(200);
    } finally {
      await stopChild(postgresServer.child);
    }

    for (const [index, file] of ['launch-shadow-1.txt', 'launch-shadow-2.txt'].entries()) {
      const port = await freePort();
      const started = spawnServer(baseEnv(port, shadowSettings(plainUrl)));
      try {
        const ready = await waitForReady(port);
        const report = await waitRedis(port, 'connected');
        const chat = await postChat(port, tenant.tenantId, tenant.secret, `prompt-shadow-launch-${index + 1}`);
        const code = `${chat.status} ${errorCode(chat.body) ?? 'allowed'}`;
        expect(ready).toEqual({ status: 'ready', database: 'ready' });
        expect(report.redis).toBe('connected');
        expect(code).toBe(postgresCode);
        const text = [
          `run ${index + 1}`,
          `GET /health/ready ${JSON.stringify(ready)}`,
          `GET /health/redis ${JSON.stringify(report)}`,
          `chat ${code}`,
          `postgres ${postgresCode}`,
        ].join('\n');
        writeFileSync(join(EVIDENCE, file), `${text}\n`);
        expect(text).not.toContain(tenant.secret);
        expect(text).not.toContain(PROXY_PASSWORD);
        console.log(`REDIS_CASE ${JSON.stringify({ case: 'shadow-launch', run: index + 1, code })}`);
      } finally {
        await stopChild(started.child);
      }
    }
  });
});
