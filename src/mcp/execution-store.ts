import type { PoolClient } from 'pg';
import { mcpFailure } from './errors.js';
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy, type ToolEffect } from './govern.js';

export type ExecutionRow = {
  id: string;
  status: string;
  approval: string;
  inserted: boolean;
  effect: ToolEffect;
  namespacedName: string;
  schemaVersion: number;
  requestId: string;
  toolCallId: string;
  identityExpiresAt: string | null;
  dispatchCount: number;
  modelRequests: number;
  latencyMs: number | null;
  outcome: string | null;
  errorCode: number | null;
  errorMessage: string | null;
  remoteName: string;
  serverId: string;
  timeoutMs: number;
  loopDepth: number;
  idempotent: boolean;
  costUnits: number;
  permission: boolean;
  createdAt: string | null;
  finishedAt: string | null;
};

export type DecisionRow = ExecutionRow & { action: 'granted' | 'denied' | 'cancelled' | 'replayed' };

type ReserveSql = {
  id: string;
  status: string;
  approval: string;
  inserted: boolean;
  effect: ToolEffect;
  namespaced_name: string;
  schema_version: number;
  request_id: string;
  tool_call_id: string;
  identity_expires_at: Date | null;
  dispatch_count: number;
  model_requests: number;
  latency_ms: number | null;
  outcome: string | null;
  error_code: number | null;
  error_message: string | null;
  remote_name: string;
  server_id: string;
  timeout_ms: number;
  loop_depth: number;
  idempotent: boolean;
  cost_units: number;
};

type ListedSql = {
  id: string;
  server_id: string;
  remote_name: string;
  namespaced_name: string;
  schema_version: number;
  request_id: string;
  tool_call_id: string;
  effect: ToolEffect;
  idempotent: boolean;
  status: string;
  approval: string;
  loop_depth: number;
  cost_units: number;
  timeout_ms: number;
  latency_ms: number | null;
  dispatch_count: number;
  model_requests: number;
  outcome: string | null;
  error_code: number | null;
  error_message: string | null;
  created_at: Date;
  finished_at: Date | null;
  allowed: boolean | null;
};

function raiseDatabase(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('tool is not approved') || message.includes('permission is invalid')) {
    throw mcpFailure('rejected', 'The tool is not approved.');
  }
  if (message.includes('tool was not found') || message.includes('tool name is invalid')) {
    throw mcpFailure('not_found', 'The tool was not found.');
  }
  if (message.includes('schema version does not match')) throw mcpFailure('conflict', 'The schema version does not match.');
  if (message.includes('tool call does not belong')) throw mcpFailure('conflict', 'The tool call does not belong to the request.');
  if (message.includes('credential is revoked')) throw mcpFailure('rejected', 'The credential is revoked.');
  if (message.includes('server is not approved')) throw mcpFailure('rejected', 'The server is not approved.');
  if (message.includes('server is missing')) throw mcpFailure('not_found', 'The server was not found.');
  if (message.includes('concurrency limit is reached')) throw mcpFailure('limit', 'The concurrency limit is reached.');
  if (message.includes('cost limit is reached')) throw mcpFailure('limit', 'The cost limit is reached.');
  if (message.includes('tool loop is too deep')) throw mcpFailure('limit', 'The tool loop is too deep.');
  if (message.includes('execution identity expired')) throw mcpFailure('rejected', 'The execution identity expired.');
  if (message.includes('execution identity is invalid')) throw mcpFailure('rejected', 'The execution identity is invalid.');
  if (message.includes('execution was not found')) throw mcpFailure('not_found', 'The execution was not found.');
  if (message.includes('request is invalid')) throw mcpFailure('invalid', 'The request is invalid.');
  throw error;
}

function asIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asEvidence(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') return null;
  return value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'utf8');
}

function fromReserve(row: ReserveSql): ExecutionRow {
  return {
    id: row.id,
    status: row.status,
    approval: row.approval,
    inserted: row.inserted,
    effect: row.effect,
    namespacedName: row.namespaced_name,
    schemaVersion: row.schema_version,
    requestId: row.request_id,
    toolCallId: row.tool_call_id,
    identityExpiresAt: asIso(row.identity_expires_at),
    dispatchCount: row.dispatch_count,
    modelRequests: row.model_requests,
    latencyMs: row.latency_ms,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    remoteName: row.remote_name,
    serverId: row.server_id,
    timeoutMs: row.timeout_ms,
    loopDepth: row.loop_depth,
    idempotent: row.idempotent,
    costUnits: row.cost_units,
    permission: true,
    createdAt: null,
    finishedAt: null,
  };
}

function fromListed(row: ListedSql): ExecutionRow {
  return {
    id: row.id,
    status: row.status,
    approval: row.approval,
    inserted: false,
    effect: row.effect,
    namespacedName: row.namespaced_name,
    schemaVersion: row.schema_version,
    requestId: row.request_id,
    toolCallId: row.tool_call_id,
    identityExpiresAt: null,
    dispatchCount: row.dispatch_count,
    modelRequests: row.model_requests,
    latencyMs: row.latency_ms,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    remoteName: row.remote_name,
    serverId: row.server_id,
    timeoutMs: row.timeout_ms,
    loopDepth: row.loop_depth,
    idempotent: row.idempotent,
    costUnits: row.cost_units,
    permission: row.allowed === true,
    createdAt: asIso(row.created_at),
    finishedAt: asIso(row.finished_at),
  };
}

const LIST_SQL = `
  SELECT execution.id, execution.server_id, execution.remote_name, execution.namespaced_name,
         execution.schema_version, execution.request_id, execution.tool_call_id, execution.effect,
         execution.idempotent, execution.status, execution.approval, execution.loop_depth,
         execution.cost_units, execution.timeout_ms, execution.latency_ms, execution.dispatch_count,
         execution.model_requests, execution.outcome, execution.error_code, execution.error_message,
         execution.created_at, execution.finished_at, permission.allowed
  FROM mcp_tool_executions AS execution
  LEFT JOIN mcp_tool_permissions AS permission
    ON permission.tenant_id = execution.tenant_id
   AND permission.server_id = execution.server_id
   AND permission.remote_name = execution.remote_name
`;

export async function readExecutionPolicy(client: PoolClient): Promise<ExecutionPolicy> {
  const result = await client.query<{
    write_approval: 'required';
    max_concurrent: number;
    timeout_ms: number;
    max_cost_units: number;
    max_loop_depth: number;
    identity_ttl_ms: number;
    model_followup: boolean;
  }>(
    `SELECT write_approval, max_concurrent, timeout_ms, max_cost_units, max_loop_depth, identity_ttl_ms, model_followup
     FROM mcp_execution_policy`,
  );
  const row = result.rows[0];
  if (row === undefined) return { ...DEFAULT_EXECUTION_POLICY };
  return {
    writeApproval: 'required',
    maxConcurrent: row.max_concurrent,
    timeoutMs: row.timeout_ms,
    maxCostUnits: row.max_cost_units,
    maxLoopDepth: row.max_loop_depth,
    identityTtlMs: row.identity_ttl_ms,
    modelFollowup: row.model_followup,
  };
}

export async function writeExecutionPolicy(client: PoolClient, tenantId: string, policy: ExecutionPolicy): Promise<void> {
  try {
    await client.query(
      `SELECT set_mcp_execution_policy($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [tenantId, policy.maxConcurrent, policy.timeoutMs, policy.maxCostUnits, policy.maxLoopDepth, policy.identityTtlMs, policy.modelFollowup],
    );
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function classifyMcpTool(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  remoteName: string,
  allowed: boolean,
  effect: ToolEffect,
): Promise<void> {
  try {
    await client.query(`SELECT classify_mcp_tool($1::uuid, $2::uuid, $3, $4, $5)`, [
      tenantId,
      serverId,
      remoteName,
      allowed,
      effect,
    ]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function revokeMcpCredential(client: PoolClient, tenantId: string, serverId: string): Promise<void> {
  try {
    await client.query(`SELECT revoke_mcp_credential($1::uuid, $2::uuid)`, [tenantId, serverId]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function reserveExecution(
  client: PoolClient,
  tenantId: string,
  input: {
    id: string;
    serverId: string;
    remoteName: string;
    schemaVersion: number;
    requestId: string;
    toolCallId: string;
    argumentHash: string;
    identityHash: string;
    identityExpiresAt: string;
    depth: number;
    parentExecutionId: string | null;
    costUnits: number;
    now: string;
    evidence: Buffer;
  },
): Promise<ExecutionRow> {
  try {
    const result = await client.query<ReserveSql>(
      `SELECT * FROM reserve_mcp_execution(
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12::uuid, $13, $14::timestamptz, $15::bytea
      )`,
      [
        tenantId,
        input.id,
        input.serverId,
        input.remoteName,
        input.schemaVersion,
        input.requestId,
        input.toolCallId,
        input.argumentHash,
        input.identityHash,
        input.identityExpiresAt,
        input.depth,
        input.parentExecutionId,
        input.costUnits,
        input.now,
        input.evidence,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw mcpFailure('invalid', 'The request is invalid.');
    return fromReserve(row);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function claimDispatch(client: PoolClient, tenantId: string, id: string, now: string): Promise<boolean> {
  try {
    const result = await client.query<{ claim_mcp_dispatch: boolean }>(
      `SELECT claim_mcp_dispatch($1::uuid, $2::uuid, $3::timestamptz)`,
      [tenantId, id, now],
    );
    return result.rows[0]?.claim_mcp_dispatch === true;
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function finishExecution(
  client: PoolClient,
  tenantId: string,
  input: {
    id: string;
    status: 'succeeded' | 'failed' | 'uncertain';
    outcome: 'result' | 'error' | 'uncertain';
    latencyMs: number;
    errorCode: number | null;
    errorMessage: string | null;
    evidence: Buffer;
    now: string;
  },
): Promise<boolean> {
  try {
    const result = await client.query<{ finish_mcp_execution: boolean }>(
      `SELECT finish_mcp_execution($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::bytea, $9::timestamptz)`,
      [tenantId, input.id, input.status, input.outcome, input.latencyMs, input.errorCode, input.errorMessage, input.evidence, input.now],
    );
    return result.rows[0]?.finish_mcp_execution === true;
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function stopExecution(client: PoolClient, tenantId: string, id: string, message: string, now: string): Promise<void> {
  try {
    await client.query(`SELECT stop_mcp_execution($1::uuid, $2::uuid, $3, $4::timestamptz)`, [tenantId, id, message, now]);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function recoverExecutions(client: PoolClient, tenantId: string, now: string): Promise<number> {
  try {
    const result = await client.query<{ recover_mcp_executions: number }>(
      `SELECT recover_mcp_executions($1::uuid, $2::timestamptz)`,
      [tenantId, now],
    );
    return result.rows[0]?.recover_mcp_executions ?? 0;
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function decideExecution(
  client: PoolClient,
  tenantId: string,
  id: string,
  identityHash: string,
  decision: 'grant' | 'deny' | 'cancel',
  now: string,
): Promise<DecisionRow> {
  try {
    const result = await client.query<ReserveSql & { action: DecisionRow['action'] }>(
      `SELECT * FROM decide_mcp_execution($1::uuid, $2::uuid, $3, $4, $5::timestamptz)`,
      [tenantId, id, identityHash, decision, now],
    );
    const row = result.rows[0];
    if (row === undefined) throw mcpFailure('not_found', 'The execution was not found.');
    return { ...fromReserve(row), action: row.action, inserted: false };
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function recordModelRequest(client: PoolClient, tenantId: string, id: string): Promise<number> {
  try {
    const result = await client.query<{ record_mcp_model_request: number }>(
      `SELECT record_mcp_model_request($1::uuid, $2::uuid)`,
      [tenantId, id],
    );
    return result.rows[0]?.record_mcp_model_request ?? 0;
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function loadExecutionEvidence(client: PoolClient, tenantId: string, id: string): Promise<Buffer | null> {
  try {
    const result = await client.query<{ load_mcp_execution_evidence: Buffer | null }>(
      `SELECT load_mcp_execution_evidence($1::uuid, $2::uuid)`,
      [tenantId, id],
    );
    return asEvidence(result.rows[0]?.load_mcp_execution_evidence);
  } catch (error) {
    raiseDatabase(error);
  }
}

export async function listExecutions(client: PoolClient): Promise<ExecutionRow[]> {
  const result = await client.query<ListedSql>(`${LIST_SQL} ORDER BY execution.created_at DESC LIMIT 50`);
  return result.rows.map(fromListed);
}

export async function readExecution(client: PoolClient, id: string): Promise<ExecutionRow | null> {
  const result = await client.query<ListedSql>(`${LIST_SQL} WHERE execution.id = $1::uuid`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : fromListed(row);
}
