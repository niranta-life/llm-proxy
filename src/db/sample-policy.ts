import type { Pool } from 'pg';

export type StoredSamplePolicy = {
  policyVersion: number;
  mode: string;
  contentCapture: boolean;
  replay: boolean;
  judgeDisclosure: boolean;
  sampleRate: string | number;
  maxSampleBytes: number;
  maxSampleCount: number;
  retentionSeconds: number;
  recentShare: string | number;
  classifications: string[];
  providers: string[];
  deployments: string[];
};

export async function setSamplePolicy(
  pool: Pool,
  tenantId: string,
  mode: string,
  contentCapture: boolean,
  replay: boolean,
  judgeDisclosure: boolean,
  sampleRate: string,
  maxSampleBytes: number,
  maxSampleCount: number,
  retentionSeconds: number,
  classifications: string[],
  providers: string[],
  deployments: string[],
  recentShare: string,
): Promise<{ policyId: string; policyVersion: number }> {
  const result = await pool.query<{ policy_id: string; policy_version: number }>(
    `SELECT policy_id, policy_version
     FROM set_sample_policy($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      tenantId,
      mode,
      contentCapture,
      replay,
      judgeDisclosure,
      sampleRate,
      maxSampleBytes,
      maxSampleCount,
      retentionSeconds,
      classifications,
      providers,
      deployments,
      recentShare,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('sample policy was not stored');
  return { policyId: row.policy_id, policyVersion: row.policy_version };
}

export async function showSamplePolicy(pool: Pool, tenantId: string): Promise<StoredSamplePolicy | null> {
  const result = await pool.query<{ show_sample_policy: StoredSamplePolicy | null }>(
    `SELECT show_sample_policy($1) AS show_sample_policy`,
    [tenantId],
  );
  return result.rows[0]?.show_sample_policy ?? null;
}

export async function deleteTenantSample(pool: Pool, tenantId: string, sampleId: string): Promise<boolean> {
  const result = await pool.query<{ delete_request_sample: boolean }>(
    `SELECT delete_request_sample($1, $2, 'manual') AS delete_request_sample`,
    [tenantId, sampleId],
  );
  return result.rows[0]?.delete_request_sample === true;
}

export async function showSampleStats(pool: Pool, tenantId: string): Promise<unknown> {
  const result = await pool.query<{ show_sample_stats: unknown }>(
    `SELECT show_sample_stats($1) AS show_sample_stats`,
    [tenantId],
  );
  return result.rows[0]?.show_sample_stats ?? null;
}

export async function setDeploymentDataClass(
  pool: Pool,
  tenantId: string,
  name: string,
  dataClass: string | null,
): Promise<number> {
  const result = await pool.query<{ set_deployment_data_class: number }>(
    `SELECT set_deployment_data_class($1, $2, $3) AS set_deployment_data_class`,
    [tenantId, name, dataClass],
  );
  const version = result.rows[0]?.set_deployment_data_class;
  if (version === undefined) throw new Error('data class was not stored');
  return version;
}
