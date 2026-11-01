import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pools.js';
import { allocateRateSlice } from '../src/db/rate-epochs.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ACTIVE_SPEND_SCRIPT } from '../src/redis/active-quota.js';
import {
  configFor,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForReady,
  type TestDatabase,
} from './helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKeyText, enableStreaming, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const exec = promisify(execFile);
const db = loadTestDatabase();
const PROXY_PASSWORD = 'local_redis_shadow_pw';
const INSPECTOR_PASSWORD = 'inspector_active_pw';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-11c');
const EFFECTIVE = '2026-01-01T00:00:00.000Z';
const ADMIT = 'admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid, boolean, boolean, boolean, boolean)';

type ChatResult = { status: number; body: string; code: string };
type RedisReport = {
  mode: string;
  redis: string;
  circuit: string;
  activeAllows: number;
  activeDenies: number;
  fallbackDenies: number;
  epochCloses: number;
  lastRecoveryMs: number | null;
  lastDurationMs: number | null;
  shadowChecks: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function record(name: string, detail: Record<string, unknown> = {}): void {
  const line = `REDIS_ACTIVE_CASE ${JSON.stringify({ case: name, passed: true, ...detail })}`;
  console.log(line);
  appendFileSync(join(EVIDENCE, 'cases.txt'), `${line}\n`);
}

function contentOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return parsed.messages?.[0]?.content ?? '';
  } catch {
    return '';
  }
}

let plain: StartedTestContainer | undefined;
let plainUrl = '';
let upstream = 'http://127.0.0.1:9/v1';
let mockClose: (() => Promise<void>) | undefined;
let admin: pg.Pool | undefined;
const held = new Map<string, import('node:http').ServerResponse>();

function baseEnv(port: number, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return serviceEnv(db, {
    PORT: String(port),
    INFERENCE_ENABLED: 'true',
    PROVIDER_CREDENTIAL_KEY: credentialKeyText,
    OPENAI_BASE_URL: upstream,
    ...overrides,
  });
}

function activeEnv(port: number): NodeJS.ProcessEnv {
  return baseEnv(port, {
    RATE_LIMIT_STORE: 'redis_active',
    REDIS_URL: plainUrl,
    REDIS_USERNAME: 'proxy',
    REDIS_PASSWORD: PROXY_PASSWORD,
    REDIS_TLS: 'false',
    REDIS_CONNECT_TIMEOUT_MS: '1000',
    REDIS_RECONNECT_TIMEOUT_MS: '1000',
    REDIS_BREAKER_COOLDOWN_MS: '200',
  });
}

async function readRedis(port: number): Promise<RedisReport> {
  const response = await fetch(`http://127.0.0.1:${port}/health/redis`);
  expect(response.status).toBe(200);
  return (await response.json()) as RedisReport;
}

async function waitConnected(port: number): Promise<RedisReport> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 20_000) {
    try {
      const report = await readRedis(port);
      last = JSON.stringify(report);
      if (report.redis === 'connected') return report;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await sleep(200);
  }
  throw new Error(`redis connected timeout: ${last}`);
}

async function postChat(port: number, tenantId: string, secret: string, content: string, extra: Record<string, unknown> = {}): Promise<ChatResult> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: chatPayload('auto', content, extra),
  });
  const body = await response.text();
  let code = 'ok';
  try {
    code = (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? 'ok';
  } catch {
    code = 'unparsed';
  }
  return { status: response.status, body, code };
}

async function boot(mode: 'active' | 'postgres'): Promise<{ port: number; child: ReturnType<typeof spawnServer>['child'] }> {
  const port = await freePort();
  const child = spawnServer(mode === 'active' ? activeEnv(port) : baseEnv(port, { RATE_LIMIT_STORE: 'postgres' })).child;
  await waitForReady(port);
  if (mode === 'active') await waitConnected(port);
  return { port, child };
}

function tenant(name: string, model: string): { tenantId: string; keyId: string; secret: string } {
  const created = provisionTenant(db, name);
  registerInference(db, {
    tenantId: created.tenantId,
    apiKey: `sk-${model}`,
    deployment: 'active-chat',
    upstreamModel: model,
  });
  runCli(db, [
    'register-price', '--provider', 'openai', '--upstream-model', model,
    '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified',
    '--input-rate', '0.01',
  ], cliEnv());
  return created;
}

function limit(tenantId: string, requests: number, mode = 'hard'): void {
  runCli(db, [
    'set-tenant-limits', '--tenant-id', tenantId, '--mode', mode, '--requests-per-minute', String(requests),
  ], cliEnv());
}

function budget(tenantId: string, amount: string): void {
  runCli(db, ['set-tenant-budget', '--tenant-id', tenantId, '--mode', 'hard', '--monthly-amount', amount], cliEnv());
}

function activate(tenantId: string, scope = 'tenant_requests'): Record<string, unknown> {
  return runCli(db, ['activate-redis-rate', '--tenant-id', tenantId, '--scope', scope], cliEnv()) as Record<string, unknown>;
}

async function counter(tenantId: string): Promise<number> {
  const result = await admin!.query<{ amount: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS amount
     FROM limit_counters WHERE tenant_id = $1 AND scope = 'tenant_requests'`,
    [tenantId],
  );
  return Number(result.rows[0]?.amount ?? 0);
}

async function allocated(tenantId: string): Promise<number> {
  const result = await admin!.query<{ amount: string }>(
    `SELECT COALESCE(SUM(allocated), 0)::text AS amount
     FROM rate_quota_allocations WHERE tenant_id = $1 AND scope = 'tenant_requests'`,
    [tenantId],
  );
  return Number(result.rows[0]?.amount ?? 0);
}

async function reservations(tenantId: string): Promise<number> {
  const result = await admin!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM budget_reservations WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function openLeases(tenantId: string): Promise<number> {
  const result = await admin!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM concurrency_leases
     WHERE tenant_id = $1 AND released_at IS NULL`,
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function xactCommit(): Promise<number> {
  const result = await admin!.query<{ xact: string }>(
    'SELECT xact_commit::text AS xact FROM pg_stat_database WHERE datname = current_database()',
  );
  return Number(result.rows[0]?.xact ?? 0);
}

async function stopRedis(): Promise<void> {
  if (plain === undefined) throw new Error('redis container is missing');
  await exec('docker', ['stop', plain.getId()]);
}

async function startRedis(): Promise<void> {
  if (plain === undefined) throw new Error('redis container is missing');
  await exec('docker', ['start', plain.getId()]);
}

async function inspector(): Promise<RedisClientType> {
  const client = createClient({
    url: plainUrl,
    username: 'inspector',
    password: INSPECTOR_PASSWORD,
    disableClientInfo: true,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: () => false },
  });
  client.on('error', () => undefined);
  await client.connect();
  return client as RedisClientType;
}

describe('redis active admission', () => {
  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'cases.txt'), '');
    writeFileSync(join(EVIDENCE, 'active-spend.lua'), ACTIVE_SPEND_SCRIPT);
    const shipped = readFileSync(join(projectRoot, 'docker/redis/users.acl'), 'utf8');
    expect(shipped).toContain('+hsetnx');
    expect(shipped).not.toContain('+flush');
    const runtimeAcl = `${shipped.trim()}\nuser inspector on resetpass >${INSPECTOR_PASSWORD} resetkeys ~* &* +@all\n`;
    const hostPort = await freePort();
    plain = await new GenericContainer('redis:7')
      .withCopyContentToContainer([{ content: runtimeAcl, target: '/opt/users.acl', mode: 0o644 }])
      .withCommand(['redis-server', '--aclfile', '/opt/users.acl', '--port', '6379', '--appendonly', 'no'])
      .withExposedPorts({ container: 6379, host: hostPort })
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(60_000)
      .start();
    plainUrl = `redis://127.0.0.1:${plain.getMappedPort(6379)}`;
    const sse = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
    const mock = await startMockUpstream((hit: MockHit, _request, response) => {
      const content = contentOf(hit.body);
      if (content.startsWith('hold-')) {
        held.set(content, response);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
    });
    upstream = mock.baseUrl;
    mockClose = async () => {
      for (const [content, response] of held) {
        if (response.writableEnded) continue;
        if (content.includes('stream')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(sse);
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
        }
      }
      await mock.close();
    };
    admin = adminPool(db);
  }, 180_000);

  afterAll(async () => {
    if (plain !== undefined) await startRedis().catch(() => undefined);
    if (mockClose) await mockClose();
    await plain?.stop();
    await admin?.end();
  });

  it('keeps redis_active off by default and requires redis settings', () => {
    expect(loadConfig(serviceEnv(db)).rateLimitMode).toBe('postgres');
    expect(() => loadConfig(serviceEnv(db, { RATE_LIMIT_STORE: 'redis_active' }))).toThrow(/REDIS_URL/);
    const active = loadConfig(serviceEnv(db, {
      RATE_LIMIT_STORE: 'redis_active',
      REDIS_URL: plainUrl,
      REDIS_USERNAME: 'proxy',
      REDIS_PASSWORD: PROXY_PASSWORD,
    }));
    expect(active.rateLimitMode).toBe('redis_active');
    expect(active.redisShadowChecks).toBe(false);
    expect(active.redis?.breakerCooldownMs).toBe(1000);
    record('config-default-off');
  });

  it('admits normal redis_active traffic and keeps the postgres reservation', async () => {
    const created = tenant('Redis Active Normal', 'gpt-active-normal');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    const first = activate(created.tenantId);
    expect(first.generation).toBe(1);
    const server = await boot('active');
    try {
      const allows: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const result = await postChat(server.port, created.tenantId, created.secret, `normal-${index}`);
        expect(result.status).toBe(200);
        allows.push(result.status);
      }
      const denied = await postChat(server.port, created.tenantId, created.secret, 'normal-over');
      expect(denied.status).toBe(429);
      expect(denied.code).toBe('tenant_rate_limited');
      expect(await reservations(created.tenantId)).toBe(4);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      expect(await allocated(created.tenantId)).toBeLessThanOrEqual(4);
      const report = await readRedis(server.port);
      expect(report.mode).toBe('redis_active');
      expect(report.circuit).toBe('closed');
      expect(report.activeAllows).toBe(4);
      record('normal-traffic', { allows: allows.length, charged: await counter(created.tenantId), activeAllows: report.activeAllows });
    } finally {
      await stopChild(server.child);
    }
  });

  it('leaves an inactive policy and an observe policy on postgresql', async () => {
    const idle = tenant('Redis Active Idle', 'gpt-active-idle');
    const watched = tenant('Redis Active Observe', 'gpt-active-observe');
    limit(idle.tenantId, 1);
    limit(watched.tenantId, 1, 'observe');
    activate(watched.tenantId);
    const server = await boot('active');
    try {
      expect((await postChat(server.port, idle.tenantId, idle.secret, 'idle-1')).status).toBe(200);
      const blocked = await postChat(server.port, idle.tenantId, idle.secret, 'idle-2');
      expect(blocked.status).toBe(429);
      expect(blocked.code).toBe('tenant_rate_limited');
      expect((await postChat(server.port, watched.tenantId, watched.secret, 'watch-1')).status).toBe(200);
      expect((await postChat(server.port, watched.tenantId, watched.secret, 'watch-2')).status).toBe(200);
      const report = await readRedis(server.port);
      expect(report.activeAllows).toBe(0);
      record('inactive-and-observe', { activeAllows: report.activeAllows });
    } finally {
      await stopChild(server.child);
    }
  });

  it('denies at the rate boundary across epochs without a second grant', async () => {
    const created = tenant('Redis Active Boundary', 'gpt-active-boundary');
    limit(created.tenantId, 2);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const server = await boot('active');
    try {
      expect((await postChat(server.port, created.tenantId, created.secret, 'edge-1')).status).toBe(200);
      expect((await postChat(server.port, created.tenantId, created.secret, 'edge-2')).status).toBe(200);
      const denied = await postChat(server.port, created.tenantId, created.secret, 'edge-3');
      expect(denied.status).not.toBe(200);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(2);
      expect(await allocated(created.tenantId)).toBeLessThanOrEqual(2);
      expect(await reservations(created.tenantId)).toBe(2);
      record('boundary', { charged: await counter(created.tenantId), allocated: await allocated(created.tenantId), code: denied.code });
    } finally {
      await stopChild(server.child);
    }
  });

  it('does not grant the same slice again after a mid-window redis stop', async () => {
    const created = tenant('Redis Active Stop', 'gpt-active-stop');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const server = await boot('active');
    try {
      expect((await postChat(server.port, created.tenantId, created.secret, 'stop-1')).status).toBe(200);
      const charged = await counter(created.tenantId);
      expect(charged).toBeGreaterThan(0);
      await stopRedis();
      const during = await postChat(server.port, created.tenantId, created.secret, 'stop-during');
      expect(during.status).not.toBe(200);
      expect(during.code).toBe('rate_backend_uncertain');
      expect(await counter(created.tenantId)).toBeGreaterThanOrEqual(charged);
      await startRedis();
      const recovered = await waitForAllow(server.port, created, 'stop-recovered');
      expect(recovered.status).toBe(200);
      let allows = 2;
      for (let index = 0; index < 6; index += 1) {
        const result = await postChat(server.port, created.tenantId, created.secret, `stop-more-${index}`);
        if (result.status === 200) allows += 1;
      }
      expect(allows).toBeLessThanOrEqual(4);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      record('mid-window-failure', { allows, charged: await counter(created.tenantId), recoveryMs: recovered.recoveryMs });
    } finally {
      await startRedis().catch(() => undefined);
      await stopChild(server.child);
    }
  });

  it('does not reset the counter when redis loses every key', async () => {
    const created = tenant('Redis Active Wipe', 'gpt-active-wipe');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const server = await boot('active');
    const reader = await inspector();
    try {
      expect((await postChat(server.port, created.tenantId, created.secret, 'wipe-1')).status).toBe(200);
      const charged = await counter(created.tenantId);
      await reader.sendCommand(['FLUSHALL']);
      const lost = await postChat(server.port, created.tenantId, created.secret, 'wipe-lost');
      expect(lost.status).not.toBe(200);
      expect(lost.code).toBe('rate_backend_uncertain');
      expect(await counter(created.tenantId)).toBe(charged);
      const recovered = await waitForAllow(server.port, created, 'wipe-recovered');
      expect(recovered.status).toBe(200);
      let allows = 2;
      for (let index = 0; index < 6; index += 1) {
        const result = await postChat(server.port, created.tenantId, created.secret, `wipe-more-${index}`);
        if (result.status === 200) allows += 1;
      }
      expect(allows).toBeLessThanOrEqual(4);
      const report = await readRedis(server.port);
      record('lost-keys', {
        allows,
        charged: await counter(created.tenantId),
        recoveryMs: recovered.recoveryMs,
        lastRecoveryMs: report.lastRecoveryMs,
        fallbackDenies: report.fallbackDenies,
      });
    } finally {
      await reader.quit().catch(() => undefined);
      await stopChild(server.child);
    }
  });

  it('lets postgresql grant only the capacity redis has not already charged', async () => {
    const created = tenant('Redis Active Fallback', 'gpt-active-fallback');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const active = await boot('active');
    const postgres = await boot('postgres');
    try {
      expect((await postChat(active.port, created.tenantId, created.secret, 'fallback-redis')).status).toBe(200);
      let allows = 1;
      for (let index = 0; index < 6; index += 1) {
        const result = await postChat(postgres.port, created.tenantId, created.secret, `fallback-pg-${index}`);
        if (result.status === 200) allows += 1;
        else break;
      }
      for (let index = 0; index < 6; index += 1) {
        const result = await postChat(active.port, created.tenantId, created.secret, `fallback-more-${index}`);
        if (result.status === 200) allows += 1;
        else break;
      }
      expect(allows).toBeLessThanOrEqual(4);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      const rolled = await readRedis(postgres.port);
      expect(rolled.mode).toBe('postgres');
      expect(rolled.circuit).toBe('off');
      record('postgres-fallback', { allows, charged: await counter(created.tenantId) });
    } finally {
      await stopChild(active.child);
      await stopChild(postgres.child);
    }
  });

  it('does not admit when the budget reservation fails', async () => {
    const blocked = tenant('Redis Active Budget', 'gpt-active-budget');
    const revoked = tenant('Redis Active Revoke', 'gpt-active-revoke');
    limit(blocked.tenantId, 4);
    limit(revoked.tenantId, 4);
    budget(blocked.tenantId, '0');
    budget(revoked.tenantId, '1000');
    activate(blocked.tenantId);
    activate(revoked.tenantId);
    const server = await boot('active');
    const reader = await inspector();
    try {
      const over = await postChat(server.port, blocked.tenantId, blocked.secret, 'budget-zero');
      expect(over.status).not.toBe(200);
      expect(over.code).toBe('budget_exceeded');
      expect(await reservations(blocked.tenantId)).toBe(0);
      expect((await postChat(server.port, revoked.tenantId, revoked.secret, 'revoke-first')).status).toBe(200);
      expect(await reservations(revoked.tenantId)).toBe(1);
      const before = await level(reader, revoked.tenantId);
      await admin!.query(`REVOKE EXECUTE ON FUNCTION ${ADMIT} FROM llm_runtime`);
      const failed = await postChat(server.port, revoked.tenantId, revoked.secret, 'revoke-second');
      expect(failed.status).not.toBe(200);
      expect(await reservations(revoked.tenantId)).toBe(1);
      const after = await level(reader, revoked.tenantId);
      expect(after).toBeLessThan(before);
      record('budget-outage', { budget: over.code, reservation: await reservations(revoked.tenantId), redisBefore: before, redisAfter: after });
    } finally {
      await admin!.query(`GRANT EXECUTE ON FUNCTION ${ADMIT} TO llm_runtime`).catch(() => undefined);
      await reader.quit().catch(() => undefined);
      await stopChild(server.child);
    }
  });

  it('shares one redis decision across three replicas during failover', async () => {
    const created = tenant('Redis Active Replicas', 'gpt-active-replicas');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const servers = [await boot('active'), await boot('active'), await boot('active')];
    try {
      const first = await Promise.all(servers.flatMap((server, index) => [
        postChat(server.port, created.tenantId, created.secret, `replica-a-${index}`),
        postChat(server.port, created.tenantId, created.secret, `replica-b-${index}`),
      ]));
      const healthy = first.filter((result) => result.status === 200).length;
      expect(healthy).toBeGreaterThan(0);
      expect(healthy).toBeLessThanOrEqual(4);
      await stopRedis();
      const during = await Promise.all(servers.map((server, index) => (
        postChat(server.port, created.tenantId, created.secret, `replica-down-${index}`)
      )));
      const extra = during.filter((result) => result.status === 200).length;
      expect(healthy + extra).toBeLessThanOrEqual(4);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      const text = [
        `healthy_allows ${healthy}`,
        `failover_allows ${extra}`,
        `charged ${await counter(created.tenantId)}`,
        `allocated ${await allocated(created.tenantId)}`,
      ].join('\n');
      writeFileSync(join(EVIDENCE, 'failover.txt'), `${text}\n`);
      record('replicas-failover', { healthy, extra, charged: await counter(created.tenantId) });
    } finally {
      await startRedis().catch(() => undefined);
      for (const server of servers) await stopChild(server.child);
    }
  });

  it('rejects a stale spend and a stopped redis without a second full grant', async () => {
    const created = tenant('Redis Active Stale', 'gpt-active-stale');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const server = await boot('active');
    const reader = await inspector();
    try {
      expect((await postChat(server.port, created.tenantId, created.secret, 'stale-1')).status).toBe(200);
      const keys = (await reader.sendCommand(['KEYS', `rl:{${created.tenantId}}:*`])) as string[];
      expect(keys.length).toBeGreaterThan(0);
      const key = keys[0] ?? '';
      const before = Number(await reader.sendCommand(['HGET', key, 'n']));
      expect(before).toBeGreaterThan(0);
      await reader.sendCommand([
        'EVAL', ACTIVE_SPEND_SCRIPT, '1', key,
        created.tenantId, randomUUID(), '180', '1', '1',
      ]);
      const after = Number(await reader.sendCommand(['HGET', key, 'n']));
      expect(after).toBe(before - 1);
      await stopRedis();
      const split = await postChat(server.port, created.tenantId, created.secret, 'stale-down');
      expect(split.status).not.toBe(200);
      await startRedis();
      let allows = 1;
      const recovered = await waitForAllow(server.port, created, 'stale-recovered');
      if (recovered.status === 200) allows += 1;
      for (let index = 0; index < 6; index += 1) {
        const result = await postChat(server.port, created.tenantId, created.secret, `stale-more-${index}`);
        if (result.status === 200) allows += 1;
      }
      expect(allows + 1).toBeLessThanOrEqual(4);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      record('split-brain', { allows, staleSpent: 1, charged: await counter(created.tenantId) });
    } finally {
      await startRedis().catch(() => undefined);
      await reader.quit().catch(() => undefined);
      await stopChild(server.child);
    }
  });

  it('closes the old epoch when the operator approves the policy again', async () => {
    const created = tenant('Redis Active Epoch', 'gpt-active-epoch');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    expect(activate(created.tenantId).generation).toBe(1);
    const server = await boot('active');
    try {
      expect((await postChat(server.port, created.tenantId, created.secret, 'epoch-1')).status).toBe(200);
      const again = activate(created.tenantId);
      expect(again.generation).toBe(2);
      let allows = 1;
      for (let index = 0; index < 6; index += 1) {
        const result = await postChat(server.port, created.tenantId, created.secret, `epoch-more-${index}`);
        if (result.status === 200) allows += 1;
        else break;
      }
      expect(allows).toBeLessThanOrEqual(4);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      const removed = runCli(db, ['deactivate-redis-rate', '--tenant-id', created.tenantId, '--scope', 'tenant_requests'], cliEnv()) as { generation?: number };
      expect(removed.generation).toBe(2);
      const postgres = await postChat(server.port, created.tenantId, created.secret, 'epoch-postgres');
      expect([200, 429]).toContain(postgres.status);
      expect(await counter(created.tenantId)).toBeLessThanOrEqual(4);
      record('policy-epoch', { allows, generation: again.generation, charged: await counter(created.tenantId) });
    } finally {
      await stopChild(server.child);
    }
  });

  it('denies a new epoch after eight closed epochs', async () => {
    const created = tenant('Redis Active Cap', 'gpt-active-cap');
    limit(created.tenantId, 100);
    const approved = activate(created.tenantId);
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (let epoch = 1; epoch <= 8; epoch += 1) {
      await admin!.query(
        `INSERT INTO rate_quota_allocations (
           tenant_id, scope, scope_id, window_start, epoch, generation, policy_revision,
           allocated, version, status, redis_seeded, opened_at, closed_at
         ) VALUES ($1, 'tenant_requests', $1, $2, $3, $4, 'abcdef0123456789', 1, 1, 'closed', true, $5, $5)`,
        [created.tenantId, windowStart, epoch, approved.generation, now],
      );
    }
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    try {
      const row = await withTenant(runtime, created.tenantId, (client) => allocateRateSlice(client, {
        tenantId: created.tenantId,
        scope: 'tenant_requests',
        scopeId: created.tenantId,
        windowStart,
        cost: 1,
        now,
      }));
      expect(row.outcome).toBe('deny');
      expect(row.reason).toBe('epoch_bound');
      record('epoch-bound');
    } finally {
      await runtime.end();
    }
  });

  it('keeps one tenant from spending another tenant slice', async () => {
    const alpha = tenant('Redis Active Alpha', 'gpt-active-alpha');
    const beta = tenant('Redis Active Beta', 'gpt-active-beta');
    limit(alpha.tenantId, 2);
    limit(beta.tenantId, 2);
    budget(alpha.tenantId, '1000');
    budget(beta.tenantId, '1000');
    activate(alpha.tenantId);
    activate(beta.tenantId);
    const server = await boot('active');
    try {
      expect((await postChat(server.port, alpha.tenantId, alpha.secret, 'fair-a1')).status).toBe(200);
      expect((await postChat(server.port, alpha.tenantId, alpha.secret, 'fair-a2')).status).toBe(200);
      expect((await postChat(server.port, alpha.tenantId, alpha.secret, 'fair-a3')).status).not.toBe(200);
      expect((await postChat(server.port, beta.tenantId, beta.secret, 'fair-b1')).status).toBe(200);
      expect((await postChat(server.port, beta.tenantId, beta.secret, 'fair-b2')).status).toBe(200);
      expect(await counter(alpha.tenantId)).toBeLessThanOrEqual(2);
      expect(await counter(beta.tenantId)).toBeLessThanOrEqual(2);
      record('multi-tenant', { alpha: await counter(alpha.tenantId), beta: await counter(beta.tenantId) });
    } finally {
      await stopChild(server.child);
    }
  });

  it('keeps a streaming request on its postgres lease when redis loses the key', async () => {
    const created = tenant('Redis Active Stream', 'gpt-active-stream');
    enableStreaming(db, {
      tenantId: created.tenantId,
      deployment: 'active-chat',
      connectTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      totalTimeoutMs: 60_000,
    });
    runCli(db, [
      'set-tenant-limits', '--tenant-id', created.tenantId, '--mode', 'hard',
      '--requests-per-minute', '4', '--concurrent-requests', '10', '--concurrent-streams', '10',
    ], cliEnv());
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const server = await boot('active');
    const reader = await inspector();
    const sse = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
    try {
      const pending = postChat(server.port, created.tenantId, created.secret, 'hold-stream', { stream: true });
      const started = Date.now();
      while (!held.has('hold-stream')) {
        if (Date.now() - started > 10_000) throw new Error('stream hold did not start');
        await sleep(20);
      }
      expect(await reservations(created.tenantId)).toBe(1);
      expect(await openLeases(created.tenantId)).toBeGreaterThan(0);
      await reader.sendCommand(['FLUSHALL']);
      const second = await postChat(server.port, created.tenantId, created.secret, 'stream-next');
      expect(second.status).not.toBe(200);
      expect(await reservations(created.tenantId)).toBe(1);
      const response = held.get('hold-stream');
      response?.writeHead(200, { 'content-type': 'text/event-stream' });
      response?.end(sse);
      held.delete('hold-stream');
      expect((await pending).status).toBe(200);
      expect(await reservations(created.tenantId)).toBe(1);
      record('stream', { second: second.code, reservations: await reservations(created.tenantId) });
    } finally {
      const response = held.get('hold-stream');
      if (response && !response.writableEnded) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sse);
      }
      await reader.quit().catch(() => undefined);
      await stopChild(server.child);
    }
  });

  it('does not send evaluation work to redis', () => {
    const worker = readFileSync(join(projectRoot, 'src/evaluation-worker.ts'), 'utf8');
    expect(worker.toLowerCase()).not.toContain('redis');
    record('evaluation-queue');
  });

  it('boots redis_active twice for one approved tenant', async () => {
    const created = tenant('Redis Active Launch', 'gpt-active-launch');
    limit(created.tenantId, 4);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    for (const pass of [1, 2]) {
      const server = await boot('active');
      try {
        const result = await postChat(server.port, created.tenantId, created.secret, `launch-${pass}`);
        const report = await readRedis(server.port);
        const reserved = await reservations(created.tenantId);
        const text = [
          `boot ${pass}`,
          `http ${result.status}`,
          `code ${result.code}`,
          `mode ${report.mode}`,
          `circuit ${report.circuit}`,
          `redis ${report.redis}`,
          `active_allows ${report.activeAllows}`,
          `reservations ${reserved}`,
        ].join('\n');
        writeFileSync(join(EVIDENCE, `launch-${pass}.txt`), `${text}\n`);
        expect(result.status).toBe(200);
        expect(report.mode).toBe('redis_active');
        expect(report.activeAllows).toBeGreaterThan(0);
        expect(reserved).toBe(pass);
      } finally {
        await stopChild(server.child);
      }
    }
    record('launch-twice');
  });

  it('rolls back to postgresql while an approval row remains', async () => {
    const created = tenant('Redis Active Rollback', 'gpt-active-rollback');
    limit(created.tenantId, 1);
    budget(created.tenantId, '1000');
    activate(created.tenantId);
    const server = await boot('postgres');
    try {
      expect((await postChat(server.port, created.tenantId, created.secret, 'rollback-1')).status).toBe(200);
      const denied = await postChat(server.port, created.tenantId, created.secret, 'rollback-2');
      expect(denied.status).toBe(429);
      expect(denied.code).toBe('tenant_rate_limited');
      const report = await readRedis(server.port);
      expect(report.mode).toBe('postgres');
      expect(report.circuit).toBe('off');
      record('rollback');
    } finally {
      await stopChild(server.child);
    }
  });

  it('measures postgres admission against redis_active admission', async () => {
    const postgresTenant = tenant('Redis Active Measure Pg', 'gpt-active-measure-pg');
    const redisTenant = tenant('Redis Active Measure Redis', 'gpt-active-measure-redis');
    limit(postgresTenant.tenantId, 1000);
    limit(redisTenant.tenantId, 1000);
    budget(postgresTenant.tenantId, '1000000');
    budget(redisTenant.tenantId, '1000000');
    activate(redisTenant.tenantId);
    const samples = 30;
    const postgres = await boot('postgres');
    const pgBefore = await xactCommit();
    const pgSamples: number[] = [];
    const pgStarted = Date.now();
    let rssPg = 'unavailable';
    try {
      for (let index = 0; index < samples; index += 1) {
        const started = Date.now();
        const result = await postChat(postgres.port, postgresTenant.tenantId, postgresTenant.secret, `measure-pg-${index}`);
        pgSamples.push(Date.now() - started);
        expect(result.status).toBe(200);
      }
      rssPg = rssOf(postgres.child.pid);
    } finally {
      await stopChild(postgres.child);
    }
    const pgElapsed = Date.now() - pgStarted;
    const pgXact = (await xactCommit()) - pgBefore;

    const active = await boot('active');
    const redisBefore = await xactCommit();
    const redisSamples: number[] = [];
    const commandSamples: number[] = [];
    const redisStarted = Date.now();
    let recoveryMs = 0;
    let lastRecoveryMs: number | null = null;
    let fallbackDenies = 0;
    let activeDenies = 0;
    const reader = await inspector();
    try {
      for (let index = 0; index < samples; index += 1) {
        const started = Date.now();
        const result = await postChat(active.port, redisTenant.tenantId, redisTenant.secret, `measure-redis-${index}`);
        redisSamples.push(Date.now() - started);
        expect(result.status).toBe(200);
        const report = await readRedis(active.port);
        if (report.lastDurationMs !== null) commandSamples.push(report.lastDurationMs);
      }
      const rssRedis = rssOf(active.child.pid);
      const memory = String(await reader.sendCommand(['INFO', 'memory']));
      const used = memory.match(/used_memory:(\d+)/)?.[1] ?? '0';
      await reader.sendCommand(['FLUSHALL']);
      const wipeStarted = Date.now();
      const lost = await postChat(active.port, redisTenant.tenantId, redisTenant.secret, 'measure-lost');
      expect(lost.status).not.toBe(200);
      const recovered = await waitForAllow(active.port, redisTenant, 'measure-recovered');
      recoveryMs = Date.now() - wipeStarted;
      expect(recovered.status).toBe(200);
      const report = await readRedis(active.port);
      lastRecoveryMs = report.lastRecoveryMs;
      fallbackDenies = report.fallbackDenies;
      activeDenies = report.activeDenies;
      const redisElapsed = Date.now() - redisStarted;
      const redisXact = (await xactCommit()) - redisBefore;
      const lines = [
        `samples ${samples}`,
        `postgres_p50_ms ${percentile(pgSamples, 50)}`,
        `postgres_p95_ms ${percentile(pgSamples, 95)}`,
        `postgres_p99_ms ${percentile(pgSamples, 99)}`,
        `postgres_xact_commit ${pgXact}`,
        `postgres_rps ${Number((samples / (pgElapsed / 1000)).toFixed(3))}`,
        `postgres_rss_kb ${rssPg}`,
        `redis_active_p50_ms ${percentile(redisSamples, 50)}`,
        `redis_active_p95_ms ${percentile(redisSamples, 95)}`,
        `redis_active_p99_ms ${percentile(redisSamples, 99)}`,
        `redis_active_xact_commit ${redisXact}`,
        `redis_active_rps ${Number((samples / (redisElapsed / 1000)).toFixed(3))}`,
        `redis_active_rss_kb ${rssRedis}`,
        `redis_command_p50_ms ${percentile(commandSamples, 50)}`,
        `redis_command_p95_ms ${percentile(commandSamples, 95)}`,
        `redis_command_p99_ms ${percentile(commandSamples, 99)}`,
        `redis_used_memory_bytes ${used}`,
        `recovery_ms ${recoveryMs}`,
        `last_recovery_ms ${lastRecoveryMs ?? 'null'}`,
        `fallback_denies ${fallbackDenies}`,
        `active_denies ${activeDenies}`,
        `active_allows ${report.activeAllows}`,
      ];
      writeFileSync(join(EVIDENCE, 'performance.txt'), `${lines.join('\n')}\n`);
      record('performance', { postgresP50: percentile(pgSamples, 50), redisP50: percentile(redisSamples, 50), recoveryMs });
    } finally {
      await reader.quit().catch(() => undefined);
      await stopChild(active.child);
    }
  });
});

function rssOf(pid: number | undefined): string {
  if (pid === undefined) return 'unavailable';
  try {
    return execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

async function level(reader: RedisClientType, tenantId: string): Promise<number> {
  const keys = (await reader.sendCommand(['KEYS', `rl:{${tenantId}}:*`])) as string[];
  let best = 0;
  for (const key of keys) {
    const value = await reader.sendCommand(['HGET', key, 'n']);
    const parsed = Number(value);
    if (Number.isFinite(parsed)) best += parsed;
  }
  return best;
}

async function waitForAllow(
  port: number,
  created: { tenantId: string; secret: string },
  content: string,
): Promise<ChatResult & { recoveryMs: number }> {
  const started = Date.now();
  let last: ChatResult = { status: 0, body: '', code: '' };
  while (Date.now() - started < 15_000) {
    last = await postChat(port, created.tenantId, created.secret, content);
    if (last.status === 200) return { ...last, recoveryMs: Date.now() - started };
    await sleep(200);
  }
  return { ...last, recoveryMs: Date.now() - started };
}
