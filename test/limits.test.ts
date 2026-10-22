import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalDecimal } from '../src/inference/cost.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  credentialKeyText,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';
import {
  bridgePrivateMock,
  closedPort,
  listenPrivate,
  pinResolver,
  postChat,
  PRIVATE_PIN,
  provision,
  registerPrivate,
} from './private-support.js';
import { startPrivateMock } from './mock-private.js';

const db = loadTestDatabase();
const admins: pg.Pool[] = [];

afterAll(async () => {
  await Promise.all(admins.map((pool) => pool.end()));
});

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

function trace(name: string, fields: Record<string, unknown>): void {
  console.log(`LIMIT_CASE ${JSON.stringify({ case: name, ...fields })}`);
}

function contentOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

async function openMock(hold: Set<string>): Promise<{
  hits: MockHit[];
  baseUrl: string;
  release: (content: string) => void;
  close: () => Promise<void>;
}> {
  const held = new Map<string, ServerResponse>();
  const mock = await startMockUpstream((hit, _request: IncomingMessage, response) => {
    const content = contentOf(hit.body);
    if (hold.has(content)) {
      held.set(content, response);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
  });
  return {
    ...mock,
    release(content: string): void {
      const response = held.get(content);
      if (response === undefined || response.writableEnded) return;
      held.delete(content);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
    },
  };
}

async function openApp(
  database: TestDatabase,
  baseUrl: string,
  options: { now?: () => number; maxStreamsPerTenant?: number; maxActiveStreams?: number } = {},
) {
  return createTestApp(database, {
    inferenceEnabled: true,
    upstreamBaseUrl: baseUrl,
    credentialKey,
    now: options.now,
    maxStreamsPerTenant: options.maxStreamsPerTenant,
    maxActiveStreams: options.maxActiveStreams,
  });
}

function tenantLimits(tenantId: string, mode: string, flags: string[]): void {
  runCli(db, ['set-tenant-limits', '--tenant-id', tenantId, '--mode', mode, ...flags], cliEnv());
}

async function poll(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 10_000) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type ChildResult = { status: number | null; code: string | null; exit: number | null; stderr: string };

function runChild(env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(projectRoot, 'test/limit-child.mjs')], {
      cwd: projectRoot,
      env: serviceEnv(db, env),
    });
    let out = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (exit) => {
      const line = out.trim().split('\n').at(-1) ?? '';
      try {
        const parsed = JSON.parse(line) as { status: number; code: string | null };
        resolve({ status: parsed.status, code: parsed.code, exit, stderr });
      } catch {
        resolve({ status: null, code: null, exit, stderr });
      }
    });
  });
}

describe('tenant limits', () => {
  it('completes an in-limit request and rejects hard rate, concurrency, and stream caps before upstream', async () => {
    const tenant = provisionTenant(db, 'Limit Eligible');
    const mock = await openMock(new Set(['hold-request', 'hold-stream']));
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-limit-eligible',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'limit-chat' });
    tenantLimits(tenant.tenantId, 'hard', ['--requests-per-minute', '5', '--concurrent-requests', '5', '--concurrent-streams', '5']);
    const ctx = await openApp(db, mock.baseUrl);
    let releaseStream = (): void => undefined;
    let streamMock: Awaited<ReturnType<typeof startMockUpstream>> | null = null;
    let streamApp: Awaited<ReturnType<typeof openApp>> | null = null;
    let firstStream: Promise<{ statusCode: number }> | null = null;
    try {
      const ok = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'within-limit'),
      });
      expect(ok.statusCode).toBe(200);
      expect(mock.hits).toHaveLength(1);
      tenantLimits(tenant.tenantId, 'hard', ['--requests-per-minute', '1']);
      const rate = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('auto', 'over-rate'),
      });
      expect(rate.statusCode).toBe(429);
      expect(rate.json().error.code).toBe('tenant_rate_limited');
      expect(mock.hits).toHaveLength(1);
      trace('rate', { status: rate.statusCode, code: rate.json().error.code, hits: mock.hits.length });

      const other = provisionTenant(db, 'Limit Concurrency');
      registerInference(db, {
        tenantId: other.tenantId,
        apiKey: 'sk-limit-concurrency',
        deployment: 'limit-chat',
        upstreamModel: 'gpt-limit',
      });
      enableStreaming(db, { tenantId: other.tenantId, deployment: 'limit-chat' });
      tenantLimits(other.tenantId, 'hard', ['--concurrent-requests', '1', '--concurrent-streams', '1']);
      const held = ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(other.tenantId, other.secret),
        payload: chatPayload('limit-chat', 'hold-request'),
      });
      await poll(() => mock.hits.length === 2, 'concurrency hold');
      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(other.tenantId, other.secret),
        payload: chatPayload('limit-chat', 'over-concurrency'),
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('concurrency_limited');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'over-concurrency')).toHaveLength(0);
      trace('concurrency', { status: blocked.statusCode, code: blocked.json().error.code, hits: mock.hits.length });
      mock.release('hold-request');
      expect((await held).statusCode).toBe(200);

      const streamTenant = provisionTenant(db, 'Limit Streams');
      registerInference(db, {
        tenantId: streamTenant.tenantId,
        apiKey: 'sk-limit-stream',
        deployment: 'limit-chat',
        upstreamModel: 'gpt-limit',
      });
      enableStreaming(db, { tenantId: streamTenant.tenantId, deployment: 'limit-chat' });
      tenantLimits(streamTenant.tenantId, 'hard', ['--concurrent-streams', '1', '--concurrent-requests', '4']);
      const sse = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      streamMock = await startMockUpstream((hit, _request, response) => {
        if (contentOf(hit.body) !== 'hold-stream') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
          return;
        }
        void streamGate.then(() => {
          if (response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(sse);
        });
      });
      streamApp = await openApp(db, streamMock.baseUrl);
      firstStream = streamApp.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(streamTenant.tenantId, streamTenant.secret),
        payload: chatPayload('limit-chat', 'hold-stream', { stream: true }),
      });
      await poll(() => streamMock.hits.length === 1, 'stream hold');
      const plain = await streamApp.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(streamTenant.tenantId, streamTenant.secret),
        payload: chatPayload('limit-chat', 'plain-beside-stream'),
      });
      expect(plain.statusCode).toBe(200);
      const secondStream = await streamApp.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(streamTenant.tenantId, streamTenant.secret),
        payload: chatPayload('limit-chat', 'over-stream', { stream: true }),
      });
      expect(secondStream.statusCode).toBe(429);
      expect(secondStream.json().error.code).toBe('stream_limited');
      expect(streamMock.hits.filter((hit) => contentOf(hit.body) === 'over-stream')).toHaveLength(0);
      releaseStream();
      expect((await firstStream).statusCode).toBe(200);
      trace('stream', { status: secondStream.statusCode, code: secondStream.json().error.code, plain: plain.statusCode });
    } finally {
      releaseStream();
      if (firstStream) await firstStream.catch(() => undefined);
      if (streamApp) {
        await streamApp.app.close();
        await streamApp.authPool.end();
        await streamApp.runtimePool.end();
      }
      if (streamMock) await streamMock.close();
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('applies the tighter API key limit and keeps two tenants apart', async () => {
    const alpha = provisionTenant(db, 'Limit Alpha');
    const beta = provisionTenant(db, 'Limit Beta');
    const mock = await openMock(new Set(['alpha-hold']));
    for (const tenant of [alpha, beta]) {
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: `sk-${tenant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        deployment: 'limit-chat',
        upstreamModel: 'gpt-limit',
      });
    }
    tenantLimits(alpha.tenantId, 'hard', ['--requests-per-minute', '10']);
    runCli(
      db,
      [
        'set-api-key-limits',
        '--tenant-id',
        alpha.tenantId,
        '--key-id',
        alpha.keyId,
        '--mode',
        'hard',
        '--requests-per-minute',
        '1',
      ],
      cliEnv(),
    );
    tenantLimits(beta.tenantId, 'hard', ['--requests-per-minute', '2', '--concurrent-requests', '2']);
    const ctx = await openApp(db, mock.baseUrl);
    try {
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(alpha.tenantId, alpha.secret),
        payload: chatPayload('limit-chat', 'alpha-one'),
      });
      expect(first.statusCode).toBe(200);
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(alpha.tenantId, alpha.secret),
        payload: chatPayload('limit-chat', 'alpha-two'),
      });
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe('api_key_rate_limited');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'alpha-two')).toHaveLength(0);
      const betaOne = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(beta.tenantId, beta.secret),
        payload: chatPayload('limit-chat', 'beta-one'),
      });
      const betaTwo = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(beta.tenantId, beta.secret),
        payload: chatPayload('limit-chat', 'beta-two'),
      });
      expect(betaOne.statusCode).toBe(200);
      expect(betaTwo.statusCode).toBe(200);
      trace('tenants', {
        alpha: second.json().error.code,
        betaHits: mock.hits.filter((hit) => contentOf(hit.body).startsWith('beta-')).length,
      });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('shares a provider connection cap across two proxy processes', async () => {
    const alpha = provisionTenant(db, 'Share Alpha');
    const beta = provisionTenant(db, 'Share Beta');
    const mock = await openMock(new Set(['share-hold']));
    for (const tenant of [alpha, beta]) {
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: `sk-${tenant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        deployment: 'limit-chat',
        upstreamModel: 'gpt-limit',
      });
      runCli(
        db,
        [
          'set-connection-limit',
          '--tenant-id',
          tenant.tenantId,
          '--provider',
          'openai',
          '--mode',
          'hard',
          '--max-concurrency',
          '1',
          '--share-group',
          'shared-openai',
        ],
        cliEnv(),
      );
    }
    const now = String(Date.parse('2026-03-01T00:00:00.000Z'));
    const base = {
      UPSTREAM_BASE_URL: mock.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      LIMIT_NOW_MS: now,
      CHAT_MODEL: 'limit-chat',
      CHAT_CONTENT: 'share-hold',
    };
    const pending = [
      runChild({ ...base, TENANT_ID: alpha.tenantId, TENANT_SECRET: alpha.secret }),
      runChild({ ...base, TENANT_ID: beta.tenantId, TENANT_SECRET: beta.secret }),
    ];
    const settled: ChildResult[] = [];
    for (const item of pending) void item.then((result) => settled.push(result));
    try {
      await poll(() => settled.length >= 1 && mock.hits.length === 1, 'shared connection');
      expect(settled[0]?.code).toBe('connection_limited');
      expect(mock.hits).toHaveLength(1);
      mock.release('share-hold');
      const done = await Promise.all(pending);
      expect(done.filter((item) => item.status === 200)).toHaveLength(1);
      expect(done.filter((item) => item.code === 'connection_limited')).toHaveLength(1);
      trace('shared-connection', { results: done.map((item) => ({ status: item.status, code: item.code })), hits: mock.hits.length });
    } finally {
      mock.release('share-hold');
      await Promise.allSettled(pending);
      await mock.close();
    }
  });

  it('blocks only the capped deployment and rejects a known token bound', async () => {
    const tenant = provisionTenant(db, 'Limit Deployment');
    const mock = await openMock(new Set(['dep-hold']));
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-limit-deployment',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
      capabilities: 'temperature,max_tokens',
    });
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'other-chat',
        '--upstream-model',
        'gpt-other',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    runCli(
      db,
      ['set-deployment-limit', '--tenant-id', tenant.tenantId, '--deployment', 'limit-chat', '--mode', 'hard', '--max-concurrency', '1'],
      cliEnv(),
    );
    tenantLimits(tenant.tenantId, 'hard', ['--token-rate', '5']);
    const ctx = await openApp(db, mock.baseUrl);
    let unknown: Awaited<ReturnType<typeof startMockUpstream>> | null = null;
    let unknownApp: Awaited<ReturnType<typeof openApp>> | null = null;
    try {
      const held = ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'dep-hold'),
      });
      await poll(() => mock.hits.length === 1, 'deployment hold');
      const other = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('other-chat', 'other-ok'),
      });
      expect(other.statusCode).toBe(200);
      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'dep-blocked'),
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('deployment_limited');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'dep-blocked')).toHaveLength(0);
      mock.release('dep-hold');
      expect((await held).statusCode).toBe(200);
      const tokens = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('other-chat', 'abcd', { max_tokens: 4 }),
      });
      expect(tokens.statusCode).toBe(429);
      expect(tokens.json().error.code).toBe('token_rate_limited');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'abcd')).toHaveLength(0);
      unknown = await startMockUpstream((_hit, _request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody('gpt-test', 'ok', null)));
      });
      unknownApp = await openApp(db, unknown.baseUrl);
      const quiet = await unknownApp.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('other-chat', 'no-bound'),
      });
      expect(quiet.statusCode).toBe(200);
      expect(unknown.hits).toHaveLength(1);
      const admin = adminPool(db);
      admins.push(admin);
      const counters = await admin.query<{ amount: string }>(
        `SELECT amount::text AS amount FROM limit_counters
         WHERE tenant_id = $1 AND scope = 'tenant_tokens'`,
        [tenant.tenantId],
      );
      expect(counters.rows.some((row) => canonicalDecimal(row.amount) === '0')).toBe(false);
      trace('deployment-token', { deployment: blocked.json().error.code, token: tokens.json().error.code, quiet: quiet.statusCode });
    } finally {
      mock.release('dep-hold');
      if (unknownApp) {
        await unknownApp.app.close();
        await unknownApp.authPool.end();
        await unknownApp.runtimePool.end();
      }
      if (unknown) await unknown.close();
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('records observation mode and fails closed when admission is unavailable', async () => {
    const tenant = provisionTenant(db, 'Limit Observe');
    const mock = await openMock(new Set());
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-limit-observe',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
    });
    tenantLimits(tenant.tenantId, 'observe', ['--requests-per-minute', '1']);
    const ctx = await openApp(db, mock.baseUrl);
    try {
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'observe-one'),
      });
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'observe-two'),
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(mock.hits).toHaveLength(2);
      const usage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/limits',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(usage.statusCode).toBe(200);
      expect(usage.json().observedUsage.requestsInWindow).toBe('2');
      expect(usage.json().configuredLimits.requestsPerMinute).toBe(1);
      expect(usage.json().configuredLimits.mode).toBe('observe');
      trace('observe', usage.json());

      tenantLimits(tenant.tenantId, 'hard', ['--requests-per-minute', '10']);
      const client = new pg.Client({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.username,
        password: db.password,
      });
      await client.connect();
      await client.query(`SELECT pg_advisory_lock(hashtextextended('admit:' || $1::text, 0))`, [tenant.tenantId]);
      try {
        const denied = await ctx.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: authHeaders(tenant.tenantId, tenant.secret),
          payload: chatPayload('limit-chat', 'db-down'),
        });
        expect(denied.statusCode).toBe(503);
        expect(denied.json().error.code).toBe('admission_unavailable');
        expect(mock.hits.filter((hit) => contentOf(hit.body) === 'db-down')).toHaveLength(0);
        trace('outage', { status: denied.statusCode, code: denied.json().error.code, hits: mock.hits.length });
      } finally {
        await client.query('SELECT pg_advisory_unlock_all()');
        await client.end();
      }
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('reacquires an expired lease and recovers a permit after a crash', async () => {
    const tenant = provisionTenant(db, 'Limit Lease');
    const mock = await openMock(new Set(['lease-hold']));
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-limit-lease',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
      timeoutMs: 5000,
    });
    tenantLimits(tenant.tenantId, 'hard', ['--concurrent-requests', '1', '--lease-ms', '200']);
    let now = Date.parse('2026-04-01T00:00:00.000Z');
    const ctx = await openApp(db, mock.baseUrl, { now: () => now });
    try {
      const held = ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'lease-hold'),
      });
      await poll(() => mock.hits.length === 1, 'lease hold');
      now += 1_000;
      const again = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'lease-again'),
      });
      expect(again.statusCode).toBe(200);
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'lease-again')).toHaveLength(1);
      mock.release('lease-hold');
      expect((await held).statusCode).toBe(200);
      trace('lease-expiry', { status: again.statusCode, hits: mock.hits.length });
    } finally {
      mock.release('lease-hold');
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }

    const crashed = provisionTenant(db, 'Limit Crash Permit');
    const crashMock = await openMock(new Set());
    registerInference(db, {
      tenantId: crashed.tenantId,
      apiKey: 'sk-limit-crash',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
    });
    tenantLimits(crashed.tenantId, 'hard', ['--concurrent-requests', '1', '--lease-ms', '200']);
    const origin = Date.parse('2026-04-02T00:00:00.000Z');
    const base = {
      UPSTREAM_BASE_URL: crashMock.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      TENANT_ID: crashed.tenantId,
      TENANT_SECRET: crashed.secret,
      CHAT_MODEL: 'limit-chat',
      CHAT_CONTENT: 'crash-permit',
    };
    const dead = await runChild({ ...base, LIMIT_NOW_MS: String(origin), CRASH_AT: 'after_admit' });
    expect(dead.exit).toBe(86);
    expect(crashMock.hits).toHaveLength(0);
    const recovered = await runChild({ ...base, LIMIT_NOW_MS: String(origin + 1_000), CHAT_CONTENT: 'after-crash' });
    expect(recovered.status).toBe(200);
    expect(crashMock.hits).toHaveLength(1);
    trace('crash-permit', { dead: dead.exit, recovered: recovered.status, hits: crashMock.hits.length });
    await crashMock.close();
  });

  it('keeps the process-local stream cap and the private deployment cap when they are stricter', async () => {
    const tenant = provisionTenant(db, 'Limit Local Stream');
    const sse = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
    let releaseStream = (): void => undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const mock = await startMockUpstream((hit, _request, response) => {
      if (contentOf(hit.body) !== 'local-hold') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
        return;
      }
      void streamGate.then(() => {
        if (response.writableEnded) return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sse);
      });
    });
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-local-stream',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'limit-chat' });
    tenantLimits(tenant.tenantId, 'hard', ['--concurrent-streams', '10']);
    const ctx = await openApp(db, mock.baseUrl, { maxStreamsPerTenant: 1, maxActiveStreams: 1 });
    try {
      const first = ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'local-hold', { stream: true }),
      });
      await poll(() => mock.hits.length === 1, 'local stream hold');
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('limit-chat', 'local-second', { stream: true }),
      });
      expect(second.statusCode).toBe(503);
      expect(second.json().error.code).toBe('stream_capacity');
      expect(mock.hits).toHaveLength(1);
      releaseStream();
      expect((await first).statusCode).toBe(200);
      trace('local-stream', { status: second.statusCode, code: second.json().error.code });
    } finally {
      releaseStream();
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }

    const privateMock = await startPrivateMock();
    const refused = await closedPort();
    const bridge = bridgePrivateMock(privateMock, refused);
    const owner = provision(db, 'Limit Private');
    registerPrivate(db, { tenantId: owner.tenantId, concurrency: 1 });
    runCli(db, ['set-deployment-enabled', '--tenant-id', owner.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    runCli(
      db,
      ['set-deployment-limit', '--tenant-id', owner.tenantId, '--deployment', 'dgx-chat', '--mode', 'hard', '--max-concurrency', '5'],
      cliEnv(),
    );
    const server = await listenPrivate(db, bridge.fetch, pinResolver(PRIVATE_PIN));
    try {
      const held = postChat(server.baseURL, owner.tenantId, owner.secret, {
        model: 'dgx-chat',
        messages: [{ role: 'user', content: 'scene-hold' }],
      });
      const arrived = await Promise.race([
        privateMock.waitFor('hold').then(() => 'held' as const),
        held.then(async (response) => `${response.status} ${await response.clone().text()}`),
      ]);
      expect(arrived).toBe('held');
      const blocked = await postChat(server.baseURL, owner.tenantId, owner.secret, {
        model: 'dgx-chat',
        messages: [{ role: 'user', content: 'scene-second' }],
      });
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain('concurrency_limit');
      expect(privateMock.hits).toHaveLength(1);
      privateMock.release('hold');
      expect((await held).status).toBe(200);
      trace('private-cap', { status: blocked.status, hits: privateMock.hits.length });
    } finally {
      privateMock.release('hold');
      await server.close();
      await privateMock.close();
    }
  });

  it('shows capacity only to the authenticated tenant and does not mutate policy over HTTP', async () => {
    const alpha = provisionTenant(db, 'Limit Inspect Alpha');
    const beta = provisionTenant(db, 'Limit Inspect Beta');
    const mock = await openMock(new Set());
    registerInference(db, {
      tenantId: alpha.tenantId,
      apiKey: 'sk-inspect-alpha',
      deployment: 'limit-chat',
      upstreamModel: 'gpt-limit',
    });
    tenantLimits(alpha.tenantId, 'observe', ['--requests-per-minute', '9', '--concurrent-requests', '3']);
    runCli(db, ['set-tenant-budget', '--tenant-id', alpha.tenantId, '--mode', 'observe', '--monthly-amount', '12.5'], cliEnv());
    const ctx = await openApp(db, mock.baseUrl);
    try {
      const chat = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(alpha.tenantId, alpha.secret),
        payload: chatPayload('limit-chat', 'inspect-one'),
      });
      expect(chat.statusCode).toBe(200);
      const headers = authHeaders(alpha.tenantId, alpha.secret);
      const limits = await ctx.app.inject({ method: 'GET', url: '/internal/v1/limits', headers });
      const budget = await ctx.app.inject({ method: 'GET', url: '/internal/v1/budgets/usage', headers });
      expect(limits.statusCode).toBe(200);
      expect(budget.statusCode).toBe(200);
      for (const body of [limits.json(), budget.json()]) {
        expect(body.configuredLimits.requestsPerMinute).toBe(9);
        expect(body.observedUsage.requestsInWindow).toBe('1');
        expect(body.reservedCapacity.concurrency).toBeDefined();
        expect(body.remainingBudget).toBe('12.5');
        expect(body.costStatus).toBeDefined();
      }
      const missing = await ctx.app.inject({ method: 'GET', url: '/internal/v1/limits' });
      const wrong = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(alpha.tenantId, 'not-the-secret'),
      });
      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(missing.json().configuredLimits).toBeUndefined();
      expect(wrong.json().remainingBudget).toBeUndefined();
      const betaView = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/limits',
        headers: authHeaders(beta.tenantId, beta.secret),
      });
      expect(betaView.statusCode).toBe(200);
      expect(betaView.json().configuredLimits.requestsPerMinute).toBeNull();
      expect(betaView.json().budget.allocated).toBeNull();
      expect(JSON.stringify(betaView.json())).not.toContain(alpha.keyId);
      const mutate = await ctx.app.inject({
        method: 'POST',
        url: '/internal/v1/limits',
        headers,
        payload: { mode: 'hard', requestsPerMinute: 1 },
      });
      const publicMutate = await ctx.app.inject({
        method: 'POST',
        url: '/v1/limits',
        headers,
        payload: { mode: 'hard' },
      });
      expect(mutate.statusCode).toBe(404);
      expect(publicMutate.statusCode).toBe(404);
      const after = await ctx.app.inject({ method: 'GET', url: '/internal/v1/limits', headers });
      expect(after.json().configuredLimits.mode).toBe('observe');
      expect(after.json().configuredLimits.requestsPerMinute).toBe(9);
      trace('inspect', { limits: limits.json(), beta: betaView.json(), wrong: wrong.statusCode });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });
});
