import { APIError } from 'openai';
import { normalizeUpstreamError, proxyError } from './errors.js';
import {
  createSseDecoder,
  eventsFromOpenAiChunk,
  initialChunkCursor,
  StreamShutdownError,
  StreamTimeoutError,
  type CanonicalEvent,
} from './stream.js';
import type { ChatMessage } from './validate.js';

export type UpstreamStreamItem =
  | { type: 'event'; event: CanonicalEvent }
  | { type: 'done' }
  | { type: 'closed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function* streamOpenAiChat(input: {
  apiKey: string;
  baseURL: string;
  upstreamModel: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  optional: Record<string, unknown>;
  includeUsage: boolean;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  deadline: AbortController;
}): AsyncGenerator<UpstreamStreamItem> {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (input.signal.aborted) controller.abort();
  else input.signal.addEventListener('abort', abort, { once: true });
  // A shutdown abort must stop a read that is blocked in the provider body.
  const onDeadline = (): void => abort();
  if (input.deadline.signal.aborted) onDeadline();
  else input.deadline.signal.addEventListener('abort', onDeadline, { once: true });

  let timedOut: 'connect' | 'idle' | 'total' | null = null;
  function expire(timer: 'connect' | 'idle' | 'total'): void {
    timedOut = timedOut ?? timer;
    if (!input.deadline.signal.aborted) input.deadline.abort(new StreamTimeoutError(timedOut));
    abort();
  }
  const totalTimer = setTimeout(() => expire('total'), input.totalTimeoutMs);
  const connectTimer = setTimeout(() => expire('connect'), input.connectTimeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function armIdle(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire('idle'), input.idleTimeoutMs);
  }

  function clearIdle(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  const body = {
    model: input.upstreamModel,
    messages: input.messages,
    stream: true,
    ...(input.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...input.optional,
  };
  const url = `${input.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const decoder = createSseDecoder();
  let cursor = initialChunkCursor();
  let sawDone = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    if (!response.ok || response.body === null) {
      await response.arrayBuffer().catch(() => undefined);
      throw normalizeUpstreamError(
        APIError.generate(response.status || 502, undefined, '', undefined),
        input.signal.aborted,
      );
    }
    armIdle();
    reader = response.body.getReader();
    while (!sawDone) {
      const read = await reader.read();
      armIdle();
      if (read.done) {
        const end = decoder.finish();
        for (const message of end.messages) {
          for (const item of itemsFromMessage(message)) {
            if (item.type === 'done') {
              sawDone = true;
              yield item;
              return;
            }
            yield item;
          }
        }
        if (!sawDone) yield { type: 'closed' };
        return;
      }
      let messages;
      try {
        messages = decoder.push(read.value);
      } catch (error) {
        throw failParse(error);
      }
      for (const message of messages) {
        for (const item of itemsFromMessage(message)) {
          if (item.type === 'done') {
            sawDone = true;
            yield item;
            await reader.cancel().catch(() => undefined);
            return;
          }
          yield item;
        }
      }
    }
  } catch (error) {
    if (input.signal.aborted) throw normalizeUpstreamError(error, true);
    if (input.deadline.signal.reason instanceof StreamShutdownError) throw input.deadline.signal.reason;
    if (timedOut !== null) throw new StreamTimeoutError(timedOut);
    if (error instanceof StreamTimeoutError) throw error;
    throw error;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    clearIdle();
    input.signal.removeEventListener('abort', abort);
    input.deadline.signal.removeEventListener('abort', onDeadline);
    abort();
    await reader?.cancel().catch(() => undefined);
  }

  function itemsFromMessage(message: { data: string; done: boolean }): UpstreamStreamItem[] {
    if (message.done) return [{ type: 'done' }];
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch (error) {
      throw failParse(error);
    }
    if (isRecord(parsed) && parsed.error !== undefined) {
      throw normalizeUpstreamError(APIError.generate(502, undefined, '', undefined), false);
    }
    const mapped = eventsFromOpenAiChunk(parsed, cursor);
    cursor = mapped.cursor;
    return mapped.events.map((event) => ({ type: 'event', event }));
  }
}

function failParse(error: unknown): Error {
  if (error instanceof Error && error.name === 'ProxyError') return error;
  return proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}
