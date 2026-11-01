import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClient, type RedisClientType } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  COUNTER_SCALE,
  COUNTER_TTL_SECONDS,
  checkHotCounters,
  counterKey,
  policyRevision,
  TOKEN_BUCKET_SCRIPT,
  type HotCounterResult,
  type RateLimitSnapshot,
  type RedisCommandClient,
} from '../src/redis/hot-counters.js';
import {
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForReady,
} from './helpers.js';
import { chatPayload, cliEnv, credentialKeyText, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const exec = promisify(execFile);
const db = loadTestDatabase();
const PROXY_PASSWORD = 'local_redis_shadow_pw';
const INSPECTOR_PASSWORD = 'inspector_shadow_pw';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-11b');
const EFFECTIVE = '2025-12-01T00:00:00.000Z';

type RedisReport = {
  shadowChecks: string;
  comparisons: number;
  agreements: number;
  disagreements: number;
  unknownResults: number;
  redisAllows: number;
  redisDenies: number;
  lastPostgres: string | null;
  lastRedis: string | null;
  lastDurationMs: number | null;
  scriptLoads: number;
  scriptMisses: number;
  redis: string;
  mode: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Redis Cluster slot: CRC-16/XMODEM of the hash tag, modulo 16384. */
function clusterSlot(key: string): number {
  const open = key.indexOf('{');
  const close = key.indexOf('}', open + 1);
  const tagged = open >= 0 && close > open ? key.slice(open + 1, close) : key;
  let crc = 0;
  for (const byte of Buffer.from(tagged)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) === 0 ? (crc << 1) & 0xffff : ((crc << 1) ^ 0x1021) & 0xffff;
    }
  }
  return crc % 16384;
}

function pass(name: string, detail: Record<string, unknown> = {}): void {
  console.log(`REDIS_HOT_CASE ${JSON.stringify({ case: name, passed: true, ...detail })}`);
}

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    tenantMode: 'hard',
    tenantRequestsPerMinute: null,
    tenantTokensPerMinute: null,
    apiKeyMode: null,
    apiKeyRequestsPerMinute: null,
    apiKeyTokensPerMinute: null,
    ...overrides,
  };
}

function pairs(reply: unknown): Record<string, string> {
  const list = Array.isArray(reply) ? reply.map((item) => String(item)) : [];
  const out: Record<string, string> = {};
  for (let i = 0; i < list.length; i += 2) {
    const field = list[i];
    if (field !== undefined) out[field] = list[i + 1] ?? '';
  }
  return out;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(3));
}

async function openClient(username: string, password: string): Promise<RedisClientType> {
  const client = createClient({
    url: plainUrl,
    username,
    password,
    disableClientInfo: true,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: () => false },
  });
  client.on('error', () => undefined);
  await client.connect();
  return client as RedisClientType;
}

function commandClient(client: RedisClientType): RedisCommandClient {
  return { sendCommand: (args) => client.sendCommand(args) };
}

async function take(
  client: RedisCommandClient,
  limits: RateLimitSnapshot,
  input: { tenantId?: string; apiKeyId?: string; attemptId?: string; tokenCost?: number | null; presentedKey?: string } = {},
): Promise<HotCounterResult> {
  return checkHotCounters(
    client,
    {
      tenantId: input.tenantId ?? randomUUID(),
      apiKeyId: input.apiKeyId ?? randomUUID(),
      attemptId: input.attemptId ?? randomUUID(),
      tokenCost: input.tokenCost ?? null,
      limits,
      presentedKey: input.presentedKey,
    },
    1000,
  );
}

let plain: StartedTestContainer | undefined;
let plainUrl = '';
let upstream = 'http://127.0.0.1:9/v1';
let mockClose: (() => Promise<void>) | undefined;

function baseEnv(port: number, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return serviceEnv(db, {
    PORT: String(port),
    INFERENCE_ENABLED: 'true',
    PROVIDER_CREDENTIAL_KEY: credentialKeyText,
    OPENAI_BASE_URL: upstream,
    ...overrides,
  });
}

function shadowEnv(port: number, checks: boolean, timeout = '1000'): NodeJS.ProcessEnv {
  return baseEnv(port, {
    RATE_LIMIT_STORE: 'redis_shadow',
    REDIS_SHADOW_CHECKS: checks ? 'true' : 'false',
    REDIS_URL: plainUrl,
    REDIS_USERNAME: 'proxy',
    REDIS_PASSWORD: PROXY_PASSWORD,
    REDIS_TLS: 'false',
    REDIS_CONNECT_TIMEOUT_MS: timeout,
    REDIS_RECONNECT_TIMEOUT_MS: timeout,
  });
}

async function readRedis(port: number): Promise<RedisReport> {
  const response = await fetch(`http://127.0.0.1:${port}/health/redis`);
  expect(response.status).toBe(200);
  return (await response.json()) as RedisReport;
}

async function waitRedis(port: number): Promise<RedisReport> {
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

async function postChat(port: number, tenantId: string, secret: string, content: string): Promise<{ status: number; body: string; code: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: chatPayload('auto', content),
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

async function hashOf(inspector: RedisClientType, key: string): Promise<Record<string, string>> {
  return pairs(await inspector.sendCommand(['HGETALL', key]));
}

describe('redis hot rate counters', () => {
  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'token-bucket.lua'), TOKEN_BUCKET_SCRIPT);
    const shipped = readFileSync(join(projectRoot, 'docker/redis/users.acl'), 'utf8');
    const runtimeAcl = `${shipped.trim()}\nuser inspector on resetpass >${INSPECTOR_PASSWORD} resetkeys ~* &* +@all\n`;
    const plainHostPort = await freePort();
    plain = await new GenericContainer('redis:7')
      .withCopyContentToContainer([{ content: runtimeAcl, target: '/opt/users.acl', mode: 0o644 }])
      .withCommand(['redis-server', '--aclfile', '/opt/users.acl', '--port', '6379', '--save', '', '--appendonly', 'no'])
      .withExposedPorts({ container: 6379, host: plainHostPort })
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(60_000)
      .start();
    plainUrl = `redis://127.0.0.1:${plain.getMappedPort(6379)}`;
    const mock = await startMockUpstream((_hit, _request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', 'completion-for-shadow')));
    });
    upstream = mock.baseUrl;
    mockClose = mock.close;
  }, 180_000);

  afterAll(async () => {
    if (mockClose) await mockClose();
    await plain?.stop();
  });

  it('rejects an invalid shadow switch and keeps the default off', () => {
    expect(loadConfig(serviceEnv(db)).redisShadowChecks).toBe(false);
    const postgres = loadConfig(serviceEnv(db, { RATE_LIMIT_STORE: 'postgres', REDIS_SHADOW_CHECKS: 'true' }));
    expect(postgres.redisShadowChecks).toBe(false);
    expect(postgres.redis).toBeNull();
    const enabled = loadConfig(serviceEnv(db, {
      RATE_LIMIT_STORE: 'redis_shadow',
      REDIS_SHADOW_CHECKS: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379',
      REDIS_USERNAME: 'proxy',
      REDIS_PASSWORD: PROXY_PASSWORD,
      REDIS_TLS: 'false',
    }));
    expect(enabled.redisShadowChecks).toBe(true);
    expect(() => loadConfig(serviceEnv(db, {
      RATE_LIMIT_STORE: 'redis_shadow',
      REDIS_SHADOW_CHECKS: 'yes',
      REDIS_URL: 'redis://127.0.0.1:6379',
      REDIS_USERNAME: 'proxy',
      REDIS_PASSWORD: PROXY_PASSWORD,
    }))).toThrow(/REDIS_SHADOW_CHECKS/);
    pass('config');
  });

  it('consumes a bucket once under concurrent callers', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    const clients = await Promise.all([0, 1, 2, 3, 4].map(() => openClient('proxy', PROXY_PASSWORD)));
    try {
      const tenantId = randomUUID();
      const limits = snapshot({ tenantRequestsPerMinute: 10 });
      const results = await Promise.all(
        clients.flatMap((client) => Array.from({ length: 4 }, () => take(commandClient(client), limits, { tenantId }))),
      );
      const allows = results.filter((result) => result.decision === 'allow');
      const denies = results.filter((result) => result.decision === 'deny');
      expect(allows).toHaveLength(10);
      expect(denies).toHaveLength(10);
      expect(results.every((result) => result.decision !== 'unknown')).toBe(true);
      writeFileSync(join(EVIDENCE, 'concurrency.txt'), [
        'callers 5',
        'requests 20',
        'capacity 10',
        `allows ${allows.length}`,
        `denies ${denies.length}`,
        `duplicates ${results.filter((result) => result.duplicate).length}`,
      ].join('\n') + '\n');
      pass('atomic', { allows: allows.length, denies: denies.length });
      pass('multi-replica-callers', { callers: clients.length, allows: allows.length });
    } finally {
      await Promise.all([proxy, ...clients].map((client) => client.quit().catch(() => undefined)));
    }
  });

  it('allows only the configured burst and then refills from server time', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    try {
      const tenantId = randomUUID();
      const apiKeyId = randomUUID();
      const requests = snapshot({ tenantRequestsPerMinute: 3 });
      const decisions: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await take(commandClient(proxy), requests, { tenantId, apiKeyId });
        decisions.push(result.decision);
        if (i === 2) expect(result.remaining).toBeLessThan(COUNTER_SCALE);
      }
      expect(decisions).toEqual(['allow', 'allow', 'allow', 'deny']);
      pass('boundary', { decisions });

      const tokens = snapshot({ tenantTokensPerMinute: 60 });
      const burst = await take(commandClient(proxy), tokens, { tenantId, apiKeyId, tokenCost: 60 });
      const blocked = await take(commandClient(proxy), tokens, { tenantId, apiKeyId, tokenCost: 60 });
      const stillBlocked = await take(commandClient(proxy), tokens, { tenantId, apiKeyId, tokenCost: 1 });
      expect(burst.decision).toBe('allow');
      expect(burst.remaining).toBe(0);
      expect(blocked.decision).toBe('deny');
      expect(stillBlocked.decision).toBe('deny');
      await sleep(1200);
      const refilled = await take(commandClient(proxy), tokens, { tenantId, apiKeyId, tokenCost: 1 });
      const notFull = await take(commandClient(proxy), tokens, { tenantId, apiKeyId, tokenCost: 60 });
      expect(refilled.decision).toBe('allow');
      expect(notFull.decision).toBe('deny');
      pass('burst-refill', { burst: burst.decision, refilled: refilled.decision, waitedMs: 1200 });

      const keyLimits = snapshot({ tenantRequestsPerMinute: 10, apiKeyRequestsPerMinute: 1 });
      const keyTenant = randomUUID();
      const keyId = randomUUID();
      const first = await take(commandClient(proxy), keyLimits, { tenantId: keyTenant, apiKeyId: keyId });
      const key = counterKey(keyTenant, policyRevision(keyLimits));
      const afterFirst = await hashOf(inspector, key);
      expect(Number(afterFirst['t:tr'])).toBe(9 * COUNTER_SCALE);
      expect(Number(afterFirst[`t:kr:${keyId}`])).toBe(0);
      const second = await take(commandClient(proxy), keyLimits, { tenantId: keyTenant, apiKeyId: keyId });
      expect(first.decision).toBe('allow');
      expect(second.decision).toBe('deny');
      const observed = await hashOf(inspector, key);
      const tenantLevel = Number(observed['t:tr']);
      const keyLevel = Number(observed[`t:kr:${keyId}`]);
      expect(tenantLevel).toBeGreaterThan(8 * COUNTER_SCALE);
      expect(keyLevel).toBeLessThan(COUNTER_SCALE);
      expect(Object.keys(observed).every((field) => /^(t:|m:|r:|s:)/.test(field))).toBe(true);
      const ttl = Number(await inspector.sendCommand(['TTL', key]));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(COUNTER_TTL_SECONDS);
      writeFileSync(join(EVIDENCE, 'observed-counters.txt'), [
        `key ${key}`,
        `ttl ${ttl}`,
        `scale ${COUNTER_SCALE}`,
        ...Object.keys(observed).sort().map((field) => `${field}=${field.startsWith('s:') ? 'seen' : observed[field]}`),
      ].join('\n') + '\n');
      pass('api-key-dimension', { tenantLevel, keyLevel, ttl });

      await inspector.sendCommand(['DEL', key]);
      const expired = await take(commandClient(proxy), keyLimits, { tenantId: keyTenant, apiKeyId: keyId });
      expect(expired.decision).toBe('allow');
      expect(expired.duplicate).toBe(false);
      pass('expiry', { decision: expired.decision });

      const revised = snapshot({ tenantRequestsPerMinute: 11, apiKeyRequestsPerMinute: 1 });
      expect(policyRevision(revised)).not.toBe(policyRevision(keyLimits));
      const oldDenied = await take(commandClient(proxy), keyLimits, { tenantId: keyTenant, apiKeyId: keyId });
      const fresh = await take(commandClient(proxy), revised, { tenantId: keyTenant, apiKeyId: keyId });
      expect(oldDenied.decision).toBe('deny');
      expect(fresh.decision).toBe('allow');
      expect(counterKey(keyTenant, policyRevision(keyLimits))).not.toBe(counterKey(keyTenant, policyRevision(revised)));
      pass('policy-revision', { old: oldDenied.decision, next: fresh.decision });
    } finally {
      await proxy.quit().catch(() => undefined);
      await inspector.quit().catch(() => undefined);
    }
  });

  it('refills one token while attempts arrive every 10ms', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    try {
      const tenantId = randomUUID();
      const limits = snapshot({ tenantRequestsPerMinute: 1 });
      const key = counterKey(tenantId, policyRevision(limits));
      const drained = await take(commandClient(proxy), limits, { tenantId });
      expect(drained.decision).toBe('allow');
      const blocked = await take(commandClient(proxy), limits, { tenantId });
      expect(blocked.decision).toBe('deny');
      const started = Date.now();
      let allowed = false;
      let polls = 0;
      let credited = false;
      while (Date.now() - started < 75_000) {
        const result = await take(commandClient(proxy), limits, { tenantId });
        polls += 1;
        if (result.decision === 'allow') {
          allowed = true;
          expect(result.duplicate).toBe(false);
          break;
        }
        if (!credited && Date.now() - started >= 3_000) {
          const level = Number(await inspector.sendCommand(['HGET', key, 't:tr']));
          expect(level).toBeGreaterThan(0);
          expect(level).toBeLessThan(COUNTER_SCALE);
          credited = true;
        }
        await sleep(10);
      }
      const waitedMs = Date.now() - started;
      expect(allowed).toBe(true);
      expect(waitedMs).toBeGreaterThan(50_000);
      pass('refill-poll', { polls, waitedMs, credited });
    } finally {
      await proxy.quit().catch(() => undefined);
      await inspector.quit().catch(() => undefined);
    }
  }, 110_000);

  it('shares one tenant bucket across api-key policies', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    try {
      const tenantId = randomUUID();
      const slowKey = randomUUID();
      const fastKey = randomUUID();
      const slow = snapshot({ tenantRequestsPerMinute: 2, apiKeyRequestsPerMinute: 1 });
      const fast = snapshot({ tenantRequestsPerMinute: 2, apiKeyRequestsPerMinute: 5 });
      expect(policyRevision(slow)).toBe(policyRevision(fast));
      const calls = [
        await take(commandClient(proxy), slow, { tenantId, apiKeyId: slowKey }),
        await take(commandClient(proxy), fast, { tenantId, apiKeyId: fastKey }),
        await take(commandClient(proxy), fast, { tenantId, apiKeyId: fastKey }),
        await take(commandClient(proxy), slow, { tenantId, apiKeyId: slowKey }),
      ];
      expect(calls.map((result) => result.decision)).toEqual(['allow', 'allow', 'deny', 'deny']);
      pass('shared-tenant-revision', { allows: 2 });
    } finally {
      await proxy.quit().catch(() => undefined);
    }
  });

  it('deduplicates a retry after the counter hash is full', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    try {
      const tenantId = randomUUID();
      const limits = snapshot({ tenantRequestsPerMinute: 100_000 });
      const key = counterKey(tenantId, policyRevision(limits));
      for (let batch = 0; batch < 8; batch += 1) {
        const args = ['HSET', key];
        for (let i = 0; i < 256; i += 1) args.push(`s:${randomUUID()}`, 'allow:0');
        await inspector.sendCommand(args);
      }
      expect(Number(await inspector.sendCommand(['HLEN', key]))).toBe(2048);
      const attemptId = randomUUID();
      const first = await take(commandClient(proxy), limits, { tenantId, attemptId });
      const level = Number(await inspector.sendCommand(['HGET', key, 't:tr']));
      const retry = await take(commandClient(proxy), limits, { tenantId, attemptId });
      const afterRetry = Number(await inspector.sendCommand(['HGET', key, 't:tr']));
      expect(first.decision).toBe('allow');
      expect(first.duplicate).toBe(false);
      expect(retry.decision).toBe('allow');
      expect(retry.duplicate).toBe(true);
      expect(level).toBe(100_000 * COUNTER_SCALE - COUNTER_SCALE);
      expect(afterRetry).toBe(level);
      pass('full-hash-dedup', { level: afterRetry, duplicate: true });
    } finally {
      await proxy.quit().catch(() => undefined);
      await inspector.quit().catch(() => undefined);
    }
  });

  it('does not consume a duplicate attempt or another tenant key', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    const callers = await Promise.all([0, 1, 2].map(() => openClient('proxy', PROXY_PASSWORD)));
    try {
      const tenantId = randomUUID();
      const limits = snapshot({ tenantRequestsPerMinute: 1 });
      const attemptId = randomUUID();
      const results = await Promise.all(callers.map((client) => take(commandClient(client), limits, { tenantId, attemptId })));
      expect(results.every((result) => result.decision === 'allow')).toBe(true);
      expect(results.filter((result) => result.duplicate)).toHaveLength(2);
      const other = await take(commandClient(proxy), limits, { tenantId });
      expect(other.decision).toBe('deny');
      pass('duplicate', { allows: results.length, duplicates: 2, later: other.decision });

      const victim = randomUUID();
      const attacker = randomUUID();
      const victimLimits = snapshot({ tenantRequestsPerMinute: 5 });
      await take(commandClient(proxy), victimLimits, { tenantId: victim });
      const victimKey = counterKey(victim, policyRevision(victimLimits));
      const before = await hashOf(inspector, victimKey);
      const wrong = await take(commandClient(proxy), victimLimits, { tenantId: attacker, presentedKey: victimKey });
      const after = await hashOf(inspector, victimKey);
      expect(wrong.decision).toBe('deny');
      expect(wrong.reason).toBe('wrong_tenant');
      expect(after).toEqual(before);
      const attackerKey = counterKey(attacker, policyRevision(victimLimits));
      expect(await inspector.sendCommand(['EXISTS', attackerKey])).toBe(0);
      const isolated = await take(commandClient(proxy), victimLimits, { tenantId: attacker });
      expect(isolated.decision).toBe('allow');
      pass('tenant-isolation', { attacker: isolated.decision });
      pass('wrong-tenant', { reason: wrong.reason });

      expect(clusterSlot('123456789')).toBe(0x31c3 % 16384);
      const revisedKey = counterKey(victim, policyRevision(snapshot({ tenantRequestsPerMinute: 9 })));
      const slotA = clusterSlot(victimKey);
      const slotB = clusterSlot(revisedKey);
      const slotC = clusterSlot(attackerKey);
      expect(slotA).toBe(slotB);
      expect(victimKey).toContain(`{${victim}}`);
      expect(revisedKey).toContain(`{${victim}}`);
      expect(attackerKey).toContain(`{${attacker}}`);
      expect(TOKEN_BUCKET_SCRIPT).toContain('KEYS[1]');
      expect(TOKEN_BUCKET_SCRIPT).not.toContain('KEYS[2]');
      writeFileSync(join(EVIDENCE, 'cluster-slots.txt'), [
        `tenant ${victim}`,
        `key ${victimKey}`,
        `slot ${slotA}`,
        `other revision key ${revisedKey}`,
        `other revision slot ${slotB}`,
        `same slot ${slotA === slotB}`,
        `other tenant key ${attackerKey}`,
        `other tenant slot ${slotC}`,
        'hash CRC-16/XMODEM of the hash tag, modulo 16384',
        'script keys: KEYS[1] only',
      ].join('\n') + '\n');
      pass('cluster-slot', { slot: slotA, same: slotA === slotB });

      await expect(proxy.sendCommand(['SET', 'secret', 'nope'])).rejects.toThrow(/NOPERM/);
      await expect(proxy.sendCommand(['HSET', 'secret', 'field', 'nope'])).rejects.toThrow(/NOPERM/);
      await expect(proxy.sendCommand(['SCRIPT', 'FLUSH'])).rejects.toThrow(/NOPERM/);
      pass('acl');
    } finally {
      await Promise.all([proxy, inspector, ...callers].map((client) => client.quit().catch(() => undefined)));
    }
  });

  it('reloads a missing script and treats a bad or late reply as unknown', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    try {
      await inspector.sendCommand(['SCRIPT', 'FLUSH']);
      const limits = snapshot({ tenantRequestsPerMinute: 4 });
      const loaded = await take(commandClient(proxy), limits, { tenantId: randomUUID() });
      expect(loaded.decision).toBe('allow');
      expect(loaded.reloaded).toBe(true);
      pass('missing-script', { reloaded: loaded.reloaded, decision: loaded.decision });

      const unloadable: RedisCommandClient = {
        async sendCommand(args) {
          if (args[0] === 'EVALSHA') throw new Error('NOSCRIPT No matching script. Please use EVAL.');
          throw new Error('NOPERM script load failed');
        },
      };
      const stuck = await checkHotCounters(unloadable, {
        tenantId: randomUUID(),
        apiKeyId: randomUUID(),
        attemptId: randomUUID(),
        tokenCost: null,
        limits,
      }, 500);
      expect(stuck.decision).toBe('unknown');
      pass('missing-script-unloaded', { decision: stuck.decision });

      const invalid: RedisCommandClient = { async sendCommand() { return 1; } };
      const bad = await checkHotCounters(invalid, {
        tenantId: randomUUID(),
        apiKeyId: randomUUID(),
        attemptId: randomUUID(),
        tokenCost: null,
        limits,
      }, 500);
      expect(bad.decision).toBe('unknown');
      expect(bad.reason).toBe('invalid');
      pass('invalid-response', { reason: bad.reason });

      const late: RedisCommandClient = {
        async sendCommand() {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1000);
            timer.unref();
          });
          return ['ok', 'allow', '0', '0', 'ok'];
        },
      };
      const timed = await checkHotCounters(late, {
        tenantId: randomUUID(),
        apiKeyId: randomUUID(),
        attemptId: randomUUID(),
        tokenCost: null,
        limits,
      }, 100);
      expect(timed.decision).toBe('unknown');
      pass('ambiguous', { decision: timed.decision, durationMs: timed.durationMs });
    } finally {
      await proxy.quit().catch(() => undefined);
      await inspector.quit().catch(() => undefined);
    }
  });

  it('returns unknown while redis is down and reloads the script after restart', async () => {
    if (plain === undefined) throw new Error('redis container is missing');
    const limits = snapshot({ tenantRequestsPerMinute: 3 });
    const tenantId = randomUUID();
    const before = await openClient('proxy', PROXY_PASSWORD);
    try {
      const allowed = await take(commandClient(before), limits, { tenantId });
      expect(allowed.decision).toBe('allow');
      await exec('docker', ['stop', plain.getId()]);
      const down = await take(commandClient(before), limits, { tenantId });
      expect(down.decision).toBe('unknown');
      pass('restart-down', { decision: down.decision });
    } finally {
      await before.quit().catch(() => undefined);
      await exec('docker', ['start', plain.getId()]).catch(() => undefined);
      const deadline = Date.now() + 20_000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          const probe = await openClient('inspector', INSPECTOR_PASSWORD);
          await probe.ping();
          await probe.quit();
          up = true;
          break;
        } catch {
          await sleep(200);
        }
      }
      if (!up) throw new Error('redis did not return');
    }
    const after = await openClient('proxy', PROXY_PASSWORD);
    try {
      const restored = await take(commandClient(after), limits, { tenantId });
      expect(restored.decision).toBe('allow');
      expect(restored.reloaded).toBe(true);
      pass('restart', { decision: restored.decision, reloaded: restored.reloaded });
    } finally {
      await after.quit().catch(() => undefined);
    }
  });

  it('benchmarks the shipped token bucket', async () => {
    const proxy = await openClient('proxy', PROXY_PASSWORD);
    try {
      const tenantId = randomUUID();
      const limits = snapshot({ tenantRequestsPerMinute: 100_000 });
      for (let i = 0; i < 20; i += 1) await take(commandClient(proxy), limits, { tenantId });
      const samples: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const started = performance.now();
        const result = await take(commandClient(proxy), limits, { tenantId });
        samples.push(performance.now() - started);
        expect(result.decision).toBe('allow');
      }
      const text = [
        'operation checkHotCounters',
        'samples 100',
        `min_ms ${percentile(samples, 0)}`,
        `p50_ms ${percentile(samples, 50)}`,
        `p99_ms ${percentile(samples, 99)}`,
        `max_ms ${percentile(samples, 100)}`,
      ].join('\n');
      writeFileSync(join(EVIDENCE, 'benchmark.txt'), `${text}\n`);
      pass('benchmark', { p50: percentile(samples, 50), p99: percentile(samples, 99) });
    } finally {
      await proxy.quit().catch(() => undefined);
    }
  });

  it('keeps postgresql admission when the redis decision disagrees', async () => {
    const tenant = provisionTenant(db, 'Redis Hot Compare');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: `sk-redis-hot-compare-${tenant.tenantId.slice(0, 8)}`,
      deployment: 'redis-hot',
      upstreamModel: 'gpt-redis-hot',
    });
    runCli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-redis-hot',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified',
      '--input-rate', '0.01',
    ], cliEnv());
    runCli(db, [
      'set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'observe',
      '--requests-per-minute', '1', '--concurrent-requests', '4',
    ], cliEnv());
    runCli(db, ['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '20'], cliEnv());
    runCli(db, [
      'set-connection-limit', '--tenant-id', tenant.tenantId, '--provider', 'openai',
      '--mode', 'hard', '--max-concurrency', '4',
    ], cliEnv());
    runCli(db, [
      'set-deployment-limit', '--tenant-id', tenant.tenantId, '--deployment', 'redis-hot',
      '--mode', 'hard', '--max-concurrency', '4',
    ], cliEnv());

    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    const port = await freePort();
    const started = spawnServer(shadowEnv(port, true));
    try {
      await waitForReady(port);
      await waitRedis(port);
      const first = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-shadow-first');
      const second = await postChat(port, tenant.tenantId, tenant.secret, 'prompt-shadow-second');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.code).toBe('ok');
      const report = await readRedis(port);
      expect(report.shadowChecks).toBe('on');
      expect(report.lastPostgres).toBe('allow');
      expect(report.lastRedis).toBe('deny');
      expect(report.disagreements).toBeGreaterThan(0);
      expect(report.agreements).toBeGreaterThan(0);
      expect(report.lastDurationMs).not.toBeNull();

      const pool = createPool(loadConfig(serviceEnv(db)), 'runtime');
      const stored = await withTenant(pool, tenant.tenantId, async (client) => {
        const counters = await client.query<{ scope: string; amount: string }>(
          `SELECT scope, amount::text AS amount FROM limit_counters WHERE tenant_id = $1 ORDER BY scope`,
          [tenant.tenantId],
        );
        const leases = await client.query<{ scope: string; released: boolean }>(
          `SELECT scope, released_at IS NOT NULL AS released
           FROM concurrency_leases WHERE tenant_id = $1 ORDER BY scope`,
          [tenant.tenantId],
        );
        const budgets = await client.query<{ status: string }>(
          `SELECT status FROM budget_reservations WHERE tenant_id = $1 ORDER BY created_at`,
          [tenant.tenantId],
        );
        return {
          counters: counters.rows,
          leases: leases.rows,
          budgets: budgets.rows.map((row) => row.status),
        };
      });
      await pool.end();
      expect(stored.counters.some((row) => row.scope === 'tenant_requests' && Number(row.amount) === 2)).toBe(true);
      const leaseScopes = stored.leases.map((row) => row.scope);
      expect(leaseScopes).toEqual(expect.arrayContaining(['connection', 'deployment', 'tenant_request']));
      expect(stored.leases.every((row) => row.released)).toBe(true);
      expect(stored.budgets).toEqual(['settled', 'settled']);
      const liveKey = counterKey(tenant.tenantId, policyRevision(snapshot({ tenantMode: 'observe', tenantRequestsPerMinute: 1 })));
      const live = await hashOf(inspector, liveKey);
      expect(Object.keys(live).some((field) => /budget|lease|connection|deployment/.test(field))).toBe(false);
      writeFileSync(join(EVIDENCE, 'comparison.txt'), [
        `http ${second.status} ${second.code}`,
        `postgres ${report.lastPostgres}`,
        `redis ${report.lastRedis}`,
        `disagreements ${report.disagreements}`,
        `duration_ms ${report.lastDurationMs}`,
        `counters ${stored.counters.map((row) => `${row.scope}:${row.amount}`).join(',')}`,
        `leases ${stored.leases.map((row) => `${row.scope}:released`).join(',')}`,
        `budgets ${stored.budgets.join(',')}`,
        `redis fields ${Object.keys(live).sort().join(',')}`,
      ].join('\n') + '\n');
      pass('comparison', { http: second.code, postgres: report.lastPostgres, redis: report.lastRedis });
    } finally {
      await stopChild(started.child);
      await inspector.quit().catch(() => undefined);
    }
  });

  it('boots two proxies and keeps the same postgresql admission', async () => {
    const tenant = provisionTenant(db, 'Redis Hot Launch');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: `sk-redis-hot-launch-${tenant.tenantId.slice(0, 8)}`,
      deployment: 'redis-hot',
      upstreamModel: 'gpt-redis-hot-launch',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '100'], cliEnv());
    for (const [index, file] of ['launch-1.txt', 'launch-2.txt'].entries()) {
      const port = await freePort();
      const started = spawnServer(shadowEnv(port, true));
      try {
        await waitForReady(port);
        await waitRedis(port);
        const chat = await postChat(port, tenant.tenantId, tenant.secret, `prompt-launch-${index + 1}`);
        const report = await readRedis(port);
        expect(chat.status).toBe(200);
        expect(chat.code).toBe('ok');
        expect(report.lastPostgres).toBe('allow');
        expect(report.lastRedis).toBe('allow');
        expect(report.mode).toBe('redis_shadow');
        const text = [
          `run ${index + 1}`,
          `HTTP ${chat.status} ${chat.code}`,
          `postgres ${report.lastPostgres}`,
          `redis ${report.lastRedis}`,
          `comparisons ${report.comparisons}`,
          `agreements ${report.agreements}`,
          `duration_ms ${report.lastDurationMs}`,
        ].join('\n');
        writeFileSync(join(EVIDENCE, file), `${text}\n`);
        pass('launch', { run: index + 1, http: chat.code, redis: report.lastRedis });
      } finally {
        await stopChild(started.child);
      }
    }
  });

  it('uses one redis decision across three proxy replicas', async () => {
    const tenant = provisionTenant(db, 'Redis Hot Replicas');
    const other = provisionTenant(db, 'Redis Hot Other');
    for (const item of [
      { tenant, key: `sk-redis-hot-replica-${tenant.tenantId.slice(0, 8)}`, model: 'gpt-redis-hot-replica' },
      { tenant: other, key: `sk-redis-hot-other-${other.tenantId.slice(0, 8)}`, model: 'gpt-redis-hot-other' },
    ]) {
      registerInference(db, {
        tenantId: item.tenant.tenantId,
        apiKey: item.key,
        deployment: 'redis-hot',
        upstreamModel: item.model,
      });
      runCli(db, ['set-tenant-limits', '--tenant-id', item.tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '2'], cliEnv());
    }
    const ports = [await freePort(), await freePort(), await freePort()];
    const servers = ports.map((port) => spawnServer(shadowEnv(port, true)));
    try {
      await Promise.all(ports.map(async (port) => {
        await waitForReady(port);
        await waitRedis(port);
      }));
      const calls = Array.from({ length: 6 }, (_item, index) => postChat(
        ports[index % ports.length] ?? ports[0],
        tenant.tenantId,
        tenant.secret,
        `prompt-replica-${index}`,
      ));
      calls.push(postChat(ports[0] ?? 0, other.tenantId, other.secret, 'prompt-other-tenant'));
      const results = await Promise.all(calls);
      const main = results.slice(0, 6);
      const isolated = results[6];
      const allows = main.filter((result) => result.status === 200);
      const denies = main.filter((result) => result.status === 429);
      expect(allows).toHaveLength(2);
      expect(denies).toHaveLength(4);
      expect(denies.every((result) => result.code === 'tenant_rate_limited')).toBe(true);
      expect(isolated?.status).toBe(200);
      const reports = await Promise.all(ports.map((port) => readRedis(port)));
      const redisAllows = reports.reduce((sum, report) => sum + report.redisAllows, 0);
      const redisDenies = reports.reduce((sum, report) => sum + report.redisDenies, 0);
      expect(redisAllows).toBe(3);
      expect(redisDenies).toBe(4);
      writeFileSync(join(EVIDENCE, 'replicas.txt'), [
        'replicas 3',
        `ports ${ports.join(',')}`,
        `http_allows ${allows.length}`,
        `http_denies ${denies.length}`,
        `redis_allows ${redisAllows}`,
        `redis_denies ${redisDenies}`,
        `other_tenant ${isolated?.status} ${isolated?.code}`,
        ...reports.map((report, index) => `replica ${index + 1} allow ${report.redisAllows} deny ${report.redisDenies} postgres ${report.lastPostgres} redis ${report.lastRedis}`),
      ].join('\n') + '\n');
      pass('replicas', { httpAllows: allows.length, redisAllows, redisDenies });
    } finally {
      await Promise.all(servers.map((server) => stopChild(server.child)));
    }
  });

  it('does not change postgresql admission when redis is paused or checks are off', async () => {
    const pausedTenant = provisionTenant(db, 'Redis Hot Pause');
    const quietTenant = provisionTenant(db, 'Redis Hot Quiet');
    registerInference(db, {
      tenantId: pausedTenant.tenantId,
      apiKey: `sk-redis-hot-pause-${pausedTenant.tenantId.slice(0, 8)}`,
      deployment: 'redis-hot',
      upstreamModel: 'gpt-redis-hot-pause',
    });
    registerInference(db, {
      tenantId: quietTenant.tenantId,
      apiKey: `sk-redis-hot-quiet-${quietTenant.tenantId.slice(0, 8)}`,
      deployment: 'redis-hot',
      upstreamModel: 'gpt-redis-hot-quiet',
    });
    runCli(db, ['set-tenant-limits', '--tenant-id', pausedTenant.tenantId, '--mode', 'hard', '--requests-per-minute', '20'], cliEnv());
    runCli(db, ['set-tenant-limits', '--tenant-id', quietTenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1'], cliEnv());

    const pausePort = await freePort();
    const paused = spawnServer(shadowEnv(pausePort, true, '200'));
    const inspector = await openClient('inspector', INSPECTOR_PASSWORD);
    try {
      await waitForReady(pausePort);
      await waitRedis(pausePort);
      await inspector.sendCommand(['CLIENT', 'PAUSE', '2000']);
      const during = await postChat(pausePort, pausedTenant.tenantId, pausedTenant.secret, 'prompt-paused');
      const report = await readRedis(pausePort);
      expect(during.status).toBe(200);
      expect(during.code).toBe('ok');
      expect(report.lastPostgres).toBe('allow');
      expect(report.lastRedis).toBe('unknown');
      expect(report.unknownResults).toBeGreaterThan(0);
      pass('ambiguous-admission', { http: during.code, redis: report.lastRedis });
    } finally {
      await inspector.sendCommand(['CLIENT', 'UNPAUSE']).catch(() => undefined);
      await inspector.quit().catch(() => undefined);
      await stopChild(paused.child);
    }

    const quietPort = await freePort();
    const quiet = spawnServer(shadowEnv(quietPort, false));
    const reader = await openClient('inspector', INSPECTOR_PASSWORD);
    try {
      await waitForReady(quietPort);
      await waitRedis(quietPort);
      const first = await postChat(quietPort, quietTenant.tenantId, quietTenant.secret, 'prompt-quiet-allow');
      const second = await postChat(quietPort, quietTenant.tenantId, quietTenant.secret, 'prompt-quiet-deny');
      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.code).toBe('tenant_rate_limited');
      const report = await readRedis(quietPort);
      expect(report.shadowChecks).toBe('off');
      expect(report.comparisons).toBe(0);
      const found = Number(await reader.sendCommand(['EXISTS', counterKey(quietTenant.tenantId, policyRevision(snapshot({ tenantMode: 'hard', tenantRequestsPerMinute: 1 })))]));
      expect(found).toBe(0);
      pass('checks-off', { http: second.code, comparisons: report.comparisons });
    } finally {
      await reader.quit().catch(() => undefined);
      await stopChild(quiet.child);
    }
  });
});
