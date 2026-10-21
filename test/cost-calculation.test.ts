import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  calculateCost,
  costToStore,
  multiplyDecimal,
  selectPrice,
  type CalculatedCost,
  type PriceCandidate,
  type StoredUsage,
} from '../src/inference/cost.js';

function usage(partial: Partial<StoredUsage> = {}): StoredUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
    ...partial,
  };
}

function price(partial: Partial<PriceCandidate> & Pick<PriceCandidate, 'id' | 'provider' | 'model'>): PriceCandidate {
  return {
    region: null,
    serviceTier: null,
    servingProvider: null,
    effectiveAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    priceSource: 'fixture',
    verificationStatus: 'verified',
    currency: 'USD',
    inputRate: null,
    outputRate: null,
    cacheReadRate: null,
    cacheWriteRate: null,
    thinkingRate: null,
    requestFee: null,
    allocatedRate: null,
    ...partial,
  };
}

function prove(name: string, result: CalculatedCost): void {
  console.log(`COST_CALC ${JSON.stringify({ name, status: result.costStatus, amount: result.amount, allocatedStatus: result.allocatedStatus, allocatedAmount: result.allocatedAmount, priceVersionId: result.priceVersionId })}`);
}

describe('model cost calculation', () => {
  it('bills OpenAI input and output as an exact decimal', () => {
    const result = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }),
      price: price({
        id: 'openai-v1',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.000003',
        outputRate: '0.000015',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('0.0105');
    expect(result.priceVersionId).toBe('openai-v1');
    expect(result.allocatedStatus).toBeNull();
    expect(result.allocatedAmount).toBeNull();
    prove('openai-tokens', result);
  });

  it('bills a stored OpenAI cache count once', () => {
    const result = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 100, completionTokens: 10, cacheReadInputTokens: 40 }),
      price: price({
        id: 'openai-cache',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.01',
        outputRate: '0.02',
        cacheReadRate: '0.001',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('0.84');
    prove('openai-cache', result);
  });

  it('keeps an OpenAI cache count provisional when the cache rate is absent', () => {
    const result = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 100, completionTokens: 10, cacheReadInputTokens: 40 }),
      price: price({
        id: 'openai-cache-missing',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.01',
        outputRate: '0.02',
      }),
    });
    expect(result.costStatus).toBe('provisional');
    expect(result.amount).toBe('0.8');
    prove('openai-cache-unpriced', result);
  });

  it('estimates OpenAI usage when cache rates are set and cache counts are absent', () => {
    const result = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }),
      price: price({
        id: 'openai-cache-rates-absent',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.000003',
        outputRate: '0.000015',
        cacheReadRate: '0.0000015',
        cacheWriteRate: '0.00000375',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('0.0105');
    expect(result.allocatedStatus).toBeNull();
    prove('openai-cache-rates-absent', result);
  });

  it('does not bill a negative cache subtraction as input', () => {
    const result = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 10, completionTokens: 1, cacheReadInputTokens: 40 }),
      price: price({
        id: 'openai-negative',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.01',
        outputRate: '0.02',
        cacheReadRate: '0.001',
      }),
    });
    expect(result.costStatus).toBe('provisional');
    expect(result.amount).toBe('0.06');
    prove('openai-negative-cache', result);
  });

  it('bills Anthropic cache write and cache read without the summed prompt', () => {
    const result = calculateCost({
      provider: 'anthropic',
      usage: usage({
        promptTokens: 20,
        completionTokens: 2,
        uncachedInputTokens: 10,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 6,
      }),
      price: price({
        id: 'anthropic-v1',
        provider: 'anthropic',
        model: 'claude-cost',
        inputRate: '0.03',
        outputRate: '0.02',
        cacheReadRate: '0.001',
        cacheWriteRate: '0.015',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('0.406');
    prove('anthropic-cache', result);
  });

  it('bills Vertex cached input and thinking tokens once', () => {
    const result = calculateCost({
      provider: 'vertex',
      usage: usage({
        promptTokens: 100,
        completionTokens: 4,
        totalTokens: 112,
        uncachedInputTokens: 75,
        cacheReadInputTokens: 25,
        thoughtsTokens: 8,
      }),
      price: price({
        id: 'vertex-v1',
        provider: 'vertex',
        model: 'gemini-cost',
        inputRate: '0.01',
        outputRate: '0.04',
        cacheReadRate: '0.001',
        thinkingRate: '0.02',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('1.095');
    prove('vertex-usage', result);
  });

  it('does not fall back to a Vertex prompt total when uncached input is missing', () => {
    const result = calculateCost({
      provider: 'vertex',
      usage: usage({
        promptTokens: 100,
        completionTokens: 4,
        cacheReadInputTokens: 25,
        thoughtsTokens: 8,
      }),
      price: price({
        id: 'vertex-partial',
        provider: 'vertex',
        model: 'gemini-cost',
        inputRate: '0.01',
        outputRate: '0.04',
        cacheReadRate: '0.001',
        thinkingRate: '0.02',
      }),
    });
    expect(result.costStatus).toBe('provisional');
    expect(result.amount).toBe('0.345');
    prove('vertex-no-prompt-fallback', result);
  });

  it('estimates Vertex usage when cache and thinking rates are set and those counts are absent', () => {
    const result = calculateCost({
      provider: 'vertex',
      usage: usage({
        promptTokens: 100,
        completionTokens: 4,
        totalTokens: 104,
        uncachedInputTokens: 100,
      }),
      price: price({
        id: 'vertex-optional',
        provider: 'vertex',
        model: 'gemini-cost',
        inputRate: '0.01',
        outputRate: '0.04',
        cacheReadRate: '0.001',
        thinkingRate: '0.02',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('1.16');
    prove('vertex-optional-counts', result);
  });

  it('selects the OpenRouter price for the stored serving provider', () => {
    const deepinfra = price({
      id: 'deepinfra',
      provider: 'openrouter',
      model: 'route-cost',
      servingProvider: 'deepinfra',
      effectiveAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
      inputRate: '0.3',
      outputRate: '0.4',
    });
    const together = price({
      id: 'together',
      provider: 'openrouter',
      model: 'route-cost',
      servingProvider: 'together',
      effectiveAt: '2025-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
      inputRate: '1',
      outputRate: '2',
    });
    const selected = selectPrice([together, deepinfra], {
      provider: 'openrouter',
      model: 'route-cost',
      location: null,
      serviceTier: null,
      servingProvider: 'deepinfra',
      at: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(selected?.id).toBe('deepinfra');
    const result = calculateCost({
      provider: 'openrouter',
      usage: usage({ promptTokens: 2, completionTokens: 1, totalTokens: 3 }),
      price: selected,
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('1');
    expect(result.priceVersionId).toBe('deepinfra');
    prove('openrouter-serving', result);
  });

  it('treats missing usage as unknown and does not store zero', () => {
    const result = calculateCost({
      provider: 'openai',
      usage: usage(),
      price: price({
        id: 'openai-empty',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.2',
        outputRate: '0.4',
        requestFee: '0.25',
      }),
    });
    expect(result.costStatus).toBe('unknown');
    expect(result.amount).toBeNull();
    expect(result.priceVersionId).toBe('openai-empty');
    prove('missing-usage', result);
  });

  it('treats a missing price as unknown for external and DGX allocated cost', () => {
    const external = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 3, completionTokens: 2 }),
      price: null,
    });
    expect(external.costStatus).toBe('unknown');
    expect(external.amount).toBeNull();
    expect(external.priceVersionId).toBeNull();
    expect(external.allocatedStatus).toBeNull();
    const dgx = calculateCost({
      provider: 'dgx',
      usage: usage({ promptTokens: 11, completionTokens: 7, totalTokens: 40 }),
      price: null,
    });
    expect(dgx.costStatus).toBe('unknown');
    expect(dgx.amount).toBeNull();
    expect(dgx.allocatedStatus).toBe('unknown');
    expect(dgx.allocatedAmount).toBeNull();
    expect(dgx.priceVersionId).toBeNull();
    prove('missing-price', dgx);
  });

  it('marks an unverified price and partial usage as provisional', () => {
    const unverified = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 1000, completionTokens: 500 }),
      price: price({
        id: 'openai-unverified',
        provider: 'openai',
        model: 'gpt-cost',
        verificationStatus: 'unverified',
        inputRate: '0.000003',
        outputRate: '0.000015',
      }),
    });
    expect(unverified.costStatus).toBe('provisional');
    expect(unverified.amount).toBe('0.0105');
    const partial = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 5 }),
      price: price({
        id: 'openai-partial',
        provider: 'openai',
        model: 'gpt-cost',
        inputRate: '0.2',
        outputRate: '0.4',
      }),
    });
    expect(partial.costStatus).toBe('provisional');
    expect(partial.amount).toBe('1');
    prove('provisional', partial);
  });

  it('keeps a reconciled amount when a later price would calculate a new one', () => {
    const saved = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 3, completionTokens: 2 }),
      price: price({ id: 'price-old', provider: 'openai', model: 'gpt-cost', inputRate: '0.1', outputRate: '0.2' }),
    });
    const reconciled: CalculatedCost = { ...saved, costStatus: 'reconciled' };
    const later = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 3, completionTokens: 2 }),
      price: price({
        id: 'price-new',
        provider: 'openai',
        model: 'gpt-cost',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        inputRate: '0.9',
        outputRate: '0.9',
      }),
    });
    expect(saved.amount).toBe('0.7');
    expect(later.amount).toBe('4.5');
    expect(costToStore(reconciled, later)).toEqual(reconciled);
    const early = selectPrice(
      [
        price({ id: 'price-old', provider: 'openai', model: 'gpt-cost', effectiveAt: '2024-01-01T00:00:00.000Z', inputRate: '0.1', outputRate: '0.2' }),
        price({ id: 'price-new', provider: 'openai', model: 'gpt-cost', effectiveAt: '2026-06-01T00:00:00.000Z', inputRate: '0.9', outputRate: '0.9' }),
      ],
      {
        provider: 'openai',
        model: 'gpt-cost',
        location: null,
        serviceTier: null,
        servingProvider: null,
        at: new Date('2026-01-01T00:00:00.000Z'),
      },
    );
    expect(early?.id).toBe('price-old');
    prove('historical', reconciled);
  });

  it('costs a failed attempt when usage is stored and leaves a failed attempt unknown without usage', () => {
    const withUsage = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 1000, completionTokens: 500 }),
      price: price({ id: 'failed-priced', provider: 'openai', model: 'gpt-cost', inputRate: '0.000003', outputRate: '0.000015' }),
    });
    const withoutUsage = calculateCost({
      provider: 'openai',
      usage: usage(),
      price: price({ id: 'failed-empty', provider: 'openai', model: 'gpt-cost', inputRate: '0.000003', outputRate: '0.000015' }),
    });
    expect(withUsage.costStatus).toBe('estimated');
    expect(withUsage.amount).toBe('0.0105');
    expect(withoutUsage.costStatus).toBe('unknown');
    expect(withoutUsage.amount).toBeNull();
    prove('failed-with-usage', withUsage);
    prove('failed-without-usage', withoutUsage);
  });

  it('multiplies a rate that is not a binary fraction', () => {
    expect(multiplyDecimal('0.1', 3)).toBe('0.3');
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    const result = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 1, completionTokens: 1 }),
      price: price({ id: 'fraction', provider: 'openai', model: 'gpt-cost', inputRate: '0.1', outputRate: '0.2' }),
    });
    expect(result.amount).toBe('0.3');
    expect(result.costStatus).toBe('estimated');
    prove('decimal', result);
  });

  it('keeps DGX allocated operating cost apart from the external amount', () => {
    const result = calculateCost({
      provider: 'dgx',
      usage: usage({ promptTokens: 11, completionTokens: 7, totalTokens: 40 }),
      price: price({
        id: 'dgx-v1',
        provider: 'dgx',
        model: 'dgx-cost',
        inputRate: '0.01',
        outputRate: '0.01',
        allocatedRate: '0.5',
      }),
    });
    expect(result.costStatus).toBe('estimated');
    expect(result.amount).toBe('0.18');
    expect(result.allocatedStatus).toBe('estimated');
    expect(result.allocatedAmount).toBe('9');
    prove('dgx-allocated', result);
  });

  it('prefers a region price and a service tier price over a later generic price', () => {
    const generic = price({
      id: 'generic',
      provider: 'vertex',
      model: 'gemini-cost',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      inputRate: '1',
      outputRate: '1',
    });
    const region = price({
      id: 'region',
      provider: 'vertex',
      model: 'gemini-cost',
      region: 'us-central1',
      effectiveAt: '2024-01-01T00:00:00.000Z',
      inputRate: '0.01',
      outputRate: '0.04',
    });
    const tier = price({
      id: 'tier',
      provider: 'openai',
      model: 'gpt-cost',
      serviceTier: 'batch',
      effectiveAt: '2024-01-01T00:00:00.000Z',
      inputRate: '0.5',
      outputRate: '0.5',
    });
    const newerGeneric = price({
      id: 'newer',
      provider: 'openai',
      model: 'gpt-cost',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      inputRate: '0.9',
      outputRate: '0.9',
    });
    expect(
      selectPrice([generic, region], {
        provider: 'vertex',
        model: 'gemini-cost',
        location: 'us-central1',
        serviceTier: null,
        servingProvider: null,
        at: new Date('2026-06-01T00:00:00.000Z'),
      })?.id,
    ).toBe('region');
    expect(
      selectPrice([newerGeneric, tier], {
        provider: 'openai',
        model: 'gpt-cost',
        location: null,
        serviceTier: 'batch',
        servingProvider: null,
        at: new Date('2026-06-01T00:00:00.000Z'),
      })?.id,
    ).toBe('tier');
  });

  it('charges a request fee only when some usage is present', () => {
    const priced = price({
      id: 'fee',
      provider: 'openai',
      model: 'gpt-cost',
      requestFee: '0.25',
    });
    const present = calculateCost({
      provider: 'openai',
      usage: usage({ promptTokens: 0, completionTokens: 0 }),
      price: priced,
    });
    const absent = calculateCost({ provider: 'openai', usage: usage(), price: priced });
    expect(present.costStatus).toBe('estimated');
    expect(present.amount).toBe('0.25');
    expect(absent.costStatus).toBe('unknown');
    expect(absent.amount).toBeNull();
    prove('request-fee', present);
  });
});
