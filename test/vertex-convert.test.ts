import { describe, expect, it } from 'vitest';
import { toVertexRequest, normalizeVertexResponse, eventsFromVertexChunk, readVertexUsage } from '../src/inference/vertex-convert.js';
import type { ChatRequest } from '../src/inference/validate.js';

function request(partial: Partial<ChatRequest> & Pick<ChatRequest, 'messages'>): ChatRequest {
  return {
    model: 'alias',
    stream: false,
    includeUsage: false,
    taskHint: null,
    optional: {},
    ...partial,
  };
}

describe('vertex request conversion', () => {
  it('maps text messages, a leading system instruction, and supported sampling fields', () => {
    const body = toVertexRequest(
      request({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Again' },
        ],
        optional: { temperature: 0.2, max_tokens: 16, stop: ['END', 'STOP'] },
      }),
      'gemini-2.5-flash',
    );
    expect(body.model).toBe('gemini-2.5-flash');
    expect(body.config.systemInstruction).toBe('Be brief.');
    expect(body.config.temperature).toBe(0.2);
    expect(body.config.maxOutputTokens).toBe(16);
    expect(body.config.stopSequences).toEqual(['END', 'STOP']);
    expect(body.config.automaticContinuation).toBe(false);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
      { role: 'user', parts: [{ text: 'Again' }] },
    ]);
  });

  it('rejects unsupported fields, a non-leading system message, and disagreeing token limits', () => {
    expect(() => toVertexRequest(request({ messages: [{ role: 'user', content: 'Hi' }], optional: { top_p: 0.5 } }), 'm')).toThrow(
      /top_p is not supported/,
    );
    expect(() =>
      toVertexRequest(
        request({
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Later' },
          ],
        }),
        'm',
      ),
    ).toThrow(/first message/);
    expect(() =>
      toVertexRequest(
        request({
          messages: [{ role: 'user', content: 'Hi' }],
          optional: { max_tokens: 4, max_completion_tokens: 8 },
        }),
        'm',
      ),
    ).toThrow(/disagree/);
  });
});

describe('vertex response conversion', () => {
  it('keeps the serving model, visible text, safety finish, and separate token counts', () => {
    const completion = normalizeVertexResponse(
      {
        responseId: 'resp-1',
        modelVersion: 'gemini-2.5-flash-001',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { thought: true, text: 'hidden-thought' },
                { text: 'visible' },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 20,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 8,
        },
      },
      100,
      'configured-model',
    );
    expect(completion.response.model).toBe('gemini-2.5-flash-001');
    expect(completion.response.choices[0]?.message.content).toBe('visible');
    expect(completion.response.choices[0]?.finish_reason).toBe('stop');
    expect(completion.response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 20 });
    expect(JSON.stringify(completion.response)).not.toContain('hidden-thought');
    expect(completion.providerRequestId).toBe('resp-1');
    expect(completion.thoughtsTokens).toBe(8);
    expect(completion.cacheReadInputTokens).toBe(3);
    expect(completion.uncachedInputTokens).toBe(7);
    expect(completion.cacheCreationInputTokens).toBeNull();
    expect(completion.usage.completionTokens).toBe(2);
  });

  it('does not invent a total when thinking tokens are present and the provider omits one', () => {
    const usage = readVertexUsage({ promptTokenCount: 4, candidatesTokenCount: 1, thoughtsTokenCount: 5 });
    expect(usage.totalTokens).toBeNull();
    expect(usage.completionTokens).toBe(1);
    expect(usage.thoughtsTokens).toBe(5);
  });

  it('returns an empty safety outcome for a blocked prompt and rejects non-text parts', () => {
    const blocked = normalizeVertexResponse(
      { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] },
      100,
      'configured-model',
    );
    expect(blocked.response.choices[0]?.message.content).toBe('');
    expect(blocked.response.choices[0]?.finish_reason).toBe('content_filter');
    expect(blocked.stopReason).toBe('safety');
    expect(blocked.providerRequestId).toBeNull();
    expect(() =>
      normalizeVertexResponse(
        {
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }, { inlineData: { data: 'aa' } }] } }],
        },
        100,
        'configured-model',
      ),
    ).toThrow(/invalid/);
    expect(() =>
      normalizeVertexResponse({ candidates: [{ finishReason: 'LANGUAGE', content: { parts: [{ text: 'x' }] } }] }, 100, 'm'),
    ).toThrow(/invalid/);
  });

  it('converts stream chunks in order and keeps usage off the visible text', () => {
    const first = eventsFromVertexChunk(
      {
        responseId: 'resp-stream',
        modelVersion: 'gemini-served',
        candidates: [{ content: { parts: [{ text: 'Hello' }, { thought: true, text: 'secret' }] } }],
      },
      { started: false, finished: false },
      'configured',
      50,
    );
    const second = eventsFromVertexChunk(
      {
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: ' world' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 9, thoughtsTokenCount: 2 },
      },
      first.cursor,
      'configured',
      50,
    );
    expect(first.events.map((event) => event.type)).toEqual(['start', 'text_delta']);
    expect(first.events[1]).toMatchObject({ text: 'Hello' });
    expect(JSON.stringify(first.events)).not.toContain('secret');
    expect(second.events.map((event) => event.type)).toEqual(['text_delta', 'finish', 'usage']);
    expect(second.events[2]).toMatchObject({ promptTokens: 5, completionTokens: 2, totalTokens: 9, thoughtsTokens: 2 });
  });

  it('maps a verified function call onto indexed tool deltas', () => {
    const mapped = eventsFromVertexChunk(
      {
        responseId: 'resp-tool',
        modelVersion: 'gemini-served',
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
      },
      { started: false, finished: false },
      'configured',
      50,
      { allowTools: true },
    );
    expect(mapped.events.map((event) => event.type)).toEqual(['start', 'text_delta', 'tool_delta', 'tool_delta', 'finish', 'usage']);
    expect(mapped.events[2]).toMatchObject({ index: 0, id: 'call_order_1001', name: 'get_order_status', arguments: '{"order_id":"ord_1001"}' });
    expect(mapped.events[3]).toMatchObject({ index: 1, id: 'call_ship_2002', name: 'ship_order', arguments: '{"shipment_id":"shp_2002"}' });
    expect(mapped.events[4]).toMatchObject({ type: 'finish', finishReason: 'tool_calls', nativeReason: 'stop' });
    expect(() =>
      eventsFromVertexChunk(
        {
          candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { id: 'call_order_1001', name: 'get_order_status', args: { order_id: 'ord_1001' } } }] } }],
        },
        { started: true, finished: false },
        'configured',
        50,
      ),
    ).toThrow(/invalid/i);
  });
});

describe('vertex tool conversion', () => {
  const parameters = {
    type: 'object',
    properties: {
      order_id: {
        type: 'string',
        description: 'The order identifier.',
        minLength: 4,
        maxLength: 32,
      },
    },
    required: ['order_id'],
  };

  function toolRequest(extra: Record<string, unknown> = {}, schema: Record<string, unknown> = parameters): ChatRequest {
    return request({
      messages: [
        { role: 'user', content: 'Check the order.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_order_1001', type: 'function', function: { name: 'get_order_status', arguments: '{"order_id":"ord_1001"}' } },
            { id: 'call_ship_2002', type: 'function', function: { name: 'get_shipment', arguments: '{"shipment_id":"shp_2002"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_order_1001', content: 'packed' },
        { role: 'tool', tool_call_id: 'call_ship_2002', content: 'shipped' },
        { role: 'user', content: 'Thanks' },
      ],
      optional: {
        tools: [
          { type: 'function', function: { name: 'get_order_status', description: 'Read one order status.', parameters: schema } },
          { type: 'function', function: { name: 'get_shipment', parameters: { type: 'object', properties: { shipment_id: { type: 'string' } } } } },
        ],
        tool_choice: { type: 'function', function: { name: 'get_order_status' } },
        ...extra,
      },
    });
  }

  it('maps function declarations and keeps call ids in conversation order', () => {
    const body = toVertexRequest(toolRequest(), 'gemini-2.5-flash');
    expect(body.config.tools).toEqual([{
      functionDeclarations: [
        {
          name: 'get_order_status',
          description: 'Read one order status.',
          parameters: {
            type: 'OBJECT',
            properties: {
              order_id: { type: 'STRING', description: 'The order identifier.', minLength: 4, maxLength: 32 },
            },
            required: ['order_id'],
          },
        },
        {
          name: 'get_shipment',
          parameters: {
            type: 'OBJECT',
            properties: { shipment_id: { type: 'STRING' } },
          },
        },
      ],
    }]);
    expect(body.config.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_order_status'] },
    });
    expect(JSON.stringify(body)).not.toContain('additionalProperties');
    expect(body.contents.map((item) => item.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[1]?.parts).toEqual([
      { functionCall: { name: 'get_order_status', id: 'call_order_1001', args: { order_id: 'ord_1001' } } },
      { functionCall: { name: 'get_shipment', id: 'call_ship_2002', args: { shipment_id: 'shp_2002' } } },
    ]);
    expect(body.contents[2]?.parts).toEqual([
      { functionResponse: { name: 'get_order_status', id: 'call_order_1001', response: { content: 'packed' } } },
      { functionResponse: { name: 'get_shipment', id: 'call_ship_2002', response: { content: 'shipped' } } },
      { text: 'Thanks' },
    ]);
  });

  it('rejects a schema or tool choice Vertex cannot represent', () => {
    expect(() => toVertexRequest(toolRequest({ parallel_tool_calls: false }), 'gemini-2.5-flash')).toThrow(
      /parallel_tool_calls is not supported/,
    );
    const extra = {
      type: 'object',
      additionalProperties: false,
      properties: { order_id: { type: 'string' } },
    };
    expect(() => toVertexRequest(toolRequest({}, extra), 'gemini-2.5-flash')).toThrow(/additionalProperties is not supported/);
    const nullable = {
      type: 'object',
      properties: { flag: { type: 'null' } },
    };
    expect(() => toVertexRequest(toolRequest({}, nullable), 'gemini-2.5-flash')).toThrow(/schema type is not supported/);
    const numbered = {
      type: 'object',
      properties: { priority: { type: 'integer', enum: [1, 2] } },
    };
    expect(() => toVertexRequest(toolRequest({}, numbered), 'gemini-2.5-flash')).toThrow(/enum is not supported/);
  });

  it('returns provider function-call ids only for a STOP finish', () => {
    const completion = normalizeVertexResponse({
      responseId: 'resp-tool',
      modelVersion: 'gemini-2.5-flash',
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'Looking.' },
            { functionCall: { name: 'get_order_status', id: 'call_order_1001', args: { order_id: 'ord_1001' } } },
            { functionCall: { name: 'get_shipment', id: 'call_ship_2002', args: { shipment_id: 'shp_2002' } } },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    }, 100, 'configured');
    expect(completion.response.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [
          { id: 'call_order_1001', type: 'function', function: { name: 'get_order_status', arguments: '{"order_id":"ord_1001"}' } },
          { id: 'call_ship_2002', type: 'function', function: { name: 'get_shipment', arguments: '{"shipment_id":"shp_2002"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(completion.stopReason).toBe('stop');
    expect(() => normalizeVertexResponse({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ functionCall: { name: 'get_order_status', args: { order_id: 'ord_1001' } } }] },
      }],
    }, 100, 'm')).toThrow(/invalid/);
    expect(() => normalizeVertexResponse({
      candidates: [{
        finishReason: 'MAX_TOKENS',
        content: { parts: [{ functionCall: { name: 'get_order_status', id: 'call_order_1001', args: { order_id: 'ord_1001' } } }] },
      }],
    }, 100, 'm')).toThrow(/invalid/);
    expect(() => normalizeVertexResponse({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'x', functionCall: { name: 'get_order_status', id: 'call_order_1001', args: {} } }] },
      }],
    }, 100, 'm')).toThrow(/invalid/);
    expect(() => eventsFromVertexChunk({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_order_status', id: 'call_order_1001', args: { order_id: 'ord_1001' } } }] },
      }],
    }, { started: true, finished: false }, 'm', 1)).toThrow(/invalid/);
  });
});
