import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTokenUsage, validateCompletion } from '../src/inference/adapter.js';
import { eventsFromOpenAiChunk, initialChunkCursor } from '../src/inference/stream.js';
import { projectRoot } from './helpers.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(projectRoot, 'test/fixtures/private', name), 'utf8')) as unknown;
}

describe('private OpenAI-compatible contract', () => {
  it('accepts vLLM and NIM text fixtures and does not invent missing usage', () => {
    const contract = readFileSync(join(projectRoot, 'test/fixtures/private/openai-contract.md'), 'utf8');
    expect(contract).toContain('GET /v1/models');
    expect(contract).toContain('POST /v1/chat/completions');
    expect(contract).toContain('data: [DONE]');
    expect(contract).toContain('Live DGX is not verified');
    expect(contract).not.toContain('validated_live');

    const vllm = validateCompletion(fixture('vllm-chat.json'));
    expect(vllm.response.model).toBe('meta-llama/Meta-Llama-3-8B-Instruct');
    expect(vllm.response.choices[0]?.message.content).toBe('vllm-ok');
    expect(vllm.usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });

    const nim = validateCompletion(fixture('nim-chat.json'));
    expect(nim.response.model).toBe('meta/llama-3.1-8b-instruct');
    expect(nim.response.choices[0]?.message.content).toBe('nim-ok');
    expect(nim.usage.totalTokens).toBe(12);

    const missing = validateCompletion(fixture('missing-usage.json'));
    expect(missing.response).not.toHaveProperty('usage');
    expect(missing.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
    expect(readTokenUsage(undefined)).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });

    const vllmEvents = eventsFromOpenAiChunk(fixture('vllm-chunk.json'), initialChunkCursor());
    expect(vllmEvents.events).toContainEqual({ type: 'text_delta', text: 'vllm-ok' });
    const nimEvents = eventsFromOpenAiChunk(fixture('nim-chunk.json'), initialChunkCursor());
    expect(nimEvents.events).toContainEqual({ type: 'text_delta', text: 'nim-ok' });
    expect(nimEvents.events.some((event) => event.type === 'finish')).toBe(true);
  });
});
