import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_BASE_URL,
  XAI_BASE_URL,
  assertServingIdentity,
  compatibleRequestFields,
  openRouterRoutingBody,
  providerChatBaseUrl,
  readReportedProvider,
  type OpenRouterPolicy,
} from '../src/inference/compatible.js';

const restricted: OpenRouterPolicy = {
  downstreamProviders: ['anthropic'],
  dataCollection: 'deny',
  allowFallbacks: false,
  requireServingProvider: true,
};

describe('compatible provider policy', () => {
  it('keeps the approved hosts and sends only stored OpenRouter restrictions', () => {
    expect(providerChatBaseUrl('xai', 'https://evil.example/v1', 'http://127.0.0.1:9/v1')).toBe(XAI_BASE_URL);
    expect(providerChatBaseUrl('openrouter', null, 'http://127.0.0.1:9/v1')).toBe(OPENROUTER_BASE_URL);
    expect(providerChatBaseUrl('openai', null, 'http://127.0.0.1:9/v1')).toBe('http://127.0.0.1:9/v1');
    expect(openRouterRoutingBody(restricted)).toEqual({
      only: ['anthropic'],
      data_collection: 'deny',
      allow_fallbacks: false,
    });
    expect(
      openRouterRoutingBody({
        downstreamProviders: null,
        dataCollection: null,
        allowFallbacks: null,
        requireServingProvider: false,
      }),
    ).toBeUndefined();
    expect(
      compatibleRequestFields('openrouter', restricted, {
        temperature: 0.2,
        provider: { only: ['openai'] },
        models: ['other-model'],
        route: 'fallback',
      }),
    ).toEqual({
      temperature: 0.2,
      provider: { only: ['anthropic'], data_collection: 'deny', allow_fallbacks: false },
    });
    expect(compatibleRequestFields('xai', restricted, { temperature: 0.2, provider: { only: ['openai'] } })).toEqual({
      temperature: 0.2,
    });
  });

  it('does not treat a model slug or a routing object as a serving provider', () => {
    expect(readReportedProvider({ model: 'anthropic/claude-3.5', provider: { only: ['anthropic'] } })).toBeNull();
    expect(readReportedProvider({ model: 'openai/gpt-4o' })).toBeNull();
    expect(readReportedProvider({ provider: 'anthropic' })).toBe('anthropic');
    expect(readReportedProvider({ provider_name: 'google' })).toBe('google');
    expect(() => assertServingIdentity(restricted, null)).toThrow(/serving provider was not verified/i);
    expect(() => assertServingIdentity(restricted, 'google')).toThrow(/serving provider was not verified/i);
    expect(() =>
      assertServingIdentity(
        { ...restricted, requireServingProvider: false },
        'google',
      ),
    ).toThrow(/serving provider was not verified/i);
    expect(() => assertServingIdentity(restricted, 'anthropic')).not.toThrow();
    expect(() =>
      assertServingIdentity({ ...restricted, requireServingProvider: false, downstreamProviders: null }, null),
    ).not.toThrow();
  });

  it('reads the selected OpenRouter provider and matches the stored slug', () => {
    const documented = {
      model: 'openai/gpt-4o-mini',
      provider: { only: ['openai'] },
      openrouter_metadata: {
        summary: 'selected=Anthropic',
        endpoints: {
          available: [
            { provider: 'Anthropic', model: 'anthropic/claude-3.5', selected: false },
            { provider: 'OpenAI', model: 'openai/gpt-4o-mini', selected: true },
          ],
        },
      },
    };
    expect(readReportedProvider(documented)).toBeNull();
    expect(readReportedProvider(documented, true)).toBe('OpenAI');
    expect(readReportedProvider({ provider: 'anthropic' }, true)).toBe('anthropic');
    expect(readReportedProvider({ provider: 'openai', provider_name: 'openai' })).toBe('openai');
    expect(readReportedProvider({ openrouter_metadata: { summary: 'selected=OpenAI' } }, true)).toBeNull();
    expect(() =>
      readReportedProvider(
        {
          provider: 'openai',
          provider_name: 'anthropic',
        },
        true,
      ),
    ).toThrow(/serving provider was not verified/i);
    expect(() =>
      readReportedProvider(
        {
          openrouter_metadata: {
            endpoints: {
              available: [
                { provider: 'OpenAI', selected: true },
                { provider: 'Anthropic', selected: true },
              ],
            },
          },
        },
        true,
      ),
    ).toThrow(/serving provider was not verified/i);
    expect(() =>
      readReportedProvider(
        {
          provider: 'google',
          openrouter_metadata: { endpoints: { available: [{ provider: 'OpenAI', selected: true }] } },
        },
        true,
      ),
    ).toThrow(/serving provider was not verified/i);
    expect(() => assertServingIdentity({ ...restricted, downstreamProviders: ['openai'] }, 'OpenAI')).not.toThrow();
    expect(() =>
      assertServingIdentity({ ...restricted, downstreamProviders: ['openai'], requireServingProvider: false }, 'OpenAI'),
    ).not.toThrow();
    expect(() => assertServingIdentity(restricted, 'OpenAI')).toThrow(/serving provider was not verified/i);
  });
});
