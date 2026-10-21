import { anthropicOrigin, mapAnthropicFinishReason, toAnthropicMessageBody } from './anthropic.js';
import type { ProviderCall } from './contract.js';
import { deadlineKindOf, isCallerAbort } from './execution-policy.js';
import { emptyAttemptFacts, ProxyError, proxyError, safeNativeReason, safeProviderRequestId, timeoutProxy, transportFor } from './errors.js';
import {
  createSseDecoder,
  jsonRequestStream,
  StreamShutdownError,
  StreamTimeoutError,
  type CanonicalEvent,
} from './stream.js';
import type { UpstreamStreamItem } from './openai-stream.js';
import type { StreamTimeouts } from './stream.js';

const ANTHROPIC_VERSION = '2023-06-01';

const USAGE_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation',
  'service_tier',
  'server_tool_use',
  'inference_geo',
  'speed',
]);

const COUNTED_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

export type AnthropicBlockKind = 'text' | 'thinking';

export type AnthropicStreamCursor = {
  phase: 'open' | 'started' | 'stopped';
  id: string | null;
  model: string | null;
  created: number;
  blocks: Array<{ index: number; kind: AnthropicBlockKind; open: boolean }>;
  stopReason: string | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  completionTokens: number | null;
};

export type AnthropicConvertResult = {
  events: CanonicalEvent[];
  cursor: AnthropicStreamCursor;
  done: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidStream(): never {
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

export function initialAnthropicStreamCursor(createdSeconds: number): AnthropicStreamCursor {
  return {
    phase: 'open',
    id: null,
    model: null,
    created: createdSeconds,
    blocks: [],
    stopReason: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    completionTokens: null,
  };
}

function copyCursor(cursor: AnthropicStreamCursor): AnthropicStreamCursor {
  return {
    ...cursor,
    blocks: cursor.blocks.map((block) => ({ ...block })),
  };
}

function readIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) invalidStream();
  return value;
}

function isConfiguredModel(reported: unknown, permittedModel: string): boolean {
  if (typeof reported !== 'string' || reported.length === 0 || reported.length > 256) return false;
  if (reported === permittedModel) return true;
  const prefix = `${permittedModel}-`;
  if (!reported.startsWith(prefix)) return false;
  return /^\d{8}$/.test(reported.slice(prefix.length));
}

function rejectForeignModel(value: Record<string, unknown>, permittedModel: string, current: string | null): void {
  const models: unknown[] = [];
  if ('model' in value) models.push(value.model);
  if (isRecord(value.message) && 'model' in value.message) models.push(value.message.model);
  if (isRecord(value.delta) && 'model' in value.delta) models.push(value.delta.model);
  for (const model of models) {
    if (!isConfiguredModel(model, permittedModel)) invalidStream();
    if (current !== null && !isConfiguredModel(model, current)) invalidStream();
  }
}

function usageEvent(cursor: AnthropicStreamCursor): CanonicalEvent | null {
  const uncached = cursor.uncachedInputTokens;
  const cacheCreation = cursor.cacheCreationInputTokens;
  const cacheRead = cursor.cacheReadInputTokens;
  const completion = cursor.completionTokens;
  let prompt: number | null = uncached;
  if (uncached !== null && (cacheCreation !== null || cacheRead !== null)) {
    prompt = uncached + (cacheCreation ?? 0) + (cacheRead ?? 0);
  }
  const total = prompt !== null && completion !== null ? prompt + completion : null;
  if (prompt === null && completion === null && total === null) return null;
  return {
    type: 'usage',
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    uncachedInputTokens: uncached,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
  };
}

function applyCount(current: number | null, value: unknown): number | null {
  if (value === null || value === undefined) return current;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalidStream();
  return value;
}

function applyUsage(cursor: AnthropicStreamCursor, value: unknown): void {
  if (!isRecord(value)) invalidStream();
  for (const key of Object.keys(value)) {
    if (!USAGE_KEYS.has(key)) invalidStream();
  }
  if ('cache_creation' in value && value.cache_creation !== null && !isRecord(value.cache_creation)) invalidStream();
  if ('service_tier' in value && value.service_tier !== null && typeof value.service_tier !== 'string') invalidStream();
  if ('inference_geo' in value && value.inference_geo !== null && typeof value.inference_geo !== 'string') invalidStream();
  if ('speed' in value && value.speed !== null && typeof value.speed !== 'string') invalidStream();
  if ('server_tool_use' in value && value.server_tool_use !== null) {
    if (!isRecord(value.server_tool_use)) invalidStream();
    for (const count of Object.values(value.server_tool_use)) {
      if (typeof count === 'number' && count > 0) invalidStream();
      if (count !== null && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) invalidStream();
    }
  }
  if ('input_tokens' in value) cursor.uncachedInputTokens = applyCount(cursor.uncachedInputTokens, value.input_tokens);
  if ('cache_creation_input_tokens' in value) {
    cursor.cacheCreationInputTokens = applyCount(cursor.cacheCreationInputTokens, value.cache_creation_input_tokens);
  }
  if ('cache_read_input_tokens' in value) {
    cursor.cacheReadInputTokens = applyCount(cursor.cacheReadInputTokens, value.cache_read_input_tokens);
  }
  if ('output_tokens' in value) cursor.completionTokens = applyCount(cursor.completionTokens, value.output_tokens);
  for (const key of COUNTED_KEYS) {
    if (key in value && value[key] !== null && value[key] !== undefined && typeof value[key] !== 'number') invalidStream();
  }
}

function pushUsage(events: CanonicalEvent[], cursor: AnthropicStreamCursor): void {
  const usage = usageEvent(cursor);
  if (usage !== null) events.push(usage);
}

function applyStop(cursor: AnthropicStreamCursor, events: CanonicalEvent[], stopReason: unknown): void {
  if (stopReason === undefined || stopReason === null) return;
  if (typeof stopReason !== 'string') invalidStream();
  if (cursor.stopReason !== null) {
    if (cursor.stopReason !== stopReason) invalidStream();
    return;
  }
  let finishReason: 'stop' | 'length' | 'content_filter';
  try {
    finishReason = mapAnthropicFinishReason(stopReason);
  } catch {
    invalidStream();
  }
  const nativeReason = safeNativeReason(stopReason);
  if (nativeReason === null) invalidStream();
  cursor.stopReason = nativeReason;
  events.push({ type: 'finish', finishReason, nativeReason });
}

function rejectCitations(block: Record<string, unknown>): void {
  if (!('citations' in block) || block.citations === null) return;
  if (!Array.isArray(block.citations) || block.citations.length > 0) invalidStream();
}

function startBlock(cursor: AnthropicStreamCursor, events: CanonicalEvent[], index: number, block: unknown): void {
  if (!isRecord(block) || typeof block.type !== 'string') invalidStream();
  if (cursor.blocks.some((item) => item.index === index)) invalidStream();
  if (block.type === 'text' || block.type === 'refusal') {
    rejectCitations(block);
    cursor.blocks.push({ index, kind: 'text', open: true });
    const raw = typeof block.text === 'string'
      ? block.text
      : block.type === 'refusal' && typeof block.refusal === 'string'
        ? block.refusal
        : undefined;
    if (raw === undefined) {
      if (block.text !== undefined) invalidStream();
      return;
    }
    if (raw.length > 0) events.push({ type: 'text_delta', text: raw });
    return;
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    cursor.blocks.push({ index, kind: 'thinking', open: true });
    return;
  }
  invalidStream();
}

function onDelta(cursor: AnthropicStreamCursor, events: CanonicalEvent[], value: Record<string, unknown>): void {
  const index = readIndex(value.index);
  const block = cursor.blocks.find((item) => item.index === index);
  if (block === undefined || !block.open) invalidStream();
  if (!isRecord(value.delta) || typeof value.delta.type !== 'string') invalidStream();
  const delta = value.delta;
  if (delta.type === 'text_delta') {
    if (block.kind !== 'text') invalidStream();
    if (typeof delta.text !== 'string') invalidStream();
    if (delta.text.length > 0) events.push({ type: 'text_delta', text: delta.text });
    return;
  }
  if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
    if (block.kind !== 'thinking') invalidStream();
    return;
  }
  invalidStream();
}

function providerStreamError(value: Record<string, unknown>): never {
  const inner = isRecord(value.error) ? value.error : {};
  const native = safeNativeReason(inner.type);
  const facts = emptyAttemptFacts();
  if (native === 'rate_limit_error') {
    throw proxyError(429, 'rate_limit_error', 'rate_limit', null, 'The upstream model request failed.', native, facts);
  }
  if (native === 'overloaded_error') {
    throw proxyError(529, 'server_error', 'overloaded', null, 'The upstream provider is overloaded.', native, facts);
  }
  if (native === 'authentication_error' || native === 'permission_error') {
    throw proxyError(401, 'authentication_error', 'upstream_auth_error', null, 'The upstream provider rejected the credential.', native, facts);
  }
  throw proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.', native, facts);
}

export function eventsFromAnthropicEvent(
  value: unknown,
  cursor: AnthropicStreamCursor,
  permittedModel: string,
): AnthropicConvertResult {
  if (!isRecord(value) || typeof value.type !== 'string') invalidStream();
  if (value.type === 'error') providerStreamError(value);
  if (value.type === 'ping') return { events: [], cursor, done: false };
  if (cursor.phase === 'stopped') invalidStream();
  rejectForeignModel(value, permittedModel, cursor.model);

  if (value.type === 'message_start') {
    if (cursor.phase !== 'open') invalidStream();
    if (!isRecord(value.message)) invalidStream();
    const message = value.message;
    if (message.type !== 'message' || message.role !== 'assistant') invalidStream();
    const id = safeProviderRequestId(message.id);
    if (id === null || !isConfiguredModel(message.model, permittedModel)) invalidStream();
    if (!Array.isArray(message.content)) invalidStream();
    const next = copyCursor(cursor);
    next.phase = 'started';
    next.id = id;
    next.model = permittedModel;
    const events: CanonicalEvent[] = [{ type: 'start', id, model: permittedModel, created: next.created }];
    if (message.usage !== undefined) applyUsage(next, message.usage);
    pushUsage(events, next);
    applyStop(next, events, message.stop_reason);
    message.content.forEach((block, index) => startBlock(next, events, index, block));
    return { events, cursor: next, done: false };
  }

  if (cursor.phase !== 'started' || cursor.id === null) invalidStream();
  const next = copyCursor(cursor);
  const events: CanonicalEvent[] = [];

  if (value.type === 'content_block_start') {
    startBlock(next, events, readIndex(value.index), value.content_block);
    return { events, cursor: next, done: false };
  }
  if (value.type === 'content_block_delta') {
    onDelta(next, events, value);
    return { events, cursor: next, done: false };
  }
  if (value.type === 'content_block_stop') {
    const index = readIndex(value.index);
    const block = next.blocks.find((item) => item.index === index);
    if (block === undefined || !block.open) invalidStream();
    block.open = false;
    return { events, cursor: next, done: false };
  }
  if (value.type === 'message_delta') {
    if (!isRecord(value.delta)) invalidStream();
    applyStop(next, events, value.delta.stop_reason);
    if (value.usage !== undefined) {
      applyUsage(next, value.usage);
      pushUsage(events, next);
    }
    return { events, cursor: next, done: false };
  }
  if (value.type === 'message_stop') {
    next.phase = 'stopped';
    return { events, cursor: next, done: true };
  }
  invalidStream();
}

export function itemsFromAnthropicData(
  data: string,
  cursor: AnthropicStreamCursor,
  permittedModel: string,
): AnthropicConvertResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    invalidStream();
  }
  return eventsFromAnthropicEvent(parsed, cursor, permittedModel);
}

function statusFailure(status: number, aborted: boolean, retryAfter: string | null): ReturnType<typeof proxyError> {
  const transport = transportFor(null, status, retryAfter);
  if (aborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
  }
  if (status === 401 || status === 403) {
    return proxyError(401, 'authentication_error', 'upstream_auth_error', null, 'The upstream provider rejected the credential.', 'authentication_error', undefined, transport);
  }
  if (status === 429) {
    return proxyError(429, 'rate_limit_error', 'rate_limit', null, 'The upstream model request failed.', 'rate_limit_error', undefined, transport);
  }
  if (status === 529) {
    return proxyError(529, 'server_error', 'overloaded', null, 'The upstream provider is overloaded.', 'overloaded_error', undefined, transport);
  }
  return proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.', null, undefined, transport);
}

export async function* streamAnthropicChat(input: {
  apiKey: string;
  baseURL: string;
  upstreamModel: string;
  request: ProviderCall['request'];
  defaultMaxOutputTokens: number | null;
  workspaceId: string | null;
  signal: AbortSignal;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  deadline: AbortController;
  fetchImpl?: typeof fetch;
  onDispatched?: () => Promise<void>;
}): AsyncGenerator<UpstreamStreamItem> {
  const controller = new AbortController();
  const abort = (): void => {
    if (controller.signal.aborted) return;
    try {
      controller.abort();
    } catch {
      // A fetch listener can throw the abort reason from abort().
    }
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

  const prepared = toAnthropicMessageBody(input.request, input.upstreamModel, input.defaultMaxOutputTokens);
  const body = { ...prepared, stream: true };
  const url = `${anthropicOrigin(input.baseURL)}/v1/messages`;
  const headers: Record<string, string> = {
    'x-api-key': input.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (input.workspaceId !== null && input.workspaceId !== '') headers['anthropic-workspace-id'] = input.workspaceId;

  const decoder = createSseDecoder();
  let cursor = initialAnthropicStreamCursor(Math.floor(Date.now() / 1000));
  let sawDone = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const doFetch = input.fetchImpl ?? fetch;
    let queued: () => void = () => undefined;
    const queuedBody = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const responsePromise = doFetch(url, {
      method: 'POST',
      headers,
      body: jsonRequestStream(JSON.stringify(body), queued),
      duplex: 'half',
      signal: controller.signal,
    });
    void responsePromise.catch(() => undefined);
    const early = await Promise.race([
      queuedBody.then(() => 'queued' as const),
      responsePromise.then(() => 'headers' as const),
    ]);
    if (early === 'queued' || early === 'headers') await input.onDispatched?.();
    const response = await responsePromise;
    clearTimeout(connectTimer);
    if (!response.ok || response.body === null) {
      await response.arrayBuffer().catch(() => undefined);
      const retryAfter = response.headers.get('retry-after');
      throw statusFailure(response.status || 502, isCallerAbort(input.signal), retryAfter === null || retryAfter.trim() === '' ? null : retryAfter.trim());
    }
    armIdle();
    reader = response.body.getReader();
    while (!sawDone) {
      const read = await reader.read();
      armIdle();
      if (read.done) {
        const end = decoder.finish();
        for (const message of end.messages) {
          for (const item of itemsFromMessage(message.data)) {
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
        for (const item of itemsFromMessage(message.data)) {
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
    if (isCallerAbort(input.signal)) throw statusFailure(408, true, null);
    const kind = deadlineKindOf(input.signal);
    if (kind !== null) throw timeoutProxy(kind);
    if (input.deadline.signal.reason instanceof StreamShutdownError) throw input.deadline.signal.reason;
    if (timedOut !== null) throw new StreamTimeoutError(timedOut);
    if (error instanceof StreamTimeoutError) throw error;
    if (error instanceof ProxyError) throw error;
    throw proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.');
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    clearIdle();
    input.signal.removeEventListener('abort', abort);
    input.deadline.signal.removeEventListener('abort', onDeadline);
    abort();
    await reader?.cancel().catch(() => undefined);
  }

  function itemsFromMessage(data: string): UpstreamStreamItem[] {
    const mapped = itemsFromAnthropicData(data, cursor, input.upstreamModel);
    cursor = mapped.cursor;
    const items: UpstreamStreamItem[] = mapped.events.map((event) => ({ type: 'event', event }));
    if (mapped.done) items.push({ type: 'done' });
    return items;
  }
}

function failParse(error: unknown): Error {
  if (error instanceof Error && error.name === 'ProxyError') return error;
  return proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

export function streamAnthropic(call: ProviderCall & { timeouts: StreamTimeouts; deadline: AbortController }): AsyncGenerator<UpstreamStreamItem> {
  return streamAnthropicChat({
    apiKey: call.apiKey,
    baseURL: call.baseURL,
    upstreamModel: call.route.upstreamModel,
    request: call.request,
    defaultMaxOutputTokens: call.route.defaultMaxOutputTokens,
    workspaceId: call.route.workspaceId,
    signal: call.signal,
    connectTimeoutMs: call.timeouts.connect,
    idleTimeoutMs: call.timeouts.idle,
    totalTimeoutMs: call.timeouts.total,
    deadline: call.deadline,
    fetchImpl: call.fetchImpl,
    onDispatched: call.onDispatched,
  });
}
