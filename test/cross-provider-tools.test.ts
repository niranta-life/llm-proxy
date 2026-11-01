import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FunctionCallingConfigMode } from '@google/genai';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import { addDecimal, multiplyDecimal } from '../src/inference/cost.js';
import type { VertexGenerateClient, VertexGenerateRequest } from '../src/inference/vertex-client.js';
import { cliEntry, createTestApp, freePort, loadTestDatabase, projectRoot, runCli, serviceEnv } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant, registerAnthropic } from './inference-support.js';
import { startMockAnthropic, type AnthropicHit } from './mock-anthropic.js';
import { closedPort, pinResolver, registerPrivate } from './private-support.js';

const ORDER_ARGUMENTS = '{"order_id":"ord_1001"}';
const SHIP_ARGUMENTS = '{"shipment_id":"shp_2002"}';
const SECRET_MARK = 'ord_1001';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-10c');
const VERTEX_EMAIL = 'cross-bot@cross-vertex-proj.iam.gserviceaccount.com';
const VERTEX_KEY = JSON.stringify({ client_email: VERTEX_EMAIL, private_key: `cross-${'k'.repeat(80)}` });
const TOOL_CAPS = 'temperature,tools,tool_choice,parallel_tool_calls';
const VERTEX_CAPS = ['temperature', 'tools', 'tool_choice'];
const ANTHROPIC_CAPS = ['temperature', 'tools', 'tool_choice', 'parallel_tool_calls'];

const orderParameters = {
  type: 'object',
  properties: {
    order_id: { type: 'string', description: 'The order identifier.', minLength: 1, maxLength: 64 },
  },
  required: ['order_id'],
};

const richParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order_id: { type: 'string', description: 'The order identifier.', minLength: 1, maxLength: 64 },
    priority: { type: 'integer', enum: [1, 2] },
  },
  required: ['order_id'],
};

const orderTool = {
  type: 'function' as const,
  function: {
    name: 'get_order_status',
    description: 'Read one order status.',
    parameters: orderParameters,
  },
};

const richOrderTool = {
  type: 'function' as const,
  function: {
    name: 'get_order_status',
    description: 'Read one order status.',
    parameters: richParameters,
  },
};

const shipmentTool = {
  type: 'function' as const,
  function: {
    name: 'get_shipment',
    description: 'Read one shipment.',
    parameters: {
      type: 'object',
      properties: { shipment_id: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['shipment_id'],
    },
  },
};

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

const providers = [
  { name: 'anthropic', model: 'claude-cross' },
  { name: 'vertex', model: 'gemini-cross' },
  { name: 'xai', model: 'grok-cross' },
  { name: 'openrouter', model: 'router-cross' },
  { name: 'dgx', model: 'dgx-loop' },
] as const;

type ProviderName = (typeof providers)[number]['name'];

type Journey = {
  provider: ProviderName;
  toolCall: { id: string; name: string; arguments: string; finishReason: string };
  toolResult: { tool_call_id: string; content: string };
  finalAnswer: string;
  proxyExecutedFunction: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function completion(model: string, message: Record<string, unknown>, finish: string, usage: Record<string, number>) {
  return {
    id: 'chatcmpl-cross',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

function assistantCall(calls: ToolCall[]) {
  return { role: 'assistant', content: null, tool_calls: calls };
}

const TOOL_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const TEXT_USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

function userTexts(messages: Array<{ role?: string; content?: unknown }> | undefined): string[] {
  const texts: string[] = [];
  for (const message of messages ?? []) {
    if (typeof message.content === 'string' && (message.role === 'user' || message.role === undefined)) {
      texts.push(message.content);
    }
  }
  return texts;
}

function compatibleReply(body: {
  model?: string;
  tools?: unknown;
  messages?: Array<{ role?: string; content?: string | null }>;
}): Record<string, unknown> {
  const model = body.model ?? 'compatible';
  const messages = body.messages ?? [];
  const lastUser = [...userTexts(messages)].reverse()[0] ?? '';
  if (body.tools === undefined && !messages.some((message) => message.role === 'tool' || message.role === 'assistant')) {
    return completion(model, { role: 'assistant', content: 'ok' }, 'stop', TEXT_USAGE);
  }
  if (messages.some((message) => message.role === 'tool')) {
    return completion(model, { role: 'assistant', content: 'The order is shipped.' }, 'stop', TOOL_USAGE);
  }
  if (lastUser === 'Bad arguments.') {
    return completion(model, assistantCall([toolCall('call_order_1001', 'get_order_status', '[]')]), 'stop', TOOL_USAGE);
  }
  if (lastUser === 'Check both orders.') {
    return completion(
      model,
      assistantCall([
        toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS),
        toolCall('call_ship_2002', 'get_shipment', SHIP_ARGUMENTS),
      ]),
      'stop',
      TOOL_USAGE,
    );
  }
  return completion(model, assistantCall([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]), 'stop', TOOL_USAGE);
}

function anthropicBlocks(body: { messages?: Array<{ role?: string; content?: unknown }> }): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block)) blocks.push(block);
    }
  }
  return blocks;
}

function anthropicText(body: { messages?: Array<{ role?: string; content?: unknown }> }): string {
  const texts: string[] = [];
  for (const message of body.messages ?? []) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') texts.push(message.content);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('\n');
}

function anthropicMessage(model: string, content: unknown, stopReason: string, usage: Record<string, number>): Record<string, unknown> {
  return {
    id: 'msg_cross',
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    content,
    usage,
  };
}

function anthropicReply(body: {
  model?: string;
  tools?: unknown;
  messages?: Array<{ role?: string; content?: unknown }>;
}): Record<string, unknown> {
  const model = body.model ?? 'claude-cross';
  const text = anthropicText(body);
  const blocks = anthropicBlocks(body);
  if (body.tools === undefined && !blocks.some((block) => block.type === 'tool_use' || block.type === 'tool_result')) {
    return anthropicMessage(model, [{ type: 'text', text: 'ok' }], 'end_turn', { input_tokens: 3, output_tokens: 2 });
  }
  if (blocks.some((block) => block.type === 'tool_result')) {
    return anthropicMessage(model, [{ type: 'text', text: 'The order is shipped.' }], 'end_turn', {
      input_tokens: 11,
      output_tokens: 7,
    });
  }
  if (text.includes('Bad arguments.')) {
    return anthropicMessage(
      model,
      [{ type: 'tool_use', id: 'call_order_1001', name: 'get_order_status', input: ['nope'] }],
      'tool_use',
      { input_tokens: 11, output_tokens: 7 },
    );
  }
  const calls = text.includes('Check both orders.')
    ? [
        { type: 'tool_use', id: 'call_order_1001', name: 'get_order_status', input: { order_id: 'ord_1001' } },
        { type: 'tool_use', id: 'call_ship_2002', name: 'get_shipment', input: { shipment_id: 'shp_2002' } },
      ]
    : [{ type: 'tool_use', id: 'call_order_1001', name: 'get_order_status', input: { order_id: 'ord_1001' } }];
  return anthropicMessage(model, calls, 'tool_use', { input_tokens: 11, output_tokens: 7 });
}

function vertexText(request: VertexGenerateRequest): string {
  return request.contents.map((content) => content.parts.map((part) => part.text ?? '').join('')).join('\n');
}

function vertexHasResponse(request: VertexGenerateRequest): boolean {
  return request.contents.some((content) => content.parts.some((part) => part.functionResponse !== undefined));
}

function vertexReply(request: VertexGenerateRequest): Record<string, unknown> {
  const text = vertexText(request);
  const usage = (prompt: number, completionTokens: number) => ({
    promptTokenCount: prompt,
    candidatesTokenCount: completionTokens,
    totalTokenCount: prompt + completionTokens,
  });
  if (request.config.tools === undefined && !vertexHasResponse(request) && !text.includes('Check')) {
    return {
      responseId: 'resp-cross',
      modelVersion: request.model,
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: usage(3, 2),
    };
  }
  if (vertexHasResponse(request)) {
    return {
      responseId: 'resp-cross',
      modelVersion: request.model,
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'The order is shipped.' }] } }],
      usageMetadata: usage(11, 7),
    };
  }
  if (text.includes('Bad arguments.')) {
    return {
      responseId: 'resp-cross',
      modelVersion: request.model,
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ functionCall: { name: 'get_order_status', args: { order_id: 'ord_1001' } } }] },
      }],
      usageMetadata: usage(11, 7),
    };
  }
  const calls = text.includes('Check both orders.')
    ? [
        { functionCall: { name: 'get_order_status', id: 'call_order_1001', args: { order_id: 'ord_1001' } } },
        { functionCall: { name: 'get_shipment', id: 'call_ship_2002', args: { shipment_id: 'shp_2002' } } },
      ]
    : [{ functionCall: { name: 'get_order_status', id: 'call_order_1001', args: { order_id: 'ord_1001' } } }];
  return {
    responseId: 'resp-cross',
    modelVersion: request.model,
    candidates: [{ finishReason: 'STOP', content: { parts: calls } }],
    usageMetadata: usage(11, 7),
  };
}

function vertexSnapshot(request: VertexGenerateRequest): Record<string, unknown> {
  const { abortSignal: _abort, httpOptions: _http, ...config } = request.config;
  return { model: request.model, contents: request.contents, config };
}

describe('cross-provider function calling', () => {
  const db = loadTestDatabase();
  const conversions: Record<string, unknown> = {};
  const journeys: Journey[] = [];
  let executions = 0;
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let lines: string[] = [];
  let runtimePool: Awaited<ReturnType<typeof createTestApp>>['runtimePool'];
  let port = 0;
  let dgxPort = 0;
  const anthropicHits: AnthropicHit[] = [];
  const vertexCalls: VertexGenerateRequest[] = [];
  const compatibleHits: Array<{ url: string; metadata: string; body: string }> = [];
  const closers: Array<() => Promise<unknown>> = [];
  const caller = { tenantId: '', secret: '' };
  const other = { tenantId: '', secret: '' };

  function runLocal(name: string, args: string): string {
    executions += 1;
    const parsed = JSON.parse(args) as { order_id?: string; shipment_id?: string };
    if (name === 'get_order_status' && parsed.order_id === 'ord_1001') return 'shipped';
    if (name === 'get_shipment' && parsed.shipment_id === 'shp_2002') return 'packed';
    throw new Error(`unexpected local function ${name}`);
  }

  function client(): OpenAI {
    return new OpenAI({
      apiKey: caller.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 20_000,
      defaultHeaders: { 'X-Tenant-ID': caller.tenantId },
    });
  }

  async function sdkChat(
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    extra: Record<string, unknown> = {},
  ): Promise<OpenAI.Chat.ChatCompletion> {
    return client().chat.completions.create({
      model,
      messages,
      ...extra,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  }

  function authHeaders(tenantId: string, secret: string): Record<string, string> {
    return {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    };
  }

  async function post(tenantId: string, secret: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenantId, secret),
      payload,
    });
  }

  beforeAll(async () => {
    dgxPort = await closedPort();
    const anthropic = await startMockAnthropic((hit, _request, response) => {
      anthropicHits.push(hit);
      const body = JSON.parse(hit.body) as Parameters<typeof anthropicReply>[0];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(anthropicReply(body)));
    });
    const created = provisionTenant(db, 'Cross Tools');
    const outsider = provisionTenant(db, 'Cross Tools Other');
    caller.tenantId = created.tenantId;
    caller.secret = created.secret;
    other.tenantId = outsider.tenantId;
    other.secret = outsider.secret;
    const env = cliEnv();
    registerAnthropic(db, {
      tenantId: caller.tenantId,
      apiKey: 'sk-ant-cross-tools',
      endpoint: anthropic.origin,
      deployment: 'claude-cross',
      upstreamModel: 'claude-cross',
      capabilities: ANTHROPIC_CAPS.join(','),
      alias: false,
    });
    runCli(db, [
      'register-vertex-connection',
      '--tenant-id',
      caller.tenantId,
      '--api-key',
      VERTEX_KEY,
      '--project',
      'cross-vertex-proj',
      '--location',
      'us-central1',
      '--service-account',
      VERTEX_EMAIL,
    ], env);
    runCli(db, [
      'register-deployment',
      '--tenant-id',
      caller.tenantId,
      '--provider',
      'vertex',
      '--name',
      'gemini-cross',
      '--upstream-model',
      'gemini-cross',
      '--timeout-ms',
      '5000',
      '--capabilities',
      VERTEX_CAPS.join(','),
      '--enabled',
      'true',
    ], env);
    runCli(db, ['register-xai-connection', '--tenant-id', caller.tenantId, '--api-key', 'xai-cross-key-0123456789'], env);
    runCli(db, [
      'register-deployment',
      '--tenant-id',
      caller.tenantId,
      '--provider',
      'xai',
      '--name',
      'grok-cross',
      '--upstream-model',
      'grok-cross',
      '--timeout-ms',
      '5000',
      '--capabilities',
      TOOL_CAPS,
      '--enabled',
      'true',
    ], env);
    runCli(db, ['register-openrouter-connection', '--tenant-id', caller.tenantId, '--api-key', 'router-cross-key-012345'], env);
    runCli(db, [
      'register-deployment',
      '--tenant-id',
      caller.tenantId,
      '--provider',
      'openrouter',
      '--name',
      'router-cross',
      '--upstream-model',
      'openai/gpt-cross',
      '--timeout-ms',
      '5000',
      '--capabilities',
      TOOL_CAPS,
      '--downstream-providers',
      'anthropic',
      '--data-collection',
      'deny',
      '--allow-fallbacks',
      'false',
      '--require-serving-provider',
      'false',
      '--enabled',
      'true',
    ], env);
    registerPrivate(db, {
      tenantId: caller.tenantId,
      apiKey: 'dgx-loop-secret-key',
      host: '127.0.0.1',
      port: dgxPort,
      addresses: ['127.0.0.1'],
      endpoint: `https://127.0.0.1:${dgxPort}/v1`,
      deployment: 'dgx-loop',
      upstreamModel: 'dgx-cross',
      enabled: true,
    });
    runCli(db, [
      'set-deployment-capabilities',
      '--tenant-id',
      caller.tenantId,
      '--deployment',
      'dgx-loop',
      '--capabilities',
      TOOL_CAPS,
    ], env);
    registerPrivate(db, {
      tenantId: other.tenantId,
      deployment: 'dgx-live',
      upstreamModel: 'dgx-live',
      enabled: true,
    });
    runCli(db, [
      'set-deployment-capabilities',
      '--tenant-id',
      other.tenantId,
      '--deployment',
      'dgx-live',
      '--capabilities',
      TOOL_CAPS,
    ], env);
    runCli(db, [
      'register-price',
      '--provider',
      'anthropic',
      '--upstream-model',
      'claude-cross',
      '--effective-at',
      new Date(Date.now() - 60_000).toISOString(),
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '0.01',
      '--output-rate',
      '0.02',
    ], env);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = readUrl(input);
      if (url.startsWith('https://api.x.ai/') || url.startsWith('https://openrouter.ai/') || url.startsWith(`https://127.0.0.1:${dgxPort}/`)) {
        const body = await readBody(input, init);
        compatibleHits.push({ url, metadata: headerValue(input, init, 'x-openrouter-metadata'), body });
        const parsed = JSON.parse(body) as Parameters<typeof compatibleReply>[0];
        return jsonResponse(200, compatibleReply(parsed));
      }
      return globalThis.fetch(input, init);
    };
    const factory = async (): Promise<VertexGenerateClient> => ({
      async generateContent(request) {
        vertexCalls.push(request);
        return vertexReply(request);
      },
      generateContentStream() {
        throw new Error('a stream does not accept tools');
      },
      async listModels() {},
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
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
      await anthropic.close();
    });
  }, 180_000);

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'conversions.json'), `${JSON.stringify(conversions, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'journeys.json'), `${JSON.stringify({
      proxyExecutedFunction: false,
      localExecutions: executions,
      journeys,
    }, null, 2)}\n`);
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('returns one tool call from the same OpenAI SDK caller', async () => {
    for (const provider of providers) {
      const beforeAnthropic = anthropicHits.length;
      const beforeVertex = vertexCalls.length;
      const beforeCompatible = compatibleHits.length;
      const response = await sdkChat(provider.model, [{ role: 'user', content: 'Check the order.' }], {
        tools: [orderTool],
        tool_choice: 'auto',
      });
      expect(response.choices[0]?.finish_reason).toBe('tool_calls');
      expect(response.choices[0]?.message.tool_calls).toEqual([
        toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS),
      ]);
      expect(JSON.stringify(response)).toContain(SECRET_MARK);
      expect(lines.join('\n')).not.toContain(SECRET_MARK);
      if (provider.name === 'anthropic') {
        const sent = JSON.parse(anthropicHits[beforeAnthropic]?.body ?? '{}') as {
          tools?: Array<{ name?: string; input_schema?: unknown }>;
          tool_choice?: unknown;
        };
        expect(sent.tool_choice).toEqual({ type: 'auto' });
        expect(sent.tools?.[0]?.input_schema).toEqual(orderParameters);
        conversions.anthropicSingle = sent;
      } else if (provider.name === 'vertex') {
        const sent = vertexCalls[beforeVertex];
        expect(sent?.config.toolConfig?.functionCallingConfig.mode).toBe(FunctionCallingConfigMode.AUTO);
        expect(sent?.config.tools?.[0]?.functionDeclarations[0]).toMatchObject({
          name: 'get_order_status',
          parameters: {
            type: 'OBJECT',
            required: ['order_id'],
            properties: { order_id: { type: 'STRING', minLength: 1, maxLength: 64, description: 'The order identifier.' } },
          },
        });
        conversions.vertexSingle = sent === undefined ? null : vertexSnapshot(sent);
      } else {
        const hit = compatibleHits[beforeCompatible];
        const sent = JSON.parse(hit?.body ?? '{}') as { tools?: unknown; tool_choice?: unknown };
        expect(sent.tool_choice).toBe('auto');
        expect(sent.tools).toEqual([orderTool]);
        conversions[`${provider.name}Single`] = { url: hit?.url, metadata: hit?.metadata, body: sent };
      }
    }
    expect(executions).toBe(0);
  });

  it('returns multiple tool calls where the provider fixture shows two calls', async () => {
    for (const provider of providers) {
      const extra: Record<string, unknown> = { tools: [orderTool, shipmentTool] };
      if (provider.name !== 'vertex') extra.parallel_tool_calls = true;
      const response = await sdkChat(provider.model, [{ role: 'user', content: 'Check both orders.' }], extra);
      expect(response.choices[0]?.finish_reason).toBe('tool_calls');
      expect(response.choices[0]?.message.tool_calls?.map((call) => call.id)).toEqual(['call_order_1001', 'call_ship_2002']);
      const started = executions;
      const results = (response.choices[0]?.message.tool_calls ?? []).map((call) => runLocal(call.function.name, call.function.arguments));
      expect(results).toEqual(['shipped', 'packed']);
      expect(executions).toBe(started + 2);
    }
  });

  it('keeps a tool result and a follow-up answer tied to the same call id', async () => {
    for (const provider of providers) {
      const beforeAnthropic = anthropicHits.length;
      const beforeVertex = vertexCalls.length;
      const beforeCompatible = compatibleHits.length;
      const first = await sdkChat(provider.model, [{ role: 'user', content: 'Check the order.' }], {
        tools: [orderTool],
        tool_choice: 'auto',
      });
      const call = first.choices[0]?.message.tool_calls?.[0];
      expect(call?.id).toBe('call_order_1001');
      const started = executions;
      const result = runLocal(call?.function.name ?? '', call?.function.arguments ?? '');
      expect(executions).toBe(started + 1);
      const second = await sdkChat(
        provider.model,
        [
          { role: 'user', content: 'Check the order.' },
          {
            role: 'assistant',
            content: first.choices[0]?.message.content ?? null,
            tool_calls: (first.choices[0]?.message.tool_calls ?? []).map((item) => ({
              id: item.id,
              type: 'function' as const,
              function: { name: item.function.name, arguments: item.function.arguments },
            })),
          },
          { role: 'tool', tool_call_id: 'call_order_1001', content: result },
        ],
        { tools: [orderTool] },
      );
      expect(second.choices[0]?.message.content).toBe('The order is shipped.');
      expect(second.choices[0]?.finish_reason).toBe('stop');
      expect(second.choices[0]?.message.tool_calls).toBeUndefined();
      if (provider.name === 'anthropic') {
        const sent = JSON.parse(anthropicHits.at(-1)?.body ?? '{}') as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        expect(sent.messages?.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
        const results = anthropicBlocks(sent).filter((block) => block.type === 'tool_result');
        expect(results).toEqual([{ type: 'tool_result', tool_use_id: 'call_order_1001', content: 'shipped' }]);
        conversions.anthropicFollowUp = sent;
        expect(anthropicHits.length).toBe(beforeAnthropic + 2);
      } else if (provider.name === 'vertex') {
        const sent = vertexCalls.at(-1);
        expect(sent?.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
        const responses = sent?.contents.flatMap((content) => content.parts.map((part) => part.functionResponse).filter((part) => part !== undefined)) ?? [];
        expect(responses).toEqual([{ name: 'get_order_status', id: 'call_order_1001', response: { content: 'shipped' } }]);
        conversions.vertexFollowUp = sent === undefined ? null : vertexSnapshot(sent);
        expect(vertexCalls.length).toBe(beforeVertex + 2);
      } else {
        const sent = JSON.parse(compatibleHits.at(-1)?.body ?? '{}') as {
          messages?: Array<{ role?: string; tool_call_id?: string; content?: string }>;
        };
        expect(sent.messages?.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_order_1001', content: 'shipped' });
        conversions[`${provider.name}FollowUp`] = sent;
        expect(compatibleHits.length).toBe(beforeCompatible + 2);
      }
      journeys.push({
        provider: provider.name,
        toolCall: {
          id: 'call_order_1001',
          name: 'get_order_status',
          arguments: ORDER_ARGUMENTS,
          finishReason: 'tool_calls',
        },
        toolResult: { tool_call_id: 'call_order_1001', content: result },
        finalAnswer: 'The order is shipped.',
        proxyExecutedFunction: false,
      });
    }
  });

  it('converts a native Anthropic tool_use body and keeps schema keywords', async () => {
    const before = anthropicHits.length;
    const response = await sdkChat('claude-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [richOrderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
      parallel_tool_calls: false,
    });
    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    const sent = JSON.parse(anthropicHits[before]?.body ?? '{}') as {
      tools?: Array<{ input_schema?: unknown }>;
      tool_choice?: unknown;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    expect(sent.tools?.[0]?.input_schema).toEqual(richParameters);
    expect(JSON.stringify(sent.tools)).toContain('"additionalProperties":false');
    expect(JSON.stringify(sent.tools)).toContain('"enum":[1,2]');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'get_order_status', disable_parallel_tool_use: true });
    const assistant = sent.messages?.find((message) => message.role === 'assistant');
    expect(assistant).toBeUndefined();
    conversions.anthropicNative = sent;
    expect(anthropicHits.length).toBe(before + 1);
  });

  it('converts a native Vertex function declaration and function call', async () => {
    const before = vertexCalls.length;
    const response = await sdkChat('gemini-cross', [{ role: 'user', content: 'Check both orders.' }], {
      tools: [orderTool, shipmentTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });
    expect(response.choices[0]?.message.tool_calls?.map((call) => call.id)).toEqual(['call_order_1001', 'call_ship_2002']);
    const sent = vertexCalls[before];
    expect(sent?.config.toolConfig?.functionCallingConfig).toEqual({
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: ['get_order_status'],
    });
    expect(JSON.stringify(sent?.config.tools)).not.toContain('additionalProperties');
    expect(sent?.contents.map((content) => content.role)).toEqual(['user']);
    const calls = sent?.contents.flatMap((content) => content.parts.flatMap((part) => (part.functionCall ? [part.functionCall.id] : []))) ?? [];
    expect(calls).toEqual([]);
    conversions.vertexNative = sent === undefined ? null : vertexSnapshot(sent);
    expect(vertexCalls.length).toBe(before + 1);
  });

  it('sends an xAI compatible tool body and does not send OpenRouter metadata', async () => {
    const before = compatibleHits.length;
    const response = await sdkChat('grok-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [richOrderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });
    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    const hit = compatibleHits[before];
    expect(hit?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(hit?.metadata).toBe('');
    const sent = JSON.parse(hit?.body ?? '{}') as { tools?: unknown; tool_choice?: unknown; provider?: unknown };
    expect(sent.tools).toEqual([richOrderTool]);
    expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'get_order_status' } });
    expect(sent.provider).toBeUndefined();
    expect(JSON.stringify(sent.tools)).toContain('"additionalProperties":false');
    conversions.xaiNative = { url: hit?.url, body: sent };
  });

  it('sends an OpenRouter compatible tool body with the stored provider restriction', async () => {
    const before = compatibleHits.length;
    const response = await sdkChat('router-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [richOrderTool],
      tool_choice: 'required',
    });
    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    const hit = compatibleHits[before];
    expect(hit?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(hit?.metadata).toBe('enabled');
    const sent = JSON.parse(hit?.body ?? '{}') as {
      tools?: unknown;
      tool_choice?: unknown;
      provider?: { only?: string[]; data_collection?: string; allow_fallbacks?: boolean };
    };
    expect(sent.tools).toEqual([richOrderTool]);
    expect(sent.tool_choice).toBe('required');
    expect(sent.provider).toEqual({ only: ['anthropic'], data_collection: 'deny', allow_fallbacks: false });
    conversions.openrouterNative = { url: hit?.url, metadata: hit?.metadata, body: sent };
  });

  it('sends a loopback DGX tool body and does not call a live DGX host', async () => {
    const before = compatibleHits.length;
    const response = await sdkChat('dgx-loop', [{ role: 'user', content: 'Check the order.' }], {
      tools: [richOrderTool],
      tool_choice: 'auto',
    });
    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    const hit = compatibleHits[before];
    expect(hit?.url).toBe(`https://127.0.0.1:${dgxPort}/v1/chat/completions`);
    const sent = JSON.parse(hit?.body ?? '{}') as { tools?: unknown; tool_choice?: unknown };
    expect(sent.tools).toEqual([richOrderTool]);
    expect(sent.tool_choice).toBe('auto');
    const live = await post(other.tenantId, other.secret, {
      model: 'dgx-live',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [orderTool],
    });
    expect(live.statusCode).toBe(400);
    expect(live.json().error.message).toBe('tools is not supported.');
    expect(compatibleHits.length).toBe(before + 1);
    expect(compatibleHits.some((item) => item.url.includes('dgx.lab.internal'))).toBe(false);
    conversions.dgxMock = { url: hit?.url, body: sent };
  });

  it('rejects invalid provider tool arguments', async () => {
    const startedExecutions = executions;
    const cases = [
      { model: 'claude-cross', before: () => anthropicHits.length, after: () => anthropicHits.length },
      { model: 'gemini-cross', before: () => vertexCalls.length, after: () => vertexCalls.length },
      { model: 'grok-cross', before: () => compatibleHits.length, after: () => compatibleHits.length },
    ];
    for (const item of cases) {
      const started = item.before();
      const response = await post(caller.tenantId, caller.secret, {
        model: item.model,
        messages: [{ role: 'user', content: 'Bad arguments.' }],
        tools: [orderTool],
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe('invalid_upstream_response');
      expect(item.after()).toBe(started + 1);
    }
    expect(executions).toBe(startedExecutions);
  });

  it('rejects a schema compatibility failure without weakening the schema', async () => {
    const anthropicBefore = anthropicHits.length;
    const nullSchema = await post(caller.tenantId, caller.secret, {
      model: 'claude-cross',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_order_status',
          parameters: { type: 'object', properties: { order_id: { type: 'null' } } },
        },
      }],
    });
    expect(nullSchema.statusCode).toBe(400);
    expect(nullSchema.json().error.message).toBe('The schema type is not supported.');
    expect(anthropicHits.length).toBe(anthropicBefore);
    const vertexBefore = vertexCalls.length;
    const extraSchema = await post(caller.tenantId, caller.secret, {
      model: 'gemini-cross',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [richOrderTool],
    });
    expect(extraSchema.statusCode).toBe(400);
    expect(extraSchema.json().error.message).toBe('additionalProperties is not supported.');
    expect(vertexCalls.length).toBe(vertexBefore);
    expect(JSON.stringify(richOrderTool)).toContain('additionalProperties');
  });

  it('rejects unsupported tool_choice behavior before the provider call', async () => {
    const before = vertexCalls.length;
    const omitted = await post(caller.tenantId, caller.secret, {
      model: 'gemini-cross',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [orderTool],
      parallel_tool_calls: false,
    });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error.message).toBe('parallel_tool_calls is not supported by this model.');
    const forced = await post(caller.tenantId, caller.secret, {
      model: 'gemini-cross',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [orderTool],
      parallel_tool_calls: true,
    });
    expect(forced.statusCode).toBe(400);
    expect(forced.json().error.param).toBe('parallel_tool_calls');
    expect(vertexCalls.length).toBe(before);
    const cli = spawnSync(process.execPath, [
      cliEntry,
      'set-deployment-capabilities',
      '--tenant-id',
      caller.tenantId,
      '--deployment',
      'gemini-cross',
      '--capabilities',
      'temperature,tools,tool_choice,parallel_tool_calls',
    ], { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' });
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain('deployment arguments are invalid');
  });

  it('forces tool selection to one named function', async () => {
    const anthropicBefore = anthropicHits.length;
    const vertexBefore = vertexCalls.length;
    const compatibleBefore = compatibleHits.length;
    const anthropic = await sdkChat('claude-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [orderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });
    const vertex = await sdkChat('gemini-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [orderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });
    const xai = await sdkChat('grok-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [orderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });
    expect(anthropic.choices[0]?.message.tool_calls?.[0]?.id).toBe('call_order_1001');
    expect(vertex.choices[0]?.finish_reason).toBe('tool_calls');
    expect(xai.choices[0]?.finish_reason).toBe('tool_calls');
    const anthropicBody = JSON.parse(anthropicHits[anthropicBefore]?.body ?? '{}') as { tool_choice?: unknown };
    expect(anthropicBody.tool_choice).toEqual({ type: 'tool', name: 'get_order_status' });
    expect(vertexCalls[vertexBefore]?.config.toolConfig?.functionCallingConfig).toEqual({
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: ['get_order_status'],
    });
    const xaiBody = JSON.parse(compatibleHits[compatibleBefore]?.body ?? '{}') as { tool_choice?: unknown };
    expect(xaiBody.tool_choice).toEqual({ type: 'function', function: { name: 'get_order_status' } });
  });

  it('keeps tenant permission isolation', async () => {
    const ownModels = await app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders(caller.tenantId, caller.secret) });
    const otherModels = await app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders(other.tenantId, other.secret) });
    const ownIds = ownModels.json().data.map((item: { id: string }) => item.id);
    const otherIds = otherModels.json().data.map((item: { id: string }) => item.id);
    expect(ownIds).toEqual(expect.arrayContaining(['claude-cross', 'gemini-cross', 'grok-cross', 'router-cross', 'dgx-loop']));
    expect(ownIds).not.toContain('dgx-live');
    expect(otherIds).toContain('dgx-live');
    expect(otherIds).not.toEqual(expect.arrayContaining(['claude-cross', 'gemini-cross', 'grok-cross', 'router-cross', 'dgx-loop']));
    const ownAttempts = await withTenant(runtimePool, caller.tenantId, (client) =>
      client.query<{ count: number }>('SELECT count(*)::int AS count FROM model_attempts'),
    );
    const otherAttempts = await withTenant(runtimePool, other.tenantId, (client) =>
      client.query<{ count: number }>('SELECT count(*)::int AS count FROM model_attempts'),
    );
    expect(ownAttempts.rows[0]?.count).toBeGreaterThan(0);
    expect(otherAttempts.rows[0]?.count).toBe(0);
  });

  it('rejects tools on a stream and leaves a text request text-only', async () => {
    for (const provider of providers) {
      const beforeAnthropic = anthropicHits.length;
      const beforeVertex = vertexCalls.length;
      const beforeCompatible = compatibleHits.length;
      const stream = await post(caller.tenantId, caller.secret, {
        model: provider.model,
        stream: true,
        messages: [{ role: 'user', content: 'Check the order.' }],
        tools: [orderTool],
      });
      expect(stream.statusCode).toBe(400);
      expect(stream.json().error.message).toBe('tools is not supported.');
      expect(anthropicHits.length).toBe(beforeAnthropic);
      expect(vertexCalls.length).toBe(beforeVertex);
      expect(compatibleHits.length).toBe(beforeCompatible);
    }
    const textAnthropic = anthropicHits.length;
    const textVertex = vertexCalls.length;
    const textCompatible = compatibleHits.length;
    const anthropic = await sdkChat('claude-cross', [{ role: 'user', content: 'plain text please' }], { temperature: 0.1 });
    const xai = await sdkChat('grok-cross', [{ role: 'user', content: 'plain text please' }], { temperature: 0.1 });
    expect(anthropic.choices[0]?.message).toEqual({ role: 'assistant', content: 'ok' });
    expect(anthropic.choices[0]?.finish_reason).toBe('stop');
    expect(anthropic.usage).toMatchObject(TEXT_USAGE);
    expect(xai.choices[0]?.message.content).toBe('ok');
    expect(xai.usage).toMatchObject(TEXT_USAGE);
    const anthropicBody = JSON.parse(anthropicHits[textAnthropic]?.body ?? '{}') as Record<string, unknown>;
    expect(anthropicBody.tools).toBeUndefined();
    expect(anthropicBody.tool_choice).toBeUndefined();
    expect(anthropicBody.temperature).toBe(0.1);
    const xaiBody = JSON.parse(compatibleHits[textCompatible]?.body ?? '{}') as Record<string, unknown>;
    expect(xaiBody.tools).toBeUndefined();
    expect(xaiBody.tool_choice).toBeUndefined();
    expect(xaiBody.parallel_tool_calls).toBeUndefined();
    expect(xaiBody.temperature).toBe(0.1);
    expect(xaiBody.stream).toBe(false);
    expect(vertexCalls.length).toBe(textVertex);
  });

  it('records the enforced capability set and adapter version on a tool attempt', async () => {
    const response = await sdkChat('claude-cross', [{ role: 'user', content: 'Check the order.' }], {
      tools: [orderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });
    expect(response.usage).toMatchObject(TOOL_USAGE);
    const admin = adminPool(db);
    try {
      const rows = await admin.query<{
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        amount: string;
        cost_status: string;
        enforced_capabilities: string[] | null;
        adapter_version: number | null;
        structured_output: boolean;
        tool_required: boolean;
      }>(
        `SELECT a.prompt_tokens, a.completion_tokens, a.total_tokens, c.amount::text AS amount, c.cost_status,
                a.enforced_capabilities, a.adapter_version, f.structured_output, f.tool_required
         FROM model_attempts a
         JOIN attempt_costs c ON c.tenant_id = a.tenant_id AND c.attempt_id = a.id
         JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
         JOIN request_features f ON f.tenant_id = a.tenant_id AND f.request_id = r.id
         WHERE a.tenant_id = $1 AND a.upstream_model = 'claude-cross' AND a.prompt_tokens = 11
         ORDER BY r.created_at DESC
         LIMIT 1`,
        [caller.tenantId],
      );
      expect(rows.rows[0]).toMatchObject({
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        cost_status: 'estimated',
        adapter_version: 1,
        structured_output: false,
        tool_required: true,
        enforced_capabilities: ANTHROPIC_CAPS,
      });
      expect(rows.rows[0]?.amount).toBe(addDecimal(multiplyDecimal('0.01', 11), multiplyDecimal('0.02', 7)));
      const samples = await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1',
        [caller.tenantId],
      );
      expect(samples.rows[0]?.count).toBe(0);
      const text = await sdkChat('claude-cross', [{ role: 'user', content: 'plain text please' }]);
      expect(text.choices[0]?.message.content).toBe('ok');
      const textRow = await admin.query<{ enforced_capabilities: string[] | null; adapter_version: number | null }>(
        `SELECT a.enforced_capabilities, a.adapter_version
         FROM model_attempts a
         JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
         WHERE a.tenant_id = $1 AND a.upstream_model = 'claude-cross'
         ORDER BY r.created_at DESC
         LIMIT 1`,
        [caller.tenantId],
      );
      expect(textRow.rows[0]).toEqual({ enforced_capabilities: null, adapter_version: null });
    } finally {
      await admin.end();
    }
    expect(lines.join('\n')).not.toContain(SECRET_MARK);
  });
});
