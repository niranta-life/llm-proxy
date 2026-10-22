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
});
