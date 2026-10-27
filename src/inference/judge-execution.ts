import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { breakerAllows } from '../db/breaker.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { openAiAdapter, type TokenUsage, type UpstreamCompletion } from './adapter.js';
import { admitChatAttempt, settleChatAttempt } from './admission.js';
import { anthropicAdapter } from './anthropic.js';
import { providerChatBaseUrl } from './compatible.js';
import type { ProviderAdapter, ProviderCall } from './contract.js';
import { recordAttemptCost } from './cost-store.js';
import type { CalculatedCost } from './cost.js';
import { canonicalBudget, loadEvaluationFacts, lockEvaluationRow, readEvaluation, type EvaluationPlan } from './evaluations.js';
import { preflightEvaluation } from './evaluation-preflight.js';
import { ProxyError } from './errors.js';
import type { EvaluationWorkerOptions } from './evaluation-worker.js';
import {
  JUDGE_SCHEMA_VERSION,
  addMoney,
  buildBlindJudgeRequest,
  combineOrders,
  mapBlindWinner,
  outputTextFromPayload,
  parseJudgeResponse,
  parseRubricConfig,
  taskTextFromPayload,
  type ComparisonOrder,
  type JudgeCriterion,
  type JudgeFinding,
  type JudgeRejection,
  type MappedCandidate,
} from './judge.js';
import { admissionItemReason, providerItemReason } from './replay-request.js';
import { routeForDeployment, type ResolvedRoute } from './resolve.js';
import { decryptSample, encryptSample, type EncryptedEnvelope, type SampleKeyManager } from './sample-crypto.js';
import { finishAttempt, insertEvaluationPending, loadCatalog } from './store.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';
import { vertexAdapter } from './vertex.js';

const EMPTY_USAGE: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

export type JudgeAdvance = {
  outcome: 'completed' | 'duplicate' | 'cancelled' | 'failed';
  finish: 'succeeded' | 'cancelled' | null;
};

type StopReason =
  | 'disclosure_revoked'
  | 'deployment_unauthorized'
  | 'budget_exceeded'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'cancelled'
  | 'parse_rejected'
  | 'provider_denied'
  | 'sample_expired'
  | 'provider_error'
  | 'output_unreadable';

type ReadyHead = {
  sampleId: string;
  rubricVersionId: string;
  rubricVersion: number;
  criteria: JudgeCriterion[];
  judgeDeployment: string;
  judgeModel: string;
  category: TaskCategory;
};

type OrderResult = {
  mapped: MappedCandidate | null;
  rejection: JudgeRejection | 'provider_timeout' | 'provider_error' | null;
  stop: StopReason | null;
  latencyMs: number;
  usage: TokenUsage;
  costAmount: string | null;
  costStatus: string | null;
};

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function judgeTenants(options: EvaluationWorkerOptions): readonly string[] {
  return options.judgeTenantIds ?? [];
}

export async function advanceJudge(
  pool: Pool,
  claimed: { jobId: string; tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
): Promise<JudgeAdvance> {
  const head = await withTenant(pool, claimed.tenantId, (client) => inspectJudge(client, claimed, options));
  if (head.kind === 'done') return head.advance;

  let forward: MappedCandidate | null = null;
  let reverse: MappedCandidate | null = null;
  let stop: StopReason | null = null;
  let latencyMs = 0;
  let promptTokens: number | null = 0;
  let completionTokens: number | null = 0;
  let totalTokens: number | null = 0;
  let costAmount: string | null = null;
  let costStatus: string | null = null;
  let rejected = false;

  for (const order of ['forward', 'reverse'] as const) {
    if (stop !== null) break;
    const result = await runOrder(pool, claimed, options, head.ready, order);
    if (order === 'forward') forward = result.mapped;
    else reverse = result.mapped;
    latencyMs += result.latencyMs;
    promptTokens = addCount(promptTokens, result.usage.promptTokens);
    completionTokens = addCount(completionTokens, result.usage.completionTokens);
    totalTokens = addCount(totalTokens, result.usage.totalTokens);
    if (result.costAmount !== null) costAmount = addMoney(costAmount, result.costAmount);
    if (result.costStatus === 'unknown' || costStatus === 'unknown') costStatus = 'unknown';
    else if (result.costStatus !== null) costStatus = result.costStatus;
    if (result.rejection !== null) rejected = true;
    if (result.stop !== null) stop = result.stop;
  }
  if (rejected && stop === null) stop = 'parse_rejected';
  const outcome = combineOrders(forward, reverse);
  await withTenant(pool, claimed.tenantId, (client) =>
    storeFinding(client, claimed, head.ready, {
      outcome: stop === null ? outcome : outcome === 'model_a' || outcome === 'model_b' || outcome === 'tie' ? 'inconclusive' : outcome,
      forward,
      reverse,
      stop,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      costAmount,
      costStatus,
    }),
  );
  logJudge(options.logger, claimed.itemId, stop === null ? outcome : 'inconclusive', stop);
  if (stop === 'cancelled') return { outcome: 'cancelled', finish: 'cancelled' };
  return { outcome: 'completed', finish: 'succeeded' };
}

async function inspectJudge(
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
): Promise<{ kind: 'done'; advance: JudgeAdvance } | { kind: 'ready'; ready: ReadyHead }> {
  await lockEvaluationRow(client, claimed.runId);
  await lockEvaluationRow(client, claimed.itemId);
  const existing = await client.query(`SELECT 1 FROM evaluation_judge_findings WHERE item_id = $1`, [claimed.itemId]);
  if ((existing.rowCount ?? 0) > 0) return { kind: 'done', advance: { outcome: 'duplicate', finish: 'succeeded' } };
  const run = await readEvaluation(client, claimed.runId);
  const item = await client.query<{ status: string; sample_id: string }>(
    `SELECT status, sample_id::text AS sample_id FROM evaluation_items WHERE id = $1`,
    [claimed.itemId],
  );
  const sampleId = item.rows[0]?.sample_id;
  if (run === null || sampleId === undefined || run.rubricVersionId === null || run.judgeDeployment === null) {
    return { kind: 'done', advance: { outcome: 'duplicate', finish: 'succeeded' } };
  }
  if (run.status === 'cancelled' || run.status === 'cancel_requested' || item.rows[0]?.status === 'cancelled') {
    return { kind: 'done', advance: { outcome: 'cancelled', finish: 'cancelled' } };
  }
  const version = await client.query<{ version: number; status: string; task_category: string; config: unknown }>(
    `SELECT version, status, task_category, config FROM evaluation_rubric_versions WHERE id = $1`,
    [run.rubricVersionId],
  );
  const rubric = version.rows[0];
  const judgeModel = judgeModelOf(run.configSnapshot);
  if (
    rubric === undefined ||
    rubric.status !== 'approved' ||
    !isTaskCategory(rubric.task_category) ||
    judgeModel === null ||
    !judgeTenants(options).includes(claimed.tenantId) ||
    !options.executionEnabled
  ) {
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  let criteria: JudgeCriterion[];
  try {
    criteria = parseRubricConfig(rubric.config, rubric.task_category).criteria;
  } catch {
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  return {
    kind: 'ready',
    ready: {
      sampleId,
      rubricVersionId: run.rubricVersionId,
      rubricVersion: rubric.version,
      criteria,
      judgeDeployment: run.judgeDeployment,
      judgeModel,
      category: rubric.task_category,
    },
  };
}

async function runOrder(
  pool: Pool,
  claimed: { tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
  ready: ReadyHead,
  order: ComparisonOrder,
): Promise<OrderResult> {
  const none = emptyResult();
  const prepared = await withTenant(pool, claimed.tenantId, (client) => prepareOrder(pool, client, claimed, options, ready, order));
  if (prepared.kind === 'stored') return prepared.result;
  if (prepared.kind === 'stopped') return { ...none, stop: prepared.stop };
  const call = prepared.call;

  try {
    await admitChatAttempt(pool, {
      tenantId: claimed.tenantId,
      apiKeyId: call.apiKeyId,
      route: call.route,
      request: call.request,
      attemptId: call.modelAttemptId,
      stream: false,
      now: new Date(),
    });
  } catch (error) {
    const reason = error instanceof ProxyError ? admissionItemReason(error.code) : 'admission_unavailable';
    await finishQuiet(pool, claimed, call, 'failed', reason, 0, EMPTY_USAGE, null);
    return { ...none, stop: reason === 'budget_exceeded' ? 'budget_exceeded' : 'provider_denied' };
  }

  const gated = await withTenant(pool, claimed.tenantId, (client) => judgeStop(pool, client, claimed, options, ready));
  if (gated !== null) {
    await finishQuiet(pool, claimed, call, 'failed', 'not_dispatched', 0, EMPTY_USAGE, null);
    await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, call.modelAttemptId, new Date());
    return { ...none, stop: gated };
  }

  const started = process.hrtime.bigint();
  if (options.callCounter) options.callCounter.count += 1;
  try {
    const adapter = adapterFor(call.route.provider);
    if (adapter === null) throw new Error('adapter is unavailable');
    const baseURL = providerChatBaseUrl(call.route.provider, call.route.endpoint, options.upstreamBaseUrl ?? '');
    const completion = await adapter.execute(providerCall(call, claimed.tenantId, baseURL, options));
    const latencyMs = elapsedMs(started);
    const stored = await withTenant(pool, claimed.tenantId, (client) =>
      storeCall(client, claimed, options, ready, order, call, completion, latencyMs),
    );
    await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, call.modelAttemptId, new Date());
    return stored;
  } catch (error) {
    const latencyMs = elapsedMs(started);
    const reason = providerItemReason(error);
    const stop: StopReason = reason === 'provider_timeout' ? 'provider_timeout' : 'provider_error';
    await withTenant(pool, claimed.tenantId, (client) =>
      storeRejectedCall(client, claimed, options, ready, order, call, stop === 'provider_timeout' ? 'provider_timeout' : 'provider_error', latencyMs, EMPTY_USAGE, null),
    );
    await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, call.modelAttemptId, new Date());
    return { ...none, stop, latencyMs, rejection: stop === 'provider_timeout' ? 'provider_timeout' : 'provider_error' };
  }
}

type PreparedCall = {
  request: import('./validate.js').ChatRequest;
  route: ResolvedRoute;
  apiKey: string;
  apiKeyId: string;
  requestId: string;
  modelAttemptId: string;
};

async function prepareOrder(
  pool: Pool,
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
  ready: ReadyHead,
  order: ComparisonOrder,
): Promise<{ kind: 'go'; call: PreparedCall } | { kind: 'stored'; result: OrderResult } | { kind: 'stopped'; stop: StopReason }> {
  await lockEvaluationRow(client, claimed.runId);
  await lockEvaluationRow(client, claimed.itemId);
  const prior = await client.query<{ status: string; mapped_candidate: string | null; rejection_code: string | null; latency_ms: number; prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null; cost_amount: string | null; cost_status: string | null }>(
    `SELECT status, mapped_candidate, rejection_code, latency_ms, prompt_tokens, completion_tokens, total_tokens,
            cost_amount::text AS cost_amount, cost_status
     FROM evaluation_judge_calls WHERE item_id = $1 AND comparison_order = $2`,
    [claimed.itemId, order],
  );
  const existing = prior.rows[0];
  if (existing !== undefined) {
    return {
      kind: 'stored',
      result: {
        mapped: isMapped(existing.mapped_candidate) ? existing.mapped_candidate : null,
        rejection: existing.status === 'rejected' ? 'malformed_json' : null,
        stop: existing.status === 'rejected' ? rejectionStop(existing.rejection_code) : null,
        latencyMs: existing.latency_ms,
        usage: {
          promptTokens: existing.prompt_tokens,
          completionTokens: existing.completion_tokens,
          totalTokens: existing.total_tokens,
        },
        costAmount: existing.cost_amount,
        costStatus: existing.cost_status,
      },
    };
  }
  const stop = await judgeStop(pool, client, claimed, options, ready);
  if (stop !== null) return { kind: 'stopped', stop };
  const manager = options.sampleKeyManager;
  if (manager === null || manager === undefined || options.credentialStore === null || options.credentialStore === undefined) {
    return { kind: 'stopped', stop: 'provider_denied' };
  }
  const opened = await openCandidates(client, manager, claimed.tenantId, ready.sampleId, claimed.itemId);
  if (opened === null) return { kind: 'stopped', stop: 'output_unreadable' };
  const route = await pinJudge(client, ready.judgeDeployment, ready.judgeModel);
  if (route === null) return { kind: 'stopped', stop: 'deployment_unauthorized' };
  const maxTokens = route.capabilities.includes('max_tokens') ? 64 : null;
  const candidateX = order === 'forward' ? opened.original : opened.challenger;
  const candidateY = order === 'forward' ? opened.challenger : opened.original;
  const request = buildBlindJudgeRequest({
    task: opened.task,
    criteria: ready.criteria,
    candidateX,
    candidateY,
    reference: opened.reference,
    deploymentName: route.deploymentName,
    maxTokens,
  });
  if ('tools' in request.optional || request.stream) return { kind: 'stopped', stop: 'provider_denied' };
  const apiKeyId = await activeApiKey(client);
  if (apiKeyId === null) return { kind: 'stopped', stop: 'provider_denied' };
  let pending: { requestId: string; attemptId: string; protectedCredential: string | null };
  try {
    pending = await insertEvaluationPending(client, claimed.tenantId, route);
  } catch {
    return { kind: 'stopped', stop: 'provider_denied' };
  }
  let apiKey = '';
  try {
    apiKey = pending.protectedCredential === null ? '' : options.credentialStore.open(pending.protectedCredential);
  } catch {
    await finishAttempt(client, failedInput(claimed.tenantId, pending.requestId, pending.attemptId, 'provider_denied', 0, EMPTY_USAGE));
    return { kind: 'stopped', stop: 'provider_denied' };
  }
  return {
    kind: 'go',
    call: {
      request,
      route,
      apiKey,
      apiKeyId,
      requestId: pending.requestId,
      modelAttemptId: pending.attemptId,
    },
  };
}

async function judgeStop(
  pool: Pool,
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
  ready: ReadyHead,
): Promise<StopReason | null> {
  if (!options.executionEnabled || !judgeTenants(options).includes(claimed.tenantId)) return 'provider_denied';
  const run = await readEvaluation(client, claimed.runId);
  const item = await client.query<{ status: string; sample_id: string }>(
    `SELECT status, sample_id::text AS sample_id FROM evaluation_items WHERE id = $1`,
    [claimed.itemId],
  );
  if (run === null || item.rows[0] === undefined) return 'provider_denied';
  if (run.status === 'cancelled' || run.status === 'cancel_requested' || item.rows[0].status === 'cancelled') return 'cancelled';
  if (run.judgeDeployment !== ready.judgeDeployment || run.rubricVersionId !== ready.rubricVersionId) return 'deployment_unauthorized';
  if (judgeModelOf(run.configSnapshot) !== ready.judgeModel) return 'deployment_unauthorized';
  const category = isTaskCategory(run.sampleCategory) ? run.sampleCategory : null;
  if (category === null) return 'provider_denied';
  const required = run.configSnapshot.requiredCapabilities;
  const plan: EvaluationPlan = {
    name: 'judge-item',
    sampleCategory: category,
    sampleIds: [ready.sampleId],
    challengerDeployment: run.challengerDeployment,
    judgeDeployment: run.judgeDeployment,
    requiredCapabilities: Array.isArray(required) && required.every((entry) => typeof entry === 'string') ? required : null,
    budgetEstimate: canonicalBudget(run.budgetEstimate),
    mode: 'replay',
    profileVersionId: null,
    rubricVersionId: run.rubricVersionId,
  };
  const facts = await loadEvaluationFacts(client, plan);
  try {
    preflightEvaluation({
      ...facts,
      openRuns: 0,
      maxOpenRuns: Math.max(facts.maxOpenRuns, 1),
      maxItems: Math.max(facts.maxItems, facts.sampleIds.length),
      tenantItemCap: null,
    });
  } catch (error) {
    if (error instanceof ProxyError) return stopForCode(error.code);
    throw error;
  }
  const health = await client.query<{ id: string; health_status: string; upstream_model: string; enabled: boolean }>(
    `SELECT id::text AS id, health_status, upstream_model, enabled FROM model_deployments WHERE name = $1`,
    [ready.judgeDeployment],
  );
  const row = health.rows[0];
  if (row === undefined || !row.enabled || row.upstream_model !== ready.judgeModel || row.upstream_model === 'auto') {
    return 'deployment_unauthorized';
  }
  if (row.health_status === 'unhealthy') return 'provider_unavailable';
  if (!(await breakerAllows(pool, claimed.tenantId, row.id, new Date()))) return 'provider_unavailable';
  return null;
}

async function openCandidates(
  client: PoolClient,
  manager: SampleKeyManager,
  tenantId: string,
  sampleId: string,
  itemId: string,
): Promise<{ task: string; original: string; challenger: string; reference: Record<string, unknown> | null } | null> {
  const sample = await client.query<{
    schema_version: number;
    wrapping_key_version: number;
    wrapped_key_iv: Buffer;
    wrapped_key_tag: Buffer;
    wrapped_key_ciphertext: Buffer;
    content_iv: Buffer;
    content_tag: Buffer;
    content_ciphertext: Buffer;
  }>(
    `SELECT schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
            content_iv, content_tag, content_ciphertext
     FROM load_replay_sample_envelope($1)`,
    [sampleId],
  );
  const sampleRow = sample.rows[0];
  if (sampleRow === undefined) return null;
  const samplePayload = decryptSample(manager, { tenantId, sampleId, schemaVersion: sampleRow.schema_version }, envelopeOf(sampleRow));
  const attempt = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM evaluation_attempts WHERE item_id = $1`,
    [itemId],
  );
  const attemptId = attempt.rows[0]?.id;
  if (attemptId === undefined) return null;
  const sealed = await client.query<{
    schema_version: number;
    wrapping_key_version: number;
    wrapped_key_iv: Buffer;
    wrapped_key_tag: Buffer;
    wrapped_key_ciphertext: Buffer;
    content_iv: Buffer;
    content_tag: Buffer;
    content_ciphertext: Buffer;
  }>(
    `SELECT schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
            content_iv, content_tag, content_ciphertext
     FROM load_evaluation_attempt_envelope($1)`,
    [attemptId],
  );
  const sealedRow = sealed.rows[0];
  if (sealedRow === undefined || sealedRow.schema_version === null) return null;
  const challengerPayload = decryptSample(
    manager,
    { tenantId, sampleId: attemptId, schemaVersion: sealedRow.schema_version },
    envelopeOf(sealedRow),
  );
  const task = taskTextFromPayload(samplePayload);
  const original = outputTextFromPayload(samplePayload);
  const challenger = outputTextFromPayload(challengerPayload);
  if (task === null || original === null || challenger === null) return null;
  const profile = await client.query<{ profile_version_id: string | null }>(
    `SELECT profile_version_id::text AS profile_version_id FROM evaluation_runs WHERE id = (
       SELECT run_id FROM evaluation_items WHERE id = $1
     )`,
    [itemId],
  );
  const profileVersionId = profile.rows[0]?.profile_version_id ?? null;
  let reference: Record<string, unknown> | null = null;
  if (profileVersionId !== null) {
    const stored = await client.query<{ reference: unknown }>(
      `SELECT reference FROM evaluation_references WHERE profile_version_id = $1 AND sample_id = $2`,
      [profileVersionId, sampleId],
    );
    const value = stored.rows[0]?.reference;
    if (isRecord(value)) reference = value;
  }
  return { task, original, challenger, reference };
}

async function storeCall(
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
  ready: ReadyHead,
  order: ComparisonOrder,
  prepared: PreparedCall,
  completion: UpstreamCompletion,
  latencyMs: number,
): Promise<OrderResult> {
  const text = completion.response.choices[0]?.message.content ?? '';
  const parsed = parseJudgeResponse(text, ready.criteria);
  const usage = completion.usage;
  await finishAttempt(client, {
    ...failedInput(claimed.tenantId, prepared.requestId, prepared.modelAttemptId, null, latencyMs, usage),
    status: 'succeeded',
    errorCode: null,
    providerRequestId: completion.providerRequestId,
    stopReason: completion.stopReason,
    dispatched: true,
    expenseCertainty: 'known',
    servingModel: completion.servingModel ?? null,
    servingProvider: null,
  });
  const cost = await costOnce(client, claimed.tenantId, prepared.modelAttemptId);
  const callId = randomUUID();
  const envelope = encryptSample(options.sampleKeyManager ?? null, {
    tenantId: claimed.tenantId,
    sampleId: callId,
    schemaVersion: JUDGE_SCHEMA_VERSION,
    payload: { schemaVersion: JUDGE_SCHEMA_VERSION, responseText: text },
  });
  if (!parsed.ok) {
    await insertCall(client, claimed, ready, order, prepared, {
      id: callId,
      status: 'rejected',
      winner: null,
      mapped: null,
      confidence: null,
      rejection: parsed.rejection,
      latencyMs,
      usage,
      cost,
      envelope,
    });
    return {
      mapped: null,
      rejection: parsed.rejection,
      stop: null,
      latencyMs,
      usage,
      costAmount: cost.amount,
      costStatus: cost.costStatus,
    };
  }
  const mapped = mapBlindWinner(order, parsed.judgment.winner);
  await insertCall(client, claimed, ready, order, prepared, {
    id: callId,
    status: 'accepted',
    winner: parsed.judgment.winner,
    mapped,
    confidence: parsed.judgment.confidence,
    rejection: null,
    latencyMs,
    usage,
    cost,
    envelope,
  });
  return {
    mapped,
    rejection: null,
    stop: null,
    latencyMs,
    usage,
    costAmount: cost.amount,
    costStatus: cost.costStatus,
  };
}

async function storeRejectedCall(
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  options: EvaluationWorkerOptions,
  ready: ReadyHead,
  order: ComparisonOrder,
  prepared: PreparedCall,
  rejection: 'provider_timeout' | 'provider_error',
  latencyMs: number,
  usage: TokenUsage,
  envelope: EncryptedEnvelope | null,
): Promise<void> {
  await finishAttempt(client, {
    ...failedInput(claimed.tenantId, prepared.requestId, prepared.modelAttemptId, rejection, latencyMs, usage),
    dispatched: true,
    expenseCertainty: 'uncertain',
    failureClass: rejection === 'provider_timeout' ? 'timeout_after_dispatch' : 'upstream_error',
  });
  const cost = await costOnce(client, claimed.tenantId, prepared.modelAttemptId);
  await insertCall(client, claimed, ready, order, prepared, {
    id: randomUUID(),
    status: 'rejected',
    winner: null,
    mapped: null,
    confidence: null,
    rejection,
    latencyMs,
    usage,
    cost,
    envelope,
  });
  void options;
}

async function insertCall(
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  ready: ReadyHead,
  order: ComparisonOrder,
  prepared: PreparedCall,
  input: {
    id: string;
    status: 'accepted' | 'rejected';
    winner: 'X' | 'Y' | 'tie' | 'inconclusive' | null;
    mapped: MappedCandidate | null;
    confidence: number | null;
    rejection: string | null;
    latencyMs: number;
    usage: TokenUsage;
    cost: CalculatedCost;
    envelope: EncryptedEnvelope | null;
  },
): Promise<void> {
  await client.query('SAVEPOINT judge_call');
  try {
    await client.query(
      `INSERT INTO evaluation_judge_calls (
         id, tenant_id, run_id, item_id, comparison_order, rubric_version_id, judge_deployment, judge_model,
         rubric_version, status, blind_winner, mapped_candidate, confidence, rejection_code, latency_ms,
         prompt_tokens, completion_tokens, total_tokens, cost_amount, cost_status, request_id, model_attempt_id,
         output_schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
         content_iv, content_tag, content_ciphertext
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19::numeric, $20, $21, $22,
         $23, $24, $25, $26, $27,
         $28, $29, $30
       )`,
      [
        input.id,
        claimed.tenantId,
        claimed.runId,
        claimed.itemId,
        order,
        ready.rubricVersionId,
        ready.judgeDeployment,
        ready.judgeModel,
        ready.rubricVersion,
        input.status,
        input.winner,
        input.mapped,
        input.confidence,
        input.rejection,
        input.latencyMs,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.usage.totalTokens,
        input.cost.amount,
        input.cost.costStatus,
        prepared.requestId,
        prepared.modelAttemptId,
        input.envelope?.schemaVersion ?? null,
        input.envelope?.wrappingKeyVersion ?? null,
        input.envelope?.wrappedKeyIv ?? null,
        input.envelope?.wrappedKeyTag ?? null,
        input.envelope?.wrappedKeyCiphertext ?? null,
        input.envelope?.contentIv ?? null,
        input.envelope?.contentTag ?? null,
        input.envelope?.contentCiphertext ?? null,
      ],
    );
    await client.query('RELEASE SAVEPOINT judge_call');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT judge_call');
    await client.query('RELEASE SAVEPOINT judge_call');
    if (!isUniqueViolation(error)) throw error;
  }
}

async function storeFinding(
  client: PoolClient,
  claimed: { tenantId: string; runId: string; itemId: string },
  ready: ReadyHead,
  input: {
    outcome: JudgeFinding;
    forward: MappedCandidate | null;
    reverse: MappedCandidate | null;
    stop: StopReason | null;
    latencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    costAmount: string | null;
    costStatus: string | null;
  },
): Promise<void> {
  const outcome = confident(input.outcome, input.forward, input.reverse, input.stop);
  await client.query('SAVEPOINT judge_finding');
  try {
    await client.query(
      `INSERT INTO evaluation_judge_findings (
         tenant_id, run_id, item_id, rubric_version_id, judge_model, rubric_version, outcome,
         forward_mapped, reverse_mapped, stop_reason, latency_ms, prompt_tokens, completion_tokens,
         total_tokens, cost_amount, cost_status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::numeric, $16)`,
      [
        claimed.tenantId,
        claimed.runId,
        claimed.itemId,
        ready.rubricVersionId,
        ready.judgeModel,
        ready.rubricVersion,
        outcome,
        input.forward,
        input.reverse,
        outcome === 'model_a' || outcome === 'model_b' || outcome === 'tie' ? null : input.stop,
        input.latencyMs,
        input.promptTokens,
        input.completionTokens,
        input.totalTokens,
        input.costAmount,
        input.costStatus,
      ],
    );
    await client.query('RELEASE SAVEPOINT judge_finding');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT judge_finding');
    await client.query('RELEASE SAVEPOINT judge_finding');
    if (!isUniqueViolation(error)) throw error;
  }
}

function confident(
  outcome: JudgeFinding,
  forward: MappedCandidate | null,
  reverse: MappedCandidate | null,
  stop: StopReason | null,
): JudgeFinding {
  if (stop !== null) return outcome === 'unstable' ? 'unstable' : 'inconclusive';
  if (forward === null || reverse === null || forward !== reverse) return outcome === 'unstable' ? 'unstable' : 'inconclusive';
  return outcome;
}

async function pinJudge(client: PoolClient, name: string, pinnedModel: string): Promise<ResolvedRoute | null> {
  if (name === 'auto' || pinnedModel === 'auto') return null;
  const catalog = await loadCatalog(client);
  const deployment = catalog.deployments.find((item) => item.name === name);
  if (deployment === undefined || !deployment.enabled || !deployment.connectionEnabled) return null;
  if (deployment.upstreamModel !== pinnedModel) return null;
  const route = routeForDeployment(deployment.name, deployment, false, null);
  return { ...route, requestedModel: deployment.name, routedByAlias: false, fallbackPolicy: null, allowFallbacks: false };
}

async function finishQuiet(
  pool: Pool,
  claimed: { tenantId: string },
  prepared: PreparedCall,
  status: 'failed',
  reason: string,
  latencyMs: number,
  usage: TokenUsage,
  providerRequestId: string | null,
): Promise<void> {
  await withTenant(pool, claimed.tenantId, (client) =>
    finishAttempt(client, {
      ...failedInput(claimed.tenantId, prepared.requestId, prepared.modelAttemptId, reason, latencyMs, usage),
      providerRequestId,
    }),
  );
}

function failedInput(
  tenantId: string,
  requestId: string,
  attemptId: string,
  reason: string | null,
  latencyMs: number,
  usage: TokenUsage,
): Parameters<typeof finishAttempt>[1] {
  return {
    tenantId,
    requestId,
    attemptId,
    status: 'failed',
    errorCode: reason,
    durationMs: latencyMs,
    usage,
    providerRequestId: null,
    stopReason: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
    dispatched: false,
    expenseCertainty: 'none',
    closeRequest: true,
  };
}

async function costOnce(client: PoolClient, tenantId: string, modelAttemptId: string): Promise<CalculatedCost> {
  await client.query('SAVEPOINT judge_cost');
  try {
    const cost = await recordAttemptCost(client, tenantId, modelAttemptId);
    await client.query('RELEASE SAVEPOINT judge_cost');
    return cost;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT judge_cost');
    await client.query('RELEASE SAVEPOINT judge_cost');
    return {
      costStatus: 'unknown',
      amount: null,
      allocatedStatus: null,
      allocatedAmount: null,
      priceVersionId: null,
      currency: null,
    };
  }
}

function providerCall(
  prepared: PreparedCall,
  tenantId: string,
  baseURL: string,
  options: EvaluationWorkerOptions,
): ProviderCall {
  return {
    apiKey: prepared.apiKey,
    baseURL,
    request: prepared.request,
    route: prepared.route,
    signal: options.signal ?? new AbortController().signal,
    tenantId,
    fetchImpl: options.fetchImpl,
  };
}

function adapterFor(provider: string): ProviderAdapter | null {
  if (provider === 'anthropic') return anthropicAdapter;
  if (provider === 'openai' || provider === 'xai' || provider === 'openrouter' || provider === 'dgx') return openAiAdapter;
  if (provider === 'vertex') return vertexAdapter;
  return null;
}

async function activeApiKey(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tenant_api_keys WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1`,
    [],
  );
  return result.rows[0]?.id ?? null;
}

function judgeModelOf(snapshot: Record<string, unknown>): string | null {
  const value = snapshot.judgeModel;
  return typeof value === 'string' && value.length > 0 && value !== 'auto' ? value : null;
}

function stopForCode(code: string | null): StopReason {
  if (code === 'judge_disclosure_denied') return 'disclosure_revoked';
  if (code === 'sample_expired') return 'sample_expired';
  if (code === 'budget_exceeded') return 'budget_exceeded';
  if (code === 'deployment_unauthorized') return 'deployment_unauthorized';
  if (code === 'provider_denied') return 'provider_denied';
  return 'provider_denied';
}

function rejectionStop(code: string | null): StopReason | null {
  if (code === 'provider_timeout') return 'provider_timeout';
  if (code === 'provider_error') return 'provider_error';
  return null;
}

function isMapped(value: string | null): value is MappedCandidate {
  return value === 'original' || value === 'challenger' || value === 'tie' || value === 'inconclusive';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envelopeOf(row: {
  schema_version: number;
  wrapping_key_version: number;
  wrapped_key_iv: Buffer;
  wrapped_key_tag: Buffer;
  wrapped_key_ciphertext: Buffer;
  content_iv: Buffer;
  content_tag: Buffer;
  content_ciphertext: Buffer;
}): EncryptedEnvelope {
  return {
    schemaVersion: row.schema_version,
    wrappingKeyVersion: row.wrapping_key_version,
    wrappedKeyIv: Buffer.isBuffer(row.wrapped_key_iv) ? row.wrapped_key_iv : Buffer.from(row.wrapped_key_iv),
    wrappedKeyTag: Buffer.isBuffer(row.wrapped_key_tag) ? row.wrapped_key_tag : Buffer.from(row.wrapped_key_tag),
    wrappedKeyCiphertext: Buffer.isBuffer(row.wrapped_key_ciphertext) ? row.wrapped_key_ciphertext : Buffer.from(row.wrapped_key_ciphertext),
    contentIv: Buffer.isBuffer(row.content_iv) ? row.content_iv : Buffer.from(row.content_iv),
    contentTag: Buffer.isBuffer(row.content_tag) ? row.content_tag : Buffer.from(row.content_tag),
    contentCiphertext: Buffer.isBuffer(row.content_ciphertext) ? row.content_ciphertext : Buffer.from(row.content_ciphertext),
  };
}

function emptyResult(): OrderResult {
  return {
    mapped: null,
    rejection: null,
    stop: null,
    latencyMs: 0,
    usage: EMPTY_USAGE,
    costAmount: null,
    costStatus: null,
  };
}

function addCount(current: number | null, next: number | null): number | null {
  if (current === null || next === null) return null;
  return current + next;
}

function elapsedMs(started: bigint): number {
  const duration = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return duration < 0 ? 0 : duration;
}

function logJudge(logger: Logger | undefined, itemId: string, outcome: string, stop: string | null): void {
  logger?.info('evaluation judge finished', { itemId, outcome, stopReason: stop });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

