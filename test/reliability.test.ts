import { spawn } from 'node:child_process';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalDecimal } from '../src/inference/cost.js';
import {
  createTestApp,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
} from './helpers.js';
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

type Tenant = ReturnType<typeof provisionTenant>;
type Script =
  | { type: 'ok' }
  | { type: 'slow'; ms: number }
  | { type: 'status'; status: number; retryAfter?: string; thenOk?: boolean }
  | { type: 'hang' }
  | { type: 'partial' }
  | { type: 'close' }
  | { type: 'malformed' }
  | { type: 'missing-usage' }
  | { type: 'sse' }
  | { type: 'sse-cut' }
  | { type: 'hold'; usage?: Record<string, number> | null };

type AttemptRow = {
  attempt_ordinal: number;
  status: string;
  failure_class: string | null;
  dispatched: boolean;
  expense_certainty: string | null;
  duration_ms: number | null;
  error_code: string | null;
  request_id: string;
  upstream_model: string;
  prompt_tokens: number | null;
  stream_status: string | null;
  amount: string | null;
  cost_status: string | null;
  request_status: string;
  reservation_status: string | null;
  reserved: string | null;
};

type ChildResult = { status: number | null; code: string | null; exit: number | null; stderr: string };

const PARTIAL = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"rel","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n`;
const EFFECTIVE = '2020-01-01T00:00:00.000Z';

function money(value: unknown): string {
  return canonicalDecimal(String(value));
}

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

function contentOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

function modelOf(body: string): string {
  try {
    return String((JSON.parse(body) as { model?: string }).model ?? '');
  } catch {
    return '';
  }
}

function errorCode(response: { json: () => unknown }): string | null {
  try {
    const body = response.json() as { error?: { code?: string } };
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}

function sseBody(model: string, content: string): string {
  const head = { id: 'chatcmpl-rel', object: 'chat.completion.chunk', created: 1_700_000_000, model };
  return [
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function disc(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index] ?? null;
}

function note(kind: string, fields: Record<string, unknown>): void {
  console.log(`RELIABILITY_${kind} ${JSON.stringify(fields)}`);
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('closed port is missing');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe('reliability controls', () => {
  const db = loadTestDatabase();
  const pools: Array<{ end: () => Promise<unknown> }> = [];
  const scripts = new Map<string, Script>();
  const counts = new Map<string, number>();
  const delays = new Map<string, number>();
  const held = new Map<string, { response: ServerResponse; model: string }>();
  let vertexCalls = 0;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: pg.Pool;

  function cli(args: string[]): Record<string, unknown> {
    return runCli(db, args, cliEnv()) as unknown as Record<string, unknown>;
  }

  function price(model: string, rates: { input?: string; output?: string; allocated?: string }): void {
    const args = [
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      model,
      '--effective-at',
      EFFECTIVE,
      '--source',
      'fixture',
      '--status',
      'verified',
    ];
    if (rates.input !== undefined) args.push('--input-rate', rates.input);
    if (rates.output !== undefined) args.push('--output-rate', rates.output);
    if (rates.allocated !== undefined) args.push('--allocated-rate', rates.allocated);
    cli(args);
  }

  function addDeployment(tenantId: string, name: string, model: string): void {
    cli([
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--name',
      name,
      '--upstream-model',
      model,
      '--timeout-ms',
      '5000',
      '--capabilities',
      'temperature,max_tokens',
      '--enabled',
      'true',
    ]);
  }

  async function ready(tenantId: string, name: string): Promise<void> {
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    cli(['set-deployment-context-limit', '--tenant-id', tenantId, '--deployment', name, '--context-limit', '128']);
    cli([
      'set-deployment-data-collection',
      '--tenant-id',
      tenantId,
      '--deployment',
      name,
      '--data-collection',
      'allow',
    ]);
  }

  function execution(
    tenantId: string,
    deployment: string,
    input: {
      retries: boolean;
      connection?: number;
      attempt?: number;
      total?: number;
      initial?: number;
      max?: number;
    },
  ): void {
    cli([
      'set-execution-policy',
      '--tenant-id',
      tenantId,
      '--deployment',
      deployment,
      '--retries',
      input.retries ? 'true' : 'false',
      '--connection-deadline-ms',
      String(input.connection ?? 5_000),
      '--attempt-deadline-ms',
      String(input.attempt ?? 5_000),
      '--total-deadline-ms',
      String(input.total ?? 5_000),
      '--initial-backoff-ms',
      String(input.initial ?? 0),
      '--max-backoff-ms',
      String(input.max ?? 0),
    ]);
  }

  function fallback(
    tenantId: string,
    deployments: string[],
    options: { enabled?: boolean; failures?: string[]; providers?: string; regions?: string[] } = {},
  ): void {
    const args = [
      'set-fallback-policy',
      '--tenant-id',
      tenantId,
      '--alias',
      'auto',
      '--enabled',
      options.enabled === false ? 'false' : 'true',
      '--deployments',
      deployments.join(','),
      '--failures',
      (options.failures ?? ['unavailable']).join(','),
      '--max-attempts',
      '2',
      '--capabilities',
      'temperature',
      '--providers',
      options.providers ?? 'openai',
      '--data-collection',
      'allow',
      '--min-remaining-deadline-ms',
      '0',
    ];
    if (options.regions !== undefined && options.regions.length > 0) args.push('--regions', options.regions.join(','));
    cli(args);
  }

  function tenantWith(name: string, model: string, deployment = 'rel-chat'): Tenant {
    const tenant = provisionTenant(db, name);
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: `sk-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      deployment,
      upstreamModel: model,
      capabilities: 'temperature,max_tokens',
    });
    return tenant;
  }

  function release(content: string): void {
    const heldResponse = held.get(content);
    if (heldResponse === undefined || heldResponse.response.writableEnded) return;
    held.delete(content);
    const script = scripts.get(content);
    const usage = script?.type === 'hold' ? script.usage : undefined;
    heldResponse.response.writeHead(200, { 'content-type': 'application/json' });
    heldResponse.response.end(JSON.stringify(completionBody(heldResponse.model, 'ok', usage)));
  }

  async function mark(): Promise<Date> {
    const result = await admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return result.rows[0]?.now ?? new Date();
  }

  async function rowsSince(tenantId: string, since: Date): Promise<AttemptRow[]> {
    const result = await admin.query<AttemptRow>(
      `SELECT a.attempt_ordinal, a.status, a.failure_class, a.dispatched, a.expense_certainty,
              a.duration_ms, a.error_code, a.request_id::text, a.upstream_model, a.prompt_tokens,
              a.stream_status, ac.amount::text AS amount, ac.cost_status,
              r.status AS request_status, br.status AS reservation_status,
              br.reserved_amount::text AS reserved
       FROM model_attempts a
       JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
       LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
       LEFT JOIN budget_reservations br ON br.tenant_id = a.tenant_id AND br.attempt_id = a.id
       WHERE a.tenant_id = $1 AND a.created_at >= $2
       ORDER BY a.created_at, a.attempt_ordinal`,
      [tenantId, since],
    );
    return result.rows;
  }

  async function ledger(tenantId: string): Promise<{ recognized: string; settles: string; active: string }> {
    const result = await admin.query<{ recognized: string; settles: string; active: string }>(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'settle'), 0)::text AS recognized,
         (SELECT count(*) FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'settle')::text AS settles,
         (SELECT count(*) FROM budget_reservations WHERE tenant_id = $1 AND status = 'active')::text AS active`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('ledger is missing');
    return { recognized: money(row.recognized), settles: row.settles, active: row.active };
  }

  function recover(tenantId: string): number {
    return Number(cli(['recover-budget', '--tenant-id', tenantId]).closed ?? -1);
  }

  async function chat(
    tenant: Tenant,
    model: string,
    content: string,
    extra: Record<string, unknown> = {},
    app: Awaited<ReturnType<typeof createTestApp>>['app'] = ctx.app,
  ) {
    const started = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: chatPayload(model, content, extra),
    });
    return { response, elapsedMs: Date.now() - started };
  }

  function runChild(script: string, env: Record<string, string>): Promise<ChildResult> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(projectRoot, script)], {
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

  async function poll(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > 15_000) throw new Error(label);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function childEnv(tenant: Tenant, model: string, content: string, now: number): Record<string, string> {
    return {
      UPSTREAM_BASE_URL: mock.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      LIMIT_NOW_MS: String(now),
      TENANT_ID: tenant.tenantId,
      TENANT_SECRET: tenant.secret,
      CHAT_MODEL: model,
      CHAT_CONTENT: content,
    };
  }

  function finish(kind: string, name: string, fields: Record<string, unknown>): void {
    note(kind, { case: name, ...fields });
  }

  beforeAll(async () => {
    mock = await startMockUpstream((hit, request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; messages?: Array<{ content?: string }> };
      const content = parsed.messages?.[0]?.content ?? '';
      const model = parsed.model ?? 'gpt-test';
      const script = scripts.get(`${model}\u0000${content}`) ?? scripts.get(content) ?? scripts.get(model) ?? { type: 'ok' };
      const count = (counts.get(content) ?? 0) + 1;
      counts.set(content, count);
      if (script.type === 'hang') return;
      if (script.type === 'close') {
        request.socket.destroy();
        return;
      }
      if (script.type === 'partial') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(PARTIAL);
        return;
      }
      if (script.type === 'sse-cut') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(PARTIAL);
        response.destroy();
        return;
      }
      if (script.type === 'sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseBody(model, `from-${model}`));
        return;
      }
      if (script.type === 'malformed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('not-json');
        return;
      }
      if (script.type === 'missing-usage') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(model, 'no-usage', null)));
        return;
      }
      if (script.type === 'slow') {
        const started = Date.now();
        setTimeout(() => {
          delays.set(content, Date.now() - started);
          if (response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completionBody(model, 'slow-ok')));
        }, script.ms);
        return;
      }
      if (script.type === 'hold') {
        held.set(content, { response, model });
        return;
      }
      if (script.type === 'status') {
        const fail = script.thenOk !== true || count === 1;
        if (fail) {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (script.retryAfter !== undefined) headers['retry-after'] = script.retryAfter;
          response.writeHead(script.status, headers);
          response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
          return;
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(model, `from-${model}`)));
    });
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      vertexClientFactory: () => {
        vertexCalls += 1;
        throw new Error('vertex was called');
      },
    });
    admin = adminPool(db);
    pools.push(ctx.authPool, ctx.runtimePool, admin);
  });

  beforeEach(() => {
    scripts.clear();
    counts.clear();
    delays.clear();
    vertexCalls = 0;
    for (const item of held.values()) {
      if (!item.response.writableEnded) item.response.destroy();
    }
    held.clear();
    mock.hits.length = 0;
  });

  afterAll(async () => {
    for (const item of held.values()) {
      if (!item.response.writableEnded) item.response.destroy();
    }
    if (mock !== undefined) await mock.close();
    if (ctx !== undefined) await ctx.app.close();
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('records a normal response, a slow response, and a missing usage count', async () => {
    const normal = tenantWith('Rel Normal', 'rel-normal');
    const slow = tenantWith('Rel Slow', 'rel-slow');
    const missing = tenantWith('Rel Missing Usage', 'rel-missing-usage');
    price('rel-normal', { input: '0.01', output: '0.02' });
    price('rel-slow', { input: '0.01', output: '0.02' });
    price('rel-missing-usage', { input: '0.01', output: '0.02' });
    cli(['set-tenant-budget', '--tenant-id', normal.tenantId, '--mode', 'observe', '--monthly-amount', '10']);
    cli(['set-tenant-budget', '--tenant-id', missing.tenantId, '--mode', 'observe', '--monthly-amount', '10']);
    scripts.set('slow-body', { type: 'slow', ms: 80 });
    scripts.set('missing-body', { type: 'missing-usage' });

    const normalSince = await mark();
    const normalCall = await chat(normal, 'auto', 'normal-body');
    const normalRows = await rowsSince(normal.tenantId, normalSince);
    expect(normalCall.response.statusCode).toBe(200);
    expect(normalCall.response.json().object).toBe('chat.completion');
    expect(normalCall.response.json().choices[0].message.content).toBe('from-rel-normal');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'normal-body')).toHaveLength(1);
    expect(normalRows).toHaveLength(1);
    expect(normalRows[0]?.status).toBe('succeeded');
    expect(money(normalRows[0]?.amount)).toBe(money('0.07'));
    expect(normalRows[0]?.cost_status).toBe('estimated');
    expect(normalRows[0]?.reservation_status).toBe('settled');
    finish('FAULT', 'normal', {
      status: normalCall.response.statusCode,
      hits: 1,
      failureClass: normalRows[0]?.failure_class ?? null,
      amount: normalRows[0]?.amount,
      costStatus: normalRows[0]?.cost_status,
      reservation: normalRows[0]?.reservation_status,
      elapsedMs: normalCall.elapsedMs,
    });

    const slowSince = await mark();
    const slowCall = await chat(slow, 'auto', 'slow-body');
    const slowRows = await rowsSince(slow.tenantId, slowSince);
    const mockDelayMs = delays.get('slow-body') ?? null;
    expect(slowCall.response.statusCode).toBe(200);
    expect(slowCall.response.json().choices[0].message.content).toBe('slow-ok');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'slow-body')).toHaveLength(1);
    expect(slowRows[0]?.status).toBe('succeeded');
    expect(mockDelayMs).not.toBeNull();
    finish('FAULT', 'slow', {
      status: slowCall.response.statusCode,
      hits: 1,
      elapsedMs: slowCall.elapsedMs,
      mockDelayMs,
      overheadMs: mockDelayMs === null ? null : slowCall.elapsedMs - mockDelayMs,
      amount: slowRows[0]?.amount,
      costStatus: slowRows[0]?.cost_status,
    });

    const missingSince = await mark();
    const missingCall = await chat(missing, 'auto', 'missing-body');
    const missingRows = await rowsSince(missing.tenantId, missingSince);
    expect(missingCall.response.statusCode).toBe(200);
    expect(missingCall.response.json().usage).toBeUndefined();
    expect(missingRows[0]?.prompt_tokens).toBeNull();
    expect(missingRows[0]?.amount).toBeNull();
    expect(missingRows[0]?.amount).not.toBe('0');
    expect(missingRows[0]?.cost_status).toBe('unknown');
    finish('FAULT', 'missing-usage', {
      status: missingCall.response.statusCode,
      hits: 1,
      promptTokens: missingRows[0]?.prompt_tokens ?? null,
      amount: missingRows[0]?.amount,
      costStatus: missingRows[0]?.cost_status,
      reservation: missingRows[0]?.reservation_status,
    });
  });

  it('retries a refused connection and stops on each timeout bound', async () => {
    const refused = tenantWith('Rel Refused', 'rel-refused');
    execution(refused.tenantId, 'rel-chat', { retries: true });
    const port = await closedPort();
    const closed = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      credentialKey,
    });
    pools.push(closed.authPool, closed.runtimePool);
    try {
      const since = await mark();
      const response = await chat(refused, 'auto', 'refused-body', {}, closed.app);
      const stored = await rowsSince(refused.tenantId, since);
      expect(response.response.statusCode).toBeGreaterThanOrEqual(500);
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.failure_class === 'connection_failure')).toBe(true);
      expect(stored.every((row) => row.expense_certainty === 'none')).toBe(true);
      expect(stored.every((row) => row.amount === null)).toBe(true);
      expect(stored.some((row) => row.amount === '0')).toBe(false);
      finish('FAULT', 'connection-refused', {
        status: response.response.statusCode,
        code: errorCode(response.response),
        hits: 0,
        attempts: stored.length,
        failureClass: stored[0]?.failure_class,
        amount: stored[0]?.amount,
        elapsedMs: response.elapsedMs,
      });
    } finally {
      await closed.app.close();
    }

    const timed = tenantWith('Rel Timeout', 'rel-timeout');
    execution(timed.tenantId, 'rel-chat', { retries: true, connection: 200, attempt: 5_000, total: 5_000 });
    scripts.set('before-send', { type: 'hang' });
    const beforeSince = await mark();
    const before = await chat(timed, 'auto', 'before-send');
    const beforeRows = await rowsSince(timed.tenantId, beforeSince);
    expect(before.response.statusCode).toBe(504);
    expect(errorCode(before.response)).toBe('timeout');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'before-send')).toHaveLength(1);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]?.failure_class).toBe('timeout_before_dispatch');
    expect(beforeRows[0]?.amount).toBeNull();
    finish('FAULT', 'timeout-before-send', {
      status: before.response.statusCode,
      hits: 1,
      failureClass: beforeRows[0]?.failure_class,
      amount: beforeRows[0]?.amount,
      expense: beforeRows[0]?.expense_certainty,
      elapsedMs: before.elapsedMs,
    });

    execution(timed.tenantId, 'rel-chat', { retries: true, connection: 5_000, attempt: 200, total: 5_000 });
    scripts.set('after-send', { type: 'hang' });
    const afterSince = await mark();
    const after = await chat(timed, 'auto', 'after-send');
    const afterRows = await rowsSince(timed.tenantId, afterSince);
    expect(after.response.statusCode).toBe(504);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'after-send')).toHaveLength(1);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.failure_class).toBe('timeout_after_dispatch');
    expect(afterRows[0]?.cost_status).toBe('unknown');
    expect(afterRows[0]?.amount).toBeNull();
    expect(afterRows[0]?.amount).not.toBe('0');
    finish('FAULT', 'timeout-after-send', {
      status: after.response.statusCode,
      hits: 1,
      failureClass: afterRows[0]?.failure_class,
      costStatus: afterRows[0]?.cost_status,
      amount: afterRows[0]?.amount,
      expense: afterRows[0]?.expense_certainty,
      elapsedMs: after.elapsedMs,
    });
  });

  it('caps retryable HTTP failures and stores overload as an existing class', async () => {
    const limited = tenantWith('Rel Http', 'rel-http');
    execution(limited.tenantId, 'rel-chat', { retries: true });
    scripts.set('rate-limit-body', { type: 'status', status: 429, thenOk: true });
    const rateSince = await mark();
    const rate = await chat(limited, 'auto', 'rate-limit-body');
    const rateRows = await rowsSince(limited.tenantId, rateSince);
    expect(rate.response.statusCode).toBe(200);
    expect(rate.response.json().object).toBe('chat.completion');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'rate-limit-body')).toHaveLength(2);
    expect(rateRows.map((row) => row.failure_class)).toEqual(['rate_limit', null]);
    finish('FAULT', 'http-429', {
      status: rate.response.statusCode,
      hits: 2,
      failureClasses: rateRows.map((row) => row.failure_class),
      elapsedMs: rate.elapsedMs,
    });

    scripts.set('always-429', { type: 'status', status: 429 });
    const capSince = await mark();
    const cap = await chat(limited, 'auto', 'always-429');
    const capRows = await rowsSince(limited.tenantId, capSince);
    expect(cap.response.statusCode).toBe(429);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'always-429')).toHaveLength(2);
    expect(capRows.every((row) => row.failure_class === 'rate_limit')).toBe(true);
    finish('FAULT', 'http-429-cap', {
      status: cap.response.statusCode,
      hits: 2,
      attempts: capRows.length,
      failureClass: 'rate_limit',
    });

    scripts.set('unavailable-body', { type: 'status', status: 503 });
    const downSince = await mark();
    const down = await chat(limited, 'auto', 'unavailable-body');
    const downRows = await rowsSince(limited.tenantId, downSince);
    expect(down.response.statusCode).toBe(502);
    expect(errorCode(down.response)).toBe('upstream_error');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'unavailable-body')).toHaveLength(2);
    expect(downRows.every((row) => row.failure_class === 'unavailable')).toBe(true);
    finish('FAULT', 'http-503', {
      status: down.response.statusCode,
      code: errorCode(down.response),
      hits: 2,
      failureClass: 'unavailable',
      elapsedMs: down.elapsedMs,
    });

    scripts.set('overload-body', { type: 'status', status: 529 });
    const overSince = await mark();
    const over = await chat(limited, 'auto', 'overload-body');
    const overRows = await rowsSince(limited.tenantId, overSince);
    expect(over.response.statusCode).toBe(502);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'overload-body')).toHaveLength(1);
    expect(overRows).toHaveLength(1);
    expect(overRows[0]?.failure_class).toBe('upstream_error');
    expect(overRows[0]?.amount).not.toBe('0');
    finish('FAULT', 'provider-overload', {
      injectedStatus: 529,
      status: over.response.statusCode,
      hits: 1,
      failureClass: overRows[0]?.failure_class,
      amount: overRows[0]?.amount,
      costStatus: overRows[0]?.cost_status,
    });
  });

  it('stores a malformed body, a closed socket, and a partial stream', async () => {
    const broken = tenantWith('Rel Malformed', 'rel-malformed');
    execution(broken.tenantId, 'rel-chat', { retries: true });
    scripts.set('malformed-body', { type: 'malformed' });
    const badSince = await mark();
    const bad = await chat(broken, 'auto', 'malformed-body');
    const badRows = await rowsSince(broken.tenantId, badSince);
    expect(bad.response.statusCode).toBe(502);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'malformed-body')).toHaveLength(1);
    expect(badRows).toHaveLength(1);
    expect(badRows[0]?.failure_class).toBe('upstream_error');
    expect(badRows[0]?.amount).not.toBe('0');
    finish('FAULT', 'malformed', {
      status: bad.response.statusCode,
      code: errorCode(bad.response),
      hits: 1,
      failureClass: badRows[0]?.failure_class,
      amount: badRows[0]?.amount,
      costStatus: badRows[0]?.cost_status,
    });

    const closed = tenantWith('Rel Close', 'rel-close');
    execution(closed.tenantId, 'rel-chat', { retries: true });
    scripts.set('close-body', { type: 'close' });
    const closeSince = await mark();
    const closedCall = await chat(closed, 'auto', 'close-body');
    const closeRows = await rowsSince(closed.tenantId, closeSince);
    const closeHits = mock.hits.filter((hit) => contentOf(hit.body) === 'close-body');
    expect(closedCall.response.statusCode).toBe(502);
    expect(closeHits).toHaveLength(1);
    expect(closeRows).toHaveLength(1);
    expect(closeRows[0]?.failure_class).toBe('ambiguous_network');
    expect(closeRows[0]?.amount).toBeNull();
    expect(closeRows[0]?.amount).not.toBe('0');
    finish('FAULT', 'connection-close', {
      status: closedCall.response.statusCode,
      code: errorCode(closedCall.response),
      hits: closeHits.length,
      attempts: closeRows.length,
      failureClass: closeRows[0]?.failure_class,
      amount: closeRows[0]?.amount,
      costStatus: closeRows[0]?.cost_status,
      expense: closeRows[0]?.expense_certainty,
    });

    const stream = tenantWith('Rel Partial', 'rel-partial');
    enableStreaming(db, { tenantId: stream.tenantId, deployment: 'rel-chat' });
    execution(stream.tenantId, 'rel-chat', { retries: true });
    const plainPartial = tenantWith('Rel Partial Plain', 'rel-partial-plain');
    execution(plainPartial.tenantId, 'rel-chat', { retries: true });
    scripts.set('partial-plain', { type: 'partial' });
    const plainSince = await mark();
    const plainCall = await chat(plainPartial, 'auto', 'partial-plain');
    const plainRows = await rowsSince(plainPartial.tenantId, plainSince);
    const plainHits = mock.hits.filter((hit) => contentOf(hit.body) === 'partial-plain');
    expect(plainCall.response.statusCode).toBe(502);
    expect(errorCode(plainCall.response)).toBe('invalid_upstream_response');
    expect(plainHits).toHaveLength(1);
    expect(plainRows).toHaveLength(1);
    expect(plainRows[0]?.failure_class).toBe('upstream_error');
    expect(plainRows[0]?.amount).toBeNull();
    expect(plainRows[0]?.amount).not.toBe('0');
    finish('FAULT', 'partial-sse-nonstream', {
      status: plainCall.response.statusCode,
      code: errorCode(plainCall.response),
      hits: plainHits.length,
      failureClass: plainRows[0]?.failure_class,
      amount: plainRows[0]?.amount,
      costStatus: plainRows[0]?.cost_status,
    });

    scripts.set('partial-body', { type: 'partial' });
    const partialSince = await mark();
    const partial = await chat(stream, 'auto', 'partial-body', { stream: true });
    const partialRows = await rowsSince(stream.tenantId, partialSince);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'partial-body')).toHaveLength(1);
    expect(partial.response.body.includes('data: [DONE]')).toBe(false);
    expect(partialRows).toHaveLength(1);
    expect(partialRows[0]?.failure_class).toBe('stream_started');
    expect(partialRows[0]?.amount).not.toBe('0');
    finish('FAULT', 'partial-sse', {
      status: partial.response.statusCode,
      hits: 1,
      failureClass: partialRows[0]?.failure_class,
      streamStatus: partialRows[0]?.stream_status,
      amount: partialRows[0]?.amount,
      done: false,
    });

    scripts.set('cut-body', { type: 'sse-cut' });
    const cutSince = await mark();
    const cut = await chat(stream, 'rel-chat', 'cut-body', { stream: true });
    const cutRows = await rowsSince(stream.tenantId, cutSince);
    expect(cut.response.statusCode).toBe(502);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'cut-body')).toHaveLength(1);
    expect(cut.response.body.includes('data: [DONE]')).toBe(false);
    expect(cutRows).toHaveLength(1);
    expect(cutRows[0]?.failure_class).toBe('ambiguous_network');
    expect(modelOf(mock.hits.find((hit) => contentOf(hit.body) === 'cut-body')?.body ?? '')).toBe('rel-partial');
    finish('FAULT', 'unexpected-close-stream', {
      status: cut.response.statusCode,
      hits: 1,
      failureClass: cutRows[0]?.failure_class,
      streamStatus: cutRows[0]?.stream_status,
      amount: cutRows[0]?.amount,
      model: 'rel-partial',
      done: false,
    });
  });

  it('stops retry at a hard budget and at the total deadline', async () => {
    const budgeted = tenantWith('Rel Retry Budget', 'rel-retry-budget');
    const content = 'b'.repeat(12);
    price('rel-retry-budget', { input: '1' });
    cli(['set-tenant-budget', '--tenant-id', budgeted.tenantId, '--mode', 'hard', '--monthly-amount', '12']);
    execution(budgeted.tenantId, 'rel-chat', { retries: true });
    scripts.set(content, { type: 'status', status: 429, thenOk: true });
    const since = await mark();
    const response = await chat(budgeted, 'auto', content);
    const stored = await rowsSince(budgeted.tenantId, since);
    const hits = mock.hits.filter((hit) => contentOf(hit.body) === content);
    expect(response.response.statusCode).toBe(429);
    expect(errorCode(response.response)).toBe('budget_exceeded');
    expect(hits).toHaveLength(1);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.failure_class).toBe('rate_limit');
    expect(stored[1]?.dispatched).toBe(false);
    expect(stored[1]?.error_code).toBe('budget_exceeded');
    finish('COMBINED', 'retry-budget', {
      status: response.response.statusCode,
      code: errorCode(response.response),
      hits: hits.length,
      attempts: stored.length,
      failureClass: stored[0]?.failure_class,
      secondDispatched: stored[1]?.dispatched,
      reservation: stored[0]?.reservation_status,
      reserved: stored[0]?.reserved,
    });

    const deadline = tenantWith('Rel Retry Deadline', 'rel-retry-deadline');
    execution(deadline.tenantId, 'rel-chat', { retries: true, connection: 5_000, attempt: 5_000, total: 1_500 });
    scripts.set('deadline-body', { type: 'status', status: 429, retryAfter: '10', thenOk: true });
    const deadlineSince = await mark();
    const stopped = await chat(deadline, 'auto', 'deadline-body');
    const deadlineRows = await rowsSince(deadline.tenantId, deadlineSince);
    expect(stopped.response.statusCode).toBe(429);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'deadline-body')).toHaveLength(1);
    expect(deadlineRows).toHaveLength(1);
    expect(deadlineRows[0]?.failure_class).toBe('rate_limit');
    finish('COMBINED', 'retry-total-deadline', {
      status: stopped.response.statusCode,
      hits: 1,
      attempts: 1,
      failureClass: deadlineRows[0]?.failure_class,
      elapsedMs: stopped.elapsedMs,
    });
  });

  it('applies breaker, budget, region, and concurrency bounds to fallback', async () => {
    const open = tenantWith('Rel Open Breaker', 'rel-open-primary');
    addDeployment(open.tenantId, 'rel-open-secondary', 'rel-open-secondary');
    await ready(open.tenantId, 'rel-open-secondary');
    execution(open.tenantId, 'rel-chat', { retries: false });
    cli([
      'set-deployment-breaker',
      '--tenant-id',
      open.tenantId,
      '--deployment',
      'rel-chat',
      '--enabled',
      'true',
      '--window-ms',
      '60000',
      '--min-samples',
      '2',
      '--failure-threshold',
      '1',
      '--cooldown-ms',
      '60000',
      '--max-probes',
      '1',
    ]);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'open', state_reason = 'failure_threshold', cooldown_until = now() + interval '1 hour'
       WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'rel-chat')`,
      [open.tenantId],
    );
    fallback(open.tenantId, ['rel-open-secondary'], { failures: ['unavailable'] });
    scripts.set('open-primary', { type: 'ok' });
    const openSince = await mark();
    const blocked = await chat(open, 'auto', 'open-primary');
    const openRows = await rowsSince(open.tenantId, openSince);
    expect(blocked.response.statusCode).toBe(503);
    expect(errorCode(blocked.response)).toBe('circuit_open');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'open-primary')).toHaveLength(0);
    expect(openRows.every((row) => row.dispatched === false)).toBe(true);
    finish('COMBINED', 'breaker-fallback', {
      status: blocked.response.statusCode,
      code: errorCode(blocked.response),
      hits: 0,
      attempts: openRows.length,
      models: [],
    });

    const skipped = tenantWith('Rel Skip Breaker', 'rel-skip-primary');
    addDeployment(skipped.tenantId, 'rel-skip-secondary', 'rel-skip-secondary');
    await ready(skipped.tenantId, 'rel-skip-secondary');
    execution(skipped.tenantId, 'rel-chat', { retries: false });
    cli([
      'set-deployment-breaker',
      '--tenant-id',
      skipped.tenantId,
      '--deployment',
      'rel-skip-secondary',
      '--enabled',
      'true',
      '--window-ms',
      '60000',
      '--min-samples',
      '2',
      '--failure-threshold',
      '1',
      '--cooldown-ms',
      '60000',
      '--max-probes',
      '1',
    ]);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'open', state_reason = 'failure_threshold', cooldown_until = now() + interval '1 hour'
       WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'rel-skip-secondary')`,
      [skipped.tenantId],
    );
    fallback(skipped.tenantId, ['rel-skip-secondary'], { failures: ['unavailable'] });
    scripts.set('skip-secondary', { type: 'status', status: 503 });
    const skipCall = await chat(skipped, 'auto', 'skip-secondary');
    const skipHits = mock.hits.filter((hit) => contentOf(hit.body) === 'skip-secondary');
    expect(skipCall.response.statusCode).toBeGreaterThanOrEqual(500);
    expect(skipHits.map((hit) => modelOf(hit.body))).toEqual(['rel-skip-primary']);
    finish('COMBINED', 'candidate-breaker', {
      status: skipCall.response.statusCode,
      hits: skipHits.length,
      models: skipHits.map((hit) => modelOf(hit.body)),
    });

    const tight = tenantWith('Rel Tight Fallback', 'rel-cheap-primary');
    addDeployment(tight.tenantId, 'rel-costly', 'rel-costly');
    await ready(tight.tenantId, 'rel-costly');
    price('rel-cheap-primary', { input: '0.01' });
    price('rel-costly', { input: '10' });
    cli(['set-tenant-budget', '--tenant-id', tight.tenantId, '--mode', 'hard', '--monthly-amount', '1']);
    execution(tight.tenantId, 'rel-chat', { retries: false });
    fallback(tight.tenantId, ['rel-costly'], { failures: ['unavailable'] });
    scripts.set('tight-body', { type: 'status', status: 503 });
    const tightCall = await chat(tight, 'auto', 'tight-body');
    const tightHits = mock.hits.filter((hit) => contentOf(hit.body) === 'tight-body');
    expect(tightCall.response.statusCode).toBeGreaterThanOrEqual(500);
    expect(tightHits.map((hit) => modelOf(hit.body))).toEqual(['rel-cheap-primary']);
    finish('COMBINED', 'fallback-hard-budget', {
      status: tightCall.response.statusCode,
      hits: tightHits.length,
      models: tightHits.map((hit) => modelOf(hit.body)),
    });

    const region = tenantWith('Rel Region', 'rel-region-primary');
    const email = 'rel-vertex@example.iam.gserviceaccount.com';
    const vertexKey = JSON.stringify({
      client_email: email,
      private_key: `-----BEGIN PRIVATE KEY-----\n${'k'.repeat(80)}\n-----END PRIVATE KEY-----\n`,
    });
    cli([
      'register-vertex-connection',
      '--tenant-id',
      region.tenantId,
      '--api-key',
      vertexKey,
      '--project',
      'rel-vertex-proj',
      '--location',
      'europe-west4',
      '--service-account',
      email,
    ]);
    cli([
      'register-deployment',
      '--tenant-id',
      region.tenantId,
      '--provider',
      'vertex',
      '--name',
      'rel-vertex',
      '--upstream-model',
      'gemini-rel-region',
      '--timeout-ms',
      '5000',
      '--capabilities',
      'temperature,max_tokens',
      '--enabled',
      'true',
    ]);
    await ready(region.tenantId, 'rel-vertex');
    execution(region.tenantId, 'rel-chat', { retries: false });
    fallback(region.tenantId, ['rel-vertex'], {
      failures: ['unavailable'],
      providers: 'openai,vertex',
      regions: ['us-central1'],
    });
    scripts.set('region-body', { type: 'status', status: 503 });
    const regionCall = await chat(region, 'auto', 'region-body');
    const regionHits = mock.hits.filter((hit) => contentOf(hit.body) === 'region-body');
    expect(regionCall.response.statusCode).toBeGreaterThanOrEqual(500);
    expect(regionHits.map((hit) => modelOf(hit.body))).toEqual(['rel-region-primary']);
    expect(vertexCalls).toBe(0);
    finish('COMBINED', 'fallback-region', {
      status: regionCall.response.statusCode,
      hits: regionHits.length,
      models: regionHits.map((hit) => modelOf(hit.body)),
      vertexCalls,
      connectionLocation: 'europe-west4',
      policyRegion: 'us-central1',
    });

    const capped = tenantWith('Rel Cap One', 'rel-cap-primary');
    addDeployment(capped.tenantId, 'rel-cap-secondary', 'rel-cap-secondary');
    await ready(capped.tenantId, 'rel-cap-secondary');
    cli([
      'set-tenant-limits',
      '--tenant-id',
      capped.tenantId,
      '--mode',
      'hard',
      '--concurrent-requests',
      '1',
      '--lease-ms',
      '120000',
    ]);
    execution(capped.tenantId, 'rel-chat', { retries: false });
    fallback(capped.tenantId, ['rel-cap-secondary'], { failures: ['unavailable'] });
    scripts.set('rel-cap-primary\u0000cap-body', { type: 'status', status: 503 });
    const capCall = await chat(capped, 'auto', 'cap-body');
    const capHits = mock.hits.filter((hit) => contentOf(hit.body) === 'cap-body');
    expect(capCall.response.statusCode).toBe(200);
    expect(capCall.response.json().choices[0].message.content).toBe('from-rel-cap-secondary');
    expect(capHits.map((hit) => modelOf(hit.body))).toEqual(['rel-cap-primary', 'rel-cap-secondary']);
    expect(capCall.response.headers['x-attempt-count']).toBe('2');
    expect(capCall.response.headers['x-fallback']).toBe('true');
    finish('COMBINED', 'concurrency-cap-one', {
      status: capCall.response.statusCode,
      hits: capHits.length,
      models: capHits.map((hit) => modelOf(hit.body)),
      fallback: capCall.response.headers['x-fallback'],
    });
  });

  it('keeps a named stream on that deployment and falls back only before output', async () => {
    const named = tenantWith('Rel Named Stream', 'rel-named-stream');
    addDeployment(named.tenantId, 'rel-named-secondary', 'rel-named-secondary');
    await ready(named.tenantId, 'rel-named-secondary');
    enableStreaming(db, { tenantId: named.tenantId, deployment: 'rel-chat' });
    enableStreaming(db, { tenantId: named.tenantId, deployment: 'rel-named-secondary' });
    execution(named.tenantId, 'rel-chat', { retries: true });
    fallback(named.tenantId, ['rel-named-secondary'], { failures: ['unavailable', 'stream_started'] });
    scripts.set('named-cut', { type: 'sse-cut' });
    const namedSince = await mark();
    const namedCall = await chat(named, 'rel-chat', 'named-cut', { stream: true });
    const namedRows = await rowsSince(named.tenantId, namedSince);
    const namedHits = mock.hits.filter((hit) => contentOf(hit.body) === 'named-cut');
    expect(namedCall.response.statusCode).toBe(502);
    expect(namedHits.map((hit) => modelOf(hit.body))).toEqual(['rel-named-stream']);
    expect(namedCall.response.body.includes('data: [DONE]')).toBe(false);
    expect(namedRows).toHaveLength(1);
    expect(namedRows[0]?.failure_class).toBe('ambiguous_network');
    finish('COMBINED', 'stream-forced-model', {
      status: namedCall.response.statusCode,
      hits: namedHits.length,
      models: namedHits.map((hit) => modelOf(hit.body)),
      failureClass: namedRows[0]?.failure_class,
      streamStatus: namedRows[0]?.stream_status,
      done: false,
    });

    const early = tenantWith('Rel Early Fallback', 'rel-early-primary');
    addDeployment(early.tenantId, 'rel-early-secondary', 'rel-early-secondary');
    await ready(early.tenantId, 'rel-early-secondary');
    enableStreaming(db, { tenantId: early.tenantId, deployment: 'rel-chat' });
    enableStreaming(db, { tenantId: early.tenantId, deployment: 'rel-early-secondary' });
    execution(early.tenantId, 'rel-chat', { retries: true });
    fallback(early.tenantId, ['rel-early-secondary'], { failures: ['unavailable'] });
    scripts.set('rel-early-primary\u0000early-body', { type: 'status', status: 503 });
    scripts.set('rel-early-secondary\u0000early-body', { type: 'sse' });
    const earlyCall = await chat(early, 'auto', 'early-body', { stream: true });
    expect(earlyCall.response.statusCode).toBe(200);
    expect(earlyCall.response.body).toContain('from-rel-early-secondary');
    expect(earlyCall.response.body).toContain('data: [DONE]');
    expect(earlyCall.response.headers['x-fallback']).toBe('true');
    expect(earlyCall.response.headers['x-attempt-count']).toBe('2');
    const both = mock.hits.filter((hit) => contentOf(hit.body) === 'early-body');
    expect(both.map((hit) => modelOf(hit.body))).toEqual(['rel-early-primary', 'rel-early-secondary']);
    finish('COMBINED', 'fallback-before-output', {
      status: earlyCall.response.statusCode,
      hits: both.length,
      models: both.map((hit) => modelOf(hit.body)),
      fallback: earlyCall.response.headers['x-fallback'],
      done: true,
    });

    scripts.set('after-output', { type: 'partial' });
    const afterSince = await mark();
    const after = await chat(early, 'auto', 'after-output', { stream: true });
    const afterRows = await rowsSince(early.tenantId, afterSince);
    const afterHits = mock.hits.filter((hit) => contentOf(hit.body) === 'after-output');
    expect(afterHits).toHaveLength(1);
    expect(after.response.body.includes('data: [DONE]')).toBe(false);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.failure_class).toBe('stream_started');
    finish('COMBINED', 'no-fallback-after-output', {
      status: after.response.statusCode,
      hits: 1,
      failureClass: afterRows[0]?.failure_class,
      done: false,
    });

    const plain = tenantWith('Rel Fallback Off', 'rel-off-primary');
    execution(plain.tenantId, 'rel-chat', { retries: false });
    scripts.set('off-body', { type: 'status', status: 503 });
    const offCall = await chat(plain, 'auto', 'off-body');
    const offHits = mock.hits.filter((hit) => contentOf(hit.body) === 'off-body');
    expect(offHits).toHaveLength(1);
    expect(offCall.response.headers['x-fallback']).toBe('false');
    finish('COMBINED', 'fallback-off', {
      status: offCall.response.statusCode,
      hits: 1,
      fallback: offCall.response.headers['x-fallback'],
    });

    const bothPolicies = tenantWith('Rel Both Bounds', 'rel-both-primary');
    addDeployment(bothPolicies.tenantId, 'rel-both-secondary', 'rel-both-secondary');
    await ready(bothPolicies.tenantId, 'rel-both-secondary');
    execution(bothPolicies.tenantId, 'rel-chat', { retries: true });
    fallback(bothPolicies.tenantId, ['rel-both-secondary'], { failures: ['unavailable'] });
    scripts.set('both-body', { type: 'status', status: 503 });
    const bothCall = await chat(bothPolicies, 'auto', 'both-body');
    const bothHits = mock.hits.filter((hit) => contentOf(hit.body) === 'both-body');
    expect(bothHits).toHaveLength(2);
    expect(bothHits.map((hit) => modelOf(hit.body))).toEqual(['rel-both-primary', 'rel-both-secondary']);
    finish('COMBINED', 'retry-and-fallback-cap', {
      status: bothCall.response.statusCode,
      hits: bothHits.length,
      models: bothHits.map((hit) => modelOf(hit.body)),
    });
  });

  it('recognizes overlapping observation closes at the allocation', async () => {
    const tenant = tenantWith('Rel Overlap', 'rel-overlap', 'rel-overlap');
    price('rel-overlap', { input: '0.01' });
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'observe', '--monthly-amount', '1']);
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const left = 'L'.repeat(80);
    const right = 'R'.repeat(80);
    const usage = { prompt_tokens: 70, completion_tokens: 0, total_tokens: 70 };
    scripts.set(left, { type: 'hold', usage });
    scripts.set(right, { type: 'hold', usage });
    const local = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      now: () => now,
    });
    pools.push(local.authPool, local.runtimePool);
    const pending = [
      runChild('test/limit-child.mjs', childEnv(tenant, 'rel-overlap', left, now)),
      runChild('test/limit-child.mjs', childEnv(tenant, 'rel-overlap', right, now)),
    ];
    try {
      await poll(async () => {
        if (mock.hits.length < 2) return false;
        const active = (await rowsSince(tenant.tenantId, new Date(0))).filter((row) => row.reservation_status === 'active');
        return active.length === 2;
      }, 'overlap hold');
      release(left);
      release(right);
      const done = await Promise.all(pending);
      expect(done.map((item) => item.status)).toEqual([200, 200]);
      const usageResponse = await local.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(usageResponse.statusCode).toBe(200);
      const body = usageResponse.json();
      expect(money(body.budget.recognized)).toBe(money('1.00'));
      expect(money(body.budget.provisional)).toBe(money('0.40'));
      finish('COMBINED', 'overlap', {
        recognized: body.budget.recognized,
        provisional: body.budget.provisional,
        remaining: body.remainingBudget,
        costStatus: body.costStatus,
        hits: mock.hits.length,
        results: done.map((item) => item.status),
      });
    } finally {
      release(left);
      release(right);
      await Promise.allSettled(pending);
      await local.app.close();
    }
  });

  it('rejects an unknown price, a locked admission, and a disabled deployment', async () => {
    const unknown = tenantWith('Rel Unknown Price', 'rel-unknown-price');
    cli(['set-tenant-budget', '--tenant-id', unknown.tenantId, '--mode', 'hard', '--monthly-amount', '5']);
    const unknownSince = await mark();
    const unknownCall = await chat(unknown, 'auto', 'unknown-price');
    const unknownRows = await rowsSince(unknown.tenantId, unknownSince);
    expect(unknownCall.response.statusCode).toBe(429);
    expect(errorCode(unknownCall.response)).toBe('budget_unknown');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'unknown-price')).toHaveLength(0);
    expect(unknownRows.every((row) => row.dispatched === false)).toBe(true);
    finish('COMBINED', 'missing-provider-cost', {
      status: unknownCall.response.statusCode,
      code: errorCode(unknownCall.response),
      hits: 0,
      dispatched: false,
    });

    const locked = tenantWith('Rel Db Lock', 'rel-db-lock');
    price('rel-db-lock', { input: '0.01' });
    cli(['set-tenant-budget', '--tenant-id', locked.tenantId, '--mode', 'hard', '--monthly-amount', '5']);
    const client = new pg.Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.username,
      password: db.password,
    });
    await client.connect();
    await client.query(`SELECT pg_advisory_lock(hashtextextended('admit:' || $1::text, 0))`, [locked.tenantId]);
    const lockStarted = Date.now();
    try {
      const denied = await chat(locked, 'auto', 'db-locked');
      expect(denied.response.statusCode).toBe(503);
      expect(errorCode(denied.response)).toBe('admission_unavailable');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'db-locked')).toHaveLength(0);
      finish('COMBINED', 'database-unavailable', {
        status: denied.response.statusCode,
        code: errorCode(denied.response),
        hits: 0,
        elapsedMs: Date.now() - lockStarted,
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock_all()');
      await client.end();
    }

    const disabled = tenantWith('Rel Disabled', 'rel-disabled');
    scripts.set('still-enabled', { type: 'ok' });
    const first = await chat(disabled, 'rel-chat', 'still-enabled');
    expect(first.response.statusCode).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'still-enabled')).toHaveLength(1);
    cli(['set-deployment-enabled', '--tenant-id', disabled.tenantId, '--name', 'rel-chat', '--enabled', 'false']);
    const second = await chat(disabled, 'rel-chat', 'now-disabled');
    expect(second.response.statusCode).toBe(404);
    expect(errorCode(second.response)).toBe('model_not_found');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'now-disabled')).toHaveLength(0);
    finish('COMBINED', 'deployment-disabled', {
      before: { status: first.response.statusCode, hits: 1 },
      after: { status: second.response.statusCode, code: errorCode(second.response), hits: 0 },
    });
  });

  it('keeps credentials, models, budgets, rate limits, and telemetry on each tenant', async () => {
    const alpha = tenantWith('Rel Alpha', 'rel-alpha', 'rel-alpha');
    const beta = tenantWith('Rel Beta', 'rel-beta', 'rel-beta');
    price('rel-alpha', { input: '0.01' });
    price('rel-beta', { input: '0.01' });
    cli(['set-tenant-budget', '--tenant-id', alpha.tenantId, '--mode', 'hard', '--monthly-amount', '1']);
    cli(['set-tenant-budget', '--tenant-id', beta.tenantId, '--mode', 'hard', '--monthly-amount', '3']);
    cli(['set-tenant-limits', '--tenant-id', alpha.tenantId, '--mode', 'hard', '--requests-per-minute', '1']);
    scripts.set('alpha-hold', { type: 'hold' });
    const heldCall = chat(alpha, 'rel-alpha', 'alpha-hold');
    await poll(() => mock.hits.some((hit) => contentOf(hit.body) === 'alpha-hold'), 'alpha hold');
    const alphaUsage = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/budgets/usage',
      headers: authHeaders(alpha.tenantId, alpha.secret),
    });
    const betaUsage = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/budgets/usage',
      headers: authHeaders(beta.tenantId, beta.secret),
    });
    expect(money(betaUsage.json().remainingBudget)).toBe('3');
    expect(money(betaUsage.json().reservedCapacity.activeReservations)).toBe('0');
    expect(JSON.stringify(betaUsage.json())).not.toContain(alpha.tenantId);
    const betaCall = await chat(beta, 'rel-beta', 'beta-live');
    expect(betaCall.response.statusCode).toBe(200);
    const alphaHit = mock.hits.find((hit) => contentOf(hit.body) === 'alpha-hold');
    const betaHit = mock.hits.find((hit) => contentOf(hit.body) === 'beta-live');
    expect(alphaHit?.authorization).toContain('sk-rel-alpha');
    expect(betaHit?.authorization).toContain('sk-rel-beta');
    expect(alphaHit?.authorization).not.toContain('sk-rel-beta');
    expect(betaHit?.authorization).not.toContain('sk-rel-alpha');
    const foreign = await chat(alpha, 'rel-beta', 'alpha-foreign');
    expect(foreign.response.statusCode).toBe(404);
    expect(errorCode(foreign.response)).toBe('model_not_found');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'alpha-foreign')).toHaveLength(0);
    release('alpha-hold');
    expect((await heldCall).response.statusCode).toBe(200);
    const limited = await chat(alpha, 'rel-alpha', 'alpha-limited');
    const betaAgain = await chat(beta, 'rel-beta', 'beta-again');
    expect(limited.response.statusCode).toBe(429);
    expect(errorCode(limited.response)).toBe('tenant_rate_limited');
    expect(betaAgain.response.statusCode).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'alpha-limited')).toHaveLength(0);
    const from = new Date(Date.now() - 120_000).toISOString();
    const to = new Date(Date.now() + 120_000).toISOString();
    const alphaHistory = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/attempts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: authHeaders(alpha.tenantId, alpha.secret),
    });
    const betaHistory = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/attempts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: authHeaders(beta.tenantId, beta.secret),
    });
    const alphaAttempts = alphaHistory.json().attempts as Array<{ requestId: string }>;
    const betaAttempts = betaHistory.json().attempts as Array<{ requestId: string }>;
    const alphaIds = new Set(alphaAttempts.map((item) => item.requestId));
    const betaIds = new Set(betaAttempts.map((item) => item.requestId));
    expect(alphaAttempts.length).toBeGreaterThan(0);
    expect(betaAttempts.length).toBeGreaterThan(0);
    for (const id of betaIds) expect(alphaIds.has(id)).toBe(false);
    expect(JSON.stringify(alphaHistory.json())).not.toContain('rel-beta');
    expect(JSON.stringify(betaHistory.json())).not.toContain('rel-alpha');
    const overlapped = await Promise.all([
      chat(alpha, 'rel-alpha', 'alpha-overlap-denied'),
      chat(beta, 'rel-beta', 'beta-overlap-ok'),
    ]);
    expect(overlapped[0]?.response.statusCode).toBe(429);
    expect(overlapped[1]?.response.statusCode).toBe(200);
    finish('TENANT', 'isolation', {
      alphaKey: alphaHit?.authorization ?? null,
      betaKey: betaHit?.authorization ?? null,
      alphaRemaining: alphaUsage.json().remainingBudget,
      betaRemaining: betaUsage.json().remainingBudget,
      alphaRate: errorCode(limited.response),
      betaStatus: betaAgain.response.statusCode,
      alphaRequests: [...alphaIds],
      betaRequests: [...betaIds],
      foreignStatus: foreign.response.statusCode,
      overlap: overlapped.map((item) => item.response.statusCode),
    });
  });

  it('shares budget, rate, lease, and breaker state across two processes', async () => {
    const now = Date.parse('2026-07-01T00:00:00.000Z');
    const budgetTenant = tenantWith('Rel Atomic Budget', 'rel-atomic', 'rel-atomic');
    price('rel-atomic', { input: '1' });
    cli(['set-tenant-budget', '--tenant-id', budgetTenant.tenantId, '--mode', 'hard', '--monthly-amount', '10']);
    const left = 'a'.repeat(10);
    const right = 'b'.repeat(10);
    scripts.set(left, { type: 'hold' });
    scripts.set(right, { type: 'hold' });
    const budgetPending = [
      runChild('test/limit-child.mjs', childEnv(budgetTenant, 'rel-atomic', left, now)),
      runChild('test/limit-child.mjs', childEnv(budgetTenant, 'rel-atomic', right, now)),
    ];
    let budgetResults: ChildResult[] = [];
    let winner = '';
    try {
      await poll(() => mock.hits.filter((hit) => contentOf(hit.body) === left || contentOf(hit.body) === right).length === 1, 'atomic hold');
      winner = contentOf(mock.hits.find((hit) => contentOf(hit.body) === left || contentOf(hit.body) === right)?.body ?? '');
      await poll(async () => {
        const stored = await rowsSince(budgetTenant.tenantId, new Date(0));
        return stored.some((row) => row.error_code === 'budget_exceeded');
      }, 'atomic denial');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === left || contentOf(hit.body) === right)).toHaveLength(1);
      release(winner);
      budgetResults = await Promise.all(budgetPending);
    } finally {
      release(left);
      release(right);
      await Promise.allSettled(budgetPending);
    }
    expect(budgetResults.map((item) => item.status).sort()).toEqual([200, 429]);
    expect(budgetResults.some((item) => item.code === 'budget_exceeded')).toBe(true);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === left || contentOf(hit.body) === right)).toHaveLength(1);
    finish('INSTANCE', 'atomic-budget', {
      results: budgetResults.map((item) => ({ status: item.status, code: item.code })),
      hits: 1,
      winner,
    });

    const rateTenant = tenantWith('Rel Atomic Rate', 'rel-rate', 'rel-rate');
    cli(['set-tenant-limits', '--tenant-id', rateTenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1']);
    const rateResults = await Promise.all([
      runChild('test/limit-child.mjs', childEnv(rateTenant, 'rel-rate', 'rate-left', now)),
      runChild('test/limit-child.mjs', childEnv(rateTenant, 'rel-rate', 'rate-right', now)),
    ]);
    expect(rateResults.map((item) => item.status).sort()).toEqual([200, 429]);
    expect(rateResults.some((item) => item.code === 'tenant_rate_limited')).toBe(true);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'rate-left' || contentOf(hit.body) === 'rate-right')).toHaveLength(1);
    finish('INSTANCE', 'rate-limit', {
      results: rateResults.map((item) => ({ status: item.status, code: item.code })),
      hits: 1,
    });

    const leaseTenant = tenantWith('Rel Atomic Lease', 'rel-lease', 'rel-lease');
    cli([
      'set-tenant-limits',
      '--tenant-id',
      leaseTenant.tenantId,
      '--mode',
      'hard',
      '--concurrent-requests',
      '1',
      '--lease-ms',
      '120000',
    ]);
    scripts.set('lease-left', { type: 'hold' });
    scripts.set('lease-right', { type: 'hold' });
    const leasePending = [
      runChild('test/limit-child.mjs', childEnv(leaseTenant, 'rel-lease', 'lease-left', now)),
      runChild('test/limit-child.mjs', childEnv(leaseTenant, 'rel-lease', 'lease-right', now)),
    ];
    let leaseResults: ChildResult[] = [];
    try {
      await poll(() => mock.hits.some((hit) => contentOf(hit.body) === 'lease-left' || contentOf(hit.body) === 'lease-right'), 'lease hold');
      await poll(async () => {
        const stored = await rowsSince(leaseTenant.tenantId, new Date(0));
        return stored.some((row) => row.error_code === 'concurrency_limited');
      }, 'lease denial');
      const leaseHits = mock.hits.filter((hit) => contentOf(hit.body) === 'lease-left' || contentOf(hit.body) === 'lease-right');
      expect(leaseHits).toHaveLength(1);
      release(contentOf(leaseHits[0]?.body ?? ''));
      leaseResults = await Promise.all(leasePending);
    } finally {
      release('lease-left');
      release('lease-right');
      await Promise.allSettled(leasePending);
    }
    expect(leaseResults.map((item) => item.status).sort()).toEqual([200, 429]);
    expect(leaseResults.some((item) => item.code === 'concurrency_limited')).toBe(true);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'lease-left' || contentOf(hit.body) === 'lease-right')).toHaveLength(1);
    finish('INSTANCE', 'concurrency-lease', {
      results: leaseResults.map((item) => ({ status: item.status, code: item.code })),
      hits: 1,
    });

    const breakerTenant = tenantWith('Rel Shared Breaker', 'rel-breaker', 'rel-breaker');
    cli([
      'set-deployment-breaker',
      '--tenant-id',
      breakerTenant.tenantId,
      '--deployment',
      'rel-breaker',
      '--enabled',
      'true',
      '--window-ms',
      '60000',
      '--min-samples',
      '2',
      '--failure-threshold',
      '2',
      '--cooldown-ms',
      '60000',
      '--max-probes',
      '1',
    ]);
    const beforeState = await admin.query<{ state: string; state_reason: string }>(
      `SELECT state, state_reason FROM deployment_breakers
       WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'rel-breaker')`,
      [breakerTenant.tenantId],
    );
    scripts.set('breaker-1', { type: 'status', status: 503 });
    scripts.set('breaker-2', { type: 'status', status: 503 });
    const opened = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      now: () => now,
    });
    pools.push(opened.authPool, opened.runtimePool);
    try {
      await chat(breakerTenant, 'rel-breaker', 'breaker-1', {}, opened.app);
      await chat(breakerTenant, 'rel-breaker', 'breaker-2', {}, opened.app);
    } finally {
      await opened.app.close();
    }
    const afterState = await admin.query<{ state: string; state_reason: string }>(
      `SELECT state, state_reason FROM deployment_breakers
       WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'rel-breaker')`,
      [breakerTenant.tenantId],
    );
    expect(beforeState.rows[0]?.state).toBe('closed');
    expect(afterState.rows[0]?.state).toBe('open');
    const hitsBefore = mock.hits.length;
    const blocked = await Promise.all([
      runChild('test/breaker-child.mjs', {
        ...childEnv(breakerTenant, 'rel-breaker', 'breaker-blocked-a', now),
        BREAKER_NOW_MS: String(now),
      }),
      runChild('test/breaker-child.mjs', {
        ...childEnv(breakerTenant, 'rel-breaker', 'breaker-blocked-b', now),
        BREAKER_NOW_MS: String(now),
      }),
    ]);
    expect(blocked.every((item) => item.status === 503 && item.code === 'circuit_open')).toBe(true);
    expect(mock.hits.length).toBe(hitsBefore);
    finish('INSTANCE', 'breaker', {
      before: beforeState.rows[0] ?? null,
      after: afterState.rows[0] ?? null,
      transitions: beforeState.rows[0]?.state === 'closed' && afterState.rows[0]?.state === 'open' ? 1 : 0,
      blocked: blocked.map((item) => ({ status: item.status, code: item.code })),
      extraHits: mock.hits.length - hitsBefore,
    });
  });

  it('settles a crashed attempt once and lets a later request proceed', async () => {
    const now = Date.now();
    const crashed = tenantWith('Rel Crash Settle', 'rel-crash-settle');
    price('rel-crash-settle', { input: '0.01' });
    cli(['set-tenant-budget', '--tenant-id', crashed.tenantId, '--mode', 'hard', '--monthly-amount', '5']);
    const late = await runChild('test/limit-child.mjs', {
      ...childEnv(crashed, 'rel-chat', 'crash-settle', now),
      CRASH_AT: 'before_settle',
    });
    expect(late.exit, late.stderr).toBe(86);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'crash-settle')).toHaveLength(1);
    const unfinished = await rowsSince(crashed.tenantId, new Date(0));
    expect(unfinished[0]?.status).toBe('succeeded');
    expect(unfinished[0]?.reservation_status).toBe('active');
    const backlogBefore = (await ledger(crashed.tenantId)).active;
    expect(recover(crashed.tenantId)).toBe(1);
    const once = await ledger(crashed.tenantId);
    expect(once.settles).toBe('1');
    expect(once.recognized).toBe('0.03');
    expect(recover(crashed.tenantId)).toBe(0);
    const twice = await ledger(crashed.tenantId);
    expect(twice.settles).toBe('1');
    expect(twice.recognized).toBe(once.recognized);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'crash-settle')).toHaveLength(1);
    const later = await runChild('test/limit-child.mjs', childEnv(crashed, 'rel-chat', 'after-crash', now));
    expect(later.status).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'crash-settle')).toHaveLength(1);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'after-crash')).toHaveLength(1);
    const after = await ledger(crashed.tenantId);
    expect(after.settles).toBe('2');
    finish('INSTANCE', 'crash-settlement', {
      exit: late.exit,
      backlogBefore,
      backlogAfter: twice.active,
      recognized: twice.recognized,
      settlesAfterRecover: twice.settles,
      settlesAfterLater: after.settles,
      crashHits: 1,
      laterStatus: later.status,
    });

    const expired = tenantWith('Rel Crash Lease', 'rel-crash-lease');
    const origin = Date.parse('2026-07-02T00:00:00.000Z');
    cli([
      'set-tenant-limits',
      '--tenant-id',
      expired.tenantId,
      '--mode',
      'hard',
      '--concurrent-requests',
      '1',
      '--lease-ms',
      '200',
    ]);
    const early = await runChild('test/limit-child.mjs', {
      ...childEnv(expired, 'rel-chat', 'crash-lease', origin),
      CRASH_AT: 'after_admit',
    });
    expect(early.exit, early.stderr).toBe(86);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'crash-lease')).toHaveLength(0);
    expect(recover(expired.tenantId)).toBe(0);
    const resumed = await runChild(
      'test/limit-child.mjs',
      childEnv(expired, 'rel-chat', 'lease-resumed', origin + 1_000),
    );
    expect(resumed.status, resumed.stderr).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'lease-resumed')).toHaveLength(1);
    finish('INSTANCE', 'crash-lease', {
      earlyExit: early.exit,
      earlyHits: 0,
      laterStatus: resumed.status,
      laterHits: 1,
    });
  });

  it('measures the captured workload', async () => {
    const tenant = tenantWith('Rel Measure', 'rel-measure', 'rel-measure');
    price('rel-measure', { input: '0.01', output: '0.02' });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'rel-measure' });
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'observe', '--monthly-amount', '100']);
    const memoryBefore = process.memoryUsage();
    const durations: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const content = `measure-${index}`;
      const call = await chat(tenant, 'rel-measure', content);
      expect(call.response.statusCode).toBe(200);
      durations.push(call.elapsedMs);
    }
    scripts.set('measure-slow', { type: 'slow', ms: 100 });
    const slow = await chat(tenant, 'rel-measure', 'measure-slow');
    const slowDelay = delays.get('measure-slow') ?? null;
    expect(slow.response.statusCode).toBe(200);
    scripts.set('measure-fail', { type: 'status', status: 500 });
    const failed = await chat(tenant, 'rel-measure', 'measure-fail');
    expect(failed.response.statusCode).toBe(502);
    const contentionStarted = Date.now();
    const overlapped = await Promise.all(
      ['c0', 'c1', 'c2', 'c3'].map((content) => chat(tenant, 'rel-measure', `measure-${content}`)),
    );
    const contentionMs = Date.now() - contentionStarted;
    expect(overlapped.every((item) => item.response.statusCode === 200)).toBe(true);
    for (const item of overlapped) durations.push(item.elapsedMs);
    scripts.set('measure-stream', { type: 'sse' });
    const streamDurations: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const started = Date.now();
      const call = await chat(tenant, 'rel-measure', 'measure-stream', { stream: true });
      streamDurations.push(Date.now() - started);
      expect(call.response.statusCode).toBe(200);
      expect(call.response.body).toContain('data: [DONE]');
    }
    const sorted = [...durations].sort((left, right) => left - right);
    const streamSorted = [...streamDurations].sort((left, right) => left - right);
    const from = new Date(Date.now() - 180_000).toISOString();
    const to = new Date(Date.now() + 180_000).toISOString();
    const summary = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: authHeaders(tenant.tenantId, tenant.secret),
    });
    expect(summary.statusCode).toBe(200);
    const stored = await rowsSince(tenant.tenantId, new Date(0));
    const requests = new Set(stored.map((row) => row.request_id));
    const succeeded = stored.filter((row) => row.request_status === 'succeeded');
    const successIds = new Set(succeeded.map((row) => row.request_id));
    const upstreamAttempts = stored.filter((row) => row.dispatched).length;
    const fallbacks = stored.filter((row) => row.attempt_ordinal > 1).length;
    const providerFailures = stored.filter((row) => row.failure_class !== null).length;
    const memoryAfter = process.memoryUsage();
    const openStreams = ctx.app.streamGate.active();
    finish('MEASURE', 'workload', {
      requests: requests.size,
      succeeded: successIds.size,
      successRate: requests.size === 0 ? null : successIds.size / requests.size,
      upstreamAttempts,
      retryAmplification: requests.size === 0 ? null : stored.length / requests.size,
      fallbacks,
      fallbackRate: requests.size === 0 ? null : fallbacks / requests.size,
      providerFailures,
      providerFailureRate: stored.length === 0 ? null : providerFailures / stored.length,
      budgetDenials: stored.filter((row) => row.error_code === 'budget_exceeded' || row.error_code === 'budget_unknown').length,
      rateDenials: stored.filter((row) => row.error_code === 'tenant_rate_limited').length,
      reservationBacklog: stored.filter((row) => row.reservation_status === 'active').length,
      capturedDurationsMs: sorted,
      capturedP50Ms: disc(sorted, 0.5),
      capturedP95Ms: disc(sorted, 0.95),
      capturedP99Ms: disc(sorted, 0.99),
      streamDurationsMs: streamSorted,
      streamP50Ms: disc(streamSorted, 0.5),
      streamP95Ms: disc(streamSorted, 0.95),
      streamP99Ms: disc(streamSorted, 0.99),
      routeLatency: summary.json().latency,
      routeStreamDuration: summary.json().streaming.durationMs,
      slowElapsedMs: slow.elapsedMs,
      mockDelayMs: slowDelay,
      overheadMs: slowDelay === null ? null : slow.elapsedMs - slowDelay,
      contentionMs,
      contentionResults: overlapped.map((item) => ({ status: item.response.statusCode, elapsedMs: item.elapsedMs })),
      concurrentStreams: openStreams,
      memoryRssBefore: memoryBefore.rss,
      memoryRssAfter: memoryAfter.rss,
      memoryHeapBefore: memoryBefore.heapUsed,
      memoryHeapAfter: memoryAfter.heapUsed,
    });
  });

  it('turns retry and fallback off for one tenant and records an interrupted stream', async () => {
    const primary = tenantWith('Rel Disable Primary', 'rel-disable-primary');
    const other = tenantWith('Rel Disable Other', 'rel-disable-other');
    addDeployment(primary.tenantId, 'rel-disable-secondary', 'rel-disable-secondary');
    addDeployment(other.tenantId, 'rel-other-secondary', 'rel-other-secondary');
    await ready(primary.tenantId, 'rel-disable-secondary');
    await ready(other.tenantId, 'rel-other-secondary');
    execution(primary.tenantId, 'rel-chat', { retries: true });
    execution(other.tenantId, 'rel-chat', { retries: true });
    fallback(primary.tenantId, ['rel-disable-secondary'], { failures: ['unavailable'] });
    fallback(other.tenantId, ['rel-other-secondary'], { failures: ['unavailable'] });
    scripts.set('retry-on', { type: 'status', status: 429, thenOk: true });
    const enabled = await chat(primary, 'auto', 'retry-on');
    expect(enabled.response.statusCode).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'retry-on')).toHaveLength(2);
    execution(primary.tenantId, 'rel-chat', { retries: false });
    scripts.set('retry-off', { type: 'status', status: 429 });
    const disabledRetry = await chat(primary, 'auto', 'retry-off');
    expect(disabledRetry.response.statusCode).toBe(429);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'retry-off')).toHaveLength(1);
    scripts.set('other-retry', { type: 'status', status: 429, thenOk: true });
    const otherRetry = await chat(other, 'auto', 'other-retry');
    expect(otherRetry.response.statusCode).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'other-retry')).toHaveLength(2);

    scripts.set('named-stay', { type: 'status', status: 503 });
    const named = await chat(primary, 'rel-chat', 'named-stay');
    const namedHits = mock.hits.filter((hit) => contentOf(hit.body) === 'named-stay');
    expect(namedHits.map((hit) => modelOf(hit.body))).toEqual(['rel-disable-primary']);
    expect(named.response.headers['x-fallback']).toBe('false');
    scripts.set('rel-disable-primary\u0000fallback-on', { type: 'status', status: 503 });
    const fell = await chat(primary, 'auto', 'fallback-on');
    expect(fell.response.statusCode).toBe(200);
    expect(fell.response.json().choices[0].message.content).toBe('from-rel-disable-secondary');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'fallback-on').map((hit) => modelOf(hit.body))).toEqual([
      'rel-disable-primary',
      'rel-disable-secondary',
    ]);
    fallback(primary.tenantId, ['rel-disable-secondary'], { enabled: false, failures: ['unavailable'] });
    scripts.set('fallback-off-body', { type: 'status', status: 503 });
    const fellOff = await chat(primary, 'auto', 'fallback-off-body');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'fallback-off-body').map((hit) => modelOf(hit.body))).toEqual([
      'rel-disable-primary',
    ]);
    scripts.set('rel-disable-other\u0000other-fallback', { type: 'status', status: 503 });
    const otherFell = await chat(other, 'auto', 'other-fallback');
    expect(otherFell.response.statusCode).toBe(200);
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'other-fallback').map((hit) => modelOf(hit.body))).toEqual([
      'rel-disable-other',
      'rel-other-secondary',
    ]);

    const flag = await createTestApp(db, {
      inferenceEnabled: false,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    pools.push(flag.authPool, flag.runtimePool);
    try {
      const hidden = await chat(primary, 'auto', 'flag-off', {}, flag.app);
      expect(hidden.response.statusCode).toBe(503);
      expect(errorCode(hidden.response)).toBe('inference_disabled');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'flag-off')).toHaveLength(0);
    } finally {
      await flag.app.close();
    }

    const streamTenant = tenantWith('Rel Stream Flag', 'rel-stream-flag', 'rel-stream-flag');
    const quietTenant = tenantWith('Rel Stream Quiet', 'rel-stream-quiet', 'rel-stream-quiet');
    enableStreaming(db, { tenantId: streamTenant.tenantId, deployment: 'rel-stream-flag' });
    scripts.set('stream-on', { type: 'sse' });
    const streamed = await chat(streamTenant, 'rel-stream-flag', 'stream-on', { stream: true });
    expect(streamed.response.statusCode).toBe(200);
    const quiet = await chat(quietTenant, 'rel-stream-quiet', 'stream-off', { stream: true });
    expect(quiet.response.statusCode).toBe(400);
    expect(errorCode(quiet.response)).toBe('unsupported_parameter');
    expect(mock.hits.filter((hit) => contentOf(hit.body) === 'stream-off')).toHaveLength(0);

    finish('DEPLOY', 'disablement', {
      retryEnabledHits: 2,
      retryDisabledHits: 1,
      otherRetryHits: 2,
      namedModels: namedHits.map((hit) => modelOf(hit.body)),
      fallbackEnabledModels: ['rel-disable-primary', 'rel-disable-secondary'],
      fallbackDisabledModels: ['rel-disable-primary'],
      otherFallbackModels: ['rel-disable-other', 'rel-other-secondary'],
      inferenceDisabled: 'inference_disabled',
      streamEnabledStatus: streamed.response.statusCode,
      streamDisabledStatus: quiet.response.statusCode,
      namedFallback: named.response.headers['x-fallback'],
      fellStatus: fell.response.statusCode,
      fellOffStatus: fellOff.response.statusCode,
      otherFellStatus: otherFell.response.statusCode,
    });
  });

  it('records an interrupted stream when shutdown writes the row', async () => {
    const tenant = tenantWith('Rel Shutdown', 'rel-shutdown', 'rel-shutdown');
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'rel-shutdown' });
    const localMock = await startMockUpstream((hit, request, response) => {
      if (contentOf(hit.body) !== 'shutdown-hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseBody('rel-shutdown', 'done'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(PARTIAL);
      const timer = setTimeout(() => {
        if (!response.writableEnded) response.end(sseBody('rel-shutdown', 'late'));
      }, 20_000);
      request.on('aborted', () => clearTimeout(timer));
      request.socket.on('close', () => clearTimeout(timer));
    });
    const local = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: localMock.baseUrl,
      credentialKey,
    });
    pools.push(local.authPool, local.runtimePool);
    const port = await freePort();
    await local.app.listen({ host: '127.0.0.1', port });
    const started = await mark();
    const payload = chatPayload('rel-shutdown', 'shutdown-hold', { stream: true });
    const settled = new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            ...authHeaders(tenant.tenantId, tenant.secret),
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res: IncomingMessage) => {
          res.on('data', () => undefined);
          res.on('end', () => resolve());
          res.on('close', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.write(payload);
      req.end();
    });
    try {
      await poll(async () => {
        const found = await admin.query(
          `SELECT 1 FROM model_attempts WHERE tenant_id = $1 AND stream_status = 'streaming' AND created_at >= $2`,
          [tenant.tenantId, started],
        );
        return (found.rowCount ?? 0) > 0;
      }, 'shutdown stream');
      const active = local.app.streamGate.active();
      const drained = await local.app.drainStreams(1_500);
      await settled;
      const stored = await rowsSince(tenant.tenantId, started);
      expect(stored.some((row) => row.stream_status === 'interrupted')).toBe(true);
      const hits = localMock.hits.length;
      const rejected = await local.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('rel-shutdown', 'after-shutdown', { stream: true }),
      });
      expect(rejected.statusCode).toBe(503);
      expect(errorCode(rejected)).toBe('shutting_down');
      expect(localMock.hits.length).toBe(hits);
      finish('DEPLOY', 'shutdown', {
        activeBefore: active,
        activeAfter: drained.activeAfter,
        interrupted: stored.filter((row) => row.stream_status === 'interrupted').length,
        streamStatuses: stored.map((row) => row.stream_status),
        rejected: errorCode(rejected),
      });
    } finally {
      await local.app.close();
      await localMock.close();
    }
  });
});
