import type { PoolClient } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { catalogFingerprint, type FingerprintTool } from './fingerprint.js';
import { mcpFailure } from './errors.js';
import type { CatalogTool } from './discover.js';

export type McpServerRow = {
  id: string;
  serverKey: string;
  displayName: string;
  endpoint: string;
  protocolMode: 'modern' | 'legacy';
  protocolVersion: string | null;
  connectionStatus: 'unknown' | 'ok' | 'failed' | 'mismatch';
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  catalogFingerprint: string | null;
  catalogCachedAt: string | null;
  ttlMs: number | null;
  cacheScope: 'public' | 'private' | null;
  catalogVersion: number;
  cacheAgeMs: number | null;
  credentialState: 'active' | 'revoked';
};

export type McpToolRow = {
  id: string;
  serverId: string;
  serverKey: string;
  remoteName: string;
  namespacedName: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  catalogVersion: number;
  allowed: boolean;
  protocolVersion: string | null;
  fingerprint: string | null;
  cacheAgeMs: number | null;
  ttlMs: number | null;
  cacheScope: 'public' | 'private' | null;
  effect: 'read' | 'write' | null;
};

type ServerSql = {
  id: string;
  server_key: string;
  display_name: string;
  endpoint: string;
  protocol_mode: 'modern' | 'legacy';
  protocol_version: string | null;
  connection_status: 'unknown' | 'ok' | 'failed' | 'mismatch';
  enabled: boolean;
  last_checked_at: Date | null;
  last_error: string | null;
  catalog_fingerprint: string | null;
  catalog_cached_at: Date | null;
  ttl_ms: number | null;
  cache_scope: 'public' | 'private' | null;
  catalog_version: number;
  credential_state: 'active' | 'revoked';
};

const SERVER_COLUMNS = `
  id, server_key, display_name, endpoint, protocol_mode, protocol_version,
  connection_status, enabled, last_checked_at, last_error, catalog_fingerprint,
  catalog_cached_at, ttl_ms, cache_scope, catalog_version, credential_state
`;

function cacheAge(cachedAt: Date | null, now: number): number | null {
  if (cachedAt === null) return null;
  return Math.max(0, now - cachedAt.getTime());
}

function toServer(row: ServerSql, now: number): McpServerRow {
  return {
    id: row.id,
    serverKey: row.server_key,
    displayName: row.display_name,
    endpoint: row.endpoint,
    protocolMode: row.protocol_mode,
    protocolVersion: row.protocol_version,
    connectionStatus: row.connection_status,
    enabled: row.enabled,
    lastCheckedAt: row.last_checked_at === null ? null : row.last_checked_at.toISOString(),
    lastError: row.last_error,
    catalogFingerprint: row.catalog_fingerprint,
    catalogCachedAt: row.catalog_cached_at === null ? null : row.catalog_cached_at.toISOString(),
    ttlMs: row.ttl_ms,
    cacheScope: row.cache_scope,
    catalogVersion: row.catalog_version,
    cacheAgeMs: cacheAge(row.catalog_cached_at, now),
    credentialState: row.credential_state,
  };
}

function raiseDatabase(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  if (code === '23505') throw mcpFailure('invalid', 'The server name is already registered.');
  if (code === '23514' && message.includes('namespaced')) throw mcpFailure('invalid', 'The tool name is invalid.');
  if (message.includes('server is missing')) throw mcpFailure('invalid', 'The server was not found.');
  if (message.includes('server name is invalid')) throw mcpFailure('invalid', 'The server name is invalid.');
  if (message.includes('display name is invalid')) throw mcpFailure('invalid', 'The display name is invalid.');
  if (message.includes('endpoint is not allowed')) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (message.includes('credential is invalid')) throw mcpFailure('invalid', 'The credential is invalid.');
  if (message.includes('protocol mode is invalid')) throw mcpFailure('invalid', 'The protocol mode is invalid.');
  if (message.includes('tool name is invalid')) throw mcpFailure('invalid', 'The tool name is invalid.');
  if (message.includes('tool description is invalid')) throw mcpFailure('invalid', 'The tool description is invalid.');
  if (message.includes('tool schema is invalid')) throw mcpFailure('schema', 'The tool schema is invalid.');
  if (message.includes('catalog is too large')) throw mcpFailure('large', 'The catalog is too large.');
  if (message.includes('tenant mismatch')) throw mcpFailure('rejected', 'The server was not found.');
  throw error;
}

export function protectCredential(store: ProviderCredentialStore, secret: string): string {
  try {
    return store.protect(secret);
  } catch {
    throw mcpFailure('invalid', 'The credential is invalid.');
  }
}

export async function registerMcpServer(
  client: PoolClient,
  tenantId: string,
  input: {
    serverKey: string;
    displayName: string;
    endpoint: string;
    credentialRef: string;
    protocolMode: 'modern' | 'legacy';
    enabled: boolean;
  },
): Promise<string> {
  try {
    const result = await client.query<{ id: string }>(
      `SELECT register_mcp_server($1::uuid, $2, $3, $4, $5, $6, $7) AS id`,
      [tenantId, input.serverKey, input.displayName, input.endpoint, input.credentialRef, input.protocolMode, input.enabled],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw mcpFailure('invalid', 'The server was not found.');
    return id;
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function replaceMcpCredential(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  credentialRef: string,
): Promise<void> {
  try {
    await client.query(`SELECT replace_mcp_credential($1::uuid, $2::uuid, $3)`, [tenantId, serverId, credentialRef]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function setMcpServerEnabled(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  enabled: boolean,
): Promise<void> {
  try {
    await client.query(`SELECT set_mcp_server_enabled($1::uuid, $2::uuid, $3)`, [tenantId, serverId, enabled]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function recordMcpConnection(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  status: 'ok' | 'failed' | 'mismatch',
  protocolVersion: string | null,
  errorText: string | null,
): Promise<void> {
  try {
    await client.query(`SELECT record_mcp_connection($1::uuid, $2::uuid, $3, $4, $5)`, [
      tenantId,
      serverId,
      status,
      protocolVersion,
      errorText,
    ]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function loadMcpCredential(client: PoolClient, tenantId: string, serverId: string): Promise<string | null> {
  try {
    const result = await client.query<{ credential: string | null }>(
      `SELECT load_mcp_credential($1::uuid, $2::uuid) AS credential`,
      [tenantId, serverId],
    );
    return result.rows[0]?.credential ?? null;
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function setMcpToolPermission(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  remoteName: string,
  allowed: boolean,
): Promise<void> {
  try {
    await client.query(`SELECT set_mcp_tool_permission($1::uuid, $2::uuid, $3, $4)`, [
      tenantId,
      serverId,
      remoteName,
      allowed,
    ]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function storeMcpCatalog(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  input: {
    protocolVersion: string;
    ttlMs: number;
    cacheScope: 'public' | 'private';
    tools: readonly CatalogTool[];
  },
): Promise<{ catalogVersion: number; changed: boolean; fingerprint: string }> {
  const fingerprint = catalogFingerprint(input.tools as readonly FingerprintTool[]);
  try {
    const result = await client.query<{ catalog_version: number; changed: boolean }>(
      `SELECT catalog_version, changed
       FROM store_mcp_catalog($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
      [
        tenantId,
        serverId,
        fingerprint,
        input.ttlMs,
        input.cacheScope,
        input.protocolVersion,
        JSON.stringify(input.tools),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw mcpFailure('invalid', 'The server was not found.');
    return { catalogVersion: row.catalog_version, changed: row.changed, fingerprint };
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function listMcpServers(client: PoolClient, now: number): Promise<McpServerRow[]> {
  const result = await client.query<ServerSql>(
    `SELECT ${SERVER_COLUMNS} FROM mcp_servers ORDER BY server_key`,
  );
  return result.rows.map((row) => toServer(row, now));
}

export async function readMcpServer(client: PoolClient, serverId: string, now: number): Promise<McpServerRow | null> {
  const result = await client.query<ServerSql>(
    `SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE id = $1::uuid`,
    [serverId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toServer(row, now);
}

type ToolSql = {
  id: string;
  server_id: string;
  server_key: string;
  remote_name: string;
  namespaced_name: string;
  description: string;
  input_schema: unknown;
  output_schema: unknown;
  catalog_version: number;
  allowed: boolean | null;
  protocol_version: string | null;
  catalog_fingerprint: string | null;
  catalog_cached_at: Date | null;
  ttl_ms: number | null;
  cache_scope: 'public' | 'private' | null;
  enabled: boolean;
  effect: 'read' | 'write' | null;
};

function toTool(row: ToolSql, now: number): McpToolRow {
  return {
    id: row.id,
    serverId: row.server_id,
    serverKey: row.server_key,
    remoteName: row.remote_name,
    namespacedName: row.namespaced_name,
    description: row.description,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    catalogVersion: row.catalog_version,
    allowed: row.allowed === true,
    protocolVersion: row.protocol_version,
    fingerprint: row.catalog_fingerprint,
    cacheAgeMs: cacheAge(row.catalog_cached_at, now),
    ttlMs: row.ttl_ms,
    cacheScope: row.cache_scope,
    effect: row.effect,
  };
}

const TOOL_SQL = `
  SELECT definition.id, definition.server_id, server.server_key, definition.remote_name,
         definition.namespaced_name, definition.description, definition.input_schema,
         definition.output_schema, definition.catalog_version, permission.allowed,
         server.protocol_version, server.catalog_fingerprint, server.catalog_cached_at,
         server.ttl_ms, server.cache_scope, server.enabled, permission.effect
  FROM mcp_tool_definitions AS definition
  JOIN mcp_servers AS server
    ON server.tenant_id = definition.tenant_id
   AND server.id = definition.server_id
  LEFT JOIN mcp_tool_permissions AS permission
    ON permission.tenant_id = definition.tenant_id
   AND permission.server_id = definition.server_id
   AND permission.remote_name = definition.remote_name
  WHERE definition.catalog_version = server.catalog_version
`;

export async function listServerTools(client: PoolClient, serverId: string, now: number): Promise<McpToolRow[]> {
  const result = await client.query<ToolSql>(`${TOOL_SQL} AND definition.server_id = $1::uuid ORDER BY definition.namespaced_name`, [
    serverId,
  ]);
  return result.rows.map((row) => toTool(row, now));
}

export async function listExposedCatalog(client: PoolClient, now: number): Promise<McpToolRow[]> {
  const result = await client.query<ToolSql>(
    `${TOOL_SQL} AND server.enabled = true AND permission.allowed = true ORDER BY definition.namespaced_name`,
  );
  return result.rows.map((row) => toTool(row, now));
}
