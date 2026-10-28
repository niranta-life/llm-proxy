import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import {
  applyStoredItemTransition,
  lockEvaluationRow,
  readEvaluation,
  syncRunProgress,
} from './evaluations.js';
import { isItemStatus, isRunStatus } from './evaluation-state.js';
import { cancelOverdueScheduleRuns, maintainEvaluationSchedule } from './evaluation-schedule-store.js';
import { advanceJudge } from './judge-execution.js';
import { advanceReplay } from './replay-execution.js';
import type { SampleKeyManager } from './sample-crypto.js';

export type ClaimedEvaluationJob = {
  jobId: string;
  tenantId: string;
  runId: string;
  itemId: string;
};

export type EvaluationWorkerOptions = {
  workerId: string;
  dryRun: boolean;
  executionEnabled: boolean;
  signal?: AbortSignal;
  pollMs?: number;
  replayTenantIds?: readonly string[];
  judgeTenantIds?: readonly string[];
  upstreamBaseUrl?: string;
  credentialStore?: ProviderCredentialStore | null;
  sampleKeyManager?: SampleKeyManager | null;
  fetchImpl?: typeof fetch;
  stopBeforeDispatch?: boolean;
  stopAfterDispatch?: boolean;
  beforeDispatch?: () => Promise<void> | void;
  logger?: Logger;
  callCounter?: { count: number };
  scheduleTenantIds?: readonly string[];
  globalKill?: boolean;
};

export type EvaluationPollResult = {
  claimed: boolean;
  outcome: 'idle' | 'completed' | 'duplicate' | 'cancelled' | 'failed' | 'not_dispatched' | 'dispatched' | 'skipped';
};

export async function claimEvaluationJob(pool: Pool, workerId: string): Promise<ClaimedEvaluationJob | null> {
  const result = await pool.query<{ job_id: string; tenant_id: string; run_id: string; item_id: string }>(
    `SELECT job_id::text AS job_id, tenant_id::text AS tenant_id, run_id::text AS run_id, item_id::text AS item_id
     FROM claim_evaluation_job($1)`,
    [workerId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { jobId: row.job_id, tenantId: row.tenant_id, runId: row.run_id, itemId: row.item_id };
}

export async function heartbeatEvaluationJob(pool: Pool, jobId: string, workerId: string): Promise<Date | null> {
  const result = await pool.query<{ heartbeat_evaluation_job: Date | null }>(
    `SELECT heartbeat_evaluation_job($1, $2) AS heartbeat_evaluation_job`,
    [jobId, workerId],
  );
  return result.rows[0]?.heartbeat_evaluation_job ?? null;
}

export async function finishEvaluationJob(
  pool: Pool,
  jobId: string,
  workerId: string,
  status: 'succeeded' | 'cancelled',
): Promise<boolean> {
  const result = await pool.query<{ finish_evaluation_job: boolean }>(
    `SELECT finish_evaluation_job($1, $2, $3) AS finish_evaluation_job`,
    [jobId, workerId, status],
  );
  return result.rows[0]?.finish_evaluation_job === true;
}

export async function claimReplayEvaluationJob(
  pool: Pool,
  workerId: string,
  tenantIds: readonly string[],
): Promise<ClaimedEvaluationJob | null> {
  if (tenantIds.length === 0) return null;
  const result = await pool.query<{ job_id: string; tenant_id: string; run_id: string; item_id: string }>(
    `SELECT job_id::text AS job_id, tenant_id::text AS tenant_id, run_id::text AS run_id, item_id::text AS item_id
     FROM claim_replay_evaluation_job($1, $2::uuid[])`,
    [workerId, tenantIds],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { jobId: row.job_id, tenantId: row.tenant_id, runId: row.run_id, itemId: row.item_id };
}

export async function claimJudgeEvaluationJob(
  pool: Pool,
  workerId: string,
  tenantIds: readonly string[],
): Promise<ClaimedEvaluationJob | null> {
  if (tenantIds.length === 0) return null;
  const result = await pool.query<{ job_id: string; tenant_id: string; run_id: string; item_id: string }>(
    `SELECT job_id::text AS job_id, tenant_id::text AS tenant_id, run_id::text AS run_id, item_id::text AS item_id
     FROM claim_judge_evaluation_job($1, $2::uuid[])`,
    [workerId, tenantIds],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { jobId: row.job_id, tenantId: row.tenant_id, runId: row.run_id, itemId: row.item_id };
}

async function evaluationKilled(pool: Pool, options: EvaluationWorkerOptions): Promise<boolean> {
  if (options.globalKill === true) return true;
  const result = await pool.query<{ kill_switch: boolean }>(
    `SELECT kill_switch FROM evaluation_controls WHERE singleton`,
  );
  return result.rows[0]?.kill_switch === true;
}

export async function pollEvaluationOnce(pool: Pool, options: EvaluationWorkerOptions): Promise<EvaluationPollResult> {
  if (options.signal?.aborted) return { claimed: false, outcome: 'idle' };
  if (options.dryRun) {
    const claimed = await claimEvaluationJob(pool, options.workerId);
    if (claimed === null) return { claimed: false, outcome: 'idle' };
    if (options.signal?.aborted) return { claimed: true, outcome: 'idle' };
    await heartbeatEvaluationJob(pool, claimed.jobId, options.workerId);
    const outcome = await advanceDryRun(pool, claimed);
    await finishEvaluationJob(pool, claimed.jobId, options.workerId, outcome === 'cancelled' ? 'cancelled' : 'succeeded');
    return { claimed: true, outcome };
  }
  const replayTenantIds = options.replayTenantIds ?? [];
  if (!options.executionEnabled || replayTenantIds.length === 0) return { claimed: false, outcome: 'skipped' };
  const scheduleTenantIds = options.scheduleTenantIds ?? [];
  if (scheduleTenantIds.length > 0) await cancelOverdueScheduleRuns(pool, scheduleTenantIds);
  if (await evaluationKilled(pool, options)) return { claimed: false, outcome: 'skipped' };
  const claimed = await claimReplayEvaluationJob(pool, options.workerId, replayTenantIds);
  if (claimed !== null) {
    if (options.signal?.aborted) return { claimed: true, outcome: 'idle' };
    await heartbeatEvaluationJob(pool, claimed.jobId, options.workerId);
    const advance = await advanceReplay(pool, claimed, options);
    if (advance.finish !== null) {
      await finishEvaluationJob(pool, claimed.jobId, options.workerId, advance.finish);
    }
    return { claimed: true, outcome: advance.outcome };
  }
  const judgeTenantIds = options.judgeTenantIds ?? [];
  if (judgeTenantIds.length === 0) return { claimed: false, outcome: 'idle' };
  const judgeClaimed = await claimJudgeEvaluationJob(pool, options.workerId, judgeTenantIds);
  if (judgeClaimed === null) return { claimed: false, outcome: 'idle' };
  if (options.signal?.aborted) return { claimed: true, outcome: 'idle' };
  await heartbeatEvaluationJob(pool, judgeClaimed.jobId, options.workerId);
  const judged = await advanceJudge(pool, judgeClaimed, options);
  if (judged.finish !== null) {
    await finishEvaluationJob(pool, judgeClaimed.jobId, options.workerId, judged.finish);
  }
  return { claimed: true, outcome: judged.outcome };
}

export async function runEvaluationWorker(
  pool: Pool,
  logger: Logger,
  options: EvaluationWorkerOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? 250;
  const callCounter = options.callCounter ?? { count: 0 };
  const workerOptions = options.callCounter === undefined ? { ...options, callCounter } : options;
  logger.info('evaluation worker started', {
    dryRun: options.dryRun,
    executionEnabled: options.executionEnabled,
    modelCalls: 0,
  });
  const aborted = (): boolean => options.signal?.aborted === true;
  while (!aborted()) {
    const result = await pollEvaluationOnce(pool, workerOptions);
    if (aborted()) break;
    if (result.outcome === 'idle' || result.outcome === 'skipped') {
      const maintained = await maintainEvaluationSchedule(pool, workerOptions);
      if (maintained.created) continue;
      const stopped = await sleep(pollMs, options.signal);
      if (stopped) break;
    }
  }
  logger.info('evaluation worker stopped', { modelCalls: callCounter.count });
}

async function advanceDryRun(
  pool: Pool,
  claimed: ClaimedEvaluationJob,
): Promise<'completed' | 'duplicate' | 'cancelled'> {
  return withTenant(pool, claimed.tenantId, async (client) => {
    await lockEvaluationRow(client, claimed.runId);
    await lockEvaluationRow(client, claimed.itemId);
    const itemResult = await client.query<{ status: string }>(
      `SELECT status FROM evaluation_items WHERE id = $1`,
      [claimed.itemId],
    );
    const itemStatus = itemResult.rows[0]?.status;
    const run = await readEvaluation(client, claimed.runId);
    if (itemStatus === undefined || !isItemStatus(itemStatus) || run === null || !isRunStatus(run.status)) {
      return 'duplicate';
    }
    if (itemStatus === 'completed' || itemStatus === 'failed') return 'duplicate';
    if (run.status === 'cancelled' || run.status === 'cancel_requested' || itemStatus === 'cancelled') {
      if (itemStatus === 'queued' || itemStatus === 'running' || itemStatus === 'pending') {
        await applyStoredItemTransition(client, claimed.itemId, 'cancelled', 'cancelled');
        await syncRunProgress(client, claimed.runId);
      }
      return 'cancelled';
    }
    if (itemStatus === 'pending') {
      await applyStoredItemTransition(client, claimed.itemId, 'queued', null);
    }
    if (itemStatus === 'pending' || itemStatus === 'queued') {
      await applyStoredItemTransition(client, claimed.itemId, 'running', null);
    }
    const completed = await applyStoredItemTransition(client, claimed.itemId, 'completed', 'dry_run');
    await syncRunProgress(client, claimed.runId);
    return completed === 'same' ? 'duplicate' : 'completed';
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
