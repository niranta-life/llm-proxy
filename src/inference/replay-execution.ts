import type { Pool } from 'pg';
import { breakerAllows } from '../db/breaker.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { openAiAdapter, type TokenUsage, type UpstreamCompletion } from './adapter.js';
import { admitChatAttempt, settleChatAttempt } from './admission.js';
import { anthropicAdapter } from './anthropic.js';
import { providerChatBaseUrl } from './compatible.js';
import type { ProviderAdapter, ProviderCall } from './contract.js';
import { recordAttemptCost } from './cost-store.js';
import { type CalculatedCost } from './cost.js';
import { ADAPTER_VERSION } from './samples.js';
import { SAMPLE_SCHEMA_VERSION, decryptSample, encryptSample, type SampleKeyManager } from './sample-crypto.js';
import type { ProviderCredentialStore } from '../credentials.js';
import {
  applyStoredItemTransition,
  canonicalBudget,
  loadEvaluationFacts,
  lockEvaluationRow,
  readEvaluation,
  syncRunProgress,
  type EvaluationPlan,
} from './evaluations.js';
import type { ItemReasonCode } from './evaluation-state.js';
import { isItemStatus, isRunStatus } from './evaluation-state.js';
import { ProxyError } from './errors.js';
import type { ClaimedEvaluationJob, EvaluationWorkerOptions } from './evaluation-worker.js';
import { admissionItemReason, providerItemReason, rebuildReplayRequest, recheckReplayItem } from './replay-request.js';
import { routeForDeployment, type ResolvedRoute } from './resolve.js';
import { scoreCompletedReplay } from './evaluation-profiles.js';
import { finishAttempt, insertEvaluationPending, loadCatalog } from './store.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';
import { vertexAdapter } from './vertex.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const EMPTY_USAGE: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

export type ReplayAdvance = {
  outcome: 'completed' | 'duplicate' | 'cancelled' | 'failed' | 'not_dispatched' | 'dispatched';
  finish: 'succeeded' | 'cancelled' | null;
};

type AttemptRow = {
  id: string;
  status: string;
  request_id: string;
  model_attempt_id: string;
};

type ReservedCall = {
  evaluationAttemptId: string;
  requestId: string;
  modelAttemptId: string;
  route: ResolvedRoute;
  request: import('./validate.js').ChatRequest;
  apiKey: string;
  originalDeployment: string;
};

export async function advanceReplay(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
): Promise<ReplayAdvance> {
  const existing = await withTenant(pool, claimed.tenantId, (client) => loadAttempt(client, claimed.itemId));
  if (existing?.status === 'reserved') return closeReserved(pool, claimed, options);
  if (existing?.status === 'dispatched') return closeDispatched(pool, claimed, options);
  if (existing !== null) return finishDuplicate(pool, claimed, options);

  const prepared = await withTenant(pool, claimed.tenantId, (client) => prepareReplay(pool, client, claimed, options));
  if (prepared.kind === 'done') return prepared.advance;
  if (options.stopBeforeDispatch) {
    logReplay(options.logger, prepared.call.evaluationAttemptId, claimed.itemId, 'reserved', 'not_dispatched', 0);
    return { outcome: 'not_dispatched', finish: null };
  }

  try {
    await admitChatAttempt(pool, {
      tenantId: claimed.tenantId,
      apiKeyId: prepared.apiKeyId,
      route: prepared.call.route,
      request: prepared.call.request,
      attemptId: prepared.call.modelAttemptId,
      stream: false,
      now: new Date(),
    });
  } catch (error) {
    const reason = error instanceof ProxyError ? admissionItemReason(error.code) : 'admission_unavailable';
    await failReserved(pool, claimed, options, prepared.call, reason, false);
    return { outcome: 'failed', finish: 'succeeded' };
  }

  if (options.beforeDispatch) await options.beforeDispatch();

  const gated = await withTenant(pool, claimed.tenantId, (client) =>
    gateDispatch(pool, client, claimed, options, prepared.call),
  );
  if (gated.kind === 'done') {
    await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, prepared.call.modelAttemptId, new Date());
    return gated.advance;
  }
  if (options.stopAfterDispatch) {
    logReplay(options.logger, prepared.call.evaluationAttemptId, claimed.itemId, 'dispatched', 'uncertain', 0);
    return { outcome: 'dispatched', finish: null };
  }

  const started = process.hrtime.bigint();
  let called = false;
  try {
    const adapter = adapterFor(prepared.call.route.provider);
    if (adapter === null) throw new Error('adapter is unavailable');
    const baseURL = providerChatBaseUrl(
      prepared.call.route.provider,
      prepared.call.route.endpoint,
      options.upstreamBaseUrl ?? '',
    );
    called = true;
    if (options.callCounter) options.callCounter.count += 1;
    const completion = await adapter.execute(providerCall(prepared.call, baseURL, options));
    const latencyMs = elapsedMs(started);
    const advance = await storeCompletion(pool, claimed, options, prepared.call, completion, latencyMs);
    await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, prepared.call.modelAttemptId, new Date());
    return advance;
  } catch (error) {
    if (!called && options.callCounter) options.callCounter.count = Math.max(0, options.callCounter.count);
    const reason = called ? providerItemReason(error) : 'provider_denied';
    if (called) {
      await storeProviderFailure(pool, claimed, options, prepared.call, reason, elapsedMs(started));
      await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, prepared.call.modelAttemptId, new Date());
      return { outcome: 'failed', finish: 'succeeded' };
    }
    await failReserved(pool, claimed, options, prepared.call, reason, true);
    return { outcome: 'failed', finish: 'succeeded' };
  }
}

async function closeReserved(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
): Promise<ReplayAdvance> {
  await withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const attempt = await loadAttempt(client, claimed.itemId);
    if (attempt === null || attempt.status !== 'reserved') return;
    await finishAttempt(client, {
      tenantId: claimed.tenantId,
      requestId: attempt.request_id,
      attemptId: attempt.model_attempt_id,
      status: 'failed',
      errorCode: 'not_dispatched',
      durationMs: 0,
      usage: EMPTY_USAGE,
      providerRequestId: null,
      stopReason: null,
      uncachedInputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      thoughtsTokens: null,
      failureClass: null,
      dispatched: false,
      expenseCertainty: 'none',
      closeRequest: true,
    });
    await markEvaluationAttempt(client, attempt.id, 'reserved', 'failed', 'not_dispatched', null);
    await failItem(client, claimed, 'not_dispatched');
    logReplay(options.logger, attempt.id, claimed.itemId, 'failed', 'not_dispatched', 0);
  });
  await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, await modelAttemptId(pool, claimed), new Date());
  return { outcome: 'failed', finish: 'succeeded' };
}

async function closeDispatched(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
): Promise<ReplayAdvance> {
  await withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const attempt = await loadAttempt(client, claimed.itemId);
    if (attempt === null || attempt.status !== 'dispatched') return;
    await finishAttempt(client, {
      tenantId: claimed.tenantId,
      requestId: attempt.request_id,
      attemptId: attempt.model_attempt_id,
      status: 'failed',
      errorCode: 'uncertain',
      durationMs: 0,
      usage: EMPTY_USAGE,
      providerRequestId: null,
      stopReason: null,
      uncachedInputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      thoughtsTokens: null,
      failureClass: null,
      dispatched: true,
      expenseCertainty: 'uncertain',
      closeRequest: true,
    });
    const cost = await costOnce(client, claimed.tenantId, attempt.model_attempt_id);
    await markEvaluationAttempt(client, attempt.id, 'dispatched', 'uncertain', 'uncertain', cost);
    await failItem(client, claimed, 'uncertain');
    logReplay(options.logger, attempt.id, claimed.itemId, 'uncertain', 'uncertain', 0);
  });
  await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, await modelAttemptId(pool, claimed), new Date());
  return { outcome: 'failed', finish: 'succeeded' };
}

async function finishDuplicate(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
): Promise<ReplayAdvance> {
  const state = await withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const item = await client.query<{ status: string }>(`SELECT status FROM evaluation_items WHERE id = $1`, [claimed.itemId]);
    const status = item.rows[0]?.status;
    if (status === 'cancelled') return 'cancelled' as const;
    logReplay(options.logger, null, claimed.itemId, status ?? 'duplicate', 'duplicate', 0);
    return 'duplicate' as const;
  });
  return { outcome: state === 'cancelled' ? 'cancelled' : 'duplicate', finish: state === 'cancelled' ? 'cancelled' : 'succeeded' };
}

async function prepareReplay(
  pool: Pool,
  client: import('pg').PoolClient,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
): Promise<{ kind: 'done'; advance: ReplayAdvance } | { kind: 'ready'; call: ReservedCall; apiKeyId: string }> {
  await lockEvaluationRow(client, claimed.runId);
  await lockEvaluationRow(client, claimed.itemId);
  const item = await client.query<{ status: string; sample_id: string }>(
    `SELECT status, sample_id::text AS sample_id FROM evaluation_items WHERE id = $1`,
    [claimed.itemId],
  );
  const itemStatus = item.rows[0]?.status;
  const sampleId = item.rows[0]?.sample_id;
  const run = await readEvaluation(client, claimed.runId);
  if (itemStatus === undefined || sampleId === undefined || !isItemStatus(itemStatus) || run === null || !isRunStatus(run.status)) {
    return { kind: 'done', advance: { outcome: 'duplicate', finish: 'succeeded' } };
  }
  if (itemStatus === 'completed' || itemStatus === 'failed') {
    return { kind: 'done', advance: { outcome: 'duplicate', finish: 'succeeded' } };
  }
  if (run.status === 'cancelled' || run.status === 'cancel_requested' || itemStatus === 'cancelled') {
    if (itemStatus === 'queued' || itemStatus === 'running' || itemStatus === 'pending') {
      await applyStoredItemTransition(client, claimed.itemId, 'cancelled', 'cancelled');
      await syncRunProgress(client, claimed.runId);
    }
    return { kind: 'done', advance: { outcome: 'cancelled', finish: 'cancelled' } };
  }
  const allowed = (options.replayTenantIds ?? []).includes(claimed.tenantId);
  if (!options.executionEnabled || !allowed) {
    await failItem(client, claimed, 'kill_switch');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  if (options.credentialStore === null || options.credentialStore === undefined || options.sampleKeyManager === null || options.sampleKeyManager === undefined) {
    await failItem(client, claimed, 'provider_denied');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  if (run.mode !== 'replay' || run.challengerDeployment === 'auto') {
    await failItem(client, claimed, 'semantic_rejected');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const category = taskOf(run.sampleCategory);
  if (category === null) {
    await failItem(client, claimed, 'invalid_canonical');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const plan = replayPlan(run, sampleId, category);
  const facts = await loadEvaluationFacts(client, plan);
  const health = await deploymentHealth(client, run.challengerDeployment);
  const breakerOpen = await challengerBreakerOpen(pool, claimed.tenantId, health.id);
  const reason = recheckReplayItem(facts, {
    healthStatus: health.status,
    breakerOpen,
    executionEnabled: options.executionEnabled,
  });
  if (reason !== null) {
    await failItem(client, claimed, reason);
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const rebuilt = await rebuildFromEnvelope(client, options.sampleKeyManager, claimed.tenantId, sampleId, run.challengerDeployment, facts);
  if (!rebuilt.ok) {
    await failItem(client, claimed, rebuilt.reason);
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const route = await pinChallenger(client, run.challengerDeployment);
  if (route === null) {
    await failItem(client, claimed, 'deployment_unauthorized');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const apiKeyId = await activeApiKey(client);
  if (apiKeyId === null) {
    await failItem(client, claimed, 'provider_denied');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  if (itemStatus === 'pending') await applyStoredItemTransition(client, claimed.itemId, 'queued', null);
  if (itemStatus === 'pending' || itemStatus === 'queued') {
    await applyStoredItemTransition(client, claimed.itemId, 'running', null);
  }
  let pending: { requestId: string; attemptId: string; protectedCredential: string | null };
  try {
    pending = await insertEvaluationPending(client, claimed.tenantId, route);
  } catch {
    await failItem(client, claimed, 'provider_denied');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  let apiKey = '';
  try {
    apiKey = pending.protectedCredential === null ? '' : options.credentialStore.open(pending.protectedCredential);
  } catch {
    await failItem(client, claimed, 'provider_denied');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO evaluation_attempts (
       tenant_id, run_id, item_id, sample_id, request_id, model_attempt_id, status,
       original_deployment, challenger_deployment, config_version, adapter_version, execution_parameters
     ) VALUES ($1, $2, $3, $4, $5, $6, 'reserved', $7, $8, $9, $10, $11::jsonb)
     RETURNING id::text AS id`,
    [
      claimed.tenantId,
      claimed.runId,
      claimed.itemId,
      sampleId,
      pending.requestId,
      pending.attemptId,
      rebuilt.value.originalDeployment,
      route.deploymentName,
      route.configVersion,
      ADAPTER_VERSION,
      JSON.stringify(rebuilt.value.executionParameters),
    ],
  );
  const evaluationAttemptId = inserted.rows[0]?.id;
  if (evaluationAttemptId === undefined) {
    await failItem(client, claimed, 'provider_error');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  await syncRunProgress(client, claimed.runId);
  return {
    kind: 'ready',
    apiKeyId,
    call: {
      evaluationAttemptId,
      requestId: pending.requestId,
      modelAttemptId: pending.attemptId,
      route,
      request: rebuilt.value.request,
      apiKey,
      originalDeployment: rebuilt.value.originalDeployment,
    },
  };
}

async function gateDispatch(
  pool: Pool,
  client: import('pg').PoolClient,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
  call: ReservedCall,
): Promise<{ kind: 'done'; advance: ReplayAdvance } | { kind: 'go' }> {
  await lockEvaluationRow(client, claimed.runId);
  await lockEvaluationRow(client, claimed.itemId);
  const run = await readEvaluation(client, claimed.runId);
  const item = await client.query<{ status: string; sample_id: string }>(
    `SELECT status, sample_id::text AS sample_id FROM evaluation_items WHERE id = $1`,
    [claimed.itemId],
  );
  const itemStatus = item.rows[0]?.status;
  const sampleId = item.rows[0]?.sample_id;
  if (run === null || itemStatus === undefined || sampleId === undefined || !isItemStatus(itemStatus) || !isRunStatus(run.status)) {
    return { kind: 'done', advance: { outcome: 'duplicate', finish: 'succeeded' } };
  }
  if (run.status === 'cancelled' || run.status === 'cancel_requested' || itemStatus === 'cancelled') {
    await releaseReserved(client, claimed, call, 'cancelled', 'cancelled');
    return { kind: 'done', advance: { outcome: 'cancelled', finish: 'cancelled' } };
  }
  const allowed = (options.replayTenantIds ?? []).includes(claimed.tenantId);
  if (!options.executionEnabled || !allowed || options.signal?.aborted) {
    await releaseReserved(client, claimed, call, 'failed', 'kill_switch');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const category = taskOf(run.sampleCategory);
  if (category === null) {
    await releaseReserved(client, claimed, call, 'failed', 'invalid_canonical');
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const facts = await loadEvaluationFacts(client, replayPlan(run, sampleId, category));
  const health = await deploymentHealth(client, run.challengerDeployment);
  const breakerOpen = await challengerBreakerOpen(pool, claimed.tenantId, health.id);
  const reason = recheckReplayItem(facts, {
    healthStatus: health.status,
    breakerOpen,
    executionEnabled: options.executionEnabled,
  });
  if (reason !== null) {
    await releaseReserved(client, claimed, call, 'failed', reason);
    return { kind: 'done', advance: { outcome: 'failed', finish: 'succeeded' } };
  }
  const marked = await client.query(
    `UPDATE evaluation_attempts
     SET status = 'dispatched', updated_at = now()
     WHERE id = $1 AND status = 'reserved'`,
    [call.evaluationAttemptId],
  );
  if ((marked.rowCount ?? 0) !== 1) return { kind: 'done', advance: { outcome: 'duplicate', finish: 'succeeded' } };
  return { kind: 'go' };
}

async function storeCompletion(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
  call: ReservedCall,
  completion: UpstreamCompletion,
  latencyMs: number,
): Promise<ReplayAdvance> {
  const manager = options.sampleKeyManager ?? null;
  const sealed = encryptSample(manager, {
    tenantId: claimed.tenantId,
    sampleId: call.evaluationAttemptId,
    schemaVersion: SAMPLE_SCHEMA_VERSION,
    payload: {
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      output: {
        id: completion.response.id,
        model: completion.response.model,
        choices: completion.response.choices.map((choice) => ({
          index: choice.index,
          content: choice.message.content,
          finishReason: choice.finish_reason,
        })),
      },
    },
  });
  return withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const current = await loadAttempt(client, claimed.itemId);
    if (current === null || current.status !== 'dispatched') {
      return { outcome: 'duplicate', finish: 'succeeded' };
    }
    await finishAttempt(client, {
      tenantId: claimed.tenantId,
      requestId: call.requestId,
      attemptId: call.modelAttemptId,
      status: 'succeeded',
      errorCode: null,
      durationMs: latencyMs,
      usage: completion.usage,
      providerRequestId: completion.providerRequestId,
      stopReason: completion.stopReason,
      uncachedInputTokens: completion.uncachedInputTokens,
      cacheCreationInputTokens: completion.cacheCreationInputTokens,
      cacheReadInputTokens: completion.cacheReadInputTokens,
      thoughtsTokens: completion.thoughtsTokens ?? null,
      servingModel: completion.servingModel ?? null,
      servingProvider: completion.servingProvider ?? null,
      failureClass: null,
      dispatched: true,
      expenseCertainty: 'known',
      closeRequest: true,
    });
    const cost = await costOnce(client, claimed.tenantId, call.modelAttemptId);
    const reason = sealed === null ? 'output_not_sealed' : completionReason(completion.usage, cost);
    await markEvaluationAttempt(client, call.evaluationAttemptId, 'dispatched', reason === 'replay_completed' ? 'completed' : 'failed', reason, cost, {
      latencyMs,
      usage: completion.usage,
      providerResponseId: completion.providerRequestId,
      envelope: sealed,
    });
    if (reason === 'replay_completed') {
      await applyStoredItemTransition(client, claimed.itemId, 'completed', reason);
      await syncRunProgress(client, claimed.runId);
      if (manager !== null) {
        const sample = await client.query<{ sample_id: string }>(
          `SELECT sample_id::text AS sample_id FROM evaluation_attempts WHERE id = $1`,
          [call.evaluationAttemptId],
        );
        const sampleId = sample.rows[0]?.sample_id;
        if (sampleId !== undefined) {
          await scoreCompletedReplay(client, manager, {
            tenantId: claimed.tenantId,
            runId: claimed.runId,
            itemId: claimed.itemId,
            sampleId,
            attemptId: call.evaluationAttemptId,
          });
        }
      }
    } else {
      await failItem(client, claimed, reason);
    }
    logReplay(options.logger, call.evaluationAttemptId, claimed.itemId, reason === 'replay_completed' ? 'completed' : 'failed', reason, 1);
    return { outcome: reason === 'replay_completed' ? 'completed' : 'failed', finish: 'succeeded' } satisfies ReplayAdvance;
  });
}

async function storeProviderFailure(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
  call: ReservedCall,
  reason: ItemReasonCode,
  latencyMs: number,
): Promise<void> {
  await withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const current = await loadAttempt(client, claimed.itemId);
    if (current === null || current.status !== 'dispatched') return;
    await finishAttempt(client, {
      tenantId: claimed.tenantId,
      requestId: call.requestId,
      attemptId: call.modelAttemptId,
      status: 'failed',
      errorCode: reason,
      durationMs: latencyMs,
      usage: EMPTY_USAGE,
      providerRequestId: null,
      stopReason: null,
      uncachedInputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      thoughtsTokens: null,
      failureClass:
        reason === 'provider_rate_limited' ? 'rate_limit' : reason === 'provider_timeout' ? 'timeout_after_dispatch' : 'upstream_error',
      dispatched: true,
      expenseCertainty: 'uncertain',
      closeRequest: true,
    });
    const cost = await costOnce(client, claimed.tenantId, call.modelAttemptId);
    await markEvaluationAttempt(client, call.evaluationAttemptId, 'dispatched', 'failed', reason, cost, {
      latencyMs,
      usage: EMPTY_USAGE,
      providerResponseId: null,
      envelope: null,
    });
    await failItem(client, claimed, reason);
    logReplay(options.logger, call.evaluationAttemptId, claimed.itemId, 'failed', reason, 1);
  });
}

async function failReserved(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
  options: EvaluationWorkerOptions,
  call: ReservedCall,
  reason: ItemReasonCode,
  dispatched: boolean,
): Promise<void> {
  await withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const from = dispatched ? 'dispatched' : 'reserved';
    await finishAttempt(client, {
      tenantId: claimed.tenantId,
      requestId: call.requestId,
      attemptId: call.modelAttemptId,
      status: 'failed',
      errorCode: reason,
      durationMs: 0,
      usage: EMPTY_USAGE,
      providerRequestId: null,
      stopReason: null,
      uncachedInputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      thoughtsTokens: null,
      failureClass: null,
      dispatched,
      expenseCertainty: 'none',
      closeRequest: true,
    });
    await markEvaluationAttempt(client, call.evaluationAttemptId, from, 'failed', reason, null);
    if (reason === 'cancelled') {
      await applyStoredItemTransition(client, claimed.itemId, 'cancelled', 'cancelled');
      await syncRunProgress(client, claimed.runId);
    } else {
      await failItem(client, claimed, reason);
    }
    logReplay(options.logger, call.evaluationAttemptId, claimed.itemId, 'failed', reason, 0);
  });
  await settleChatAttempt(pool, options.logger ?? noopLogger, claimed.tenantId, call.modelAttemptId, new Date());
}

async function releaseReserved(
  client: import('pg').PoolClient,
  claimed: ClaimedEvaluationJob,
  call: ReservedCall,
  itemStatus: 'failed' | 'cancelled',
  reason: ItemReasonCode,
): Promise<void> {
  await finishAttempt(client, {
    tenantId: claimed.tenantId,
    requestId: call.requestId,
    attemptId: call.modelAttemptId,
    status: 'failed',
    errorCode: reason,
    durationMs: 0,
    usage: EMPTY_USAGE,
    providerRequestId: null,
    stopReason: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
    failureClass: null,
    dispatched: false,
    expenseCertainty: 'none',
    closeRequest: true,
  });
  await markEvaluationAttempt(client, call.evaluationAttemptId, 'reserved', 'failed', reason, null);
  if (itemStatus === 'cancelled') {
    await applyStoredItemTransition(client, claimed.itemId, 'cancelled', 'cancelled');
    await syncRunProgress(client, claimed.runId);
  } else {
    await failItem(client, claimed, reason);
  }
}

async function failItem(client: import('pg').PoolClient, claimed: ClaimedEvaluationJob, reason: ItemReasonCode): Promise<void> {
  const item = await client.query<{ status: string }>(`SELECT status FROM evaluation_items WHERE id = $1`, [claimed.itemId]);
  let status = item.rows[0]?.status;
  if (!isItemStatus(status ?? '')) return;
  if (status === 'failed' || status === 'completed' || status === 'cancelled') return;
  if (status === 'pending') {
    await applyStoredItemTransition(client, claimed.itemId, 'queued', null);
    status = 'queued';
  }
  // A queued run cannot move directly to failed. The item is running before the failure sync.
  if (status === 'queued') await applyStoredItemTransition(client, claimed.itemId, 'running', null);
  await syncRunProgress(client, claimed.runId);
  await applyStoredItemTransition(client, claimed.itemId, 'failed', reason);
  await syncRunProgress(client, claimed.runId);
}

async function loadAttempt(client: import('pg').PoolClient, itemId: string): Promise<AttemptRow | null> {
  const result = await client.query<AttemptRow>(
    `SELECT id::text AS id, status, request_id::text AS request_id, model_attempt_id::text AS model_attempt_id
     FROM evaluation_attempts WHERE item_id = $1`,
    [itemId],
  );
  return result.rows[0] ?? null;
}

async function markEvaluationAttempt(
  client: import('pg').PoolClient,
  attemptId: string,
  from: string,
  status: 'completed' | 'failed' | 'uncertain',
  reason: ItemReasonCode,
  cost: CalculatedCost | null,
  detail?: {
    latencyMs: number;
    usage: TokenUsage;
    providerResponseId: string | null;
    envelope: import('./sample-crypto.js').EncryptedEnvelope | null;
  },
): Promise<void> {
  const envelope = detail?.envelope ?? null;
  await client.query(
    `UPDATE evaluation_attempts
     SET status = $3,
         reason_code = $4,
         error_code = $5,
         latency_ms = COALESCE($6, latency_ms),
         prompt_tokens = $7,
         completion_tokens = $8,
         total_tokens = $9,
         provider_response_id = $10,
         cost_amount = $11::numeric,
         cost_status = $12,
         output_schema_version = $13,
         wrapping_key_version = $14,
         wrapped_key_iv = $15,
         wrapped_key_tag = $16,
         wrapped_key_ciphertext = $17,
         content_iv = $18,
         content_tag = $19,
         content_ciphertext = $20,
         updated_at = now()
     WHERE id = $1 AND status = $2`,
    [
      attemptId,
      from,
      status,
      reason,
      status === 'completed' ? null : reason,
      detail?.latencyMs ?? null,
      detail?.usage.promptTokens ?? null,
      detail?.usage.completionTokens ?? null,
      detail?.usage.totalTokens ?? null,
      detail?.providerResponseId ?? null,
      cost?.amount ?? null,
      cost?.costStatus ?? null,
      envelope?.schemaVersion ?? null,
      envelope?.wrappingKeyVersion ?? null,
      envelope?.wrappedKeyIv ?? null,
      envelope?.wrappedKeyTag ?? null,
      envelope?.wrappedKeyCiphertext ?? null,
      envelope?.contentIv ?? null,
      envelope?.contentTag ?? null,
      envelope?.contentCiphertext ?? null,
    ],
  );
}

async function costOnce(client: import('pg').PoolClient, tenantId: string, modelAttemptId: string): Promise<CalculatedCost> {
  await client.query('SAVEPOINT replay_cost');
  try {
    const cost = await recordAttemptCost(client, tenantId, modelAttemptId);
    await client.query('RELEASE SAVEPOINT replay_cost');
    return cost;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT replay_cost');
    await client.query('RELEASE SAVEPOINT replay_cost');
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

async function challengerBreakerOpen(pool: Pool, tenantId: string, deploymentId: string | null): Promise<boolean> {
  if (deploymentId === null) return true;
  // Read admission only. A probe claim would consume a production slot that replay never releases.
  return !(await breakerAllows(pool, tenantId, deploymentId, new Date()));
}

async function deploymentHealth(
  client: import('pg').PoolClient,
  name: string,
): Promise<{ id: string | null; status: string | null }> {
  const result = await client.query<{ id: string; health_status: string }>(
    `SELECT id::text AS id, health_status FROM model_deployments WHERE name = $1`,
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) return { id: null, status: null };
  return { id: row.id, status: row.health_status };
}

async function pinChallenger(client: import('pg').PoolClient, name: string): Promise<ResolvedRoute | null> {
  if (!NAME.test(name) || name === 'auto') return null;
  const catalog = await loadCatalog(client);
  const deployment = catalog.deployments.find((item) => item.name === name);
  if (deployment === undefined || !deployment.enabled || !deployment.connectionEnabled) return null;
  const route = routeForDeployment(deployment.name, deployment, false, null);
  return {
    ...route,
    requestedModel: deployment.name,
    routedByAlias: false,
    fallbackPolicy: null,
    allowFallbacks: false,
  };
}

async function rebuildFromEnvelope(
  client: import('pg').PoolClient,
  manager: SampleKeyManager,
  tenantId: string,
  sampleId: string,
  challengerName: string,
  facts: import('./evaluation-preflight.js').PreflightFacts,
): Promise<{ ok: true; value: import('./replay-request.js').ReplayRequestBuild } | { ok: false; reason: ItemReasonCode }> {
  const result = await client.query<{
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
  const row = result.rows[0];
  if (row === undefined) return { ok: false, reason: 'invalid_canonical' };
  const payload = decryptSample(
    manager,
    { tenantId, sampleId, schemaVersion: row.schema_version },
    {
      schemaVersion: row.schema_version,
      wrappingKeyVersion: row.wrapping_key_version,
      wrappedKeyIv: bufferOf(row.wrapped_key_iv),
      wrappedKeyTag: bufferOf(row.wrapped_key_tag),
      wrappedKeyCiphertext: bufferOf(row.wrapped_key_ciphertext),
      contentIv: bufferOf(row.content_iv),
      contentTag: bufferOf(row.content_tag),
      contentCiphertext: bufferOf(row.content_ciphertext),
    },
  );
  if (payload === null) return { ok: false, reason: 'invalid_canonical' };
  const capabilities = facts.challenger?.capabilities ?? [];
  const rebuilt = rebuildReplayRequest(payload, challengerName, capabilities);
  if (!rebuilt.ok) return rebuilt;
  if (!NAME.test(rebuilt.value.originalDeployment) || rebuilt.value.originalDeployment === 'auto') {
    return { ok: false, reason: 'invalid_canonical' };
  }
  if (rebuilt.value.request.model === 'auto' || rebuilt.value.request.stream) return { ok: false, reason: 'semantic_rejected' };
  return rebuilt;
}

function replayPlan(
  run: { sampleCategory: string; challengerDeployment: string; judgeDeployment: string | null; budgetEstimate: string; configSnapshot: Record<string, unknown> },
  sampleId: string,
  category: TaskCategory,
): EvaluationPlan {
  const required = run.configSnapshot.requiredCapabilities;
  return {
    name: 'replay-item',
    sampleCategory: category,
    sampleIds: [sampleId],
    challengerDeployment: run.challengerDeployment,
    judgeDeployment: run.judgeDeployment,
    requiredCapabilities: Array.isArray(required) && required.every((item) => typeof item === 'string') ? required : null,
    budgetEstimate: canonicalBudget(run.budgetEstimate),
    mode: 'replay',
    profileVersionId: null,
  };
}

function taskOf(value: string): TaskCategory | null {
  return isTaskCategory(value) ? value : null;
}

function completionReason(usage: TokenUsage, cost: CalculatedCost): ItemReasonCode {
  if (usage.promptTokens === null && usage.completionTokens === null && usage.totalTokens === null) return 'usage_missing';
  if (cost.costStatus === 'unknown' || cost.amount === null) return 'cost_missing';
  return 'replay_completed';
}

function providerCall(call: ReservedCall, baseURL: string, options: EvaluationWorkerOptions): ProviderCall {
  return {
    apiKey: call.apiKey,
    baseURL,
    request: call.request,
    route: call.route,
    signal: options.signal ?? new AbortController().signal,
    tenantId: '',
    fetchImpl: options.fetchImpl,
  };
}

function adapterFor(provider: string): ProviderAdapter | null {
  if (provider === 'anthropic') return anthropicAdapter;
  if (provider === 'openai' || provider === 'xai' || provider === 'openrouter' || provider === 'dgx') return openAiAdapter;
  if (provider === 'vertex') return vertexAdapter;
  return null;
}

async function activeApiKey(client: import('pg').PoolClient): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tenant_api_keys WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  return result.rows[0]?.id ?? null;
}

async function modelAttemptId(pool: Pool, claimed: ClaimedEvaluationJob): Promise<string> {
  const row = await withTenant(pool, claimed.tenantId, (client) => loadAttempt(client, claimed.itemId));
  return row?.model_attempt_id ?? claimed.itemId;
}

function bufferOf(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function elapsedMs(started: bigint): number {
  const duration = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return duration < 0 ? 0 : duration;
}

function logReplay(
  logger: Logger | undefined,
  attemptId: string | null,
  itemId: string,
  status: string,
  reason: string,
  modelCalls: number,
): void {
  logger?.info('evaluation replay finished', { attemptId, itemId, status, reason, modelCalls });
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
