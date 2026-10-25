import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createSampleKeyManager, decryptSample, CAPTURE_BYTE_CEILING } from '../src/inference/sample-crypto.js';
import { ELIGIBILITY_CHECKS } from '../src/inference/sample-eligibility.js';
import { appendVisibleDelta, createVisibleCapture, visibleCaptureText } from '../src/inference/stream-capture.js';
import type { VertexGenerateClient, VertexGenerateRequest } from '../src/inference/vertex-client.js';
import { createTestApp, freePort, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import {
  adminPool,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockAnthropic, type AnthropicHit } from './mock-anthropic.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const JOURNEY_PROMPT = 'stream-sample-prompt-zeta-06d';
const JOURNEY_VISIBLE = 'stream-sample-visible-zeta-06d';
const NONSTREAM = 'stream-sample-nonstream-zeta-06d';
const EVIDENCE = process.env.SLICE_06D_EVIDENCE;
const VERTEX_KEY = JSON.stringify({
  client_email: 'stream-bot@stream-vertex-proj.iam.gserviceaccount.com',
  private_key: `stream-${'k'.repeat(80)}`,
});
const FORBIDDEN = [
  JOURNEY_PROMPT,
  JOURNEY_VISIBLE,
  NONSTREAM,
  'stream-delta-alpha',
  'alpha-block',
  'hidden-thought-marker',
  'hidden-signature-marker',
  'redacted-secret-marker',
  'toolu_1',
  'input_json_delta',
];

type Tenant = { tenantId: string; secret: string };
type Report = {
  eligible: boolean;
  reasons: string[];
  checks: Array<{ check: string; result: string; reason: string }>;
  policyVersion: number;
};
type AttemptRow = {
  request_id: string;
  request_status: string;
  attempt_status: string;
  stream_status: string;
  error_code: string | null;
  attempts: number;
};

const streamNotes: string[] = [];
const eligibilityNotes: string[] = [];
const isolationNotes: string[] = [];
const journeyNotes: string[] = [];
const memoryNotes: string[] = [];
const sdkNotes: string[] = [];
const rollbackNotes: string[] = [];
const holds = new Map<string, () => void>();

function safe(text: string): string {
  for (const marker of FORBIDDEN) {
    if (text.includes(marker)) throw new Error('evidence contains sample text');
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function contentOf(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
  const content = parsed.messages?.[0]?.content;
  return typeof content === 'string' ? content : '';
}

function textOf(request: VertexGenerateRequest): string {
  return request.contents.map((content) => content.parts.map((part) => part.text).join('')).join('\n');
}

function frame(model: string, choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices: [choice],
  })}\n\n`;
}

function openaiFrames(model: string, deltas: string[], finish = true): string {
  const parts = [frame(model, { index: 0, delta: { role: 'assistant' }, finish_reason: null })];
  for (const delta of deltas) {
    parts.push(frame(model, { index: 0, delta: { content: delta }, finish_reason: null }));
  }
  if (finish) {
    parts.push(frame(model, { index: 0, delta: {}, finish_reason: 'stop' }));
    parts.push('data: [DONE]\n\n');
  }
  return parts.join('');
}

function anthropicFixture(name: string, model: string): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/anthropic-stream', name), 'utf8').replaceAll('__MODEL__', model);
  return raw.endsWith('\n\n') ? raw : `${raw.replace(/\n*$/, '')}\n\n`;
}

function deltasOf(raw: string): string[] {
  const deltas: string[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]' || data.length === 0) continue;
      const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === 'string') deltas.push(text);
    }
  }
  return deltas;
}

function withoutCreated(raw: string): string {
  return raw.replace(/"created":\d+/g, '"created":0');
}

function vertexStream(parts: Array<{ text?: string; thought?: boolean }>, finish: string | null): AsyncGenerator<Record<string, unknown>> {
  return (async function* stream() {
    yield {
      responseId: 'resp-stream',
      modelVersion: 'gemini-2.5-flash',
      candidates: [{ content: { parts: parts.map((part) => ({ ...part })) } }],
    };
    if (finish !== null) {
      yield {
        candidates: [{ finishReason: finish, content: { parts: [{ text: '' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      };
    }
  })();
}

describe('streaming samples and replay eligibility', () => {
  const db = loadTestDatabase();
  const vertexCalls: string[] = [];
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let anthropic: Awaited<ReturnType<typeof startMockAnthropic>>;
  let openaiHits: MockHit[] = [];
  let anthropicHits: AnthropicHit[] = [];
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: ReturnType<typeof adminPool>;
  let port = 0;
  const tenant: Tenant = { tenantId: '', secret: '' };
  const other: Tenant = { tenantId: '', secret: '' };

  function headers(caller: Tenant): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-tenant-id': caller.tenantId,
      authorization: `Bearer ${caller.secret}`,
    };
  }

  function arm(options: {
    streaming?: boolean;
    replay?: boolean;
    retention?: number;
    bytes?: number;
    providers?: string;
    deployments?: string;
    mode?: string;
    content?: boolean;
  } = {}): void {
    runCli(db, [
      'set-sample-policy',
      '--tenant-id',
      tenant.tenantId,
      '--mode',
      options.mode ?? 'encrypted_sample',
      '--content-capture',
      options.content === false ? 'false' : 'true',
      '--streaming-capture',
      options.streaming === false ? 'false' : 'true',
      '--replay',
      options.replay === false ? 'false' : 'true',
      '--judge-disclosure',
      'false',
      '--sample-rate',
      '1',
      '--max-sample-bytes',
      String(options.bytes ?? 1_000_000),
      '--max-sample-count',
      '100',
      '--retention-seconds',
      String(options.retention ?? 86_400),
      '--classifications',
      'internal',
      '--providers',
      options.providers ?? 'openai,anthropic,vertex',
      '--deployments',
      options.deployments ?? 'chat,claude-chat,gemini-us,gemini-bare',
    ], cliEnv());
  }

  async function postChat(model: string, content: string, extra: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: { model, messages: [{ role: 'user', content }], ...extra },
    });
  }

  function postRaw(
    model: string,
    content: string,
    options: { signal?: AbortSignal; onData?: () => void } = {},
  ): Promise<{ status: number; raw: string; requestId: string }> {
    const payload = JSON.stringify({ model, messages: [{ role: 'user', content }], stream: true });
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          signal: options.signal,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-tenant-id': tenant.tenantId,
            authorization: `Bearer ${tenant.secret}`,
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk) => {
            parts.push(Buffer.from(chunk));
            options.onData?.();
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              raw: Buffer.concat(parts).toString('utf8'),
              requestId: String(res.headers['x-request-id'] ?? ''),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async function sampleCount(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function samplesFor(requestId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1 AND request_id = $2',
      [tenant.tenantId, requestId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function attemptTotal(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM model_attempts WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function jobTotal(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM sample_jobs WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function versionOf(table: 'sample_policies' | 'fallback_policies'): Promise<number> {
    const result = await admin.query<{ version: number }>(
      `SELECT COALESCE(max(policy_version), 0)::int AS version FROM ${table} WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    return result.rows[0]?.version ?? 0;
  }

  async function executionCount(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM execution_policies WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function latestAttempt(): Promise<AttemptRow | undefined> {
    const result = await admin.query<AttemptRow>(
      `SELECT r.id::text AS request_id, r.status AS request_status, a.status AS attempt_status,
              a.stream_status, a.error_code,
              (SELECT count(*)::int FROM model_attempts m WHERE m.tenant_id = a.tenant_id AND m.request_id = a.request_id) AS attempts
       FROM model_attempts a
       JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [tenant.tenantId],
    );
    return result.rows[0];
  }

  async function waitForStatus(status: string): Promise<AttemptRow> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      const row = await latestAttempt();
      if (row?.stream_status === status) return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`stream status ${status} did not arrive`);
  }

  async function settled(requestId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      if (ctx.lines.some((line) => line.includes('stream sample capture finished') && line.includes(requestId))) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error('stream sample capture did not finish');
  }

  function requestIdOf(response: { headers: Record<string, string | string[] | undefined> | { 'x-request-id'?: string } }): string {
    const value = response.headers['x-request-id'];
    return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }

  async function openSample(requestId: string): Promise<{ id: string; text: string; stream: boolean; digest: string }> {
    const stored = await admin.query<{
      id: string;
      schema_version: number;
      wrapping_key_version: number;
      wrapped_key_iv: Buffer;
      wrapped_key_tag: Buffer;
      wrapped_key_ciphertext: Buffer;
      content_iv: Buffer;
      content_tag: Buffer;
      content_ciphertext: Buffer;
      digest: string;
    }>(
      `SELECT id::text, schema_version, wrapping_key_version,
              wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext,
              md5(content_ciphertext) AS digest
       FROM request_samples WHERE tenant_id = $1 AND request_id = $2`,
      [tenant.tenantId, requestId],
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();
    const opened = decryptSample(
      createSampleKeyManager(credentialKey),
      { tenantId: tenant.tenantId, sampleId: row?.id ?? '', schemaVersion: row?.schema_version ?? 0 },
      {
        schemaVersion: row?.schema_version ?? 0,
        wrappingKeyVersion: row?.wrapping_key_version ?? 0,
        wrappedKeyIv: row?.wrapped_key_iv ?? Buffer.alloc(0),
        wrappedKeyTag: row?.wrapped_key_tag ?? Buffer.alloc(0),
        wrappedKeyCiphertext: row?.wrapped_key_ciphertext ?? Buffer.alloc(0),
        contentIv: row?.content_iv ?? Buffer.alloc(0),
        contentTag: row?.content_tag ?? Buffer.alloc(0),
        contentCiphertext: row?.content_ciphertext ?? Buffer.alloc(0),
      },
    ) as { output: { choices: Array<{ content: string }> }; configuration: { stream: boolean } };
    return {
      id: row?.id ?? '',
      text: opened.output.choices.map((choice) => choice.content).join('\n'),
      stream: opened.configuration.stream,
      digest: row?.digest ?? '',
    };
  }

  async function digestOf(sampleId: string): Promise<string> {
    const result = await admin.query<{ digest: string }>(
      'SELECT md5(content_ciphertext) AS digest FROM request_samples WHERE id = $1',
      [sampleId],
    );
    return result.rows[0]?.digest ?? '';
  }

  function reportOf(body: string): Report {
    return JSON.parse(body) as Report;
  }

  async function eligibility(caller: Tenant, sampleId: string, deployment: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/samples/${sampleId}/eligibility-check`,
      headers: headers(caller),
      payload: { deployment },
    });
  }

  beforeAll(async () => {
    openai = await startMockUpstream((hit, request, response) => {
      const parsed = JSON.parse(hit.body) as { stream?: boolean; model?: string };
      const scene = contentOf(hit.body);
      const model = parsed.model ?? 'gpt-stream';
      if (parsed.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(model, NONSTREAM)));
        return;
      }
      if (scene === 'scene-fail') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream-failed', type: 'server_error' } }));
        return;
      }
      if (scene === 'scene-cancel') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(openaiFrames(model, ['cancel-delta'], false));
        const stop = (): void => {
          if (!response.writableEnded) response.end();
        };
        request.on('aborted', stop);
        request.socket?.on('close', stop);
        return;
      }
      if (scene === 'scene-slow') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(openaiFrames(model, ['x'], false));
        const big = 'y'.repeat(256 * 1024);
        let writes = 0;
        const pump = (): void => {
          if (response.writableEnded || response.destroyed || request.aborted || request.socket?.destroyed === true) return;
          if (writes >= 24) return;
          writes += 1;
          response.write(frame(model, { index: 0, delta: { content: big }, finish_reason: null }));
          setImmediate(pump);
        };
        setImmediate(pump);
        return;
      }
      if (scene === 'scene-revoke') {
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        holds.set(scene, release);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(openaiFrames(model, ['revoke-one'], false));
        void gate.then(() => {
          if (response.writableEnded) return;
          response.end(`${frame(model, { index: 0, delta: { content: 'revoke-two' }, finish_reason: null })}${frame(model, { index: 0, delta: {}, finish_reason: 'stop' })}data: [DONE]\n\n`);
        });
        return;
      }
      if (scene === 'scene-oversize') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(openaiFrames(model, ['a'.repeat(600_000), 'b'.repeat(500_000)]));
        return;
      }
      if (scene === 'scene-empty') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(openaiFrames(model, []));
        return;
      }
      if (scene === 'scene-cut') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(openaiFrames(model, ['partial-cut'], false));
        return;
      }
      if (scene === 'scene-mark') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(openaiFrames(model, ['e', '\u0301']));
        return;
      }
      if (scene === 'scene-bytes') {
        const bytes = Buffer.from(openaiFrames(model, ['caf\u00e9']));
        const split = bytes.indexOf(0xc3);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(bytes.subarray(0, split + 1));
        setTimeout(() => {
          if (!response.writableEnded) response.end(bytes.subarray(split + 1));
        }, 20);
        return;
      }
      if (scene === 'scene-sdk' || scene === 'scene-openai') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(openaiFrames(model, ['left', ' right']));
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unknown scene' } }));
    });
    anthropic = await startMockAnthropic((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as { stream?: boolean; model?: string };
      const scene = contentOf(hit.body);
      const model = parsed.model ?? 'claude-stream';
      if (parsed.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'msg_json', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      const file = scene === 'scene-think' ? 'thinking.sse' : scene === 'scene-tool' ? 'tool-use.sse' : scene === 'scene-open' ? 'missing-stop.sse' : 'normal.sse';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(anthropicFixture(file, model));
    });
    openaiHits = openai.hits;
    anthropicHits = anthropic.hits;
    const created = provisionTenant(db, 'Stream Sample');
    const foreign = provisionTenant(db, 'Stream Sample Other');
    tenant.tenantId = created.tenantId;
    tenant.secret = created.secret;
    other.tenantId = foreign.tenantId;
    other.secret = foreign.secret;
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-stream-samples',
      deployment: 'chat',
      upstreamModel: 'gpt-stream',
      timeoutMs: 20_000,
    });
    runCli(db, ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'openai', '--name', 'other-chat', '--upstream-model', 'gpt-other', '--timeout-ms', '20000', '--capabilities', 'temperature', '--enabled', 'true'], cliEnv());
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-stream-samples',
      endpoint: anthropic.origin,
      deployment: 'claude-chat',
      upstreamModel: 'claude-stream',
      timeoutMs: 20_000,
      alias: false,
    });
    runCli(db, ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_KEY, '--project', 'stream-vertex-proj', '--location', 'us-central1', '--service-account', 'stream-bot@stream-vertex-proj.iam.gserviceaccount.com'], cliEnv());
    runCli(db, ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'vertex', '--name', 'gemini-us', '--upstream-model', 'gemini-2.5-flash', '--timeout-ms', '20000', '--capabilities', 'temperature,stop', '--enabled', 'true'], cliEnv());
    runCli(db, ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'vertex', '--name', 'gemini-bare', '--upstream-model', 'gemini-2.5-flash', '--timeout-ms', '20000', '--capabilities', 'stop', '--enabled', 'true'], cliEnv());
    for (const name of ['chat', 'claude-chat', 'gemini-us', 'gemini-bare']) {
      runCli(db, ['set-deployment-data-class', '--tenant-id', tenant.tenantId, '--deployment', name, '--data-class', 'internal'], cliEnv());
    }
    for (const name of ['chat', 'claude-chat', 'gemini-us']) {
      enableStreaming(db, { tenantId: tenant.tenantId, deployment: name });
    }
    const factory = async (): Promise<VertexGenerateClient> => ({
      async generateContent() {
        return {};
      },
      generateContentStream(request) {
        const text = textOf(request);
        vertexCalls.push('stream');
        if (text.includes(JOURNEY_PROMPT)) return vertexStream([{ text: JOURNEY_VISIBLE }], 'STOP');
        if (text.includes('scene-vertex-think')) {
          return vertexStream([{ thought: true, text: 'hidden-thought-marker' }, { text: 'visible-vertex' }], 'STOP');
        }
        if (text.includes('scene-vertex-empty')) return vertexStream([{ text: '' }], 'STOP');
        return (async function* success() {
          yield { responseId: 'resp-stream', modelVersion: 'gemini-2.5-flash', candidates: [{ content: { parts: [{ text: 'Hello' }] } }] };
          yield {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ' world' }] } }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          };
        })();
      },
      async listModels() {},
    });
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      vertexClientFactory: factory,
    });
    admin = adminPool(db);
    port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    streamNotes.push(
      'openai complete has two text deltas, finish stop, and done',
      'openai unicode splits a combining mark across two deltas',
      'openai unicode bytes split one character across writes',
      'openai empty has finish stop and done and no text',
      'openai missing terminal has text and no done',
      'openai provider failure is an upstream 500',
      'openai cancel aborts after the first frame',
      'openai slow consumer pauses the caller',
      'openai oversize sends two deltas above the byte ceiling',
      'openai revoke clears streaming capture after the first frame',
      'anthropic complete uses normal.sse',
      'anthropic thinking uses thinking.sse and stores visible text only',
      'anthropic tool uses tool-use.sse and stores no sample',
      'vertex complete sends two text parts and finish',
      'vertex thought omits the thought part',
    );
  }, 180_000);

  afterAll(async () => {
    if (EVIDENCE !== undefined && EVIDENCE.length > 0) {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, 'streams.txt'), safe([...streamNotes, ...sdkNotes, ...memoryNotes].join('\n')));
      writeFileSync(join(EVIDENCE, 'sdk.txt'), safe(sdkNotes.join('\n')));
      writeFileSync(join(EVIDENCE, 'memory.txt'), safe(memoryNotes.join('\n')));
      writeFileSync(join(EVIDENCE, 'eligibility.txt'), safe(eligibilityNotes.join('\n')));
      writeFileSync(join(EVIDENCE, 'tenant-isolation.txt'), safe(isolationNotes.join('\n')));
      writeFileSync(join(EVIDENCE, 'journey.txt'), safe(journeyNotes.join('\n')));
      writeFileSync(join(EVIDENCE, 'rollback.txt'), safe(rollbackNotes.join('\n')));
    }
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
    await anthropic.close();
  });

  it('discards the in-memory buffer at the byte ceiling', () => {
    const buffer = createVisibleCapture();
    appendVisibleDelta(buffer, 'a'.repeat(600_000));
    expect(buffer.discarded).toBe(false);
    expect(buffer.bytes).toBe(600_000);
    appendVisibleDelta(buffer, 'b'.repeat(CAPTURE_BYTE_CEILING));
    expect(buffer.discarded).toBe(true);
    expect(buffer.parts).toEqual([]);
    expect(visibleCaptureText(buffer)).toBeNull();
    memoryNotes.push('in-memory buffer discarded when the next delta crosses the ceiling');
  });

  it('stores no stream sample when streaming capture is off', async () => {
    arm({ streaming: false });
    const shown = runCli(db, ['show-sample-policy', '--tenant-id', tenant.tenantId], cliEnv()) as { streamingCapture?: boolean; contentCapture?: boolean };
    expect(shown.contentCapture).toBe(true);
    expect(shown.streamingCapture).toBe(false);
    const before = await sampleCount();
    const response = await postChat('chat', 'scene-openai', { stream: true });
    await settled(requestIdOf(response));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: [DONE]');
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.attempts).toBe(1);
    expect(await samplesFor(row?.request_id ?? '')).toBe(0);
    expect(await sampleCount()).toBe(before);
    streamNotes.push('capture off completed stream stored 0');
  });

  it('stores one encrypted OpenAI stream and keeps the SSE bytes', async () => {
    arm({ streaming: false });
    const off = await postChat('chat', 'scene-openai', { stream: true });
    await settled(requestIdOf(off));
    const before = await sampleCount();
    arm({ streaming: true });
    const on = await postChat('chat', 'scene-openai', { stream: true });
    await settled(requestIdOf(on));
    expect(on.statusCode).toBe(200);
    expect(on.body).toBe(off.body);
    expect(deltasOf(on.body)).toEqual(['left', ' right']);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.request_status).toBe('succeeded');
    expect(row?.attempts).toBe(1);
    expect(await sampleCount()).toBe(before + 1);
    const opened = await openSample(row?.request_id ?? '');
    expect(opened.stream).toBe(true);
    expect(opened.text).toBe(deltasOf(on.body).join(''));
    streamNotes.push('openai capture on stored 1 and the SSE bytes matched capture off');
  });

  it('stores Anthropic visible text in order', async () => {
    arm();
    const before = await sampleCount();
    const calls = anthropicHits.length;
    const response = await postChat('claude-chat', 'scene-anthropic', { stream: true });
    await settled(requestIdOf(response));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: [DONE]');
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.attempts).toBe(1);
    expect(anthropicHits).toHaveLength(calls + 1);
    expect(await sampleCount()).toBe(before + 1);
    const opened = await openSample(row?.request_id ?? '');
    expect(opened.stream).toBe(true);
    expect(opened.text).toBe(deltasOf(response.body).join(''));
    expect(deltasOf(response.body).length).toBeGreaterThan(0);
    streamNotes.push('anthropic capture on stored 1 and the text matched the forwarded deltas');
  });

  it('stores Vertex visible text in order', async () => {
    arm({ streaming: false });
    const off = await postChat('gemini-us', 'scene-vertex', { stream: true });
    await settled(requestIdOf(off));
    const before = await sampleCount();
    const calls = vertexCalls.length;
    arm();
    const on = await postChat('gemini-us', 'scene-vertex', { stream: true });
    await settled(requestIdOf(on));
    expect(on.statusCode).toBe(200);
    expect(withoutCreated(on.body)).toBe(withoutCreated(off.body));
    expect(deltasOf(on.body)).toEqual(['Hello', ' world']);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.attempts).toBe(1);
    expect(vertexCalls).toHaveLength(calls + 1);
    expect(await sampleCount()).toBe(before + 1);
    const opened = await openSample(row?.request_id ?? '');
    expect(opened.text).toBe(deltasOf(on.body).join(''));
    streamNotes.push('vertex capture on stored 1 and the SSE bytes matched capture off aside from the clock');
  });

  it('keeps Unicode fragments in order', async () => {
    arm();
    const marked = await postChat('chat', 'scene-mark', { stream: true });
    await settled(requestIdOf(marked));
    const markedRow = await latestAttempt();
    const markedSample = await openSample(markedRow?.request_id ?? '');
    expect(deltasOf(marked.body)).toEqual(['e', '\u0301']);
    expect(markedSample.text).toBe('e\u0301');
    const split = await postChat('chat', 'scene-bytes', { stream: true });
    await settled(requestIdOf(split));
    const splitRow = await latestAttempt();
    const splitSample = await openSample(splitRow?.request_id ?? '');
    expect(splitSample.text).toBe(deltasOf(split.body).join(''));
    expect(splitSample.text).toBe('caf\u00e9');
    streamNotes.push('unicode combining mark and split bytes stayed in order');
  });

  it('stores an empty completion', async () => {
    arm();
    const before = await sampleCount();
    const response = await postChat('chat', 'scene-empty', { stream: true });
    await settled(requestIdOf(response));
    expect(response.statusCode).toBe(200);
    expect(deltasOf(response.body)).toEqual([]);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(await sampleCount()).toBe(before + 1);
    const opened = await openSample(row?.request_id ?? '');
    expect(opened.text).toBe('');
    const vertex = await postChat('gemini-us', 'scene-vertex-empty', { stream: true });
    await settled(requestIdOf(vertex));
    const vertexRow = await latestAttempt();
    expect(vertex.statusCode).toBe(200);
    expect(vertexRow?.stream_status).toBe('completed');
    const vertexSample = await openSample(vertexRow?.request_id ?? '');
    expect(vertexSample.text).toBe(deltasOf(vertex.body).join(''));
    streamNotes.push('empty openai and vertex completions stored one sample each');
  });

  it('stores nothing when the terminal event is missing', async () => {
    arm();
    const before = await sampleCount();
    const openaiCut = await postChat('chat', 'scene-cut', { stream: true });
    expect(openaiCut.statusCode).toBe(200);
    expect(openaiCut.body).not.toContain('[DONE]');
    const openaiRow = await latestAttempt();
    expect(openaiRow?.stream_status).toBe('stream_truncated');
    expect(await samplesFor(openaiRow?.request_id ?? '')).toBe(0);
    const anthropicCut = await postChat('claude-chat', 'scene-open', { stream: true });
    expect(anthropicCut.body).not.toContain('[DONE]');
    const anthropicRow = await latestAttempt();
    expect(anthropicRow?.stream_status).not.toBe('completed');
    expect(await samplesFor(anthropicRow?.request_id ?? '')).toBe(0);
    expect(await sampleCount()).toBe(before);
    streamNotes.push('missing terminal stored 0');
  });

  it('stores nothing after a provider failure', async () => {
    arm();
    const before = await sampleCount();
    const calls = openaiHits.length;
    const response = await postChat('chat', 'scene-fail', { stream: true });
    expect(response.statusCode).toBe(502);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('provider_failed');
    expect(row?.attempt_status).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(openaiHits).toHaveLength(calls + 1);
    expect(await samplesFor(row?.request_id ?? '')).toBe(0);
    expect(await sampleCount()).toBe(before);
    streamNotes.push('provider failure stored 0 and added one attempt');
  });

  it('stores nothing when the client cancels', async () => {
    arm();
    const before = await sampleCount();
    const controller = new AbortController();
    const pending = postRaw('chat', 'scene-cancel', { signal: controller.signal });
    await waitForStatus('streaming');
    controller.abort();
    await expect(pending).rejects.toThrow();
    const row = await waitForStatus('client_aborted');
    expect(row.attempt_status).toBe('failed');
    expect(await samplesFor(row.request_id)).toBe(0);
    expect(await sampleCount()).toBe(before);
    streamNotes.push('client cancel stored 0');
  });

  it('stores nothing for a slow consumer', async () => {
    arm();
    const before = await sampleCount();
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'chat', backpressureTimeoutMs: 300 });
    try {
      const payload = JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'scene-slow' }], stream: true });
      const body = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'x-tenant-id': tenant.tenantId,
              authorization: `Bearer ${tenant.secret}`,
            },
          },
          (res) => {
            res.pause();
            void waitForStatus('slow_consumer')
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
      const row = await latestAttempt();
      expect(row?.stream_status).toBe('slow_consumer');
      expect(await samplesFor(row?.request_id ?? '')).toBe(0);
      expect(await sampleCount()).toBe(before);
      streamNotes.push('slow consumer stored 0');
    } finally {
      enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'chat' });
    }
  });

  it('discards an over-size buffer and stores nothing', async () => {
    arm();
    const before = await sampleCount();
    const response = await postChat('chat', 'scene-oversize', { stream: true });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: [DONE]');
    expect(Buffer.byteLength(response.body)).toBeGreaterThan(CAPTURE_BYTE_CEILING);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.request_status).toBe('succeeded');
    expect(await samplesFor(row?.request_id ?? '')).toBe(0);
    expect(await sampleCount()).toBe(before);
    streamNotes.push('over-size completed stream stored 0');
    memoryNotes.push('completed over-size stream forwarded the text and stored no sample');
  }, 60_000);

  it('stores nothing when capture is revoked mid-stream', async () => {
    arm();
    const before = await sampleCount();
    let released = false;
    const pending = postRaw('chat', 'scene-revoke', {
      onData: () => {
        if (released) return;
        released = true;
        try {
          arm({ streaming: false });
        } finally {
          holds.get('scene-revoke')?.();
        }
      },
    });
    const body = await pending;
    await settled(body.requestId);
    expect(body.status).toBe(200);
    expect(body.raw).toContain('data: [DONE]');
    expect(deltasOf(body.raw)).toEqual(['revoke-one', 'revoke-two']);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.request_status).toBe('succeeded');
    expect(await samplesFor(row?.request_id ?? '')).toBe(0);
    expect(await sampleCount()).toBe(before);
    streamNotes.push('mid-stream revocation stored 0 and the forwarded deltas stayed in order');
  });

  it('omits hidden thinking and does not store tool use', async () => {
    arm();
    const before = await sampleCount();
    const thinking = await postChat('claude-chat', 'scene-think', { stream: true });
    await settled(requestIdOf(thinking));
    expect(thinking.statusCode).toBe(200);
    expect(thinking.body).not.toContain('hidden-thought-marker');
    expect(thinking.body).not.toContain('hidden-signature-marker');
    expect(thinking.body).not.toContain('redacted-secret-marker');
    const thoughtRow = await latestAttempt();
    expect(thoughtRow?.stream_status).toBe('completed');
    const thought = await openSample(thoughtRow?.request_id ?? '');
    expect(thought.text).toBe(deltasOf(thinking.body).join(''));
    expect(thought.text).not.toContain('hidden-thought-marker');
    const vertex = await postChat('gemini-us', 'scene-vertex-think', { stream: true });
    await settled(requestIdOf(vertex));
    expect(vertex.body).not.toContain('hidden-thought-marker');
    const vertexRow = await latestAttempt();
    const vertexSample = await openSample(vertexRow?.request_id ?? '');
    expect(vertexSample.text).toBe(deltasOf(vertex.body).join(''));
    expect(vertexSample.text).not.toContain('hidden-thought-marker');
    const tool = await postChat('claude-chat', 'scene-tool', { stream: true });
    expect(tool.statusCode).toBe(200);
    expect(tool.raw ?? tool.body).not.toContain('[DONE]');
    expect(tool.body).not.toContain('input_json_delta');
    expect(tool.body).not.toContain('tool_calls');
    const toolRow = await latestAttempt();
    expect(toolRow?.stream_status).toBe('provider_failed');
    expect(await samplesFor(toolRow?.request_id ?? '')).toBe(0);
    expect(await sampleCount()).toBe(before + 2);
    streamNotes.push('thinking samples kept visible text only and the tool stream stored 0');
  });

  it('keeps a non-streaming sample when streaming capture is on', async () => {
    arm();
    const before = await sampleCount();
    const response = await postChat('chat', 'scene-nonstream');
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe(NONSTREAM);
    const requestId = String(response.headers['x-request-id']);
    const opened = await openSample(requestId);
    expect(opened.stream).toBe(false);
    expect(opened.text).toBe(NONSTREAM);
    expect(await sampleCount()).toBe(before + 1);
    streamNotes.push('non-stream capture still stored one sample with stream false');
  });

  it('matches the OpenAI SDK with capture on and off', async () => {
    const client = new OpenAI({
      apiKey: tenant.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 20_000,
      defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
    });
    async function read(): Promise<string> {
      const stream = await client.chat.completions.create({
        model: 'chat',
        messages: [{ role: 'user', content: 'scene-sdk' }],
        stream: true,
      });
      let text = '';
      for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
      return text;
    }
    arm({ streaming: false });
    const off = await read();
    await settled((await latestAttempt())?.request_id ?? '');
    const before = await sampleCount();
    arm();
    const on = await read();
    await settled((await latestAttempt())?.request_id ?? '');
    expect(on).toBe(off);
    expect(on).toBe('left right');
    const row = await latestAttempt();
    expect(row?.attempts).toBe(1);
    const opened = await openSample(row?.request_id ?? '');
    expect(opened.text).toBe(on);
    expect(await sampleCount()).toBe(before + 1);
    sdkNotes.push('openai sdk text matched with capture off and on and one sample was stored');
  });

  it('reports eligibility without a replay and hides the sample from another tenant', async () => {
    arm({ streaming: false });
    runCli(db, [
      'set-fallback-policy',
      '--tenant-id',
      tenant.tenantId,
      '--alias',
      'auto',
      '--enabled',
      'true',
      '--deployments',
      'gemini-us,chat',
      '--failures',
      'unavailable',
      '--max-attempts',
      '2',
      '--capabilities',
      'temperature',
      '--providers',
      'vertex,openai',
      '--regions',
      'us-central1',
      '--data-collection',
      'allow',
      '--min-remaining-deadline-ms',
      '0',
    ], cliEnv());
    const off = await postChat('gemini-us', JOURNEY_PROMPT, { stream: true, temperature: 0 });
    await settled(requestIdOf(off));
    expect(await samplesFor(String(off.headers['x-request-id']))).toBe(0);
    arm({ streaming: false });
    const quiet = await postChat('gemini-us', JOURNEY_PROMPT, { stream: true, temperature: 0 });
    await settled(requestIdOf(quiet));
    expect(withoutCreated(quiet.body)).toBe(withoutCreated(off.body));
    expect(await samplesFor(String(quiet.headers['x-request-id']))).toBe(0);
    arm();
    const on = await postChat('gemini-us', JOURNEY_PROMPT, { stream: true, temperature: 0 });
    await settled(requestIdOf(on));
    expect(on.statusCode).toBe(200);
    expect(withoutCreated(on.body)).toBe(withoutCreated(off.body));
    expect(deltasOf(on.body).join('')).toBe(JOURNEY_VISIBLE);
    const row = await latestAttempt();
    expect(row?.stream_status).toBe('completed');
    expect(row?.attempts).toBe(1);
    const opened = await openSample(row?.request_id ?? '');
    expect(opened.text).toBe(JOURNEY_VISIBLE);
    expect(opened.stream).toBe(true);
    const beforeCancel = await sampleCount();
    const controller = new AbortController();
    const pending = postRaw('chat', 'scene-cancel', { signal: controller.signal });
    await waitForStatus('streaming');
    controller.abort();
    await expect(pending).rejects.toThrow();
    const cancelled = await waitForStatus('client_aborted');
    expect(await samplesFor(cancelled.request_id)).toBe(0);
    expect(await sampleCount()).toBe(beforeCancel);

    const attemptsBefore = await attemptTotal();
    const jobsBefore = await jobTotal();
    const vertexBefore = vertexCalls.length;
    const openaiBefore = openaiHits.length;
    const anthropicBefore = anthropicHits.length;
    const fallbackBefore = await versionOf('fallback_policies');
    const policyBefore = await versionOf('sample_policies');
    const executionBefore = await executionCount();
    const digestBefore = await digestOf(opened.id);
    const logMark = ctx.lines.length;

    const approved = await eligibility(tenant, opened.id, 'gemini-us');
    expect(approved.statusCode).toBe(200);
    const approvedReport = reportOf(approved.body);
    expect(approvedReport.checks.map((item) => item.check)).toEqual([...ELIGIBILITY_CHECKS]);
    expect(approvedReport.eligible).toBe(true);
    expect(approvedReport.reasons).toEqual([]);
    expect(approvedReport.policyVersion).toBe(policyBefore);
    for (const item of approvedReport.checks) expect(item.result).toBe('pass');

    const unapproved = await eligibility(tenant, opened.id, 'other-chat');
    const unapprovedReport = reportOf(unapproved.body);
    expect(unapproved.statusCode).toBe(200);
    expect(unapprovedReport.eligible).toBe(false);
    expect(unapprovedReport.checks.find((item) => item.check === 'target_deployment_permission')?.reason).toBe('deployment_unauthorized');
    expect(unapprovedReport.reasons).toContain('deployment_unauthorized');

    const mismatch = reportOf((await eligibility(tenant, opened.id, 'gemini-bare')).body);
    expect(mismatch.eligible).toBe(false);
    expect(mismatch.checks.find((item) => item.check === 'target_model_capabilities')?.reason).toBe('capability_mismatch');

    const residency = reportOf((await eligibility(tenant, opened.id, 'chat')).body);
    expect(residency.eligible).toBe(false);
    expect(residency.checks.find((item) => item.check === 'provider_location')?.reason).toBe('residency_denied');

    const cloned = await admin.query<{ id: string }>(
      `WITH source_req AS (
         SELECT * FROM proxy_requests WHERE tenant_id = $1 AND id = $2::uuid
       ),
       inserted AS (
         INSERT INTO proxy_requests (
           tenant_id, deployment_id, deployment_config_version, connection_id, connection_version,
           requested_model, status, created_at, completed_at
         )
         SELECT tenant_id, deployment_id, deployment_config_version, connection_id, connection_version,
                requested_model, status, created_at, completed_at
         FROM source_req
         RETURNING id, tenant_id
       )
       INSERT INTO request_samples (
         id, tenant_id, request_id, policy_id, policy_version, provider, deployment_name,
         data_classification, schema_version, size_bytes, wrapping_key_version,
         wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
         content_iv, content_tag, content_ciphertext, created_at, expires_at,
         fingerprint, slot, task_category, input_size, complexity,
         exchange_complete, text_only, required_capabilities, source_location
       )
       SELECT gen_random_uuid(), s.tenant_id, inserted.id, s.policy_id, s.policy_version, s.provider, s.deployment_name,
              s.data_classification, s.schema_version, s.size_bytes, s.wrapping_key_version,
              s.wrapped_key_iv, s.wrapped_key_tag, s.wrapped_key_ciphertext,
              s.content_iv, s.content_tag, s.content_ciphertext, s.created_at, s.expires_at,
              NULL, s.slot, s.task_category, s.input_size, s.complexity,
              true, NULL, s.required_capabilities, s.source_location
       FROM request_samples s
       JOIN inserted ON inserted.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1 AND s.id = $3::uuid
       RETURNING id::text AS id`,
      [tenant.tenantId, row?.request_id, opened.id],
    );
    const unknownId = cloned.rows[0]?.id ?? '';
    const unknown = reportOf((await eligibility(tenant, unknownId, 'gemini-us')).body);
    expect(unknown.eligible).toBe(false);
    expect(unknown.checks.find((item) => item.check === 'tool_or_multimodal')).toEqual({
      check: 'tool_or_multimodal',
      result: 'unknown',
      reason: 'content_inspection',
    });

    const providerPolicy = await versionOf('sample_policies');
    arm({ providers: 'openai,vertex' });
    const provider = reportOf((await eligibility(tenant, opened.id, 'claude-chat')).body);
    expect(provider.eligible).toBe(false);
    expect(provider.checks.find((item) => item.check === 'provider_location')?.reason).toBe('provider_denied');
    expect(provider.policyVersion).toBeGreaterThan(providerPolicy);

    expect(await attemptTotal()).toBe(attemptsBefore);
    expect(await jobTotal()).toBe(jobsBefore);
    expect(vertexCalls).toHaveLength(vertexBefore);
    expect(openaiHits).toHaveLength(openaiBefore);
    expect(anthropicHits).toHaveLength(anthropicBefore);
    expect(await versionOf('fallback_policies')).toBe(fallbackBefore);
    expect(await executionCount()).toBe(executionBefore);
    expect(await digestOf(opened.id)).toBe(digestBefore);
    const logged = ctx.lines.slice(logMark).join('\n');
    const bodies = [approved.body, unapproved.body, JSON.stringify(mismatch), JSON.stringify(residency), JSON.stringify(unknown), JSON.stringify(provider)].join('\n');
    expect(bodies).not.toContain(JOURNEY_PROMPT);
    expect(bodies).not.toContain(JOURNEY_VISIBLE);
    expect(bodies).not.toContain(digestBefore);
    expect(logged).not.toContain(JOURNEY_PROMPT);
    expect(logged).not.toContain(JOURNEY_VISIBLE);
    expect(logged).not.toContain(digestBefore);

    const foreign = await eligibility(other, opened.id, 'gemini-us');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(JOURNEY_PROMPT);
    expect(foreign.body).not.toContain(JOURNEY_VISIBLE);

    arm({ retention: 1 });
    const expiring = await postChat('gemini-us', 'scene-expire', { stream: true, temperature: 0 });
    await settled(requestIdOf(expiring));
    const expiringRow = await latestAttempt();
    expect(expiring.statusCode).toBe(200);
    const expiringSample = await openSample(expiringRow?.request_id ?? '');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const expired = reportOf((await eligibility(tenant, expiringSample.id, 'gemini-us')).body);
    expect(expired.eligible).toBe(false);
    expect(expired.checks.find((item) => item.check === 'expiry_revocation')?.reason).toBe('expired');

    arm({ replay: false });
    const replayOff = reportOf((await eligibility(tenant, opened.id, 'gemini-us')).body);
    expect(replayOff.eligible).toBe(false);
    expect(replayOff.checks.find((item) => item.check === 'replay_authorization')?.reason).toBe('replay_denied');

    arm({ mode: 'disabled', content: false, streaming: false, replay: false });
    const revoked = reportOf((await eligibility(tenant, opened.id, 'gemini-us')).body);
    expect(revoked.eligible).toBe(false);
    expect(revoked.checks.find((item) => item.check === 'capture_authorization')?.reason).toBe('capture_denied');
    const original = await admin.query<{ status: string; stream_status: string }>(
      `SELECT r.status, a.stream_status
       FROM proxy_requests r
       JOIN model_attempts a ON a.request_id = r.id AND a.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenant.tenantId, row?.request_id],
    );
    expect(original.rows[0]?.status).toBe('succeeded');
    expect(original.rows[0]?.stream_status).toBe('completed');

    journeyNotes.push(
      'streaming capture enabled',
      'capture off stored 0',
      'capture on stored 1 encrypted sample',
      'incremental output matched capture off',
      'cancelled stream stored 0',
      `approved target eligible true policy ${approvedReport.policyVersion}`,
      'unapproved target eligible false reason deployment_unauthorized',
      'eligibility added 0 model attempts',
      'eligibility added 0 sample jobs',
      'eligibility added 0 provider calls',
      'routing policy version unchanged during the metadata checks',
    );
    eligibilityNotes.push(
      `approved eligible true reasons 0 checks ${approvedReport.checks.length} policy ${approvedReport.policyVersion}`,
      'unapproved reason deployment_unauthorized',
      'capability reason capability_mismatch',
      'residency reason residency_denied',
      'provider reason provider_denied',
      'unknown tool_or_multimodal result unknown reason content_inspection',
      'expired reason expired',
      'replay off reason replay_denied',
      'capture revoked reason capture_denied',
      'ciphertext digest unchanged',
      'response and log omitted the sample text',
    );
    isolationNotes.push(`other tenant eligibility status ${foreign.statusCode}`);
    streamNotes.push('journey completed sample stored and cancelled stream stored 0');
  }, 60_000);

  it('keeps readiness for 019_sample_retention.sql after 020 is applied', async () => {
    const applied = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM schema_migrations WHERE version = '020_stream_samples.sql'`,
    );
    const prior = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM schema_migrations WHERE version = '019_sample_retention.sql'`,
    );
    expect(applied.rows[0]?.count).toBe(1);
    expect(prior.rows[0]?.count).toBe(1);
    const sql = readFileSync(join(projectRoot, 'migrations/020_stream_samples.sql'), 'utf8');
    expect(sql).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const rollback = buildApp({
      logger: ctx.logger,
      authPool: ctx.authPool,
      runtimePool: ctx.runtimePool,
      readyVersion: '019_sample_retention.sql',
      inferenceEnabled: false,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey: null,
      maxActiveStreams: 1,
      maxStreamsPerTenant: 1,
    });
    const response = await rollback.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', database: 'ready' });
    await rollback.close();
    rollbackNotes.push(
      `GET /health/ready for 019_sample_retention.sql status ${response.statusCode}`,
      response.body,
      'applied version 019_sample_retention.sql row count 1',
      'applied version 020_stream_samples.sql row count 1',
      '020_stream_samples.sql does not drop a table or a column',
    );
  });
});
