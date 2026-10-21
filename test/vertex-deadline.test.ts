import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthClient } from 'google-auth-library';
import { GoogleGenAI } from '@google/genai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { describeVertexClientOptions, vertexGenerateClient } from '../src/inference/vertex-client.js';
import { createTestApp, loadTestDatabase, runCli } from './helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKey, provisionTenant } from './inference-support.js';

const PROJECT = 'deadline-vertex-proj';

type Reply = {
  status: number;
  retryAfter?: string;
  headerDelayMs: number;
  bodyDelayMs: number;
  body: unknown;
};

type Hit = {
  at: number;
  path: string;
  headerAt: number | null;
  bodyAt: number | null;
  status: number | null;
};

type AttemptRow = {
  attempt_ordinal: number;
  status: string;
  failure_class: string | null;
  dispatched: boolean;
  expense_certainty: string | null;
  duration_ms: number | null;
  amount: string | null;
  request_status: string;
};

class HeaderAuth extends AuthClient {
  override async getRequestHeaders(): Promise<Headers> {
    return new Headers({ Authorization: 'Bearer test-token' });
  }

  override async getAccessToken(): Promise<{ token?: string | null }> {
    return { token: 'test-token' };
  }

  override async request(): Promise<never> {
    throw new Error('request was not used');
  }
}

function okBody(): Record<string, unknown> {
  return {
    responseId: 'vertex-deadline-ok',
    modelVersion: 'gemini-deadline-served',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'vertex-ok' }] } }],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
  };
}

function errorBody(status: number): Record<string, unknown> {
  return { error: { message: 'upstream rejected the call', code: status, status: 'UNAVAILABLE' } };
}

function waitWhileOpen(ms: number, req: IncomingMessage): Promise<boolean> {
  if (req.socket.destroyed) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.socket.off('close', onClose);
      resolve(!req.socket.destroyed);
    }, ms);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    req.socket.once('close', onClose);
  });
}

async function consume(req: IncomingMessage): Promise<void> {
  req.resume();
  if (req.readableEnded || req.socket.destroyed) return;
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    req.once('end', done);
    req.once('error', done);
    req.socket.once('close', done);
  });
}

describe('vertex deadlines on the shipped client', () => {
  const db = loadTestDatabase();
  const hits: Hit[] = [];
  const other: string[] = [];
  let queue: Reply[] = [];
  let port = 0;
  let tenant = { tenantId: '', secret: '' };
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: pg.Pool;
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '';
    if (!path.includes(':generateContent')) {
      other.push(path);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not-generate"}');
      return;
    }
    const hit: Hit = { at: Date.now(), path, headerAt: null, bodyAt: null, status: null };
    hits.push(hit);
    const reply = queue.shift();
    try {
      await consume(req);
      if (reply === undefined) {
        if (req.socket.destroyed) return;
        hit.status = 599;
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end('{"error":"no reply queued"}');
        return;
      }
      const headersOpen = await waitWhileOpen(reply.headerDelayMs, req);
      if (!headersOpen || req.socket.destroyed || res.writableEnded) return;
      const headers: Record<string, string | number> = { 'content-type': 'application/json', connection: 'close' };
      if (reply.retryAfter !== undefined) headers['retry-after'] = reply.retryAfter;
      res.writeHead(reply.status, headers);
      res.flushHeaders();
      hit.headerAt = Date.now();
      hit.status = reply.status;
      const bodyOpen = await waitWhileOpen(reply.bodyDelayMs, req);
      if (!bodyOpen || req.socket.destroyed || res.writableEnded) return;
      res.end(JSON.stringify(reply.body));
      hit.bodyAt = Date.now();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    }
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
    const created = provisionTenant(db, 'Vertex Deadline');
    tenant = { tenantId: created.tenantId, secret: created.secret };
    const env = cliEnv();
    runCli(db, ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--auth-mode', 'adc', '--project', PROJECT, '--location', 'us-central1'], env);
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'vertex',
        '--name',
        'gemini-deadline',
        '--upstream-model',
        'gemini-2.5-flash',
        '--timeout-ms',
        '30000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      env,
    );
    runCli(db, ['set-alias', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--deployment', 'gemini-deadline'], env);
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      credentialKey,
      vertexClientFactory: async (spec) => {
        const options = describeVertexClientOptions(spec);
        const ai = new GoogleGenAI({
          ...options,
          googleAuthOptions: { ...options.googleAuthOptions, authClient: new HeaderAuth() },
          httpOptions: { baseUrl: `http://127.0.0.1:${port}/`, apiVersion: spec.apiVersion },
        });
        return vertexGenerateClient(ai);
      },
    });
    admin = adminPool(db);
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (ctx !== undefined) {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
    }
    if (admin !== undefined) await admin.end();
  });

  function setPolicy(input: {
    retries: boolean;
    connection: number;
    attempt: number;
    total: number;
    initial?: number;
    max?: number;
  }): void {
    const result = runCli(
      db,
      [
        'set-execution-policy',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'gemini-deadline',
        '--retries',
        input.retries ? 'true' : 'false',
        '--connection-deadline-ms',
        String(input.connection),
        '--attempt-deadline-ms',
        String(input.attempt),
        '--total-deadline-ms',
        String(input.total),
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

  function useReplies(replies: Reply[]): void {
    hits.length = 0;
    other.length = 0;
    queue = replies.slice();
  }

  async function chat(content: string): Promise<{ status: number; body: string; elapsedMs: number }> {
    const started = Date.now();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', content),
    });
    return { status: response.statusCode, body: response.body, elapsedMs: Date.now() - started };
  }

  async function rowsSince(since: Date): Promise<AttemptRow[]> {
    const result = await admin.query<AttemptRow>(
      `SELECT a.attempt_ordinal, a.status, a.failure_class, a.dispatched, a.expense_certainty,
              a.duration_ms, ac.amount::text AS amount, r.status AS request_status
       FROM model_attempts a
       JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
       LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
       WHERE a.tenant_id = $1 AND a.created_at >= $2
       ORDER BY a.created_at, a.attempt_ordinal`,
      [tenant.tenantId, since],
    );
    return result.rows;
  }

  it('accepts a body that finishes inside the attempt deadline after headers', async () => {
    setPolicy({ retries: false, connection: 800, attempt: 4000, total: 6000 });
    useReplies([{ status: 200, headerDelayMs: 30, bodyDelayMs: 1100, body: okBody() }]);
    const since = new Date();
    const result = await chat('headers-then-body');
    const stored = await rowsSince(since);
    const hit = hits[0];
    console.log(
      `VERTEX_DEADLINE ${JSON.stringify({
        case: 'headers-inside-connection',
        status: result.status,
        hits: hits.length,
        elapsedMs: result.elapsedMs,
        headerMs: hit === undefined || hit.headerAt === null ? null : hit.headerAt - hit.at,
        bodyAfterHeaderMs: hit === undefined || hit.headerAt === null || hit.bodyAt === null ? null : hit.bodyAt - hit.headerAt,
        path: hit?.path ?? null,
        attempts: stored.map((row) => ({
          ordinal: row.attempt_ordinal,
          status: row.status,
          failureClass: row.failure_class,
          dispatched: row.dispatched,
          expense: row.expense_certainty,
          durationMs: row.duration_ms,
          amount: row.amount,
        })),
      })}`,
    );
    expect(other).toEqual([]);
    expect(hits).toHaveLength(1);
    expect(hit?.path).toContain(PROJECT);
    expect(hit?.path).toContain(':generateContent');
    expect(hit?.path).not.toContain('aiplatform.googleapis.com');
    expect(hit?.headerAt).not.toBeNull();
    expect(hit?.bodyAt).not.toBeNull();
    expect((hit?.headerAt ?? 0) - (hit?.at ?? 0)).toBeLessThan(800);
    expect((hit?.bodyAt ?? 0) - (hit?.headerAt ?? 0)).toBeGreaterThanOrEqual(1000);
    expect(result.status).toBe(200);
    expect(result.body).toContain('vertex-ok');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      attempt_ordinal: 1,
      status: 'succeeded',
      failure_class: null,
      dispatched: true,
      expense_certainty: 'known',
      request_status: 'succeeded',
      amount: null,
    });
  });

  it('records a connection deadline before headers as not dispatched', async () => {
    setPolicy({ retries: false, connection: 300, attempt: 4000, total: 6000 });
    useReplies([{ status: 200, headerDelayMs: 1500, bodyDelayMs: 0, body: okBody() }]);
    const since = new Date();
    const result = await chat('headers-after-connection');
    const stored = await rowsSince(since);
    const hit = hits[0];
    console.log(
      `VERTEX_DEADLINE ${JSON.stringify({
        case: 'headers-after-connection',
        status: result.status,
        hits: hits.length,
        elapsedMs: result.elapsedMs,
        headerAt: hit?.headerAt ?? null,
        dispatched: stored[0]?.dispatched ?? null,
        failureClass: stored[0]?.failure_class ?? null,
        expense: stored[0]?.expense_certainty ?? null,
        amount: stored[0]?.amount ?? null,
        durationMs: stored[0]?.duration_ms ?? null,
      })}`,
    );
    expect(other).toEqual([]);
    expect(hits).toHaveLength(1);
    expect(hit?.headerAt).toBeNull();
    expect(result.status).toBe(504);
    expect(result.elapsedMs).toBeLessThan(1200);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      attempt_ordinal: 1,
      status: 'failed',
      failure_class: 'timeout_before_dispatch',
      dispatched: false,
      expense_certainty: 'none',
      request_status: 'failed',
      amount: null,
    });
  });

  it('waits for a Vertex 429 Retry-After before the second attempt', async () => {
    setPolicy({ retries: true, connection: 5000, attempt: 5000, total: 8000 });
    useReplies([
      { status: 429, retryAfter: '1', headerDelayMs: 0, bodyDelayMs: 0, body: errorBody(429) },
      { status: 200, headerDelayMs: 0, bodyDelayMs: 0, body: okBody() },
    ]);
    const since = new Date();
    const result = await chat('vertex-429');
    const stored = await rowsSince(since);
    const gapMs = hits.length >= 2 ? hits[1]!.at - hits[0]!.at : null;
    console.log(
      `VERTEX_RETRY_AFTER ${JSON.stringify({
        case: '429',
        status: result.status,
        hits: hits.length,
        statuses: hits.map((item) => item.status),
        gapMs,
        elapsedMs: result.elapsedMs,
        attempts: stored.map((row) => ({
          ordinal: row.attempt_ordinal,
          status: row.status,
          failureClass: row.failure_class,
          dispatched: row.dispatched,
          expense: row.expense_certainty,
          amount: row.amount,
          durationMs: row.duration_ms,
        })),
      })}`,
    );
    expect(other).toEqual([]);
    expect(hits).toHaveLength(2);
    expect(hits.every((item) => item.path.includes(':generateContent') && item.path.includes(PROJECT))).toBe(true);
    expect(gapMs).toBeGreaterThanOrEqual(800);
    expect(gapMs).toBeLessThan(3000);
    expect(result.status).toBe(200);
    expect(result.body).toContain('vertex-ok');
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      attempt_ordinal: 1,
      status: 'failed',
      failure_class: 'rate_limit',
      dispatched: true,
      expense_certainty: 'known',
      amount: null,
    });
    expect(stored[1]).toMatchObject({
      attempt_ordinal: 2,
      status: 'succeeded',
      failure_class: null,
      dispatched: true,
      request_status: 'succeeded',
      amount: null,
    });
  });

  it('waits for a Vertex 503 Retry-After before the second attempt', async () => {
    setPolicy({ retries: true, connection: 5000, attempt: 5000, total: 8000 });
    useReplies([
      { status: 503, retryAfter: '1', headerDelayMs: 0, bodyDelayMs: 0, body: errorBody(503) },
      { status: 200, headerDelayMs: 0, bodyDelayMs: 0, body: okBody() },
    ]);
    const since = new Date();
    const result = await chat('vertex-503');
    const stored = await rowsSince(since);
    const gapMs = hits.length >= 2 ? hits[1]!.at - hits[0]!.at : null;
    console.log(
      `VERTEX_RETRY_AFTER ${JSON.stringify({
        case: '503',
        status: result.status,
        hits: hits.length,
        statuses: hits.map((item) => item.status),
        gapMs,
        elapsedMs: result.elapsedMs,
        failureClass: stored[0]?.failure_class ?? null,
        amount: stored[0]?.amount ?? null,
      })}`,
    );
    expect(hits).toHaveLength(2);
    expect(gapMs).toBeGreaterThanOrEqual(800);
    expect(gapMs).toBeLessThan(3000);
    expect(result.status).toBe(200);
    expect(stored[0]).toMatchObject({
      attempt_ordinal: 1,
      status: 'failed',
      failure_class: 'unavailable',
      dispatched: true,
      expense_certainty: 'known',
      amount: null,
    });
    expect(stored[1]).toMatchObject({ attempt_ordinal: 2, status: 'succeeded', amount: null });
  });

  it('does not retry when a Vertex Retry-After does not fit the deadline', async () => {
    setPolicy({ retries: true, connection: 2000, attempt: 2000, total: 2000 });
    useReplies([
      { status: 429, retryAfter: '10', headerDelayMs: 0, bodyDelayMs: 0, body: errorBody(429) },
      { status: 200, headerDelayMs: 0, bodyDelayMs: 0, body: okBody() },
    ]);
    const since = new Date();
    const result = await chat('vertex-retry-after-too-long');
    const stored = await rowsSince(since);
    console.log(
      `VERTEX_RETRY_AFTER ${JSON.stringify({
        case: 'retry-after-too-long',
        status: result.status,
        hits: hits.length,
        elapsedMs: result.elapsedMs,
        failureClass: stored[0]?.failure_class ?? null,
        dispatched: stored[0]?.dispatched ?? null,
        expense: stored[0]?.expense_certainty ?? null,
        amount: stored[0]?.amount ?? null,
      })}`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.status).toBe(429);
    expect(result.status).toBe(502);
    expect(result.elapsedMs).toBeLessThan(800);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      attempt_ordinal: 1,
      status: 'failed',
      failure_class: 'rate_limit',
      dispatched: true,
      expense_certainty: 'known',
      request_status: 'failed',
      amount: null,
    });
  });
});
