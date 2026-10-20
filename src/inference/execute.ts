import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { completeChat, type TokenUsage, type UpstreamCompletion } from './adapter.js';
import { ProxyError, normalizeUpstreamError, proxyError, safeErrorCode } from './errors.js';
import { resolveModel } from './resolve.js';
import { finishAttempt, insertPending, loadCatalog } from './store.js';
import { assertCapabilities, validateChatRequest } from './validate.js';

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
}): Promise<UpstreamCompletion['response']> {
  const request = validateChatRequest(input.body);
  if (!input.inferenceEnabled || input.store === null) {
    throw proxyError(503, 'server_error', 'inference_disabled', null, 'Inference is not enabled.');
  }

  const route = await withTenant(input.runtimePool, input.tenantId, async (client) => {
    const catalog = await loadCatalog(client);
    return resolveModel(request.model, catalog.deployments, catalog.aliases);
  });
  if (route === null) {
    throw proxyError(404, 'invalid_request_error', 'model_not_found', 'model', 'The model is not available.');
  }
  assertCapabilities(request, route.capabilities);

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
        apiKey: store.open(pending.protectedCredential),
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

  const started = process.hrtime.bigint();
  const emptyUsage: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
  try {
    const completion = await completeChat({
      apiKey,
      baseURL: input.upstreamBaseUrl,
      upstreamModel: route.upstreamModel,
      messages: request.messages,
      timeoutMs: route.timeoutMs,
      signal: input.signal,
      optional: request.optional,
    });
    await recordResult(input, {
      requestId,
      attemptId,
      status: 'succeeded',
      errorCode: null,
      durationMs: elapsedMs(started),
      usage: completion.usage,
    });
    return completion.response;
  } catch (error) {
    const normalized = input.signal.aborted
      ? normalizeUpstreamError(error, true)
      : error instanceof ProxyError
        ? error
        : normalizeUpstreamError(error, false);
    await recordResult(input, {
      requestId,
      attemptId,
      status: 'failed',
      errorCode: safeErrorCode(normalized.code),
      durationMs: elapsedMs(started),
      usage: emptyUsage,
    });
    throw normalized;
  } finally {
    apiKey = '';
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
