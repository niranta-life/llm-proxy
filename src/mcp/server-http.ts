import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import { executeChat } from '../inference/execute.js';
import { executeEmbeddings } from '../inference/execute-embeddings.js';
import { ProxyError, proxyError } from '../inference/errors.js';
import { resolveModel } from '../inference/resolve.js';
import { listVisibleModels, loadCatalog } from '../inference/store.js';
import type { StreamGate } from '../inference/stream.js';
import type { StreamHttp } from '../inference/execute-stream.js';
import type { VertexClientFactory } from '../inference/vertex-client.js';
import type { Logger } from '../logger.js';
import { redact } from '../redact.js';
import {
  MCP_SERVER_CONCURRENCY,
  MCP_SERVER_PROTOCOL,
  MCP_SERVER_REQUEST_MAX_BYTES,
  SERVER_TOOL_NAMES,
  checkProtocolMessage,
  createConcurrencyGate,
  isServerToolName,
  originAllowed,
  outputWithinLimit,
  toolIsAllowed,
  toolKind,
  toolPermission,
  type ServerToolName,
} from './server-gate.js';

type Auth = { tenantId: string; keyId: string };

export type McpServerDeps = {
  logger: Logger;
  runtimePool: Pool;
  credentialStore: ProviderCredentialStore | null;
  inferenceEnabled: boolean;
  upstreamBaseUrl: string;
  streamGate: StreamGate;
  vertexClientFactory?: VertexClientFactory;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  now?: () => number;
  authenticate: (headers: IncomingHttpHeaders) => Promise<Auth | null>;
};

const EMPTY_ARGUMENTS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

const MODEL_LIST_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['models'],
  properties: {
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'object', 'created', 'owned_by'],
        properties: {
          id: { type: 'string' },
          object: { type: 'string', enum: ['model'] },
          created: { type: 'integer' },
          owned_by: { type: 'string' },
        },
      },
    },
  },
} as const;

const CAPABILITY_ARGUMENTS = {
  type: 'object',
  additionalProperties: false,
  required: ['model'],
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

const CAPABILITY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'capabilities'],
  properties: {
    model: { type: 'string' },
    capabilities: { type: 'array', items: { type: 'string' } },
  },
} as const;

const CHAT_ARGUMENTS = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'messages'],
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 128 },
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          content: { type: 'string', minLength: 1, maxLength: 8192 },
        },
      },
    },
    max_tokens: { type: 'integer', minimum: 1, maximum: 4096 },
  },
} as const;

const CHAT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'model', 'content'],
  properties: {
    id: { type: 'string' },
    model: { type: 'string' },
    content: { type: 'string' },
  },
} as const;

const EMBEDDING_ARGUMENTS = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'input'],
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 128 },
    input: { type: 'string', minLength: 1, maxLength: 8192 },
  },
} as const;

const EMBEDDING_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'count', 'dimension'],
  properties: {
    model: { type: 'string' },
    count: { type: 'integer' },
    dimension: { type: 'integer' },
  },
} as const;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function workSignal(ctx: { mcpReq: { signal: AbortSignal } }, parent: AbortSignal): AbortSignal {
  if (parent.aborted || ctx.mcpReq.signal.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  parent.addEventListener('abort', abort, { once: true });
  ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

type Exchange = {
  auth: Auth;
  allowed: ReadonlySet<ServerToolName>;
  signal: AbortSignal;
};

export function registerMcpServer(app: FastifyInstance, deps: McpServerDeps): void {
  const gate = createConcurrencyGate(MCP_SERVER_CONCURRENCY);
  const admitted = new WeakMap<FastifyRequest, Auth>();
  const exchanges = new WeakMap<Request, Exchange>();
  const mcpHandler = createMcpHandler(
    (ctx) => {
      const exchange = ctx.requestInfo === undefined ? undefined : exchanges.get(ctx.requestInfo);
      if (exchange === undefined) throw new Error('The MCP exchange is missing.');
      return buildServer(deps, exchange.auth, exchange.allowed, exchange.signal);
    },
    { legacy: 'reject', responseMode: 'sse', keepAliveMs: 0 },
  );
  app.addHook('onClose', async () => {
    await mcpHandler.close();
  });

  app.get('/internal/v1/mcp/exposed', async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    try {
      const tools = await withTenant(deps.runtimePool, auth.tenantId, async (client) => exposedTools(await readGrants(client)));
      return { tools };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.post('/internal/v1/mcp/exposed', { bodyLimit: 4_096 }, async (request, reply) => {
    const auth = await requireAuth(deps, request.headers, reply);
    if (auth === null) return;
    const body = isRecord(request.body) ? request.body : null;
    const name = body !== null && typeof body.name === 'string' ? body.name : '';
    const approved = body !== null && typeof body.approved === 'boolean' ? body.approved : null;
    if (!isServerToolName(name) || approved === null) {
      return reply.code(400).send(proxyError(400, 'invalid_request_error', 'invalid_request', 'name', 'The tool is not available.').body());
    }
    try {
      await withTenant(deps.runtimePool, auth.tenantId, (client) => writeGrant(client, auth.tenantId, name, approved));
      const tools = await withTenant(deps.runtimePool, auth.tenantId, async (client) => exposedTools(await readGrants(client)));
      return { tools };
    } catch (error) {
      return sendFailure(reply, error, deps.logger);
    }
  });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    bodyLimit: MCP_SERVER_REQUEST_MAX_BYTES,
    onRequest: async (request, reply) => {
      const auth = await requireAuth(deps, request.headers, reply);
      if (auth === null) return;
      const origin = headerString(request.headers.origin);
      const host = headerString(request.headers.host);
      if (!originAllowed(origin, host)) {
        await reply.code(403).send(proxyError(403, 'invalid_request_error', 'origin_rejected', null, 'The origin is not allowed.').body());
        return;
      }
      if (request.method !== 'POST') {
        reply.header('allow', 'POST');
        await reply.code(405).send({ error: 'method_not_allowed' });
        return;
      }
      admitted.set(request, auth);
    },
    handler: async (request, reply) => {
      const auth = admitted.get(request);
      if (auth === undefined) return;
      const rejection = checkProtocolMessage(request.body, {
        protocol: headerString(request.headers['mcp-protocol-version']),
        method: headerString(request.headers['mcp-method']),
        name: headerString(request.headers['mcp-name']),
      });
      if (rejection !== null) {
        deps.logger.info('mcp server rejected a request', { code: rejection.code });
        return reply.code(rejection.status).send(rpcError(requestId(request.body), rejection.code, rejection.message));
      }
      const release = gate.enter();
      if (release === null) {
        return reply.code(429).send(proxyError(429, 'rate_limit_error', 'concurrency_limit', null, 'The concurrency limit was reached.').body());
      }
      const controller = new AbortController();
      const abort = (): void => {
        if (!controller.signal.aborted) controller.abort();
      };
      const onClose = (): void => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.on('aborted', abort);
      reply.raw.on('close', onClose);
      try {
        const grants = await withTenant(deps.runtimePool, auth.tenantId, (client) => readGrants(client));
        const allowed = new Set(SERVER_TOOL_NAMES.filter((name) => toolIsAllowed(name, grants.get(name))));
        const webRequest = asRequest(request, controller.signal);
        exchanges.set(webRequest, { auth, allowed, signal: controller.signal });
        const response = await mcpHandler.fetch(webRequest, { parsedBody: request.body });
        return await sendTransport(reply, response);
      } catch (error) {
        if (controller.signal.aborted) {
          return reply.code(400).send(rpcError(requestId(request.body), -32800, 'The request was cancelled.'));
        }
        deps.logger.error('mcp server request failed', {
          message: redact(error instanceof Error ? error.message : 'unknown'),
        });
        return reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', onClose);
        release();
      }
    },
  });
}

function buildServer(
  deps: McpServerDeps,
  auth: Auth,
  allowed: ReadonlySet<ServerToolName>,
  signal: AbortSignal,
): McpServer {
  const server = new McpServer(
    { name: 'llm-proxy', version: '1.0.0' },
    {
      instructions: 'Read approved model data for this tenant. Inference and embedding stay off until the tenant approves them.',
      capabilities: { tools: { listChanged: false } },
      supportedProtocolVersions: [MCP_SERVER_PROTOCOL],
    },
  );
  if (allowed.has('list_models')) {
    server.registerTool(
      'list_models',
      {
        description: 'List the models this tenant can call.',
        inputSchema: fromJsonSchema(EMPTY_ARGUMENTS),
        outputSchema: fromJsonSchema(MODEL_LIST_OUTPUT),
        annotations: { readOnlyHint: true },
      },
      async (_args, ctx) => listModels(deps, auth.tenantId, workSignal(ctx, signal)),
    );
  }
  if (allowed.has('get_model_capabilities')) {
    server.registerTool(
      'get_model_capabilities',
      {
        description: 'Read the capabilities of one visible model.',
        inputSchema: fromJsonSchema(CAPABILITY_ARGUMENTS),
        outputSchema: fromJsonSchema(CAPABILITY_OUTPUT),
        annotations: { readOnlyHint: true },
      },
      async (args, ctx) => readCapabilities(deps, auth.tenantId, args, workSignal(ctx, signal)),
    );
  }
  if (allowed.has('create_chat_completion')) {
    server.registerTool(
      'create_chat_completion',
      {
        description: 'Create one chat completion when this tenant has approved it.',
        inputSchema: fromJsonSchema(CHAT_ARGUMENTS),
        outputSchema: fromJsonSchema(CHAT_OUTPUT),
        annotations: { readOnlyHint: false },
      },
      async (args, ctx) => createChat(deps, auth, args, workSignal(ctx, signal)),
    );
  }
  if (allowed.has('create_embedding')) {
    server.registerTool(
      'create_embedding',
      {
        description: 'Create one embedding when this tenant has approved it.',
        inputSchema: fromJsonSchema(EMBEDDING_ARGUMENTS),
        outputSchema: fromJsonSchema(EMBEDDING_OUTPUT),
        annotations: { readOnlyHint: false },
      },
      async (args, ctx) => createEmbedding(deps, auth, args, workSignal(ctx, signal)),
    );
  }
  return server;
}

async function listModels(deps: McpServerDeps, tenantId: string, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return toolError('The request was cancelled.');
  try {
    const models = await withTenant(deps.runtimePool, tenantId, (client) => listVisibleModels(client));
    return toolSuccess({ models });
  } catch (error) {
    return failed(deps, 'list_models', signal, error);
  }
}

async function readCapabilities(deps: McpServerDeps, tenantId: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return toolError('The request was cancelled.');
  const model = isRecord(args) && typeof args.model === 'string' ? args.model : '';
  try {
    const capabilities = await withTenant(deps.runtimePool, tenantId, async (client) => {
      const catalog = await loadCatalog(client);
      return resolveModel(model, catalog.deployments, catalog.aliases)?.capabilities ?? null;
    });
    if (capabilities === null) return toolError('The model is not available.');
    return toolSuccess({ model, capabilities: [...capabilities] });
  } catch (error) {
    return failed(deps, 'get_model_capabilities', signal, error);
  }
}

async function createChat(deps: McpServerDeps, auth: Auth, args: unknown, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return toolError('The request was cancelled.');
  try {
    const result = await executeChat({
      runtimePool: deps.runtimePool,
      logger: deps.logger,
      inferenceEnabled: deps.inferenceEnabled,
      upstreamBaseUrl: deps.upstreamBaseUrl,
      store: deps.credentialStore,
      tenantId: auth.tenantId,
      apiKeyId: auth.keyId,
      body: chatBody(args),
      signal,
      reply: idleReply(),
      gate: deps.streamGate,
      vertexClientFactory: deps.vertexClientFactory,
      fetchImpl: deps.fetchImpl,
      resolveHost: deps.resolveHost,
      nowMs: deps.now,
    });
    if (signal.aborted) return toolError('The request was cancelled.');
    const choice = result?.choices[0]?.message.content;
    return toolSuccess({ id: result?.id ?? '', model: result?.model ?? '', content: typeof choice === 'string' ? choice : '' });
  } catch (error) {
    return failed(deps, 'create_chat_completion', signal, error);
  }
}

async function createEmbedding(deps: McpServerDeps, auth: Auth, args: unknown, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return toolError('The request was cancelled.');
  try {
    const result = await executeEmbeddings({
      runtimePool: deps.runtimePool,
      logger: deps.logger,
      inferenceEnabled: deps.inferenceEnabled,
      upstreamBaseUrl: deps.upstreamBaseUrl,
      store: deps.credentialStore,
      tenantId: auth.tenantId,
      apiKeyId: auth.keyId,
      body: embeddingBody(args),
      signal,
      vertexClientFactory: deps.vertexClientFactory,
      fetchImpl: deps.fetchImpl,
      resolveHost: deps.resolveHost,
      nowMs: deps.now,
    });
    if (signal.aborted) return toolError('The request was cancelled.');
    const first = result.data[0];
    const dimension = Array.isArray(first?.embedding) ? first.embedding.length : 0;
    return toolSuccess({ model: result.model, count: result.data.length, dimension });
  } catch (error) {
    return failed(deps, 'create_embedding', signal, error);
  }
}

function chatBody(args: unknown): Record<string, unknown> {
  const body = isRecord(args) ? args : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const request: Record<string, unknown> = {
    model: body.model,
    messages,
  };
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens;
  return request;
}

function embeddingBody(args: unknown): Record<string, unknown> {
  const body = isRecord(args) ? args : {};
  return { model: body.model, input: body.input };
}

function toolSuccess(output: Record<string, unknown>): ToolResult {
  if (!outputWithinLimit(output)) return toolError('The output is too large.');
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function toolError(message: string): ToolResult {
  const text = message.slice(0, 256);
  return { isError: true, content: [{ type: 'text', text }] };
}

function failed(deps: McpServerDeps, tool: string, signal: AbortSignal, error: unknown): ToolResult {
  if (signal.aborted) return toolError('The request was cancelled.');
  if (error instanceof ProxyError) return toolError(error.message);
  deps.logger.error('mcp tool failed', { tool, message: redact(error instanceof Error ? error.message : 'unknown') });
  return toolError('The request failed.');
}

function idleReply(): StreamHttp {
  return {
    write() {
      return true;
    },
    once() {},
    off() {},
    hijack() {},
    header() {},
    writeHead() {},
    end() {},
    headersSent() {
      return false;
    },
  };
}

async function readGrants(client: PoolClient): Promise<Map<ServerToolName, boolean>> {
  const result = await client.query<{ tool_name: string; approved: boolean }>(
    `SELECT tool_name, approved FROM mcp_server_tool_grants ORDER BY tool_name`,
  );
  const grants = new Map<ServerToolName, boolean>();
  for (const row of result.rows) {
    if (isServerToolName(row.tool_name)) grants.set(row.tool_name, row.approved);
  }
  return grants;
}

async function writeGrant(client: PoolClient, tenantId: string, name: ServerToolName, approved: boolean): Promise<void> {
  try {
    await client.query(`SELECT set_mcp_server_tool_grant($1::uuid, $2, $3)`, [tenantId, name, approved]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('request is invalid')) {
      throw proxyError(400, 'invalid_request_error', 'invalid_request', 'name', 'The tool is not available.');
    }
    throw error;
  }
}

function exposedTools(grants: Map<ServerToolName, boolean>): Array<{ name: ServerToolName; kind: string; permission: string }> {
  return SERVER_TOOL_NAMES.map((name) => {
    const permission = toolPermission(name, grants.get(name));
    return {
      name,
      kind: toolKind(name),
      permission: permission === 'approval_required' ? 'approval required' : permission,
    };
  });
}

async function requireAuth(deps: McpServerDeps, headers: IncomingHttpHeaders, reply: FastifyReply): Promise<Auth | null> {
  try {
    const auth = await deps.authenticate(headers);
    if (auth === null) {
      deps.logger.info('credential rejected');
      await reply.code(401).send(proxyError(401, 'authentication_error', 'invalid_api_key', null, 'Invalid authentication.').body());
      return null;
    }
    return auth;
  } catch (error) {
    deps.logger.error('authentication failed', { message: redact(error instanceof Error ? error.message : 'unknown') });
    await reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    return null;
  }
}

function sendFailure(reply: FastifyReply, error: unknown, logger: Logger): FastifyReply {
  if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
  logger.error('mcp server request failed', { message: redact(error instanceof Error ? error.message : 'unknown') });
  return reply.code(500).send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
}

async function sendTransport(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  const bytes = Buffer.from(await response.arrayBuffer());
  reply.code(response.status);
  const contentType = response.headers.get('content-type');
  if (contentType !== null) reply.header('content-type', contentType);
  return reply.send(bytes);
}

function asRequest(request: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (key === 'content-length' || key === 'transfer-encoding' || key === 'host') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
      continue;
    }
    headers.set(key, value);
  }
  const host = headerString(request.headers.host) ?? '127.0.0.1';
  return new Request(`http://${host}${request.url}`, { method: 'POST', headers, signal });
}

function rpcError(id: unknown, code: number, message: string): { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function requestId(body: unknown): unknown {
  if (!isRecord(body)) return null;
  const id = body.id;
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return null;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
