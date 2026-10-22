import { ApiError } from '@google/genai';
import type { ProviderAdapter, ProviderCall } from './contract.js';
import { deadlineKindOf, isCallerAbort } from './execution-policy.js';
import { ProxyError, proxyError, timeoutProxy } from './errors.js';
import type { UpstreamStreamItem } from './openai-stream.js';
import { StreamShutdownError, StreamTimeoutError, type StreamTimeouts } from './stream.js';
import {
  defaultVertexClientFactory,
  evictVertexClient,
  type VertexApiVersion,
  type VertexAuthMode,
  type VertexClientSpec,
  type VertexGenerateClient,
} from './vertex-client.js';
import { normalizeVertexError, normalizeVertexResponse, toVertexRequest } from './vertex-convert.js';
import { raceAbort, streamVertexChat } from './vertex-stream.js';

const AUTH_MODES = new Set<VertexAuthMode>(['service_account', 'adc', 'workload_identity', 'impersonation']);
const API_VERSIONS = new Set<VertexApiVersion>(['v1', 'v1beta1']);

function providerStatus(error: unknown): number | null {
  if (error instanceof ApiError && typeof error.status === 'number') return error.status;
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return null;
}

function vertexSpec(call: ProviderCall): VertexClientSpec {
  const route = call.route;
  const authMode = route.authMode;
  const apiVersion = route.apiVersion;
  if (
    route.projectId === null ||
    route.location === null ||
    authMode === null ||
    !AUTH_MODES.has(authMode as VertexAuthMode) ||
    apiVersion === null ||
    !API_VERSIONS.has(apiVersion as VertexApiVersion) ||
    !Number.isInteger(route.connectionConfigVersion) ||
    route.connectionConfigVersion < 1
  ) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return {
    tenantId: call.tenantId,
    connectionId: route.connectionId,
    connectionConfigVersion: route.connectionConfigVersion,
    credentialVersion: route.connectionVersion,
    projectId: route.projectId,
    location: route.location,
    apiVersion: apiVersion as VertexApiVersion,
    authMode: authMode as VertexAuthMode,
    serviceAccountIdentity: route.serviceAccountIdentity,
    credentialJson: call.apiKey.length === 0 ? null : call.apiKey,
  };
}

function finishVertexError(
  spec: VertexClientSpec,
  error: unknown,
  callerAborted: boolean,
  timedOut: boolean,
  deadlineKind: 'connection' | 'attempt' | 'total' | null,
  retryAfter: string | null,
): Error {
  let normalized: Error;
  if (callerAborted) normalized = normalizeVertexError(error, true, retryAfter);
  else if (error instanceof ProxyError) normalized = error;
  else {
    const status = providerStatus(error);
    if (status === 400 || status === 401 || status === 403 || status === 404) normalized = normalizeVertexError(error, false, retryAfter);
    else if (timedOut) normalized = timeoutProxy(deadlineKind ?? 'attempt');
    else normalized = normalizeVertexError(error, false, retryAfter);
  }
  if (normalized instanceof ProxyError && normalized.code === 'expired_credentials') evictVertexClient(spec);
  return normalized;
}

async function executeVertex(call: ProviderCall) {
  const prepared = toVertexRequest(call.request, call.route.upstreamModel);
  const spec = vertexSpec(call);
  const factory = call.vertexClientFactory ?? defaultVertexClientFactory;
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(call.signal.reason);
  };
  if (call.signal.aborted) abort();
  else call.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, call.route.timeoutMs);
  try {
    const client = await factory(spec);
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('aborted');
    if (call.attemptTrace) call.attemptTrace.fetchEntered = true;
    const response = await raceAbort(
      client.generateContent({
        model: prepared.model,
        contents: prepared.contents,
        config: {
          ...prepared.config,
          abortSignal: controller.signal,
          ...(call.fetchImpl ? { httpOptions: { fetch: call.fetchImpl } } : {}),
        },
      }),
      controller.signal,
    );
    if (call.attemptTrace) call.attemptTrace.headersReceived = true;
    call.onHeaders?.();
    return normalizeVertexResponse(response, Math.floor(Date.now() / 1000), call.route.upstreamModel);
  } catch (error) {
    const kind = deadlineKindOf(call.signal);
    throw finishVertexError(
      spec,
      error,
      isCallerAbort(call.signal),
      kind !== null || controller.signal.aborted,
      kind,
      call.attemptTrace?.retryAfter ?? null,
    );
  } finally {
    clearTimeout(timer);
    call.signal.removeEventListener('abort', abort);
  }
}

export const vertexAdapter: ProviderAdapter & {
  stream(call: ProviderCall & { timeouts: StreamTimeouts; deadline: AbortController }): AsyncGenerator<UpstreamStreamItem>;
} = {
  provider: 'vertex',
  prepare(request, route): void {
    toVertexRequest(request, route.upstreamModel);
  },
  execute: executeVertex,
  async *stream(call) {
    const prepared = toVertexRequest(call.request, call.route.upstreamModel);
    const spec = vertexSpec(call);
    const factory = call.vertexClientFactory ?? defaultVertexClientFactory;
    let client: VertexGenerateClient;
    try {
      client = await factory(spec);
    } catch (error) {
      throw finishVertexError(
        spec,
        error,
        isCallerAbort(call.signal),
        deadlineKindOf(call.signal) !== null,
        deadlineKindOf(call.signal),
        call.attemptTrace?.retryAfter ?? null,
      );
    }
    if (call.attemptTrace) call.attemptTrace.fetchEntered = true;
    let noted = false;
    try {
      for await (const item of streamVertexChat({
        client,
        request: prepared,
        signal: call.signal,
        connectTimeoutMs: call.timeouts.connect,
        idleTimeoutMs: call.timeouts.idle,
        totalTimeoutMs: call.timeouts.total,
        deadline: call.deadline,
        fetchImpl: call.fetchImpl,
        retryAfter: () => call.attemptTrace?.retryAfter ?? null,
        onDispatched: call.onDispatched,
      })) {
        if (!noted) {
          noted = true;
          if (call.attemptTrace) call.attemptTrace.headersReceived = true;
          call.onHeaders?.();
        }
        yield item;
      }
    } catch (error) {
      if (error instanceof StreamTimeoutError || error instanceof StreamShutdownError) throw error;
      const kind = deadlineKindOf(call.signal);
      throw finishVertexError(spec, error, isCallerAbort(call.signal), kind !== null, kind, call.attemptTrace?.retryAfter ?? null);
    }
  },
};
