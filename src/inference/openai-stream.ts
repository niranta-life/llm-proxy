import { APIError } from 'openai';
import {
  OPENROUTER_METADATA_HEADER,
  OPENROUTER_METADATA_VALUE,
  readReportedProvider,
  servingIdentityError,
  servingProviderAllowed,
  type OpenRouterPolicy,
} from './compatible.js';
import { deadlineKindOf, isCallerAbort } from './execution-policy.js';
import { normalizeUpstreamError, proxyError, timeoutProxy } from './errors.js';
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
  | { type: 'done'; servingProvider?: string | null }
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
  fetchImpl?: typeof fetch;
  identity?: OpenRouterPolicy;
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
  const held: UpstreamStreamItem[] = [];
  let released = input.identity?.requireServingProvider !== true;
  let reportedProvider: string | null = null;
  let providerConflict = false;
  const doFetch = input.fetchImpl ?? fetch;

  function noteProvider(parsed: unknown): void {
    const reported = readReportedProvider(parsed, input.identity !== undefined);
    if (reported === null) return;
    if (reportedProvider !== null && reported.toLowerCase() !== reportedProvider.toLowerCase()) {
      providerConflict = true;
      reportedProvider = null;
      if (input.identity !== undefined) throw servingIdentityError();
      return;
    }
    if (providerConflict) return;
    if (
      input.identity?.downstreamProviders != null &&
      !servingProviderAllowed(reported, input.identity.downstreamProviders)
    ) {
      throw servingIdentityError();
    }
    if (reportedProvider === null) reportedProvider = reported;
    if (input.identity?.requireServingProvider === true) released = true;
  }

  function requireIdentity(): void {
    if (input.identity?.requireServingProvider !== true) return;
    if (providerConflict || reportedProvider === null) throw servingIdentityError();
  }

  function stage(item: UpstreamStreamItem): UpstreamStreamItem[] {
    if (item.type === 'done') requireIdentity();
    const stamped = item.type === 'done' && reportedProvider !== null ? { type: 'done' as const, servingProvider: reportedProvider } : item;
    if (!released) {
      held.push(stamped);
      return [];
    }
    const ready = held.length === 0 ? [stamped] : [...held.splice(0, held.length), stamped];
    return ready;
  }

  function itemsFromMessage(message: { data: string; done: boolean }): UpstreamStreamItem[] {
    if (message.done) return stage({ type: 'done' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch (error) {
      throw failParse(error);
    }
    if (isRecord(parsed) && parsed.error !== undefined) {
      throw normalizeUpstreamError(APIError.generate(502, undefined, '', undefined), false);
    }
    noteProvider(parsed);
    const mapped = eventsFromOpenAiChunk(parsed, cursor);
    cursor = mapped.cursor;
    const staged = mapped.events.flatMap((event) => stage({ type: 'event', event }));
    if (staged.length === 0 && released && held.length > 0) return held.splice(0, held.length);
    return staged;
  }

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(input.identity !== undefined ? { [OPENROUTER_METADATA_HEADER]: OPENROUTER_METADATA_VALUE } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    if (!response.ok || response.body === null) {
      await response.arrayBuffer().catch(() => undefined);
      const retryHeaders = new Headers();
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter !== null && retryAfter.trim() !== '') retryHeaders.set('retry-after', retryAfter);
      throw normalizeUpstreamError(
        APIError.generate(response.status || 502, undefined, '', retryHeaders as never),
        isCallerAbort(input.signal),
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
        if (!sawDone) {
          requireIdentity();
          for (const item of held.splice(0, held.length)) yield item;
          yield { type: 'closed' };
        }
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
    if (isCallerAbort(input.signal)) throw normalizeUpstreamError(error, true);
    const kind = deadlineKindOf(input.signal);
    if (kind !== null) throw timeoutProxy(kind);
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
}

function failParse(error: unknown): Error {
  if (error instanceof Error && error.name === 'ProxyError') return error;
  return proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}
