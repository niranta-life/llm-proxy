import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { guardUpstream, noteUpstream } from '../db/breaker.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { anthropicAdapter } from './anthropic.js';
import { openAiAdapter } from './adapter.js';
import type { VertexClientFactory } from './vertex-client.js';
import { vertexAdapter } from './vertex.js';
import { circuitOpenError, classifyBreakerOutcome, type BreakerOutcome } from './breaker.js';
import { beginFallbackAttempt, chooseFallback, fallbackAttemptCap, fallbackPermitted } from './fallback.js';
import { ProxyError, proxyError, safeErrorCode, safeNativeReason, safeProviderRequestId, timeoutProxy } from './errors.js';
import type { ResolvedRoute } from './resolve.js';
import { bindRouteTransport } from './private-serve.js';
import { admitChatAttempt, isAdmissionCode, settleChatAttempt } from './admission.js';
import { recordAttemptCostSafely } from './cost-store.js';
import {
  featureInputFromChat,
  recordChatFeatures,
  type ExtractedFeatures,
  type FeatureExtractInput,
} from './request-features.js';
import { captureChatSample } from './samples.js';
import type { SampleKeyManager } from './sample-crypto.js';
import { appendVisibleDelta, createVisibleCapture, visibleCaptureText } from './stream-capture.js';
import { finishAttempt, finishRequest, insertAttempt, insertPending, markStream } from './store.js';
import { recordRoutingDecision } from './routing-policy-store.js';
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
  header(name: string, value: string): void;
  writeHead(status: number, headers: Record<string, string>): void;
  end(): void;
  headersSent(): boolean;
};

export function stampProxyOutcome(
  reply: StreamHttp,
  facts: { requestId: string; deployment: string; attemptCount: number; fallback: boolean },
): void {
  if (reply.headersSent()) return;
  reply.header('x-request-id', facts.requestId);
  reply.header('x-deployment', facts.deployment);
  reply.header('x-attempt-count', String(facts.attemptCount));
  reply.header('x-fallback', facts.fallback ? 'true' : 'false');
}

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
  apiKeyId: string;
  request: ChatRequest;
  route: ResolvedRoute;
  signal: AbortSignal;
  reply: StreamHttp;
  gate: StreamGate;
  vertexClientFactory?: VertexClientFactory;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  nowMs?: () => number;
  afterAdmit?: () => Promise<void> | void;
  beforeSettle?: () => Promise<void> | void;
  extractFeatures?: (value: FeatureExtractInput) => ExtractedFeatures;
  sampleKeyManager?: SampleKeyManager | null;
  sampleDraw?: number;
  beforeSampleStore?: () => Promise<void> | void;
  beforeSampleInsert?: () => Promise<void> | void;
  failSampleInsert?: () => boolean;
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
  let transport = await bindRouteTransport({
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
  let gateReleased = false;
  const releaseGate = (): void => {
    if (gateReleased) return;
    gateReleased = true;
    input.gate.release(input.tenantId);
  };
  let ordinal = 1;
  let fellBack = false;
  let fallbackUsed = false;
  let timeouts = streamTimeouts(input.route);
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
        await recordRoutingDecision(client, input.tenantId, pending.requestId, input.route);
        return {
          requestId: pending.requestId,
          attemptId: pending.attemptId,
          apiKey: pending.protectedCredential === null ? '' : store.open(pending.protectedCredential),
        };
      });
      requestId = created.requestId;
      attemptId = created.attemptId;
      apiKey = created.apiKey;
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      input.logger.error('request persistence failed', { message: errorMessage(error) });
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }

    const requestStarted = process.hrtime.bigint();
    const { policy, deadlinesActive } = policyFor(input.route);
    const originTimeoutMs = input.route.timeoutMs;
    const ceiling = Math.max(policyAttempts(policy), fallbackAttemptCap(input.route.fallbackPolicy ?? null));
    const total = startTotalDeadline(deadlinesActive, policy.totalDeadlineMs);
    const deadline = new AbortController();
    abortShutdown = (): void => {
      shutdownState.fired = true;
      if (!deadline.signal.aborted) deadline.abort(new StreamShutdownError());
    };
    if (shutdownState.fired && !deadline.signal.aborted) deadline.abort(new StreamShutdownError());
    try {
    while (ordinal <= ceiling) {
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
    const visible = createVisibleCapture();
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
    let trackedBreaker = false;
    let breakerProbe = false;
    let breakerObservedAt = new Date((input.nowMs ?? Date.now)());

    try {
      if (deadline.signal.reason instanceof StreamShutdownError) {
        machine = reduceStream(machine, { type: 'shutdown' });
      } else {
      const observedAt = new Date((input.nowMs ?? Date.now)());
      const gate = await guardUpstream(input.runtimePool, input.tenantId, input.route.deploymentId, observedAt);
      if (!gate.allow) throw circuitOpenError();
      breakerObservedAt = observedAt;
      trackedBreaker = gate.track;
      breakerProbe = gate.probe;
      await admitChatAttempt(input.runtimePool, {
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        route: input.route,
        request: input.request,
        attemptId,
        stream: true,
        now: observedAt,
      });
      if (input.afterAdmit) await input.afterAdmit();
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
        onDispatched: async () => {
          try {
            await withTenant(input.runtimePool, input.tenantId, (client) =>
              markStream(client, { tenantId: input.tenantId, attemptId, streamStatus: 'connecting' }),
            );
          } catch (error) {
            if (error instanceof ProxyError) throw error;
            input.logger.error('request persistence failed', { message: errorMessage(error) });
            throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
          }
        },
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
            'x-request-id': requestId,
            'x-deployment': input.route.deploymentName,
            'x-attempt-count': String(ordinal),
            'x-fallback': fellBack ? 'true' : 'false',
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
        if (event.type === 'text_delta') appendVisibleDelta(visible, event.text);
      }
      }
    } catch (error) {
      failure = error;
      if (error instanceof ProxyError && (error.code === 'circuit_open' || isAdmissionCode(error.code))) {
        machine = { ...machine, status: 'provider_failed' };
        providerCode = error.code ?? 'admission_unavailable';
      } else if (input.signal.aborted) machine = reduceStream(machine, { type: 'client_abort' });
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
    if (failure instanceof ProxyError && (failure.code === 'circuit_open' || isAdmissionCode(failure.code))) {
      if (isAdmissionCode(failure.code) && trackedBreaker) {
        await noteStreamBreaker(input, breakerObservedAt, breakerProbe, 'ignore');
      }
      await recordStream(input, {
        requestId,
        attemptId,
        status: 'failed',
        errorCode: failure.code ?? 'admission_unavailable',
        durationMs: elapsedMs(started),
        usage,
        uncachedInputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        thoughtsTokens: null,
        providerRequestId: null,
        stopReason: null,
        streamStatus: 'provider_failed',
        firstTextDeltaMs: null,
        chunkCount: 0,
        bytesWritten: 0,
        failureClass: null,
        dispatched: false,
        expenseCertainty: 'none',
        closeRequest: true,
      });
      throw failure;
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
    const suppressRetry = trackedBreaker
      ? await noteStreamBreaker(
          input,
          breakerObservedAt,
          breakerProbe,
          streamBreakerKind(failed, failure, facts.callerAborted, decision?.failureClass ?? null),
        )
      : false;
    const outputStarted = opened || input.reply.headersSent();
    const budgetMs = deadlinesActive ? policy.totalDeadlineMs : originTimeoutMs;
    const permitted = failed && decision !== null && fallbackPermitted({
      route: input.route,
      failureClass: decision.failureClass,
      ordinal,
      outputStarted,
      callerAborted: facts.callerAborted,
      fallbackUsed,
      remainingMs: budgetMs - elapsedMs(requestStarted),
    });
    const next = permitted
      ? await chooseFallback({
          pool: input.runtimePool,
          tenantId: input.tenantId,
          apiKeyId: input.apiKeyId,
          request: input.request,
          failedRoute: input.route,
          now: new Date((input.nowMs ?? Date.now)()),
          stream: true,
          releasingAttemptId: attemptId,
        })
      : null;
    const retry = next === null && !permitted && decision !== null && decision.retry && !suppressRetry && !outputStarted && ordinal < policyAttempts(policy);
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
      closeRequest: next === null && !retry,
    });

    if (outputStarted) {
      let downstreamClosed = false;
      try {
        input.reply.end();
        downstreamClosed = true;
      } catch {
        downstreamClosed = false;
      }
      releaseGate();
      const text = visibleCaptureText(visible);
      if (downstreamClosed && terminal === 'completed' && text !== null) {
        await captureChatSample({
          pool: input.runtimePool,
          logger: input.logger,
          tenantId: input.tenantId,
          requestId,
          request: input.request,
          response: {
            id: header?.id ?? 'chatcmpl-stream',
            object: 'chat.completion',
            created: header?.created ?? 0,
            model: header?.model ?? input.route.upstreamModel,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: stopReason,
              },
            ],
          },
          route: input.route,
          keyManager: input.sampleKeyManager ?? null,
          nowMs: input.nowMs,
          draw: input.sampleDraw,
          beforeStore: input.beforeSampleStore,
          beforeInsert: input.beforeSampleInsert,
          failInsert: input.failSampleInsert,
          streamText: text,
        });
      }
      return;
    }
    if (next !== null && decision !== null) {
      try {
        const adopted = await beginFallbackAttempt({
          runtimePool: input.runtimePool,
          tenantId: input.tenantId,
          requestId,
          route: next,
          ordinal: ordinal + 1,
          triggerReason: decision.failureClass,
          store: input.store,
          upstreamBaseUrl: input.upstreamBaseUrl,
          fetchImpl: input.fetchImpl,
          resolveHost: input.resolveHost,
          prepare: (selected) => prepareProvider(input.request, selected),
        });
        const previous = transport;
        transport = adopted.transport;
        await previous.release();
        apiKey = adopted.apiKey;
        attemptId = adopted.attemptId;
        input.route = next;
        timeouts = streamTimeouts(next);
        fallbackUsed = true;
        fellBack = true;
        ordinal += 1;
        continue;
      } catch (switchError) {
        await closeStreamRequest(input, requestId);
        if (switchError instanceof ProxyError) throw switchError;
        input.logger.error('request persistence failed', { message: errorMessage(switchError) });
        throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
      }
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
    if (ordinal > ceiling) throw httpError(terminal, failure);
    try {
      attemptId = await withTenant(input.runtimePool, input.tenantId, (client) =>
        insertAttempt(client, input.tenantId, requestId, input.route, ordinal),
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
    if (requestId !== '' && !opened && !input.reply.headersSent()) {
      stampProxyOutcome(input.reply, {
        requestId,
        deployment: input.route.deploymentName,
        attemptCount: ordinal,
        fallback: fellBack,
      });
    }
    apiKey = '';
    untrack();
    releaseGate();
    await transport.release();
  }
}

function prepareProvider(request: ChatRequest, route: ResolvedRoute): void {
  if (route.provider === 'anthropic') anthropicAdapter.prepare(request, route);
  else if (route.provider === 'vertex') vertexAdapter.prepare(request, route);
  else openAiAdapter.prepare(request, route);
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

function streamBreakerKind(
  failed: boolean,
  failure: unknown,
  callerAborted: boolean,
  failureClass: string | null,
): BreakerOutcome {
  if (!failed) return 'success';
  // A local persistence error is not provider health. The probe slot must be released.
  if (failure instanceof ProxyError && failure.code === 'service_unavailable') return 'ignore';
  return classifyBreakerOutcome({ succeeded: false, callerAborted, failureClass });
}

async function noteStreamBreaker(
  input: { runtimePool: Pool; logger: Logger; tenantId: string; route: ResolvedRoute },
  now: Date,
  probe: boolean,
  kind: BreakerOutcome,
): Promise<boolean> {
  try {
    const noted = await noteUpstream(input.runtimePool, input.tenantId, input.route.deploymentId, now, probe, kind);
    return noted.suppressRetry;
  } catch (error) {
    input.logger.error('breaker observation was not recorded', { message: errorMessage(error) });
    if (probe) {
      try {
        await noteUpstream(input.runtimePool, input.tenantId, input.route.deploymentId, now, true, 'ignore');
      } catch (releaseError) {
        input.logger.error('breaker probe was not released', { message: errorMessage(releaseError) });
      }
    }
    return false;
  }
}

async function closeStreamRequest(
  input: {
    runtimePool: Pool;
    logger: Logger;
    tenantId: string;
    request: Parameters<typeof featureInputFromChat>[0];
    extractFeatures?: (value: FeatureExtractInput) => ExtractedFeatures;
  },
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
    return;
  }
  await recordChatFeatures({
    pool: input.runtimePool,
    logger: input.logger,
    tenantId: input.tenantId,
    requestId,
    request: featureInputFromChat(input.request),
    extract: input.extractFeatures,
  });
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
  input: {
    runtimePool: Pool;
    logger: Logger;
    tenantId: string;
    nowMs?: () => number;
    beforeSettle?: () => Promise<void> | void;
    request: Parameters<typeof featureInputFromChat>[0];
    extractFeatures?: (value: FeatureExtractInput) => ExtractedFeatures;
  },
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
    if (result.closeRequest !== false) {
      await recordChatFeatures({
        pool: input.runtimePool,
        logger: input.logger,
        tenantId: input.tenantId,
        requestId: result.requestId,
        request: featureInputFromChat(input.request),
        extract: input.extractFeatures,
      });
    }
    if (input.beforeSettle) await input.beforeSettle();
    await settleChatAttempt(
      input.runtimePool,
      input.logger,
      input.tenantId,
      result.attemptId,
      new Date((input.nowMs ?? Date.now)()),
    );
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
