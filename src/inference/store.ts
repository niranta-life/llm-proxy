import type { PoolClient } from 'pg';
import { proxyError } from './errors.js';
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
};

function providerName(value: string): 'openai' | 'anthropic' {
  if (value === 'openai' || value === 'anthropic') return value;
  throw new Error('provider is invalid');
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
            d.default_max_output_tokens, d.streaming_enabled,
            d.stream_connect_timeout_ms, d.stream_idle_timeout_ms,
            d.stream_total_timeout_ms, d.stream_backpressure_timeout_ms
     FROM model_deployments d
     JOIN provider_connections c
       ON c.tenant_id = d.tenant_id AND c.id = d.connection_id`,
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
    })),
    aliases: aliases.rows.map((row) => ({ alias: row.alias, deploymentId: row.deployment_id })),
    streamingEnabled: tenant.rows[0]?.streaming_enabled ?? false,
  };
}

export async function insertPending(
  client: PoolClient,
  tenantId: string,
  route: ResolvedRoute,
): Promise<{ requestId: string; attemptId: string; protectedCredential: string }> {
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
       tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status
     ) VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [tenantId, requestId, route.deploymentId, route.configVersion, route.upstreamModel],
  );
  const attemptId = attempt.rows[0]?.id;
  if (attemptId === undefined) throw new Error('attempt was not created');
  const credential = await client.query<{ protected_credential: string | null }>(
    'SELECT load_provider_credential($1::uuid, $2::uuid) AS protected_credential',
    [tenantId, route.connectionId],
  );
  const protectedCredential = credential.rows[0]?.protected_credential;
  if (protectedCredential === undefined || protectedCredential === null) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return { requestId, attemptId, protectedCredential };
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
    streamStatus?: StreamStatus | null;
    firstTextDeltaMs?: number | null;
    chunkCount?: number | null;
    bytesWritten?: number | null;
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
         chunk_count = $16, bytes_written = $17
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
    ],
  );
  if ((attempt.rowCount ?? 0) !== 1) throw new Error('attempt was not updated');
  const request = await client.query(
    `UPDATE proxy_requests
     SET status = $3, completed_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [input.requestId, input.tenantId, input.status],
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
  const requestRow = requests.rows[0];
  const attemptRow = attempts.rows[0];
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
  };
}
