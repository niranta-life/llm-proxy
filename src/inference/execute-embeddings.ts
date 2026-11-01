import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { guardUpstream, noteUpstream } from '../db/breaker.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import type { ProviderCredentialStore } from '../credentials.js';
import { admitEmbeddingAttempt, isAdmissionCode, settleChatAttempt } from './admission.js';
import { circuitOpenError, type BreakerOutcome } from './breaker.js';
import { recordAttemptCostSafely } from './cost-store.js';
import {
  assertApprovedSpace,
  assertEmbeddingProvider,
  assertEncodingForProvider,
  assertRequestedDimension,
  checkVectors,
  embeddingResponse,
  EMBEDDING_ADAPTER_VERSION,
  parseEmbeddingRequest,
  readOpenAiEmbeddings,
  readVertexEmbeddings,
  type CheckedVector,
  type EmbeddingContractPin,
} from './embeddings.js';
import { ProxyError, proxyError } from './errors.js';
import { bindRouteTransport, type RouteTransport } from './private-serve.js';
import { routeForDeployment, type ResolvedRoute } from './resolve.js';
import { finishAttempt, insertPending, loadCatalog } from './store.js';
import type { TokenUsage } from './adapter.js';
import {
  defaultVertexClientFactory,
  type VertexApiVersion,
  type VertexAuthMode,
  type VertexClientFactory,
  type VertexClientSpec,
} from './vertex-client.js';

const AUTH_MODES = new Set<VertexAuthMode>(['service_account', 'adc', 'workload_identity', 'impersonation']);
const API_VERSIONS = new Set<VertexApiVersion>(['v1', 'v1beta1']);
const EMBEDDING_AUDIT = { capabilities: ['embeddings'], adapterVersion: EMBEDDING_ADAPTER_VERSION };

type EmbeddingBody = ReturnType<typeof embeddingResponse>;

export async function executeEmbeddings(input: {
  runtimePool: Pool;
  logger: Logger;
  inferenceEnabled: boolean;
  upstreamBaseUrl: string;
  store: ProviderCredentialStore | null;
  tenantId: string;
  apiKeyId: string;
  body: unknown;
  signal: AbortSignal;
  vertexClientFactory?: VertexClientFactory;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  nowMs?: () => number;
}): Promise<EmbeddingBody> {
  const request = parseEmbeddingRequest(input.body);
  if (!input.inferenceEnabled || input.store === null) {
    throw proxyError(503, 'server_error', 'inference_disabled', null, 'Inference is not enabled.');
  }
  const store = input.store;
  const prepared = await withTenant(input.runtimePool, input.tenantId, async (client) => {
    const catalog = await loadCatalog(client);
    const deployment = catalog.deployments.find((item) => item.name === request.model);
    if (deployment === undefined || !deployment.enabled || !deployment.connectionEnabled) return null;
    const contract = await loadContract(client, deployment.id);
    return { deployment, contract };
  });
  if (prepared === null) {
    throw proxyError(404, 'invalid_request_error', 'model_not_found', 'model', 'The model is not available.');
  }
  const route = routeForDeployment(request.model, prepared.deployment, false, null);
  if (!route.capabilities.includes('embeddings')) {
    throw invalidCapability();
  }
  assertEmbeddingProvider(route.provider, route.endpoint, route.validationStatus);
  if (prepared.contract === null) {
    throw proxyError(400, 'invalid_request_error', 'invalid_request', 'model', 'The embedding contract is missing.');
  }
  const contract = prepared.contract;
  if (contract.model !== route.upstreamModel) {
    throw proxyError(400, 'invalid_request_error', 'invalid_request', 'model', 'The embedding model changed.');
  }
  assertRequestedDimension(request.dimensions, contract.dimension);
  assertEncodingForProvider(request.encoding, route.provider);
  const space = assertApprovedSpace(route.provider, route.upstreamModel, contract.dimension);

  let transport: RouteTransport | null = null;
  try {
    transport = await bindRouteTransport({
      runtimePool: input.runtimePool,
      tenantId: input.tenantId,
      route,
      upstreamBaseUrl: input.upstreamBaseUrl,
      fetchImpl: input.fetchImpl,
      resolveHost: input.resolveHost,
    });
    let created: { requestId: string; attemptId: string; apiKey: string };
    try {
      created = await withTenant(input.runtimePool, input.tenantId, async (client) => {
        const pending = await insertPending(client, input.tenantId, route, EMBEDDING_AUDIT);
        return {
          requestId: pending.requestId,
          attemptId: pending.attemptId,
          apiKey: pending.protectedCredential === null ? '' : store.open(pending.protectedCredential),
        };
      });
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      input.logger.error('embedding request was not stored', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }
    const started = process.hrtime.bigint();
    const observedAt = new Date((input.nowMs ?? Date.now)());
    let gate: { allow: boolean; probe: boolean; track: boolean } = { allow: true, probe: false, track: false };
    try {
      gate = await guardUpstream(input.runtimePool, input.tenantId, route.deploymentId, observedAt);
      if (!gate.allow) throw circuitOpenError();
      await admitEmbeddingAttempt(input.runtimePool, {
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        route,
        inputChars: inputChars(request.inputs),
        attemptId: created.attemptId,
        now: observedAt,
      });
      const outcome = await dispatchEmbedding({
        route,
        contract,
        inputs: request.inputs,
        encoding: request.encoding,
        sendDimensions: space.sendDimensions,
        apiKey: created.apiKey,
        tenantId: input.tenantId,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(route.timeoutMs)]),
        transport,
        vertexClientFactory: input.vertexClientFactory ?? defaultVertexClientFactory,
      });
      const vectors = checkVectors({
        count: request.inputs.length,
        dimension: contract.dimension,
        normalization: contract.normalization,
        items: outcome.items,
      });
      const body = embeddingResponse(route.deploymentName, vectors, outcome.usage);
      await recordEmbedding({
        pool: input.runtimePool,
        logger: input.logger,
        tenantId: input.tenantId,
        requestId: created.requestId,
        attemptId: created.attemptId,
        status: 'succeeded',
        errorCode: null,
        durationMs: elapsedMs(started),
        usage: {
          promptTokens: outcome.usage.prompt,
          completionTokens: 0,
          totalTokens: outcome.usage.total,
        },
        dispatched: true,
        expenseCertainty: 'known',
        now: observedAt,
      });
      if (gate.track) await noteBreaker(input, route.deploymentId, observedAt, gate.probe, 'success');
      input.logger.info('embedding completed', {
        requestId: created.requestId,
        deployment: route.deploymentName,
        vectorCount: vectors.length,
        dimension: contract.dimension,
      });
      return body;
    } catch (error) {
      const normalized = normalizeEmbeddingError(error, input.signal.aborted);
      if (gate.track && isAdmissionCode(normalized.code)) {
        await noteBreaker(input, route.deploymentId, observedAt, gate.probe, 'ignore');
      } else if (gate.track && normalized.code !== 'circuit_open' && normalized.code !== 'request_cancelled') {
        await noteBreaker(input, route.deploymentId, observedAt, gate.probe, 'failure');
      }
      await recordEmbedding({
        pool: input.runtimePool,
        logger: input.logger,
        tenantId: input.tenantId,
        requestId: created.requestId,
        attemptId: created.attemptId,
        status: 'failed',
        errorCode: normalized.code,
        durationMs: elapsedMs(started),
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        dispatched: normalized.code === 'upstream_error' || normalized.code === 'invalid_upstream_response' || normalized.code === 'timeout',
        expenseCertainty: 'none',
        now: observedAt,
      });
      throw normalized;
    }
  } finally {
    await transport?.release();
  }
}

function invalidCapability(): ProxyError {
  return proxyError(400, 'invalid_request_error', 'unsupported_parameter', 'model', 'embeddings is not supported.');
}

function inputChars(inputs: readonly string[]): number {
  let total = 0;
  for (const item of inputs) total += item.length;
  return total;
}

function elapsedMs(started: bigint): number {
  const duration = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return duration < 0 ? 0 : duration;
}

async function loadContract(client: PoolClient, deploymentId: string): Promise<EmbeddingContractPin | null> {
  const result = await client.query<{ version: number; model: string; dimension: number; normalization: string }>(
    `SELECT version, model, dimension, normalization
     FROM embedding_contracts
     WHERE deployment_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [deploymentId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (row.normalization !== 'none' && row.normalization !== 'l2') return null;
  return {
    version: row.version,
    model: row.model,
    dimension: row.dimension,
    normalization: row.normalization,
  };
}

async function dispatchEmbedding(input: {
  route: ResolvedRoute;
  contract: EmbeddingContractPin;
  inputs: string[];
  encoding: 'float' | 'base64';
  sendDimensions: boolean;
  apiKey: string;
  tenantId: string;
  signal: AbortSignal;
  transport: RouteTransport;
  vertexClientFactory: VertexClientFactory;
}): Promise<{ items: CheckedVector[]; usage: { prompt: number; total: number } }> {
  if (input.route.provider === 'vertex') {
    return embedVertex(input);
  }
  return embedCompatible(input);
}

async function embedCompatible(input: {
  route: ResolvedRoute;
  contract: EmbeddingContractPin;
  inputs: string[];
  encoding: 'float' | 'base64';
  sendDimensions: boolean;
  apiKey: string;
  signal: AbortSignal;
  transport: RouteTransport;
}): Promise<{ items: CheckedVector[]; usage: { prompt: number; total: number } }> {
  const payload: Record<string, unknown> = {
    model: input.route.upstreamModel,
    input: input.inputs,
    encoding_format: input.encoding,
  };
  if (input.sendDimensions) payload.dimensions = input.contract.dimension;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (input.apiKey.length > 0) headers.authorization = `Bearer ${input.apiKey}`;
  const fetchImpl = input.transport.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.transport.baseURL}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: input.signal,
  });
  if (response.status >= 400) {
    await response.body?.cancel().catch(() => undefined);
    throw proxyError(502, 'server_error', 'upstream_error', null, 'The upstream provider failed.');
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The embedding response is invalid.');
  }
  return readOpenAiEmbeddings(parsed, input.encoding, input.contract.dimension, input.route.upstreamModel);
}

async function embedVertex(input: {
  route: ResolvedRoute;
  contract: EmbeddingContractPin;
  inputs: string[];
  apiKey: string;
  tenantId: string;
  signal: AbortSignal;
  transport: RouteTransport;
  vertexClientFactory: VertexClientFactory;
}): Promise<{ items: CheckedVector[]; usage: { prompt: number; total: number } }> {
  const spec = vertexSpec(input.tenantId, input.route, input.apiKey);
  const client = await input.vertexClientFactory(spec);
  if (client.embedContent === undefined) {
    throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The embedding response is invalid.');
  }
  let raw: unknown;
  try {
    raw = await client.embedContent({
      model: input.route.upstreamModel,
      contents: input.inputs,
      config: {
        outputDimensionality: input.contract.dimension,
        autoTruncate: false,
        abortSignal: input.signal,
        httpOptions: input.transport.fetchImpl === undefined ? undefined : { fetch: input.transport.fetchImpl },
      },
    });
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw proxyError(502, 'server_error', 'upstream_error', null, 'The upstream provider failed.');
  }
  return readVertexEmbeddings(raw);
}

function vertexSpec(tenantId: string, route: ResolvedRoute, apiKey: string): VertexClientSpec {
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
    tenantId,
    connectionId: route.connectionId,
    connectionConfigVersion: route.connectionConfigVersion,
    credentialVersion: route.connectionVersion,
    projectId: route.projectId,
    location: route.location,
    apiVersion: apiVersion as VertexApiVersion,
    authMode: authMode as VertexAuthMode,
    serviceAccountIdentity: route.serviceAccountIdentity,
    credentialJson: apiKey.length === 0 ? null : apiKey,
  };
}

function normalizeEmbeddingError(error: unknown, callerAborted: boolean): ProxyError {
  if (error instanceof ProxyError) return error;
  if (callerAborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.');
  }
  if (isTimeout(error)) {
    return proxyError(504, 'server_error', 'timeout', null, 'The upstream model request timed out.');
  }
  return proxyError(502, 'server_error', 'upstream_error', null, 'The upstream provider failed.');
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function noteBreaker(
  input: { runtimePool: Pool; logger: Logger; tenantId: string },
  deploymentId: string,
  now: Date,
  probe: boolean,
  kind: BreakerOutcome,
): Promise<void> {
  try {
    await noteUpstream(input.runtimePool, input.tenantId, deploymentId, now, probe, kind);
  } catch (error) {
    input.logger.error('breaker observation was not recorded', {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function recordEmbedding(input: {
  pool: Pool;
  logger: Logger;
  tenantId: string;
  requestId: string;
  attemptId: string;
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  durationMs: number;
  usage: TokenUsage;
  dispatched: boolean;
  expenseCertainty: 'none' | 'known';
  now: Date;
}): Promise<void> {
  try {
    await withTenant(input.pool, input.tenantId, async (client) => {
      await finishAttempt(client, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        attemptId: input.attemptId,
        status: input.status,
        errorCode: input.errorCode,
        durationMs: input.durationMs,
        usage: input.usage,
        providerRequestId: null,
        stopReason: null,
        uncachedInputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        thoughtsTokens: null,
        failureClass: null,
        dispatched: input.dispatched,
        expenseCertainty: input.expenseCertainty,
        closeRequest: true,
      });
      await recordAttemptCostSafely(client, input.logger, input.tenantId, input.attemptId);
    });
    await settleChatAttempt(input.pool, input.logger, input.tenantId, input.attemptId, input.now);
  } catch (error) {
    input.logger.error('embedding attempt was not recorded', {
      severity: 'critical',
      requestId: input.requestId,
      attemptId: input.attemptId,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

