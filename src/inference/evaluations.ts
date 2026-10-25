import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { invalidRequest, proxyError } from './errors.js';
import {
  MAX_EVALUATION_ITEMS,
  MAX_OPEN_EVALUATION_RUNS,
  EVALUATION_CAPABILITIES,
  preflightEvaluation,
  preflightRejection,
  scaleDecimal,
  type PreflightDeploymentFact,
  type PreflightFacts,
  type PreflightPolicyFact,
  type PreflightSampleFact,
} from './evaluation-preflight.js';
import {
  ITEM_REASON_CODES,
  countItems,
  isItemStatus,
  isRunStatus,
  planRunSteps,
  transitionItem,
  transitionRun,
  type ItemReasonCode,
  type ItemStatus,
  type RunStatus,
} from './evaluation-state.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';

export const EVALUATION_PAGE_CAP = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY = /^[A-Za-z0-9:_-]{1,200}$/;

export const SAMPLE_FACT_SQL = `SELECT id::text AS id,
            task_category,
            expires_at > statement_timestamp() AS expires_fresh,
            exchange_complete,
            required_capabilities,
            source_location,
            content_bytes
     FROM request_samples
     WHERE id = ANY($1::uuid[])`;

export type EvaluationPlan = {
  name: string;
  sampleCategory: TaskCategory;
  sampleIds: string[];
  challengerDeployment: string;
  judgeDeployment: string | null;
  requiredCapabilities: string[] | null;
  budgetEstimate: string;
  mode: 'dry_run' | 'replay';
};

export type EvaluationRunView = {
  id: string;
  definitionId: string;
  definitionName: string;
  definitionVersion: number;
  status: RunStatus;
  sampleCategory: string;
  challengerDeployment: string;
  judgeDeployment: string | null;
  mode: 'dry_run' | 'replay';
  modelExecution: 'off' | 'pinned';
  itemCount: number;
  pendingCount: number;
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  budgetEstimate: string;
  createdAt: string;
  updatedAt: string;
  configSnapshot: Record<string, unknown>;
};

export type EvaluationItemView = {
  id: string;
  sampleId: string;
  ordinal: number;
  status: ItemStatus;
  reasonCode: ItemReasonCode | null;
  originalDeployment?: string;
  challengerDeployment?: string;
  configVersion?: number;
  adapterVersion?: number;
  providerResponseId?: string | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  costAmount?: string | null;
  costStatus?: string | null;
};

type RunRow = {
  id: string;
  status: string;
  sample_category: string;
  challenger_deployment: string;
  judge_deployment: string | null;
  budget_estimate: string;
  item_count: number;
  pending_count: number;
  queued_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  cancelled_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  config_snapshot: Record<string, unknown>;
  definition_version: number;
  definition_id: string;
  definition_name: string;
};

const PLAN_KEYS = new Set([
  'name',
  'sampleCategory',
  'sampleIds',
  'challengerDeployment',
  'judgeDeployment',
  'requiredCapabilities',
  'budgetEstimate',
  'mode',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deploymentName(value: unknown, param: string): string {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'auto') {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value;
}

export function canonicalBudget(value: string): string {
  const scaled = scaleDecimal(value);
  if (scaled === null) throw invalidRequest('budget_estimate', 'invalid_parameter', 'budgetEstimate is invalid.');
  const whole = scaled / 1_000_000_000_000n;
  const fraction = (scaled % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

export function parseEvaluationPlan(body: unknown): EvaluationPlan {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The evaluation body is invalid.');
  for (const key of Object.keys(body)) {
    if (!PLAN_KEYS.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The evaluation body is invalid.');
  }
  const name = body.name;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw invalidRequest('name', 'invalid_parameter', 'name is invalid.');
  }
  const sampleCategory = body.sampleCategory;
  if (typeof sampleCategory !== 'string' || !isTaskCategory(sampleCategory)) {
    throw invalidRequest('sample_category', 'invalid_parameter', 'sampleCategory is invalid.');
  }
  if (!Array.isArray(body.sampleIds) || body.sampleIds.length < 1) {
    throw invalidRequest('sample_ids', 'invalid_parameter', 'sampleIds is required.');
  }
  if (body.sampleIds.length > MAX_EVALUATION_ITEMS) throw preflightRejection('item_limit_exceeded');
  const sampleIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of body.sampleIds) {
    if (typeof entry !== 'string' || !UUID.test(entry)) {
      throw invalidRequest('sample_ids', 'invalid_parameter', 'sampleIds is invalid.');
    }
    const id = entry.toLowerCase();
    if (seen.has(id)) throw invalidRequest('sample_ids', 'invalid_parameter', 'sampleIds contains a duplicate.');
    seen.add(id);
    sampleIds.push(id);
  }
  const challengerDeployment = deploymentName(body.challengerDeployment, 'challenger_deployment');
  let judgeDeployment: string | null = null;
  if (body.judgeDeployment !== undefined && body.judgeDeployment !== null) {
    judgeDeployment = deploymentName(body.judgeDeployment, 'judge_deployment');
  }
  let requiredCapabilities: string[] | null = null;
  if (body.requiredCapabilities !== undefined) {
    if (!Array.isArray(body.requiredCapabilities) || body.requiredCapabilities.length > EVALUATION_CAPABILITIES.length) {
      throw invalidRequest('required_capabilities', 'invalid_parameter', 'requiredCapabilities is invalid.');
    }
    requiredCapabilities = [];
    for (const entry of body.requiredCapabilities) {
      if (typeof entry !== 'string' || !(EVALUATION_CAPABILITIES as readonly string[]).includes(entry)) {
        throw invalidRequest('required_capabilities', 'invalid_parameter', 'requiredCapabilities is invalid.');
      }
      if (!requiredCapabilities.includes(entry)) requiredCapabilities.push(entry);
    }
  }
  if (typeof body.budgetEstimate !== 'string') {
    throw invalidRequest('budget_estimate', 'invalid_parameter', 'budgetEstimate is invalid.');
  }
  const budgetEstimate = canonicalBudget(body.budgetEstimate);
  if (body.mode !== 'dry_run' && body.mode !== 'replay') {
    throw invalidRequest('mode', 'invalid_parameter', 'mode must be dry_run or replay.');
  }
  return {
    name,
    sampleCategory,
    sampleIds,
    challengerDeployment,
    judgeDeployment,
    requiredCapabilities,
    budgetEstimate,
    mode: body.mode,
  };
}

export function parseIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !KEY.test(value)) {
    throw invalidRequest('Idempotency-Key', 'invalid_parameter', 'Idempotency-Key is required.');
  }
  return value;
}

export function parseEvaluationId(evaluationId: string): string {
  if (!UUID.test(evaluationId)) throw invalidRequest('evaluation_id', 'invalid_parameter', 'evaluation id is invalid.');
  return evaluationId.toLowerCase();
}

export function parseEvaluationListQuery(query: { limit?: string; cursor?: string }): {
  limit: number;
  cursor: string | null;
} {
  let limit = EVALUATION_PAGE_CAP;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(query.limit)) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > EVALUATION_PAGE_CAP) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
  }
  let cursor: string | null = null;
  if (query.cursor !== undefined) {
    if (!UUID.test(query.cursor)) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
    cursor = query.cursor.toLowerCase();
  }
  return { limit, cursor };
}

export function evaluationRequestHash(plan: EvaluationPlan): string {
  const payload = {
    name: plan.name,
    sampleCategory: plan.sampleCategory,
    sampleIds: [...plan.sampleIds].sort(),
    challengerDeployment: plan.challengerDeployment,
    judgeDeployment: plan.judgeDeployment,
    requiredCapabilities: plan.requiredCapabilities === null ? null : [...plan.requiredCapabilities].sort(),
    budgetEstimate: plan.budgetEstimate,
    mode: plan.mode,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function snapshotFor(plan: EvaluationPlan): Record<string, unknown> {
  return {
    mode: plan.mode,
    modelExecution: plan.mode === 'replay' ? 'pinned' : 'off',
    name: plan.name,
    sampleCategory: plan.sampleCategory,
    sampleIds: [...plan.sampleIds],
    challengerDeployment: plan.challengerDeployment,
    judgeDeployment: plan.judgeDeployment,
    requiredCapabilities: plan.requiredCapabilities,
    budgetEstimate: plan.budgetEstimate,
  };
}

export async function preflightStoredPlan(client: PoolClient, plan: EvaluationPlan): Promise<{ accepted: true; itemCount: number }> {
  const facts = await loadEvaluationFacts(client, plan);
  preflightEvaluation(facts);
  return { accepted: true, itemCount: plan.sampleIds.length };
}

export async function createEvaluation(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  plan: EvaluationPlan,
): Promise<{ run: EvaluationRunView; replayed: boolean }> {
  const requestHash = evaluationRequestHash(plan);
  const existing = await client.query<{ id: string; request_hash: string }>(
    `SELECT id::text AS id, request_hash FROM evaluation_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    if (prior.request_hash !== requestHash) {
      throw proxyError(
        409,
        'invalid_request_error',
        'idempotency_conflict',
        'Idempotency-Key',
        'The idempotency key was used with a different request.',
      );
    }
    const replay = await readEvaluation(client, prior.id);
    if (replay === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    return { run: replay, replayed: true };
  }

  await preflightStoredPlan(client, plan);
  const definitionId = await upsertDefinition(client, tenantId, plan.name);
  const versionId = await insertVersion(client, tenantId, definitionId, plan);
  const snapshot = snapshotFor(plan);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO evaluation_runs (
       tenant_id, definition_version_id, status, idempotency_key, request_hash, config_snapshot,
       sample_category, challenger_deployment, judge_deployment, budget_estimate, item_count
     )
     VALUES ($1, $2, 'created', $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING id::text AS id`,
    [
      tenantId,
      versionId,
      idempotencyKey,
      requestHash,
      JSON.stringify(snapshot),
      plan.sampleCategory,
      plan.challengerDeployment,
      plan.judgeDeployment,
      plan.budgetEstimate,
      plan.sampleIds.length,
    ],
  );
  const runId = inserted.rows[0]?.id;
  if (runId === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  const itemIds: string[] = [];
  for (let ordinal = 0; ordinal < plan.sampleIds.length; ordinal += 1) {
    const sampleId = plan.sampleIds[ordinal];
    const item = await client.query<{ id: string }>(
      `INSERT INTO evaluation_items (tenant_id, run_id, sample_id, ordinal, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id::text AS id`,
      [tenantId, runId, sampleId, ordinal],
    );
    const itemId = item.rows[0]?.id;
    if (itemId === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    itemIds.push(itemId);
  }
  await applyRun(client, runId, 'preflight');
  await applyRun(client, runId, 'queued');
  const jobKind = plan.mode === 'replay' ? 'replay' : 'dry_run';
  const jobKeyPrefix = jobKind === 'replay' ? 'replay' : 'dry-run';
  for (const itemId of itemIds) {
    await applyItem(client, itemId, 'queued', null);
    await client.query(
      `INSERT INTO evaluation_jobs (tenant_id, run_id, item_id, kind, idempotency_key, status, payload)
       VALUES ($1, $2, $3, $4, $5, 'pending', jsonb_build_object('kind', $4::text))`,
      [tenantId, runId, itemId, jobKind, `${jobKeyPrefix}:${itemId}`],
    );
  }
  await syncRunProgress(client, runId);
  const run = await readEvaluation(client, runId);
  if (run === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return { run, replayed: false };
}

export async function listEvaluations(
  client: PoolClient,
  query: { limit: number; cursor: string | null },
): Promise<{ evaluations: EvaluationRunView[]; nextCursor: string | null }> {
  if (query.cursor !== null) {
    const found = await client.query(`SELECT 1 FROM evaluation_runs WHERE id = $1`, [query.cursor]);
    if ((found.rowCount ?? 0) === 0) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
  }
  const result = await client.query<RunRow>(
    `${RUN_SELECT}
     WHERE (
       $1::uuid IS NULL
       OR (r.created_at, r.id) < (SELECT c.created_at, c.id FROM evaluation_runs c WHERE c.id = $1)
     )
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $2`,
    [query.cursor, query.limit + 1],
  );
  const page = result.rows.slice(0, query.limit).map(runFromRow);
  const last = page.at(-1);
  const nextCursor = result.rows.length > query.limit && last !== undefined ? last.id : null;
  return { evaluations: page, nextCursor };
}

export async function readEvaluation(client: PoolClient, evaluationId: string): Promise<EvaluationRunView | null> {
  const result = await client.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [evaluationId]);
  const row = result.rows[0];
  return row === undefined ? null : runFromRow(row);
}

export async function listEvaluationItems(
  client: PoolClient,
  evaluationId: string,
  query: { limit: number; cursor: string | null },
): Promise<{ items: EvaluationItemView[]; nextCursor: string | null } | null> {
  const run = await client.query(`SELECT 1 FROM evaluation_runs WHERE id = $1`, [evaluationId]);
  if ((run.rowCount ?? 0) === 0) return null;
  if (query.cursor !== null) {
    const found = await client.query(`SELECT 1 FROM evaluation_items WHERE id = $1 AND run_id = $2`, [
      query.cursor,
      evaluationId,
    ]);
    if ((found.rowCount ?? 0) === 0) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
  }
  const result = await client.query<{
    id: string;
    sample_id: string;
    ordinal: number;
    status: string;
    reason_code: string | null;
    attempt_id: string | null;
    original_deployment: string | null;
    challenger_deployment: string | null;
    config_version: number | null;
    adapter_version: number | null;
    provider_response_id: string | null;
    latency_ms: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    cost_amount: string | null;
    cost_status: string | null;
  }>(
    `SELECT i.id::text AS id, i.sample_id::text AS sample_id, i.ordinal, i.status, i.reason_code,
            a.id::text AS attempt_id, a.original_deployment, a.challenger_deployment,
            a.config_version, a.adapter_version, a.provider_response_id, a.latency_ms,
            a.prompt_tokens, a.completion_tokens, a.total_tokens,
            a.cost_amount::text AS cost_amount, a.cost_status
     FROM evaluation_items i
     LEFT JOIN evaluation_attempts a
       ON a.tenant_id = i.tenant_id AND a.item_id = i.id
     WHERE i.run_id = $1
       AND (
         $2::uuid IS NULL
         OR i.ordinal > (SELECT cursor_item.ordinal FROM evaluation_items cursor_item WHERE cursor_item.id = $2)
       )
     ORDER BY i.ordinal ASC
     LIMIT $3`,
    [evaluationId, query.cursor, query.limit + 1],
  );
  const page = result.rows.slice(0, query.limit).map(itemFromRow);
  const last = page.at(-1);
  const nextCursor = result.rows.length > query.limit && last !== undefined ? last.id : null;
  return { items: page, nextCursor };
}

export async function cancelEvaluation(client: PoolClient, evaluationId: string): Promise<EvaluationRunView | null> {
  await lockEvaluationRow(client, evaluationId);
  const locked = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_runs WHERE id = $1`,
    [evaluationId],
  );
  const status = locked.rows[0]?.status;
  if (status === undefined) return null;
  if (!isRunStatus(status)) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  if (status === 'cancelled' || status === 'cancel_requested') {
    const current = await readEvaluation(client, evaluationId);
    return current;
  }
  if (status === 'queued') {
    await applyRun(client, evaluationId, 'cancelled');
    await cancelOpenItems(client, evaluationId);
    await client.query(`SELECT cancel_pending_evaluation_jobs(tenant_id, $1) FROM evaluation_runs WHERE id = $1`, [
      evaluationId,
    ]);
    await syncRunProgress(client, evaluationId);
    return readEvaluation(client, evaluationId);
  }
  if (status === 'running') {
    await applyRun(client, evaluationId, 'cancel_requested');
    await cancelOpenItems(client, evaluationId);
    await client.query(`SELECT cancel_pending_evaluation_jobs(tenant_id, $1) FROM evaluation_runs WHERE id = $1`, [
      evaluationId,
    ]);
    await syncRunProgress(client, evaluationId);
    return readEvaluation(client, evaluationId);
  }
  throw proxyError(409, 'invalid_request_error', 'illegal_transition', 'status', 'The status transition is not allowed.');
}

export async function applyStoredRunTransition(
  client: PoolClient,
  evaluationId: string,
  next: RunStatus,
): Promise<EvaluationRunView> {
  await lockEvaluationRow(client, evaluationId);
  const locked = await client.query(`SELECT 1 FROM evaluation_runs WHERE id = $1`, [evaluationId]);
  if ((locked.rowCount ?? 0) === 0) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'evaluation_id', 'The evaluation was not found.');
  }
  await applyRun(client, evaluationId, next);
  const run = await readEvaluation(client, evaluationId);
  if (run === null) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'evaluation_id', 'The evaluation was not found.');
  }
  return run;
}

export async function applyStoredItemTransition(
  client: PoolClient,
  itemId: string,
  next: ItemStatus,
  reason: ItemReasonCode | null,
): Promise<'applied' | 'same' | 'missing'> {
  await lockEvaluationRow(client, itemId);
  const locked = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_items WHERE id = $1`,
    [itemId],
  );
  const status = locked.rows[0]?.status;
  if (status === undefined) return 'missing';
  if (!isItemStatus(status)) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  const step = transitionItem(status, next);
  if (!step.applied) return 'same';
  const updated = await client.query(
    `UPDATE evaluation_items
     SET status = $2, reason_code = $3, updated_at = now()
     WHERE id = $1 AND status = $4`,
    [itemId, next, reason, status],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw proxyError(409, 'invalid_request_error', 'illegal_transition', 'status', 'The status transition is not allowed.');
  }
  return 'applied';
}

export async function syncRunProgress(client: PoolClient, runId: string): Promise<void> {
  await lockEvaluationRow(client, runId);
  const locked = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_runs WHERE id = $1`,
    [runId],
  );
  const items = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_items WHERE run_id = $1 ORDER BY ordinal`,
    [runId],
  );
  const statuses: ItemStatus[] = [];
  for (const row of items.rows) {
    if (!isItemStatus(row.status)) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    statuses.push(row.status);
  }
  const status = locked.rows[0]?.status;
  if (status === undefined || !isRunStatus(status)) {
    throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  }
  for (const step of planRunSteps(status, statuses)) {
    await applyRun(client, runId, step);
  }
  const counts = countItems(statuses);
  await client.query(
    `UPDATE evaluation_runs
     SET pending_count = $2,
         queued_count = $3,
         running_count = $4,
         completed_count = $5,
         failed_count = $6,
         cancelled_count = $7,
         updated_at = now()
     WHERE id = $1`,
    [runId, counts.pending, counts.queued, counts.running, counts.completed, counts.failed, counts.cancelled],
  );
}

export async function loadEvaluationFacts(client: PoolClient, plan: EvaluationPlan): Promise<PreflightFacts> {
  const sampleResult = await client.query<{
    id: string;
    task_category: string | null;
    expires_fresh: boolean;
    exchange_complete: boolean | null;
    required_capabilities: string[] | null;
    source_location: string | null;
    content_bytes: number;
  }>(SAMPLE_FACT_SQL, [plan.sampleIds]);
  const found = new Map(sampleResult.rows.map((row) => [row.id, row]));
  const samples: PreflightSampleFact[] = plan.sampleIds.map((id) => {
    const row = found.get(id);
    if (row === undefined) {
      return {
        id,
        found: false,
        category: null,
        expiresFresh: false,
        exchangeComplete: null,
        requiredCapabilities: null,
        sourceLocation: null,
        contentBytes: 0,
      };
    }
    return {
      id,
      found: true,
      category: row.task_category,
      expiresFresh: row.expires_fresh === true,
      exchangeComplete: row.exchange_complete,
      requiredCapabilities: row.required_capabilities,
      sourceLocation: row.source_location,
      contentBytes: Number(row.content_bytes),
    };
  });
  const policyResult = await client.query<{
    replay_permitted: boolean;
    judge_disclosure_permitted: boolean;
    allowed_providers: string[];
    allowed_deployments: string[];
  }>(
    `SELECT replay_permitted, judge_disclosure_permitted, allowed_providers, allowed_deployments
     FROM sample_policies
     ORDER BY policy_version DESC
     LIMIT 1`,
  );
  const policyRow = policyResult.rows[0];
  const policy: PreflightPolicyFact | null =
    policyRow === undefined
      ? null
      : {
          replay: policyRow.replay_permitted,
          judgeDisclosure: policyRow.judge_disclosure_permitted,
          allowedProviders: policyRow.allowed_providers,
          allowedDeployments: policyRow.allowed_deployments,
        };
  const regionResult = await client.query<{ allowed_regions: string[] }>(
    `SELECT allowed_regions FROM fallback_policies ORDER BY policy_version DESC LIMIT 1`,
  );
  const budgetResult = await client.query<{ mode: 'observe' | 'hard' | 'disabled'; monthly_amount: string }>(
    `SELECT mode, monthly_amount::text AS monthly_amount FROM tenant_budgets`,
  );
  const budget = budgetResult.rows[0];
  const limitResult = await client.query<{ mode: 'observe' | 'hard'; concurrent_requests: number | null }>(
    `SELECT mode, concurrent_requests FROM tenant_limit_policies`,
  );
  const limits = limitResult.rows[0];
  const tenantCap =
    limits?.mode === 'hard' && limits.concurrent_requests !== null ? limits.concurrent_requests : null;
  const openResult = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM evaluation_runs
     WHERE status IN ('created', 'preflight', 'queued', 'running', 'cancel_requested')`,
  );
  return {
    sampleCategory: plan.sampleCategory,
    sampleIds: plan.sampleIds,
    samples,
    challenger: await loadDeployment(client, plan.challengerDeployment),
    judge: plan.judgeDeployment === null ? null : await loadDeployment(client, plan.judgeDeployment),
    judgeRequested: plan.judgeDeployment !== null,
    policy,
    allowedRegions: regionResult.rows[0]?.allowed_regions ?? [],
    requiredCapabilities: plan.requiredCapabilities,
    budgetEstimate: plan.budgetEstimate,
    budgetMode: budget?.mode ?? null,
    budgetLimit: budget?.monthly_amount ?? null,
    openRuns: openResult.rows[0]?.count ?? 0,
    maxOpenRuns: Math.min(MAX_OPEN_EVALUATION_RUNS, tenantCap ?? MAX_OPEN_EVALUATION_RUNS),
    maxItems: MAX_EVALUATION_ITEMS,
    tenantItemCap: tenantCap,
  };
}

async function loadDeployment(client: PoolClient, name: string): Promise<PreflightDeploymentFact | null> {
  const result = await client.query<{
    name: string;
    enabled: boolean;
    connection_enabled: boolean;
    provider: string;
    location: string | null;
    capabilities: string[];
  }>(
    `SELECT d.name, d.enabled, d.capabilities, c.enabled AS connection_enabled, c.provider, c.location
     FROM model_deployments d
     JOIN provider_connections c
       ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE d.name = $1`,
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    name: row.name,
    enabled: row.enabled,
    connectionEnabled: row.connection_enabled,
    provider: row.provider,
    location: row.location,
    capabilities: row.capabilities ?? [],
  };
}

async function upsertDefinition(client: PoolClient, tenantId: string, name: string): Promise<string> {
  // A unique violation aborts the transaction unless it rolls back to a savepoint.
  await client.query('SAVEPOINT evaluation_definition');
  let created: string | undefined;
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO evaluation_definitions (tenant_id, name)
       VALUES ($1, $2)
       RETURNING id::text AS id`,
      [tenantId, name],
    );
    created = inserted.rows[0]?.id;
    await client.query('RELEASE SAVEPOINT evaluation_definition');
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT evaluation_definition');
      await client.query('RELEASE SAVEPOINT evaluation_definition');
    } catch (rollbackError) {
      throw rollbackError;
    }
    if (!isUniqueViolation(error)) throw error;
  }
  if (created !== undefined) return created;
  await lockEvaluationRow(client, name);
  const existing = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM evaluation_definitions WHERE name = $1`,
    [name],
  );
  const id = existing.rows[0]?.id;
  if (id === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return id;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function lockEvaluationRow(client: PoolClient, id: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [id]);
}

async function insertVersion(
  client: PoolClient,
  tenantId: string,
  definitionId: string,
  plan: EvaluationPlan,
): Promise<string> {
  await lockEvaluationRow(client, definitionId);
  await client.query(`SELECT id FROM evaluation_definitions WHERE id = $1`, [definitionId]);
  const next = await client.query<{ version: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS version
     FROM evaluation_definition_versions
     WHERE definition_id = $1`,
    [definitionId],
  );
  const version = next.rows[0]?.version;
  if (version === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO evaluation_definition_versions (tenant_id, definition_id, version, config)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id::text AS id`,
    [tenantId, definitionId, version, JSON.stringify(snapshotFor(plan))],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return id;
}

async function applyRun(client: PoolClient, runId: string, next: RunStatus): Promise<void> {
  await lockEvaluationRow(client, runId);
  const locked = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_runs WHERE id = $1`,
    [runId],
  );
  const status = locked.rows[0]?.status;
  if (status === undefined || !isRunStatus(status)) {
    throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  }
  const step = transitionRun(status, next);
  if (!step.applied) return;
  const updated = await client.query(
    `UPDATE evaluation_runs SET status = $2, updated_at = now() WHERE id = $1 AND status = $3`,
    [runId, next, status],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw proxyError(409, 'invalid_request_error', 'illegal_transition', 'status', 'The status transition is not allowed.');
  }
}

async function applyItem(
  client: PoolClient,
  itemId: string,
  next: ItemStatus,
  reason: ItemReasonCode | null,
): Promise<void> {
  const result = await applyStoredItemTransition(client, itemId, next, reason);
  if (result === 'missing') throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
}

async function cancelOpenItems(client: PoolClient, runId: string): Promise<void> {
  const items = await client.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status FROM evaluation_items WHERE run_id = $1 AND status IN ('pending', 'queued')`,
    [runId],
  );
  for (const item of items.rows) {
    if (!isItemStatus(item.status)) continue;
    await applyItem(client, item.id, 'cancelled', 'cancelled');
  }
}

const RUN_SELECT = `SELECT r.id::text AS id, r.status, r.sample_category, r.challenger_deployment, r.judge_deployment,
            r.budget_estimate::text AS budget_estimate, r.item_count, r.pending_count, r.queued_count,
            r.running_count, r.completed_count, r.failed_count, r.cancelled_count, r.created_at, r.updated_at,
            r.config_snapshot, v.version AS definition_version, d.id::text AS definition_id, d.name AS definition_name
     FROM evaluation_runs r
     JOIN evaluation_definition_versions v
       ON v.tenant_id = r.tenant_id AND v.id = r.definition_version_id
     JOIN evaluation_definitions d
       ON d.tenant_id = r.tenant_id AND d.id = v.definition_id`;

function runFromRow(row: RunRow): EvaluationRunView {
  if (!isRunStatus(row.status)) {
    throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  }
  return {
    id: row.id,
    definitionId: row.definition_id,
    definitionName: row.definition_name,
    definitionVersion: row.definition_version,
    status: row.status,
    sampleCategory: row.sample_category,
    challengerDeployment: row.challenger_deployment,
    judgeDeployment: row.judge_deployment,
    mode: snapshotMode(row.config_snapshot).mode,
    modelExecution: snapshotMode(row.config_snapshot).modelExecution,
    itemCount: row.item_count,
    pendingCount: row.pending_count,
    queuedCount: row.queued_count,
    runningCount: row.running_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    cancelledCount: row.cancelled_count,
    budgetEstimate: canonicalBudget(row.budget_estimate),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    configSnapshot: row.config_snapshot,
  };
}

function itemFromRow(row: {
  id: string;
  sample_id: string;
  ordinal: number;
  status: string;
  reason_code: string | null;
  attempt_id: string | null;
  original_deployment: string | null;
  challenger_deployment: string | null;
  config_version: number | null;
  adapter_version: number | null;
  provider_response_id: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_amount: string | null;
  cost_status: string | null;
}): EvaluationItemView {
  if (!isItemStatus(row.status)) {
    throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  }
  const view: EvaluationItemView = {
    id: row.id,
    sampleId: row.sample_id,
    ordinal: row.ordinal,
    status: row.status,
    reasonCode: isReason(row.reason_code) ? row.reason_code : null,
  };
  if (row.attempt_id === null) return view;
  view.originalDeployment = row.original_deployment ?? undefined;
  view.challengerDeployment = row.challenger_deployment ?? undefined;
  view.configVersion = row.config_version ?? undefined;
  view.adapterVersion = row.adapter_version ?? undefined;
  view.providerResponseId = row.provider_response_id;
  view.latencyMs = row.latency_ms;
  view.promptTokens = row.prompt_tokens;
  view.completionTokens = row.completion_tokens;
  view.totalTokens = row.total_tokens;
  view.costAmount = row.cost_amount === null ? null : canonicalBudget(row.cost_amount);
  view.costStatus = row.cost_status;
  return view;
}

function snapshotMode(snapshot: Record<string, unknown>): {
  mode: 'dry_run' | 'replay';
  modelExecution: 'off' | 'pinned';
} {
  if (snapshot.mode === 'replay' && snapshot.modelExecution === 'pinned') {
    return { mode: 'replay', modelExecution: 'pinned' };
  }
  if (snapshot.mode === 'dry_run' && snapshot.modelExecution === 'off') {
    return { mode: 'dry_run', modelExecution: 'off' };
  }
  throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
}

function isReason(value: string | null): value is ItemReasonCode {
  if (value === null) return false;
  return (ITEM_REASON_CODES as readonly string[]).includes(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
