import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  freePort,
  loadTestDatabase,
  projectRoot,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForExit,
  waitForReady,
} from './helpers.js';
import {
  adminPool,
  chatPayload,
  credentialKey,
  credentialKeyText,
  enableStreaming,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockAnthropic, type AnthropicHit } from './mock-anthropic.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const OPENAI_MODEL = 'gpt-metrics-actual';
const ANTHROPIC_MODEL = 'claude-metrics';

function framed(text: string): string {
  return text.endsWith('\n\n') ? text : `${text.replace(/\n*$/, '')}\n\n`;
}

function successBody(): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
  return framed(raw.replaceAll('__MODEL__', OPENAI_MODEL));
}

function anthropicUsageBody(): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/anthropic-stream/usage.sse'), 'utf8');
  return framed(raw.replaceAll('__MODEL__', ANTHROPIC_MODEL));
}

function contentOf(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
  const content = parsed.messages?.[0]?.content;
  return typeof content === 'string' ? content : '';
}

function nearestRank(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function percentile(values: number[], fraction: number): number | null {
  return nearestRank(values, fraction);
}

type AttemptRow = {
  stream_status: string | null;
  attempt_status: string;
  error_code: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  first_text_delta_ms: number | null;
  duration_ms: number | null;
  provider: string;
  deployment_name: string;
};

function openPost(
  port: number,
  tenantId: string,
  secret: string,
  payload: string,
  timeoutMs?: number,
): {
  settled: Promise<{ status: number; raw: string; headers: IncomingMessage['headers']; firstByteMs: number | null }>;
  destroy: () => void;
} {
  const started = performance.now();
  let destroy = (): void => undefined;
  const settled = new Promise<{
    status: number;
    raw: string;
    headers: IncomingMessage['headers'];
    firstByteMs: number | null;
  }>((resolve, reject) => {
    let done = false;
    const finish = (value: {
      status: number;
      raw: string;
      headers: IncomingMessage['headers'];
      firstByteMs: number | null;
    }): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-tenant-id': tenantId,
          authorization: `Bearer ${secret}`,
        },
      },
      (res) => {
        let firstByteMs: number | null = null;
        const parts: Buffer[] = [];
        res.on('data', (chunk) => {
          if (firstByteMs === null) firstByteMs = performance.now() - started;
          parts.push(Buffer.from(chunk));
        });
        const snapshot = (): {
          status: number;
          raw: string;
          headers: IncomingMessage['headers'];
          firstByteMs: number | null;
        } => ({
          status: res.statusCode ?? 0,
          raw: Buffer.concat(parts).toString('utf8'),
          headers: res.headers,
          firstByteMs,
        });
        res.on('end', () => finish(snapshot()));
        res.on('aborted', () => finish(snapshot()));
        res.on('close', () => {
          if (req.destroyed) finish(snapshot());
        });
      },
    );
    destroy = () => req.destroy();
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
        finish({ status: 0, raw: '', headers: {}, firstByteMs: null });
        return;
      }
      if (!done) reject(error);
    });
    req.write(payload);
    req.end();
  });
  return { settled, destroy };
}

function openPaused(port: number, tenantId: string, secret: string, payload: string): { destroy: () => void } {
  const req = httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-tenant-id': tenantId,
        authorization: `Bearer ${secret}`,
      },
    },
    (res) => {
      res.pause();
    },
  );
  req.on('error', () => undefined);
  req.write(payload);
  req.end();
  return { destroy: () => req.destroy() };
}

describe('streaming production controls', () => {
  const db = loadTestDatabase();

  it('reports stream metrics for OpenAI and Anthropic under row-level security', async () => {
    const openaiHits: MockHit[] = [];
    const anthropicHits: AnthropicHit[] = [];
    let releaseCancel: (() => void) | undefined;
    const openai = await startMockUpstream((hit, request, response) => {
      openaiHits.push(hit);
      const content = contentOf(hit.body);
      if (content === 'openai-json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(OPENAI_MODEL, 'ok')));
        return;
      }
      if (content === 'openai-error') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'no', type: 'server_error' } }));
        return;
      }
      if (content === 'openai-truncate') {
        const body = successBody();
        const split = body.indexOf('\n\n');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(body.slice(0, split + 2));
        return;
      }
      if (content === 'openai-cancel') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(successBody().slice(0, successBody().indexOf('\n\n') + 2));
        const timer = setTimeout(() => {
          if (!response.writableEnded) response.end(successBody());
        }, 10_000);
        releaseCancel = () => {
          clearTimeout(timer);
        };
        request.on('aborted', () => clearTimeout(timer));
        request.socket.on('close', () => clearTimeout(timer));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    });
    const anthropic = await startMockAnthropic((hit, _request, response) => {
      anthropicHits.push(hit);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(anthropicUsageBody());
    });
    const tenant = provisionTenant(db, 'Metrics Primary');
    const other = provisionTenant(db, 'Metrics Other');
    const off = provisionTenant(db, 'Metrics Off');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-metrics-openai',
      deployment: 'metrics-openai',
      upstreamModel: OPENAI_MODEL,
      timeoutMs: 10_000,
    });
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-metrics',
      endpoint: anthropic.origin,
      deployment: 'metrics-claude',
      upstreamModel: ANTHROPIC_MODEL,
    });
    registerInference(db, {
      tenantId: off.tenantId,
      apiKey: 'sk-test-metrics-off',
      deployment: 'metrics-off',
      upstreamModel: OPENAI_MODEL,
      timeoutMs: 10_000,
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'metrics-openai' });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'metrics-claude' });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
    const port = await freePort();
    const admin = adminPool(db);
    await ctx.app.listen({ host: '127.0.0.1', port });
    await admin.query('SELECT 1');
    try {
      const sdk = new OpenAI({
        apiKey: tenant.secret,
        baseURL: `http://127.0.0.1:${port}/v1`,
        defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
        maxRetries: 0,
        timeout: 15_000,
      });
      const before = openaiHits.length;
      const openaiEvents: string[] = [];
      const openaiStream = await sdk.chat.completions.create({
        model: 'metrics-openai',
        messages: [{ role: 'user', content: 'openai-ok' }],
        stream: true,
      });
      for await (const event of openaiStream) {
        openaiEvents.push(JSON.stringify(event));
      }
      expect(openaiEvents.length).toBeGreaterThan(0);
      expect(openaiHits.length).toBe(before + 1);

      const beforeAnthropic = anthropicHits.length;
      const anthropicEvents: string[] = [];
      const anthropicStream = await sdk.chat.completions.create({
        model: 'metrics-claude',
        messages: [{ role: 'user', content: 'anthropic-ok' }],
        stream: true,
      });
      for await (const event of anthropicStream) {
        anthropicEvents.push(JSON.stringify(event));
      }
      expect(anthropicEvents.length).toBeGreaterThan(0);
      expect(anthropicHits.length).toBe(beforeAnthropic + 1);
      expect(anthropicHits.at(-1)?.url).toBe('/v1/messages');

      const json = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('metrics-openai', 'openai-json'),
      });
      expect(json.statusCode).toBe(200);

      const truncated = await openPost(
        port,
        tenant.tenantId,
        tenant.secret,
        chatPayload('metrics-openai', 'openai-truncate', { stream: true }),
        20_000,
      );
      const truncatedBody = await truncated.settled;
      expect(truncatedBody.status).toBe(200);
      expect(truncatedBody.headers['x-accel-buffering']).toBe('no');
      expect(truncatedBody.headers['content-encoding']).toBeUndefined();
      expect(truncatedBody.raw).not.toContain('[DONE]');

      const failed = await openPost(
        port,
        tenant.tenantId,
        tenant.secret,
        chatPayload('metrics-openai', 'openai-error', { stream: true }),
        20_000,
      );
      const failedBody = await failed.settled;
      expect(failedBody.status).toBe(502);
      expect(failedBody.raw).not.toContain('[DONE]');

      const hitsBeforeCancel = openaiHits.length;
      const cancel = openPost(
        port,
        tenant.tenantId,
        tenant.secret,
        chatPayload('metrics-openai', 'openai-cancel', { stream: true }),
        20_000,
      );
      const started = Date.now();
      let cancelStatus: string | null = null;
      while (Date.now() - started < 5_000) {
        const found = await admin.query<{ stream_status: string | null }>(
          `SELECT stream_status FROM model_attempts
           WHERE tenant_id = $1 AND stream_status IN ('streaming', 'connecting')
           ORDER BY created_at DESC LIMIT 1`,
          [tenant.tenantId],
        );
        cancelStatus = found.rows[0]?.stream_status ?? null;
        if (cancelStatus === 'streaming' || cancelStatus === 'connecting') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(cancelStatus === 'streaming' || cancelStatus === 'connecting').toBe(true);
      cancel.destroy();
      releaseCancel?.();
      await cancel.settled;
      const cancelWait = Date.now();
      let storedCancel = false;
      while (Date.now() - cancelWait < 5_000) {
        const found = await admin.query<{ stream_status: string | null }>(
          `SELECT stream_status FROM model_attempts WHERE tenant_id = $1 AND stream_status = 'client_aborted'`,
          [tenant.tenantId],
        );
        if ((found.rowCount ?? 0) > 0) {
          storedCancel = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(storedCancel).toBe(true);
      expect(openaiHits.length).toBe(hitsBeforeCancel + 1);

      const offHits = openaiHits.length;
      const denied = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': off.tenantId,
          authorization: `Bearer ${off.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('metrics-off', 'should-not-stream', { stream: true }),
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('unsupported_parameter');
      expect(denied.json().error.param).toBe('stream');
      expect(openaiHits.length).toBe(offHits);

      const unauthenticated = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/metrics/summary?from=2030-01-01T00:00:00.000Z&to=2030-01-02T00:00:00.000Z',
      });
      expect(unauthenticated.statusCode).toBe(401);

      const from = new Date(Date.now() - 120_000).toISOString();
      const to = new Date(Date.now() + 120_000).toISOString();
      const summary = await ctx.app.inject({
        method: 'GET',
        url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
      });
      expect(summary.statusCode).toBe(200);
      const body = summary.json();
      console.log(JSON.stringify({ metricsSummary: body }));
      expect(body.requests).toMatchObject({ total: 6, succeeded: 3, failed: 3, pending: 0 });
      expect(body.usage).toMatchObject({ promptTokens: 21, completionTokens: 19, totalTokens: 40 });
      expect(body.streaming).toMatchObject({
        requests: 5,
        completed: 2,
        cancelled: 1,
        errors: 1,
        truncated: 1,
        usage: { promptTokens: 18, completionTokens: 17, totalTokens: 35 },
      });
      expect(body.streaming.firstTextDeltaMs.samples).toBeGreaterThan(0);
      expect(body.streaming.durationMs.samples).toBe(5);
      const stored = await admin.query<AttemptRow>(
        `SELECT a.stream_status, a.status AS attempt_status, a.error_code,
                a.prompt_tokens, a.completion_tokens, a.total_tokens,
                a.first_text_delta_ms, a.duration_ms, c.provider, d.name AS deployment_name
         FROM model_attempts a
         JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
         JOIN provider_connections c ON c.id = d.connection_id AND c.tenant_id = d.tenant_id
         WHERE a.tenant_id = $1 AND a.stream_status IS NOT NULL`,
        [tenant.tenantId],
      );
      const firstValues = stored.rows
        .map((row) => row.first_text_delta_ms)
        .filter((value): value is number => value !== null);
      const durationValues = stored.rows
        .map((row) => row.duration_ms)
        .filter((value): value is number => value !== null);
      expect(body.streaming.firstTextDeltaMs.p50).toBe(nearestRank(firstValues, 0.5));
      expect(body.streaming.firstTextDeltaMs.p95).toBe(nearestRank(firstValues, 0.95));
      expect(body.streaming.durationMs.p50).toBe(nearestRank(durationValues, 0.5));
      expect(body.streaming.durationMs.p95).toBe(nearestRank(durationValues, 0.95));
      expect(body.byDeployment).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'openai',
            deployment: 'metrics-openai',
            requests: 5,
            completed: 2,
            cancelled: 1,
            errors: 1,
            truncated: 1,
            promptTokens: 6,
            completionTokens: 4,
            totalTokens: 10,
          }),
          expect.objectContaining({
            provider: 'anthropic',
            deployment: 'metrics-claude',
            requests: 1,
            completed: 1,
            promptTokens: 15,
            completionTokens: 15,
            totalTokens: 30,
          }),
        ]),
      );
      expect(body.byProvider).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'openai',
            requests: 5,
            completed: 2,
            promptTokens: 6,
            completionTokens: 4,
            totalTokens: 10,
          }),
          expect.objectContaining({ provider: 'anthropic', requests: 1, completed: 1, totalTokens: 30 }),
        ]),
      );
      expect(JSON.stringify(body)).not.toContain('quality');
      expect(stored.rows.some((row) => row.stream_status === 'timed_out')).toBe(false);

      const otherSummary = await ctx.app.inject({
        method: 'GET',
        url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: { 'x-tenant-id': other.tenantId, authorization: `Bearer ${other.secret}` },
      });
      expect(otherSummary.statusCode).toBe(200);
      const otherBody = otherSummary.json();
      expect(otherBody.requests.total).toBe(0);
      expect(otherBody.streaming.requests).toBe(0);
      expect(otherBody.streaming.completed).toBe(0);
      expect(otherBody.usage.promptTokens).toBeNull();
      expect(otherBody.streaming.usage.promptTokens).toBeNull();
      expect(otherBody.streaming.firstTextDeltaMs.p50).toBeNull();
      expect(otherBody.streaming.firstTextDeltaMs.p95).toBeNull();
      expect(otherBody.streaming.durationMs.p50).toBeNull();
      expect(otherBody.streaming.durationMs.p95).toBeNull();
      expect(otherBody.byDeployment).toEqual([]);
      expect(otherBody.byProvider).toEqual([]);
      expect(JSON.stringify(otherBody)).not.toContain('metrics-openai');
      expect(JSON.stringify(otherBody)).not.toContain('metrics-claude');

      const empty = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/metrics/summary?from=2030-01-01T00:00:00.000Z&to=2030-01-02T00:00:00.000Z',
        headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
      });
      const emptyBody = empty.json();
      expect(emptyBody.requests.total).toBe(0);
      expect(emptyBody.usage.promptTokens).toBeNull();
      expect(emptyBody.usage.completionTokens).toBeNull();
      expect(emptyBody.usage.totalTokens).toBeNull();
      expect(emptyBody.streaming.requests).toBe(0);
      expect(emptyBody.streaming.usage.promptTokens).toBeNull();
      expect(emptyBody.streaming.firstTextDeltaMs).toEqual({ samples: 0, p50: null, p95: null });
      expect(emptyBody.streaming.durationMs).toEqual({ samples: 0, p50: null, p95: null });
      expect(emptyBody.latency.sumMs).toBeNull();
      expect(emptyBody.latency.maxMs).toBeNull();
    } finally {
      releaseCancel?.();
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
      await openai.close();
      await anthropic.close();
    }
  });

  it('isolates tenant caps per process and releases a slow consumer slot', async () => {
    let slowWrites = 0;
    let slowStopped = false;
    const openai = await startMockUpstream((hit, request, response) => {
      const content = contentOf(hit.body);
      if (content === 'proc-hold' || content === 'slow-hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = `data: ${JSON.stringify({
          id: 'chatcmpl-hold',
          object: 'chat.completion.chunk',
          created: 1,
          model: OPENAI_MODEL,
          choices: [{ index: 0, delta: { content: 'y'.repeat(content === 'slow-hold' ? 256 * 1024 : 1) }, finish_reason: null }],
        })}\n\n`;
        const pump = (): void => {
          if (response.writableEnded || response.destroyed || request.aborted || request.socket.destroyed) {
            slowStopped = true;
            return;
          }
          slowWrites += 1;
          if (slowWrites >= 24 && content === 'slow-hold') return;
          const accepted = response.write(chunk);
          if (content === 'slow-hold') {
            setImmediate(pump);
            return;
          }
          if (!accepted) response.once('drain', () => setImmediate(pump));
          else setTimeout(pump, 50);
        };
        pump();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    });
    const alpha = provisionTenant(db, 'Cap Alpha');
    const beta = provisionTenant(db, 'Cap Beta');
    for (const tenant of [alpha, beta]) {
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: tenant.name === 'Cap Alpha' ? 'sk-test-cap-alpha' : 'sk-test-cap-beta',
        deployment: 'cap-chat',
        upstreamModel: OPENAI_MODEL,
        timeoutMs: 10_000,
      });
      enableStreaming(db, {
        tenantId: tenant.tenantId,
        deployment: 'cap-chat',
        backpressureTimeoutMs: 200,
      });
    }
    const portA = await freePort();
    const portB = await freePort();
    const childA = spawnServer(
      serviceEnv(db, {
        PORT: String(portA),
        INFERENCE_ENABLED: 'true',
        OPENAI_BASE_URL: openai.baseUrl,
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
        MAX_ACTIVE_STREAMS: '2',
        MAX_STREAMS_PER_TENANT: '1',
        STREAM_SHUTDOWN_DRAIN_MS: '200',
      }),
    );
    const childB = spawnServer(
      serviceEnv(db, {
        PORT: String(portB),
        INFERENCE_ENABLED: 'true',
        OPENAI_BASE_URL: openai.baseUrl,
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
        MAX_ACTIVE_STREAMS: '1',
        MAX_STREAMS_PER_TENANT: '2',
        STREAM_SHUTDOWN_DRAIN_MS: '200',
      }),
    );
    const holds: Array<{ destroy: () => void }> = [];
    try {
      await waitForReady(portA);
      await waitForReady(portB);
      const hitsAtStart = openai.hits.length;
      const hold = openPost(portA, alpha.tenantId, alpha.secret, chatPayload('cap-chat', 'proc-hold', { stream: true }));
      holds.push(hold);
      const admin = adminPool(db);
      const waitStarted = Date.now();
      let holding = false;
      while (Date.now() - waitStarted < 5_000) {
        const row = await admin.query(
          `SELECT 1 FROM model_attempts WHERE tenant_id = $1 AND stream_status IN ('connecting', 'streaming')`,
          [alpha.tenantId],
        );
        if ((row.rowCount ?? 0) > 0) {
          holding = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await admin.end();
      expect(holding).toBe(true);
      const second = await fetch(`http://127.0.0.1:${portA}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': alpha.tenantId,
          authorization: `Bearer ${alpha.secret}`,
        },
        body: chatPayload('cap-chat', 'proc-second', { stream: true }),
      });
      expect(second.status).toBe(503);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe('stream_capacity');
      expect(openai.hits.length).toBe(hitsAtStart + 1);

      const other = await fetch(`http://127.0.0.1:${portA}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': beta.tenantId,
          authorization: `Bearer ${beta.secret}`,
        },
        body: chatPayload('cap-chat', 'proc-ok', { stream: true }),
      });
      expect(other.status).toBe(200);
      expect(await other.text()).toContain('[DONE]');

      const onOtherProcess = await fetch(`http://127.0.0.1:${portB}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': alpha.tenantId,
          authorization: `Bearer ${alpha.secret}`,
        },
        body: chatPayload('cap-chat', 'proc-ok-b', { stream: true }),
      });
      expect(onOtherProcess.status).toBe(200);
      expect(await onOtherProcess.text()).toContain('[DONE]');

      const fillB = openPost(portB, beta.tenantId, beta.secret, chatPayload('cap-chat', 'proc-hold', { stream: true }));
      holds.push(fillB);
      const fillWait = Date.now();
      let filled = false;
      const adminB = adminPool(db);
      while (Date.now() - fillWait < 5_000) {
        const row = await adminB.query(
          `SELECT 1 FROM model_attempts
           WHERE tenant_id = $1 AND stream_status IN ('connecting', 'streaming')`,
          [beta.tenantId],
        );
        if ((row.rowCount ?? 0) > 0) {
          filled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await adminB.end();
      expect(filled).toBe(true);
      const hitsBeforeProcessCap = openai.hits.length;
      const processBlocked = await fetch(`http://127.0.0.1:${portB}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': alpha.tenantId,
          authorization: `Bearer ${alpha.secret}`,
        },
        body: chatPayload('cap-chat', 'proc-blocked', { stream: true }),
      });
      expect(processBlocked.status).toBe(503);
      expect(((await processBlocked.json()) as { error: { code: string } }).error.code).toBe('stream_capacity');
      expect(openai.hits.length).toBe(hitsBeforeProcessCap);
    } finally {
      for (const hold of holds) hold.destroy();
      await stopChild(childA.child);
      await stopChild(childB.child);
      await openai.close();
    }

    const slow = await startMockUpstream((hit, request, response) => {
      const content = contentOf(hit.body);
      if (content !== 'slow-hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(successBody());
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = `data: ${JSON.stringify({
        id: 'chatcmpl-slow',
        object: 'chat.completion.chunk',
        created: 1,
        model: OPENAI_MODEL,
        choices: [{ index: 0, delta: { content: 'z'.repeat(256 * 1024) }, finish_reason: null }],
      })}\n\n`;
      const pump = (): void => {
        if (response.writableEnded || response.destroyed || request.aborted || request.socket.destroyed) {
          slowStopped = true;
          return;
        }
        slowWrites += 1;
        if (slowWrites >= 24) return;
        response.write(chunk);
        setTimeout(pump, 20);
      };
      pump();
    });
    slowWrites = 0;
    slowStopped = false;
    const limited = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: slow.baseUrl,
      credentialKey,
      maxActiveStreams: 1,
      maxStreamsPerTenant: 1,
    });
    const port = await freePort();
    await limited.app.listen({ host: '127.0.0.1', port });
    const admin = adminPool(db);
    try {
      const paused = openPaused(port, alpha.tenantId, alpha.secret, chatPayload('cap-chat', 'slow-hold', { stream: true }));
      const statusWait = Date.now();
      let status: string | null = null;
      while (Date.now() - statusWait < 5_000) {
        const row = await admin.query<{ stream_status: string | null }>(
          `SELECT stream_status FROM model_attempts
           WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [alpha.tenantId],
        );
        status = row.rows[0]?.stream_status ?? null;
        if (status === 'slow_consumer') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toBe('slow_consumer');
      const writesAtStop = slowWrites;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(slowStopped || slowWrites < 24).toBe(true);
      expect(slowWrites).toBe(writesAtStop);
      expect(limited.app.streamGate.active()).toBe(0);
      const next = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': beta.tenantId,
          authorization: `Bearer ${beta.secret}`,
        },
        body: chatPayload('cap-chat', 'after-slow', { stream: true }),
      });
      expect(next.status).toBe(200);
      expect(await next.text()).toContain('[DONE]');
      expect(limited.app.streamGate.active()).toBe(0);
      paused.destroy();
    } finally {
      await limited.app.close();
      await limited.authPool.end();
      await limited.runtimePool.end();
      await admin.end();
      await slow.close();
    }
  });

  it('drains open streams and records an abort on a second shutdown', async () => {
    for (const pass of [1, 2]) {
      let releaseFinish: (() => void) | undefined;
      const openai = await startMockUpstream((hit, request, response) => {
        const content = contentOf(hit.body);
        const body = successBody();
        const split = body.indexOf('\n\n') + 2;
        if (content === 'finish-in-drain') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(body.slice(0, split));
          releaseFinish = () => {
            if (!response.writableEnded) response.end(body.slice(split));
          };
          return;
        }
        if (content === 'hold-open') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(body.slice(0, split));
          const timer = setTimeout(() => {
            if (!response.writableEnded) response.end(body.slice(split));
          }, 20_000);
          request.on('aborted', () => clearTimeout(timer));
          request.socket.on('close', () => clearTimeout(timer));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(body);
      });
      const tenant = provisionTenant(db, `Drain ${pass}`);
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: `sk-test-drain-${pass}`,
        deployment: 'drain-chat',
        upstreamModel: OPENAI_MODEL,
        timeoutMs: 10_000,
      });
      enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'drain-chat' });
      const ctx = await createTestApp(db, {
        inferenceEnabled: true,
        upstreamBaseUrl: openai.baseUrl,
        credentialKey,
      });
      const port = await freePort();
      const admin = adminPool(db);
      await ctx.app.listen({ host: '127.0.0.1', port });
      const started = new Date();
      const finish = openPost(port, tenant.tenantId, tenant.secret, chatPayload('drain-chat', 'finish-in-drain', { stream: true }));
      const hold = openPost(port, tenant.tenantId, tenant.secret, chatPayload('drain-chat', 'hold-open', { stream: true }));
      try {
        const waitStarted = Date.now();
        let ready = 0;
        while (Date.now() - waitStarted < 5_000) {
          const rows = await admin.query(
            `SELECT stream_status FROM model_attempts a
             JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
             WHERE a.tenant_id = $1 AND r.created_at >= $2
               AND a.stream_status = 'streaming'`,
            [tenant.tenantId, started],
          );
          ready = rows.rowCount ?? 0;
          if (ready >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(ready).toBe(2);
        const hitsBeforeDrain = openai.hits.length;
        const draining = ctx.app.drainStreams(1_500);
        releaseFinish?.();
        const drained = await draining;
        await finish.settled;
        await hold.settled;
        expect(drained.activeAfter).toBe(0);
        expect(ctx.app.streamGate.active()).toBe(0);
        const rows = await admin.query<{ stream_status: string; status: string; error_code: string | null }>(
          `SELECT a.stream_status, a.status, a.error_code
           FROM model_attempts a
           JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
           WHERE a.tenant_id = $1 AND r.created_at >= $2
           ORDER BY a.stream_status`,
          [tenant.tenantId, started],
        );
        expect(rows.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stream_status: 'completed', status: 'succeeded', error_code: null }),
            expect.objectContaining({ stream_status: 'interrupted', status: 'failed', error_code: 'interrupted' }),
          ]),
        );
        expect(rows.rows.find((row) => row.stream_status === 'interrupted')?.status).not.toBe('succeeded');
        const rejected = await ctx.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            'x-tenant-id': tenant.tenantId,
            authorization: `Bearer ${tenant.secret}`,
            'content-type': 'application/json',
          },
          payload: chatPayload('drain-chat', 'after-shutdown', { stream: true }),
        });
        expect(rejected.statusCode).toBe(503);
        expect(rejected.json().error.code).toBe('shutting_down');
        expect(openai.hits.length).toBe(hitsBeforeDrain);
        const second = await ctx.app.drainStreams(50);
        expect(second.activeAfter).toBe(0);
        expect(second.aborted).toBe(0);
        expect(ctx.app.streamGate.shuttingDown()).toBe(true);
        const stillRejected = await ctx.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            'x-tenant-id': tenant.tenantId,
            authorization: `Bearer ${tenant.secret}`,
            'content-type': 'application/json',
          },
          payload: chatPayload('drain-chat', 'after-second-shutdown', { stream: true }),
        });
        expect(stillRejected.statusCode).toBe(503);
        expect(stillRejected.json().error.code).toBe('shutting_down');
        expect(openai.hits.length).toBe(hitsBeforeDrain);
        console.log(JSON.stringify({
          shutdownPass: pass,
          activeAfter: drained.activeAfter,
          aborted: drained.aborted,
          secondActive: second.activeAfter,
          completed: rows.rows.filter((row) => row.stream_status === 'completed').length,
          interrupted: rows.rows.filter((row) => row.stream_status === 'interrupted').length,
        }));
      } finally {
        releaseFinish?.();
        hold.destroy();
        finish.destroy();
        await ctx.app.close();
        await ctx.authPool.end();
        await ctx.runtimePool.end();
        await admin.end();
        await openai.close();
      }
    }
  });

  it('restarts a proxy process after an interrupted stream', async () => {
    const openai = await startMockUpstream((hit, request, response) => {
      const content = contentOf(hit.body);
      if (content === 'restart-hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(successBody().slice(0, successBody().indexOf('\n\n') + 2));
        const timer = setTimeout(() => {
          if (!response.writableEnded) response.end(successBody());
        }, 20_000);
        request.on('aborted', () => clearTimeout(timer));
        request.socket.on('close', () => clearTimeout(timer));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    });
    const tenant = provisionTenant(db, 'Restart Tenant');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-restart',
      deployment: 'restart-chat',
      upstreamModel: OPENAI_MODEL,
      timeoutMs: 10_000,
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'restart-chat' });
    const port = await freePort();
    const env = {
      PORT: String(port),
      INFERENCE_ENABLED: 'true',
      OPENAI_BASE_URL: openai.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      STREAM_SHUTDOWN_DRAIN_MS: '200',
      MAX_ACTIVE_STREAMS: '4',
      MAX_STREAMS_PER_TENANT: '4',
    };
    let child = spawnServer(serviceEnv(db, env));
    const admin = adminPool(db);
    try {
      await waitForReady(port);
      const hold = openPost(port, tenant.tenantId, tenant.secret, chatPayload('restart-chat', 'restart-hold', { stream: true }));
      const waitStarted = Date.now();
      let live = false;
      while (Date.now() - waitStarted < 5_000) {
        const row = await admin.query(
          `SELECT 1 FROM model_attempts WHERE tenant_id = $1 AND stream_status IN ('connecting', 'streaming')`,
          [tenant.tenantId],
        );
        if ((row.rowCount ?? 0) > 0) {
          live = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(live).toBe(true);
      child.child.kill('SIGTERM');
      const code = await waitForExit(child.child, 10_000);
      expect(code).toBe(0);
      const output = child.output();
      expect(output).toContain('stream drain complete');
      expect(output).toContain('"pools":"closed"');
      expect(output).not.toContain(tenant.secret);
      expect(output).not.toContain('sk-test-restart');
      const stored = await admin.query<{ stream_status: string; status: string }>(
        `SELECT stream_status, status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenant.tenantId],
      );
      expect(stored.rows[0]?.stream_status).toBe('interrupted');
      expect(stored.rows[0]?.status).not.toBe('succeeded');
      hold.destroy();

      child = spawnServer(serviceEnv(db, env));
      await waitForReady(port);
      const again = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
        body: chatPayload('restart-chat', 'restart-ok', { stream: true }),
      });
      expect(again.status).toBe(200);
      const text = await again.text();
      expect(text).toContain('[DONE]');
      expect(text).not.toContain(tenant.secret);
      const completed = await admin.query<{ stream_status: string }>(
        `SELECT stream_status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenant.tenantId],
      );
      expect(completed.rows[0]?.stream_status).toBe('completed');
      console.log(JSON.stringify({
        restartExit: code,
        interrupted: stored.rows[0]?.stream_status,
        restarted: completed.rows[0]?.stream_status,
        drainLogged: output.includes('stream drain complete'),
        poolsClosed: output.includes('"pools":"closed"'),
      }));
    } finally {
      await stopChild(child.child);
      await admin.end();
      await openai.close();
    }
  });

  it('measures mock stream load without a leaked slot', async () => {
    const writesAt = new Map<string, number>();
    let sequence = 0;
    const openai = await startMockUpstream((hit, _request, response) => {
      const content = contentOf(hit.body);
      const id = String(sequence);
      sequence += 1;
      if (content.startsWith('load-hold')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(successBody().slice(0, successBody().indexOf('\n\n') + 2));
        const timer = setTimeout(() => {
          if (!response.writableEnded) response.end(successBody());
        }, 20_000);
        writesAt.set(id, performance.now());
        hit.body = `${hit.body}\n${id}`;
        const stop = (): void => clearTimeout(timer);
        response.on('close', stop);
        return;
      }
      const startedWrite = performance.now();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
      writesAt.set(content, startedWrite);
    });
    const tenant = provisionTenant(db, 'Load Tenant');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-load',
      deployment: 'load-chat',
      upstreamModel: OPENAI_MODEL,
      timeoutMs: 10_000,
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'load-chat' });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      maxActiveStreams: 16,
      maxStreamsPerTenant: 16,
    });
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    const memory: Record<string, number> = {};
    const holds: Array<{ destroy: () => void }> = [];
    try {
      for (const concurrency of [1, 4, 8]) {
        const batch = Array.from({ length: concurrency }, (_value, index) =>
          openPost(port, tenant.tenantId, tenant.secret, chatPayload('load-chat', `load-hold-${concurrency}-${index}`, { stream: true })),
        );
        holds.push(...batch);
        const waitStarted = Date.now();
        while (Date.now() - waitStarted < 5_000 && ctx.app.streamGate.active() < concurrency) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(ctx.app.streamGate.active()).toBe(concurrency);
        memory[String(concurrency)] = process.memoryUsage().rss;
        for (const hold of batch) hold.destroy();
        const releaseWait = Date.now();
        while (Date.now() - releaseWait < 5_000 && ctx.app.streamGate.active() !== 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(ctx.app.streamGate.active()).toBe(0);
      }
      memory.after = process.memoryUsage().rss;

      const runs: Array<Record<string, unknown>> = [];
      for (const run of [1, 2]) {
        const firstText: number[] = [];
        const duration: number[] = [];
        const overhead: number[] = [];
        let completed = 0;
        let errors = 0;
        for (let index = 0; index < 12; index += 1) {
          const content = `load-ok-${run}-${index}`;
          const started = performance.now();
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-tenant-id': tenant.tenantId,
              authorization: `Bearer ${tenant.secret}`,
            },
            body: chatPayload('load-chat', content, { stream: true }),
          });
          const reader = response.body?.getReader();
          let first: number | null = null;
          let raw = '';
          if (reader !== undefined) {
            while (true) {
              const step = await reader.read();
              if (first === null) first = performance.now();
              if (step.done) break;
              raw += Buffer.from(step.value).toString('utf8');
            }
          }
          const ended = performance.now();
          if (response.status === 200 && raw.includes('[DONE]')) completed += 1;
          else errors += 1;
          if (first !== null) firstText.push(first - started);
          duration.push(ended - started);
          const wrote = writesAt.get(content);
          if (first !== null && wrote !== undefined) overhead.push(Math.max(0, first - wrote));
        }
        expect(completed).toBe(12);
        expect(errors).toBe(0);
        expect(ctx.app.streamGate.active()).toBe(0);
        runs.push({
          completed,
          errors,
          completionRate: completed / (completed + errors),
          errorRate: errors / (completed + errors),
          firstTextDeltaMs: { p50: percentile(firstText, 0.5), p95: percentile(firstText, 0.95) },
          durationMs: { p50: percentile(duration, 0.5), p95: percentile(duration, 0.95) },
          forwardingOverheadMs: { p50: percentile(overhead, 0.5), p95: percentile(overhead, 0.95) },
          memoryRssBytes: memory,
        });
      }
      expect(runs[0]).toMatchObject({ completed: 12, errors: 0, completionRate: 1, errorRate: 0 });
      expect(runs[1]).toMatchObject({ completed: 12, errors: 0, completionRate: 1, errorRate: 0 });
      const report = { runs };
      const out = process.env.STREAM_LOAD_OUT;
      if (out !== undefined && out !== '') writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ streamLoad: report }));
    } finally {
      for (const hold of holds) hold.destroy();
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await openai.close();
    }
  });
});
