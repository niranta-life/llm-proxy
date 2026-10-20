import { describe, expect, it } from 'vitest';
import { readTokenUsage, validateCompletion } from '../src/inference/adapter.js';
import { normalizeUpstreamError } from '../src/inference/errors.js';
import { resolveModel, type DeploymentCandidate } from '../src/inference/resolve.js';
import { assertCapabilities, assertStreamAllowed, validateChatRequest } from '../src/inference/validate.js';
import { parseMetricsWindow } from '../src/inference/window.js';
import { APIConnectionTimeoutError, APIError } from 'openai';

const textRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('request validation', () => {
  it('accepts text messages and stream false', () => {
    const parsed = validateChatRequest({ ...textRequest, stream: false, temperature: 0.2 });
    expect(parsed.model).toBe('auto');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(parsed.optional.temperature).toBe(0.2);
  });

  it('keeps stream=true and rejects it until an OpenAI deployment allows streaming', () => {
    const parsed = validateChatRequest({ ...textRequest, stream: true, stream_options: { include_usage: true } });
    expect(parsed.stream).toBe(true);
    expect(parsed.includeUsage).toBe(true);
    expect(() => assertStreamAllowed(parsed, { provider: 'openai', streamingEnabled: false }, false)).toThrow(
      /streaming is not supported/i,
    );
    expect(() => assertStreamAllowed(parsed, { provider: 'openai', streamingEnabled: true }, false)).toThrow(
      /streaming is not supported/i,
    );
    expect(() => assertStreamAllowed(parsed, { provider: 'anthropic', streamingEnabled: true }, true)).toThrow(
      /streaming is not supported/i,
    );
    expect(() => assertStreamAllowed(parsed, { provider: 'openai', streamingEnabled: true }, true)).not.toThrow();
    expect(() => validateChatRequest({ ...textRequest, stream: 'yes' })).toThrow(/stream must be false/i);
    expect(() => validateChatRequest({ ...textRequest, stream_options: { include_usage: true } })).toThrow(
      /stream_options is not supported/i,
    );
  });

  it('rejects tools, images, audio, and unknown parameters', () => {
    expect(() => validateChatRequest({ ...textRequest, tools: [] })).toThrow(/tools is not supported/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://img' } }] }],
      }),
    ).toThrow(/text message content/i);
    expect(() =>
      validateChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'aa' } }] }],
      }),
    ).toThrow(/text message content/i);
    expect(() => validateChatRequest({ ...textRequest, base_url: 'https://evil.example/v1' })).toThrow(
      /base_url is not a supported parameter/i,
    );
    expect(() => validateChatRequest({ ...textRequest, response_format: { type: 'json_object' } })).toThrow(
      /only text response_format/i,
    );
  });

  it('rejects a supported parameter the deployment does not allow', () => {
    const parsed = validateChatRequest({ ...textRequest, temperature: 0.4 });
    expect(() => assertCapabilities(parsed, [])).toThrow(/temperature is not supported by this model/i);
    expect(() => assertCapabilities(parsed, ['temperature'])).not.toThrow();
  });
});

describe('static routing', () => {
  const shared = {
    timeoutMs: 1000,
    capabilities: ['temperature'],
    configVersion: 3,
    connectionVersion: 2,
    enabled: true,
    connectionEnabled: true,
    provider: 'openai' as const,
    endpoint: null,
    workspaceId: null,
    defaultMaxOutputTokens: null,
    streamingEnabled: false,
    streamConnectTimeoutMs: null,
    streamIdleTimeoutMs: null,
    streamTotalTimeoutMs: null,
    streamBackpressureTimeoutMs: null,
  };
  const alpha: DeploymentCandidate = {
    ...shared,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'alpha-chat',
    upstreamModel: 'gpt-alpha',
    connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  const beta: DeploymentCandidate = {
    ...shared,
    id: '22222222-2222-4222-8222-222222222222',
    name: 'beta-chat',
    upstreamModel: 'gpt-beta',
    connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };

  it('resolves an alias and an explicit deployment name deterministically', () => {
    const aliases = [{ alias: 'auto', deploymentId: alpha.id }];
    expect(resolveModel('auto', [alpha, beta], aliases)?.upstreamModel).toBe('gpt-alpha');
    expect(resolveModel('beta-chat', [alpha, beta], aliases)?.upstreamModel).toBe('gpt-beta');
    expect(resolveModel('missing', [alpha, beta], aliases)).toBeNull();
  });

  it('skips a disabled deployment or connection', () => {
    expect(resolveModel('alpha-chat', [{ ...alpha, enabled: false }], [])).toBeNull();
    expect(resolveModel('auto', [alpha], [{ alias: 'auto', deploymentId: alpha.id }])?.deploymentId).toBe(alpha.id);
    expect(resolveModel('auto', [{ ...alpha, connectionEnabled: false }], [{ alias: 'auto', deploymentId: alpha.id }])).toBeNull();
  });
});

describe('alias resolution', () => {
  it('uses only the alias target that was supplied for that tenant', () => {
    const deployment: DeploymentCandidate = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'primary',
      upstreamModel: 'gpt-4o-mini',
      timeoutMs: 1000,
      capabilities: [],
      configVersion: 1,
      connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      connectionVersion: 1,
      enabled: true,
      connectionEnabled: true,
      provider: 'openai',
      endpoint: null,
      workspaceId: null,
      defaultMaxOutputTokens: null,
      streamingEnabled: false,
      streamConnectTimeoutMs: null,
      streamIdleTimeoutMs: null,
      streamTotalTimeoutMs: null,
      streamBackpressureTimeoutMs: null,
    };
    const resolved = resolveModel('auto', [deployment], [{ alias: 'auto', deploymentId: deployment.id }]);
    expect(resolved?.upstreamModel).toBe('gpt-4o-mini');
    expect(resolved?.configVersion).toBe(1);
  });
});

describe('error normalization', () => {
  it('hides upstream error text and maps timeout, cancellation, and rate limits', () => {
    const headers = new Headers();
    const upstream = APIError.generate(
      500,
      { error: { message: 'prompt leaked sk-test-upstream-secret', type: 'server_error' } },
      'prompt leaked sk-test-upstream-secret',
      headers,
    );
    const normalized = normalizeUpstreamError(upstream, false);
    expect(normalized.status).toBe(502);
    expect(normalized.body().error.message).not.toContain('sk-test-upstream-secret');
    expect(normalizeUpstreamError(new APIConnectionTimeoutError(), false).code).toBe('timeout');
    expect(normalizeUpstreamError(new Error('socket'), true).code).toBe('request_cancelled');
    expect(
      normalizeUpstreamError(APIError.generate(429, { error: { message: 'slow' } }, 'slow', headers), false).status,
    ).toBe(429);
  });

  it('leaves missing usage unset', () => {
    expect(readTokenUsage(undefined)).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    const completion = validateCompletion({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(completion.response.usage).toBeUndefined();
    expect(completion.usage.totalTokens).toBeNull();
  });
});

describe('metrics window', () => {
  it('rejects an unbounded window', () => {
    expect(() => parseMetricsWindow('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z')).toThrow(/too large/i);
    const parsed = parseMetricsWindow('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    expect(parsed.to.getTime() - parsed.from.getTime()).toBe(86_400_000);
  });
});
