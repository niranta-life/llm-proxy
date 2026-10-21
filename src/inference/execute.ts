import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { anthropicAdapter } from './anthropic.js';
import { openAiAdapter, type TokenUsage, type UpstreamCompletion } from './adapter.js';
import { bindRouteTransport } from './private-serve.js';
import type { ProviderAdapter } from './contract.js';
import type { VertexClientFactory } from './vertex-client.js';
import { vertexAdapter } from './vertex.js';
import { runChatStream, type StreamHttp } from './execute-stream.js';
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
import { ProxyError, normalizeUpstreamError, proxyError, safeErrorCode, timeoutProxy } from './errors.js';
import { resolveModel, type ResolvedRoute } from './resolve.js';
import { recordAttemptCostSafely } from './cost-store.js';
import { finishAttempt, finishRequest, insertAttempt, insertPending, loadCatalog } from './store.js';
import type { StreamGate } from './stream.js';
import { assertCapabilities, assertStreamAllowed, validateChatRequest } from './validate.js';

function adapterFor(provider: string): ProviderAdapter {
  if (provider === 'anthropic') return anthropicAdapter;
  if (provider === 'openai' || provider === 'xai' || provider === 'openrouter' || provider === 'dgx') return openAiAdapter;
  if (provider === 'vertex') return vertexAdapter;
  throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
}

function openedSecret(store: { open(value: string): string }, protectedCredential: string | null): string {
  if (protectedCredential === null) return '';
  return store.open(protectedCredential);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function elapsedMs(started: bigint): number {
  const duration = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return duration < 0 ? 0 : duration;
}

function policyFor(route: ResolvedRoute): { policy: PolicyInput; deadlinesActive: boolean } {
  const stored = route.executionPolicy ?? null;
  if (stored === null) return { policy: defaultPolicy(route.timeoutMs), deadlinesActive: false };
  return { policy: stored, deadlinesActive: true };
}

function asProxy(error: unknown, callerAborted: boolean): ProxyError {
  if (callerAborted) return normalizeUpstreamError(error, true);
  if (error instanceof ProxyError) return error;
  return normalizeUpstreamError(error, false);
}

function failureFacts(input: {
  caller: AbortSignal;
  attemptSignal: AbortSignal;
  outputStarted: boolean;
  trace: AttemptTrace;
  error: ProxyError;
  raw: unknown;
}): FailureInput {
  const network = networkFailureKind(input.raw);
  const connectionFailure = input.error.transport.connectionFailure || network === 'connection';
  const ambiguousNetwork = input.error.transport.ambiguousNetwork || network === 'ambiguous';
  const deadlineKind = deadlineKindOf(input.attemptSignal) ?? input.error.transport.deadlineKind;
  const timedOut = input.error.code === 'timeout' || deadlineKind !== null;
  const httpStatus = input.error.transport.upstreamStatus;
  return {
    callerAborted: isCallerAbort(input.caller),
    outputStarted: input.outputStarted,
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
    retryAfter: input.error.transport.retryAfter,
    connectionFailure,
    ambiguousNetwork,
  };
}

export async function executeChat(input: {
  runtimePool: Pool;
  logger: Logger;
  inferenceEnabled: boolean;
  upstreamBaseUrl: string;
  store: ProviderCredentialStore | null;
  tenantId: string;
  body: unknown;
  signal: AbortSignal;
  reply: StreamHttp;
  gate: StreamGate;
  vertexClientFactory?: VertexClientFactory;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
}): Promise<UpstreamCompletion['response'] | undefined> {
  const request = validateChatRequest(input.body);
  if (!input.inferenceEnabled || input.store === null) {
    throw proxyError(503, 'server_error', 'inference_disabled', null, 'Inference is not enabled.');
  }

  const loaded = await withTenant(input.runtimePool, input.tenantId, async (client) => {
    const catalog = await loadCatalog(client);
    return {
      route: resolveModel(request.model, catalog.deployments, catalog.aliases),
      streamingEnabled: catalog.streamingEnabled,
    };
  });
  const route = loaded.route;
  if (route === null) {
    throw proxyError(404, 'invalid_request_error', 'model_not_found', 'model', 'The model is not available.');
  }
  assertStreamAllowed(request, route, loaded.streamingEnabled);
  assertCapabilities(request, route.capabilities);
  const adapter = adapterFor(route.provider);
  adapter.prepare(request, route);
  if (request.stream) {
    await runChatStream({
      runtimePool: input.runtimePool,
      logger: input.logger,
      upstreamBaseUrl: input.upstreamBaseUrl,
      store: input.store,
      tenantId: input.tenantId,
      request,
      route,
      signal: input.signal,
      reply: input.reply,
      gate: input.gate,
      vertexClientFactory: input.vertexClientFactory,
      fetchImpl: input.fetchImpl,
      resolveHost: input.resolveHost,
    });
    return undefined;
  }
  const transport = await bindRouteTransport({
    runtimePool: input.runtimePool,
    tenantId: input.tenantId,
    route,
    upstreamBaseUrl: input.upstreamBaseUrl,
    fetchImpl: input.fetchImpl,
    resolveHost: input.resolveHost,
  });
  const baseURL = transport.baseURL;

  let requestId = '';
  let attemptId = '';
  let apiKey = '';
  try {
    const store = input.store;
    const created = await withTenant(input.runtimePool, input.tenantId, async (client) => {
      const pending = await insertPending(client, input.tenantId, route);
      return {
        requestId: pending.requestId,
        attemptId: pending.attemptId,
        apiKey: openedSecret(store, pending.protectedCredential),
      };
    });
    requestId = created.requestId;
    attemptId = created.attemptId;
    apiKey = created.apiKey;
  } catch (error) {
    await transport.release();
    if (error instanceof ProxyError) throw error;
    input.logger.error('request persistence failed', { message: errorMessage(error) });
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }

  const requestStarted = process.hrtime.bigint();
  const { policy, deadlinesActive } = policyFor(route);
  const total = startTotalDeadline(deadlinesActive, policy.totalDeadlineMs);
  let ordinal = 1;
  try {
    while (ordinal <= policyAttempts(policy)) {
      const elapsed = elapsedMs(requestStarted);
      if (deadlinesActive && elapsed >= policy.totalDeadlineMs) {
        const timeout = timeoutProxy('total');
        await recordResult(input, {
          requestId,
          attemptId,
          status: 'failed',
          errorCode: 'timeout',
          durationMs: 0,
          usage: emptyUsage(),
          providerRequestId: null,
          stopReason: 'timeout',
          uncachedInputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          thoughtsTokens: null,
          failureClass: 'total_deadline',
          dispatched: false,
          expenseCertainty: 'none',
          closeRequest: true,
        });
        throw timeout;
      }
      const remaining = deadlinesActive ? Math.max(1, policy.totalDeadlineMs - elapsed) : route.timeoutMs;
      const attemptMs = deadlinesActive ? Math.max(1, Math.min(policy.attemptDeadlineMs, remaining)) : route.timeoutMs;
      const trace = emptyAttemptTrace();
      const window = startAttemptDeadlines({
        enabled: deadlinesActive,
        caller: input.signal,
        total: total.signal,
        connectionMs: policy.connectionDeadlineMs,
        attemptMs,
      });
      const started = process.hrtime.bigint();
      try {
        const completion = await adapter.execute({
          apiKey,
          baseURL,
          request,
          route: deadlinesActive ? { ...route, timeoutMs: attemptMs } : route,
          signal: window.signal,
          tenantId: input.tenantId,
          vertexClientFactory: input.vertexClientFactory,
          fetchImpl: fetchForProvider(route.provider, transport.fetchImpl, trace, () => window.noteHeaders()),
          attemptTrace: trace,
          onHeaders: () => window.noteHeaders(),
        });
        await recordResult(input, {
          requestId,
          attemptId,
          status: 'succeeded',
          errorCode: null,
          durationMs: elapsedMs(started),
          usage: completion.usage,
          providerRequestId: completion.providerRequestId,
          stopReason: completion.stopReason,
          uncachedInputTokens: completion.uncachedInputTokens,
          cacheCreationInputTokens: completion.cacheCreationInputTokens,
          cacheReadInputTokens: completion.cacheReadInputTokens,
          thoughtsTokens: completion.thoughtsTokens ?? null,
          servingModel: completion.servingModel ?? null,
          servingProvider: completion.servingProvider ?? null,
          failureClass: null,
          dispatched: true,
          expenseCertainty: 'known',
          closeRequest: true,
        });
        return completion.response;
      } catch (error) {
        const normalized = asProxy(error, isCallerAbort(input.signal));
        const facts = failureFacts({
          caller: input.signal,
          attemptSignal: window.signal,
          outputStarted: false,
          trace,
          error: normalized,
          raw: error,
        });
        const decision = decideRetry({
          policy,
          deadlinesActive,
          ordinal,
          elapsedMs: elapsedMs(requestStarted),
          nowMs: Date.now(),
          random: Math.random,
          failure: facts,
        });
        const retry = decision.retry && ordinal < policyAttempts(policy);
        const attemptFacts = normalized.attempt;
        await recordResult(input, {
          requestId,
          attemptId,
          status: 'failed',
          errorCode: safeErrorCode(normalized.code),
          durationMs: elapsedMs(started),
          usage: {
            promptTokens: attemptFacts.promptTokens,
            completionTokens: attemptFacts.completionTokens,
            totalTokens: attemptFacts.totalTokens,
          },
          providerRequestId: attemptFacts.providerRequestId,
          stopReason: normalized.nativeReason,
          uncachedInputTokens: attemptFacts.uncachedInputTokens,
          cacheCreationInputTokens: attemptFacts.cacheCreationInputTokens,
          cacheReadInputTokens: attemptFacts.cacheReadInputTokens,
          thoughtsTokens: attemptFacts.thoughtsTokens,
          failureClass: decision.failureClass,
          dispatched: facts.dispatched,
          expenseCertainty: decision.expenseCertainty,
          closeRequest: !retry,
        });
        if (!retry) throw normalized;
        const signals = total.signal === null ? [input.signal] : [input.signal, total.signal];
        const slept = await waitForRetry(decision.waitMs, signals);
        if (slept !== 'ok') {
          await closePending(input, requestId);
          if (isCallerAbort(input.signal)) {
            throw proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
          }
          throw timeoutProxy(deadlineKindOf(total.signal ?? undefined) ?? 'total');
        }
        ordinal += 1;
        if (ordinal > policyAttempts(policy)) throw normalized;
        attemptId = await withTenant(input.runtimePool, input.tenantId, (client) =>
          insertAttempt(client, input.tenantId, requestId, route, ordinal),
        );
      } finally {
        window.cancel();
      }
    }
    throw proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.');
  } finally {
    total.cancel();
    apiKey = '';
    await transport.release();
  }
}

function emptyUsage(): { promptTokens: null; completionTokens: null; totalTokens: null } {
  return { promptTokens: null, completionTokens: null, totalTokens: null };
}

async function closePending(
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

async function recordResult(
  input: { runtimePool: Pool; logger: Logger; tenantId: string },
  result: {
    requestId: string;
    attemptId: string;
    status: 'succeeded' | 'failed';
    errorCode: string | null;
    durationMs: number;
    usage: TokenUsage;
    providerRequestId: string | null;
    stopReason: string | null;
    uncachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
    thoughtsTokens: number | null;
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
      await finishAttempt(client, { tenantId: input.tenantId, ...result });
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
