import type { Pool, PoolClient } from 'pg';
import { withTenant } from './tenant-context.js';
import {
  decideAdmission,
  decideTransition,
  type BreakerOutcome,
  type BreakerStateName,
  type BreakerView,
} from '../inference/breaker.js';

export type BreakerGate = {
  allow: boolean;
  probe: boolean;
  track: boolean;
};

export type BreakerInspection = {
  deployment: string;
  enabled: boolean;
  state: BreakerStateName;
  reason: string;
  changedAt: string | null;
  samples: number;
  failures: number;
  rateLimits: number;
  probesInflight: number;
};

type BreakerRow = {
  enabled: boolean;
  state: BreakerStateName;
  cooldown_until: Date | null;
  probes_inflight: number;
  max_probes: number;
  min_samples: number;
  failure_threshold: number;
};

function viewOf(row: BreakerRow): BreakerView {
  return {
    enabled: row.enabled,
    state: row.state,
    cooldownUntilMs: row.cooldown_until === null ? null : row.cooldown_until.getTime(),
    probesInflight: row.probes_inflight,
    maxProbes: row.max_probes,
  };
}

async function readBreaker(client: PoolClient, deploymentId: string): Promise<BreakerRow | null> {
  const result = await client.query<BreakerRow>(
    `SELECT enabled, state, cooldown_until, probes_inflight, max_probes, min_samples, failure_threshold
     FROM deployment_breakers
     WHERE deployment_id = $1`,
    [deploymentId],
  );
  return result.rows[0] ?? null;
}

async function claimProbe(client: PoolClient, deploymentId: string, now: Date): Promise<boolean> {
  const result = await client.query(
    `UPDATE deployment_breakers
     SET probes_inflight = probes_inflight + 1,
         state = 'half_open',
         state_reason = CASE WHEN state = 'open' THEN 'cooldown_elapsed' ELSE state_reason END,
         state_changed_at = CASE WHEN state = 'open' THEN $2 ELSE state_changed_at END
     WHERE deployment_id = $1
       AND enabled = true
       AND probes_inflight < max_probes
       AND (
         (state = 'open' AND cooldown_until IS NOT NULL AND cooldown_until <= $2)
         OR state = 'half_open'
       )`,
    [deploymentId, now],
  );
  return (result.rowCount ?? 0) === 1;
}

async function insertObservation(
  client: PoolClient,
  tenantId: string,
  deploymentId: string,
  kind: 'success' | 'failure' | 'rate_limit',
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO breaker_observations (tenant_id, deployment_id, kind, observed_at)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, deploymentId, kind, now],
  );
  await client.query(
    `DELETE FROM breaker_observations AS observation
     USING deployment_breakers AS breaker
     WHERE observation.deployment_id = breaker.deployment_id
       AND observation.tenant_id = breaker.tenant_id
       AND observation.deployment_id = $1
       AND observation.observed_at < $2::timestamptz - (breaker.window_ms * INTERVAL '1 millisecond')`,
    [deploymentId, now],
  );
}

async function releaseProbe(client: PoolClient, deploymentId: string): Promise<void> {
  await client.query(
    `UPDATE deployment_breakers
     SET probes_inflight = GREATEST(probes_inflight - 1, 0)
     WHERE deployment_id = $1 AND state = 'half_open'`,
    [deploymentId],
  );
}

async function healthCounts(
  client: PoolClient,
  deploymentId: string,
  now: Date,
): Promise<{ samples: number; failures: number }> {
  const result = await client.query<{ samples: number; failures: number }>(
    `SELECT
       count(*) FILTER (WHERE observation.kind IN ('success', 'failure'))::int AS samples,
       count(*) FILTER (WHERE observation.kind = 'failure')::int AS failures
     FROM breaker_observations AS observation
     JOIN deployment_breakers AS breaker
       ON breaker.tenant_id = observation.tenant_id
      AND breaker.deployment_id = observation.deployment_id
     WHERE observation.deployment_id = $1
       AND observation.observed_at >= $2::timestamptz - (breaker.window_ms * INTERVAL '1 millisecond')`,
    [deploymentId, now],
  );
  return result.rows[0] ?? { samples: 0, failures: 0 };
}

export async function guardUpstream(
  pool: Pool,
  tenantId: string,
  deploymentId: string,
  now: Date,
): Promise<BreakerGate> {
  return withTenant(pool, tenantId, async (client) => {
    const row = await readBreaker(client, deploymentId);
    const admission = decideAdmission(row === null ? null : viewOf(row), now.getTime());
    if (admission === 'skip') return { allow: true, probe: false, track: false };
    if (admission === 'allow') return { allow: true, probe: false, track: true };
    if (admission === 'reject') return { allow: false, probe: false, track: true };
    const claimed = await claimProbe(client, deploymentId, now);
    if (!claimed) return { allow: false, probe: false, track: true };
    return { allow: true, probe: true, track: true };
  });
}

export async function noteUpstream(
  pool: Pool,
  tenantId: string,
  deploymentId: string,
  now: Date,
  probe: boolean,
  kind: BreakerOutcome,
): Promise<{ suppressRetry: boolean }> {
  return withTenant(pool, tenantId, async (client) => {
    const row = await readBreaker(client, deploymentId);
    if (row === null || !row.enabled) return { suppressRetry: false };
    if (kind === 'ignore') {
      if (probe) await releaseProbe(client, deploymentId);
      return { suppressRetry: false };
    }
    await insertObservation(client, tenantId, deploymentId, kind, now);
    const counts = kind === 'failure' ? await healthCounts(client, deploymentId, now) : { samples: 0, failures: 0 };
    const current = await readBreaker(client, deploymentId);
    if (current === null) return { suppressRetry: false };
    const action = decideTransition({
      state: current.state,
      probe,
      kind,
      samples: counts.samples,
      failures: counts.failures,
      minSamples: current.min_samples,
      failureThreshold: current.failure_threshold,
    });
    if (action === 'release') {
      await releaseProbe(client, deploymentId);
      return { suppressRetry: false };
    }
    if (action === 'close') {
      const closed = await client.query(
        `UPDATE deployment_breakers
         SET state = 'closed',
             state_reason = 'probe_succeeded',
             state_changed_at = $2,
             cooldown_until = NULL,
             probes_inflight = 0
         WHERE deployment_id = $1 AND enabled = true AND state = 'half_open'`,
        [deploymentId, now],
      );
      if ((closed.rowCount ?? 0) === 1) {
        await client.query('DELETE FROM breaker_observations WHERE deployment_id = $1', [deploymentId]);
      }
      return { suppressRetry: false };
    }
    if (action === 'reopen') {
      await client.query(
        `UPDATE deployment_breakers
         SET state = 'open',
             state_reason = 'probe_failed',
             state_changed_at = $2,
             cooldown_until = $2::timestamptz + (cooldown_ms * INTERVAL '1 millisecond'),
             probes_inflight = 0
         WHERE deployment_id = $1 AND enabled = true AND state = 'half_open'`,
        [deploymentId, now],
      );
      return { suppressRetry: true };
    }
    if (action === 'open') {
      const opened = await client.query(
        `UPDATE deployment_breakers
         SET state = 'open',
             state_reason = 'failure_threshold',
             state_changed_at = $2,
             cooldown_until = $2::timestamptz + (cooldown_ms * INTERVAL '1 millisecond'),
             probes_inflight = 0
         WHERE deployment_id = $1
           AND enabled = true
           AND state = 'closed'
           AND $3::int >= min_samples
           AND $4::int >= failure_threshold`,
        [deploymentId, now, counts.samples, counts.failures],
      );
      return { suppressRetry: (opened.rowCount ?? 0) === 1 };
    }
    return { suppressRetry: false };
  });
}

export async function listBreakers(
  client: PoolClient,
  now: Date,
  deployment: string | null,
): Promise<BreakerInspection[]> {
  const result = await client.query<{
    deployment: string;
    enabled: boolean;
    state: BreakerStateName;
    reason: string;
    changed_at: Date | null;
    probes_inflight: number;
    samples: number;
    failures: number;
    rate_limits: number;
  }>(
    `SELECT
       deployment.name AS deployment,
       COALESCE(breaker.enabled, false) AS enabled,
       COALESCE(breaker.state, 'closed') AS state,
       COALESCE(breaker.state_reason, 'disabled') AS reason,
       breaker.state_changed_at AS changed_at,
       COALESCE(breaker.probes_inflight, 0)::int AS probes_inflight,
       COALESCE(sample.samples, 0)::int AS samples,
       COALESCE(sample.failures, 0)::int AS failures,
       COALESCE(sample.rate_limits, 0)::int AS rate_limits
     FROM model_deployments AS deployment
     LEFT JOIN deployment_breakers AS breaker
       ON breaker.tenant_id = deployment.tenant_id
      AND breaker.deployment_id = deployment.id
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (
           WHERE observation.kind IN ('success', 'failure')
             AND observation.observed_at >= $1::timestamptz - (breaker.window_ms * INTERVAL '1 millisecond')
         ) AS samples,
         count(*) FILTER (
           WHERE observation.kind = 'failure'
             AND observation.observed_at >= $1::timestamptz - (breaker.window_ms * INTERVAL '1 millisecond')
         ) AS failures,
         count(*) FILTER (
           WHERE observation.kind = 'rate_limit'
             AND observation.observed_at >= $1::timestamptz - (breaker.window_ms * INTERVAL '1 millisecond')
         ) AS rate_limits
       FROM breaker_observations AS observation
       WHERE breaker.deployment_id IS NOT NULL
         AND observation.tenant_id = breaker.tenant_id
         AND observation.deployment_id = breaker.deployment_id
     ) AS sample ON true
     WHERE ($2::text IS NULL OR deployment.name = $2)
     ORDER BY deployment.name`,
    [now, deployment],
  );
  return result.rows.map((row) => ({
    deployment: row.deployment,
    enabled: row.enabled,
    state: row.state,
    reason: row.reason,
    changedAt: row.changed_at === null ? null : row.changed_at.toISOString(),
    samples: row.samples,
    failures: row.failures,
    rateLimits: row.rate_limits,
    probesInflight: row.probes_inflight,
  }));
}

export async function setDeploymentBreaker(
  pool: Pool,
  tenantId: string,
  name: string,
  enabled: boolean,
  windowMs: number | null,
  minSamples: number | null,
  failureThreshold: number | null,
  cooldownMs: number | null,
  maxProbes: number | null,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT set_deployment_breaker($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
    [tenantId, name, enabled, windowMs, minSamples, failureThreshold, cooldownMs, maxProbes],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('breaker was not stored');
  return id;
}

export async function resetDeploymentBreaker(pool: Pool, tenantId: string, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'SELECT reset_deployment_breaker($1, $2) AS id',
    [tenantId, name],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('breaker was not reset');
  return id;
}
