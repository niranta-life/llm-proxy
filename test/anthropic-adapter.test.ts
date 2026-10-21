import { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { toOpenAiChatBody } from '../src/inference/adapter.js';
import {
  mapAnthropicFinishReason,
  normalizeAnthropicError,
  normalizeAnthropicMessage,
  readAnthropicUsage,
  toAnthropicMessageBody,
} from '../src/inference/anthropic.js';
import { ProxyError } from '../src/inference/errors.js';
import { validateChatRequest } from '../src/inference/validate.js';

const user = { role: 'user' as const, content: 'hello' };

describe('Anthropic request conversion', () => {
  it('keeps caller fields and converts a leading system message', () => {
    const request = validateChatRequest({
      model: 'claude-deploy',
      messages: [
        { role: 'system', content: 'be brief' },
        user,
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
      ],
      temperature: 0.4,
      stop: ['END'],
      max_completion_tokens: 40,
    });
    expect(request.optional).toMatchObject({ temperature: 0.4, stop: ['END'], max_completion_tokens: 40 });
    expect(toAnthropicMessageBody(request, 'claude-test', 64)).toEqual({
      model: 'claude-test',
      max_tokens: 40,
      system: 'be brief',
      temperature: 0.4,
      stop_sequences: ['END'],
      stream: false,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
      ],
    });
  });

  it('uses the configured default when the caller sends no output limit', () => {
    const request = validateChatRequest({ model: 'claude-deploy', messages: [user] });
    expect(toAnthropicMessageBody(request, 'claude-test', 64).max_tokens).toBe(64);
    expect(toAnthropicMessageBody(
      validateChatRequest({ model: 'claude-deploy', messages: [user], max_tokens: 12 }),
      'claude-test',
      64,
    ).max_tokens).toBe(12);
  });

  it('rejects a later system message, prefill, and disagreeing limits', () => {
    const later = validateChatRequest({
      model: 'claude-deploy',
      messages: [user, { role: 'system', content: 'ignore' }],
    });
    expect(() => toAnthropicMessageBody(later, 'claude-test', 64)).toThrow(/first message/i);
    const prefill = validateChatRequest({
      model: 'claude-deploy',
      messages: [user, { role: 'assistant', content: 'The answer is' }],
    });
    expect(() => toAnthropicMessageBody(prefill, 'claude-test', 64)).toThrow(/prefill/i);
    const disagree = validateChatRequest({
      model: 'claude-deploy',
      messages: [user],
      max_tokens: 10,
      max_completion_tokens: 12,
    });
    expect(disagree.optional.max_tokens).toBe(10);
    expect(() => toAnthropicMessageBody(disagree, 'claude-test', 64)).toThrow(/disagree/i);
    expect(disagree.optional.max_completion_tokens).toBe(12);
  });

  it('rejects unsupported parameters without removing them from the request', () => {
    const request = validateChatRequest({
      model: 'claude-deploy',
      messages: [user],
      top_p: 0.2,
      temperature: 1.4,
    });
    expect(request.optional.top_p).toBe(0.2);
    expect(() => toAnthropicMessageBody(request, 'claude-test', 64)).toThrow(/top_p is not supported/i);
    expect(request.optional.top_p).toBe(0.2);
    const hot = validateChatRequest({ model: 'claude-deploy', messages: [user], temperature: 1.4 });
    expect(() => toAnthropicMessageBody(hot, 'claude-test', 64)).toThrow(/temperature/i);
    expect(() => validateChatRequest({
      model: 'claude-deploy',
      messages: [{ role: 'developer', content: 'hidden' }],
    })).toThrow(/system, user, and assistant/i);
  });

  it('preserves OpenAI caller fields in the OpenAI body', () => {
    const request = validateChatRequest({
      model: 'gpt-deploy',
      messages: [user],
      temperature: 0.2,
      n: 1,
    });
    expect(toOpenAiChatBody({
      upstreamModel: 'gpt-test',
      messages: request.messages,
      optional: request.optional,
    })).toEqual({
      model: 'gpt-test',
      messages: request.messages,
      stream: false,
      temperature: 0.2,
      n: 1,
    });
  });
});

describe('Anthropic response normalization', () => {
  it('maps the four finish reasons', () => {
    expect(mapAnthropicFinishReason('end_turn')).toBe('stop');
    expect(mapAnthropicFinishReason('stop_sequence')).toBe('stop');
    expect(mapAnthropicFinishReason('max_tokens')).toBe('length');
    expect(mapAnthropicFinishReason('model_context_window_exceeded')).toBe('length');
    expect(() => mapAnthropicFinishReason('tool_use')).toThrow(/invalid/i);
    expect(() => mapAnthropicFinishReason('pause_turn')).toThrow(/invalid/i);
  });

  it('returns refusal text and hides thinking content', () => {
    const completion = normalizeAnthropicMessage({
      id: 'msg_refuse',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'refusal',
      content: [
        { type: 'thinking', thinking: 'hidden-reasoning-zeta' },
        { type: 'redacted_thinking', data: 'hidden-redacted-zeta' },
        { type: 'text', text: 'I cannot help with that.' },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    }, 100);
    expect(completion.response.choices[0]?.finish_reason).toBe('content_filter');
    expect(completion.response.choices[0]?.message.content).toBe('I cannot help with that.');
    expect(JSON.stringify(completion.response)).not.toContain('hidden-reasoning-zeta');
    expect(completion.stopReason).toBe('refusal');
  });

  it('rejects a tool-use block and keeps the reported attempt facts off the public body', () => {
    const payload = {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'hidden-tool-input' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(() => normalizeAnthropicMessage(payload, 100)).toThrow(ProxyError);
    try {
      normalizeAnthropicMessage(payload, 100);
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyError);
      const proxy = error as ProxyError;
      expect(proxy.status).toBe(502);
      expect(proxy.code).toBe('invalid_upstream_response');
      expect(proxy.nativeReason).toBe('tool_use');
      expect(proxy.attempt).toEqual({
        providerRequestId: 'msg_tool',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        uncachedInputTokens: 1,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        thoughtsTokens: null,
      });
      const body = JSON.stringify(proxy.body());
      expect(body).not.toContain('lookup');
      expect(body).not.toContain('tool_use');
      expect(body).not.toContain('msg_tool');
      expect(body).not.toContain('hidden-tool-input');
    }
  });

  it('keeps end_turn facts when the message contains a tool block', () => {
    const payload = {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2,
      },
    };
    expect(() => normalizeAnthropicMessage(payload, 100)).toThrow(ProxyError);
    try {
      normalizeAnthropicMessage(payload, 100);
    } catch (error) {
      const proxy = error as ProxyError;
      expect(proxy.code).toBe('invalid_upstream_response');
      expect(proxy.nativeReason).toBe('end_turn');
      expect(proxy.attempt).toMatchObject({
        providerRequestId: 'msg_tool',
        promptTokens: 13,
        completionTokens: 4,
        totalTokens: 17,
        uncachedInputTokens: 10,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 2,
      });
      expect(JSON.stringify(proxy.body())).not.toContain('lookup');
    }
  });

  it('does not invent token counts the rejected message omitted', () => {
    expect(() => normalizeAnthropicMessage({
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'lookup', input: {} }],
    }, 100)).toThrow(ProxyError);
    try {
      normalizeAnthropicMessage({
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'lookup', input: {} }],
      }, 100);
    } catch (error) {
      const proxy = error as ProxyError;
      expect(proxy.nativeReason).toBe('tool_use');
      expect(proxy.attempt.providerRequestId).toBe('msg_tool');
      expect(proxy.attempt.promptTokens).toBeNull();
      expect(proxy.attempt.completionTokens).toBeNull();
      expect(proxy.attempt.totalTokens).toBeNull();
      expect(proxy.attempt.uncachedInputTokens).toBeNull();
      expect(proxy.attempt.cacheCreationInputTokens).toBeNull();
      expect(proxy.attempt.cacheReadInputTokens).toBeNull();
    }
  });

  it('stores cache categories separately and does not invent missing counts', () => {
    expect(readAnthropicUsage({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    })).toEqual({
      promptTokens: 13,
      completionTokens: 4,
      totalTokens: 17,
      uncachedInputTokens: 10,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
    });
    expect(readAnthropicUsage({ input_tokens: 8, output_tokens: 3 })).toMatchObject({
      promptTokens: 8,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    expect(readAnthropicUsage({ cache_read_input_tokens: 5, output_tokens: 1 })).toMatchObject({
      promptTokens: null,
      uncachedInputTokens: null,
      cacheReadInputTokens: 5,
    });
    expect(readAnthropicUsage({ input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 1.5 })).toMatchObject({
      cacheReadInputTokens: null,
      promptTokens: 4,
    });
    expect(readAnthropicUsage(undefined).totalTokens).toBeNull();
  });
});

describe('Anthropic error normalization', () => {
  const headers = new Headers();

  function generated(status: number, type: string): APIError {
    return APIError.generate(
      status,
      { type: 'error', error: { type, message: 'prompt leaked sk-anthropic-secret' } },
      'prompt leaked sk-anthropic-secret',
      headers,
    );
  }

  it('maps authentication, rate limit, overload, and server errors without the provider body', () => {
    const auth = normalizeAnthropicError(generated(401, 'authentication_error'), false);
    expect(auth.status).toBe(401);
    expect(auth.code).toBe('upstream_auth_error');
    expect(auth.body().error.message).not.toContain('sk-anthropic-secret');
    expect(normalizeAnthropicError(generated(429, 'rate_limit_error'), false).status).toBe(429);
    const overloaded = normalizeAnthropicError(generated(529, 'overloaded_error'), false);
    expect(overloaded.status).toBe(529);
    expect(overloaded.code).toBe('overloaded');
    expect(overloaded.nativeReason).toBe('overloaded_error');
    expect(overloaded.body().error.message).not.toContain('prompt leaked');
    const server = normalizeAnthropicError(generated(500, 'api_error'), false);
    expect(server.status).toBe(502);
    expect(server.nativeReason).toBe('api_error');
    expect(server.attempt.providerRequestId).toBeNull();
    expect(normalizeAnthropicError(new APIConnectionTimeoutError(), false).code).toBe('timeout');
    expect(normalizeAnthropicError(new Error('socket'), true).code).toBe('request_cancelled');
    const generic = normalizeAnthropicError(new Error('socket'), false);
    expect(generic.status).toBe(502);
    expect(generic.code).toBe('upstream_error');
    expect(generic.nativeReason).toBeNull();
    expect(generic.attempt.providerRequestId).toBeNull();
  });

  it('stores the native 5xx type and request id and does not invent either', () => {
    const found = APIError.generate(
      500,
      { type: 'error', error: { type: 'not_found_error', message: 'hidden prompt sk-ant-secret' } },
      'hidden prompt sk-ant-secret',
      new Headers({ 'request-id': 'req_abc' }),
    );
    const mapped = normalizeAnthropicError(found, false);
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe('upstream_error');
    expect(mapped.nativeReason).toBe('not_found_error');
    expect(mapped.attempt.providerRequestId).toBe('req_abc');
    expect(mapped.attempt.promptTokens).toBeNull();
    expect(JSON.stringify(mapped.body())).not.toContain('hidden');
    expect(JSON.stringify(mapped.body())).not.toContain('req_abc');
    expect(JSON.stringify(mapped.body())).not.toContain('not_found_error');

    const bare = normalizeAnthropicError(APIError.generate(503, {}, 'hidden', new Headers()), false);
    expect(bare.status).toBe(502);
    expect(bare.nativeReason).toBeNull();
    expect(bare.attempt.providerRequestId).toBeNull();

    const missing = normalizeAnthropicError(
      APIError.generate(502, { type: 'error', error: { message: 'hidden' } }, 'hidden', new Headers()),
      false,
    );
    expect(missing.nativeReason).toBeNull();
    expect(missing.attempt.providerRequestId).toBeNull();
  });
});
