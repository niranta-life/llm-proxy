import type { Pool } from 'pg';

export type StoredFallbackPolicy = {
  policyId: string;
  policyVersion: number;
  enabled: boolean;
  maxAttempts: number;
  allowedFailures: string[];
  requiredCapabilities: string[];
  allowedProviders: string[];
  allowedRegions: string[];
  dataCollection: string;
  minRemainingDeadlineMs: number;
  deployments: string[];
};

export async function setFallbackPolicy(
  pool: Pool,
  tenantId: string,
  alias: string,
  enabled: boolean,
  deployments: string[],
  failures: string[],
  maxAttempts: number,
  capabilities: string[],
  providers: string[],
  regions: string[],
  dataCollection: string,
  minRemainingDeadlineMs: number,
): Promise<{ policyId: string; policyVersion: number }> {
  const result = await pool.query<{ policy_id: string; policy_version: number }>(
    `SELECT policy_id, policy_version
     FROM set_fallback_policy($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      tenantId,
      alias,
      enabled,
      deployments,
      failures,
      maxAttempts,
      capabilities,
      providers,
      regions,
      dataCollection,
      minRemainingDeadlineMs,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('fallback policy was not stored');
  return { policyId: row.policy_id, policyVersion: row.policy_version };
}

export async function showFallbackPolicy(
  pool: Pool,
  tenantId: string,
  alias: string,
): Promise<StoredFallbackPolicy | null> {
  const result = await pool.query<{ show_fallback_policy: StoredFallbackPolicy | null }>(
    `SELECT show_fallback_policy($1, $2) AS show_fallback_policy`,
    [tenantId, alias],
  );
  return result.rows[0]?.show_fallback_policy ?? null;
}

export async function setDeploymentContextLimit(
  pool: Pool,
  tenantId: string,
  name: string,
  limit: number,
): Promise<number> {
  const result = await pool.query<{ set_deployment_context_limit: number }>(
    `SELECT set_deployment_context_limit($1, $2, $3) AS set_deployment_context_limit`,
    [tenantId, name, limit],
  );
  const version = result.rows[0]?.set_deployment_context_limit;
  if (version === undefined) throw new Error('context limit was not stored');
  return version;
}

export async function setDeploymentDataCollection(
  pool: Pool,
  tenantId: string,
  name: string,
  value: string,
): Promise<number> {
  const result = await pool.query<{ set_deployment_data_collection: number }>(
    `SELECT set_deployment_data_collection($1, $2, $3) AS set_deployment_data_collection`,
    [tenantId, name, value],
  );
  const version = result.rows[0]?.set_deployment_data_collection;
  if (version === undefined) throw new Error('data handling was not stored');
  return version;
}
