import type { Pool } from 'pg';

export type InferenceListing = {
  streamingEnabled: boolean;
  connections: Array<{
    id: string;
    provider: string;
    enabled: boolean;
    credentialVersion: number;
    configVersion: number;
    authMode: string;
    endpoint: string | null;
    workspaceId: string | null;
    projectId: string | null;
    location: string | null;
    serviceAccountIdentity: string | null;
    apiVersion: string;
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
    validationStatus: string;
    healthStatus: string;
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

export async function registerOpenRouterDeployment(
  pool: Pool,
  input: {
    tenantId: string;
    name: string;
    upstreamModel: string;
    timeoutMs: number;
    capabilities: string[];
    enabled: boolean;
    downstreamProviders: string[] | null;
    dataCollection: 'allow' | 'deny' | null;
    allowFallbacks: boolean | null;
    requireServingProvider: boolean;
  },
): Promise<{ deploymentId: string; configVersion: number }> {
  const result = await pool.query<{ deployment_id: string; config_version: number }>(
    `SELECT deployment_id, config_version
     FROM register_openrouter_deployment($1::uuid, $2, $3, $4, $5::text[], $6, $7::text[], $8, $9, $10)`,
    [
      input.tenantId,
      input.name,
      input.upstreamModel,
      input.timeoutMs,
      input.capabilities,
      input.enabled,
      input.downstreamProviders,
      input.dataCollection,
      input.allowFallbacks,
      input.requireServingProvider,
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

export async function registerRegistryConnection(
  pool: Pool,
  input: {
    tenantId: string;
    provider: string;
    protectedCredential: string | null;
    authMode: string;
    endpoint: string | null;
    projectId: string | null;
    location: string | null;
    serviceAccountIdentity?: string | null;
    apiVersion?: 'v1' | 'v1beta1';
  },
): Promise<{ connectionId: string; credentialVersion: number; configVersion: number }> {
  const result = await pool.query<{ connection_id: string; credential_version: number; config_version: number }>(
    `SELECT connection_id, credential_version, config_version
     FROM register_registry_connection($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId,
      input.provider,
      input.protectedCredential,
      input.authMode,
      input.endpoint,
      input.projectId,
      input.location,
      input.serviceAccountIdentity ?? null,
      input.apiVersion ?? 'v1',
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('connection was not created');
  return {
    connectionId: row.connection_id,
    credentialVersion: row.credential_version,
    configVersion: row.config_version,
  };
}

export async function setDeploymentValidation(
  pool: Pool,
  tenantId: string,
  name: string,
  status: string,
): Promise<{ configVersion: number; validationStatus: string; healthStatus: string }> {
  const result = await pool.query<{ config_version: number; validation_status: string; health_status: string }>(
    'SELECT config_version, validation_status, health_status FROM set_deployment_validation($1::uuid, $2, $3)',
    [tenantId, name, status],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('deployment was not updated');
  return {
    configVersion: row.config_version,
    validationStatus: row.validation_status,
    healthStatus: row.health_status,
  };
}

export async function setDeploymentHealth(
  pool: Pool,
  tenantId: string,
  name: string,
  status: string,
): Promise<{ configVersion: number; validationStatus: string; healthStatus: string }> {
  const result = await pool.query<{ config_version: number; validation_status: string; health_status: string }>(
    'SELECT config_version, validation_status, health_status FROM set_deployment_health($1::uuid, $2, $3)',
    [tenantId, name, status],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('deployment was not updated');
  return {
    configVersion: row.config_version,
    validationStatus: row.validation_status,
    healthStatus: row.health_status,
  };
}

export type VertexOperatorConnection = {
  connectionId: string;
  projectId: string;
  location: string;
  authMode: string;
  serviceAccountIdentity: string | null;
  apiVersion: string;
  configVersion: number;
  credentialVersion: number;
  protectedCredential: string | null;
  enabled: boolean;
};

export async function loadVertexOperatorConnection(pool: Pool, tenantId: string): Promise<VertexOperatorConnection | null> {
  const result = await pool.query<{
    connection_id: string;
    project_id: string;
    location: string;
    auth_mode: string;
    service_account_identity: string | null;
    api_version: string;
    config_version: number;
    credential_version: number;
    protected_credential: string | null;
    enabled: boolean;
  }>('SELECT * FROM load_vertex_operator_connection($1::uuid)', [tenantId]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    connectionId: row.connection_id,
    projectId: row.project_id,
    location: row.location,
    authMode: row.auth_mode,
    serviceAccountIdentity: row.service_account_identity,
    apiVersion: row.api_version,
    configVersion: row.config_version,
    credentialVersion: row.credential_version,
    protectedCredential: row.protected_credential,
    enabled: row.enabled,
  };
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
