import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTestApp, loadTestDatabase, runCli } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

type Mode =
  | { type: 'ok' }
  | { type: 'status'; status: number; retryAfter?: string }
  | { type: 'then-ok'; status: number; retryAfter?: string }
  | { type: 'hang' }
  | { type: 'partial' };

type AttemptRow = {
  attempt_ordinal: number;
  status: string;
  failure_class: string | null;
  dispatched: boolean;
  expense_certainty: string | null;
  duration_ms: number | null;
  error_code: string | null;
  amount: string | null;
  cost_status: string | null;
  cost_certainty: string | null;
  request_status: string;
  request_id: string;
};

const PARTIAL = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n`;

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

async function closedBaseUrl(): Promise<string> {
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
  return `http://127.0.0.1:${port}/v1`;
}

describe('controlled retries', () => {
  const db = loadTestDatabase();
  const pools: Array<{ end: () => Promise<unknown> }> = [];
  const seen = new Map<string, number>();
  const times: number[] = [];
  let mode: Mode = { type: 'ok' };
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: pg.Pool;
  let plain: ReturnType<typeof provisionTenant>;
  let opted: ReturnType<typeof provisionTenant>;

  beforeAll(async () => {
    mock = await startMockUpstream((hit, _request, response) => {
      times.push(Date.now());
      const parsed = JSON.parse(hit.body) as { model?: string; messages?: Array<{ content?: string }> };
      const content = parsed.messages?.[0]?.content ?? '';
      const count = (seen.get(content) ?? 0) + 1;
      seen.set(content, count);
      if (mode.type === 'hang') return;
      if (mode.type === 'partial') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(PARTIAL);
        return;
      }
      const fail = mode.type === 'status' || (mode.type === 'then-ok' && count === 1);
      if (fail && mode.type !== 'ok') {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (mode.retryAfter !== undefined) headers['retry-after'] = mode.retryAfter;
        response.writeHead(mode.status, headers);
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? 'gpt-test', 'ok')));
    });
    plain = provisionTenant(db, 'Retry Plain');
    opted = provisionTenant(db, 'Retry Opted');
    registerInference(db, {
      tenantId: plain.tenantId,
      apiKey: 'sk-test-retry-plain',
      deployment: 'plain-chat',
      upstreamModel: 'gpt-test',
    });
    registerInference(db, {
      tenantId: opted.tenantId,
      apiKey: 'sk-test-retry-opted',
      deployment: 'opted-chat',
      upstreamModel: 'gpt-test',
    });
    enableStreaming(db, { tenantId: opted.tenantId, deployment: 'opted-chat' });
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    admin = adminPool(db);
    pools.push(ctx.authPool, ctx.runtimePool, admin);
  });

  beforeEach(() => {
    mode = { type: 'ok' };
    seen.clear();
    times.length = 0;
    mock.hits.length = 0;
  });

  afterAll(async () => {
    await mock.close();
    await ctx.app.close();
    await Promise.all(pools.map((pool) => pool.end()));
  });

  function setPolicy(
    input: {
      retries: boolean;
      connection?: number;
      attempt?: number;
      total?: number;
      initial?: number;
      max?: number;
    },
  ): void {
    const result = runCli(
      db,
      [
        'set-execution-policy',
        '--tenant-id',
        opted.tenantId,
        '--deployment',
        'opted-chat',
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
      ],
      cliEnv(),
    ) as { policyId?: string; retriesEnabled?: boolean };
    expect(result.policyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.retriesEnabled).toBe(input.retries);
  }

  async function chat(
    tenant: { tenantId: string; secret: string },
    content: string,
    extra: Record<string, unknown> = {},
  ) {
    const started = Date.now();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: chatPayload('auto', content, extra),
    });
    return { response, elapsedMs: Date.now() - started };
  }

  async function rowsSince(tenantId: string, since: Date): Promise<AttemptRow[]> {
    const result = await admin.query<AttemptRow>(
      `SELECT a.attempt_ordinal, a.status, a.failure_class, a.dispatched, a.expense_certainty,
              a.duration_ms, a.error_code, a.request_id,
              ac.amount::text AS amount, ac.cost_status, ac.expense_certainty AS cost_certainty,
              r.status AS request_status
       FROM model_attempts a
       JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
       LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
       WHERE a.tenant_id = $1 AND a.created_at >= $2
       ORDER BY a.created_at, a.attempt_ordinal`,
      [tenantId, since],
    );
    return result.rows;
  }

  function report(name: string, status: number, hits: MockHit[], stored: AttemptRow[], elapsedMs: number): void {
    console.log(
      `RETRY_CASE ${JSON.stringify({
        case: name,
        status,
        hits: hits.length,
        elapsedMs,
        attempts: stored.map((row) => ({
          ordinal: row.attempt_ordinal,
          status: row.status,
          failureClass: row.failure_class,
          durationMs: row.duration_ms,
          expense: row.expense_certainty,
          costStatus: row.cost_status,
          amount: row.amount,
          dispatched: row.dispatched,
          requestStatus: row.request_status,
        })),
      })}`,
    );
  }

  it('sends one attempt when retry is off', async () => {
    mode = { type: 'status', status: 429 };
    const since = new Date();
    const { response, elapsedMs } = await chat(plain, 'plain-429');
    const stored = await rowsSince(plain.tenantId, since);
    report('retry-off', response.statusCode, mock.hits, stored, elapsedMs);
    expect(response.statusCode).toBe(429);
    expect(mock.hits).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ attempt_ordinal: 1, failure_class: 'rate_limit', status: 'failed' });
  });

  it('retries a rate limit once for model=auto and then succeeds', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'then-ok', status: 429 };
    const since = new Date();
    const { response, elapsedMs } = await chat(opted, 'auto-429-ok');
    const stored = await rowsSince(opted.tenantId, since);
    report('429-then-ok', response.statusCode, mock.hits, stored, elapsedMs);
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('ok');
    expect(mock.hits).toHaveLength(2);
    expect(stored.map((row) => row.attempt_ordinal)).toEqual([1, 2]);
    expect(stored[0]?.failure_class).toBe('rate_limit');
    expect(stored[1]).toMatchObject({ status: 'succeeded', failure_class: null });
    expect(stored[0]?.amount).not.toBe('0');
    expect(stored[1]?.amount).not.toBe('0');
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/attempts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: authHeaders(opted.tenantId, opted.secret),
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      attempts: Array<{ ordinal: number; failureClass: string | null; durationMs: number | null; costAmount: string | null }>;
    };
    const match = body.attempts.filter((item) => item.failureClass === 'rate_limit' || item.ordinal === 2);
    expect(match.length).toBeGreaterThanOrEqual(2);
    for (const item of body.attempts) {
      expect(item.costAmount === null || typeof item.costAmount === 'string').toBe(true);
      expect(item.costAmount).not.toBe('0');
      if (item.durationMs !== null) expect(item.durationMs).toBeGreaterThanOrEqual(0);
    }
    console.log(
      `RETRY_HISTORY ${JSON.stringify({
        listed: body.attempts.length,
        sample: stored.map((row) => ({
          ordinal: row.attempt_ordinal,
          failureClass: row.failure_class,
          durationMs: row.duration_ms,
          amount: row.amount,
        })),
      })}`,
    );
  });

  it('stops at two attempts when the rate limit continues', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'status', status: 429 };
    const since = new Date();
    const { response, elapsedMs } = await chat(opted, 'always-429');
    const stored = await rowsSince(opted.tenantId, since);
    report('429-cap', response.statusCode, mock.hits, stored, elapsedMs);
    expect(response.statusCode).toBe(429);
    expect(mock.hits).toHaveLength(2);
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.failure_class === 'rate_limit')).toBe(true);
  });

  it('retries HTTP 503 and keeps the public status', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'status', status: 503 };
    const since = new Date();
    const { response, elapsedMs } = await chat(opted, 'always-503');
    const stored = await rowsSince(opted.tenantId, since);
    report('503', response.statusCode, mock.hits, stored, elapsedMs);
    expect(response.statusCode).toBe(502);
    expect(mock.hits).toHaveLength(2);
    expect(stored.every((row) => row.failure_class === 'unavailable')).toBe(true);
  });

  it('waits for a valid Retry-After and ignores an invalid one', async () => {
    setPolicy({ retries: true, total: 10_000, initial: 0, max: 0 });
    mode = { type: 'then-ok', status: 429, retryAfter: '1' };
    const since = new Date();
    const first = await chat(opted, 'retry-after-1');
    const stored = await rowsSince(opted.tenantId, since);
    const gap = (times[1] ?? 0) - (times[0] ?? 0);
    report('retry-after-valid', first.response.statusCode, mock.hits, stored, first.elapsedMs);
    expect(first.response.statusCode).toBe(200);
    expect(mock.hits).toHaveLength(2);
    expect(gap).toBeGreaterThanOrEqual(800);
    expect(gap).toBeLessThan(2_500);
    console.log(`RETRY_ELAPSED ${JSON.stringify({ case: 'retry-after-valid', gapMs: gap })}`);

    setPolicy({ retries: true, initial: 40, max: 40 });
    mode = { type: 'then-ok', status: 429, retryAfter: 'soon' };
    times.length = 0;
    mock.hits.length = 0;
    seen.clear();
    const secondSince = new Date();
    const second = await chat(opted, 'retry-after-soon');
    const secondRows = await rowsSince(opted.tenantId, secondSince);
    const small = (times[1] ?? 0) - (times[0] ?? 0);
    report('retry-after-invalid', second.response.statusCode, mock.hits, secondRows, second.elapsedMs);
    expect(second.response.statusCode).toBe(200);
    expect(mock.hits).toHaveLength(2);
    expect(small).toBeLessThan(700);
    console.log(`RETRY_ELAPSED ${JSON.stringify({ case: 'retry-after-invalid', gapMs: small })}`);
  });

  it('does not retry when a valid Retry-After exceeds the deadline', async () => {
    setPolicy({ retries: true, connection: 5_000, attempt: 5_000, total: 2_000, initial: 0, max: 0 });
    mode = { type: 'then-ok', status: 429, retryAfter: '10' };
    const since = new Date();
    const { response, elapsedMs } = await chat(opted, 'retry-after-too-long');
    const stored = await rowsSince(opted.tenantId, since);
    report('retry-after-exceeds', response.statusCode, mock.hits, stored, elapsedMs);
    expect(response.statusCode).toBe(429);
    expect(mock.hits).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.failure_class).toBe('rate_limit');
  });

  it('does not retry HTTP 400 or HTTP 401', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'status', status: 400 };
    const since = new Date();
    const denied = await chat(opted, 'http-400');
    const deniedRows = await rowsSince(opted.tenantId, since);
    report('http-400', denied.response.statusCode, mock.hits, deniedRows, denied.elapsedMs);
    expect(denied.response.statusCode).toBe(502);
    expect(mock.hits).toHaveLength(1);
    expect(deniedRows[0]?.failure_class).toBe('client_error');

    mode = { type: 'status', status: 401 };
    times.length = 0;
    mock.hits.length = 0;
    // The database clock can lead the host clock. A host timestamp can include the prior row.
    const marked = await admin.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
    const authSince = marked.rows[0]?.now ?? new Date();
    const unauthorized = await chat(opted, 'http-401');
    const authRows = await rowsSince(opted.tenantId, authSince);
    report('http-401', unauthorized.response.statusCode, mock.hits, authRows, unauthorized.elapsedMs);
    expect(unauthorized.response.statusCode).toBe(502);
    expect(mock.hits).toHaveLength(1);
    expect(authRows[0]?.failure_class).toBe('unauthorized');
  });

  it('retries a connection failure before dispatch and records no expense', async () => {
    const baseUrl = await closedBaseUrl();
    const closed = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: baseUrl,
      credentialKey,
    });
    pools.push(closed.authPool, closed.runtimePool);
    try {
      setPolicy({ retries: true, initial: 0, max: 0 });
      const since = new Date();
      const started = Date.now();
      const response = await closed.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(opted.tenantId, opted.secret),
        payload: chatPayload('auto', 'connection-on'),
      });
      const stored = await rowsSince(opted.tenantId, since);
      report('connection-on', response.statusCode, [], stored, Date.now() - started);
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.failure_class === 'connection_failure')).toBe(true);
      expect(stored.every((row) => row.expense_certainty === 'none')).toBe(true);
      expect(stored.every((row) => row.amount === null)).toBe(true);
      expect(stored.some((row) => row.amount === '0')).toBe(false);

      const offSince = new Date();
      const plainResponse = await closed.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(plain.tenantId, plain.secret),
        payload: chatPayload('auto', 'connection-off'),
      });
      const plainRows = await rowsSince(plain.tenantId, offSince);
      report('connection-off', plainResponse.statusCode, [], plainRows, 0);
      expect(plainRows).toHaveLength(1);
      expect(plainRows[0]?.failure_class).toBe('connection_failure');
    } finally {
      await closed.app.close();
    }
  });

  it('stops on a timeout before dispatch, after dispatch, and on the total deadline', async () => {
    mode = { type: 'hang' };
    setPolicy({ retries: true, connection: 200, attempt: 5_000, total: 5_000, initial: 0, max: 0 });
    const beforeSince = new Date();
    const before = await chat(opted, 'timeout-before');
    const beforeRows = await rowsSince(opted.tenantId, beforeSince);
    report('timeout-before', before.response.statusCode, mock.hits, beforeRows, before.elapsedMs);
    expect(before.response.statusCode).toBe(504);
    expect(mock.hits).toHaveLength(1);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]?.failure_class).toBe('timeout_before_dispatch');
    expect(beforeRows[0]?.expense_certainty).toBe('none');
    expect(beforeRows[0]?.amount).toBeNull();

    mock.hits.length = 0;
    setPolicy({ retries: true, connection: 5_000, attempt: 200, total: 5_000, initial: 0, max: 0 });
    const afterSince = new Date();
    const after = await chat(opted, 'timeout-after');
    const afterRows = await rowsSince(opted.tenantId, afterSince);
    report('timeout-after', after.response.statusCode, mock.hits, afterRows, after.elapsedMs);
    expect(after.response.statusCode).toBe(504);
    expect(mock.hits).toHaveLength(1);
    expect(afterRows[0]?.failure_class).toBe('timeout_after_dispatch');
    expect(afterRows[0]?.expense_certainty).toBe('uncertain');
    expect(afterRows[0]?.cost_certainty).toBe('uncertain');
    expect(afterRows[0]?.amount).toBeNull();
    expect(afterRows[0]?.cost_status).toBe('unknown');

    mock.hits.length = 0;
    setPolicy({ retries: true, connection: 5_000, attempt: 5_000, total: 200, initial: 0, max: 0 });
    const totalSince = new Date();
    const total = await chat(opted, 'timeout-total');
    const totalRows = await rowsSince(opted.tenantId, totalSince);
    report('total-deadline', total.response.statusCode, mock.hits, totalRows, total.elapsedMs);
    expect(total.response.statusCode).toBe(504);
    expect(mock.hits).toHaveLength(1);
    expect(totalRows).toHaveLength(1);
    expect(totalRows[0]?.failure_class).toBe('total_deadline');
  });

  it('does not start another attempt when the caller cancels during backoff', async () => {
    setPolicy({ retries: true, initial: 800, max: 800, total: 10_000 });
    mode = { type: 'status', status: 429 };
    const live = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    pools.push(live.authPool, live.runtimePool);
    try {
    await live.app.listen({ host: '127.0.0.1', port: 0 });
    const address = live.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('listen port is missing');
    const since = new Date();
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(opted.tenantId, opted.secret),
      body: chatPayload('auto', 'cancel-backoff'),
      signal: controller.signal,
    });
    const waitStarted = Date.now();
    while (mock.hits.length < 1 && Date.now() - waitStarted < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await expect(pending).rejects.toThrow();
    const started = Date.now();
    let stored: AttemptRow[] = [];
    while (Date.now() - started < 5_000) {
      stored = await rowsSince(opted.tenantId, since);
      if (stored.length > 0 && stored[0]?.request_status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    report('cancel-backoff', 408, mock.hits, stored, Date.now() - since.getTime());
    expect(mock.hits).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.failure_class).toBe('rate_limit');
    expect(stored[0]?.request_status).toBe('failed');
    expect(stored[0]?.attempt_ordinal).toBe(1);
    } finally {
      await live.app.close();
    }
  });

  it('does not retry a stream after output has started', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'partial' };
    const since = new Date();
    const { response, elapsedMs } = await chat(opted, 'stream-partial', { stream: true });
    const stored = await rowsSince(opted.tenantId, since);
    report('stream-partial', response.statusCode, mock.hits, stored, elapsedMs);
    expect(mock.hits).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.failure_class).toBe('stream_started');
    expect(stored[0]?.amount).not.toBe('0');
  });

  it('keeps concurrent retries on separate attempts', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'then-ok', status: 429 };
    const since = new Date();
    const responses = await Promise.all([chat(opted, 'concurrent-a'), chat(opted, 'concurrent-b')]);
    const stored = await rowsSince(opted.tenantId, since);
    report('concurrent', responses[0]?.response.statusCode ?? 0, mock.hits, stored, responses[0]?.elapsedMs ?? 0);
    expect(responses.every((item) => item.response.statusCode === 200)).toBe(true);
    expect(mock.hits).toHaveLength(4);
    const groups = new Map<string, number[]>();
    for (const row of stored) {
      const ordinals = groups.get(row.request_id) ?? [];
      ordinals.push(row.attempt_ordinal);
      groups.set(row.request_id, ordinals);
    }
    expect(groups.size).toBe(2);
    for (const ordinals of groups.values()) expect(ordinals).toEqual([1, 2]);
  });

  it('stops further attempts when retry is turned off', async () => {
    setPolicy({ retries: true, initial: 0, max: 0 });
    mode = { type: 'then-ok', status: 429 };
    const before = await chat(opted, 'rollback-on');
    expect(before.response.statusCode).toBe(200);
    expect(mock.hits).toHaveLength(2);
    setPolicy({ retries: false, initial: 0, max: 0 });
    mode = { type: 'status', status: 429 };
    mock.hits.length = 0;
    seen.clear();
    const since = new Date();
    const after = await chat(opted, 'rollback-off');
    const stored = await rowsSince(opted.tenantId, since);
    report('rollback-off', after.response.statusCode, mock.hits, stored, after.elapsedMs);
    expect(after.response.statusCode).toBe(429);
    expect(mock.hits).toHaveLength(1);
    expect(stored).toHaveLength(1);
    console.log(
      `RETRY_ROLLBACK ${JSON.stringify({
        enabledHits: 2,
        disabledHits: mock.hits.length,
        disabledAttempts: stored.length,
        failureClass: stored[0]?.failure_class ?? null,
      })}`,
    );
  });
});
