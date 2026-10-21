import type { PoolClient } from 'pg';
import type { DataCollection } from './compatible.js';
import { proxyError } from './errors.js';
import type { PrivateApproval } from './private.js';
import type { RegistryProviderName } from './contract.js';
import type { ExpenseCertainty, StoredExecutionPolicy } from './execution-policy.js';
import type { AliasCandidate, DeploymentCandidate, ResolvedRoute } from './resolve.js';
import type { TokenUsage } from './adapter.js';
import type { StreamStatus } from './stream.js';

type DeploymentRow = {
  id: string;
  name: string;
  upstream_model: string;
  timeout_ms: number;
  capabilities: string[] | null;
  config_version: number;
  connection_id: string;
  connection_version: number;
  enabled: boolean;
  connection_enabled: boolean;
  provider: string;
  endpoint: string | null;
  workspace_id: string | null;
  default_max_output_tokens: number | null;
  streaming_enabled: boolean;
  stream_connect_timeout_ms: number | null;
  stream_idle_timeout_ms: number | null;
  stream_total_timeout_ms: number | null;
  stream_backpressure_timeout_ms: number | null;
  project_id: string | null;
  location: string | null;
  auth_mode: string;
  service_account_identity: string | null;
  api_version: string;
  connection_config_version: number;
  downstream_providers: string[] | null;
  data_collection: string | null;
  allow_fallbacks: boolean | null;
  require_serving_provider: boolean;
  max_concurrency: number | null;
  policy_id: string | null;
  policy_version: number | null;
  retries_enabled: boolean | null;
  max_attempts: number | null;
  connection_deadline_ms: number | null;
  attempt_deadline_ms: number | null;
  total_deadline_ms: number | null;
  initial_backoff_ms: number | null;
  max_backoff_ms: number | null;
};

function providerName(value: string): RegistryProviderName {
  if (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'vertex' ||
    value === 'xai' ||
    value === 'openrouter' ||
    value === 'dgx'
  ) {
    return value;
  }
  throw new Error('provider is invalid');
}

function readDataCollection(value: string | null): DataCollection | null {
  if (value === null) return null;
  if (value === 'allow' || value === 'deny') return value;
  throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
}

function readPolicy(row: DeploymentRow): StoredExecutionPolicy | null {
  if (row.policy_id === null) return null;
  if (
    row.policy_version === null ||
    row.retries_enabled === null ||
    row.max_attempts === null ||
    row.connection_deadline_ms === null ||
    row.attempt_deadline_ms === null ||
    row.total_deadline_ms === null ||
    row.initial_backoff_ms === null ||
    row.max_backoff_ms === null
  ) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return {
    id: row.policy_id,
    version: row.policy_version,
    retriesEnabled: row.retries_enabled,
    maxAttempts: row.max_attempts,
    connectionDeadlineMs: row.connection_deadline_ms,
    attemptDeadlineMs: row.attempt_deadline_ms,
    totalDeadlineMs: row.total_deadline_ms,
    initialBackoffMs: row.initial_backoff_ms,
    maxBackoffMs: row.max_backoff_ms,
  };
}

function readDownstream(value: string[] | null): readonly string[] | null {
  if (value === null) return null;
  if (value.length === 0) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return value;
}

export async function loadCatalog(client: PoolClient): Promise<{
  streamingEnabled: boolean;
  deployments: DeploymentCandidate[];
  aliases: AliasCandidate[];
}> {
  const tenant = await client.query<{ streaming_enabled: boolean }>(
    `SELECT streaming_enabled
     FROM tenants
     WHERE id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
  );
  const deployments = await client.query<DeploymentRow>(
    `SELECT d.id, d.name, d.upstream_model, d.timeout_ms, d.capabilities, d.config_version,
            d.connection_id, c.credential_version AS connection_version, d.enabled,
            c.enabled AS connection_enabled, c.provider, c.endpoint, c.workspace_id,
            c.project_id, c.location, c.auth_mode, c.service_account_identity, c.api_version,
            c.config_version AS connection_config_version,
            d.default_max_output_tokens, d.streaming_enabled,
            d.stream_connect_timeout_ms, d.stream_idle_timeout_ms,
            d.stream_total_timeout_ms, d.stream_backpressure_timeout_ms,
            d.downstream_providers, d.data_collection, d.allow_fallbacks,
            d.require_serving_provider, d.max_concurrency,
            p.id AS policy_id, p.policy_version, p.retries_enabled, p.max_attempts,
            p.connection_deadline_ms, p.attempt_deadline_ms, p.total_deadline_ms,
            p.initial_backoff_ms, p.max_backoff_ms
     FROM model_deployments d
     JOIN provider_connections c
       ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     LEFT JOIN execution_policies p
       ON p.tenant_id = d.tenant_id AND p.id = d.execution_policy_id`,
  );
  const aliases = await client.query<{ alias: string; deployment_id: string }>(
    'SELECT alias, deployment_id FROM model_aliases',
  );
  return {
    deployments: deployments.rows.map((row) => ({
      id: row.id,
      name: row.name,
      upstreamModel: row.upstream_model,
      timeoutMs: row.timeout_ms,
      capabilities: row.capabilities ?? [],
      configVersion: row.config_version,
      connectionId: row.connection_id,
      connectionVersion: row.connection_version,
      enabled: row.enabled,
      connectionEnabled: row.connection_enabled,
      provider: providerName(row.provider),
      endpoint: row.endpoint,
      workspaceId: row.workspace_id,
      defaultMaxOutputTokens: row.default_max_output_tokens,
      streamingEnabled: row.streaming_enabled,
      streamConnectTimeoutMs: row.stream_connect_timeout_ms,
      streamIdleTimeoutMs: row.stream_idle_timeout_ms,
      streamTotalTimeoutMs: row.stream_total_timeout_ms,
      streamBackpressureTimeoutMs: row.stream_backpressure_timeout_ms,
      projectId: row.project_id,
      location: row.location,
      authMode: row.auth_mode,
      serviceAccountIdentity: row.service_account_identity,
      apiVersion: row.api_version,
      connectionConfigVersion: row.connection_config_version,
      downstreamProviders: readDownstream(row.downstream_providers),
      dataCollection: readDataCollection(row.data_collection),
      allowFallbacks: row.allow_fallbacks,
      requireServingProvider: row.require_serving_provider,
      maxConcurrency: row.max_concurrency,
      executionPolicy: readPolicy(row),
    })),
    aliases: aliases.rows.map((row) => ({ alias: row.alias, deploymentId: row.deployment_id })),
    streamingEnabled: tenant.rows[0]?.streaming_enabled ?? false,
  };
}

export async function loadPrivateApproval(client: PoolClient, host: string, port: number): Promise<PrivateApproval | null> {
  const result = await client.query<{
    host: string;
    port: number;
    addresses: string[] | null;
    tls_verify: boolean;
    health_endpoint: string | null;
  }>(
    `SELECT host, port, addresses, tls_verify, health_endpoint
     FROM private_endpoint_allowlist
     WHERE host = $1 AND port = $2`,
    [host, port],
  );
  const row = result.rows[0];
  if (row === undefined || row.addresses === null || row.addresses.length === 0) return null;
  return {
    host: row.host,
    port: row.port,
    addresses: row.addresses,
    tlsVerify: row.tls_verify,
    healthEndpoint: row.health_endpoint,
  };
}

export async function insertPending(
  client: PoolClient,
  tenantId: string,
  route: ResolvedRoute,
): Promise<{ requestId: string; attemptId: string; protectedCredential: string | null }> {
  const request = await client.query<{ id: string }>(
    `INSERT INTO proxy_requests (
       tenant_id, deployment_id, deployment_config_version, connection_id, connection_version, requested_model, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [
      tenantId,
      route.deploymentId,
      route.configVersion,
      route.connectionId,
      route.connectionVersion,
      route.requestedModel,
    ],
  );
  const requestId = request.rows[0]?.id;
  if (requestId === undefined) throw new Error('request was not created');
  const attempt = await client.query<{ id: string }>(
    `INSERT INTO model_attempts (
       tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status,
       attempt_ordinal, policy_id, policy_version
     ) VALUES ($1, $2, $3, $4, $5, 'pending', 1, $6, $7)
     RETURNING id`,
    [
      tenantId,
      requestId,
      route.deploymentId,
      route.configVersion,
      route.upstreamModel,
      route.executionPolicy?.id ?? null,
      route.executionPolicy?.version ?? 1,
    ],
  );
  const attemptId = attempt.rows[0]?.id;
  if (attemptId === undefined) throw new Error('attempt was not created');
  const credential = await client.query<{
    auth_mode: string;
    enabled: boolean;
    protected_credential: string | null;
  }>(
    `SELECT c.auth_mode, c.enabled,
            load_provider_credential($1::uuid, $2::uuid) AS protected_credential
     FROM provider_connections c
     WHERE c.id = $2 AND c.tenant_id = $1`,
    [tenantId, route.connectionId],
  );
  const row = credential.rows[0];
  const secretless = row?.auth_mode === 'adc' || row?.auth_mode === 'workload_identity' || row?.auth_mode === 'impersonation';
  if (row === undefined || !row.enabled || (row.protected_credential === null && !secretless)) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return { requestId, attemptId, protectedCredential: row.protected_credential };
}

export async function insertAttempt(
  client: PoolClient,
  tenantId: string,
  requestId: string,
  route: ResolvedRoute,
  ordinal: number,
): Promise<string> {
  const attempt = await client.query<{ id: string }>(
    `INSERT INTO model_attempts (
       tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status,
       attempt_ordinal, policy_id, policy_version
     ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      requestId,
      route.deploymentId,
      route.configVersion,
      route.upstreamModel,
      ordinal,
      route.executionPolicy?.id ?? null,
      route.executionPolicy?.version ?? 1,
    ],
  );
  const attemptId = attempt.rows[0]?.id;
  if (attemptId === undefined) throw new Error('attempt was not created');
  return attemptId;
}

export async function finishAttempt(
  client: PoolClient,
  input: {
    tenantId: string;
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
    streamStatus?: StreamStatus | null;
    firstTextDeltaMs?: number | null;
    chunkCount?: number | null;
    bytesWritten?: number | null;
    failureClass?: string | null;
    dispatched?: boolean;
    expenseCertainty?: ExpenseCertainty | null;
    closeRequest?: boolean;
  },
): Promise<void> {
  const attempt = await client.query(
    `UPDATE model_attempts
     SET status = $3, error_code = $4, duration_ms = $5,
         prompt_tokens = $6, completion_tokens = $7, total_tokens = $8,
         provider_request_id = $9, stop_reason = $10,
         uncached_input_tokens = $11, cache_creation_input_tokens = $12,
         cache_read_input_tokens = $13,
         stream_status = $14, first_text_delta_ms = $15,
         chunk_count = $16, bytes_written = $17,
         thoughts_tokens = $18,
         serving_model = $19, serving_provider = $20,
         failure_class = $21, dispatched = $22, expense_certainty = $23
     WHERE id = $1 AND tenant_id = $2`,
    [
      input.attemptId,
      input.tenantId,
      input.status,
      input.errorCode,
      input.durationMs,
      input.usage.promptTokens,
      input.usage.completionTokens,
      input.usage.totalTokens,
      input.providerRequestId,
      input.stopReason,
      input.uncachedInputTokens,
      input.cacheCreationInputTokens,
      input.cacheReadInputTokens,
      input.streamStatus ?? null,
      input.firstTextDeltaMs ?? null,
      input.chunkCount ?? null,
      input.bytesWritten ?? null,
      input.thoughtsTokens,
      input.servingModel ?? null,
      input.servingProvider ?? null,
      input.failureClass ?? null,
      input.dispatched ?? false,
      input.expenseCertainty ?? null,
    ],
  );
  if ((attempt.rowCount ?? 0) !== 1) throw new Error('attempt was not updated');
  if (input.closeRequest === false) return;
  await finishRequest(client, input.tenantId, input.requestId, input.status);
}

export async function finishRequest(
  client: PoolClient,
  tenantId: string,
  requestId: string,
  status: 'succeeded' | 'failed',
): Promise<void> {
  const request = await client.query(
    `UPDATE proxy_requests
     SET status = $3, completed_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
    [requestId, tenantId, status],
  );
  if ((request.rowCount ?? 0) !== 1) throw new Error('request was not updated');
}

export async function markStream(
  client: PoolClient,
  input: { tenantId: string; attemptId: string; streamStatus: 'connecting' | 'streaming' },
): Promise<void> {
  const result = await client.query(
    `UPDATE model_attempts
     SET stream_status = $3
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       AND (stream_status IS NULL OR stream_status IN ('connecting', 'streaming'))`,
    [input.attemptId, input.tenantId, input.streamStatus],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('stream status was not updated');
}

export type ModelListItem = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
};

export async function listVisibleModels(client: PoolClient): Promise<ModelListItem[]> {
  const result = await client.query<{ id: string; created: number; owned_by: string }>(
    `SELECT a.alias AS id, floor(extract(epoch FROM a.created_at))::int AS created, 'llm-proxy' AS owned_by
     FROM model_aliases a
     JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
     JOIN provider_connections c ON c.id = d.connection_id AND c.tenant_id = d.tenant_id
     WHERE d.enabled AND c.enabled
     UNION ALL
     SELECT d.name, floor(extract(epoch FROM d.created_at))::int, c.provider
     FROM model_deployments d
     JOIN provider_connections c ON c.id = d.connection_id AND c.tenant_id = d.tenant_id
     WHERE d.enabled AND c.enabled
     ORDER BY id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    object: 'model' as const,
    created: row.created,
    owned_by: row.owned_by,
  }));
}

export type AttemptHistoryItem = {
  attemptId: string;
  requestId: string;
  ordinal: number;
  provider: string;
  deployment: string;
  model: string;
  status: string;
  failureClass: string | null;
  durationMs: number | null;
  expenseCertainty: string | null;
  dispatched: boolean;
  errorCode: string | null;
  createdAt: string;
  costStatus: string | null;
  costAmount: string | null;
};

export async function listAttemptHistory(
  client: PoolClient,
  from: Date,
  to: Date,
  filters: { provider: string | null; deployment: string | null; model: string | null },
): Promise<AttemptHistoryItem[]> {
  const result = await client.query<{
    attempt_id: string;
    request_id: string;
    ordinal: number;
    provider: string;
    deployment: string;
    model: string;
    status: string;
    failure_class: string | null;
    duration_ms: number | null;
    expense_certainty: string | null;
    dispatched: boolean;
    error_code: string | null;
    created_at: Date;
    cost_status: string | null;
    cost_amount: string | null;
  }>(
    `SELECT a.id AS attempt_id, a.request_id, a.attempt_ordinal AS ordinal,
            c.provider, d.name AS deployment, a.upstream_model AS model,
            a.status, a.failure_class, a.duration_ms, a.expense_certainty, a.dispatched,
            a.error_code, a.created_at, ac.cost_status, ac.amount::text AS cost_amount
     FROM model_attempts a
     JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
     JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
     JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = r.connection_id
     LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
     WHERE r.created_at >= $1 AND r.created_at < $2
       AND ($3::text IS NULL OR c.provider = $3)
       AND ($4::text IS NULL OR d.name = $4)
       AND ($5::text IS NULL OR a.upstream_model = $5)
     ORDER BY a.created_at, a.attempt_ordinal`,
    [from, to, filters.provider, filters.deployment, filters.model],
  );
  return result.rows.map((row) => ({
    attemptId: row.attempt_id,
    requestId: row.request_id,
    ordinal: row.ordinal,
    provider: row.provider,
    deployment: row.deployment,
    model: row.model,
    status: row.status,
    failureClass: row.failure_class,
    durationMs: row.duration_ms,
    expenseCertainty: row.expense_certainty,
    dispatched: row.dispatched,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    costStatus: row.cost_status,
    costAmount: row.cost_amount,
  }));
}

export type StreamCount = {
  requests: number;
  completed: number;
  cancelled: number;
  errors: number;
  truncated: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type MetricsSummary = {
  window: { from: string; to: string };
  requests: { total: number; succeeded: number; failed: number; pending: number };
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    responsesMissingUsage: number;
  };
  latency: { samples: number; sumMs: number | null; maxMs: number | null };
  streaming: {
    requests: number;
    completed: number;
    cancelled: number;
    errors: number;
    truncated: number;
    firstTextDeltaMs: { samples: number; p50: number | null; p95: number | null };
    durationMs: { samples: number; p50: number | null; p95: number | null };
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    };
  };
  byProvider: Array<StreamCount & { provider: string }>;
  byDeployment: Array<StreamCount & { provider: string; deployment: string }>;
};

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOrNull(value: unknown): number | null {
  const parsed = sumOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

const STREAM_ERROR_STATUSES = `('provider_failed', 'timed_out', 'slow_consumer', 'interrupted')`;

type StreamCountRow = {
  requests: number;
  completed: number;
  cancelled: number;
  errors: number;
  truncated: number;
  prompt_tokens: string | null;
  completion_tokens: string | null;
  total_tokens: string | null;
};

function streamCountFrom(row: StreamCountRow | undefined): Omit<StreamCount, never> {
  return {
    requests: count(row?.requests),
    completed: count(row?.completed),
    cancelled: count(row?.cancelled),
    errors: count(row?.errors),
    truncated: count(row?.truncated),
    promptTokens: sumOrNull(row?.prompt_tokens),
    completionTokens: sumOrNull(row?.completion_tokens),
    totalTokens: sumOrNull(row?.total_tokens),
  };
}

function addToken(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

export async function summarizeMetrics(client: PoolClient, from: Date, to: Date): Promise<MetricsSummary> {
  const requests = await client.query<{
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM proxy_requests
     WHERE created_at >= $1 AND created_at < $2`,
    [from, to],
  );
  const attempts = await client.query<{
    prompt_tokens: string | null;
    completion_tokens: string | null;
    total_tokens: string | null;
    missing_usage: number;
    latency_samples: number;
    latency_sum: string | null;
    latency_max: number | null;
  }>(
    `SELECT sum(a.prompt_tokens)::bigint AS prompt_tokens,
            sum(a.completion_tokens)::bigint AS completion_tokens,
            sum(a.total_tokens)::bigint AS total_tokens,
            count(*) FILTER (
              WHERE a.status = 'succeeded'
                AND a.prompt_tokens IS NULL
                AND a.completion_tokens IS NULL
                AND a.total_tokens IS NULL
            )::int AS missing_usage,
            count(a.duration_ms)::int AS latency_samples,
            sum(a.duration_ms)::bigint AS latency_sum,
            max(a.duration_ms)::int AS latency_max
     FROM model_attempts a
     JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
     WHERE r.created_at >= $1 AND r.created_at < $2`,
    [from, to],
  );
  const streams = await client.query<StreamCountRow>(
    `SELECT count(*) FILTER (WHERE a.stream_status IS NOT NULL)::int AS requests,
            count(*) FILTER (WHERE a.stream_status = 'completed')::int AS completed,
            count(*) FILTER (WHERE a.stream_status = 'client_aborted')::int AS cancelled,
            count(*) FILTER (WHERE a.stream_status IN ${STREAM_ERROR_STATUSES})::int AS errors,
            count(*) FILTER (WHERE a.stream_status = 'stream_truncated')::int AS truncated,
            sum(a.prompt_tokens) FILTER (WHERE a.stream_status IS NOT NULL)::bigint AS prompt_tokens,
            sum(a.completion_tokens) FILTER (WHERE a.stream_status IS NOT NULL)::bigint AS completion_tokens,
            sum(a.total_tokens) FILTER (WHERE a.stream_status IS NOT NULL)::bigint AS total_tokens
     FROM model_attempts a
     JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
     WHERE r.created_at >= $1 AND r.created_at < $2`,
    [from, to],
  );
  const firstText = await client.query<{ samples: number; p50: number | null; p95: number | null }>(
    `SELECT count(a.first_text_delta_ms)::int AS samples,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY a.first_text_delta_ms) AS p50,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY a.first_text_delta_ms) AS p95
     FROM model_attempts a
     JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
     WHERE r.created_at >= $1 AND r.created_at < $2
       AND a.stream_status IS NOT NULL
       AND a.first_text_delta_ms IS NOT NULL`,
    [from, to],
  );
  const duration = await client.query<{ samples: number; p50: number | null; p95: number | null }>(
    `SELECT count(a.duration_ms)::int AS samples,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY a.duration_ms) AS p50,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95
     FROM model_attempts a
     JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
     WHERE r.created_at >= $1 AND r.created_at < $2
       AND a.stream_status IS NOT NULL
       AND a.duration_ms IS NOT NULL`,
    [from, to],
  );
  const deployments = await client.query<
    StreamCountRow & { provider: string; deployment: string }
  >(
    `SELECT c.provider AS provider,
            d.name AS deployment,
            count(*)::int AS requests,
            count(*) FILTER (
              WHERE a.stream_status = 'completed'
                 OR (a.stream_status IS NULL AND a.status = 'succeeded')
            )::int AS completed,
            count(*) FILTER (
              WHERE a.stream_status = 'client_aborted'
                 OR (a.stream_status IS NULL AND a.error_code = 'request_cancelled')
            )::int AS cancelled,
            count(*) FILTER (
              WHERE a.stream_status IN ${STREAM_ERROR_STATUSES}
                 OR (
                   a.stream_status IS NULL
                   AND a.status = 'failed'
                   AND a.error_code IS DISTINCT FROM 'request_cancelled'
                 )
            )::int AS errors,
            count(*) FILTER (WHERE a.stream_status = 'stream_truncated')::int AS truncated,
            sum(a.prompt_tokens)::bigint AS prompt_tokens,
            sum(a.completion_tokens)::bigint AS completion_tokens,
            sum(a.total_tokens)::bigint AS total_tokens
     FROM model_attempts a
     JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
     JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
     JOIN provider_connections c ON c.id = d.connection_id AND c.tenant_id = d.tenant_id
     WHERE r.created_at >= $1 AND r.created_at < $2
     GROUP BY c.provider, d.name
     ORDER BY c.provider, d.name`,
    [from, to],
  );
  const requestRow = requests.rows[0];
  const attemptRow = attempts.rows[0];
  const streamRow = streamCountFrom(streams.rows[0]);
  const firstRow = firstText.rows[0];
  const durationRow = duration.rows[0];
  const byDeployment = deployments.rows.map((row) => ({
    provider: row.provider,
    deployment: row.deployment,
    ...streamCountFrom(row),
  }));
  const byProviderMap = new Map<string, StreamCount>();
  for (const row of byDeployment) {
    const current = byProviderMap.get(row.provider) ?? {
      requests: 0,
      completed: 0,
      cancelled: 0,
      errors: 0,
      truncated: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
    byProviderMap.set(row.provider, {
      requests: current.requests + row.requests,
      completed: current.completed + row.completed,
      cancelled: current.cancelled + row.cancelled,
      errors: current.errors + row.errors,
      truncated: current.truncated + row.truncated,
      promptTokens: addToken(current.promptTokens, row.promptTokens),
      completionTokens: addToken(current.completionTokens, row.completionTokens),
      totalTokens: addToken(current.totalTokens, row.totalTokens),
    });
  }
  const firstSamples = count(firstRow?.samples);
  const durationSamples = count(durationRow?.samples);
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    requests: {
      total: count(requestRow?.total),
      succeeded: count(requestRow?.succeeded),
      failed: count(requestRow?.failed),
      pending: count(requestRow?.pending),
    },
    usage: {
      promptTokens: sumOrNull(attemptRow?.prompt_tokens),
      completionTokens: sumOrNull(attemptRow?.completion_tokens),
      totalTokens: sumOrNull(attemptRow?.total_tokens),
      responsesMissingUsage: count(attemptRow?.missing_usage),
    },
    latency: {
      samples: count(attemptRow?.latency_samples),
      sumMs: sumOrNull(attemptRow?.latency_sum),
      maxMs: attemptRow?.latency_max ?? null,
    },
    streaming: {
      requests: streamRow.requests,
      completed: streamRow.completed,
      cancelled: streamRow.cancelled,
      errors: streamRow.errors,
      truncated: streamRow.truncated,
      firstTextDeltaMs: {
        samples: firstSamples,
        p50: firstSamples === 0 ? null : intOrNull(firstRow?.p50),
        p95: firstSamples === 0 ? null : intOrNull(firstRow?.p95),
      },
      durationMs: {
        samples: durationSamples,
        p50: durationSamples === 0 ? null : intOrNull(durationRow?.p50),
        p95: durationSamples === 0 ? null : intOrNull(durationRow?.p95),
      },
      usage: {
        promptTokens: streamRow.promptTokens,
        completionTokens: streamRow.completionTokens,
        totalTokens: streamRow.totalTokens,
      },
    },
    byProvider: [...byProviderMap.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([provider, counts]) => ({ provider, ...counts })),
    byDeployment,
  };
}
