import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import { createPool } from '../src/db/pools.js';
import {
  configFor,
  createTestApp,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  type TestDatabase,
} from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockAnthropic, type AnthropicHit } from './mock-anthropic.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const MODEL = 'gpt-stream-actual';
const CONFIGURED = 'gpt-stream-configured';
const DELTA_A = 'stream-delta-alpha';
const DELTA_B = 'stream-delta-beta';
const SECRET = 'upstream-secret-text';
const UNICODE = 'caf\u00e9-split';
const ATTEMPT_GRANT = `GRANT UPDATE (
  status, error_code, duration_ms, prompt_tokens, completion_tokens, total_tokens,
  provider_request_id, stop_reason, uncached_input_tokens, cache_creation_input_tokens,
  cache_read_input_tokens, stream_status, first_text_delta_ms, chunk_count, bytes_written
) ON model_attempts TO llm_runtime`;

type Scene = (request: IncomingMessage, response: ServerResponse, hit: MockHit) => void;

function framed(text: string): string {
  return text.endsWith('\n\n') ? text : `${text.replace(/\n*$/, '')}\n\n`;
}

function successBody(model = MODEL): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
  return framed(raw.replaceAll('__MODEL__', model));
}

function contentOf(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
  return String(parsed.messages?.[0]?.content ?? '');
}

function sseEvents(raw: string): string[] {
  return raw
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
}

describe('OpenAI streaming', () => {
  const db = loadTestDatabase();
  const state: {
    db: TestDatabase;
    port: number;
    tenantId: string;
    secret: string;
    apiKey: string;
    otherId: string;
    otherSecret: string;
    otherKey: string;
    offId: string;
    offSecret: string;
    baseUrl: string;
    releaseTelemetry: () => void;
    backpressureWrites: number;
    backpressureBytes: number;
    aborted: Set<string>;
  } = {
    db,
    port: 0,
    tenantId: '',
    secret: '',
    apiKey: 'sk-test-stream-enabled',
    otherId: '',
    otherSecret: '',
    otherKey: 'sk-test-stream-other',
    offId: '',
    offSecret: '',
    baseUrl: '',
    releaseTelemetry: () => undefined,
    backpressureWrites: 0,
    backpressureBytes: 0,
    aborted: new Set(),
  };
  const closers: Array<() => Promise<void>> = [];
  let hits: MockHit[] = [];
  let anthropicHits: AnthropicHit[] = [];
  let lines: string[] = [];
  let admin: ReturnType<typeof adminPool>;
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];

  function markAbort(content: string, request: IncomingMessage, response: ServerResponse): void {
    const note = (): void => {
      if (!response.writableEnded) state.aborted.add(content);
    };
    request.on('aborted', note);
    request.socket?.on('close', note);
  }

  const scenes: Record<string, Scene> = {
    'sdk-success': (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    },
    'raw-frame': (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    },
    'cancel-me': (request, response) => {
      markAbort('cancel-me', request, response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(successBody().split('data: [DONE]')[0] ?? '');
    },
    backpressure: (request, response) => {
      markAbort('backpressure', request, response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const first = framed(
        `data: ${JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
        })}`,
      );
      state.backpressureBytes += Buffer.byteLength(first);
      response.write(first);
      const big = 'y'.repeat(256 * 1024);
      const pump = (): void => {
        // The request readable is destroyed after its body ends. The socket stays open.
        if (response.writableEnded || response.destroyed || request.aborted || request.socket?.destroyed === true) return;
        if (state.backpressureWrites >= 24) return;
        const frame = `data: ${JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: MODEL,
          choices: [{ index: 0, delta: { content: big }, finish_reason: null }],
        })}\n\n`;
        state.backpressureWrites += 1;
        state.backpressureBytes += Buffer.byteLength(frame);
        response.write(frame);
        setImmediate(pump);
      };
      setImmediate(pump);
    },
    'error-before': (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: SECRET, type: 'server_error' } }));
    },
    'error-after': (_request, response) => {
      const body = successBody();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(body.slice(0, body.indexOf(DELTA_B)));
      response.end(`data: ${JSON.stringify({ error: { message: SECRET } })}\n\n`);
    },
    'missing-done': (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody().replace('data: [DONE]\n\n', ''));
    },
    'missing-usage': (_request, response) => {
      const withoutUsage = successBody()
        .split(/\n\n/)
        .filter((block) => !block.includes('prompt_tokens'))
        .join('\n\n');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(framed(withoutUsage));
    },
    'unicode-split': (_request, response) => {
      const frame = Buffer.from(
        `data: ${JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: UNICODE }, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      );
      const split = frame.indexOf(0xc3);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame.subarray(0, split + 1));
      setTimeout(() => {
        if (!response.writableEnded) response.end(frame.subarray(split + 1));
      }, 20);
    },
    'parallel-a': (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    },
    'parallel-b': (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    },
    'db-fail': (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successBody());
    },
    'telemetry-gap': (_request, response) => {
      const body = successBody();
      const at = body.indexOf(DELTA_B);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(body.slice(0, at));
      void new Promise<void>((resolve) => {
        state.releaseTelemetry = resolve;
      }).then(() => {
        if (response.writableEnded) return;
        response.end(body.slice(at));
      });
    },
    'timeout-connect': (request, response) => {
      markAbort('timeout-connect', request, response);
    },
    'timeout-idle': (request, response) => {
      markAbort('timeout-idle', request, response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = successBody();
      response.write(body.slice(0, body.indexOf(DELTA_B)));
    },
    'timeout-total': (request, response) => {
      markAbort('timeout-total', request, response);
      setTimeout(() => {
        if (!response.writableEnded) response.end(successBody());
      }, 5_000);
    },
    'stall-write': (request, response) => {
      markAbort('stall-write', request, response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: { role?: string; content?: string }) =>
        JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      response.write(framed(`data: ${chunk({ role: 'assistant', content: 'x' })}`));
      response.write(framed(`data: ${chunk({ content: 'y'.repeat(256 * 1024) })}`));
    },
    'capacity-hold': (request, response) => {
      markAbort('capacity-hold', request, response);
      const timer = setTimeout(() => {
        if (!response.writableEnded) response.end(successBody());
      }, 5_000);
      const stop = (): void => {
        clearTimeout(timer);
      };
      request.on('aborted', stop);
      request.socket?.on('close', stop);
    },
  };

  beforeAll(async () => {
    const mock = await startMockUpstream((hit, request, response) => {
      const parsed = JSON.parse(hit.body) as { stream?: boolean; model?: string };
      if (parsed.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(parsed.model ?? CONFIGURED, 'ok')));
        return;
      }
      const scene = scenes[contentOf(hit.body)];
      if (scene === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unknown scene' }));
        return;
      }
      scene(request, response, hit);
    });
    hits = mock.hits;
    state.baseUrl = mock.baseUrl;
    const anthropic = await startMockAnthropic();
    const enabled = provisionTenant(db, 'Stream Enabled');
    const other = provisionTenant(db, 'Stream Other');
    const off = provisionTenant(db, 'Stream Off');
    state.tenantId = enabled.tenantId;
    state.secret = enabled.secret;
    state.otherId = other.tenantId;
    state.otherSecret = other.secret;
    state.offId = off.tenantId;
    state.offSecret = off.secret;
    registerInference(db, {
      tenantId: enabled.tenantId,
      apiKey: state.apiKey,
      deployment: 'stream-chat',
      upstreamModel: CONFIGURED,
      timeoutMs: 10_000,
    });
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: state.otherKey,
      deployment: 'stream-chat',
      upstreamModel: CONFIGURED,
      timeoutMs: 10_000,
    });
    registerInference(db, {
      tenantId: off.tenantId,
      apiKey: 'sk-test-stream-off',
      deployment: 'stream-chat',
      upstreamModel: CONFIGURED,
      timeoutMs: 10_000,
    });
    registerAnthropic(db, {
      tenantId: enabled.tenantId,
      apiKey: 'sk-ant-stream-off',
      endpoint: anthropic.origin,
      deployment: 'claude-chat',
      upstreamModel: 'claude-stream',
    });
    enableStreaming(db, { tenantId: enabled.tenantId, deployment: 'stream-chat' });
    enableStreaming(db, { tenantId: other.tenantId, deployment: 'stream-chat' });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    app = ctx.app;
    lines = ctx.lines;
    state.port = await freePort();
    await app.listen({ host: '127.0.0.1', port: state.port });
    admin = adminPool(db);
    closers.push(async () => {
      await app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
      await mock.close();
      await anthropic.close();
    });
    anthropicHits = anthropic.hits;
  });

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  function clientFor(secret: string, tenantId: string): OpenAI {
    return new OpenAI({
      apiKey: secret,
      baseURL: `http://127.0.0.1:${state.port}/v1`,
      maxRetries: 0,
      timeout: 10_000,
      defaultHeaders: { 'X-Tenant-ID': tenantId },
    });
  }

  async function readStream(content: string, tenantId = state.tenantId, secret = state.secret) {
    const stream = await clientFor(secret, tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  function postRaw(content: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{
    status: number;
    type: string;
    raw: string;
  }> {
    const payload = JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content }],
      stream: true,
      ...extra,
    });
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: state.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-tenant-id': state.tenantId,
            authorization: `Bearer ${state.secret}`,
          },
          signal,
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type'] ?? ''),
              raw: Buffer.concat(parts).toString('utf8'),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async function latestAttempt(tenantId: string) {
    const result = await admin.query<{
      provider: string;
      deployment_name: string;
      upstream_model: string;
      stream_status: string | null;
      attempt_status: string;
      request_status: string;
      first_text_delta_ms: number | null;
      chunk_count: number | null;
      bytes_written: number | null;
      duration_ms: number | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      error_code: string | null;
      stop_reason: string | null;
      provider_request_id: string | null;
      attempt_json: unknown;
      request_json: unknown;
    }>(
      `SELECT c.provider, d.name AS deployment_name, a.upstream_model, a.stream_status,
              a.status AS attempt_status, r.status AS request_status,
              a.first_text_delta_ms, a.chunk_count, a.bytes_written, a.duration_ms,
              a.prompt_tokens, a.completion_tokens, a.total_tokens, a.error_code,
              a.stop_reason, a.provider_request_id,
              to_jsonb(a) AS attempt_json, to_jsonb(r) AS request_json
       FROM model_attempts a
       JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
       JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
       JOIN provider_connections c ON c.id = r.connection_id AND c.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [tenantId],
    );
    return result.rows[0];
  }

  function expectNoLeak(row: { attempt_json: unknown; request_json: unknown } | undefined, markers: string[]): void {
    const stored = `${JSON.stringify(row?.attempt_json ?? {})}\n${JSON.stringify(row?.request_json ?? {})}`;
    const logs = lines.join('\n');
    for (const marker of markers) {
      expect(stored).not.toContain(marker);
      expect(logs).not.toContain(marker);
    }
    expect(logs).not.toContain(state.apiKey);
    expect(logs).not.toContain(state.otherKey);
    expect(stored).not.toContain('data:');
  }

  async function waitForStatus(tenantId: string, status: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      const row = await latestAttempt(tenantId);
      if (row?.stream_status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const row = await latestAttempt(tenantId);
    throw new Error(
      `stream status ${status} was not stored; latest=${row?.stream_status ?? 'none'}; chunks=${row?.chunk_count ?? 'none'}; bytes=${row?.bytes_written ?? 'none'}; upstreamWrites=${state.backpressureWrites}; upstreamBytes=${state.backpressureBytes}`,
    );
  }

  it('streams a chat completion the official SDK can read', async () => {
    const before = hits.length;
    const chunks = await readStream('sdk-success');
    expect(hits).toHaveLength(before + 1);
    expect(hits.at(-1)?.authorization).toBe(`Bearer ${state.apiKey}`);
    const upstream = JSON.parse(hits.at(-1)?.body ?? '{}') as { stream?: boolean; model?: string };
    expect(upstream.stream).toBe(true);
    expect(upstream.model).toBe(CONFIGURED);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks[0]?.id).toBe('chatcmpl-fixture');
    expect(chunks.every((chunk) => chunk.model === MODEL)).toBe(true);
    expect(chunks[0]?.choices[0]?.delta?.role).toBe('assistant');
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe(`${DELTA_A} ${DELTA_B}`);
    expect(chunks.some((chunk) => chunk.choices[0]?.finish_reason === 'stop')).toBe(true);
    const usage = chunks.find((chunk) => chunk.usage !== undefined && chunk.usage !== null);
    expect(usage?.choices).toEqual([]);
    expect(usage?.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

    const row = await latestAttempt(state.tenantId);
    expect(row?.provider).toBe('openai');
    expect(row?.deployment_name).toBe('stream-chat');
    expect(row?.upstream_model).toBe(CONFIGURED);
    expect(row?.stream_status).toBe('completed');
    expect(row?.attempt_status).toBe('succeeded');
    expect(row?.request_status).toBe('succeeded');
    expect(row?.provider_request_id).toBe('chatcmpl-fixture');
    expect(row?.stop_reason).toBe('stop');
    expect(row?.prompt_tokens).toBe(3);
    expect(row?.completion_tokens).toBe(2);
    expect(row?.total_tokens).toBe(5);
    expect(row?.first_text_delta_ms).toBeGreaterThanOrEqual(0);
    expect(row?.chunk_count).toBeGreaterThanOrEqual(4);
    expect(row?.bytes_written).toBeGreaterThan(0);
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row?.error_code).toBeNull();
    expectNoLeak(row, ['sdk-success', DELTA_A, DELTA_B]);
  });

  it('frames one done marker and keeps stream=false as JSON', async () => {
    const before = hits.length;
    const raw = await postRaw('raw-frame', { stream_options: { include_usage: true } });
    expect(raw.status).toBe(200);
    expect(raw.type).toContain('text/event-stream');
    const events = sseEvents(raw.raw);
    expect(events.filter((event) => event === '[DONE]')).toHaveLength(1);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event) as { id: string; object: string });
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk' && chunk.id === 'chatcmpl-fixture')).toBe(true);
    expect(hits).toHaveLength(before + 1);

    const json = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': state.tenantId,
        authorization: `Bearer ${state.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'stream-false'),
    });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.json().object).toBe('chat.completion');
    expect(json.json().model).toBe(CONFIGURED);
    expect(json.json().choices[0].message.content).toBe('ok');
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBeNull();
    expect(row?.attempt_status).toBe('succeeded');
    expect(hits).toHaveLength(before + 2);
  });

  it('rejects streaming until both the tenant and the deployment allow it', async () => {
    const before = hits.length;
    const off = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': state.offId,
        authorization: `Bearer ${state.offSecret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'stream-off', { stream: true }),
    });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.code).toBe('unsupported_parameter');
    expect(off.json().error.param).toBe('stream');
    runCli(
      db,
      ['set-deployment-streaming', '--tenant-id', state.tenantId, '--deployment', 'stream-chat', '--enabled', 'false'],
      cliEnv(),
    );
    try {
      const deploymentOff = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('auto', 'deployment-off', { stream: true }),
      });
      expect(deploymentOff.statusCode).toBe(400);
      expect(deploymentOff.json().error.param).toBe('stream');
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }
    const tools = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': state.tenantId,
        authorization: `Bearer ${state.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'tools', { stream: true, tools: [] }),
    });
    expect(tools.statusCode).toBe(400);
    const image = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': state.tenantId,
        authorization: `Bearer ${state.secret}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://img' } }] }],
      }),
    });
    expect(image.statusCode).toBe(400);
    const claude = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': state.tenantId,
        authorization: `Bearer ${state.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('claude-chat', 'claude-stream', { stream: true }),
    });
    expect(claude.statusCode).toBe(400);
    expect(claude.json().error.param).toBe('stream');
    expect(hits).toHaveLength(before);
    expect(anthropicHits).toHaveLength(0);
  });

  it('cancels the upstream stream when the client disconnects', async () => {
    const before = hits.length;
    const controller = new AbortController();
    const pending = postRaw('cancel-me', {}, controller.signal);
    const started = Date.now();
    while (!state.aborted.has('cancel-me') && Date.now() - started < 4_000) {
      const row = await latestAttempt(state.tenantId);
      if (row?.stream_status === 'streaming' || row?.stream_status === 'connecting') break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitForStatus(state.tenantId, 'client_aborted');
    const row = await latestAttempt(state.tenantId);
    expect(row?.attempt_status).toBe('failed');
    expect(row?.error_code).toBe('request_cancelled');
    expect(hits).toHaveLength(before + 1);
    const abortStarted = Date.now();
    while (!state.aborted.has('cancel-me') && Date.now() - abortStarted < 4_000) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(state.aborted.has('cancel-me')).toBe(true);
    expectNoLeak(row, ['cancel-me', DELTA_A]);
  });

  it('aborts a stalled downstream consumer', async () => {
    state.backpressureWrites = 0;
    state.backpressureBytes = 0;
    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'stream-chat',
      backpressureTimeoutMs: 300,
    });
    try {
      const before = hits.length;
      const pending = new Promise<{ status: number; raw: string }>((resolve, reject) => {
        const payload = JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'backpressure' }],
          stream: true,
        });
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: state.port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'x-tenant-id': state.tenantId,
              authorization: `Bearer ${state.secret}`,
            },
          },
          (res) => {
            res.pause();
            void waitForStatus(state.tenantId, 'slow_consumer')
              .then(() => {
                const parts: Buffer[] = [];
                res.resume();
                res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
              })
              .catch(reject);
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      const body = await pending;
      expect(body.status).toBe(200);
      expect(body.raw).not.toContain('[DONE]');
      expect(hits).toHaveLength(before + 1);
      expect(state.aborted.has('backpressure')).toBe(true);
      const row = await latestAttempt(state.tenantId);
      expect(row?.stream_status).toBe('slow_consumer');
      expect(row?.attempt_status).toBe('failed');
      expect(row?.error_code).toBe('slow_consumer');
      expect(row?.bytes_written).toBeGreaterThan(0);
      expect(row?.bytes_written).toBeLessThan(state.backpressureBytes);
      expectNoLeak(row, ['backpressure', 'yyyy']);
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }
  });

  it('ends a stalled downstream write on the total and idle deadlines', async () => {
    async function paused(content: string): Promise<{ status: number; raw: string; elapsed: number }> {
      const started = Date.now();
      const payload = JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content }],
        stream: true,
      });
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: state.port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'x-tenant-id': state.tenantId,
              authorization: `Bearer ${state.secret}`,
            },
          },
          (res) => {
            res.pause();
            void waitForStatus(state.tenantId, 'timed_out')
              .then(() => {
                const parts: Buffer[] = [];
                res.resume();
                res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
                res.on('end', () =>
                  resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8'), elapsed: Date.now() - started }),
                );
              })
              .catch(reject);
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'stream-chat',
      totalTimeoutMs: 500,
      backpressureTimeoutMs: 3_000,
    });
    try {
      const before = hits.length;
      const total = await paused('stall-write');
      expect(total.status).toBe(200);
      expect(total.raw).not.toContain('[DONE]');
      expect(total.elapsed).toBeLessThan(2_000);
      expect(hits).toHaveLength(before + 1);
      expect(state.aborted.has('stall-write')).toBe(true);
      const row = await latestAttempt(state.tenantId);
      expect(row?.stream_status).toBe('timed_out');
      expect(row?.attempt_status).toBe('failed');
      expect(row?.error_code).toBe('timeout');
      expect(row?.duration_ms).toBeLessThan(2_000);
      expect(row?.bytes_written).toBeGreaterThan(0);
      expectNoLeak(row, ['stall-write']);
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }

    state.aborted.delete('stall-write');
    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'stream-chat',
      idleTimeoutMs: 500,
      backpressureTimeoutMs: 3_000,
    });
    try {
      const before = hits.length;
      const idle = await paused('stall-write');
      expect(idle.status).toBe(200);
      expect(idle.raw).not.toContain('[DONE]');
      expect(idle.elapsed).toBeLessThan(2_000);
      expect(hits).toHaveLength(before + 1);
      expect(state.aborted.has('stall-write')).toBe(true);
      const row = await latestAttempt(state.tenantId);
      expect(row?.stream_status).toBe('timed_out');
      expect(row?.error_code).toBe('timeout');
      expect(row?.duration_ms).toBeLessThan(2_000);
      expect(row?.bytes_written).toBeGreaterThan(0);
      expectNoLeak(row, ['stall-write']);
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }
  });

  it('returns a normal HTTP error when the provider fails before the first event', async () => {
    const before = hits.length;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': state.tenantId,
        authorization: `Bearer ${state.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'error-before', { stream: true }),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('upstream_error');
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('[DONE]');
    expect(hits).toHaveLength(before + 1);
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBe('provider_failed');
    expect(row?.attempt_status).toBe('failed');
    expectNoLeak(row, [SECRET, 'error-before']);
  });

  it('keeps the HTTP status and omits done when the provider fails after partial output', async () => {
    const before = hits.length;
    const body = await postRaw('error-after');
    expect(body.status).toBe(200);
    expect(body.type).toContain('text/event-stream');
    expect(body.raw).not.toContain('[DONE]');
    expect(body.raw).not.toContain(SECRET);
    expect(hits).toHaveLength(before + 1);
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBe('provider_failed');
    expect(row?.attempt_status).toBe('failed');
    expect(row?.bytes_written).toBeGreaterThan(0);
    expectNoLeak(row, [SECRET, 'error-after', DELTA_A]);
  });

  it('does not complete a stream that never sends done', async () => {
    const body = await postRaw('missing-done');
    expect(body.status).toBe(200);
    expect(sseEvents(body.raw).filter((event) => event === '[DONE]')).toHaveLength(0);
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBe('stream_truncated');
    expect(row?.attempt_status).toBe('failed');
    expect(row?.error_code).toBe('stream_truncated');
    expectNoLeak(row, ['missing-done', DELTA_A, DELTA_B]);
  });

  it('completes when the provider omits usage', async () => {
    const chunks = await readStream('missing-usage');
    expect(chunks.some((chunk) => chunk.usage !== undefined && chunk.usage !== null)).toBe(false);
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBe('completed');
    expect(row?.prompt_tokens).toBeNull();
    expect(row?.completion_tokens).toBeNull();
    expect(row?.total_tokens).toBeNull();
    expectNoLeak(row, ['missing-usage', DELTA_A]);
  });

  it('reassembles unicode split across upstream bytes', async () => {
    const chunks = await readStream('unicode-split');
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe(UNICODE);
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBe('completed');
    expectNoLeak(row, ['unicode-split', UNICODE]);
  });

  it('keeps parallel tenants on their own credentials', async () => {
    const before = hits.length;
    const [left, right] = await Promise.all([
      readStream('parallel-a', state.tenantId, state.secret),
      readStream('parallel-b', state.otherId, state.otherSecret),
    ]);
    expect(left[0]?.id).toBe('chatcmpl-fixture');
    expect(right[0]?.id).toBe('chatcmpl-fixture');
    expect(hits).toHaveLength(before + 2);
    const auths = hits.slice(before).map((hit) => hit.authorization).sort();
    expect(auths).toEqual([`Bearer ${state.apiKey}`, `Bearer ${state.otherKey}`].sort());
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    try {
      const visible = await withTenant(runtime, state.tenantId, (client) =>
        client.query('SELECT tenant_id FROM proxy_requests'),
      );
      expect(visible.rows.every((row) => row.tenant_id === state.tenantId)).toBe(true);
    } finally {
      await runtime.end();
    }
    expectNoLeak(await latestAttempt(state.tenantId), ['parallel-a', DELTA_A]);
    expectNoLeak(await latestAttempt(state.otherId), ['parallel-b', DELTA_A]);
  });

  it('does not call upstream when persistence fails before the stream', async () => {
    const before = hits.length;
    await admin.query('REVOKE INSERT ON proxy_requests FROM llm_runtime');
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('auto', 'db-fail', { stream: true }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('service_unavailable');
      expect(hits).toHaveLength(before);
    } finally {
      await admin.query('GRANT INSERT ON proxy_requests TO llm_runtime');
    }
  });

  it('does not retry when telemetry fails after bytes were sent', async () => {
    const before = hits.length;
    const pending = readStream('telemetry-gap');
    await waitForStatus(state.tenantId, 'streaming');
    await admin.query('REVOKE UPDATE ON model_attempts FROM llm_runtime');
    state.releaseTelemetry();
    try {
      const chunks = await pending;
      expect(chunks.length).toBeGreaterThan(0);
      expect(hits).toHaveLength(before + 1);
      const logs = lines.join('\n');
      expect(logs).toContain('attempt result was not recorded');
      expect(logs).toContain('"severity":"critical"');
      const row = await latestAttempt(state.tenantId);
      expect(row?.request_status).toBe('pending');
      expect(row?.stream_status).toBe('streaming');
      expectNoLeak(row, ['telemetry-gap', DELTA_A, DELTA_B]);
    } finally {
      await admin.query(ATTEMPT_GRANT);
    }
  });

  it('ends the stream on connect, idle, and total timeouts', async () => {
    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'stream-chat',
      connectTimeoutMs: 300,
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 10_000,
    });
    try {
      const connect = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('auto', 'timeout-connect', { stream: true }),
      });
      expect(connect.statusCode).toBe(504);
      expect(connect.json().error.code).toBe('timeout');
      expect(connect.body).not.toContain('[DONE]');
      expect((await latestAttempt(state.tenantId))?.stream_status).toBe('timed_out');
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }

    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'stream-chat',
      connectTimeoutMs: 10_000,
      idleTimeoutMs: 300,
      totalTimeoutMs: 10_000,
    });
    try {
      const idle = await postRaw('timeout-idle');
      expect(idle.status).toBe(200);
      expect(idle.raw).not.toContain('[DONE]');
      const row = await latestAttempt(state.tenantId);
      expect(row?.stream_status).toBe('timed_out');
      expect(row?.error_code).toBe('timeout');
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }

    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'stream-chat',
      connectTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 400,
    });
    try {
      const total = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('auto', 'timeout-total', { stream: true }),
      });
      expect(total.statusCode).toBe(504);
      expect(total.json().error.code).toBe('timeout');
      expect((await latestAttempt(state.tenantId))?.stream_status).toBe('timed_out');
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'stream-chat' });
    }
  });

  it('shows connecting and rejects one more stream at the active limit', async () => {
    const limited = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: state.baseUrl,
      credentialKey,
      maxActiveStreams: 1,
    });
    const port = await freePort();
    await limited.app.listen({ host: '127.0.0.1', port });
    try {
      const payload = JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'capacity-hold' }],
        stream: true,
      });
      const first = new Promise<{ status: number; raw: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'x-tenant-id': state.tenantId,
              authorization: `Bearer ${state.secret}`,
            },
          },
          (res) => {
            const parts: Buffer[] = [];
            res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      await waitForStatus(state.tenantId, 'connecting');
      const second = await limited.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('auto', 'capacity-second', { stream: true }),
      });
      expect(second.statusCode).toBe(503);
      expect(second.json().error.code).toBe('stream_capacity');
      expect(second.headers['content-type']).not.toContain('text/event-stream');
      const held = await latestAttempt(state.tenantId);
      expect(held?.stream_status).toBe('connecting');
      const finished = await first;
      expect(finished.status).toBe(200);
      expect(sseEvents(finished.raw).filter((event) => event === '[DONE]')).toHaveLength(1);
      expect((await latestAttempt(state.tenantId))?.stream_status).toBe('completed');
    } finally {
      await limited.app.close();
      await limited.authPool.end();
      await limited.runtimePool.end();
    }
  });
});
