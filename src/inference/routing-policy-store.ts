import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { invalidRequest, proxyError } from './errors.js';
import { FEATURE_EXTRACTOR_VERSION } from './request-features.js';
import type { ResolvedRoute } from './resolve.js';
import {
  nextRoutingStatus,
  routingConfigDigest,
  routingRequestHash,
  type RoutingStatus,
  type RoutingWrite,
} from './routing-policy.js';

export type RoutingEventView = {
  status: RoutingStatus;
  epoch: number;
  versionId: string;
};

export type RoutingPolicyView = {
  id: string;
  name: string;
  alias: 'auto';
  version: number;
  versionId: string;
  status: RoutingStatus;
  epoch: number;
  configDigest: string;
  baselineDeployment: string;
  candidateDeployments: string[];
  qualityMinPassRate: string;
  qualityMinValidPairs: number;
  maxCostPerRequest: string;
  maxLatencyMs: number;
  taskSegments: string[];
  events: RoutingEventView[];
};

export type RoutingDecisionView = {
  tenantId: string;
  requestId: string;
  alias: 'auto' | null;
  baselineDeployment: string | null;
  selectedDeployment: string;
  policyVersionId: string | null;
  activationEpoch: number | null;
  featureExtractorVersion: number;
  routingMode: 'static' | 'shadow' | 'bypass';
  reasonCodes: string[];
};

type PolicyRow = {
  id: string;
  name: string;
  version: number;
  version_id: string;
  status: RoutingStatus;
  epoch: number;
  config_digest: string;
  baseline_deployment: string;
  candidate_deployment_ids: string[];
  quality_min_pass_rate: string;
  quality_min_valid_pairs: number;
  max_cost_per_request: string;
  max_latency_ms: number;
  task_segments: string[];
};

const POLICY_SQL = `SELECT p.id::text AS id, p.name, v.version, v.id::text AS version_id, a.status, a.epoch,
            v.config_digest, b.name AS baseline_deployment, v.candidate_deployment_ids::text[] AS candidate_deployment_ids,
            v.quality_min_pass_rate::text AS quality_min_pass_rate, v.quality_min_valid_pairs,
            v.max_cost_per_request::text AS max_cost_per_request, v.max_latency_ms, v.task_segments
     FROM routing_policies p
     JOIN routing_policy_activations a ON a.tenant_id = p.tenant_id AND a.policy_id = p.id
     JOIN routing_policy_versions v ON v.tenant_id = p.tenant_id AND v.id = a.version_id
     JOIN model_deployments b ON b.tenant_id = p.tenant_id AND b.id = v.baseline_deployment_id`;

export async function keyRoutingPermissions(authPool: Pool, tenantId: string, keyId: string): Promise<ReadonlySet<string>> {
  const result = await authPool.query<{ permissions: string[] | null }>(
    'SELECT key_routing_permissions($1::uuid, $2::uuid) AS permissions',
    [tenantId, keyId],
  );
  return new Set(result.rows[0]?.permissions ?? []);
}

export async function createRoutingPolicy(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  write: RoutingWrite,
): Promise<{ policy: RoutingPolicyView; created: boolean }> {
  const requestHash = routingRequestHash(write);
  const existing = await readIdempotentVersion(client, idempotencyKey);
  if (existing !== null) {
    if (existing.requestHash !== requestHash) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return { policy: await readRoutingPolicy(client, existing.policyId), created: false };
  }
  const targets = await resolveTargets(client, write);
  const digest = routingConfigDigest({
    alias: 'auto',
    baselineDeploymentId: targets.baselineId,
    candidateDeploymentIds: targets.candidateIds,
    qualityMinPassRate: write.qualityMinPassRate,
    qualityMinValidPairs: write.qualityMinValidPairs,
    maxCostPerRequest: write.maxCostPerRequest,
    maxLatencyMs: write.maxLatencyMs,
    taskSegments: write.taskSegments,
  });
  let policyId = '';
  await client.query('SAVEPOINT routing_policy_create');
  try {
    const policy = await client.query<{ id: string }>(
      `INSERT INTO routing_policies (tenant_id, name, alias)
       VALUES ($1, $2, 'auto')
       RETURNING id::text AS id`,
      [tenantId, write.name],
    );
    policyId = requiredId(policy.rows[0]?.id, 'policy was not created');
    const version = await client.query<{ id: string }>(
      `INSERT INTO routing_policy_versions (
         tenant_id, policy_id, version, alias, baseline_deployment_id, candidate_deployment_ids,
         quality_min_pass_rate, quality_min_valid_pairs, max_cost_per_request, max_latency_ms,
         task_segments, config_digest, idempotency_key, request_hash
       ) VALUES (
         $1, $2, 1, 'auto', $3, $4::uuid[], $5, $6, $7, $8, $9::text[], $10, $11, $12
       ) RETURNING id::text AS id`,
      [
        tenantId,
        policyId,
        targets.baselineId,
        targets.candidateIds,
        write.qualityMinPassRate,
        write.qualityMinValidPairs,
        write.maxCostPerRequest,
        write.maxLatencyMs,
        write.taskSegments,
        digest,
        idempotencyKey,
        requestHash,
      ],
    );
    const versionId = requiredId(version.rows[0]?.id, 'policy version was not created');
    await client.query(
      `INSERT INTO routing_policy_activations (tenant_id, policy_id, version_id, alias, status, epoch)
       VALUES ($1, $2, $3, 'auto', 'draft', 1)`,
      [tenantId, policyId, versionId],
    );
    await insertEvent(client, {
      tenantId,
      policyId,
      versionId,
      status: 'draft',
      epoch: 1,
      idempotencyKey,
      requestHash,
    });
    await client.query('RELEASE SAVEPOINT routing_policy_create');
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT routing_policy_create');
    await client.query('RELEASE SAVEPOINT routing_policy_create');
    const raced = await readIdempotentVersion(client, idempotencyKey);
    if (raced !== null && raced.requestHash === requestHash) {
      return { policy: await readRoutingPolicy(client, raced.policyId), created: false };
    }
    if (raced !== null) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    const event = await client.query(
      `SELECT 1 FROM routing_policy_activation_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (event.rows.length > 0) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    throw proxyError(409, 'invalid_request_error', 'policy_name_conflict', 'name', 'The policy name is already stored.');
  }
  return { policy: await readRoutingPolicy(client, policyId), created: true };
}

export async function listRoutingPolicies(client: PoolClient): Promise<RoutingPolicyView[]> {
  const result = await client.query<PolicyRow>(`${POLICY_SQL} ORDER BY p.created_at, p.id`);
  return Promise.all(result.rows.map((row) => presentPolicy(client, row)));
}

export async function readRoutingPolicy(client: PoolClient, policyId: string): Promise<RoutingPolicyView> {
  const result = await client.query<PolicyRow>(`${POLICY_SQL} WHERE p.id = $1`, [policyId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'policy_id', 'The policy was not found.');
  }
  return presentPolicy(client, row);
}

export async function validateRoutingPolicy(
  client: PoolClient,
  tenantId: string,
  policyId: string,
  idempotencyKey: string,
  expectedEpoch: number,
): Promise<RoutingPolicyView> {
  return changeRoutingStatus(client, tenantId, policyId, idempotencyKey, 'validated', expectedEpoch);
}

export async function setRoutingStatus(
  client: PoolClient,
  tenantId: string,
  policyId: string,
  idempotencyKey: string,
  status: 'shadow' | 'disabled',
  expectedEpoch: number,
): Promise<RoutingPolicyView> {
  return changeRoutingStatus(client, tenantId, policyId, idempotencyKey, status, expectedEpoch);
}

export async function recordRoutingDecision(
  client: PoolClient,
  tenantId: string,
  requestId: string,
  route: ResolvedRoute,
): Promise<void> {
  if (route.routedByAlias !== true) {
    await client.query(
      `INSERT INTO routing_decisions (
         tenant_id, request_id, alias, baseline_deployment_id, selected_deployment_id,
         policy_version_id, activation_epoch, feature_extractor_version, routing_mode, reason_codes
       ) VALUES ($1, $2, NULL, NULL, $3, NULL, NULL, $4, 'bypass', ARRAY['named_model']::text[])`,
      [tenantId, requestId, route.deploymentId, FEATURE_EXTRACTOR_VERSION],
    );
    return;
  }
  const shadow = await client.query<{ version_id: string; epoch: number; baseline_deployment_id: string }>(
    `SELECT a.version_id::text AS version_id, a.epoch, v.baseline_deployment_id::text AS baseline_deployment_id
     FROM routing_policy_activations a
     JOIN routing_policy_versions v ON v.tenant_id = a.tenant_id AND v.id = a.version_id
     WHERE a.alias = 'auto' AND a.status = 'shadow'
     LIMIT 1`,
  );
  const active = shadow.rows[0];
  if (active === undefined) {
    await client.query(
      `INSERT INTO routing_decisions (
         tenant_id, request_id, alias, baseline_deployment_id, selected_deployment_id,
         policy_version_id, activation_epoch, feature_extractor_version, routing_mode, reason_codes
       ) VALUES ($1, $2, 'auto', $3, $3, NULL, NULL, $4, 'static', ARRAY['static_alias']::text[])`,
      [tenantId, requestId, route.deploymentId, FEATURE_EXTRACTOR_VERSION],
    );
    return;
  }
  await client.query(
    `INSERT INTO routing_decisions (
       tenant_id, request_id, alias, baseline_deployment_id, selected_deployment_id,
       policy_version_id, activation_epoch, feature_extractor_version, routing_mode, reason_codes
     ) VALUES ($1, $2, 'auto', $3, $4, $5, $6, $7, 'shadow', ARRAY['shadow_observed']::text[])`,
    [
      tenantId,
      requestId,
      active.baseline_deployment_id,
      route.deploymentId,
      active.version_id,
      Number(active.epoch),
      FEATURE_EXTRACTOR_VERSION,
    ],
  );
}

export async function readRoutingDecision(client: PoolClient, requestId: string): Promise<RoutingDecisionView | null> {
  const result = await client.query<{
    tenant_id: string;
    request_id: string;
    alias: 'auto' | null;
    baseline_deployment: string | null;
    selected_deployment: string;
    policy_version_id: string | null;
    activation_epoch: number | null;
    feature_extractor_version: number;
    routing_mode: 'static' | 'shadow' | 'bypass';
    reason_codes: string[];
  }>(
    `SELECT d.tenant_id::text AS tenant_id, d.request_id::text AS request_id, d.alias,
            b.name AS baseline_deployment, s.name AS selected_deployment,
            d.policy_version_id::text AS policy_version_id, d.activation_epoch,
            d.feature_extractor_version, d.routing_mode, d.reason_codes
     FROM routing_decisions d
     JOIN model_deployments s ON s.tenant_id = d.tenant_id AND s.id = d.selected_deployment_id
     LEFT JOIN model_deployments b ON b.tenant_id = d.tenant_id AND b.id = d.baseline_deployment_id
     WHERE d.request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    tenantId: row.tenant_id,
    requestId: row.request_id,
    alias: row.alias,
    baselineDeployment: row.baseline_deployment,
    selectedDeployment: row.selected_deployment,
    policyVersionId: row.policy_version_id,
    activationEpoch: row.activation_epoch === null ? null : Number(row.activation_epoch),
    featureExtractorVersion: Number(row.feature_extractor_version),
    routingMode: row.routing_mode,
    reasonCodes: textList(row.reason_codes),
  };
}

async function changeRoutingStatus(
  client: PoolClient,
  tenantId: string,
  policyId: string,
  idempotencyKey: string,
  requested: RoutingStatus,
  expectedEpoch: number,
): Promise<RoutingPolicyView> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ policyId, status: requested, expectedEpoch }))
    .digest('hex');
  const existing = await client.query<{ policy_id: string; request_hash: string }>(
    `SELECT policy_id::text AS policy_id, request_hash
     FROM routing_policy_activation_events
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== requestHash || stored.policy_id !== policyId) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return readRoutingPolicy(client, policyId);
  }
  const current = await client.query<{ status: RoutingStatus; epoch: number; version_id: string }>(
    `SELECT status, epoch, version_id::text AS version_id
     FROM routing_policy_activations
     WHERE policy_id = $1`,
    [policyId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'policy_id', 'The policy was not found.');
  }
  if (Number(row.epoch) !== expectedEpoch) {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The policy epoch is stale.');
  }
  const next = nextRoutingStatus(row.status, requested);
  if (next === 'shadow') {
    const other = await client.query(
      `SELECT 1 FROM routing_policy_activations
       WHERE alias = 'auto' AND status = 'shadow' AND policy_id <> $1`,
      [policyId],
    );
    if (other.rows.length > 0) {
      throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'status', 'Another policy is already in shadow.');
    }
  }
  await client.query('SAVEPOINT routing_status');
  try {
    const updated = await client.query<{ epoch: number }>(
      `UPDATE routing_policy_activations
       SET status = $2, epoch = epoch + 1, updated_at = statement_timestamp()
       WHERE policy_id = $1 AND epoch = $3
       RETURNING epoch`,
      [policyId, next, expectedEpoch],
    );
    const epoch = updated.rows[0]?.epoch;
    if (epoch === undefined) {
      throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The policy epoch is stale.');
    }
    await insertEvent(client, {
      tenantId,
      policyId,
      versionId: row.version_id,
      status: next,
      epoch: Number(epoch),
      idempotencyKey,
      requestHash,
    });
    await client.query('RELEASE SAVEPOINT routing_status');
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT routing_status');
    await client.query('RELEASE SAVEPOINT routing_status');
    const raced = await client.query<{ request_hash: string }>(
      `SELECT request_hash
       FROM routing_policy_activation_events
       WHERE idempotency_key = $1 AND policy_id = $2`,
      [idempotencyKey, policyId],
    );
    if (raced.rows[0]?.request_hash === requestHash) return readRoutingPolicy(client, policyId);
    if (raced.rows.length > 0) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'status', 'Another policy is already in shadow.');
  }
  return readRoutingPolicy(client, policyId);
}

async function presentPolicy(client: PoolClient, row: PolicyRow): Promise<RoutingPolicyView> {
  const names = await client.query<{ name: string }>(
    `SELECT d.name
     FROM unnest($1::uuid[]) WITH ORDINALITY AS listed(id, ordinal)
     JOIN model_deployments d ON d.id = listed.id
     ORDER BY listed.ordinal`,
    [textList(row.candidate_deployment_ids)],
  );
  const events = await client.query<RoutingEventView & { version_id: string }>(
    `SELECT status, epoch, version_id::text AS version_id
     FROM routing_policy_activation_events
     WHERE policy_id = $1
     ORDER BY epoch`,
    [row.id],
  );
  return {
    id: row.id,
    name: row.name,
    alias: 'auto',
    version: Number(row.version),
    versionId: row.version_id,
    status: row.status,
    epoch: Number(row.epoch),
    configDigest: row.config_digest,
    baselineDeployment: row.baseline_deployment,
    candidateDeployments: names.rows.map((item) => item.name),
    qualityMinPassRate: fixedDecimal(row.quality_min_pass_rate, 5),
    qualityMinValidPairs: Number(row.quality_min_valid_pairs),
    maxCostPerRequest: fixedDecimal(row.max_cost_per_request, 8),
    maxLatencyMs: Number(row.max_latency_ms),
    taskSegments: textList(row.task_segments),
    events: events.rows.map((event) => ({
      status: event.status,
      epoch: Number(event.epoch),
      versionId: event.version_id,
    })),
  };
}

async function resolveTargets(
  client: PoolClient,
  write: RoutingWrite,
): Promise<{ baselineId: string; candidateIds: string[] }> {
  const alias = await client.query(`SELECT 1 FROM model_aliases WHERE alias = 'auto'`);
  if (alias.rows.length === 0) throw invalidRequest('alias', 'unknown_alias', 'The alias is not configured.');
  const names = [...new Set([write.baselineDeployment, ...write.candidateDeployments])];
  const result = await client.query<{ id: string; name: string; ready: boolean }>(
    `SELECT d.id::text AS id, d.name, (d.enabled AND c.enabled) AS ready
     FROM model_deployments d
     JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE d.name = ANY($1::text[])`,
    [names],
  );
  const byName = new Map(result.rows.map((row) => [row.name, row]));
  const baseline = byName.get(write.baselineDeployment);
  if (baseline === undefined) {
    throw invalidRequest('baselineDeployment', 'missing_baseline', 'The baseline deployment was not found.');
  }
  if (!baseline.ready) throw invalidRequest('baselineDeployment', 'deployment_disabled', 'The deployment is disabled.');
  const candidateIds: string[] = [];
  for (const name of write.candidateDeployments) {
    const candidate = byName.get(name);
    if (candidate === undefined) {
      throw invalidRequest('candidateDeployments', 'candidate_not_in_tenant', 'A candidate deployment is not in this tenant.');
    }
    if (!candidate.ready) throw invalidRequest('candidateDeployments', 'deployment_disabled', 'The deployment is disabled.');
    candidateIds.push(candidate.id);
  }
  return { baselineId: baseline.id, candidateIds };
}

async function readIdempotentVersion(
  client: PoolClient,
  idempotencyKey: string,
): Promise<{ policyId: string; requestHash: string } | null> {
  const result = await client.query<{ policy_id: string; request_hash: string }>(
    `SELECT policy_id::text AS policy_id, request_hash
     FROM routing_policy_versions
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { policyId: row.policy_id, requestHash: row.request_hash };
}

async function insertEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    policyId: string;
    versionId: string;
    status: RoutingStatus;
    epoch: number;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO routing_policy_activation_events (
       tenant_id, policy_id, version_id, alias, status, epoch, idempotency_key, request_hash
     ) VALUES ($1, $2, $3, 'auto', $4, $5, $6, $7)`,
    [input.tenantId, input.policyId, input.versionId, input.status, input.epoch, input.idempotencyKey, input.requestHash],
  );
}

function requiredId(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    if (value.length === 2) return [];
    return value.slice(1, -1).split(',');
  }
  return [];
}

function fixedDecimal(value: string, places: number): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
}
