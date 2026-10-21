import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  cachedVertexClient,
  clearVertexClientCache,
  type VertexClientFactory,
  type VertexClientSpec,
  type VertexGenerateClient,
  type VertexGenerateRequest,
} from '../src/inference/vertex-client.js';
import { createTestApp, freePort, projectRoot, runCli, type TestDatabase } from './helpers.js';
import {
  adminPool,
  cliEnv,
  credentialKey,
  enableStreaming,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockAnthropic, anthropicMessage, type AnthropicHit } from './mock-anthropic.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';
import {
  bridgePrivateMock,
  closedPort,
  pinResolver,
  postChat,
  PRIVATE_HOST,
  PRIVATE_PIN,
  registerPrivate,
  UPSTREAM_MODEL,
  type PrivateHit,
} from './private-support.js';
import { startPrivateMock } from './mock-private.js';

export const TIMEOUT_MS = 1_200;
export const STREAM_MS = 15_000;

export const UPSTREAM = {
  openai: 'gpt-matrix-actual',
  anthropic: 'claude-matrix-actual',
  vertex: 'gemini-matrix-actual',
  xai: 'grok-matrix-actual',
  openrouter: 'router-matrix-actual',
  dgx: UPSTREAM_MODEL,
} as const;

export type ProviderName = keyof typeof UPSTREAM;

export type SixNames = Record<ProviderName, string>;

export type SixKeys = {
  openai: string;
  anthropic: string;
  vertexEmail: string;
  vertexKey: string;
  vertexProject: string;
  xai: string;
  openrouter: string;
  dgx: string;
};

export type CompatibleHit = {
  url: string;
  authorization: string;
  metadata: string;
  body: string;
  model: string;
};

export type VertexCall = {
  spec: VertexClientSpec;
  model: string;
  text: string;
  kind: 'chat' | 'stream';
};

export type Doubles = {
  openaiHits: MockHit[];
  anthropicHits: AnthropicHit[];
  vertexCalls: VertexCall[];
  xaiHits: CompatibleHit[];
  openrouterHits: CompatibleHit[];
  dgxHits: PrivateHit[];
  mints: VertexClientSpec[];
  openaiBaseUrl: string;
  anthropicOrigin: string;
  fetch: typeof fetch;
  vertexFactory: VertexClientFactory;
  releaseFinish: () => void;
  close: () => Promise<void>;
};

export type HitSnapshot = Record<ProviderName, number> & { mints: number };

const OPENAI_STREAM = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
const ANTHROPIC_STREAM = readFileSync(join(projectRoot, 'test/fixtures/anthropic-stream/usage.sse'), 'utf8');

function framed(text: string): string {
  return text.endsWith('\n\n') ? text : `${text.replace(/\n*$/, '')}\n\n`;
}

function messageText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    const content = parsed.messages?.[0]?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

function readUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string {
  const headers = new Headers(init?.headers);
  const direct = headers.get(name);
  if (direct) return direct;
  if (input instanceof Request) return input.headers.get(name) ?? '';
  return '';
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8');
  if (input instanceof Request) return input.clone().text();
  return '';
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function untilAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function holdResponse(request: IncomingMessage, response: ServerResponse, first?: string): void {
  const timer = setTimeout(() => {
    if (!response.writableEnded) request.socket.destroy();
  }, 20_000);
  const stop = (): void => clearTimeout(timer);
  request.on('aborted', stop);
  request.on('close', stop);
  request.on('error', () => undefined);
  response.on('error', () => undefined);
  if (first !== undefined) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(first);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function openAiCompletion(
  model: string,
  content: string,
  usage?: Record<string, number> | null,
): Record<string, unknown> {
  if (usage === undefined) return completionBody(model, content);
  return completionBody(model, content, usage);
}

function compatibleSse(model: string, content: string, usage: Record<string, number>): string {
  const head = {
    id: 'chatcmpl-matrix',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
  };
  return [
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [], usage })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function usageFor(provider: 'xai' | 'openrouter'): Record<string, number> {
  if (provider === 'xai') return { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 };
  return { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 };
}

function contentFor(provider: 'xai' | 'openrouter'): string {
  return provider === 'xai' ? 'xai-ok' : 'router-ok';
}

function textOf(request: VertexGenerateRequest): string {
  return request.contents.map((content) => content.parts.map((part) => part.text).join('')).join('\n');
}

function vertexCompletion(model: string, usage: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    responseId: 'resp-matrix',
    modelVersion: model,
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'vertex-ok' }] } }],
  };
  if (usage) {
    body.usageMetadata = { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 };
  }
  return body;
}

export function sceneContent(provider: ProviderName, scene: string): string {
  if (provider !== 'dgx' || scene === 'ok') return scene;
  return `scene-${scene}`;
}

export function defaultNames(suffix: string): SixNames {
  return {
    openai: `oa-${suffix}`,
    anthropic: `claude-${suffix}`,
    vertex: `gemini-${suffix}`,
    xai: `xai-${suffix}`,
    openrouter: `router-${suffix}`,
    dgx: `dgx-${suffix}`,
  };
}

export function vertexKey(email: string): string {
  return JSON.stringify({ client_email: email, private_key: `key-${'k'.repeat(80)}` });
}

export function registerSix(
  db: TestDatabase,
  tenantId: string,
  names: SixNames,
  keys: SixKeys,
  anthropicOrigin: string,
): void {
  const env = cliEnv();
  registerInference(db, {
    tenantId,
    apiKey: keys.openai,
    deployment: names.openai,
    upstreamModel: UPSTREAM.openai,
    timeoutMs: TIMEOUT_MS,
    capabilities: 'temperature',
  });
  registerAnthropic(db, {
    tenantId,
    apiKey: keys.anthropic,
    endpoint: anthropicOrigin,
    deployment: names.anthropic,
    upstreamModel: UPSTREAM.anthropic,
    timeoutMs: TIMEOUT_MS,
    capabilities: 'temperature',
  });
  runCli(
    db,
    [
      'register-vertex-connection',
      '--tenant-id',
      tenantId,
      '--api-key',
      keys.vertexKey,
      '--project',
      keys.vertexProject,
      '--location',
      'us-central1',
      '--service-account',
      keys.vertexEmail,
    ],
    env,
  );
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--provider',
      'vertex',
      '--name',
      names.vertex,
      '--upstream-model',
      UPSTREAM.vertex,
      '--timeout-ms',
      String(TIMEOUT_MS),
      '--capabilities',
      'temperature',
      '--enabled',
      'true',
    ],
    env,
  );
  runCli(db, ['register-xai-connection', '--tenant-id', tenantId, '--api-key', keys.xai], env);
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--provider',
      'xai',
      '--name',
      names.xai,
      '--upstream-model',
      UPSTREAM.xai,
      '--timeout-ms',
      String(TIMEOUT_MS),
      '--capabilities',
      'temperature',
      '--enabled',
      'true',
    ],
    env,
  );
  runCli(db, ['register-openrouter-connection', '--tenant-id', tenantId, '--api-key', keys.openrouter], env);
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--provider',
      'openrouter',
      '--name',
      names.openrouter,
      '--upstream-model',
      UPSTREAM.openrouter,
      '--timeout-ms',
      String(TIMEOUT_MS),
      '--capabilities',
      'temperature',
      '--enabled',
      'true',
    ],
    env,
  );
  registerPrivate(db, {
    tenantId,
    apiKey: keys.dgx,
    deployment: names.dgx,
    upstreamModel: UPSTREAM.dgx,
    timeoutMs: TIMEOUT_MS,
    enabled: true,
  });
  for (const name of Object.values(names)) {
    enableStreaming(db, {
      tenantId,
      deployment: name,
      connectTimeoutMs: STREAM_MS,
      idleTimeoutMs: STREAM_MS,
      totalTimeoutMs: STREAM_MS,
    });
  }
}

export async function startDoubles(): Promise<Doubles> {
  clearVertexClientCache();
  const refused = await closedPort();
  const vertexCalls: VertexCall[] = [];
  const mints: VertexClientSpec[] = [];
  const xaiHits: CompatibleHit[] = [];
  const openrouterHits: CompatibleHit[] = [];

  const openaiStream = framed(OPENAI_STREAM.replaceAll('__MODEL__', UPSTREAM.openai));
  const anthropicStream = framed(ANTHROPIC_STREAM.replaceAll('__MODEL__', UPSTREAM.anthropic));
  const openaiFirst = openaiStream.slice(0, openaiStream.indexOf('\n\n') + 2);
  const anthropicFirst = anthropicStream.slice(0, anthropicStream.indexOf('\n\n') + 2);
  let releaseFinish: (() => void) | undefined;

  const openai = await startMockUpstream((hit, request, response) => {
    const content = messageText(hit.body);
    if (content === 'refuse') {
      request.socket.destroy();
      return;
    }
    if (content === 'timeout') {
      holdResponse(request, response);
      return;
    }
    if (content === 'cancel' || content === 'hold-open') {
      holdResponse(request, response, openaiFirst);
      return;
    }
    if (content === 'finish-in-drain') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(openaiFirst);
      releaseFinish = () => {
        if (!response.writableEnded) response.end(openaiStream.slice(openaiFirst.length));
      };
      return;
    }
    if (content === 'rate' || content === 'down') {
      const status = content === 'rate' ? 429 : 500;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream', type: 'server_error' } }));
      return;
    }
    if (content === 'stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(openaiStream);
      return;
    }
    const parsed = JSON.parse(hit.body) as { model?: string };
    const model = parsed.model ?? UPSTREAM.openai;
    if (content === 'nousage') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(openAiCompletion(model, 'openai-ok', null)));
      return;
    }
    if (content === 'partial') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(openAiCompletion(model, 'openai-ok', { prompt_tokens: 4, completion_tokens: 1 })));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(openAiCompletion(model, 'openai-ok')));
  });

  const anthropic = await startMockAnthropic((hit, request, response) => {
    const content = messageText(hit.body);
    const parsed = JSON.parse(hit.body) as { model?: string };
    const model = parsed.model ?? UPSTREAM.anthropic;
    if (content === 'refuse') {
      request.socket.destroy();
      return;
    }
    if (content === 'timeout') {
      holdResponse(request, response);
      return;
    }
    if (content === 'cancel') {
      holdResponse(request, response, anthropicFirst);
      return;
    }
    if (content === 'rate' || content === 'down') {
      const status = content === 'rate' ? 429 : 500;
      const type = content === 'rate' ? 'rate_limit_error' : 'api_error';
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type, message: 'upstream' } }));
      return;
    }
    if (content === 'stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(anthropicStream);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (content === 'nousage') {
      response.end(JSON.stringify(anthropicMessage(model, 'claude-ok', 'end_turn', null)));
      return;
    }
    response.end(JSON.stringify(anthropicMessage(model, 'claude-ok')));
  });

  const privateMock = await startPrivateMock();
  const bridge = bridgePrivateMock(privateMock, refused);

  function buildClient(spec: VertexClientSpec): VertexGenerateClient {
    return {
      async generateContent(request) {
        const text = textOf(request);
        vertexCalls.push({ spec, model: request.model, text, kind: 'chat' });
        if (text.includes('timeout')) await untilAbort(request.config.abortSignal);
        if (text.includes('refuse')) throw new Error('connect-failed');
        if (text.includes('rate')) throw { status: 429 };
        if (text.includes('down')) throw { status: 500 };
        return vertexCompletion(request.model, !text.includes('nousage'));
      },
      generateContentStream(request) {
        const text = textOf(request);
        vertexCalls.push({ spec, model: request.model, text, kind: 'stream' });
        if (text.includes('cancel')) {
          return (async function* cancel() {
            yield {
              responseId: 'resp-cancel',
              modelVersion: request.model,
              candidates: [{ content: { parts: [{ text: 'vertex-ok' }] } }],
            };
            await untilAbort(request.config.abortSignal);
          })();
        }
        return (async function* success() {
          yield {
            responseId: 'resp-stream',
            modelVersion: request.model,
            candidates: [{ content: { parts: [{ text: 'vertex-ok' }] } }],
          };
          yield {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ' stream' }] } }],
            usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
          };
        })();
      },
      async listModels() {},
    };
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = readUrl(input);
    if (url.includes(PRIVATE_HOST)) return bridge.fetch(input, init);
    const body = await readBody(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let provider: 'xai' | 'openrouter';
    if (url.startsWith('https://api.x.ai/')) provider = 'xai';
    else if (url.startsWith('https://openrouter.ai/')) provider = 'openrouter';
    else throw new Error(`unexpected upstream host`);
    let model = '';
    try {
      model = String((JSON.parse(body) as { model?: string }).model ?? '');
    } catch {
      model = '';
    }
    const hit: CompatibleHit = {
      url,
      authorization: headerValue(input, init, 'authorization'),
      metadata: headerValue(input, init, 'x-openrouter-metadata'),
      body,
      model,
    };
    if (provider === 'xai') xaiHits.push(hit);
    else openrouterHits.push(hit);
    const content = messageText(body);
    const streaming = (() => {
      try {
        return (JSON.parse(body) as { stream?: boolean }).stream === true;
      } catch {
        return false;
      }
    })();
    if (content === 'timeout') return untilAbort(signal ?? undefined);
    if (content === 'cancel') {
      const encoder = new TextEncoder();
      const first = `data: ${JSON.stringify({
        id: 'chatcmpl-matrix',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: { content: contentFor(provider) }, finish_reason: null }],
      })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(first));
          try {
            await untilAbort(signal ?? undefined);
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (content === 'refuse') {
      return fetch(`http://127.0.0.1:${refused}/connection-refused`, { signal: signal ?? undefined });
    }
    if (content === 'rate') return jsonResponse(429, { error: { message: 'upstream', type: 'rate_limit_error' } });
    if (content === 'down') return jsonResponse(500, { error: { message: 'upstream', type: 'server_error' } });
    if (streaming) {
      return new Response(compatibleSse(model, contentFor(provider), usageFor(provider)), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const usage = content === 'nousage' ? null : usageFor(provider);
    return jsonResponse(200, openAiCompletion(model, contentFor(provider), usage));
  };

  return {
    openaiHits: openai.hits,
    anthropicHits: anthropic.hits,
    vertexCalls,
    xaiHits,
    openrouterHits,
    dgxHits: bridge.hits,
    mints,
    openaiBaseUrl: openai.baseUrl,
    anthropicOrigin: anthropic.origin,
    fetch: fetchImpl,
    vertexFactory: (spec) =>
      cachedVertexClient(spec, {
        now: () => Date.now(),
        mint: async (value) => {
          mints.push({ ...value });
          return { client: buildClient(value), expiresAtMs: Date.now() + 10 * 60_000 };
        },
      }),
    releaseFinish: () => releaseFinish?.(),
    close: async () => {
      clearVertexClientCache();
      await openai.close();
      await anthropic.close();
      await privateMock.close();
    },
  };
}

export async function listenProxy(
  db: TestDatabase,
  doubles: Doubles,
): Promise<{
  app: Awaited<ReturnType<typeof createTestApp>>['app'];
  port: number;
  close: () => Promise<void>;
}> {
  const ctx = await createTestApp(db, {
    inferenceEnabled: true,
    upstreamBaseUrl: doubles.openaiBaseUrl,
    credentialKey,
    compatibleFetch: doubles.fetch,
    privateResolve: pinResolver(PRIVATE_PIN),
    vertexClientFactory: doubles.vertexFactory,
  });
  const port = await freePort();
  await ctx.app.listen({ host: '127.0.0.1', port });
  return {
    app: ctx.app,
    port,
    close: async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
    },
  };
}

export function snapshot(doubles: Doubles): HitSnapshot {
  return {
    openai: doubles.openaiHits.length,
    anthropic: doubles.anthropicHits.length,
    vertex: doubles.vertexCalls.length,
    xai: doubles.xaiHits.length,
    openrouter: doubles.openrouterHits.length,
    dgx: doubles.dgxHits.length,
    mints: doubles.mints.length,
  };
}

export function grewOnly(before: HitSnapshot, after: HitSnapshot, provider: ProviderName): boolean {
  for (const name of Object.keys(UPSTREAM) as ProviderName[]) {
    const expected = before[name] + (name === provider ? 1 : 0);
    if (after[name] !== expected) return false;
  }
  return true;
}

export function chat(
  port: number,
  tenantId: string,
  secret: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return postChat(`http://127.0.0.1:${port}/v1`, tenantId, secret, body, signal);
}

export function doneCount(raw: string): number {
  return raw.split('data: [DONE]').length - 1;
}

export function cliJson(db: TestDatabase, args: string[]): Record<string, unknown> {
  return runCli(db, args, cliEnv()) as unknown as Record<string, unknown>;
}

export function openDb(db: TestDatabase): pg.Pool {
  return adminPool(db);
}

export type AttemptFacts = {
  status: string;
  error_code: string | null;
  stream_status: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  provider: string;
  deployment_name: string;
  upstream_model: string;
};

export async function latestAttempt(admin: pg.Pool, tenantId: string): Promise<AttemptFacts> {
  const result = await admin.query<AttemptFacts>(
    `SELECT a.status, a.error_code, a.stream_status, a.prompt_tokens, a.completion_tokens, a.total_tokens,
            c.provider, d.name AS deployment_name, a.upstream_model
     FROM model_attempts a
     JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
     JOIN provider_connections c ON c.id = d.connection_id AND c.tenant_id = d.tenant_id
     WHERE a.tenant_id = $1
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('attempt is missing');
  return row;
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
}

export function openPost(
  port: number,
  tenantId: string,
  secret: string,
  payload: string,
): { settled: Promise<{ status: number; raw: string }>; destroy: () => void } {
  let destroy = (): void => undefined;
  const settled = new Promise<{ status: number; raw: string }>((resolve, reject) => {
    let done = false;
    const finish = (value: { status: number; raw: string }): void => {
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
        const parts: Buffer[] = [];
        res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
        const snapshotBody = (): { status: number; raw: string } => ({
          status: res.statusCode ?? 0,
          raw: Buffer.concat(parts).toString('utf8'),
        });
        res.on('end', () => finish(snapshotBody()));
        res.on('aborted', () => finish(snapshotBody()));
        res.on('close', () => {
          if (req.destroyed) finish(snapshotBody());
        });
      },
    );
    destroy = () => req.destroy();
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
        finish({ status: 0, raw: '' });
        return;
      }
      if (!done) reject(error);
    });
    req.write(payload);
    req.end();
  });
  return { settled, destroy };
}

export function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

export async function deploymentRows(
  admin: pg.Pool,
  tenantId: string,
): Promise<
  Array<{ name: string; config_version: number; health_status: string; validation_status: string; enabled: boolean }>
> {
  const result = await admin.query<{
    name: string;
    config_version: number;
    health_status: string;
    validation_status: string;
    enabled: boolean;
  }>(
    `SELECT name, config_version, health_status, validation_status, enabled
     FROM model_deployments
     WHERE tenant_id = $1
     ORDER BY name`,
    [tenantId],
  );
  return result.rows;
}

export async function connectionRows(
  admin: pg.Pool,
  tenantId: string,
): Promise<Array<{ provider: string; config_version: number; credential_version: number; enabled: boolean }>> {
  const result = await admin.query<{
    provider: string;
    config_version: number;
    credential_version: number;
    enabled: boolean;
  }>(
    `SELECT provider, config_version, credential_version, enabled
     FROM provider_connections
     WHERE tenant_id = $1
     ORDER BY provider`,
    [tenantId],
  );
  return result.rows;
}

export async function autoDeployment(admin: pg.Pool, tenantId: string): Promise<string | null> {
  const result = await admin.query<{ name: string }>(
    `SELECT d.name
     FROM model_aliases a
     JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.alias = 'auto'`,
    [tenantId],
  );
  return result.rows[0]?.name ?? null;
}
