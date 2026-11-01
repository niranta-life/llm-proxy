import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import { ProxyError, proxyError } from '../inference/errors.js';
import { redact } from '../redact.js';
import type { Logger } from '../logger.js';
import { assertResolvableEndpoint, parseApprovedEndpoint } from './endpoint.js';
import { McpFailure, type McpFailureKind } from './errors.js';
import { mcpAdminPage } from './page.js';
import { assertDisplayName, assertRemoteName, assertServerKey } from './names.js';
import { discoverMcpCatalog, probeMcpServer } from './discover.js';
import {
  listExposedCatalog,
  listMcpServers,
  listServerTools,
  loadMcpCredential,
  protectCredential,
  readMcpServer,
  recordMcpConnection,
  registerMcpServer,
  replaceMcpCredential,
  setMcpServerEnabled,
  setMcpToolPermission,
  storeMcpCatalog,
  type McpServerRow,
} from './store.js';

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_KEYS = new Set(['command', 'args', 'cwd', 'stdio', 'transport']);

type Auth = { tenantId: string; keyId: string };

export type McpRouteDeps = {
  logger: Logger;
  runtimePool: Pool;
  credentialStore: ProviderCredentialStore | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
  authenticate: (headers: IncomingHttpHeaders) => Promise<Auth | null>;
};

function statusFor(kind: McpFailureKind): number {
  if (kind === 'redirect') return 502;
  if (kind === 'unavailable') return 503;
  if (kind === 'mismatch') return 409;
  return 400;
}

function connectionStatus(kind: McpFailureKind): 'failed' | 'mismatch' {
  return kind === 'mismatch' ? 'mismatch' : 'failed';
}

function sendFailure(reply: FastifyReply, error: unknown, logger: Logger): FastifyReply {
  if (error instanceof McpFailure) {
    return reply.code(statusFor(error.kind)).send(proxyError(statusFor(error.kind), 'invalid_request_error', error.kind, null, error.message).body());
  }
  if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
  logger.error('mcp request failed', { message: redact(error instanceof Error ? error.message : 'unknown') });
  return reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectLocal(body: Record<string, unknown>): void {
  for (const key of LOCAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new McpFailure('rejected', 'A local executable is not allowed.');
    }
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new McpFailure('invalid', 'The request is invalid.');
  return value;
}

function clock(deps: McpRouteDeps): number {
  return deps.now?.() ?? Date.now();
}

async function requireAuth(deps: McpRouteDeps, headers: IncomingHttpHeaders, reply: FastifyReply): Promise<Auth | null> {
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

function requireStore(store: ProviderCredentialStore | null): ProviderCredentialStore {
  if (store === null) throw new McpFailure('invalid', 'The credential is invalid.');
  return store;
}

function parseServerId(value: string): string {
  if (!SERVER_ID.test(value)) throw new McpFailure('invalid', 'The server was not found.');
  return value.toLowerCase();
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  app.get('/internal/v1/mcp', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(mcpAdminPage());
  });

  app.get('/internal/v1/mcp/servers', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const servers = await withTenant(deps.runtimePool, auth.tenantId, (client) => listMcpServers(client, clock(deps)));
      return { servers };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post('/internal/v1/mcp/servers', { bodyLimit: 16_384 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      if (!isRecord(request.body)) throw new McpFailure('invalid', 'The request is invalid.');
      rejectLocal(request.body);
      const serverKey = assertServerKey(requireString(request.body, 'serverKey'));
      const displayName = assertDisplayName(requireString(request.body, 'displayName'));
      const endpoint = parseApprovedEndpoint(requireString(request.body, 'endpoint'));
      await assertResolvableEndpoint(endpoint);
      const protocolMode = requireString(request.body, 'protocolMode');
      if (protocolMode !== 'modern' && protocolMode !== 'legacy') {
        throw new McpFailure('invalid', 'The protocol mode is invalid.');
      }
      const credentialRef = protectCredential(requireStore(deps.credentialStore), requireString(request.body, 'credential'));
      const enabled = request.body.enabled === undefined ? false : request.body.enabled;
      if (typeof enabled !== 'boolean') throw new McpFailure('invalid', 'The request is invalid.');
      const id = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        registerMcpServer(client, auth.tenantId, {
          serverKey,
          displayName,
          endpoint: endpoint.href,
          credentialRef,
          protocolMode,
          enabled,
        }),
      );
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) => readMcpServer(client, id, clock(deps)));
      return reply.code(201).send({ server });
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/credential', { bodyLimit: 8_192 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const serverId = parseServerId(request.params.id);
      if (!isRecord(request.body)) throw new McpFailure('invalid', 'The request is invalid.');
      rejectLocal(request.body);
      const credentialRef = protectCredential(requireStore(deps.credentialStore), requireString(request.body, 'credential'));
      await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        replaceMcpCredential(client, auth.tenantId, serverId, credentialRef),
      );
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) => readMcpServer(client, serverId, clock(deps)));
      if (server === null) throw new McpFailure('invalid', 'The server was not found.');
      return { server };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/enabled', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const serverId = parseServerId(request.params.id);
      if (!isRecord(request.body) || typeof request.body.enabled !== 'boolean') {
        throw new McpFailure('invalid', 'The request is invalid.');
      }
      const enabled = request.body.enabled;
      await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        setMcpServerEnabled(client, auth.tenantId, serverId, enabled),
      );
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) => readMcpServer(client, serverId, clock(deps)));
      if (server === null) throw new McpFailure('invalid', 'The server was not found.');
      return { server };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.get<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/health', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        readMcpServer(client, parseServerId(request.params.id), clock(deps)),
      );
      if (server === null) throw new McpFailure('invalid', 'The server was not found.');
      return healthBody(server);
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.get<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/tools', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const serverId = parseServerId(request.params.id);
      const tools = await withTenant(deps.runtimePool, auth.tenantId, async (client) => {
        const server = await readMcpServer(client, serverId, clock(deps));
        if (server === null) throw new McpFailure('invalid', 'The server was not found.');
        return listServerTools(client, serverId, clock(deps));
      });
      return { tools };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.get('/internal/v1/mcp/catalog', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const catalog = await withTenant(deps.runtimePool, auth.tenantId, (client) => listExposedCatalog(client, clock(deps)));
      return { catalog };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post('/internal/v1/mcp/permissions', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      if (!isRecord(request.body) || typeof request.body.allowed !== 'boolean' || typeof request.body.serverId !== 'string') {
        throw new McpFailure('invalid', 'The request is invalid.');
      }
      const serverId = parseServerId(request.body.serverId);
      const remoteName = assertRemoteName(requireString(request.body, 'remoteName'));
      const allowed = request.body.allowed;
      await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        setMcpToolPermission(client, auth.tenantId, serverId, remoteName, allowed),
      );
      const tools = await withTenant(deps.runtimePool, auth.tenantId, (client) => listServerTools(client, serverId, clock(deps)));
      return { tools };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/test', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const serverId = parseServerId(request.params.id);
      const loaded = await withTenant(deps.runtimePool, auth.tenantId, async (client) => loadServer(client, auth.tenantId, serverId, deps));
      try {
        const probe = await probeMcpServer({
          mode: loaded.server.protocolMode,
          endpoint: loaded.endpoint,
          credential: loaded.credential,
          fetchImpl: deps.fetchImpl,
        });
        await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          recordMcpConnection(client, auth.tenantId, serverId, 'ok', probe.protocolVersion, null),
        );
      } catch (error) {
        const failure = error instanceof McpFailure ? error : new McpFailure('unavailable', 'The server is unavailable.');
        await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          recordMcpConnection(client, auth.tenantId, serverId, connectionStatus(failure.kind), null, failure.message),
        );
        throw failure;
      }
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) => readMcpServer(client, serverId, clock(deps)));
      return { server, toolCalls: 0 };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post<{ Params: { id: string } }>('/internal/v1/mcp/servers/:id/discover', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const serverId = parseServerId(request.params.id);
      const loaded = await withTenant(deps.runtimePool, auth.tenantId, async (client) => loadServer(client, auth.tenantId, serverId, deps));
      let discovered;
      try {
        discovered = await discoverMcpCatalog({
          mode: loaded.server.protocolMode,
          endpoint: loaded.endpoint,
          credential: loaded.credential,
          serverKey: loaded.server.serverKey,
          fetchImpl: deps.fetchImpl,
        });
      } catch (error) {
        const failure = error instanceof McpFailure ? error : new McpFailure('unavailable', 'The server is unavailable.');
        await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          recordMcpConnection(client, auth.tenantId, serverId, connectionStatus(failure.kind), null, failure.message),
        );
        throw failure;
      }
      if (discovered.toolCalls !== 0) throw new McpFailure('rejected', 'The proxy does not call a tool.');
      const saved = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        storeMcpCatalog(client, auth.tenantId, serverId, discovered),
      );
      const server = await withTenant(deps.runtimePool, auth.tenantId, (client) => readMcpServer(client, serverId, clock(deps)));
      return {
        server,
        catalogVersion: saved.catalogVersion,
        changed: saved.changed,
        fingerprint: saved.fingerprint,
        protocolVersion: discovered.protocolVersion,
        ttlMs: discovered.ttlMs,
        cacheScope: discovered.cacheScope,
        pages: discovered.pages,
        toolCalls: discovered.toolCalls,
        tools: discovered.tools.map((tool) => ({
          remoteName: tool.remoteName,
          namespacedName: tool.namespacedName,
          description: tool.description,
        })),
      };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });
}

function healthBody(server: McpServerRow): Record<string, unknown> {
  return {
    id: server.id,
    serverKey: server.serverKey,
    displayName: server.displayName,
    protocolMode: server.protocolMode,
    protocolVersion: server.protocolVersion,
    connectionStatus: server.connectionStatus,
    enabled: server.enabled,
    lastCheckedAt: server.lastCheckedAt,
    lastError: server.lastError,
    catalogFingerprint: server.catalogFingerprint,
    cacheAgeMs: server.cacheAgeMs,
    ttlMs: server.ttlMs,
    cacheScope: server.cacheScope,
    catalogVersion: server.catalogVersion,
  };
}

async function loadServer(
  client: PoolClient,
  tenantId: string,
  serverId: string,
  deps: McpRouteDeps,
): Promise<{ server: McpServerRow; endpoint: URL; credential: string }> {
  const server = await readMcpServer(client, serverId, clock(deps));
  if (server === null) throw new McpFailure('invalid', 'The server was not found.');
  const endpoint = parseApprovedEndpoint(server.endpoint);
  await assertResolvableEndpoint(endpoint);
  const protectedRef = await loadMcpCredential(client, tenantId, serverId);
  if (protectedRef === null) throw new McpFailure('invalid', 'The server was not found.');
  let credential: string;
  try {
    credential = requireStore(deps.credentialStore).open(protectedRef);
  } catch {
    throw new McpFailure('invalid', 'The credential is invalid.');
  }
  return { server, endpoint, credential };
}
