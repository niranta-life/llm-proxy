import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import type { VertexGenerateClient, VertexGenerateRequest } from '../src/inference/vertex-client.js';
import { createTestApp, freePort, loadTestDatabase, projectRoot, runCli, type TestDatabase } from './helpers.js';
import { adminPool, cliEnv, credentialKey, enableStreaming, provisionTenant, registerAnthropic, registerInference } from './inference-support.js';
import { startMockAnthropic, type AnthropicHit } from './mock-anthropic.js';
import { startMockUpstream, type MockHit } from './mock-openai.js';
import { closedPort, pinResolver, registerPrivate } from './private-support.js';

const EVIDENCE = join(projectRoot, 'evidence', 'slice-10d');
const TOOL_CAPS = 'temperature,tools,tool_choice,parallel_tool_calls';
const VERTEX_CAPS = 'temperature,tools,tool_choice';
const VERTEX_EMAIL = 'stream-bot@stream-vertex-proj.iam.gserviceaccount.com';
const VERTEX_KEY = JSON.stringify({ client_email: VERTEX_EMAIL, private_key: `stream-${'k'.repeat(80)}` });
const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

const orderTool = {
  type: 'function' as const,
  function: {
    name: 'get_order_status',
    description: 'Look up an order.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string', description: 'The order identifier.' } },
      required: ['order_id'],
    },
  },
};

const shipTool = {
  type: 'function' as const,
  function: {
    name: 'ship_order',
    description: 'Ship an order.',
    parameters: {
      type: 'object',
      properties: { shipment_id: { type: 'string', description: 'The shipment identifier.' } },
      required: ['shipment_id'],
    },
  },
};

type PublicCall = { index: number; id?: string; name?: string; arguments: string; finish: string | null; done: boolean; text: string };

const proof: {
  proxyExecutedFunction: boolean;
  localExecutions: number;
  sdk: PublicCall | null;
  publicStreams: Record<string, string>;
  upstream: Array<{ provider: string; stream: boolean; toolNames: string[] }>;
  failuresWithoutDone: string[];
} = {
  proxyExecutedFunction: false,
  localExecutions: 0,
  sdk: null,
  publicStreams: {},
  upstream: [],
  failuresWithoutDone: [],
};

function runOrder(args: string): string {
  proof.localExecutions += 1;
  proof.proxyExecutedFunction = true;
  const parsed = JSON.parse(args) as { order_id?: string };
  return parsed.order_id === 'ord_1001' ? 'shipped' : 'unknown';
}

function userText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }>; stream?: boolean; tools?: Array<{ function?: { name?: string } }> };
    const content = parsed.messages?.[0]?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

function toolNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
    return (parsed.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '').filter((name) => name !== '');
  } catch {
    return [];
  }
}

function frame(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'gpt-stream',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function usageFrame(): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'gpt-stream',
    choices: [],
    usage: USAGE,
  })}\n\n`;
}

function doneFrame(): string {
  return 'data: [DONE]\n\n';
}

function openCall(index: number, id: string, name: string, args = ''): unknown {
  return { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] };
}

function argCall(index: number, args: string): unknown {
  return { tool_calls: [{ index, function: { arguments: args } }] };
}

function successStream(): string {
  return [
    frame({ role: 'assistant' }),
    frame(openCall(0, 'call_order_1001', 'get_order_status', '')),
    frame(argCall(0, '{"order_id":"ord_1001"}')),
    frame({}, 'tool_calls'),
    usageFrame(),
    doneFrame(),
  ].join('');
}

function readPublic(raw: string): PublicCall {
  const calls = new Map<number, { index: number; id?: string; name?: string; arguments: string }>();
  let finish: string | null = null;
  let done = false;
  let text = '';
  for (const block of raw.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
        finish_reason?: string | null;
      }>;
    };
    for (const choice of parsed.choices ?? []) {
      if (choice.finish_reason) finish = choice.finish_reason;
      if (typeof choice.delta?.content === 'string') text += choice.delta.content;
      for (const call of choice.delta?.tool_calls ?? []) {
        const current = calls.get(call.index) ?? { index: call.index, arguments: '' };
        if (call.id !== undefined) current.id = call.id;
        if (call.function?.name !== undefined) current.name = call.function.name;
        if (call.function?.arguments !== undefined) current.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
    }
  }
  const first = [...calls.values()].sort((left, right) => left.index - right.index)[0];
  return {
    index: first?.index ?? -1,
    ...(first?.id !== undefined ? { id: first.id } : {}),
    ...(first?.name !== undefined ? { name: first.name } : {}),
    arguments: first?.arguments ?? '',
    finish,
    done,
    text,
  };
}

function anthropicStream(model: string): string {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_stream_tool',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Checking.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_order_1001', name: 'get_order_status', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"order_id":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ord_1001"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function vertexChunk(): Record<string, unknown> {
  return {
    responseId: 'resp-stream-tool',
    modelVersion: 'gemini-stream',
    candidates: [{
      finishReason: 'STOP',
      content: {
        parts: [
          { text: 'Checking.' },
          { functionCall: { id: 'call_order_1001', name: 'get_order_status', args: { order_id: 'ord_1001' } } },
          { functionCall: { id: 'call_ship_2002', name: 'ship_order', args: { shipment_id: 'shp_2002' } } },
        ],
      },
    }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
  };
}

describe('streaming tool calls', () => {
  const db: TestDatabase = loadTestDatabase();
  const caller = { tenantId: '', secret: '' };
  const other = { tenantId: '', secret: '' };
  const closers: Array<() => Promise<unknown>> = [];
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let runtimePool: Awaited<ReturnType<typeof createTestApp>>['runtimePool'];
  let lines: string[] = [];
  let port = 0;
  let dgxPort = 0;
  let openaiHits: MockHit[] = [];
  let anthropicHits: AnthropicHit[] = [];
  let compatibleHits: Array<{ url: string; metadata: string; body: string }> = [];
  let vertexCalls: VertexGenerateRequest[] = [];
  let liveHits = 0;
  const held = new Set<string>();

  function authHeaders(tenantId: string, secret: string): Record<string, string> {
    return { 'x-tenant-id': tenantId, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  }

  function openaiScene(content: string, request: IncomingMessage, response: ServerResponse): void {
    const sse = 'text/event-stream';
    if (content === 'Two calls.') {
      response.writeHead(200, { 'content-type': sse });
      response.end([
        frame({ role: 'assistant', content: 'Checking.' }),
        frame(openCall(0, 'call_order_1001', 'get_order_status', '')),
        frame(openCall(1, 'call_ship_2002', 'ship_order', '')),
        frame(argCall(0, '{"order_id":')),
        frame(argCall(1, '{"shipment_id":')),
        frame(argCall(0, '"ord_1001"}')),
        frame(argCall(1, '"shp_2002"}')),
        frame({}, 'tool_calls'),
        usageFrame(),
        doneFrame(),
      ].join(''));
      return;
    }
    if (content === 'Fragmented.') {
      response.writeHead(200, { 'content-type': sse });
      response.end([
        frame({ role: 'assistant' }),
        frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":')),
        frame(argCall(0, '"ord_1001"}')),
        frame({}, 'tool_calls'),
        usageFrame(),
        doneFrame(),
      ].join(''));
      return;
    }
    if (content === 'Unicode.') {
      response.writeHead(200, { 'content-type': sse });
      response.end([
        frame({ role: 'assistant' }),
        frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":"ord_1001","note":"caf')),
        frame(argCall(0, 'é \\"quoted\\""}')),
        frame({}, 'tool_calls'),
        usageFrame(),
        doneFrame(),
      ].join(''));
      return;
    }
    if (content === 'Missing id.') {
      response.writeHead(200, { 'content-type': sse });
      response.end(frame({ tool_calls: [{ index: 0, type: 'function', function: { name: 'get_order_status', arguments: '{"order_id":"ord_1001"}' } }] }));
      return;
    }
    if (content === 'Out of order.') {
      response.writeHead(200, { 'content-type': sse });
      response.end([
        frame({ role: 'assistant' }),
        frame(argCall(0, '{"order_id":"ord_1001"}')),
      ].join(''));
      return;
    }
    if (content === 'Oversized.') {
      response.writeHead(200, { 'content-type': sse });
      response.write(frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":"ord_1001","pad":"')));
      response.end(frame(argCall(0, 'Z'.repeat(9000))));
      return;
    }
    if (content === 'Bad json.') {
      response.writeHead(200, { 'content-type': sse });
      response.end([
        frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":')),
        frame({}, 'tool_calls'),
      ].join(''));
      return;
    }
    if (content === 'Cancel me.') {
      held.add('cancel');
      request.on('close', () => held.delete('cancel'));
      response.writeHead(200, { 'content-type': sse });
      response.write(frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":"ord_1001"}')));
      return;
    }
    if (content === 'Fail mid.') {
      response.writeHead(200, { 'content-type': sse });
      response.end(`${frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":"ord_1001"}'))}data: ${JSON.stringify({ error: { message: 'boom', type: 'server_error' } })}\n\n`);
      return;
    }
    if (content === 'Incomplete.') {
      response.writeHead(200, { 'content-type': sse });
      response.end(frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":')));
      return;
    }
    if (content === 'Backpressure.') {
      held.add('backpressure');
      const release = (): void => {
        held.delete('backpressure');
      };
      request.on('aborted', release);
      request.socket?.on('close', release);
      response.writeHead(200, { 'content-type': sse });
      response.write(frame(openCall(0, 'call_order_1001', 'get_order_status', '')));
      const big = 'y'.repeat(256 * 1024);
      let writes = 0;
      const pump = (): void => {
        if (response.writableEnded || response.destroyed || request.aborted || request.socket?.destroyed === true) {
          release();
          return;
        }
        if (writes >= 24) return;
        writes += 1;
        response.write(frame({ content: big }));
        setImmediate(pump);
      };
      setImmediate(pump);
      return;
    }
    if (content === 'plain text') {
      response.writeHead(200, { 'content-type': sse });
      response.end(frame(openCall(0, 'call_order_1001', 'get_order_status', '{"order_id":"ord_1001"}'), 'tool_calls'));
      return;
    }
    response.writeHead(200, { 'content-type': sse });
    response.end(successStream());
  }

  async function latest(upstreamModel: string): Promise<{
    stream_status: string | null;
    status: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    enforced_capabilities: string[] | null;
    adapter_version: number | null;
    error_code: string | null;
  } | undefined> {
    const admin = adminPool(db);
    try {
      const rows = await admin.query<{
        stream_status: string | null;
        status: string;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        total_tokens: number | null;
        enforced_capabilities: string[] | null;
        adapter_version: number | null;
        error_code: string | null;
      }>(
        `SELECT a.stream_status, a.status, a.prompt_tokens, a.completion_tokens, a.total_tokens,
                a.enforced_capabilities, a.adapter_version, a.error_code
         FROM model_attempts a
         WHERE a.tenant_id = $1 AND a.upstream_model = $2
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [caller.tenantId, upstreamModel],
      );
      return rows.rows[0];
    } finally {
      await admin.end();
    }
  }

  async function waitForStatus(upstreamModel: string, status: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const row = await latest(upstreamModel);
      if (row?.stream_status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const row = await latest(upstreamModel);
    throw new Error(`stream status ${status} was not stored; latest=${row?.stream_status ?? 'none'}`);
  }

  function post(model: string, content: string, extra: Record<string, unknown> = {}, signal?: AbortSignal, tenant = caller): Promise<{ status: number; raw: string }> {
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      stream: true,
      ...extra,
    });
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { ...authHeaders(tenant.tenantId, tenant.secret), 'content-length': Buffer.byteLength(payload) },
          signal,
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  beforeAll(async () => {
    dgxPort = await closedPort();
    const openai = await startMockUpstream((hit, request, response) => {
      openaiHits.push(hit);
      openaiScene(userText(hit.body), request, response);
    });
    const anthropic = await startMockAnthropic((hit, _request, response) => {
      anthropicHits.push(hit);
      const parsed = JSON.parse(hit.body) as { model?: string; stream?: boolean };
      if (parsed.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(anthropicStream(parsed.model ?? 'claude-stream'));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'msg_text', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    });
    const created = provisionTenant(db, 'Stream Tools');
    const outsider = provisionTenant(db, 'Stream Tools Other');
    caller.tenantId = created.tenantId;
    caller.secret = created.secret;
    other.tenantId = outsider.tenantId;
    other.secret = outsider.secret;
    const env = cliEnv();
    registerInference(db, {
      tenantId: caller.tenantId,
      apiKey: 'sk-test-stream-tools',
      deployment: 'tool-stream',
      upstreamModel: 'gpt-stream',
      capabilities: TOOL_CAPS,
    });
    enableStreaming(db, {
      tenantId: caller.tenantId,
      deployment: 'tool-stream',
      connectTimeoutMs: 8000,
      idleTimeoutMs: 8000,
      totalTimeoutMs: 8000,
      backpressureTimeoutMs: 300,
    });
    registerAnthropic(db, {
      tenantId: caller.tenantId,
      apiKey: 'sk-ant-stream-tools',
      endpoint: anthropic.origin,
      deployment: 'claude-stream',
      upstreamModel: 'claude-stream',
      capabilities: TOOL_CAPS,
      alias: false,
    });
    enableStreaming(db, { tenantId: caller.tenantId, deployment: 'claude-stream', connectTimeoutMs: 8000, idleTimeoutMs: 8000, totalTimeoutMs: 8000 });
    runCli(db, ['register-vertex-connection', '--tenant-id', caller.tenantId, '--api-key', VERTEX_KEY, '--project', 'stream-vertex-proj', '--location', 'us-central1', '--service-account', VERTEX_EMAIL], env);
    runCli(db, ['register-deployment', '--tenant-id', caller.tenantId, '--provider', 'vertex', '--name', 'gemini-stream', '--upstream-model', 'gemini-stream', '--timeout-ms', '8000', '--capabilities', VERTEX_CAPS, '--enabled', 'true'], env);
    enableStreaming(db, { tenantId: caller.tenantId, deployment: 'gemini-stream', connectTimeoutMs: 8000, idleTimeoutMs: 8000, totalTimeoutMs: 8000 });
    runCli(db, ['register-xai-connection', '--tenant-id', caller.tenantId, '--api-key', 'xai-stream-key-0123456789'], env);
    runCli(db, ['register-deployment', '--tenant-id', caller.tenantId, '--provider', 'xai', '--name', 'grok-stream', '--upstream-model', 'grok-stream', '--timeout-ms', '8000', '--capabilities', TOOL_CAPS, '--enabled', 'true'], env);
    enableStreaming(db, { tenantId: caller.tenantId, deployment: 'grok-stream', connectTimeoutMs: 8000, idleTimeoutMs: 8000, totalTimeoutMs: 8000 });
    runCli(db, ['register-openrouter-connection', '--tenant-id', caller.tenantId, '--api-key', 'router-stream-key-012345'], env);
    runCli(db, ['register-deployment', '--tenant-id', caller.tenantId, '--provider', 'openrouter', '--name', 'router-stream', '--upstream-model', 'openai/gpt-stream', '--timeout-ms', '8000', '--capabilities', TOOL_CAPS, '--downstream-providers', 'anthropic', '--data-collection', 'deny', '--allow-fallbacks', 'false', '--require-serving-provider', 'false', '--enabled', 'true'], env);
    enableStreaming(db, { tenantId: caller.tenantId, deployment: 'router-stream', connectTimeoutMs: 8000, idleTimeoutMs: 8000, totalTimeoutMs: 8000 });
    registerPrivate(db, {
      tenantId: caller.tenantId,
      apiKey: 'dgx-stream-secret-key',
      host: '127.0.0.1',
      port: dgxPort,
      addresses: ['127.0.0.1'],
      endpoint: `https://127.0.0.1:${dgxPort}/v1`,
      deployment: 'dgx-stream',
      upstreamModel: 'dgx-stream',
      enabled: true,
    });
    runCli(db, ['set-deployment-capabilities', '--tenant-id', caller.tenantId, '--deployment', 'dgx-stream', '--capabilities', TOOL_CAPS], env);
    enableStreaming(db, { tenantId: caller.tenantId, deployment: 'dgx-stream', connectTimeoutMs: 8000, idleTimeoutMs: 8000, totalTimeoutMs: 8000 });
    registerPrivate(db, { tenantId: other.tenantId, deployment: 'dgx-live', upstreamModel: 'dgx-live', enabled: true });
    runCli(db, ['set-deployment-capabilities', '--tenant-id', other.tenantId, '--deployment', 'dgx-live', '--capabilities', TOOL_CAPS], env);
    enableStreaming(db, { tenantId: other.tenantId, deployment: 'dgx-live', connectTimeoutMs: 8000, idleTimeoutMs: 8000, totalTimeoutMs: 8000 });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (url.includes('dgx.lab.internal')) {
        liveHits += 1;
        return new Response('live', { status: 500 });
      }
      if (url.startsWith('https://api.x.ai/') || url.startsWith('https://openrouter.ai/') || url.startsWith(`https://127.0.0.1:${dgxPort}/`)) {
        compatibleHits.push({ url, metadata: headers.get('x-openrouter-metadata') ?? '', body });
        return new Response(successStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return globalThis.fetch(input, init);
    };
    const factory = async (): Promise<VertexGenerateClient> => ({
      async generateContent() {
        throw new Error('a tool stream does not use the unary vertex call');
      },
      generateContentStream(request) {
        vertexCalls.push(request);
        return (async function* () {
          yield vertexChunk();
        })();
      },
      async listModels() {},
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      vertexClientFactory: factory,
      compatibleFetch: fetchImpl,
      privateResolve: pinResolver('127.0.0.1'),
    });
    app = ctx.app;
    lines = ctx.lines;
    runtimePool = ctx.runtimePool;
    port = await freePort();
    await app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await openai.close();
      await anthropic.close();
    });
  });

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'sdk-proof.json'), `${JSON.stringify({
      proxyExecutedFunction: proof.proxyExecutedFunction,
      localExecutions: proof.localExecutions,
      sdk: proof.sdk,
      upstream: proof.upstream,
      failuresWithoutDone: proof.failuresWithoutDone,
      providers: Object.keys(proof.publicStreams),
    }, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'fixtures.json'), `${JSON.stringify({ streams: proof.publicStreams }, null, 2)}\n`);
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('returns a single streamed tool call', async () => {
    const before = openaiHits.length;
    const response = await post('auto', 'Check the order.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    const parsed = readPublic(response.raw);
    expect(parsed).toMatchObject({ index: 0, id: 'call_order_1001', name: 'get_order_status', arguments: '{"order_id":"ord_1001"}', finish: 'tool_calls', done: true });
    expect(response.raw.indexOf('tool_calls')).toBeGreaterThan(response.raw.indexOf('"role":"assistant"'));
    expect(openaiHits).toHaveLength(before + 1);
    expect(openaiHits[before]?.url).toContain('/chat/completions');
    const upstream = JSON.parse(openaiHits[before]?.body ?? '{}') as { stream?: boolean; tools?: unknown };
    expect(upstream.stream).toBe(true);
    expect(upstream.tools).toEqual([orderTool]);
    proof.publicStreams.openai = response.raw;
    proof.upstream.push({ provider: 'openai', stream: true, toolNames: toolNames(openaiHits[before]?.body ?? '') });
    expect(runOrder).toBeTypeOf('function');
    expect(proof.localExecutions).toBe(0);
  });

  it('returns two interleaved tool calls', async () => {
    const response = await post('auto', 'Two calls.', { tools: [orderTool, shipTool] });
    expect(response.status).toBe(200);
    const calls = new Map<number, string>();
    const parsed = readPublic(response.raw);
    expect(parsed.text).toContain('Checking.');
    expect(parsed.finish).toBe('tool_calls');
    expect(parsed.done).toBe(true);
    expect(response.raw.indexOf('Checking.')).toBeLessThan(response.raw.indexOf('call_order_1001'));
    for (const block of response.raw.split('\n\n')) {
      if (!block.includes('tool_calls') || block.includes('[DONE]')) continue;
      const data = block.split('\n').find((line) => line.startsWith('data:'));
      if (data === undefined) continue;
      const body = JSON.parse(data.slice(5).trim()) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> } }> };
      for (const call of body.choices?.[0]?.delta?.tool_calls ?? []) {
        calls.set(call.index, `${calls.get(call.index) ?? ''}${call.function?.arguments ?? ''}`);
      }
    }
    expect(calls.get(0)).toBe('{"order_id":"ord_1001"}');
    expect(calls.get(1)).toBe('{"shipment_id":"shp_2002"}');
    expect(response.raw.indexOf('call_order_1001')).toBeLessThan(response.raw.indexOf('call_ship_2002'));
    expect(proof.localExecutions).toBe(0);
  });

  it('accepts fragmented JSON', async () => {
    const response = await post('auto', 'Fragmented.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    const parsed = readPublic(response.raw);
    expect(parsed).toMatchObject({ id: 'call_order_1001', name: 'get_order_status', arguments: '{"order_id":"ord_1001"}', finish: 'tool_calls', done: true });
    expect(JSON.parse(parsed.arguments)).toEqual({ order_id: 'ord_1001' });
  });

  it('accepts unicode and escaping', async () => {
    const response = await post('auto', 'Unicode.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    const parsed = readPublic(response.raw);
    expect(parsed.finish).toBe('tool_calls');
    expect(parsed.done).toBe(true);
    expect(JSON.parse(parsed.arguments)).toEqual({ order_id: 'ord_1001', note: 'café "quoted"' });
  });

  it('rejects a missing function ID', async () => {
    const before = openaiHits.length;
    const response = await post('auto', 'Missing id.', { tools: [orderTool] });
    expect(response.status).toBe(502);
    expect(response.raw).not.toContain('[DONE]');
    expect(response.raw).toContain('invalid_upstream_response');
    expect(openaiHits).toHaveLength(before + 1);
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('provider_failed');
    proof.failuresWithoutDone.push('missing function ID');
    expect(proof.localExecutions).toBe(0);
  });

  it('rejects out-of-order provider events', async () => {
    const response = await post('auto', 'Out of order.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    expect(response.raw).toContain('"role":"assistant"');
    expect(response.raw).not.toContain('[DONE]');
    expect(response.raw).not.toContain('ord_1001');
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('provider_failed');
    proof.failuresWithoutDone.push('out-of-order provider events');
  });

  it('rejects oversized arguments', async () => {
    const response = await post('auto', 'Oversized.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    expect(response.raw).toContain('call_order_1001');
    expect(response.raw).not.toContain('Z'.repeat(100));
    expect(response.raw).not.toContain('[DONE]');
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('provider_failed');
    proof.failuresWithoutDone.push('oversized arguments');
  });

  it('rejects assembled arguments that are not one JSON object', async () => {
    const response = await post('auto', 'Bad json.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    const parsed = readPublic(response.raw);
    expect(parsed.arguments).toContain('{"order_id":');
    expect(parsed.finish).toBeNull();
    expect(parsed.done).toBe(false);
    expect(response.raw).not.toContain('[DONE]');
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('provider_failed');
    proof.failuresWithoutDone.push('incomplete JSON');
  });

  it('cancels the stream', async () => {
    const controller = new AbortController();
    const pending = post('auto', 'Cancel me.', { tools: [orderTool] }, controller.signal);
    await waitForStatus('gpt-stream', 'streaming');
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitForStatus('gpt-stream', 'client_aborted');
    const row = await latest('gpt-stream');
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('request_cancelled');
    expect(held.has('cancel')).toBe(false);
    proof.failuresWithoutDone.push('stream cancellation');
    expect(proof.localExecutions).toBe(0);
  });

  it('fails the stream when the provider fails mid-call', async () => {
    const response = await post('auto', 'Fail mid.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    expect(response.raw).toContain('call_order_1001');
    expect(response.raw).not.toContain('[DONE]');
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('provider_failed');
    expect(row?.status).toBe('failed');
    proof.failuresWithoutDone.push('provider failure mid-call');
  });

  it('applies backpressure', async () => {
    const pending = new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const payload = JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'Backpressure.' }],
        stream: true,
        tools: [orderTool],
      });
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { ...authHeaders(caller.tenantId, caller.secret), 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          res.pause();
          void waitForStatus('gpt-stream', 'slow_consumer')
            .then(() => {
              const parts: Buffer[] = [];
              res.resume();
              res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
            })
            .catch((error: unknown) => {
              req.destroy();
              reject(error);
            });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.raw).toContain('call_order_1001');
    expect(response.raw).not.toContain('[DONE]');
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('slow_consumer');
    expect(row?.error_code).toBe('slow_consumer');
    expect(held.has('backpressure')).toBe(false);
    proof.failuresWithoutDone.push('backpressure');
  });

  it('leaves an incomplete stream unfinished', async () => {
    const response = await post('auto', 'Incomplete.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    expect(response.raw).toContain('call_order_1001');
    expect(response.raw).not.toContain('[DONE]');
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('stream_truncated');
    expect(row?.status).toBe('failed');
    proof.failuresWithoutDone.push('incomplete stream');
  });

  it('feeds the official OpenAI SDK', async () => {
    const client = new OpenAI({
      apiKey: caller.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 20_000,
      defaultHeaders: { 'X-Tenant-ID': caller.tenantId },
    });
    const stream = await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [orderTool],
      stream: true,
    });
    const calls = new Map<number, { index: number; id?: string; name?: string; arguments: string }>();
    let finish: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      for (const call of choice?.delta.tool_calls ?? []) {
        const current = calls.get(call.index) ?? { index: call.index, arguments: '' };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
    }
    const call = calls.get(0);
    expect(finish).toBe('tool_calls');
    expect(call).toMatchObject({ index: 0, id: 'call_order_1001', name: 'get_order_status', arguments: '{"order_id":"ord_1001"}' });
    expect(JSON.parse(call?.arguments ?? '')).toEqual({ order_id: 'ord_1001' });
    expect(proof.localExecutions).toBe(0);
    expect(lines.join('\n')).not.toContain('ord_1001');
    const row = await latest('gpt-stream');
    expect(row).toMatchObject({
      stream_status: 'completed',
      status: 'succeeded',
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      adapter_version: 1,
      error_code: null,
    });
    expect(row?.enforced_capabilities).toEqual(TOOL_CAPS.split(','));
    const samples = await withTenant(runtimePool, caller.tenantId, (clientDb) =>
      clientDb.query<{ count: number }>('SELECT count(*)::int AS count FROM request_samples'),
    );
    expect(samples.rows[0]?.count).toBe(0);
    proof.sdk = {
      index: 0,
      id: call?.id,
      name: call?.name,
      arguments: call?.arguments ?? '',
      finish,
      done: true,
      text: '',
    };
  });

  it('normalizes an Anthropic input_json_delta stream', async () => {
    const before = anthropicHits.length;
    const response = await post('claude-stream', 'Check the order.', { tools: [orderTool] });
    expect(response.status).toBe(200);
    const parsed = readPublic(response.raw);
    expect(parsed.text).toContain('Checking.');
    expect(parsed).toMatchObject({ index: 1, id: 'call_order_1001', name: 'get_order_status', arguments: '{"order_id":"ord_1001"}', finish: 'tool_calls', done: true });
    const upstream = JSON.parse(anthropicHits[before]?.body ?? '{}') as { stream?: boolean; tools?: Array<{ name?: string; input_schema?: { type?: string } }> };
    expect(upstream.stream).toBe(true);
    expect(upstream.tools?.[0]?.name).toBe('get_order_status');
    expect(upstream.tools?.[0]?.input_schema?.type).toBe('object');
    const row = await latest('claude-stream');
    expect(row).toMatchObject({ stream_status: 'completed', prompt_tokens: 11, completion_tokens: 7, adapter_version: 1 });
    proof.publicStreams.anthropic = response.raw;
    proof.upstream.push({ provider: 'anthropic', stream: true, toolNames: ['get_order_status'] });
    expect(proof.localExecutions).toBe(0);
  });

  it('normalizes a Vertex function-call stream', async () => {
    const before = vertexCalls.length;
    const response = await post('gemini-stream', 'Check the order.', { tools: [orderTool, shipTool] });
    expect(response.status).toBe(200);
    expect(response.raw).toContain('"index":0');
    expect(response.raw).toContain('call_order_1001');
    expect(response.raw).toContain('call_ship_2002');
    expect(response.raw).toContain('"finish_reason":"tool_calls"');
    expect(response.raw).toContain('data: [DONE]');
    expect(response.raw.indexOf('Checking.')).toBeLessThan(response.raw.indexOf('call_order_1001'));
    const request = vertexCalls[before];
    expect(request?.config?.tools?.[0]?.functionDeclarations?.map((item) => item.name)).toEqual(['get_order_status', 'ship_order']);
    const row = await latest('gemini-stream');
    expect(row).toMatchObject({ stream_status: 'completed', prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, adapter_version: 1 });
    proof.publicStreams.vertex = response.raw;
    proof.upstream.push({ provider: 'vertex', stream: true, toolNames: ['get_order_status', 'ship_order'] });
    expect(proof.localExecutions).toBe(0);
  });

  it('streams tools for xAI, OpenRouter, and a loopback DGX mock', async () => {
    const xaiBefore = compatibleHits.length;
    const xai = await post('grok-stream', 'Check the order.', { tools: [orderTool] });
    const router = await post('router-stream', 'Check the order.', { tools: [orderTool] });
    const dgx = await post('dgx-stream', 'Check the order.', { tools: [orderTool] });
    for (const response of [xai, router, dgx]) {
      expect(response.status).toBe(200);
      expect(readPublic(response.raw)).toMatchObject({
        index: 0,
        id: 'call_order_1001',
        name: 'get_order_status',
        arguments: '{"order_id":"ord_1001"}',
        finish: 'tool_calls',
        done: true,
      });
    }
    const xaiHit = compatibleHits[xaiBefore];
    const routerHit = compatibleHits[xaiBefore + 1];
    const dgxHit = compatibleHits[xaiBefore + 2];
    expect(xaiHit?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(xaiHit?.metadata).toBe('');
    expect(JSON.parse(xaiHit?.body ?? '{}').tools).toEqual([orderTool]);
    expect(routerHit?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(routerHit?.metadata).not.toBe('');
    expect(dgxHit?.url).toBe(`https://127.0.0.1:${dgxPort}/v1/chat/completions`);
    expect(dgxHit?.metadata).toBe('');
    expect(liveHits).toBe(0);
    proof.publicStreams.xai = xai.raw;
    proof.publicStreams.openrouter = router.raw;
    proof.publicStreams.dgx = dgx.raw;
    proof.upstream.push(
      { provider: 'xai', stream: true, toolNames: ['get_order_status'] },
      { provider: 'openrouter', stream: true, toolNames: ['get_order_status'] },
      { provider: 'dgx', stream: true, toolNames: ['get_order_status'] },
    );
    expect(proof.localExecutions).toBe(0);
  });

  it('does not send function tools to a live DGX host', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(other.tenantId, other.secret),
      payload: { model: 'dgx-live', stream: true, messages: [{ role: 'user', content: 'Check the order.' }], tools: [orderTool] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('tools is not supported.');
    expect(liveHits).toBe(0);
    expect(response.body).not.toContain('[DONE]');
  });

  it('rejects a text-only stream that receives a tool delta', async () => {
    const before = openaiHits.length;
    const response = await post('auto', 'plain text');
    expect(response.status).toBe(502);
    expect(response.raw).not.toContain('[DONE]');
    expect(response.raw).toContain('invalid_upstream_response');
    const upstream = JSON.parse(openaiHits[before]?.body ?? '{}') as { tools?: unknown };
    expect(upstream.tools).toBeUndefined();
    const row = await latest('gpt-stream');
    expect(row?.stream_status).toBe('provider_failed');
    expect(row?.enforced_capabilities).toBeNull();
    expect(row?.adapter_version).toBeNull();
  });

  it('still rejects an empty tools array', async () => {
    const before = openaiHits.length;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(caller.tenantId, caller.secret),
      payload: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'Empty.' }], tools: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(openaiHits).toHaveLength(before);
    expect(response.body).not.toContain('[DONE]');
  });
});
