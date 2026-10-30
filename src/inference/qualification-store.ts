import type { PoolClient } from 'pg';
import { proxyError } from './errors.js';
import { proposeFromSnapshot } from './promotion-store.js';
import {
  qualificationDigest,
  qualificationRequestHash,
  qualifyCohort,
  refreshRequestHash,
  type ObjectiveResult,
  type QualificationItem,
  type QualificationProfile,
  type QualificationStatus,
  type QualificationUncertainty,
  type QualificationWrite,
} from './qualification.js';

export type QualificationProfileView = {
  id: string;
  versionId: string;
  version: number;
  name: string;
  taskCategory: string;
  complexity: string;
  inputSizeCategory: string;
  outputRequirementId: string;
  requiredCapabilities: string[];
  candidateDeployment: string;
  modelVersion: string;
  deploymentConfigVersion: number;
  adapterVersion: number;
  minSamples: number;
  objectiveFloor: string;
  maxIntervalWidth: string;
  noninferiorityMargin: string;
  freshnessSeconds: number;
  minCoverage: string;
  configDigest: string;
  createdAt: string;
};

export type EvidenceSnapshotView = {
  id: string;
  profileVersionId: string;
  taskCategory: string;
  complexity: string;
  inputSizeCategory: string;
  outputRequirementId: string;
  requiredCapabilities: string[];
  candidateDeployment: string;
  modelVersion: string;
  deploymentConfigVersion: number;
  adapterVersion: number;
  status: QualificationStatus;
  reasonCodes: string[];
  uncertainty: QualificationUncertainty;
  sourceRunIds: string[];
  sampleCount: number;
  coverageRate: number;
  createdAt: string;
};

type ProfileRow = {
  id: string;
  version_id: string;
  version: number;
  name: string;
  task_category: string;
  complexity: string;
  input_size_category: string;
  output_requirement_id: string;
  required_capabilities: string[] | string;
  candidate_deployment: string;
  candidate_deployment_id: string;
  model_version: string;
  deployment_config_version: number;
  adapter_version: number;
  min_samples: number;
  objective_floor: string;
  max_interval_width: string;
  noninferiority_margin: string;
  freshness_seconds: number;
  min_coverage: string;
  config_digest: string;
  request_hash: string;
  created_at: Date;
};

type SnapshotRow = {
  id: string;
  profile_version_id: string;
  task_category: string;
  complexity: string;
  input_size_category: string;
  output_requirement_id: string;
  required_capabilities: string[] | string;
  candidate_deployment: string;
  model_version: string;
  deployment_config_version: number;
  adapter_version: number;
  status: QualificationStatus;
  reason_codes: string[] | string;
  wilson_lower: string | null;
  wilson_upper: string | null;
  difference_lower: string | null;
  source_run_ids: string[] | string;
  matched_pairs: number;
  coverage_rate: string;
  created_at: Date;
  request_hash: string;
};

const PROFILE_SQL = `SELECT p.id::text AS id,
            v.id::text AS version_id,
            v.version,
            p.name,
            v.task_category,
            v.complexity,
            v.input_size_category,
            v.output_requirement_id::text AS output_requirement_id,
            v.required_capabilities,
            d.name AS candidate_deployment,
            v.candidate_deployment_id::text AS candidate_deployment_id,
            v.model_version,
            v.deployment_config_version,
            v.adapter_version,
            v.min_samples,
            v.objective_floor::text AS objective_floor,
            v.max_interval_width::text AS max_interval_width,
            v.noninferiority_margin::text AS noninferiority_margin,
            v.freshness_seconds,
            v.min_coverage::text AS min_coverage,
            v.config_digest,
            v.request_hash,
            v.created_at
     FROM qualification_profiles p
     JOIN qualification_profile_versions v
       ON v.tenant_id = p.tenant_id AND v.profile_id = p.id
     JOIN model_deployments d
       ON d.tenant_id = v.tenant_id AND d.id = v.candidate_deployment_id`;

const SNAPSHOT_SQL = `SELECT s.id::text AS id,
            s.profile_version_id::text AS profile_version_id,
            v.task_category,
            v.complexity,
            v.input_size_category,
            v.output_requirement_id::text AS output_requirement_id,
            v.required_capabilities,
            d.name AS candidate_deployment,
            v.model_version,
            v.deployment_config_version,
            v.adapter_version,
            a.status,
            a.reason_codes,
            a.wilson_lower::text AS wilson_lower,
            a.wilson_upper::text AS wilson_upper,
            a.difference_lower::text AS difference_lower,
            s.source_run_ids,
            s.matched_pairs,
            s.coverage_rate::text AS coverage_rate,
            s.created_at,
            s.request_hash
     FROM evidence_snapshots s
     JOIN qualification_profile_versions v
       ON v.tenant_id = s.tenant_id AND v.id = s.profile_version_id
     JOIN model_deployments d
       ON d.tenant_id = v.tenant_id AND d.id = v.candidate_deployment_id
     JOIN evidence_candidate_assessments a
       ON a.tenant_id = s.tenant_id AND a.snapshot_id = s.id`;

export async function createQualificationProfile(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  write: QualificationWrite,
): Promise<{ profile: QualificationProfileView; created: boolean }> {
  const requestHash = qualificationRequestHash(write);
  const existing = await client.query<{ version_id: string; request_hash: string }>(
    `SELECT id::text AS version_id, request_hash
     FROM qualification_profile_versions
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    if (prior.request_hash !== requestHash) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return { profile: await readProfileByVersion(client, prior.version_id), created: false };
  }
  const deployment = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM model_deployments WHERE name = $1`,
    [write.candidateDeployment],
  );
  const deploymentId = deployment.rows[0]?.id;
  if (deploymentId === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'candidateDeployment', 'The deployment was not found.');
  }
  const requirement = await client.query(
    `SELECT 1 FROM evaluation_profile_versions WHERE id = $1 AND status = 'approved'`,
    [write.outputRequirementId],
  );
  if ((requirement.rowCount ?? 0) !== 1) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'outputRequirementId', 'The output requirement was not found.');
  }
  const digest = qualificationDigest({
    taskCategory: write.taskCategory,
    complexity: write.complexity,
    inputSizeCategory: write.inputSizeCategory,
    outputRequirementId: write.outputRequirementId,
    requiredCapabilities: write.requiredCapabilities,
    candidateDeploymentId: deploymentId,
    modelVersion: write.modelVersion,
    deploymentConfigVersion: write.deploymentConfigVersion,
    adapterVersion: write.adapterVersion,
    minSamples: write.minSamples,
    objectiveFloor: write.objectiveFloor,
    maxIntervalWidth: write.maxIntervalWidth,
    noninferiorityMargin: write.noninferiorityMargin,
    freshnessSeconds: write.freshnessSeconds,
    minCoverage: write.minCoverage,
  });
  let profileId = '';
  await client.query('SAVEPOINT qualification_profile_create');
  try {
    const profile = await client.query<{ id: string }>(
      `INSERT INTO qualification_profiles (tenant_id, name)
       VALUES ($1, $2)
       RETURNING id::text AS id`,
      [tenantId, write.name],
    );
    profileId = requiredId(profile.rows[0]?.id, 'qualification profile was not created');
    await client.query(
      `INSERT INTO qualification_profile_versions (
         tenant_id, profile_id, version, task_category, complexity, input_size_category,
         output_requirement_id, required_capabilities, candidate_deployment_id, model_version,
         deployment_config_version, adapter_version, min_samples, objective_floor, max_interval_width,
         noninferiority_margin, freshness_seconds, min_coverage, config_digest, idempotency_key, request_hash
       ) VALUES (
         $1, $2, 1, $3, $4, $5,
         $6, $7::text[], $8, $9,
         $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20
       )`,
      [
        tenantId,
        profileId,
        write.taskCategory,
        write.complexity,
        write.inputSizeCategory,
        write.outputRequirementId,
        write.requiredCapabilities,
        deploymentId,
        write.modelVersion,
        write.deploymentConfigVersion,
        write.adapterVersion,
        write.minSamples,
        write.objectiveFloor,
        write.maxIntervalWidth,
        write.noninferiorityMargin,
        write.freshnessSeconds,
        write.minCoverage,
        digest,
        idempotencyKey,
        requestHash,
      ],
    );
    await client.query('RELEASE SAVEPOINT qualification_profile_create');
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT qualification_profile_create');
    await client.query('RELEASE SAVEPOINT qualification_profile_create');
    const raced = await client.query<{ version_id: string; request_hash: string }>(
      `SELECT id::text AS version_id, request_hash
       FROM qualification_profile_versions
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = raced.rows[0];
    if (row !== undefined && row.request_hash === requestHash) {
      return { profile: await readProfileByVersion(client, row.version_id), created: false };
    }
    if (row !== undefined) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    throw proxyError(409, 'invalid_request_error', 'profile_name_conflict', 'name', 'The profile name is already stored.');
  }
  const stored = await client.query<ProfileRow>(`${PROFILE_SQL} WHERE p.id = $1`, [profileId]);
  return { profile: presentProfile(requiredRow(stored.rows[0], 'qualification profile was not stored')), created: true };
}

export async function refreshEvidenceSnapshot(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  profileVersionId: string,
  now: Date,
): Promise<{ snapshot: EvidenceSnapshotView; created: boolean }> {
  const requestHash = refreshRequestHash(profileVersionId);
  const existing = await client.query<{ id: string; request_hash: string }>(
    `SELECT id::text AS id, request_hash FROM evidence_snapshots WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    if (prior.request_hash !== requestHash) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return { snapshot: await readSnapshot(client, prior.id), created: false };
  }
  const profile = await client.query<ProfileRow>(`${PROFILE_SQL} WHERE v.id = $1`, [profileVersionId]);
  const version = profile.rows[0];
  if (version === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'profileVersionId', 'The qualification profile was not found.');
  }
  const decision = qualifyCohort(profileFromRow(version), await loadItems(client, version.candidate_deployment), now);
  let snapshotId = '';
  await client.query('SAVEPOINT evidence_snapshot_create');
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO evidence_snapshots (
         tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
         idempotency_key, request_hash
       ) VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        tenantId,
        profileVersionId,
        decision.sourceRunIds,
        decision.coverageRate.toFixed(6),
        decision.sampleCount,
        idempotencyKey,
        requestHash,
      ],
    );
    snapshotId = requiredId(inserted.rows[0]?.id, 'evidence snapshot was not created');
    await client.query(
      `INSERT INTO evidence_candidate_assessments (
         tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
         challenger_passes, challenger_trials, original_passes, original_trials
       ) VALUES (
         $1, $2, $3, $4::text[], $5::numeric, $6::numeric, $7::numeric, $8, $9, $10, $11
       )`,
      [
        tenantId,
        snapshotId,
        decision.status,
        decision.reasonCodes,
        decimalOrNull(decision.uncertainty.lower),
        decimalOrNull(decision.uncertainty.upper),
        decimalOrNull(decision.uncertainty.differenceLower),
        decision.challengerPasses,
        decision.challengerTrials,
        decision.originalPasses,
        decision.originalTrials,
      ],
    );
    await client.query('RELEASE SAVEPOINT evidence_snapshot_create');
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT evidence_snapshot_create');
    await client.query('RELEASE SAVEPOINT evidence_snapshot_create');
    const raced = await client.query<{ id: string; request_hash: string }>(
      `SELECT id::text AS id, request_hash FROM evidence_snapshots WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = raced.rows[0];
    if (row !== undefined && row.request_hash === requestHash) {
      return { snapshot: await readSnapshot(client, row.id), created: false };
    }
    throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
  }
  await proposeFromSnapshot(client, tenantId, snapshotId);
  return { snapshot: await readSnapshot(client, snapshotId), created: true };
}

export async function listEvidenceSnapshots(
  client: PoolClient,
  profileVersionId: string | null,
): Promise<EvidenceSnapshotView[]> {
  const result =
    profileVersionId === null
      ? await client.query<SnapshotRow>(`${SNAPSHOT_SQL} ORDER BY s.created_at, s.id`)
      : await client.query<SnapshotRow>(`${SNAPSHOT_SQL} WHERE s.profile_version_id = $1 ORDER BY s.created_at, s.id`, [
          profileVersionId,
        ]);
  return result.rows.map(presentSnapshot);
}

async function readProfileByVersion(client: PoolClient, versionId: string): Promise<QualificationProfileView> {
  const result = await client.query<ProfileRow>(`${PROFILE_SQL} WHERE v.id = $1`, [versionId]);
  return presentProfile(requiredRow(result.rows[0], 'qualification profile was not stored'));
}

async function readSnapshot(client: PoolClient, snapshotId: string): Promise<EvidenceSnapshotView> {
  const result = await client.query<SnapshotRow>(`${SNAPSHOT_SQL} WHERE s.id = $1`, [snapshotId]);
  return presentSnapshot(requiredRow(result.rows[0], 'evidence snapshot was not stored'));
}

async function loadItems(client: PoolClient, deploymentName: string): Promise<QualificationItem[]> {
  const rows = await client.query<{
    run_id: string;
    item_id: string;
    updated_at: Date;
    run_status: string;
    profile_approved: boolean;
    run_task_category: string;
    profile_version_id: string | null;
    sample_task_category: string | null;
    complexity: string | null;
    input_size: number | null;
    required_capabilities: string[] | null;
    challenger_deployment: string;
    challenger_model: string | null;
    config_version: number | null;
    adapter_version: number | null;
    attempt_status: string | null;
    original_present: boolean;
    latency_ms: number | null;
    original_duration_ms: number | null;
    cost_amount: string | null;
    cost_status: string | null;
    original_cost_amount: string | null;
    original_cost_status: string | null;
    judge_outcome: string | null;
    forward_mapped: string | null;
    reverse_mapped: string | null;
  }>(
    `SELECT r.id::text AS run_id,
            i.id::text AS item_id,
            r.updated_at,
            r.status AS run_status,
            (pv.status = 'approved') AS profile_approved,
            r.sample_category AS run_task_category,
            r.profile_version_id::text AS profile_version_id,
            s.task_category AS sample_task_category,
            s.complexity,
            s.input_size,
            s.required_capabilities,
            a.challenger_deployment,
            cma.upstream_model AS challenger_model,
            a.config_version,
            a.adapter_version,
            a.status AS attempt_status,
            (oma.id IS NOT NULL) AS original_present,
            a.latency_ms,
            oma.duration_ms AS original_duration_ms,
            a.cost_amount::text AS cost_amount,
            a.cost_status,
            oc.amount::text AS original_cost_amount,
            oc.cost_status AS original_cost_status,
            j.outcome AS judge_outcome,
            j.forward_mapped,
            j.reverse_mapped
     FROM evaluation_runs r
     JOIN evaluation_items i ON i.tenant_id = r.tenant_id AND i.run_id = r.id
     JOIN evaluation_profile_versions pv ON pv.id = r.profile_version_id
     JOIN request_samples s ON s.tenant_id = i.tenant_id AND s.id = i.sample_id
     JOIN evaluation_attempts a ON a.tenant_id = i.tenant_id AND a.item_id = i.id
     LEFT JOIN model_attempts cma ON cma.tenant_id = a.tenant_id AND cma.id = a.model_attempt_id
     LEFT JOIN LATERAL (
       SELECT ma.id, ma.duration_ms
       FROM model_attempts ma
       WHERE ma.tenant_id = s.tenant_id AND ma.request_id = s.request_id
       ORDER BY (ma.status = 'succeeded') DESC, ma.created_at DESC
       LIMIT 1
     ) oma ON true
     LEFT JOIN attempt_costs oc ON oc.tenant_id = s.tenant_id AND oc.attempt_id = oma.id
     LEFT JOIN evaluation_judge_findings j ON j.tenant_id = i.tenant_id AND j.item_id = i.id
     WHERE r.status IN ('completed', 'completed_partial')
       AND a.challenger_deployment = $1`,
    [deploymentName],
  );
  if (rows.rows.length === 0) return [];
  const itemIds = rows.rows.map((row) => row.item_id);
  const validators = await client.query<{ item_id: string; candidate: string; result: string }>(
    `SELECT item_id::text AS item_id, candidate, result
     FROM evaluation_validator_results
     WHERE item_id = ANY($1::uuid[])`,
    [itemIds],
  );
  const byItem = new Map<string, { challenger: ObjectiveResult[]; original: ObjectiveResult[] }>();
  for (const row of validators.rows) {
    const result = objectiveResult(row.result);
    if (result === null) continue;
    const bucket = byItem.get(row.item_id) ?? { challenger: [], original: [] };
    if (row.candidate === 'challenger') bucket.challenger.push(result);
    else if (row.candidate === 'original') bucket.original.push(result);
    byItem.set(row.item_id, bucket);
  }
  return rows.rows.map((row) => {
    const results = byItem.get(row.item_id) ?? { challenger: [], original: [] };
    return {
      runId: row.run_id,
      runUpdatedAt: row.updated_at,
      runStatus: row.run_status,
      profileApproved: row.profile_approved === true,
      runTaskCategory: row.run_task_category,
      runProfileVersionId: row.profile_version_id,
      sampleTaskCategory: row.sample_task_category,
      complexity: row.complexity,
      inputSize: row.input_size,
      requiredCapabilities: row.required_capabilities,
      challengerDeploymentName: row.challenger_deployment,
      challengerModel: row.challenger_model,
      configVersion: row.config_version,
      adapterVersion: row.adapter_version,
      attemptStatus: row.attempt_status,
      originalPresent: row.original_present === true,
      challengerLatencyMs: row.latency_ms,
      originalDurationMs: row.original_duration_ms,
      challengerCostAmount: row.cost_amount,
      challengerCostStatus: row.cost_status,
      originalCostAmount: row.original_cost_amount,
      originalCostStatus: row.original_cost_status,
      challengerResults: results.challenger,
      originalResults: results.original,
      judgeOutcome: row.judge_outcome,
      forwardMapped: row.forward_mapped,
      reverseMapped: row.reverse_mapped,
    };
  });
}

function profileFromRow(row: ProfileRow): QualificationProfile {
  return {
    taskCategory: row.task_category,
    complexity: row.complexity as QualificationProfile['complexity'],
    inputSizeCategory: row.input_size_category as QualificationProfile['inputSizeCategory'],
    outputRequirementId: row.output_requirement_id,
    requiredCapabilities: textList(row.required_capabilities),
    candidateDeploymentName: row.candidate_deployment,
    modelVersion: row.model_version,
    deploymentConfigVersion: row.deployment_config_version,
    adapterVersion: row.adapter_version,
    minSamples: row.min_samples,
    objectiveFloor: Number(row.objective_floor),
    maxIntervalWidth: Number(row.max_interval_width),
    noninferiorityMargin: Number(row.noninferiority_margin),
    freshnessSeconds: row.freshness_seconds,
    minCoverage: Number(row.min_coverage),
  };
}

function presentProfile(row: ProfileRow): QualificationProfileView {
  return {
    id: row.id,
    versionId: row.version_id,
    version: row.version,
    name: row.name,
    taskCategory: row.task_category,
    complexity: row.complexity,
    inputSizeCategory: row.input_size_category,
    outputRequirementId: row.output_requirement_id,
    requiredCapabilities: textList(row.required_capabilities),
    candidateDeployment: row.candidate_deployment,
    modelVersion: row.model_version,
    deploymentConfigVersion: row.deployment_config_version,
    adapterVersion: row.adapter_version,
    minSamples: row.min_samples,
    objectiveFloor: fixedDecimal(row.objective_floor, 5),
    maxIntervalWidth: fixedDecimal(row.max_interval_width, 5),
    noninferiorityMargin: fixedDecimal(row.noninferiority_margin, 5),
    freshnessSeconds: row.freshness_seconds,
    minCoverage: fixedDecimal(row.min_coverage, 5),
    configDigest: row.config_digest,
    createdAt: row.created_at.toISOString(),
  };
}

function presentSnapshot(row: SnapshotRow): EvidenceSnapshotView {
  return {
    id: row.id,
    profileVersionId: row.profile_version_id,
    taskCategory: row.task_category,
    complexity: row.complexity,
    inputSizeCategory: row.input_size_category,
    outputRequirementId: row.output_requirement_id,
    requiredCapabilities: textList(row.required_capabilities),
    candidateDeployment: row.candidate_deployment,
    modelVersion: row.model_version,
    deploymentConfigVersion: row.deployment_config_version,
    adapterVersion: row.adapter_version,
    status: row.status,
    reasonCodes: textList(row.reason_codes),
    uncertainty: {
      method: 'wilson_95_newcombe',
      lower: row.wilson_lower === null ? null : Number(row.wilson_lower),
      upper: row.wilson_upper === null ? null : Number(row.wilson_upper),
      differenceLower: row.difference_lower === null ? null : Number(row.difference_lower),
    },
    sourceRunIds: textList(row.source_run_ids),
    sampleCount: row.matched_pairs,
    coverageRate: Number(row.coverage_rate),
    createdAt: row.created_at.toISOString(),
  };
}

function objectiveResult(value: string): ObjectiveResult | null {
  if (value === 'pass' || value === 'fail' || value === 'not_applicable' || value === 'unknown') return value;
  return null;
}

function decimalOrNull(value: number | null): string | null {
  return value === null ? null : value.toFixed(6);
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

function requiredId(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function requiredRow<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
