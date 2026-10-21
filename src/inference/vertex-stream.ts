import { normalizeVertexError } from './vertex-convert.js';
import type { VertexGenerateClient, VertexGenerateRequest } from './vertex-client.js';
import type { UpstreamStreamItem } from './openai-stream.js';
import { StreamShutdownError, StreamTimeoutError, type CanonicalEvent } from './stream.js';
import { eventsFromVertexChunk, type VertexRequestBody, type VertexStreamCursor } from './vertex-convert.js';

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

// Node does not call an abort listener that is added after the signal has
// already aborted. The proxy must stop its own wait in that case.
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function* streamVertexChat(input: {
  client: VertexGenerateClient;
  request: VertexRequestBody;
  signal: AbortSignal;
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

  const createdSeconds = Math.floor(Date.now() / 1000);
  let cursor: VertexStreamCursor = { started: false, finished: false };
  const request: VertexGenerateRequest = {
    model: input.request.model,
    contents: input.request.contents,
    config: { ...input.request.config, abortSignal: controller.signal },
  };

  let iterator: AsyncIterator<unknown> | null = null;
  try {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    const produced = input.client.generateContentStream(request);
    const iterable = isAsyncIterable(produced)
      ? produced
      : await raceAbort(Promise.resolve(produced), controller.signal);
    iterator = iterable[Symbol.asyncIterator]();
    for (;;) {
      const step = await raceAbort(iterator.next(), controller.signal);
      if (step.done) break;
      clearTimeout(connectTimer);
      armIdle();
      const mapped = eventsFromVertexChunk(step.value, cursor, input.request.model, createdSeconds);
      cursor = mapped.cursor;
      for (const event of mapped.events) {
        yield { type: 'event', event: event satisfies CanonicalEvent };
      }
    }
    clearTimeout(connectTimer);
    clearIdle();
    if (cursor.finished) yield { type: 'done' };
    else yield { type: 'closed' };
  } catch (error) {
    if (input.signal.aborted) throw normalizeVertexError(error, true);
    if (input.deadline.signal.reason instanceof StreamShutdownError) throw input.deadline.signal.reason;
    if (timedOut !== null) throw new StreamTimeoutError(timedOut);
    if (error instanceof StreamTimeoutError) throw error;
    throw normalizeVertexError(error, false);
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    clearIdle();
    input.signal.removeEventListener('abort', abort);
    input.deadline.signal.removeEventListener('abort', onDeadline);
    abort();
    const pending = iterator?.return?.();
    if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
  }
}
