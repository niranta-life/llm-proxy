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
import { ProxyError, normalizeUpstreamError, proxyError, safeErrorCode } from './errors.js';
import { resolveModel } from './resolve.js';
import { finishAttempt, insertPending, loadCatalog } from './store.js';
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

  const started = process.hrtime.bigint();
  try {
    const completion = await adapter.execute({
      apiKey,
      baseURL,
      request,
      route,
      signal: input.signal,
      tenantId: input.tenantId,
      vertexClientFactory: input.vertexClientFactory,
      fetchImpl: transport.fetchImpl,
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
    });
    return completion.response;
  } catch (error) {
    const normalized = input.signal.aborted
      ? normalizeUpstreamError(error, true)
      : error instanceof ProxyError
        ? error
        : normalizeUpstreamError(error, false);
    const facts = normalized.attempt;
    await recordResult(input, {
      requestId,
      attemptId,
      status: 'failed',
      errorCode: safeErrorCode(normalized.code),
      durationMs: elapsedMs(started),
      usage: {
        promptTokens: facts.promptTokens,
        completionTokens: facts.completionTokens,
        totalTokens: facts.totalTokens,
      },
      providerRequestId: facts.providerRequestId,
      stopReason: normalized.nativeReason,
      uncachedInputTokens: facts.uncachedInputTokens,
      cacheCreationInputTokens: facts.cacheCreationInputTokens,
      cacheReadInputTokens: facts.cacheReadInputTokens,
      thoughtsTokens: facts.thoughtsTokens,
    });
    throw normalized;
  } finally {
    apiKey = '';
    await transport.release();
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
  },
): Promise<void> {
  try {
    await withTenant(input.runtimePool, input.tenantId, async (client) => {
      await finishAttempt(client, { tenantId: input.tenantId, ...result });
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
