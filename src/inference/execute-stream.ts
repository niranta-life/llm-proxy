import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { anthropicAdapter } from './anthropic.js';
import { openAiAdapter } from './adapter.js';
import { ProxyError, proxyError, safeErrorCode, safeNativeReason, safeProviderRequestId } from './errors.js';
import type { ResolvedRoute } from './resolve.js';
import { finishAttempt, insertPending, markStream } from './store.js';
import {
  attemptStatusFor,
  initialStreamMachine,
  isTerminalStatus,
  reduceStream,
  renderChunk,
  renderDone,
  SlowConsumerError,
  streamErrorCode,
  StreamTimeoutError,
  writeFrame,
  type FrameSocket,
  type StreamGate,
  type StreamTimeouts,
  type TerminalStreamStatus,
} from './stream.js';
import type { ChatRequest } from './validate.js';

export type StreamHttp = FrameSocket & {
  hijack(): void;
  writeHead(status: number, headers: Record<string, string>): void;
  end(): void;
  headersSent(): boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function elapsedMs(started: bigint): number {
  const duration = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return duration < 0 ? 0 : duration;
}

export function streamTimeouts(route: ResolvedRoute): StreamTimeouts {
  return {
    connect: route.streamConnectTimeoutMs ?? route.timeoutMs,
    idle: route.streamIdleTimeoutMs ?? route.timeoutMs,
    total: route.streamTotalTimeoutMs ?? route.timeoutMs,
    backpressure: route.streamBackpressureTimeoutMs ?? route.timeoutMs,
  };
}

export async function runChatStream(input: {
  runtimePool: Pool;
  logger: Logger;
  upstreamBaseUrl: string;
  store: ProviderCredentialStore;
  tenantId: string;
  request: ChatRequest;
  route: ResolvedRoute;
  signal: AbortSignal;
  reply: StreamHttp;
  gate: StreamGate;
}): Promise<void> {
  if (!input.gate.tryAcquire()) {
    throw proxyError(503, 'server_error', 'stream_capacity', null, 'The service is unavailable.');
  }

  let requestId = '';
  let attemptId = '';
  let apiKey = '';
  let opened = false;
  const timeouts = streamTimeouts(input.route);
  try {
    try {
      const store = input.store;
      const created = await withTenant(input.runtimePool, input.tenantId, async (client) => {
        const pending = await insertPending(client, input.tenantId, input.route);
        return {
          requestId: pending.requestId,
          attemptId: pending.attemptId,
          apiKey: store.open(pending.protectedCredential),
        };
      });
      requestId = created.requestId;
      attemptId = created.attemptId;
      apiKey = created.apiKey;
      await withTenant(input.runtimePool, input.tenantId, (client) =>
        markStream(client, { tenantId: input.tenantId, attemptId, streamStatus: 'connecting' }),
      );
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      input.logger.error('request persistence failed', { message: errorMessage(error) });
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }

    const started = process.hrtime.bigint();
    const deadline = new AbortController();
    let machine = initialStreamMachine();
    let header: { id: string; model: string; created: number } | null = null;
    let bytesWritten = 0;
    let chunkCount = 0;
    let firstTextDeltaMs: number | null = null;
    let providerCode: string | null = null;
    let stopReason: string | null = null;
    let usage = {
      promptTokens: null as number | null,
      completionTokens: null as number | null,
      totalTokens: null as number | null,
      uncachedInputTokens: null as number | null,
      cacheCreationInputTokens: null as number | null,
      cacheReadInputTokens: null as number | null,
    };
    let failure: unknown = null;

    try {
      const call = {
        apiKey,
        baseURL: input.route.provider === 'anthropic' ? input.route.endpoint ?? '' : input.upstreamBaseUrl,
        request: input.request,
        route: input.route,
        signal: input.signal,
        timeouts,
        deadline,
      };
      const iterable = input.route.provider === 'anthropic' ? anthropicAdapter.stream(call) : openAiAdapter.stream(call);
      for await (const item of iterable) {
        if (input.signal.aborted) {
          machine = reduceStream(machine, { type: 'client_abort' });
          break;
        }
        if (item.type === 'done') {
          machine = reduceStream(machine, { type: 'provider_done' });
          break;
        }
        if (item.type === 'closed') {
          machine = reduceStream(machine, { type: 'upstream_closed' });
          break;
        }
        const event = item.event;
        if (event.type === 'start') header = { id: event.id, model: event.model, created: event.created };
        if (header === null) {
          throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
        }
        if (!opened) {
          try {
            await withTenant(input.runtimePool, input.tenantId, (client) =>
              markStream(client, { tenantId: input.tenantId, attemptId, streamStatus: 'streaming' }),
            );
          } catch (error) {
            input.logger.error('request persistence failed', { message: errorMessage(error) });
            throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
          }
          input.reply.hijack();
          opened = true;
          input.reply.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          machine = reduceStream(machine, { type: 'downstream_open' });
        }
        if (event.type === 'text_delta' && firstTextDeltaMs === null) firstTextDeltaMs = elapsedMs(started);
        if (event.type === 'finish') {
          stopReason = safeNativeReason(event.nativeReason ?? event.finishReason);
          machine = reduceStream(machine, { type: 'provider_finish' });
        }
        if (event.type === 'usage') {
          usage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            uncachedInputTokens: event.uncachedInputTokens ?? null,
            cacheCreationInputTokens: event.cacheCreationInputTokens ?? null,
            cacheReadInputTokens: event.cacheReadInputTokens ?? null,
          };
        }
        const rendered = renderChunk(event, header, input.request.includeUsage);
        if (rendered === null) continue;
        bytesWritten += await writeFrame(input.reply, rendered, timeouts.backpressure, input.signal, deadline.signal);
        chunkCount += 1;
      }
    } catch (error) {
      failure = error;
      if (input.signal.aborted) machine = reduceStream(machine, { type: 'client_abort' });
      else if (error instanceof SlowConsumerError) machine = reduceStream(machine, { type: 'backpressure_timeout' });
      else if (error instanceof StreamTimeoutError) machine = reduceStream(machine, { type: 'timeout', timer: error.timer });
      else {
        machine = reduceStream(machine, { type: 'provider_failure' });
        if (error instanceof ProxyError) providerCode = error.code;
      }
    }

    if (machine.status === 'completed' && opened) {
      try {
        bytesWritten += await writeFrame(input.reply, renderDone(), timeouts.backpressure, input.signal, deadline.signal);
        chunkCount += 1;
      } catch (error) {
        failure = error;
        if (input.signal.aborted) machine = { ...machine, status: 'client_aborted' };
        else if (error instanceof SlowConsumerError) machine = { ...machine, status: 'slow_consumer' };
        else if (error instanceof StreamTimeoutError) machine = { ...machine, status: 'timed_out' };
        else machine = { ...machine, status: 'provider_failed' };
      }
    }

    if (!isTerminalStatus(machine.status)) {
      machine = reduceStream(machine, { type: 'upstream_closed' });
    }
    const terminal = machine.status as TerminalStreamStatus;
    const recordedCode = streamErrorCode(terminal, providerCode);
    await recordStream(input, {
      requestId,
      attemptId,
      status: attemptStatusFor(terminal),
      errorCode: recordedCode === null ? null : safeErrorCode(recordedCode),
      durationMs: elapsedMs(started),
      usage,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      providerRequestId: safeProviderRequestId(header?.id),
      stopReason,
      streamStatus: terminal,
      firstTextDeltaMs,
      chunkCount,
      bytesWritten,
    });

    if (opened) {
      try {
        input.reply.end();
      } catch {
        // The caller may already have closed the socket.
      }
      return;
    }
    throw httpError(terminal, failure);
  } finally {
    apiKey = '';
    input.gate.release();
  }
}

function httpError(status: TerminalStreamStatus, failure: unknown): ProxyError {
  if (status === 'provider_failed' && failure instanceof ProxyError) return failure;
  if (status === 'client_aborted') {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
  }
  if (status === 'timed_out') {
    return proxyError(504, 'server_error', 'timeout', null, 'The upstream model request timed out.', 'timeout');
  }
  if (status === 'slow_consumer') {
    return proxyError(503, 'server_error', 'slow_consumer', null, 'The service is unavailable.');
  }
  if (failure instanceof ProxyError) return failure;
  return proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

async function recordStream(
  input: { runtimePool: Pool; logger: Logger; tenantId: string },
  result: {
    requestId: string;
    attemptId: string;
    status: 'succeeded' | 'failed';
    errorCode: string | null;
    durationMs: number;
    usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
    uncachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
    providerRequestId: string | null;
    stopReason: string | null;
    streamStatus: TerminalStreamStatus;
    firstTextDeltaMs: number | null;
    chunkCount: number;
    bytesWritten: number;
  },
): Promise<void> {
  try {
    await withTenant(input.runtimePool, input.tenantId, async (client) => {
      await finishAttempt(client, {
        tenantId: input.tenantId,
        requestId: result.requestId,
        attemptId: result.attemptId,
        status: result.status,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
        usage: result.usage,
        providerRequestId: result.providerRequestId,
        stopReason: result.stopReason,
        uncachedInputTokens: result.uncachedInputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        streamStatus: result.streamStatus,
        firstTextDeltaMs: result.firstTextDeltaMs,
        chunkCount: result.chunkCount,
        bytesWritten: result.bytesWritten,
      });
    });
  } catch (error) {
    input.logger.error('attempt result was not recorded', {
      severity: 'critical',
      requestId: result.requestId,
      attemptId: result.attemptId,
      outcome: result.status,
      message: errorMessage(error),
    });
  }
}
