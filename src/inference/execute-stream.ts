import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { anthropicAdapter } from './anthropic.js';
import { openAiAdapter } from './adapter.js';
import type { VertexClientFactory } from './vertex-client.js';
import { vertexAdapter } from './vertex.js';
import { ProxyError, proxyError, safeErrorCode, safeNativeReason, safeProviderRequestId, timeoutProxy } from './errors.js';
import type { ResolvedRoute } from './resolve.js';
import { bindRouteTransport } from './private-serve.js';
import { recordAttemptCostSafely } from './cost-store.js';
import { finishAttempt, finishRequest, insertAttempt, insertPending, markStream } from './store.js';
import {
  deadlineKindOf,
  decideRetry,
  defaultPolicy,
  emptyAttemptTrace,
  fetchForProvider,
  isCallerAbort,
  networkFailureKind,
  policyAttempts,
  startAttemptDeadlines,
  startTotalDeadline,
  waitForRetry,
  wasDispatched,
  type AttemptTrace,
  type FailureInput,
  type PolicyInput,
} from './execution-policy.js';
import {
  attemptStatusFor,
  initialStreamMachine,
  isTerminalStatus,
  reduceStream,
  renderChunk,
  renderDone,
  SlowConsumerError,
  streamErrorCode,
  StreamShutdownError,
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
  vertexClientFactory?: VertexClientFactory;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
}): Promise<void> {
  if (
    input.route.provider !== 'anthropic' &&
    input.route.provider !== 'openai' &&
    input.route.provider !== 'vertex' &&
    input.route.provider !== 'xai' &&
    input.route.provider !== 'openrouter' &&
    input.route.provider !== 'dgx'
  ) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  const transport = await bindRouteTransport({
    runtimePool: input.runtimePool,
    tenantId: input.tenantId,
    route: input.route,
    upstreamBaseUrl: input.upstreamBaseUrl,
    fetchImpl: input.fetchImpl,
    resolveHost: input.resolveHost,
  });
  const admission = input.gate.tryAcquire(input.tenantId);
  if (admission === 'shutting_down') {
    await transport.release();
    throw proxyError(503, 'server_error', 'shutting_down', null, 'The service is unavailable.');
  }
  if (admission !== 'admitted') {
    await transport.release();
    throw proxyError(503, 'server_error', 'stream_capacity', null, 'The service is unavailable.');
  }

  let requestId = '';
  let attemptId = '';
  let apiKey = '';
  let opened = false;
  const timeouts = streamTimeouts(input.route);
  const shutdownState = { fired: false };
  let abortShutdown = (): void => {
    shutdownState.fired = true;
  };
  const untrack = input.gate.track(() => abortShutdown());
  try {
    try {
      const store = input.store;
      const created = await withTenant(input.runtimePool, input.tenantId, async (client) => {
        const pending = await insertPending(client, input.tenantId, input.route);
        return {
          requestId: pending.requestId,
          attemptId: pending.attemptId,
          apiKey: pending.protectedCredential === null ? '' : store.open(pending.protectedCredential),
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

    const requestStarted = process.hrtime.bigint();
    const { policy, deadlinesActive } = policyFor(input.route);
    const total = startTotalDeadline(deadlinesActive, policy.totalDeadlineMs);
    const deadline = new AbortController();
    abortShutdown = (): void => {
      shutdownState.fired = true;
      if (!deadline.signal.aborted) deadline.abort(new StreamShutdownError());
    };
    if (shutdownState.fired && !deadline.signal.aborted) deadline.abort(new StreamShutdownError());
    let ordinal = 1;
    try {
    while (ordinal <= policyAttempts(policy)) {
    if (deadlinesActive && elapsedMs(requestStarted) >= policy.totalDeadlineMs) {
      await recordStream(input, {
        requestId,
        attemptId,
        status: 'failed',
        errorCode: 'timeout',
        durationMs: 0,
        usage: emptyTokenUsage(),
        uncachedInputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        thoughtsTokens: null,
        providerRequestId: null,
        stopReason: 'timeout',
        streamStatus: 'timed_out',
        firstTextDeltaMs: null,
        chunkCount: 0,
        bytesWritten: 0,
        failureClass: 'total_deadline',
        dispatched: false,
        expenseCertainty: 'none',
        closeRequest: true,
      });
      throw timeoutProxy('total');
    }
    const elapsed = elapsedMs(requestStarted);
    const remaining = deadlinesActive ? Math.max(1, policy.totalDeadlineMs - elapsed) : input.route.timeoutMs;
    const attemptMs = deadlinesActive ? Math.max(1, Math.min(policy.attemptDeadlineMs, remaining)) : input.route.timeoutMs;
    const trace = emptyAttemptTrace();
    const window = startAttemptDeadlines({
      enabled: deadlinesActive,
      caller: input.signal,
      total: total.signal,
      connectionMs: policy.connectionDeadlineMs,
      attemptMs,
    });
    const started = process.hrtime.bigint();
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
      thoughtsTokens: null as number | null,
    };
    let explicitProviderRequestId = false;
    let providerRequestId: string | null = null;
    let servingProvider: string | null = null;
    let failure: unknown = null;

    try {
      if (deadline.signal.reason instanceof StreamShutdownError) {
        machine = reduceStream(machine, { type: 'shutdown' });
      } else {
      const call = {
        apiKey,
        baseURL: transport.baseURL,
        request: input.request,
        route: input.route,
        signal: window.signal,
        timeouts,
        deadline,
        tenantId: input.tenantId,
        vertexClientFactory: input.vertexClientFactory,
        fetchImpl: fetchForProvider(input.route.provider, transport.fetchImpl, trace, () => window.noteHeaders()),
        attemptTrace: trace,
        onHeaders: () => window.noteHeaders(),
      };
      const iterable =
        input.route.provider === 'anthropic'
          ? anthropicAdapter.stream(call)
          : input.route.provider === 'vertex'
            ? vertexAdapter.stream(call)
            : openAiAdapter.stream(call);
      for await (const item of iterable) {
        if (input.signal.aborted) {
          machine = reduceStream(machine, { type: 'client_abort' });
          break;
        }
        if (deadline.signal.reason instanceof StreamShutdownError) {
          machine = reduceStream(machine, { type: 'shutdown' });
          break;
        }
        if (item.type === 'done') {
          servingProvider = item.servingProvider ?? null;
          machine = reduceStream(machine, { type: 'provider_done' });
          break;
        }
        if (item.type === 'closed') {
          machine = reduceStream(machine, { type: 'upstream_closed' });
          break;
        }
        const event = item.event;
        if (event.type === 'start') {
          header = { id: event.id, model: event.model, created: event.created };
          if ('providerRequestId' in event) {
            explicitProviderRequestId = true;
            providerRequestId = event.providerRequestId ?? null;
          }
        }
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
            'x-accel-buffering': 'no',
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
            thoughtsTokens: event.thoughtsTokens ?? null,
          };
        }
        const rendered = renderChunk(event, header, input.request.includeUsage);
        if (rendered === null) continue;
        bytesWritten += await writeFrame(input.reply, rendered, timeouts.backpressure, input.signal, deadline.signal);
        chunkCount += 1;
      }
      }
    } catch (error) {
      failure = error;
      if (input.signal.aborted) machine = reduceStream(machine, { type: 'client_abort' });
      else if (error instanceof StreamShutdownError || deadline.signal.reason instanceof StreamShutdownError) {
        machine = reduceStream(machine, { type: 'shutdown' });
      } else if (error instanceof SlowConsumerError) machine = reduceStream(machine, { type: 'backpressure_timeout' });
      else if (error instanceof StreamTimeoutError) machine = reduceStream(machine, { type: 'timeout', timer: error.timer });
      else {
        machine = reduceStream(machine, { type: 'provider_failure' });
        if (error instanceof ProxyError) providerCode = error.code;
      }
    } finally {
      window.cancel();
    }

    if (machine.status === 'completed' && opened) {
      try {
        bytesWritten += await writeFrame(input.reply, renderDone(), timeouts.backpressure, input.signal, deadline.signal);
        chunkCount += 1;
      } catch (error) {
        failure = error;
        if (input.signal.aborted) machine = { ...machine, status: 'client_aborted' };
        else if (error instanceof StreamShutdownError || deadline.signal.reason instanceof StreamShutdownError) {
          machine = { ...machine, status: 'interrupted' };
        } else if (error instanceof SlowConsumerError) machine = { ...machine, status: 'slow_consumer' };
        else if (error instanceof StreamTimeoutError) machine = { ...machine, status: 'timed_out' };
        else machine = { ...machine, status: 'provider_failed' };
      }
    }

    if (!isTerminalStatus(machine.status)) {
      machine = reduceStream(machine, { type: 'upstream_closed' });
    }
    const terminal = machine.status as TerminalStreamStatus;
    const recordedCode = streamErrorCode(terminal, providerCode);
    const failed = attemptStatusFor(terminal) === 'failed';
    const facts = streamFailureFacts({
      caller: input.signal,
      attemptSignal: window.signal,
      opened,
      trace,
      failure,
      terminal,
    });
    const decision = failed
      ? decideRetry({
          policy,
          deadlinesActive,
          ordinal,
          elapsedMs: elapsedMs(requestStarted),
          nowMs: Date.now(),
          random: Math.random,
          failure: facts,
        })
      : null;
    const retry = decision !== null && decision.retry && !opened && ordinal < policyAttempts(policy);
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
      providerRequestId: explicitProviderRequestId ? providerRequestId : safeProviderRequestId(header?.id),
      thoughtsTokens: usage.thoughtsTokens,
      stopReason,
      streamStatus: terminal,
      firstTextDeltaMs,
      chunkCount,
      bytesWritten,
      servingModel: header?.model ?? null,
      servingProvider,
      failureClass: decision?.failureClass ?? null,
      dispatched: failed ? facts.dispatched : true,
      expenseCertainty: decision?.expenseCertainty ?? 'known',
      closeRequest: !retry,
    });

    if (opened) {
      try {
        input.reply.end();
      } catch {
        // The caller may already have closed the socket.
      }
      return;
    }
    if (!retry) throw httpError(terminal, failure);
    const signals = total.signal === null ? [input.signal] : [input.signal, total.signal];
    const slept = await waitForRetry(decision?.waitMs ?? 0, signals);
    if (slept !== 'ok') {
      await closeStreamRequest(input, requestId);
      if (isCallerAbort(input.signal)) {
        throw proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
      }
      throw timeoutProxy(deadlineKindOf(total.signal ?? undefined) ?? 'total');
    }
    ordinal += 1;
    if (ordinal > policyAttempts(policy)) throw httpError(terminal, failure);
    try {
      attemptId = await withTenant(input.runtimePool, input.tenantId, (client) =>
        insertAttempt(client, input.tenantId, requestId, input.route, ordinal),
      );
      await withTenant(input.runtimePool, input.tenantId, (client) =>
        markStream(client, { tenantId: input.tenantId, attemptId, streamStatus: 'connecting' }),
      );
    } catch (error) {
      await closeStreamRequest(input, requestId);
      if (error instanceof ProxyError) throw error;
      input.logger.error('request persistence failed', { message: errorMessage(error) });
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }
    }
    throw proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.');
    } finally {
      total.cancel();
    }
  } finally {
    apiKey = '';
    untrack();
    input.gate.release(input.tenantId);
    await transport.release();
  }
}

function policyFor(route: ResolvedRoute): { policy: PolicyInput; deadlinesActive: boolean } {
  const stored = route.executionPolicy ?? null;
  if (stored === null) return { policy: defaultPolicy(route.timeoutMs), deadlinesActive: false };
  return { policy: stored, deadlinesActive: true };
}

function emptyTokenUsage(): { promptTokens: null; completionTokens: null; totalTokens: null } {
  return { promptTokens: null, completionTokens: null, totalTokens: null };
}

function streamFailureFacts(input: {
  caller: AbortSignal;
  attemptSignal: AbortSignal;
  opened: boolean;
  trace: AttemptTrace;
  failure: unknown;
  terminal: TerminalStreamStatus;
}): FailureInput {
  const proxy = input.failure instanceof ProxyError ? input.failure : null;
  const network = networkFailureKind(input.failure);
  const deadlineKind = deadlineKindOf(input.attemptSignal) ?? proxy?.transport.deadlineKind ?? null;
  const timedOut =
    input.terminal === 'timed_out' || proxy?.code === 'timeout' || deadlineKind !== null || input.failure instanceof StreamTimeoutError;
  const httpStatus = proxy?.transport.upstreamStatus ?? null;
  const connectionFailure = proxy?.transport.connectionFailure === true || network === 'connection';
  const ambiguousNetwork = proxy?.transport.ambiguousNetwork === true || network === 'ambiguous';
  return {
    callerAborted: input.terminal === 'client_aborted' || isCallerAbort(input.caller),
    outputStarted: input.opened,
    dispatched: wasDispatched({
      fetchEntered: input.trace.fetchEntered,
      headersReceived: input.trace.headersReceived,
      httpStatus,
      connectionFailure,
      ambiguousNetwork,
      timedOut,
      deadlineKind,
    }),
    timedOut,
    deadlineKind,
    httpStatus,
    retryAfter: proxy?.transport.retryAfter ?? null,
    connectionFailure,
    ambiguousNetwork,
  };
}

async function closeStreamRequest(
  input: { runtimePool: Pool; logger: Logger; tenantId: string },
  requestId: string,
): Promise<void> {
  try {
    await withTenant(input.runtimePool, input.tenantId, (client) => finishRequest(client, input.tenantId, requestId, 'failed'));
  } catch (error) {
    input.logger.error('attempt result was not recorded', {
      severity: 'critical',
      requestId,
      message: errorMessage(error),
    });
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
  if (status === 'interrupted') {
    return proxyError(503, 'server_error', 'shutting_down', null, 'The service is unavailable.');
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
    thoughtsTokens: number | null;
    providerRequestId: string | null;
    stopReason: string | null;
    streamStatus: TerminalStreamStatus;
    firstTextDeltaMs: number | null;
    chunkCount: number;
    bytesWritten: number;
    servingModel?: string | null;
    servingProvider?: string | null;
    failureClass?: string | null;
    dispatched?: boolean;
    expenseCertainty?: 'none' | 'uncertain' | 'known' | null;
    closeRequest?: boolean;
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
        thoughtsTokens: result.thoughtsTokens,
        streamStatus: result.streamStatus,
        firstTextDeltaMs: result.firstTextDeltaMs,
        chunkCount: result.chunkCount,
        bytesWritten: result.bytesWritten,
        servingModel: result.servingModel ?? null,
        servingProvider: result.servingProvider ?? null,
        failureClass: result.failureClass ?? null,
        dispatched: result.dispatched ?? false,
        expenseCertainty: result.expenseCertainty ?? null,
        closeRequest: result.closeRequest,
      });
      await recordAttemptCostSafely(client, input.logger, input.tenantId, result.attemptId);
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
