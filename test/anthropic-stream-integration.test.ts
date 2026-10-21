import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { loadCatalog } from '../src/inference/store.js';
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

const ANTHROPIC_MODEL = 'claude-permitted';
const OPENAI_MODEL = 'gpt-stream-actual';
const OPENAI_KEY = 'sk-test-stream-openai';
const ANTHROPIC_KEY = 'sk-ant-tenant-a';
const OTHER_KEY = 'sk-ant-tenant-b';

const FILES: Record<string, string> = {
  'scene-normal': 'normal.sse',
  'scene-blocks': 'blocks.sse',
  'scene-empty': 'empty.sse',
  'scene-ping': 'ping.sse',
  'scene-usage': 'usage.sse',
  'scene-length': 'max-tokens.sse',
  'scene-refusal': 'refusal.sse',
  'scene-thinking': 'thinking.sse',
  'scene-tool': 'tool-use.sse',
  'scene-error': 'error.sse',
  'scene-open': 'missing-stop.sse',
  'scene-bad': 'malformed.sse',
  'scene-fallback': 'fallback.sse',
  'scene-model': 'wrong-model.sse',
  'scene-sdk': 'blocks.sse',
  'scene-cancel': 'cancel-prefix.sse',
  'scene-slow': 'slow-prefix.sse',
};

function fixture(name: string, model: string): string {
  const file = FILES[name];
  if (file === undefined) throw new Error(`missing fixture ${name}`);
  const raw = readFileSync(join(projectRoot, 'test/fixtures/anthropic-stream', file), 'utf8').replaceAll('__MODEL__', model);
  return raw.endsWith('\n\n') ? raw : `${raw.replace(/\n*$/, '')}\n\n`;
}

function contentOf(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
  return String(parsed.messages?.[0]?.content ?? '');
}

function sseData(raw: string): string[] {
  return raw
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
}

function textFromSse(raw: string): string {
  let text = '';
  for (const data of sseData(raw)) {
    if (data === '[DONE]') continue;
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
    text += chunk.choices?.[0]?.delta?.content ?? '';
  }
  return text;
}

describe('Anthropic streaming', () => {
  const db = loadTestDatabase();
  const state: {
    port: number;
    tenantId: string;
    secret: string;
    otherId: string;
    otherSecret: string;
    version: string;
    aborted: Set<string>;
    upstreamBytes: number;
  } = {
    port: 0,
    tenantId: '',
    secret: '',
    otherId: '',
    otherSecret: '',
    version: '',
    aborted: new Set(),
    upstreamBytes: 0,
  };
  let hits: AnthropicHit[] = [];
  let openaiHits: MockHit[] = [];
  let lines: string[] = [];
  let admin: ReturnType<typeof adminPool>;
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  const closers: Array<() => Promise<void>> = [];

  function markAbort(content: string, request: IncomingMessage, response: ServerResponse): void {
    const note = (): void => {
      if (!response.writableEnded) state.aborted.add(content);
    };
    request.on('aborted', note);
    request.socket?.on('close', note);
  }

  beforeAll(async () => {
    const anthropic = await startMockAnthropic((hit, request, response) => {
      state.version = String(request.headers['anthropic-version'] ?? '');
      const parsed = JSON.parse(hit.body) as { stream?: boolean; model?: string };
      const scene = contentOf(hit.body);
      if (parsed.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'msg_json', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      if (scene === 'scene-http') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (scene === 'scene-cancel') {
        markAbort(scene, request, response);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(fixture(scene, parsed.model ?? ANTHROPIC_MODEL));
        return;
      }
      if (scene === 'scene-slow') {
        markAbort(scene, request, response);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const prefix = fixture(scene, parsed.model ?? ANTHROPIC_MODEL);
        state.upstreamBytes += Buffer.byteLength(prefix);
        response.write(prefix);
        const big = 'y'.repeat(256 * 1024);
        let writes = 0;
        const pump = (): void => {
          if (response.writableEnded || response.destroyed || request.aborted || request.socket?.destroyed === true) return;
          if (writes >= 24) return;
          const frame = `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: big },
          })}\n\n`;
          writes += 1;
          state.upstreamBytes += Buffer.byteLength(frame);
          response.write(frame);
          setImmediate(pump);
        };
        setImmediate(pump);
        return;
      }
      const file = FILES[scene];
      if (file === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(fixture(scene, parsed.model ?? ANTHROPIC_MODEL));
    });
    const openai = await startMockUpstream((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as { stream?: boolean; model?: string };
      if (parsed.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(parsed.model ?? OPENAI_MODEL, 'ok')));
        return;
      }
      const raw = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8').replaceAll('__MODEL__', OPENAI_MODEL);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(raw.endsWith('\n\n') ? raw : `${raw}\n\n`);
    });
    hits = anthropic.hits;
    openaiHits = openai.hits;
    const enabled = provisionTenant(db, 'Anthropic Stream A');
    const other = provisionTenant(db, 'Anthropic Stream B');
    state.tenantId = enabled.tenantId;
    state.secret = enabled.secret;
    state.otherId = other.tenantId;
    state.otherSecret = other.secret;
    registerInference(db, {
      tenantId: enabled.tenantId,
      apiKey: OPENAI_KEY,
      deployment: 'gpt-chat',
      upstreamModel: OPENAI_MODEL,
      timeoutMs: 10_000,
    });
    registerAnthropic(db, {
      tenantId: enabled.tenantId,
      apiKey: ANTHROPIC_KEY,
      endpoint: anthropic.origin,
      deployment: 'claude-chat',
      upstreamModel: ANTHROPIC_MODEL,
      timeoutMs: 10_000,
      workspaceId: 'ws-enabled',
    });
    registerAnthropic(db, {
      tenantId: other.tenantId,
      apiKey: OTHER_KEY,
      endpoint: anthropic.origin,
      deployment: 'claude-b',
      upstreamModel: 'claude-other-model',
      timeoutMs: 10_000,
    });
    enableStreaming(db, { tenantId: enabled.tenantId, deployment: 'gpt-chat' });
    enableStreaming(db, { tenantId: enabled.tenantId, deployment: 'claude-chat' });
    enableStreaming(db, { tenantId: other.tenantId, deployment: 'claude-b' });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
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
      await anthropic.close();
      await openai.close();
    });
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

  async function readSdk(model: string, secret = state.secret, tenantId = state.tenantId) {
    const stream = await clientFor(secret, tenantId).chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'scene-sdk' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let finish: string | null = null;
    const models = new Set<string>();
    for await (const chunk of stream) {
      models.add(chunk.model);
      text += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    }
    return { text, finish, models };
  }

  function postRaw(
    content: string,
    extra: Record<string, unknown> = {},
    auth: { tenantId: string; secret: string } = { tenantId: state.tenantId, secret: state.secret },
    signal?: AbortSignal,
  ): Promise<{ status: number; type: string; raw: string }> {
    const payload = JSON.stringify({
      model: 'claude-chat',
      messages: [{ role: 'user', content }],
      stream: true,
      stream_options: { include_usage: true },
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
            'x-tenant-id': auth.tenantId,
            authorization: `Bearer ${auth.secret}`,
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
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      uncached_input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
      error_code: string | null;
      stop_reason: string | null;
      provider_request_id: string | null;
      bytes_written: number | null;
      chunk_count: number | null;
      attempt_json: unknown;
      request_json: unknown;
    }>(
      `SELECT c.provider, d.name AS deployment_name, a.upstream_model, a.stream_status,
              a.status AS attempt_status, a.prompt_tokens, a.completion_tokens, a.total_tokens,
              a.uncached_input_tokens, a.cache_creation_input_tokens, a.cache_read_input_tokens,
              a.error_code, a.stop_reason, a.provider_request_id, a.bytes_written, a.chunk_count,
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
    expect(logs).not.toContain(ANTHROPIC_KEY);
    expect(logs).not.toContain(OTHER_KEY);
    expect(logs).not.toContain(OPENAI_KEY);
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
    throw new Error(`stream status ${status} was not stored; latest=${row?.stream_status ?? 'none'}`);
  }

  it('streams Anthropic and OpenAI through the same caller', async () => {
    const beforeAnthropic = hits.length;
    const beforeOpenAi = openaiHits.length;
    const openai = await readSdk('gpt-chat');
    const first = await readSdk('claude-chat');
    const second = await readSdk('claude-chat');
    expect(openai.text).toContain('stream-delta-alpha');
    expect(openai.text.indexOf('stream-delta-beta')).toBeGreaterThan(openai.text.indexOf('stream-delta-alpha'));
    expect(openai.finish).toBe('stop');
    expect(openai.models).toEqual(new Set([OPENAI_MODEL]));
    expect(first.text).toBe('alpha-blockbeta-block');
    expect(first.finish).toBe('stop');
    expect(first.models).toEqual(new Set([ANTHROPIC_MODEL]));
    expect(second.text).toBe(first.text);
    expect(second.finish).toBe(first.finish);
    console.log(JSON.stringify({
      openaiContentPresent: openai.text.length > 0,
      openaiOrderHeld: openai.text.indexOf('stream-delta-beta') > openai.text.indexOf('stream-delta-alpha'),
      openaiFinish: openai.finish,
      anthropicContentPresent: first.text.length > 0,
      anthropicFinish: first.finish,
      secondMatchesFirst: second.text === first.text && second.finish === first.finish,
      anthropicModel: [...first.models][0],
      openaiModel: [...openai.models][0],
    }));
    expect(hits).toHaveLength(beforeAnthropic + 2);
    expect(openaiHits).toHaveLength(beforeOpenAi + 1);
    expect(hits.at(-1)?.apiKey).toBe(ANTHROPIC_KEY);
    expect(hits.at(-1)?.workspaceId).toBe('ws-enabled');
    expect(hits.at(-1)?.url).toBe('/v1/messages');
    expect(state.version).toBe('2023-06-01');
    const upstream = JSON.parse(hits.at(-1)?.body ?? '{}') as { stream?: boolean; model?: string; max_tokens?: number };
    expect(upstream.stream).toBe(true);
    expect(upstream.model).toBe(ANTHROPIC_MODEL);
    expect(upstream.max_tokens).toBe(64);
    expect(hits.filter((hit) => hit.apiKey === OTHER_KEY)).toHaveLength(0);
    const row = await latestAttempt(state.tenantId);
    expect(row?.provider).toBe('anthropic');
    expect(row?.stream_status).toBe('completed');
    expect(row?.attempt_status).toBe('succeeded');
    expect(row?.stop_reason).toBe('end_turn');
    expect(row?.upstream_model).toBe(ANTHROPIC_MODEL);
    expectNoLeak(row, ['scene-sdk', 'alpha-block', 'beta-block']);
  });

  it('keeps cumulative usage and cache categories on the attempt', async () => {
    const before = hits.length;
    const body = await postRaw('scene-usage');
    expect(body.status).toBe(200);
    expect(body.type).toContain('text/event-stream');
    expect(textFromSse(body.raw)).toBe('alpha-block');
    expect(sseData(body.raw).filter((line) => line === '[DONE]')).toHaveLength(1);
    expect(body.raw).not.toContain('cache_creation_input_tokens');
    expect(body.raw).toContain('"prompt_tokens":15');
    expect(body.raw).toContain('"completion_tokens":15');
    expect(body.raw).toContain('"total_tokens":30');
    expect(hits).toHaveLength(before + 1);
    const row = await latestAttempt(state.tenantId);
    expect(row?.stream_status).toBe('completed');
    expect(row?.prompt_tokens).toBe(15);
    expect(row?.completion_tokens).toBe(15);
    expect(row?.total_tokens).toBe(30);
    expect(row?.uncached_input_tokens).toBe(10);
    expect(row?.cache_creation_input_tokens).toBe(2);
    expect(row?.cache_read_input_tokens).toBe(3);
    expect(row?.provider_request_id).toBe('msg_usage');
    expect(row?.stop_reason).toBe('end_turn');
    expectNoLeak(row, ['scene-usage', 'alpha-block']);
  });

  it('maps length and refusal and omits ping and thinking text', async () => {
    const length = await postRaw('scene-length');
    expect(textFromSse(length.raw)).toBe('alpha-block');
    expect(length.raw).toContain('"finish_reason":"length"');
    expect(sseData(length.raw).filter((line) => line === '[DONE]')).toHaveLength(1);
    const lengthRow = await latestAttempt(state.tenantId);
    expect(lengthRow?.stop_reason).toBe('max_tokens');
    expect(lengthRow?.stream_status).toBe('completed');

    const refusal = await postRaw('scene-refusal');
    expect(refusal.raw).toContain('"finish_reason":"content_filter"');
    const refusalRow = await latestAttempt(state.tenantId);
    expect(refusalRow?.stop_reason).toBe('refusal');

    const empty = await postRaw('scene-empty');
    expect(textFromSse(empty.raw)).toBe('');
    expect(empty.raw).not.toContain('"content":""');
    expect(sseData(empty.raw).filter((line) => line === '[DONE]')).toHaveLength(1);
    const emptyRow = await latestAttempt(state.tenantId);
    expect(emptyRow?.stream_status).toBe('completed');

    const ping = await postRaw('scene-ping');
    expect(textFromSse(ping.raw)).toBe('alpha-block');
    expect(ping.raw).not.toContain('ping-marker-text');

    const thinking = await postRaw('scene-thinking');
    expect(textFromSse(thinking.raw)).toBe('alpha-block');
    expect(thinking.raw).not.toContain('hidden-thought-marker');
    expect(thinking.raw).not.toContain('hidden-signature-marker');
    expect(thinking.raw).not.toContain('redacted-secret-marker');
    expect(sseData(thinking.raw).filter((line) => line === '[DONE]')).toHaveLength(1);
  });

  it('fails tool use, fallback, a foreign model, malformed input, a missing stop, and an in-stream error', async () => {
    const before = hits.length;
    const tool = await postRaw('scene-tool');
    expect(tool.status).toBe(200);
    expect(tool.raw).not.toContain('[DONE]');
    expect(tool.raw).not.toContain('tool_calls');
    expect(tool.raw).not.toContain('input_json_delta');
    const toolRow = await latestAttempt(state.tenantId);
    expect(toolRow?.stream_status).toBe('provider_failed');
    expect(toolRow?.attempt_status).toBe('failed');
    expect(toolRow?.error_code).toBe('invalid_upstream_response');

    const fallback = await postRaw('scene-fallback');
    expect(fallback.status).toBe(200);
    expect(fallback.raw).not.toContain('[DONE]');
    expect(fallback.raw).not.toContain('claude-other');
    const fallbackRow = await latestAttempt(state.tenantId);
    expect(fallbackRow?.stream_status).toBe('provider_failed');
    expect(fallbackRow?.error_code).toBe('invalid_upstream_response');

    const wrong = await postRaw('scene-model');
    expect(wrong.status).toBe(502);
    expect(wrong.raw).not.toContain('[DONE]');
    expect(wrong.raw).toContain('invalid_upstream_response');
    const wrongRow = await latestAttempt(state.tenantId);
    expect(wrongRow?.stream_status).toBe('provider_failed');
    expect(wrongRow?.error_code).toBe('invalid_upstream_response');

    const malformed = await postRaw('scene-bad');
    expect(malformed.status).toBe(200);
    expect(malformed.raw).not.toContain('[DONE]');
    const malformedRow = await latestAttempt(state.tenantId);
    expect(malformedRow?.stream_status).toBe('provider_failed');
    expect(malformedRow?.error_code).toBe('invalid_upstream_response');

    const open = await postRaw('scene-open');
    expect(open.status).toBe(200);
    expect(textFromSse(open.raw)).toBe('alpha-block');
    expect(open.raw).not.toContain('[DONE]');
    const openRow = await latestAttempt(state.tenantId);
    expect(openRow?.stream_status).toBe('stream_truncated');
    expect(openRow?.error_code).toBe('stream_truncated');

    const failure = await postRaw('scene-error');
    expect(failure.status).toBe(200);
    expect(failure.raw).not.toContain('[DONE]');
    const failureRow = await latestAttempt(state.tenantId);
    expect(failureRow?.stream_status).toBe('provider_failed');
    expect(failureRow?.error_code).toBe('overloaded');

    const httpError = await postRaw('scene-http');
    expect(httpError.status).toBe(502);
    expect(httpError.raw).toContain('upstream_error');
    expect(hits).toHaveLength(before + 7);
  });

  it('keeps a tenant off another tenant configuration and credential', async () => {
    const before = hits.length;
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    try {
      const names = await withTenant(runtime, state.otherId, async (client) => {
        const catalog = await loadCatalog(client);
        return catalog.deployments.map((deployment) => deployment.name);
      });
      expect(names).toEqual(['claude-b']);
      expect(names).not.toContain('claude-chat');
    } finally {
      await runtime.end();
    }
    const missing = await postRaw('scene-normal', { model: 'claude-chat' }, { tenantId: state.otherId, secret: state.otherSecret });
    expect(missing.status).toBe(404);
    const crossed = await postRaw('scene-normal', {}, { tenantId: state.tenantId, secret: state.otherSecret });
    expect(crossed.status).toBe(401);
    expect(hits).toHaveLength(before);
    const own = await postRaw('scene-normal', { model: 'claude-b' }, { tenantId: state.otherId, secret: state.otherSecret });
    expect(own.status).toBe(200);
    expect(textFromSse(own.raw)).toBe('alpha-block');
    expect(hits).toHaveLength(before + 1);
    expect(hits.at(-1)?.apiKey).toBe(OTHER_KEY);
    expect(hits.at(-1)?.apiKey).not.toBe(ANTHROPIC_KEY);
    const listed = runCli(db, ['list-inference', '--tenant-id', state.otherId]);
    expect(JSON.stringify(listed)).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(listed)).not.toContain('claude-chat');
    expect(JSON.stringify(listed)).not.toContain(state.secret);
  });

  it('makes no upstream call when either streaming flag is off', async () => {
    const before = hits.length;
    runCli(db, ['set-tenant-streaming', '--tenant-id', state.tenantId, '--enabled', 'false'], cliEnv());
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('claude-chat', 'scene-normal', { stream: true }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('unsupported_parameter');
      expect(response.json().error.param).toBe('stream');
      expect(hits).toHaveLength(before);
    } finally {
      runCli(db, ['set-tenant-streaming', '--tenant-id', state.tenantId, '--enabled', 'true'], cliEnv());
    }
    runCli(
      db,
      ['set-deployment-streaming', '--tenant-id', state.tenantId, '--deployment', 'claude-chat', '--enabled', 'false'],
      cliEnv(),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-tenant-id': state.tenantId,
          authorization: `Bearer ${state.secret}`,
          'content-type': 'application/json',
        },
        payload: chatPayload('claude-chat', 'scene-normal', { stream: true }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.param).toBe('stream');
      expect(hits).toHaveLength(before);
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'claude-chat' });
    }
  });

  it('records client cancellation and a slow downstream consumer', async () => {
    const before = hits.length;
    const controller = new AbortController();
    const pending = postRaw('scene-cancel', {}, { tenantId: state.tenantId, secret: state.secret }, controller.signal);
    const started = Date.now();
    while (!state.aborted.has('scene-cancel') && Date.now() - started < 4_000) {
      const row = await latestAttempt(state.tenantId);
      if (row?.stream_status === 'streaming' || row?.stream_status === 'connecting') break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitForStatus(state.tenantId, 'client_aborted');
    const cancelled = await latestAttempt(state.tenantId);
    expect(cancelled?.attempt_status).toBe('failed');
    expect(cancelled?.error_code).toBe('request_cancelled');
    expect(hits).toHaveLength(before + 1);
    const abortStarted = Date.now();
    while (!state.aborted.has('scene-cancel') && Date.now() - abortStarted < 4_000) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(state.aborted.has('scene-cancel')).toBe(true);
    expectNoLeak(cancelled, ['scene-cancel', 'alpha-block']);

    state.upstreamBytes = 0;
    enableStreaming(db, {
      tenantId: state.tenantId,
      deployment: 'claude-chat',
      backpressureTimeoutMs: 300,
    });
    try {
      const slowBefore = hits.length;
      const body = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
        const payload = JSON.stringify({
          model: 'claude-chat',
          messages: [{ role: 'user', content: 'scene-slow' }],
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
      expect(body.status).toBe(200);
      expect(body.raw).not.toContain('[DONE]');
      expect(hits).toHaveLength(slowBefore + 1);
      expect(state.aborted.has('scene-slow')).toBe(true);
      const row = await latestAttempt(state.tenantId);
      expect(row?.stream_status).toBe('slow_consumer');
      expect(row?.error_code).toBe('slow_consumer');
      expect(row?.bytes_written).toBeGreaterThan(0);
      expect(row?.bytes_written).toBeLessThan(state.upstreamBytes);
      expectNoLeak(row, ['scene-slow']);
    } finally {
      enableStreaming(db, { tenantId: state.tenantId, deployment: 'claude-chat' });
    }
  });
});
