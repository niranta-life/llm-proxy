import type { FastifyInstance, FastifyReply } from 'fastify';
import { proxyError } from '../inference/errors.js';
import { McpDispatchAbort } from './execute.js';
import { McpFailure, type McpFailureKind } from './errors.js';
import { assertIdentityToken, parseExecutionRequest, parsePolicyPatch } from './govern.js';
import { assertRemoteName } from './names.js';
import {
  decideManagedTool,
  executeManagedTool,
  listManagedExecutions,
  readManagedExecution,
  readManagedPolicy,
  recoverManagedExecutions,
  submitManagedResult,
  writeManagedPolicy,
  type ExecutionDeps,
} from './run.js';
import { revokeMcpCredential } from './execution-store.js';
import { readMcpServer } from './store.js';
import { withTenant } from '../db/tenant-context.js';
import type { McpRouteDeps } from './http.js';

const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusFor(kind: McpFailureKind): number {
  if (kind === 'redirect') return 502;
  if (kind === 'unavailable') return 503;
  if (kind === 'mismatch' || kind === 'conflict') return 409;
  if (kind === 'limit') return 429;
  if (kind === 'not_found') return 404;
  return 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendFailure(reply: FastifyReply, error: unknown, deps: McpRouteDeps): FastifyReply {
  if (error instanceof McpDispatchAbort) {
    return reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, error.message).body());
  }
  if (error instanceof McpFailure) {
    const status = statusFor(error.kind);
    return reply.code(status).send(proxyError(status, 'invalid_request_error', error.kind, null, error.message).body());
  }
  deps.logger.error('mcp execution failed', { message: error instanceof Error ? error.message : 'unknown' });
  return reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
}

function executionDeps(deps: McpRouteDeps): ExecutionDeps {
  return {
    runtimePool: deps.runtimePool,
    credentialStore: deps.credentialStore,
    sampleKeyManager: deps.sampleKeyManager,
    now: () => deps.now?.() ?? Date.now(),
    fetchImpl: deps.fetchImpl,
    abortAfterDispatch: deps.abortAfterDispatch,
  };
}

async function requireAuth(deps: McpRouteDeps, headers: McpRouteDeps extends never ? never : Parameters<McpRouteDeps['authenticate']>[0], reply: FastifyReply) {
  try {
    const auth = await deps.authenticate(headers);
    if (auth === null) {
      await reply.code(401).send(proxyError(401, 'authentication_error', 'invalid_api_key', null, 'Invalid authentication.').body());
      return null;
    }
    return auth;
  } catch (error) {
    deps.logger.error('authentication failed', { message: error instanceof Error ? error.message : 'unknown' });
    await reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    return null;
  }
}

function parseExecutionId(value: string): string {
  if (!EXECUTION_ID.test(value)) throw new McpFailure('not_found', 'The execution was not found.');
  return value.toLowerCase();
}

export function registerExecutionRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const runtime = executionDeps(deps);

  app.get('/internal/v1/mcp/policy', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      return await readManagedPolicy(runtime, auth.tenantId);
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.post('/internal/v1/mcp/policy', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      if (!isRecord(request.body)) throw new McpFailure('invalid', 'The request is invalid.');
      const current = await readManagedPolicy(runtime, auth.tenantId);
      const policy = await writeManagedPolicy(runtime, auth.tenantId, parsePolicyPatch(request.body, current));
      return { policy };
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.get('/internal/v1/mcp/executions', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      return await listManagedExecutions(runtime, auth.tenantId);
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.get<{ Params: { id: string } }>('/internal/v1/mcp/executions/:id', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      return await readManagedExecution(runtime, auth.tenantId, parseExecutionId(request.params.id));
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.post('/internal/v1/mcp/executions', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      if (!isRecord(request.body)) throw new McpFailure('invalid', 'The request is invalid.');
      const parsed = parseExecutionRequest(request.body);
      if (!EXECUTION_ID.test(parsed.serverId)) throw new McpFailure('not_found', 'The server was not found.');
      parsed.serverId = parsed.serverId.toLowerCase();
      parsed.remoteName = assertRemoteName(parsed.remoteName);
      const outcome = await executeManagedTool(runtime, auth.tenantId, parsed);
      return reply.code(outcome.statusCode).send(outcome.body);
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/executions/:id/approval', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      if (!isRecord(request.body) || typeof request.body.executionIdentity !== 'string') {
        throw new McpFailure('invalid', 'The execution identity is invalid.');
      }
      const decision = request.body.decision;
      if (decision !== 'grant' && decision !== 'deny' && decision !== 'cancel') {
        throw new McpFailure('invalid', 'The request is invalid.');
      }
      const outcome = await decideManagedTool(
        runtime,
        auth.tenantId,
        parseExecutionId(request.params.id),
        decision,
        assertIdentityToken(request.body.executionIdentity),
      );
      return reply.code(outcome.statusCode).send(outcome.body);
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/executions/:id/submit', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      if (!isRecord(request.body)) throw new McpFailure('invalid', 'The request is invalid.');
      const runMode = request.body.runMode === undefined ? null : request.body.runMode;
      if (runMode !== null && typeof runMode !== 'string') throw new McpFailure('invalid', 'The request is invalid.');
      const outcome = await submitManagedResult(runtime, auth.tenantId, parseExecutionId(request.params.id), runMode);
      return reply.code(outcome.statusCode).send(outcome.body);
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.post('/internal/v1/mcp/executions/recover', { bodyLimit: 1_024 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      return await recoverManagedExecutions(runtime, auth.tenantId);
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/revoke', { bodyLimit: 1_024 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const serverId = request.params.id.toLowerCase();
      if (!EXECUTION_ID.test(serverId)) throw new McpFailure('not_found', 'The server was not found.');
      await withTenant(deps.runtimePool, auth.tenantId, (client) => revokeMcpCredential(client, auth.tenantId, serverId));
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        readMcpServer(client, serverId, deps.now?.() ?? Date.now()),
      );
      if (server === null) throw new McpFailure('not_found', 'The server was not found.');
      return { server };
    } catch (error) {
      return sendFailure(reply, error, deps);
    }
  });
}
