import type { Pool } from 'pg';

export type InferenceListing = {
  streamingEnabled: boolean;
  connections: Array<{
    id: string;
    provider: string;
    enabled: boolean;
    credentialVersion: number;
    endpoint: string | null;
    workspaceId: string | null;
    createdAt: string;
  }>;
  deployments: Array<{
    id: string;
    connectionId: string;
    name: string;
    upstreamModel: string;
    timeoutMs: number;
    capabilities: string[];
    enabled: boolean;
    configVersion: number;
    defaultMaxOutputTokens: number | null;
    streamingEnabled: boolean;
    streamConnectTimeoutMs: number | null;
    streamIdleTimeoutMs: number | null;
    streamTotalTimeoutMs: number | null;
    streamBackpressureTimeoutMs: number | null;
    createdAt: string;
  }>;
  aliases: Array<{
    id: string;
    alias: string;
    deploymentId: string;
    createdAt: string;
  }>;
};

export async function registerOpenAiConnection(
  pool: Pool,
  tenantId: string,
  protectedCredential: string,
): Promise<{ connectionId: string; credentialVersion: number }> {
  const result = await pool.query<{ connection_id: string; credential_version: number }>(
    'SELECT connection_id, credential_version FROM register_openai_connection($1::uuid, $2)',
    [tenantId, protectedCredential],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('connection was not created');
  return { connectionId: row.connection_id, credentialVersion: row.credential_version };
}

export async function replaceOpenAiCredential(
  pool: Pool,
  tenantId: string,
  protectedCredential: string,
): Promise<number> {
  const result = await pool.query<{ version: number }>(
    'SELECT replace_openai_credential($1::uuid, $2) AS version',
    [tenantId, protectedCredential],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error('credential was not replaced');
  return version;
}

export async function setOpenAiConnectionEnabled(
  pool: Pool,
  tenantId: string,
  enabled: boolean,
): Promise<number> {
  const result = await pool.query<{ version: number }>(
    'SELECT set_openai_connection_enabled($1::uuid, $2) AS version',
    [tenantId, enabled],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error('connection was not updated');
  return version;
}

export async function registerAnthropicConnection(
  pool: Pool,
  tenantId: string,
  protectedCredential: string,
  endpoint: string,
  workspaceId: string | null,
): Promise<{ connectionId: string; credentialVersion: number }> {
  const result = await pool.query<{ connection_id: string; credential_version: number }>(
    'SELECT connection_id, credential_version FROM register_anthropic_connection($1::uuid, $2, $3, $4)',
    [tenantId, protectedCredential, endpoint, workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('connection was not created');
  return { connectionId: row.connection_id, credentialVersion: row.credential_version };
}

export async function replaceAnthropicCredential(
  pool: Pool,
  tenantId: string,
  protectedCredential: string,
): Promise<number> {
  const result = await pool.query<{ version: number }>(
    'SELECT replace_anthropic_credential($1::uuid, $2) AS version',
    [tenantId, protectedCredential],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error('credential was not replaced');
  return version;
}

export async function setProviderConnectionEnabled(
  pool: Pool,
  tenantId: string,
  provider: string,
  enabled: boolean,
): Promise<number> {
  const result = await pool.query<{ version: number }>(
    'SELECT set_provider_connection_enabled($1::uuid, $2, $3) AS version',
    [tenantId, provider, enabled],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error('connection was not updated');
  return version;
}

export async function registerProviderDeployment(
  pool: Pool,
  input: {
    tenantId: string;
    provider: string;
    name: string;
    upstreamModel: string;
    timeoutMs: number;
    capabilities: string[];
    enabled: boolean;
    defaultMaxOutputTokens: number | null;
  },
): Promise<{ deploymentId: string; configVersion: number }> {
  const result = await pool.query<{ deployment_id: string; config_version: number }>(
    `SELECT deployment_id, config_version
     FROM register_provider_deployment($1::uuid, $2, $3, $4, $5, $6::text[], $7, $8)`,
    [
      input.tenantId,
      input.provider,
      input.name,
      input.upstreamModel,
      input.timeoutMs,
      input.capabilities,
      input.enabled,
      input.defaultMaxOutputTokens,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('deployment was not created');
  return { deploymentId: row.deployment_id, configVersion: row.config_version };
}

export async function registerModelDeployment(
  pool: Pool,
  input: {
    tenantId: string;
    name: string;
    upstreamModel: string;
    timeoutMs: number;
    capabilities: string[];
    enabled: boolean;
  },
): Promise<{ deploymentId: string; configVersion: number }> {
  const result = await pool.query<{ deployment_id: string; config_version: number }>(
    `SELECT deployment_id, config_version
     FROM register_model_deployment($1::uuid, $2, $3, $4, $5::text[], $6)`,
    [input.tenantId, input.name, input.upstreamModel, input.timeoutMs, input.capabilities, input.enabled],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('deployment was not created');
  return { deploymentId: row.deployment_id, configVersion: row.config_version };
}

export async function setModelDeploymentEnabled(
  pool: Pool,
  tenantId: string,
  name: string,
  enabled: boolean,
): Promise<number> {
  const result = await pool.query<{ version: number }>(
    'SELECT set_model_deployment_enabled($1::uuid, $2, $3) AS version',
    [tenantId, name, enabled],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error('deployment was not updated');
  return version;
}

export async function setModelAlias(
  pool: Pool,
  tenantId: string,
  alias: string,
  deploymentName: string,
): Promise<string> {
  const result = await pool.query<{ alias_id: string }>(
    'SELECT set_model_alias($1::uuid, $2, $3) AS alias_id',
    [tenantId, alias, deploymentName],
  );
  const aliasId = result.rows[0]?.alias_id;
  if (aliasId === undefined) throw new Error('alias was not saved');
  return aliasId;
}

export async function setTenantStreamingEnabled(pool: Pool, tenantId: string, enabled: boolean): Promise<boolean> {
  const result = await pool.query<{ enabled: boolean }>(
    'SELECT set_tenant_streaming_enabled($1::uuid, $2) AS enabled',
    [tenantId, enabled],
  );
  const value = result.rows[0]?.enabled;
  if (value === undefined) throw new Error('tenant streaming was not updated');
  return value;
}

export async function setDeploymentStreaming(
  pool: Pool,
  input: {
    tenantId: string;
    name: string;
    enabled: boolean;
    connectTimeoutMs: number | null;
    idleTimeoutMs: number | null;
    totalTimeoutMs: number | null;
    backpressureTimeoutMs: number | null;
  },
): Promise<number> {
  const result = await pool.query<{ version: number }>(
    `SELECT set_deployment_streaming($1::uuid, $2, $3, $4, $5, $6, $7) AS version`,
    [
      input.tenantId,
      input.name,
      input.enabled,
      input.connectTimeoutMs,
      input.idleTimeoutMs,
      input.totalTimeoutMs,
      input.backpressureTimeoutMs,
    ],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error('deployment streaming was not updated');
  return version;
}

export async function listTenantInference(pool: Pool, tenantId: string): Promise<InferenceListing> {
  const result = await pool.query<{ listing: InferenceListing }>(
    'SELECT list_tenant_inference($1::uuid) AS listing',
    [tenantId],
  );
  const listing = result.rows[0]?.listing;
  if (listing === undefined) throw new Error('configuration was not listed');
  return listing;
}
