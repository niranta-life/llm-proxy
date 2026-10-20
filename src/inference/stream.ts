import { proxyError } from './errors.js';

export const STREAM_STATUSES = [
  'connecting',
  'streaming',
  'completed',
  'client_aborted',
  'provider_failed',
  'timed_out',
  'stream_truncated',
  'slow_consumer',
] as const;

export type StreamStatus = (typeof STREAM_STATUSES)[number];

export type TerminalStreamStatus = Exclude<StreamStatus, 'connecting' | 'streaming'>;

export type CanonicalEvent =
  | { type: 'start'; id: string; model: string; created: number }
  | { type: 'text_delta'; text: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }
  | { type: 'finish'; finishReason: string };

export type ChunkCursor = {
  id: string | null;
  model: string | null;
  created: number | null;
  started: boolean;
};

export type StreamMachine = {
  status: StreamStatus;
  sawFinish: boolean;
  sawDone: boolean;
};

export type StreamSignal =
  | { type: 'downstream_open' }
  | { type: 'provider_finish' }
  | { type: 'provider_done' }
  | { type: 'client_abort' }
  | { type: 'provider_failure' }
  | { type: 'timeout'; timer: 'connect' | 'idle' | 'total' }
  | { type: 'backpressure_timeout' }
  | { type: 'upstream_closed' };

export type SseHeader = {
  id: string;
  model: string;
  created: number;
};

export type SseMessage = {
  data: string;
  done: boolean;
};

const TERMINAL = new Set<StreamStatus>([
  'completed',
  'client_aborted',
  'provider_failed',
  'timed_out',
  'stream_truncated',
  'slow_consumer',
]);

export class SlowConsumerError extends Error {
  readonly code = 'slow_consumer';

  constructor() {
    super('slow consumer');
    this.name = 'SlowConsumerError';
  }
}

export class StreamTimeoutError extends Error {
  readonly timer: 'connect' | 'idle' | 'total';

  constructor(timer: 'connect' | 'idle' | 'total') {
    super('timeout');
    this.name = 'StreamTimeoutError';
    this.timer = timer;
  }
}

export function initialChunkCursor(): ChunkCursor {
  return { id: null, model: null, created: null, started: false };
}

export function initialStreamMachine(): StreamMachine {
  return { status: 'connecting', sawFinish: false, sawDone: false };
}

export function isTerminalStatus(status: StreamStatus): status is TerminalStreamStatus {
  return TERMINAL.has(status);
}

export function reduceStream(machine: StreamMachine, signal: StreamSignal): StreamMachine {
  if (isTerminalStatus(machine.status)) return machine;
  if (signal.type === 'downstream_open') {
    if (machine.status === 'connecting') return { ...machine, status: 'streaming' };
    return machine;
  }
  if (signal.type === 'provider_finish') return { ...machine, sawFinish: true };
  if (signal.type === 'provider_done') {
    if (machine.status === 'streaming' && machine.sawFinish) {
      return { status: 'completed', sawFinish: true, sawDone: true };
    }
    return { ...machine, sawDone: true };
  }
  if (signal.type === 'upstream_closed') {
    if (machine.status === 'streaming' && machine.sawFinish && machine.sawDone) {
      return { status: 'completed', sawFinish: true, sawDone: true };
    }
    return { ...machine, status: 'stream_truncated' };
  }
  if (signal.type === 'client_abort') return { ...machine, status: 'client_aborted' };
  if (signal.type === 'provider_failure') return { ...machine, status: 'provider_failed' };
  if (signal.type === 'timeout') return { ...machine, status: 'timed_out' };
  return { ...machine, status: 'slow_consumer' };
}

export function attemptStatusFor(status: TerminalStreamStatus): 'succeeded' | 'failed' {
  return status === 'completed' ? 'succeeded' : 'failed';
}

export function streamErrorCode(status: TerminalStreamStatus, providerCode: string | null): string | null {
  if (status === 'completed') return null;
  if (status === 'client_aborted') return 'request_cancelled';
  if (status === 'timed_out') return 'timeout';
  if (status === 'slow_consumer') return 'slow_consumer';
  if (status === 'stream_truncated') return 'stream_truncated';
  if (providerCode !== null && /^[a-z0-9_]{1,64}$/.test(providerCode)) return providerCode;
  return 'upstream_error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function invalidChunk(): never {
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

export function eventsFromOpenAiChunk(
  value: unknown,
  cursor: ChunkCursor,
): { events: CanonicalEvent[]; cursor: ChunkCursor } {
  if (!isRecord(value)) invalidChunk();
  if (value.object !== undefined && value.object !== 'chat.completion.chunk') invalidChunk();
  const id =
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256 && !/\s/.test(value.id)
      ? value.id
      : null;
  const model = typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 256 ? value.model : null;
  const created = typeof value.created === 'number' && Number.isFinite(value.created) ? Math.floor(value.created) : null;
  const next: ChunkCursor = {
    id: cursor.id ?? id,
    model: cursor.model ?? model,
    created: cursor.created ?? created,
    started: cursor.started,
  };
  if (next.id === null || next.model === null || next.created === null) invalidChunk();

  const events: CanonicalEvent[] = [];
  if (!next.started) {
    events.push({ type: 'start', id: next.id, model: next.model, created: next.created });
    next.started = true;
  }

  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) invalidChunk();
    for (const choice of value.choices) {
      if (!isRecord(choice)) invalidChunk();
      if (choice.delta !== undefined && choice.delta !== null) {
        if (!isRecord(choice.delta)) invalidChunk();
        if ('tool_calls' in choice.delta || 'function_call' in choice.delta) invalidChunk();
        if (choice.delta.role !== undefined && choice.delta.role !== 'assistant') invalidChunk();
        if (choice.delta.content !== undefined) {
          if (typeof choice.delta.content !== 'string') invalidChunk();
          if (choice.delta.content.length > 0) events.push({ type: 'text_delta', text: choice.delta.content });
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(choice.finish_reason)) {
          invalidChunk();
        }
        events.push({ type: 'finish', finishReason: choice.finish_reason });
      }
    }
  }

  if (isRecord(value.usage)) {
    const usage = {
      promptTokens: readCount(value.usage.prompt_tokens),
      completionTokens: readCount(value.usage.completion_tokens),
      totalTokens: readCount(value.usage.total_tokens),
    };
    if (usage.promptTokens !== null || usage.completionTokens !== null || usage.totalTokens !== null) {
      events.push({ type: 'usage', ...usage });
    }
  }

  return { events, cursor: next };
}

export function renderChunk(event: CanonicalEvent, header: SseHeader, includeUsage: boolean): string | null {
  if (event.type === 'usage') {
    if (!includeUsage) return null;
    const usage: Record<string, number> = {};
    if (event.promptTokens !== null) usage.prompt_tokens = event.promptTokens;
    if (event.completionTokens !== null) usage.completion_tokens = event.completionTokens;
    if (event.totalTokens !== null) usage.total_tokens = event.totalTokens;
    if (Object.keys(usage).length === 0) return null;
    return frame({
      id: header.id,
      object: 'chat.completion.chunk',
      created: header.created,
      model: header.model,
      choices: [],
      usage,
    });
  }
  if (event.type === 'start') {
    return frame({
      id: header.id,
      object: 'chat.completion.chunk',
      created: header.created,
      model: header.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  }
  if (event.type === 'text_delta') {
    return frame({
      id: header.id,
      object: 'chat.completion.chunk',
      created: header.created,
      model: header.model,
      choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
    });
  }
  return frame({
    id: header.id,
    object: 'chat.completion.chunk',
    created: header.created,
    model: header.model,
    choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
  });
}

export function renderDone(): string {
  return 'data: [DONE]\n\n';
}

function frame(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

export function createSseDecoder(): {
  push(bytes: Uint8Array): SseMessage[];
  finish(): { messages: SseMessage[]; truncated: boolean };
} {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';

  function drain(): SseMessage[] {
    const messages: SseMessage[] = [];
    while (buffer.length > 0) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (match === null || match.index === undefined) break;
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const message = parseEvent(raw);
      if (message !== null) messages.push(message);
    }
    return messages;
  }

  return {
    push(bytes: Uint8Array): SseMessage[] {
      buffer += decoder.decode(bytes, { stream: true });
      return drain();
    },
    finish(): { messages: SseMessage[]; truncated: boolean } {
      buffer += decoder.decode();
      const messages = drain();
      const truncated = buffer.trim().length > 0;
      buffer = '';
      return { messages, truncated };
    },
  };
}

function parseEvent(raw: string): SseMessage | null {
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  if (text === '[DONE]') return { data: text, done: true };
  return { data: text, done: false };
}

export type FrameSocket = {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): void;
  off(event: 'drain', listener: () => void): void;
};

export function writeFrame(
  socket: FrameSocket,
  frameText: string,
  timeoutMs: number,
  signal: AbortSignal,
  deadline?: AbortSignal,
): Promise<number> {
  if (signal.aborted) return Promise.reject(abortError());
  if (deadline?.aborted) return Promise.reject(timeoutFrom(deadline));
  const accepted = socket.write(frameText);
  const bytes = Buffer.byteLength(frameText);
  if (accepted) return Promise.resolve(bytes);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SlowConsumerError());
    }, timeoutMs);
    const onDrain = (): void => {
      cleanup();
      resolve(bytes);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const onDeadline = (): void => {
      cleanup();
      reject(timeoutFrom(deadline as AbortSignal));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off('drain', onDrain);
      signal.removeEventListener('abort', onAbort);
      deadline?.removeEventListener('abort', onDeadline);
    }
    socket.once('drain', onDrain);
    signal.addEventListener('abort', onAbort, { once: true });
    deadline?.addEventListener('abort', onDeadline, { once: true });
  });
}

function timeoutFrom(signal: AbortSignal): StreamTimeoutError {
  return signal.reason instanceof StreamTimeoutError ? signal.reason : new StreamTimeoutError('total');
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export type StreamGate = {
  tryAcquire(): boolean;
  release(): void;
  active(): number;
};

export function createStreamGate(limit: number): StreamGate {
  let active = 0;
  return {
    tryAcquire(): boolean {
      if (active >= limit) return false;
      active += 1;
      return true;
    },
    release(): void {
      if (active > 0) active -= 1;
    },
    active(): number {
      return active;
    },
  };
}

export type StreamTimeouts = {
  connect: number;
  idle: number;
  total: number;
  backpressure: number;
};

export async function writeEventSequence(input: {
  events: AsyncIterable<CanonicalEvent>;
  includeUsage: boolean;
  socket: FrameSocket;
  signal: AbortSignal;
  backpressureTimeoutMs: number;
  open?: (header: SseHeader) => Promise<void>;
}): Promise<{ bytesWritten: number; chunkCount: number; wroteDone: boolean; header: SseHeader | null }> {
  let header: SseHeader | null = null;
  let bytesWritten = 0;
  let chunkCount = 0;
  let opened = false;
  let sawFinish = false;
  for await (const event of input.events) {
    if (event.type === 'start') {
      header = { id: event.id, model: event.model, created: event.created };
    }
    if (header === null) {
      throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
    }
    if (!opened) {
      if (input.open) await input.open(header);
      opened = true;
    }
    if (event.type === 'finish') sawFinish = true;
    const rendered = renderChunk(event, header, input.includeUsage);
    if (rendered === null) continue;
    bytesWritten += await writeFrame(input.socket, rendered, input.backpressureTimeoutMs, input.signal);
    chunkCount += 1;
  }
  return { bytesWritten, chunkCount, wroteDone: sawFinish, header };
}
