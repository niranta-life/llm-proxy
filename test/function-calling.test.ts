import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import { addDecimal, multiplyDecimal } from '../src/inference/cost.js';
import { compatibleRequestFields } from '../src/inference/compatible.js';
import { inputBound } from '../src/inference/admission.js';
import { extractRequestFeatures, featureInputFromChat } from '../src/inference/request-features.js';
import { redact } from '../src/redact.js';
import { buildSamplePayload, captureChatSample } from '../src/inference/samples.js';
import { assertCapabilities, assertToolProvider, validateChatRequest } from '../src/inference/validate.js';
import { captureLogger, createTestApp, freePort, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import {
  adminPool,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const ORDER_ARGUMENTS = '{"order_id":"ord_1001"}';
const SHIP_ARGUMENTS = '{"shipment_id":"shp_2002"}';
const SECRET_MARK = 'ord_1001';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-10b');

const orderTool = {
  type: 'function' as const,
  function: {
    name: 'get_order_status',
    description: 'Read one order status.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order identifier.' },
      },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
};

const shipmentTool = {
  type: 'function' as const,
  function: {
    name: 'get_shipment',
    description: 'Read one shipment.',
    parameters: {
      type: 'object',
      properties: { shipment_id: { type: 'string' } },
      required: ['shipment_id'],
    },
  },
};

function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function' as const, function: { name, arguments: args } };
}

function assistantCall(calls: ReturnType<typeof toolCall>[]) {
  return { role: 'assistant' as const, content: null, tool_calls: calls };
}

function completion(
  model: string,
  message: Record<string, unknown>,
  finish: string,
  usage: Record<string, number> = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

function framed(text: string): string {
  return text.endsWith('\n\n') ? text : `${text.replace(/\n*$/, '')}\n\n`;
}

function streamFixture(model: string): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
  return framed(raw.replaceAll('__MODEL__', model));
}

function reply(response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body?: string) => void }, status: number, body: unknown, type = 'application/json') {
  response.writeHead(status, { 'content-type': type });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function handleToolUpstream(hit: MockHit, _request: unknown, response: Parameters<typeof reply>[0]): void {
  const body = JSON.parse(hit.body) as {
    model?: string;
    stream?: boolean;
    tools?: unknown;
    tool_choice?: unknown;
    messages?: Array<{ role?: string; content?: string | null }>;
  };
  const model = body.model ?? 'gpt-fn10b';
  if (body.stream === true) {
    reply(response, 200, streamFixture(model), 'text/event-stream');
    return;
  }
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const users = messages.filter((message) => message.role === 'user');
  const lastUser = [...users].reverse()[0]?.content ?? '';
  if (body.tools === undefined) {
    reply(response, 200, completionBody(model, 'ok'));
    return;
  }
  if (last?.role === 'tool') {
    const text = lastUser === 'Check it again.' ? 'The order is still shipped.' : 'The order is shipped.';
    reply(response, 200, completionBody(model, text, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
    return;
  }
  if (lastUser === 'Say hello.' || body.tool_choice === 'none') {
    reply(response, 200, completionBody(model, 'hello', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
    return;
  }
  if (lastUser === 'Bad arguments.') {
    reply(response, 200, completion(model, assistantCall([toolCall('call_order_1001', 'get_order_status', '[]')]), 'stop'));
    return;
  }
  if (lastUser === 'Check both orders.') {
    reply(
      response,
      200,
      completion(
        model,
        assistantCall([
          toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS),
          toolCall('call_ship_2002', 'get_shipment', SHIP_ARGUMENTS),
        ]),
        'stop',
      ),
    );
    return;
  }
  const id = lastUser === 'Check it again.' ? 'call_order_1002' : 'call_order_1001';
  reply(response, 200, completion(model, assistantCall([toolCall(id, 'get_order_status', ORDER_ARGUMENTS)]), 'stop'));
}

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

function chatBody(model: string, messages: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model, messages, ...extra });
}

function wideSchema(count: number, extraOnLast = 0): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const suffix = index === count - 1 ? 'x'.repeat(extraOnLast) : '';
    const name = `field_${String(index).padStart(2, '0')}${suffix}`;
    properties[name] = { type: 'string', description: 'd'.repeat(512) };
  }
  return { type: 'object', additionalProperties: false, properties };
}

function functionTools(count: number, parameters: Record<string, unknown>) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'function' as const,
    function: { name: `fn_${String(index).padStart(2, '0')}`, parameters },
  }));
}

describe('function tool validation', () => {
  it('accepts a function tool and rejects unsupported schemas', () => {
    const parsed = validateChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: [orderTool],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
      parallel_tool_calls: true,
    });
    expect(parsed.optional.tools).toHaveLength(1);
    expect(parsed.optional.tool_choice).toEqual({ type: 'function', function: { name: 'get_order_status' } });
    expect(() => assertToolProvider(parsed, 'openai')).not.toThrow();
    expect(() => assertToolProvider(parsed, 'anthropic')).toThrow(/tools is not supported/i);
    expect(() => assertToolProvider(parsed, 'xai')).toThrow(/tools is not supported/i);
    expect(() => assertCapabilities(parsed, ['tools', 'tool_choice'])).toThrow(/parallel_tool_calls is not supported by this model/i);
    expect(() => assertCapabilities(parsed, ['tools', 'tool_choice', 'parallel_tool_calls'])).not.toThrow();
    expect(() => validateChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], tools: [] })).toThrow(/1 to 32/i);
    expect(() => validateChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], functions: [] })).toThrow(/functions is not supported/i);
    expect(() => validateChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], function_call: 'auto' })).toThrow(/function_call is not supported/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_order_status', strict: true } }],
      }),
    ).toThrow(/strict function tools are not supported/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_order_status', parameters: { type: 'object', $ref: '#/defs/order' } } }],
      }),
    ).toThrow(/\$ref is not a supported schema keyword/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [orderTool],
        tool_choice: { type: 'function', function: { name: 'missing_fn' } },
      }),
    ).toThrow(/The function is missing/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [
          { role: 'user', content: 'Check the order.' },
          assistantCall([toolCall('call_order_1001', 'missing_fn', ORDER_ARGUMENTS)]),
        ],
        tools: [orderTool],
      }),
    ).toThrow(/The function is missing/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [
          { role: 'user', content: 'Check the order.' },
          assistantCall([toolCall('call_order_1001', 'get_order_status', '[]')]),
        ],
        tools: [orderTool],
      }),
    ).toThrow(/Function arguments must be a JSON object/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [
          { role: 'user', content: 'Check the order.' },
          assistantCall([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]),
          { role: 'tool', tool_call_id: 'call_missing', content: 'shipped' },
        ],
        tools: [orderTool],
      }),
    ).toThrow(/tool result id does not match/i);
  });

  it('accepts every tools array inside the published schema limits', () => {
    const accepted = wideSchema(14, 27);
    const acceptedBytes = Buffer.byteLength(JSON.stringify(accepted), 'utf8');
    expect(acceptedBytes).toBeGreaterThanOrEqual(7900);
    expect(acceptedBytes).toBeLessThanOrEqual(8192);
    const five = validateChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: functionTools(5, accepted),
    });
    expect(five.optional.tools).toHaveLength(5);
    const full = validateChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'Check the order.' }],
      tools: functionTools(32, accepted),
    });
    expect(full.optional.tools).toHaveLength(32);
    const oversized = wideSchema(15);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(8192);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'Check the order.' }],
        tools: functionTools(1, oversized),
      }),
    ).toThrow(/schema is too large/i);
  });

  it('counts argument length and omits argument text from features, samples, and logs', async () => {
    const request = validateChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'Check the order.' },
        assistantCall([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]),
        { role: 'tool', tool_call_id: 'call_order_1001', content: 'shipped' },
      ],
      tools: [orderTool],
      tool_choice: 'required',
    });
    const features = extractRequestFeatures(featureInputFromChat(request));
    expect(JSON.stringify(features)).not.toContain(SECRET_MARK);
    expect(features.toolRequired).toBe(true);
    expect(features.inputSize).toBe('Check the order.'.length + 'shipped'.length + ORDER_ARGUMENTS.length);
    expect(inputBound(request)).toBe(features.inputSize);
    const textOnly = validateChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'Check the order.' }] });
    expect(inputBound(textOnly)).toBe('Check the order.'.length);
    expect(featureInputFromChat(textOnly).toolRequired).toBe(false);

    const payload = buildSamplePayload({
      request,
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-fn10b',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      route: {
        requestedModel: 'auto',
        deploymentName: 'tool-chat',
        provider: 'openai',
        upstreamModel: 'gpt-fn10b',
        timeoutMs: 5000,
      },
      dataClass: 'internal',
    });
    const encoded = JSON.stringify(payload);
    expect(encoded).not.toContain(SECRET_MARK);
    expect(encoded).not.toContain('get_order_status');
    expect(payload.request.parameters.temperature).toBeUndefined();
    expect(payload.request.parameters.tools).toBeUndefined();
    expect(payload.output.choices[0]?.content).toBe('');

    const captured = captureLogger();
    await captureChatSample({
      pool: {} as never,
      logger: captured.logger,
      tenantId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      request,
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-fn10b',
        choices: [],
      },
      route: {
        deploymentId: '33333333-3333-4333-8333-333333333333',
        requestedModel: 'auto',
        deploymentName: 'tool-chat',
        provider: 'openai',
        upstreamModel: 'gpt-fn10b',
        timeoutMs: 5000,
        location: null,
      },
      keyManager: { encrypt() { throw new Error('sample stored tool arguments'); } } as never,
    });
    expect(captured.lines.join('\n')).toContain('tool_round');
    expect(captured.lines.join('\n')).not.toContain(SECRET_MARK);
    const redacted = JSON.stringify(
      redact({
        arguments: ORDER_ARGUMENTS,
        note: `prefix "arguments":${JSON.stringify(ORDER_ARGUMENTS)} suffix`,
      }),
    );
    expect(redacted).not.toContain(SECRET_MARK);
    expect(redacted).toContain('[REDACTED]');

    const fields = compatibleRequestFields(
      'xai',
      { downstreamProviders: null, dataCollection: null, allowFallbacks: null, requireServingProvider: false },
      { tools: [orderTool], tool_choice: 'auto', parallel_tool_calls: true, temperature: 0.1 },
    );
    expect(fields.tools).toBeUndefined();
    expect(fields.tool_choice).toBeUndefined();
    expect(fields.parallel_tool_calls).toBeUndefined();
    expect(fields.temperature).toBe(0.1);
  });
});

describe('OpenAI function calling', () => {
  const db = loadTestDatabase();
  const apiResults: unknown[] = [];
  let executions = 0;
  const closers: Array<() => Promise<void>> = [];
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let tenant: ReturnType<typeof provisionTenant>;
  let other: ReturnType<typeof provisionTenant>;
  let port = 0;

  function runLocal(name: string, args: string): string {
    executions += 1;
    const parsed = JSON.parse(args) as { order_id?: string; shipment_id?: string };
    if (name === 'get_order_status' && parsed.order_id === 'ord_1001') return 'shipped';
    if (name === 'get_shipment' && parsed.shipment_id === 'shp_2002') return 'packed';
    throw new Error('unexpected local function call');
  }

  beforeAll(async () => {
    mock = await startMockUpstream(handleToolUpstream);
    tenant = provisionTenant(db, 'Function Tenant');
    other = provisionTenant(db, 'Function Other');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fn10b',
      deployment: 'tool-chat',
      upstreamModel: 'gpt-fn10b',
      capabilities: 'temperature,tools,tool_choice,parallel_tool_calls',
    });
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'plain-chat',
        '--upstream-model',
        'gpt-fn10b-plain',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'tools-only',
        '--upstream-model',
        'gpt-fn10b-tools',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'tools,tool_choice',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        'gpt-fn10b',
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
      ],
      cliEnv(),
    );
    enableStreaming(db, {
      tenantId: tenant.tenantId,
      deployment: 'tool-chat',
      connectTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      totalTimeoutMs: 5000,
      backpressureTimeoutMs: 5000,
    });
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-test-fn10b-other',
      deployment: 'other-chat',
      upstreamModel: 'gpt-fn10b-other',
      capabilities: 'temperature',
    });
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    });
  });

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'api-results.json'), `${JSON.stringify(apiResults, null, 2)}\n`);
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  async function post(payload: string, headers = authHeaders(tenant.tenantId, tenant.secret)) {
    const before = mock.hits.length;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload,
    });
    return { response, before, body: response.json() };
  }

  it('returns one tool call and then a final answer', async () => {
    const first = await post(chatBody('auto', [{ role: 'user', content: 'Check the order.' }], { tools: [orderTool], tool_choice: 'auto' }));
    expect(first.response.statusCode).toBe(200);
    expect(first.body.choices[0].finish_reason).toBe('tool_calls');
    expect(first.body.choices[0].message.tool_calls).toEqual([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]);
    expect(first.body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    expect(mock.hits.length).toBe(first.before + 1);
    const upstream = JSON.parse(mock.hits[first.before]?.body ?? '{}') as { tools?: unknown; tool_choice?: string };
    expect(upstream.tool_choice).toBe('auto');
    expect(Array.isArray(upstream.tools)).toBe(true);
    const result = runLocal('get_order_status', first.body.choices[0].message.tool_calls[0].function.arguments);
    expect(result).toBe('shipped');
    const second = await post(
      chatBody(
        'auto',
        [
          { role: 'user', content: 'Check the order.' },
          first.body.choices[0].message,
          { role: 'tool', tool_call_id: 'call_order_1001', content: result },
        ],
        { tools: [orderTool] },
      ),
    );
    expect(second.response.statusCode).toBe(200);
    expect(second.body.choices[0].message.content).toBe('The order is shipped.');
    expect(second.body.choices[0].finish_reason).toBe('stop');
    expect(second.body.choices[0].message.tool_calls).toBeUndefined();
    const follow = JSON.parse(mock.hits.at(-1)?.body ?? '{}') as { messages?: Array<{ role?: string; tool_call_id?: string }> };
    expect(follow.messages?.at(-1)?.role).toBe('tool');
    expect(follow.messages?.at(-1)?.tool_call_id).toBe('call_order_1001');
    expect(mock.hits.every((hit) => hit.url.startsWith('/v1/chat/completions'))).toBe(true);
    expect(ctx.lines.join('\n')).not.toContain(SECRET_MARK);
    apiResults.push({
      name: 'single-function-call',
      status: first.response.statusCode,
      finishReason: first.body.choices[0].finish_reason,
      toolCallId: 'call_order_1001',
      final: second.body.choices[0].message.content,
      localExecutions: executions,
    });
  });

  it('returns multiple tool calls and keeps both ids', async () => {
    const started = executions;
    const first = await post(
      chatBody('auto', [{ role: 'user', content: 'Check both orders.' }], {
        tools: [orderTool, shipmentTool],
        parallel_tool_calls: true,
      }),
    );
    expect(first.response.statusCode).toBe(200);
    expect(first.body.choices[0].message.tool_calls.map((call: { id: string }) => call.id)).toEqual([
      'call_order_1001',
      'call_ship_2002',
    ]);
    const sent = JSON.parse(mock.hits[first.before]?.body ?? '{}') as { parallel_tool_calls?: boolean };
    expect(sent.parallel_tool_calls).toBe(true);
    const results = first.body.choices[0].message.tool_calls.map((call: { function: { name: string; arguments: string } }) =>
      runLocal(call.function.name, call.function.arguments),
    );
    expect(results).toEqual(['shipped', 'packed']);
    expect(executions).toBe(started + 2);
    const second = await post(
      chatBody(
        'auto',
        [
          { role: 'user', content: 'Check both orders.' },
          first.body.choices[0].message,
          { role: 'tool', tool_call_id: 'call_order_1001', content: 'shipped' },
          { role: 'tool', tool_call_id: 'call_ship_2002', content: 'packed' },
        ],
        { tools: [orderTool, shipmentTool], parallel_tool_calls: true },
      ),
    );
    expect(second.body.choices[0].message.content).toBe('The order is shipped.');
    apiResults.push({ name: 'multiple-function-calls', ids: ['call_order_1001', 'call_ship_2002'], final: second.body.choices[0].message.content });
  });

  it('forwards a forced tool_choice and can return no tool', async () => {
    const forced = await post(
      chatBody('auto', [{ role: 'user', content: 'Force the status.' }], {
        tools: [orderTool],
        tool_choice: 'required',
      }),
    );
    expect(forced.body.choices[0].finish_reason).toBe('tool_calls');
    expect(JSON.parse(mock.hits[forced.before]?.body ?? '{}').tool_choice).toBe('required');
    const none = await post(
      chatBody('auto', [{ role: 'user', content: 'Say hello.' }], { tools: [orderTool], tool_choice: 'none' }),
    );
    expect(none.body.choices[0].message.content).toBe('hello');
    expect(none.body.choices[0].finish_reason).toBe('stop');
    expect(none.body.choices[0].message.tool_calls).toBeUndefined();
    expect(JSON.parse(mock.hits[none.before]?.body ?? '{}').tool_choice).toBe('none');
    apiResults.push({
      name: 'tool-choice',
      forced: forced.body.choices[0].finish_reason,
      none: none.body.choices[0].message.content,
    });
  });

  it('rejects a missing function, bad arguments, and a bad tool result id before upstream', async () => {
    const cases = [
      {
        name: 'missing-function',
        payload: chatBody('auto', [{ role: 'user', content: 'Check the order.' }], {
          tools: [orderTool],
          tool_choice: { type: 'function', function: { name: 'missing_fn' } },
        }),
      },
      {
        name: 'invalid-arguments',
        payload: chatBody(
          'auto',
          [
            { role: 'user', content: 'Check the order.' },
            assistantCall([toolCall('call_order_1001', 'get_order_status', '[]')]),
          ],
          { tools: [orderTool] },
        ),
      },
      {
        name: 'invalid-tool-result-id',
        payload: chatBody(
          'auto',
          [
            { role: 'user', content: 'Check the order.' },
            assistantCall([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]),
            { role: 'tool', tool_call_id: 'call_missing', content: 'shipped' },
          ],
          { tools: [orderTool] },
        ),
      },
      {
        name: 'unanswered-tool-call',
        payload: chatBody(
          'auto',
          [
            { role: 'user', content: 'Check the order.' },
            assistantCall([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]),
          ],
          { tools: [orderTool] },
        ),
      },
    ];
    for (const item of cases) {
      const result = await post(item.payload);
      expect(result.response.statusCode).toBe(400);
      expect(mock.hits.length).toBe(result.before);
      apiResults.push({ name: item.name, status: result.response.statusCode, code: result.body.error.code });
    }
  });

  it('rejects an invalid upstream tool call without a second provider call', async () => {
    const started = executions;
    const result = await post(chatBody('auto', [{ role: 'user', content: 'Bad arguments.' }], { tools: [orderTool] }));
    expect(result.response.statusCode).toBe(502);
    expect(result.body.error.code).toBe('invalid_upstream_response');
    expect(mock.hits.length).toBe(result.before + 1);
    expect(executions).toBe(started);
    apiResults.push({ name: 'invalid-upstream-arguments', status: 502, code: result.body.error.code });
  });

  it('rejects parallel_tool_calls and tools when the deployment does not list them', async () => {
    const parallel = await post(
      chatBody('tools-only', [{ role: 'user', content: 'Check the order.' }], {
        tools: [orderTool],
        parallel_tool_calls: true,
      }),
    );
    expect(parallel.response.statusCode).toBe(400);
    expect(parallel.body.error.code).toBe('unsupported_parameter');
    expect(parallel.body.error.param).toBe('parallel_tool_calls');
    expect(mock.hits.length).toBe(parallel.before);
    const plain = await post(chatBody('plain-chat', [{ role: 'user', content: 'Check the order.' }], { tools: [orderTool] }));
    expect(plain.response.statusCode).toBe(400);
    expect(plain.body.error.param).toBe('tools');
    expect(mock.hits.length).toBe(plain.before);
    const stream = await post(chatBody('auto', [{ role: 'user', content: 'Check the order.' }], { stream: true, tools: [orderTool] }));
    expect(stream.response.statusCode).toBe(400);
    expect(stream.body.error.code).toBe('unsupported_parameter');
    expect(mock.hits.length).toBe(stream.before);
    apiResults.push({
      name: 'permissions',
      parallel: parallel.body.error.param,
      plain: plain.body.error.param,
      stream: stream.response.statusCode,
    });
  });

  it('records tool-call token usage and cost', async () => {
    const result = await post(chatBody('auto', [{ role: 'user', content: 'Check the order.' }], { tools: [orderTool] }));
    expect(result.body.usage.total_tokens).toBe(18);
    const admin = adminPool(db);
    try {
      const rows = await admin.query<{
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        amount: string;
        cost_status: string;
      }>(
        `SELECT a.prompt_tokens, a.completion_tokens, a.total_tokens, c.amount::text AS amount, c.cost_status
         FROM model_attempts a
         JOIN attempt_costs c ON c.tenant_id = a.tenant_id AND c.attempt_id = a.id
         WHERE a.tenant_id = $1
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [tenant.tenantId],
      );
      expect(rows.rows[0]).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost_status: 'estimated' });
      expect(rows.rows[0]?.amount).toBe(addDecimal(multiplyDecimal('0.01', 11), multiplyDecimal('0.02', 7)));
      apiResults.push({ name: 'usage', tokens: rows.rows[0], amount: rows.rows[0]?.amount });
    } finally {
      await admin.end();
    }
  });

  it('keeps tenants apart', async () => {
    const ownModels = await ctx.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: authHeaders(tenant.tenantId, tenant.secret),
    });
    const otherModels = await ctx.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: authHeaders(other.tenantId, other.secret),
    });
    const ownIds = ownModels.json().data.map((item: { id: string }) => item.id);
    const otherIds = otherModels.json().data.map((item: { id: string }) => item.id);
    expect(ownIds).toContain('tool-chat');
    expect(ownIds).not.toContain('other-chat');
    expect(otherIds).toContain('other-chat');
    expect(otherIds).not.toContain('tool-chat');
    const ownAttempts = await withTenant(ctx.runtimePool, tenant.tenantId, (client) =>
      client.query<{ count: number }>('SELECT count(*)::int AS count FROM model_attempts'),
    );
    const otherAttempts = await withTenant(ctx.runtimePool, other.tenantId, (client) =>
      client.query<{ count: number }>('SELECT count(*)::int AS count FROM model_attempts'),
    );
    expect(ownAttempts.rows[0]?.count).toBeGreaterThan(0);
    expect(otherAttempts.rows[0]?.count).toBe(0);
    apiResults.push({ name: 'tenant-isolation', ownModels: ownIds, otherModels: otherIds });
  });

  it('leaves a text request and a text stream unchanged', async () => {
    const text = await post(chatBody('auto', [{ role: 'user', content: 'plain text please' }], { temperature: 0.1 }));
    expect(text.response.statusCode).toBe(200);
    expect(text.body.choices[0].message).toEqual({ role: 'assistant', content: 'ok' });
    expect(text.body.choices[0].finish_reason).toBe('stop');
    expect(text.body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const sent = JSON.parse(mock.hits[text.before]?.body ?? '{}') as Record<string, unknown>;
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.parallel_tool_calls).toBeUndefined();
    expect(sent.temperature).toBe(0.1);
    expect(sent.stream).toBe(false);
    const stream = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const payload = chatBody('auto', [{ role: 'user', content: 'plain stream please' }], { stream: true, temperature: 0.1 });
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
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    expect(stream.status).toBe(200);
    expect(stream.raw).toContain('stream-delta-alpha');
    expect(stream.raw).not.toContain('tool_calls');
    const streamBody = JSON.parse(mock.hits.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(streamBody.stream).toBe(true);
    expect(streamBody.tools).toBeUndefined();
    apiResults.push({ name: 'text-regression', content: text.body.choices[0].message.content, stream: stream.status });
  });

  it('runs the official SDK tool loop for two rounds', async () => {
    const started = executions;
    const client = new OpenAI({
      apiKey: tenant.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 10_000,
      defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
    });
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Check the order.' }];
    const transcript: unknown[] = [];
    const first = await client.chat.completions.create({
      model: 'auto',
      messages,
      tools: [orderTool],
      tool_choice: 'auto',
    });
    const firstCall = first.choices[0]?.message.tool_calls?.[0];
    if (firstCall === undefined || firstCall.type !== 'function') throw new Error('expected a function call');
    expect(firstCall.id).toBe('call_order_1001');
    expect(first.choices[0]?.finish_reason).toBe('tool_calls');
    const firstResult = runLocal(firstCall.function.name, firstCall.function.arguments);
    messages.push(first.choices[0].message);
    messages.push({ role: 'tool', tool_call_id: firstCall.id, content: firstResult });
    transcript.push({
      step: 'tool_request',
      request: { model: 'auto', messages: [{ role: 'user', content: 'Check the order.' }], tools: [orderTool], tool_choice: 'auto' },
      response: first,
    });
    transcript.push({ step: 'tool_result', tool_call_id: firstCall.id, content: firstResult, executedBy: 'application' });
    const second = await client.chat.completions.create({ model: 'auto', messages, tools: [orderTool] });
    expect(second.choices[0]?.message.content).toBe('The order is shipped.');
    transcript.push({ step: 'final', response: second });
    messages.push({ role: 'user', content: 'Check it again.' });
    const third = await client.chat.completions.create({ model: 'auto', messages, tools: [orderTool] });
    const secondCall = third.choices[0]?.message.tool_calls?.[0];
    if (secondCall === undefined || secondCall.type !== 'function') throw new Error('expected a second function call');
    expect(secondCall.id).toBe('call_order_1002');
    const secondResult = runLocal(secondCall.function.name, secondCall.function.arguments);
    messages.push(third.choices[0].message);
    messages.push({ role: 'tool', tool_call_id: secondCall.id, content: secondResult });
    transcript.push({ step: 'second_tool_request', response: third });
    transcript.push({ step: 'second_tool_result', tool_call_id: secondCall.id, content: secondResult, executedBy: 'application' });
    const fourth = await client.chat.completions.create({ model: 'auto', messages, tools: [orderTool] });
    expect(fourth.choices[0]?.message.content).toBe('The order is still shipped.');
    transcript.push({ step: 'second_final', response: fourth });
    expect(executions).toBe(started + 2);
    expect(mock.hits.every((hit) => hit.url.startsWith('/v1/chat/completions'))).toBe(true);
    const logs = ctx.lines.join('\n');
    expect(logs).not.toContain(SECRET_MARK);
    expect(logs).not.toContain(tenant.secret);
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, 'sdk-loop.json'),
      `${JSON.stringify({ synthetic: true, proxyExecutedFunction: false, localExecutions: 2, transcript }, null, 2)}\n`,
    );
    writeFileSync(join(EVIDENCE, 'proxy-logs.txt'), logs);
    apiResults.push({
      name: 'sdk-loop',
      firstId: firstCall.id,
      secondId: secondCall.id,
      final: fourth.choices[0]?.message.content,
      localExecutions: 2,
    });
  });
});

describe('function calling failures', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('does not retry a provider error and does not execute a function', async () => {
    let executions = 0;
    const mock = await startMockUpstream((_hit, _request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream blew up', type: 'server_error' } }));
    });
    const tenant = provisionTenant(db, 'Function Failure');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fn10b-fail',
      deployment: 'fail-chat',
      upstreamModel: 'gpt-fn10b-fail',
      capabilities: 'tools,tool_choice',
    });
    const ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: chatBody('auto', [{ role: 'user', content: 'Check the order.' }], { tools: [orderTool] }),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('upstream_error');
    expect(mock.hits).toHaveLength(1);
    expect(executions).toBe(0);
    expect(ctx.lines.join('\n')).not.toContain(SECRET_MARK);
  });

  it('cancels the provider call and does not execute a function', async () => {
    let executions = 0;
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = await startMockUpstream((_hit, _request, _response) => {
      release?.();
    });
    const tenant = provisionTenant(db, 'Function Cancel');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fn10b-cancel',
      deployment: 'cancel-chat',
      upstreamModel: 'gpt-fn10b-cancel',
      timeoutMs: 10_000,
      capabilities: 'tools',
    });
    const ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    const admin = adminPool(db);
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
      await mock.close();
    });
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      body: chatBody('auto', [{ role: 'user', content: 'Check the order.' }], { tools: [orderTool] }),
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toThrow();
    const started = Date.now();
    let errorCode: string | null = null;
    while (Date.now() - started < 5000) {
      const stored = await admin.query<{ error_code: string | null }>(
        'SELECT error_code FROM model_attempts WHERE tenant_id = $1',
        [tenant.tenantId],
      );
      errorCode = stored.rows[0]?.error_code ?? null;
      if (errorCode === 'request_cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errorCode).toBe('request_cancelled');
    expect(mock.hits).toHaveLength(1);
    expect(executions).toBe(0);
  });

  it('does not send a failed OpenAI tool call to another provider', async () => {
    const calls: string[] = [];
    const compatibleFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('api.x.ai') || url.includes('openrouter.ai')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-leak',
            object: 'chat.completion',
            created: 1,
            model: 'grok-fn10b-fallback',
            choices: [{ index: 0, message: { role: 'assistant', content: 'leaked from fallback' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fetch(input, init);
    };
    const mock = await startMockUpstream((_hit, _request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream blew up', type: 'server_error' } }));
    });
    const tenant = provisionTenant(db, 'Function Fallback');
    const admin = adminPool(db);
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fn10b-fallback',
      deployment: 'tool-primary',
      upstreamModel: 'gpt-fn10b-fallback',
      capabilities: 'temperature,tools,tool_choice,parallel_tool_calls',
    });
    runCli(db, ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-fn10b-fallback-key'], cliEnv());
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'xai',
        '--name',
        'xai-fallback',
        '--upstream-model',
        'grok-fn10b-fallback',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    expect(() =>
      runCli(
        db,
        [
          'set-deployment-capabilities',
          '--tenant-id',
          tenant.tenantId,
          '--deployment',
          'xai-fallback',
          '--capabilities',
          'temperature,tools,tool_choice,parallel_tool_calls',
        ],
        cliEnv(),
      ),
    ).toThrow(/deployment arguments are invalid/);
    await expect(
      admin.query('SELECT set_deployment_capabilities($1::uuid, $2, $3::text[])', [
        tenant.tenantId,
        'xai-fallback',
        ['temperature', 'tools', 'tool_choice', 'parallel_tool_calls'],
      ]),
    ).rejects.toThrow(/capabilities are invalid/);
    runCli(
      db,
      [
        'set-deployment-capabilities',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'tool-primary',
        '--capabilities',
        'temperature,tools,tool_choice,parallel_tool_calls',
      ],
      cliEnv(),
    );
    await admin.query(
      `UPDATE model_deployments
       SET validation_status = 'validated_live',
           capabilities = ARRAY['temperature','tools','tool_choice','parallel_tool_calls']::text[]
       WHERE tenant_id = $1 AND name = 'xai-fallback'`,
      [tenant.tenantId],
    );
    runCli(
      db,
      ['set-deployment-context-limit', '--tenant-id', tenant.tenantId, '--deployment', 'xai-fallback', '--context-limit', '128'],
      cliEnv(),
    );
    runCli(
      db,
      ['set-deployment-data-collection', '--tenant-id', tenant.tenantId, '--deployment', 'xai-fallback', '--data-collection', 'allow'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'set-fallback-policy',
        '--tenant-id',
        tenant.tenantId,
        '--alias',
        'auto',
        '--enabled',
        'true',
        '--deployments',
        'xai-fallback',
        '--failures',
        'upstream_error',
        '--max-attempts',
        '2',
        '--capabilities',
        'temperature',
        '--providers',
        'openai,xai',
        '--data-collection',
        'allow',
        '--min-remaining-deadline-ms',
        '0',
      ],
      cliEnv(),
    );
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      compatibleFetch,
    });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
      await mock.close();
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: chatBody(
        'auto',
        [
          { role: 'user', content: 'Check the order.' },
          assistantCall([toolCall('call_order_1001', 'get_order_status', ORDER_ARGUMENTS)]),
          { role: 'tool', tool_call_id: 'call_order_1001', content: 'shipped' },
        ],
        { tools: [orderTool], tool_choice: 'auto', parallel_tool_calls: false, temperature: 0.1 },
      ),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_parameter');
    expect(response.json().error.message).toMatch(/tools is not supported/i);
    expect(response.body).not.toContain('leaked from fallback');
    expect(mock.hits).toHaveLength(1);
    expect(calls.some((url) => url.includes('api.x.ai') || url.includes('openrouter.ai'))).toBe(false);
    expect(ctx.lines.join('\n')).not.toContain(SECRET_MARK);
    const attempts = await admin.query<{ name: string }>(
      `SELECT deployment.name
       FROM model_attempts AS attempt
       JOIN model_deployments AS deployment
         ON deployment.tenant_id = attempt.tenant_id
        AND deployment.id = attempt.deployment_id
       WHERE attempt.tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(attempts.rows.map((row) => row.name)).toEqual(['tool-primary']);
  });
});
