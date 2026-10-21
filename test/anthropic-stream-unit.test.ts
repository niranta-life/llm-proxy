import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  eventsFromAnthropicEvent,
  initialAnthropicStreamCursor,
  itemsFromAnthropicData,
} from '../src/inference/anthropic-stream.js';
import { ProxyError } from '../src/inference/errors.js';
import { createSseDecoder, type CanonicalEvent } from '../src/inference/stream.js';
import { projectRoot } from './helpers.js';

const MODEL = 'claude-permitted';

function load(name: string, model = MODEL): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/anthropic-stream', name), 'utf8').replaceAll('__MODEL__', model);
  return raw.endsWith('\n\n') ? raw : `${raw.replace(/\n*$/, '')}\n\n`;
}

function play(name: string, model = MODEL): { events: CanonicalEvent[]; done: boolean; error: ProxyError | null } {
  const decoder = createSseDecoder();
  let cursor = initialAnthropicStreamCursor(1_700_000_000);
  const events: CanonicalEvent[] = [];
  let done = false;
  const pushed = decoder.push(Buffer.from(load(name, model)));
  const end = decoder.finish();
  try {
    for (const message of [...pushed, ...end.messages]) {
      const step = itemsFromAnthropicData(message.data, cursor, model);
      cursor = step.cursor;
      events.push(...step.events);
      done = done || step.done;
    }
  } catch (error) {
    if (!(error instanceof ProxyError)) throw error;
    return { events, done, error };
  }
  return { events, done, error: null };
}

function textOf(events: CanonicalEvent[]): string {
  return events
    .filter((event): event is Extract<CanonicalEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
}

function finishOf(events: CanonicalEvent[]): Extract<CanonicalEvent, { type: 'finish' }> | undefined {
  return events.find((event): event is Extract<CanonicalEvent, { type: 'finish' }> => event.type === 'finish');
}

describe('Anthropic stream conversion', () => {
  it('converts a text stream in block order', () => {
    const normal = play('normal.sse');
    expect(normal.error).toBeNull();
    expect(normal.done).toBe(true);
    expect(textOf(normal.events)).toBe('alpha-block');
    expect(normal.events[0]).toMatchObject({ type: 'start', id: 'msg_normal', model: MODEL });
    expect(finishOf(normal.events)).toEqual({ type: 'finish', finishReason: 'stop', nativeReason: 'end_turn' });

    const blocks = play('blocks.sse');
    expect(blocks.error).toBeNull();
    expect(textOf(blocks.events)).toBe('alpha-blockbeta-block');
    expect(blocks.events.filter((event) => event.type === 'text_delta').map((event) => event.type === 'text_delta' && event.text)).toEqual([
      'alpha-block',
      'beta-block',
    ]);
  });

  it('omits empty text, ping text, thinking text, and signature text', () => {
    const empty = play('empty.sse');
    expect(empty.error).toBeNull();
    expect(empty.done).toBe(true);
    expect(textOf(empty.events)).toBe('');
    expect(empty.events.some((event) => event.type === 'text_delta')).toBe(false);
    expect(finishOf(empty.events)?.finishReason).toBe('stop');

    const ping = play('ping.sse');
    expect(ping.error).toBeNull();
    expect(textOf(ping.events)).toBe('alpha-block');
    expect(JSON.stringify(ping.events)).not.toContain('ping-marker-text');
    expect(finishOf(ping.events)).toEqual({ type: 'finish', finishReason: 'stop', nativeReason: 'stop_sequence' });

    const thinking = play('thinking.sse');
    expect(thinking.error).toBeNull();
    expect(thinking.done).toBe(true);
    expect(textOf(thinking.events)).toBe('alpha-block');
    const encoded = JSON.stringify(thinking.events);
    expect(encoded).not.toContain('hidden-thought-marker');
    expect(encoded).not.toContain('hidden-signature-marker');
    expect(encoded).not.toContain('redacted-secret-marker');
  });

  it('keeps the latest cumulative usage and the reported cache categories', () => {
    const usage = play('usage.sse');
    expect(usage.error).toBeNull();
    expect(usage.done).toBe(true);
    const totals = usage.events.filter((event): event is Extract<CanonicalEvent, { type: 'usage' }> => event.type === 'usage');
    expect(totals.map((event) => event.completionTokens)).toEqual([1, 8, 15]);
    expect(totals[0]?.promptTokens).toBe(15);
    expect(totals[2]).toMatchObject({
      promptTokens: 15,
      completionTokens: 15,
      totalTokens: 30,
      uncachedInputTokens: 10,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    });
    expect(totals[2]?.promptTokens).not.toBe(20);
    expect(totals[2]?.completionTokens).not.toBe(24);
  });

  it('maps max_tokens and refusal onto the OpenAI finish reasons', () => {
    const length = play('max-tokens.sse');
    expect(length.error).toBeNull();
    expect(length.done).toBe(true);
    expect(finishOf(length.events)).toEqual({ type: 'finish', finishReason: 'length', nativeReason: 'max_tokens' });

    const refusal = play('refusal.sse');
    expect(refusal.error).toBeNull();
    expect(finishOf(refusal.events)).toEqual({ type: 'finish', finishReason: 'content_filter', nativeReason: 'refusal' });
  });

  it('rejects tool use, fallback, a foreign model, malformed input, and an in-stream error', () => {
    const tool = play('tool-use.sse');
    expect(tool.done).toBe(false);
    expect(tool.error?.code).toBe('invalid_upstream_response');
    expect(JSON.stringify(tool.events)).not.toContain('tool_use');
    expect(JSON.stringify(tool.events)).not.toContain('input_json_delta');
    expect(textOf(tool.events)).toBe('alpha-block');

    const fallback = play('fallback.sse');
    expect(fallback.done).toBe(false);
    expect(fallback.error?.code).toBe('invalid_upstream_response');
    expect(JSON.stringify(fallback.events)).not.toContain('fallback');
    expect(JSON.stringify(fallback.events)).not.toContain('claude-other');

    const wrong = play('wrong-model.sse');
    expect(wrong.events).toEqual([]);
    expect(wrong.done).toBe(false);
    expect(wrong.error?.code).toBe('invalid_upstream_response');

    const dated = eventsFromAnthropicEvent({
      type: 'message_start',
      message: {
        id: 'msg_dated',
        type: 'message',
        role: 'assistant',
        model: `${MODEL}-20250929`,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 4,
          output_tokens: 1,
          inference_geo: 'ignored',
          speed: 'standard',
        },
      },
    }, initialAnthropicStreamCursor(1_700_000_000), MODEL);
    expect(dated.events[0]).toMatchObject({ type: 'start', model: MODEL });
    expect(JSON.stringify(dated.events)).not.toContain('inference_geo');
    expect(JSON.stringify(dated.events)).not.toContain('standard');

    expect(() => eventsFromAnthropicEvent({
      type: 'message_start',
      message: {
        id: 'msg_alias',
        type: 'message',
        role: 'assistant',
        model: `${MODEL}-latest`,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }, initialAnthropicStreamCursor(1_700_000_000), MODEL)).toThrow(ProxyError);

    const malformed = play('malformed.sse');
    expect(malformed.done).toBe(false);
    expect(malformed.error?.code).toBe('invalid_upstream_response');

    const failure = play('error.sse');
    expect(failure.done).toBe(false);
    expect(failure.error?.code).toBe('overloaded');
    expect(textOf(failure.events)).toBe('alpha-block');
  });

  it('does not complete when message_stop is missing', () => {
    const open = play('missing-stop.sse');
    expect(open.error).toBeNull();
    expect(open.done).toBe(false);
    expect(textOf(open.events)).toBe('alpha-block');
    expect(finishOf(open.events)?.finishReason).toBe('stop');
  });

  it('rejects output-changing deltas and positive server tool counts', () => {
    let cursor = initialAnthropicStreamCursor(1_700_000_000);
    cursor = eventsFromAnthropicEvent(
      {
        type: 'message_start',
        message: {
          id: 'msg_inline',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      cursor,
      MODEL,
    ).cursor;
    cursor = eventsFromAnthropicEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      cursor,
      MODEL,
    ).cursor;
    expect(() =>
      eventsFromAnthropicEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        cursor,
        MODEL,
      ),
    ).toThrow(ProxyError);
    expect(() =>
      eventsFromAnthropicEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location' } } },
        cursor,
        MODEL,
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      eventsFromAnthropicEvent(
        { type: 'message_delta', delta: { stop_reason: 'pause_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        cursor,
        MODEL,
      ),
    ).toThrow(ProxyError);
    expect(() =>
      eventsFromAnthropicEvent({ type: 'widget', text: 'hidden-widget' }, cursor, MODEL),
    ).toThrow(ProxyError);
    expect(() =>
      eventsFromAnthropicEvent(
        {
          type: 'message_delta',
          delta: { stop_reason: null, stop_sequence: null },
          usage: { output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
        },
        cursor,
        MODEL,
      ),
    ).toThrow(ProxyError);
    const windowed = eventsFromAnthropicEvent(
      {
        type: 'message_delta',
        delta: { stop_reason: 'model_context_window_exceeded', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      cursor,
      MODEL,
    );
    expect(finishOf(windowed.events)?.finishReason).toBe('length');
  });
});
