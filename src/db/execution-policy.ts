import type { Pool } from 'pg';

export async function setDeploymentExecutionPolicy(
  pool: Pool,
  tenantId: string,
  name: string,
  retriesEnabled: boolean,
  connectionDeadlineMs: number,
  attemptDeadlineMs: number,
  totalDeadlineMs: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT set_deployment_execution_policy($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
    [
      tenantId,
      name,
      retriesEnabled,
      connectionDeadlineMs,
      attemptDeadlineMs,
      totalDeadlineMs,
      initialBackoffMs,
      maxBackoffMs,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('execution policy was not stored');
  return id;
}
