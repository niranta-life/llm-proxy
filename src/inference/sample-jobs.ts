import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../logger.js';

const CLEANUP_INTERVAL_MS = 60_000;

export type SampleCleanupResult = {
  status: 'succeeded' | 'idle' | 'failed';
  removed: number;
};

export async function runSampleCleanup(
  pool: Pool,
  input: {
    idempotencyKey: string;
    tenantId: string | null;
    now?: Date;
    crashAfterCommit?: boolean;
    interruptBeforeCommit?: boolean;
  },
): Promise<SampleCleanupResult> {
  await pool.query(`SELECT enqueue_sample_job($1, $2)`, [input.tenantId, input.idempotencyKey]);
  const claimed = await pool.query<{ job_id: string; tenant_id: string | null }>(
    `SELECT job_id, tenant_id FROM claim_sample_job($1)`,
    [input.idempotencyKey],
  );
  const job = claimed.rows[0];
  if (job === undefined) return { status: 'idle', removed: 0 };
  const client = await pool.connect();
  let removed = 0;
  let failed = false;
  try {
    await client.query('BEGIN');
    const cleaned = await client.query<{ removed: number }>(
      `SELECT cleanup_sample_rows($1, $2) AS removed`,
      [job.tenant_id, input.now ?? new Date()],
    );
    removed = cleaned.rows[0]?.removed ?? 0;
    if (input.interruptBeforeCommit) throw new Error('sample cleanup interrupted');
    await client.query('COMMIT');
  } catch {
    failed = true;
    await rollback(client);
  } finally {
    client.release();
  }
  if (failed) {
    await finishJob(pool, job.job_id, 'failed', 'cleanup failed');
    return { status: 'failed', removed: 0 };
  }
  if (input.crashAfterCommit) throw new Error('sample cleanup crashed');
  await finishJob(pool, job.job_id, 'succeeded', null);
  return { status: 'succeeded', removed };
}

export function startSampleCleanupWorker(pool: Pool, logger: Logger): () => void {
  const timer = setInterval(() => {
    const bucket = new Date().toISOString().slice(0, 13);
    const idempotencyKey = `expire-cleanup:all:${bucket}`;
    void runSampleCleanup(pool, { idempotencyKey, tenantId: null }).then(
      (result) => {
        if (result.removed > 0) {
          logger.info('sample cleanup finished', { removed: result.removed, status: result.status });
        }
      },
      () => {
        logger.error('sample cleanup failed');
      },
    );
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

async function finishJob(
  pool: Pool,
  jobId: string,
  status: 'succeeded' | 'failed',
  error: string | null,
): Promise<void> {
  await pool.query(`SELECT finish_sample_job($1, $2, $3)`, [jobId, status, error]);
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The connection is discarded by the caller after release.
  }
}
