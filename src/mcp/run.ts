import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import {
  SAMPLE_SCHEMA_VERSION,
  decryptSample,
  encryptSample,
  type EncryptedEnvelope,
  type SampleKeyManager,
} from '../inference/sample-crypto.js';
import { assertResolvableEndpoint, parseApprovedEndpoint } from './endpoint.js';
import { McpDispatchAbort, dispatchApprovedTool } from './execute.js';
import {
  claimDispatch,
  decideExecution,
  finishExecution,
  listExecutions,
  loadExecutionEvidence,
  readExecution,
  readExecutionPolicy,
  recordModelRequest,
  recoverExecutions,
  reserveExecution,
  stopExecution,
  writeExecutionPolicy,
  type ExecutionRow,
} from './execution-store.js';
import { McpFailure, mcpFailure } from './errors.js';
import {
  argumentDigest,
  assertCompleteArguments,
  commandsFromDescription,
  identityDigest,
  mintExecutionIdentity,
  scrubSecret,
  type ExecutionPolicy,
  type ExecutionRequest,
} from './govern.js';
import { loadMcpCredential, listServerTools, readMcpServer } from './store.js';

export type ExecutionDeps = {
  runtimePool: Pool;
  credentialStore: ProviderCredentialStore | null;
  sampleKeyManager: SampleKeyManager | null;
  now: () => number;
  fetchImpl?: typeof fetch;
  abortAfterDispatch?: () => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stamp(now: number): string {
  return new Date(now).toISOString();
}

function packEvidence(manager: SampleKeyManager | null, tenantId: string, id: string, payload: unknown): Buffer {
  const envelope = encryptSample(manager, {
    tenantId,
    sampleId: id,
    schemaVersion: SAMPLE_SCHEMA_VERSION,
    payload,
  });
  if (envelope === null) throw mcpFailure('invalid', 'The execution evidence cannot be stored.');
  return Buffer.from(
    JSON.stringify({
      schemaVersion: envelope.schemaVersion,
      wrappingKeyVersion: envelope.wrappingKeyVersion,
      wrappedKeyIv: envelope.wrappedKeyIv.toString('base64'),
      wrappedKeyTag: envelope.wrappedKeyTag.toString('base64'),
      wrappedKeyCiphertext: envelope.wrappedKeyCiphertext.toString('base64'),
      contentIv: envelope.contentIv.toString('base64'),
      contentTag: envelope.contentTag.toString('base64'),
      contentCiphertext: envelope.contentCiphertext.toString('base64'),
    }),
  );
}

function unpackEvidence(manager: SampleKeyManager | null, tenantId: string, id: string, packed: Buffer | null): unknown {
  if (manager === null || packed === null) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(packed.toString('utf8')) as unknown;
    if (!isRecord(value)) return null;
    parsed = value;
  } catch {
    return null;
  }
  const envelope: EncryptedEnvelope = {
    schemaVersion: Number(parsed.schemaVersion),
    wrappingKeyVersion: Number(parsed.wrappingKeyVersion),
    wrappedKeyIv: Buffer.from(String(parsed.wrappedKeyIv), 'base64'),
    wrappedKeyTag: Buffer.from(String(parsed.wrappedKeyTag), 'base64'),
    wrappedKeyCiphertext: Buffer.from(String(parsed.wrappedKeyCiphertext), 'base64'),
    contentIv: Buffer.from(String(parsed.contentIv), 'base64'),
    contentTag: Buffer.from(String(parsed.contentTag), 'base64'),
    contentCiphertext: Buffer.from(String(parsed.contentCiphertext), 'base64'),
  };
  return decryptSample(manager, { tenantId, sampleId: id, schemaVersion: envelope.schemaVersion }, envelope);
}

function storedResult(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.result)) return null;
  return payload.result;
}

export function executionView(
  row: ExecutionRow,
  result: Record<string, unknown> | null,
  toolCalls: number,
): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    approval: row.approval,
    effect: row.effect,
    namespacedName: row.namespacedName,
    schemaVersion: row.schemaVersion,
    requestId: row.requestId,
    toolCallId: row.toolCallId,
    permission: row.permission ? 'allowed' : 'denied',
    latencyMs: row.latencyMs,
    dispatchCount: row.dispatchCount,
    modelRequests: row.modelRequests,
    outcome: row.outcome,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    idempotent: row.idempotent,
    loopDepth: row.loopDepth,
    result,
    toolCalls,
  };
}

async function savedResult(deps: ExecutionDeps, tenantId: string, row: ExecutionRow): Promise<Record<string, unknown> | null> {
  if (row.outcome !== 'result') return null;
  const packed = await withTenant(deps.runtimePool, tenantId, (client) => loadExecutionEvidence(client, tenantId, row.id));
  return storedResult(unpackEvidence(deps.sampleKeyManager, tenantId, row.id, packed));
}

async function openCredential(deps: ExecutionDeps, tenantId: string, serverId: string): Promise<string> {
  if (deps.credentialStore === null) throw mcpFailure('invalid', 'The credential is invalid.');
  const store = deps.credentialStore;
  const protectedRef = await withTenant(deps.runtimePool, tenantId, (client) => loadMcpCredential(client, tenantId, serverId));
  if (protectedRef === null) throw mcpFailure('invalid', 'The credential is invalid.');
  try {
    return store.open(protectedRef);
  } catch {
    throw mcpFailure('invalid', 'The credential is invalid.');
  }
}

async function currentRow(deps: ExecutionDeps, tenantId: string, id: string): Promise<ExecutionRow> {
  const row = await withTenant(deps.runtimePool, tenantId, (client) => readExecution(client, id));
  if (row === null) throw mcpFailure('not_found', 'The execution was not found.');
  return row;
}

async function dispatchReserved(
  deps: ExecutionDeps,
  tenantId: string,
  row: ExecutionRow,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
  description: string,
  endpoint: URL,
  credential: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const claimed = await withTenant(deps.runtimePool, tenantId, (client) => claimDispatch(client, tenantId, row.id, stamp(deps.now())));
  if (!claimed) {
    const server = await withTenant(deps.runtimePool, tenantId, (client) => readMcpServer(client, row.serverId, deps.now()));
    if (server?.credentialState === 'revoked') {
      await withTenant(deps.runtimePool, tenantId, (client) =>
        stopExecution(client, tenantId, row.id, 'The credential is revoked.', stamp(deps.now())),
      );
    }
    const current = await currentRow(deps, tenantId, row.id);
    const result = await savedResult(deps, tenantId, current);
    return {
      statusCode: current.dispatchCount > 0 ? 409 : 400,
      body: { execution: executionView(current, result, 0), replayed: current.dispatchCount > 0 },
    };
  }
  const started = deps.now();
  const evidencePayload = { arguments: scrubSecret(args, credential), result: null, protocolError: null };
  try {
    const dispatched = await dispatchApprovedTool({
      endpoint,
      credential,
      remoteName: row.remoteName,
      description,
      inputSchema: schema,
      arguments: args,
      timeoutMs: row.timeoutMs,
      fetchImpl: deps.fetchImpl,
      abortAfterDispatch: deps.abortAfterDispatch?.() === true,
    });
    const latencyMs = Math.max(0, deps.now() - started);
    if (dispatched.uncertain || dispatched.toolCalls !== 1) {
      await withTenant(deps.runtimePool, tenantId, (client) =>
        finishExecution(client, tenantId, {
          id: row.id,
          status: 'uncertain',
          outcome: 'uncertain',
          latencyMs,
          errorCode: null,
          errorMessage: 'The execution outcome is uncertain.',
          evidence: packEvidence(deps.sampleKeyManager, tenantId, row.id, evidencePayload),
          now: stamp(deps.now()),
        }),
      );
      const current = await currentRow(deps, tenantId, row.id);
      return { statusCode: 200, body: { execution: executionView(current, null, dispatched.toolCalls), replayed: false } };
    }
    if (dispatched.protocolError !== null) {
      const scrubbedMessage = scrubSecret(dispatched.protocolError.message, credential);
      const protocolError = {
        code: dispatched.protocolError.code,
        message: typeof scrubbedMessage === 'string' ? scrubbedMessage : dispatched.protocolError.message,
      };
      const errorMessage = protocolError.message.slice(0, 200);
      await withTenant(deps.runtimePool, tenantId, (client) =>
        finishExecution(client, tenantId, {
          id: row.id,
          status: 'failed',
          outcome: 'error',
          latencyMs,
          errorCode: dispatched.protocolError?.code ?? null,
          errorMessage,
          evidence: packEvidence(deps.sampleKeyManager, tenantId, row.id, { ...evidencePayload, protocolError }),
          now: stamp(deps.now()),
        }),
      );
      const current = await currentRow(deps, tenantId, row.id);
      return {
        statusCode: 200,
        body: { execution: executionView(current, null, dispatched.toolCalls), protocolError, replayed: false },
      };
    }
    const result = scrubSecret(dispatched.result, credential);
    await withTenant(deps.runtimePool, tenantId, (client) =>
      finishExecution(client, tenantId, {
        id: row.id,
        status: 'succeeded',
        outcome: 'result',
        latencyMs,
        errorCode: null,
        errorMessage: null,
        evidence: packEvidence(deps.sampleKeyManager, tenantId, row.id, { ...evidencePayload, result }),
        now: stamp(deps.now()),
      }),
    );
    const current = await currentRow(deps, tenantId, row.id);
    return {
      statusCode: 200,
      body: {
        execution: executionView(current, isRecord(result) ? result : null, dispatched.toolCalls),
        replayed: false,
        modelRequests: 0,
      },
    };
  } catch (error) {
    if (error instanceof McpDispatchAbort) throw error;
    const latencyMs = Math.max(0, deps.now() - started);
    const known = error instanceof McpFailure;
    await withTenant(deps.runtimePool, tenantId, (client) =>
      finishExecution(client, tenantId, {
        id: row.id,
        status: known ? 'failed' : 'uncertain',
        outcome: known ? 'error' : 'uncertain',
        latencyMs,
        errorCode: null,
        errorMessage: known ? error.message.slice(0, 200) : 'The execution outcome is uncertain.',
        evidence: packEvidence(deps.sampleKeyManager, tenantId, row.id, evidencePayload),
        now: stamp(deps.now()),
      }),
    ).catch(() => undefined);
    throw error;
  }
}

export async function executeManagedTool(
  deps: ExecutionDeps,
  tenantId: string,
  request: ExecutionRequest,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const prepared = await withTenant(deps.runtimePool, tenantId, async (client) => {
    const server = await readMcpServer(client, request.serverId, deps.now());
    if (server === null) throw mcpFailure('not_found', 'The server was not found.');
    const tools = await listServerTools(client, request.serverId, deps.now());
    const tool = tools.find((item) => item.remoteName === request.remoteName);
    if (tool === undefined) throw mcpFailure('not_found', 'The tool was not found.');
    const policy = await readExecutionPolicy(client);
    return { server, tool, policy };
  });
  if (commandsFromDescription(prepared.tool.description).length > 0) {
    throw mcpFailure('rejected', 'The tool is not approved.');
  }
  if (!isRecord(prepared.tool.inputSchema)) throw mcpFailure('schema', 'The arguments are invalid.');
  const args = assertCompleteArguments(prepared.tool.inputSchema, request.arguments);
  if (request.schemaVersion !== prepared.tool.catalogVersion || request.schemaVersion !== prepared.server.catalogVersion) {
    throw mcpFailure('conflict', 'The schema version does not match.');
  }
  if (request.depth > prepared.policy.maxLoopDepth || request.costUnits > prepared.policy.maxCostUnits) {
    throw mcpFailure('limit', request.depth > prepared.policy.maxLoopDepth ? 'The tool loop is too deep.' : 'The cost limit is reached.');
  }
  const endpoint = parseApprovedEndpoint(prepared.server.endpoint);
  await assertResolvableEndpoint(endpoint);
  const id = randomUUID();
  const token = mintExecutionIdentity();
  const now = deps.now();
  const evidence = packEvidence(deps.sampleKeyManager, tenantId, id, {
    arguments: args,
    result: null,
    protocolError: null,
  });
  const reserved = await withTenant(deps.runtimePool, tenantId, (client) =>
    reserveExecution(client, tenantId, {
      id,
      serverId: request.serverId,
      remoteName: request.remoteName,
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      argumentHash: argumentDigest(args),
      identityHash: identityDigest(token),
      identityExpiresAt: stamp(now + prepared.policy.identityTtlMs),
      depth: request.depth,
      parentExecutionId: request.parentExecutionId,
      costUnits: request.costUnits,
      now: stamp(now),
      evidence,
    }),
  );
  if (!reserved.inserted) {
    const current = await currentRow(deps, tenantId, reserved.id);
    const result = await savedResult(deps, tenantId, current);
    return { statusCode: 200, body: { execution: executionView(current, result, 0), replayed: true, modelRequests: current.modelRequests } };
  }
  if (reserved.effect === 'write') {
    const current = await currentRow(deps, tenantId, reserved.id);
    return {
      statusCode: 202,
      body: { execution: executionView(current, null, 0), executionIdentity: token, replayed: false, modelRequests: 0 },
    };
  }
  let credential: string;
  try {
    credential = await openCredential(deps, tenantId, reserved.serverId);
  } catch (error) {
    await withTenant(deps.runtimePool, tenantId, (client) =>
      stopExecution(client, tenantId, reserved.id, 'The credential is invalid.', stamp(deps.now())),
    );
    throw error;
  }
  const outcome = await dispatchReserved(
    deps,
    tenantId,
    reserved,
    args,
    prepared.tool.inputSchema,
    prepared.tool.description,
    endpoint,
    credential,
  );
  outcome.body.modelRequests = 0;
  return outcome;
}

export async function decideManagedTool(
  deps: ExecutionDeps,
  tenantId: string,
  id: string,
  decision: 'grant' | 'deny' | 'cancel',
  identity: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const decided = await withTenant(deps.runtimePool, tenantId, (client) =>
    decideExecution(client, tenantId, id, identityDigest(identity), decision, stamp(deps.now())),
  );
  if (decided.action === 'denied' || decided.action === 'cancelled' || decided.action === 'replayed') {
    const current = await currentRow(deps, tenantId, decided.id);
    const result = await savedResult(deps, tenantId, current);
    const replayed = decided.action === 'replayed';
    return {
      statusCode: replayed && current.dispatchCount > 0 ? 409 : 200,
      body: { execution: executionView(current, result, 0), replayed, modelRequests: current.modelRequests },
    };
  }
  const prepared = await withTenant(deps.runtimePool, tenantId, async (client) => {
    const server = await readMcpServer(client, decided.serverId, deps.now());
    const tools = await listServerTools(client, decided.serverId, deps.now());
    const tool = tools.find((item) => item.remoteName === decided.remoteName);
    return { server, tool };
  });
  if (prepared.server === null || prepared.tool === undefined || !isRecord(prepared.tool.inputSchema)) {
    throw mcpFailure('rejected', 'The server is not approved.');
  }
  const packed = await withTenant(deps.runtimePool, tenantId, (client) => loadExecutionEvidence(client, tenantId, decided.id));
  const payload = unpackEvidence(deps.sampleKeyManager, tenantId, decided.id, packed);
  if (!isRecord(payload) || !isRecord(payload.arguments)) throw mcpFailure('schema', 'The arguments are invalid.');
  const endpoint = parseApprovedEndpoint(prepared.server.endpoint);
  await assertResolvableEndpoint(endpoint);
  const credential = await openCredential(deps, tenantId, decided.serverId);
  const row = await currentRow(deps, tenantId, decided.id);
  return dispatchReserved(deps, tenantId, row, payload.arguments, prepared.tool.inputSchema, prepared.tool.description, endpoint, credential);
}

export async function submitManagedResult(
  deps: ExecutionDeps,
  tenantId: string,
  id: string,
  runMode: string | null,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  if (runMode !== 'continue') throw mcpFailure('rejected', 'A model request is not authorized.');
  const row = await currentRow(deps, tenantId, id);
  const modelRequests = await withTenant(deps.runtimePool, tenantId, (client) => recordModelRequest(client, tenantId, id));
  if (modelRequests !== 1) throw mcpFailure('rejected', 'A model request is not authorized.');
  const current = await currentRow(deps, tenantId, id);
  const result = await savedResult(deps, tenantId, current);
  if (result === null) throw mcpFailure('rejected', 'A model request is not authorized.');
  return {
    statusCode: 200,
    body: {
      execution: executionView(current, result, 0),
      modelRequests,
      toolResult: {
        role: 'tool',
        tool_call_id: row.toolCallId,
        content: JSON.stringify(result),
      },
    },
  };
}

export async function listManagedExecutions(deps: ExecutionDeps, tenantId: string): Promise<Record<string, unknown>> {
  const executions = await withTenant(deps.runtimePool, tenantId, (client) => listExecutions(client));
  return { executions: executions.map((row) => executionView(row, null, 0)) };
}

export async function readManagedExecution(
  deps: ExecutionDeps,
  tenantId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await currentRow(deps, tenantId, id);
  const result = await savedResult(deps, tenantId, row);
  return { execution: executionView(row, result, 0) };
}

export async function recoverManagedExecutions(deps: ExecutionDeps, tenantId: string): Promise<Record<string, unknown>> {
  const recovered = await withTenant(deps.runtimePool, tenantId, (client) =>
    recoverExecutions(client, tenantId, stamp(deps.now())),
  );
  return { recovered };
}

export async function readManagedPolicy(deps: ExecutionDeps, tenantId: string): Promise<ExecutionPolicy> {
  return withTenant(deps.runtimePool, tenantId, (client) => readExecutionPolicy(client));
}

export async function writeManagedPolicy(deps: ExecutionDeps, tenantId: string, policy: ExecutionPolicy): Promise<ExecutionPolicy> {
  await withTenant(deps.runtimePool, tenantId, (client) => writeExecutionPolicy(client, tenantId, policy));
  return readManagedPolicy(deps, tenantId);
}
