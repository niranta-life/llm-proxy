import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCredentialStore } from '../src/credentials.js';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { configFor, createTestApp, loadTestDatabase, projectRoot, type TestDatabase } from './helpers.js';
import { adminPool, credentialKey, provisionTenant } from './inference-support.js';

const EVIDENCE = join(projectRoot, 'evidence', 'slice-10f');
const OLD_SECRET = 'mcp-secret-old1';
const NEW_SECRET = 'mcp-secret-new2';
const PROTOCOL = '2026-07-28';

type Hit = { method: string; url: string; body: string; protocolHeader: string; methodHeader: string; authorization: string };

const hits: Hit[] = [];
let revision = 1;
let serverPort = 0;
let redirectPort = 0;
let schemaPort = 0;
let redirectHits = 0;
let schemaHits = 0;

function tool(name: string, schema: Record<string, unknown> = { type: 'object', properties: { q: { type: 'string' } } }, description = 'Search the catalog'): Record<string, unknown> {
  return { name, description, inputSchema: schema };
}

function nestedSchema(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < depth; index += 1) node = { type: 'object', properties: { a: node } };
  return node;
}

function wideSchema(count: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) properties[`field${index}`] = { type: 'string' };
  return { type: 'object', properties };
}

function pageTools(cursor: string, total: number, size: number): { tools: Record<string, unknown>[]; nextCursor?: string } {
  const start = cursor === '' ? 0 : Number(cursor.slice('page-'.length));
  const tools = [];
  for (let item = start; item < Math.min(start + size, total); item += 1) tools.push(tool(`tool${item}`, undefined, `Tool ${item}`));
  const nextCursor = start + size < total ? `page-${start + size}` : undefined;
  return { tools, nextCursor };
}

function toolsFor(pathname: string, cursor: string): { tools: Record<string, unknown>[]; nextCursor?: string } {
  if (pathname === '/page') return pageTools(cursor, 3, 2);
  if (pathname === '/large') return pageTools(cursor, 40, 8);
  if (pathname === '/rest') return pageTools(cursor, 36, 4);
  if (pathname === '/long') return { tools: [tool(`t${'o'.repeat(63)}`)] };
  if (pathname === '/bad') return { tools: [tool('broken', { type: 'object', properties: { q: 1 as unknown as Record<string, unknown> } })] };
  if (pathname === '/deep') return { tools: [tool('deep', nestedSchema(9))] };
  if (pathname === '/wide') return { tools: [tool('wide', wideSchema(70))] };
  if (pathname === '/size') {
    return { tools: [tool('sized', { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(17_000) } } })] };
  }
  if (pathname === '/external') {
    return {
      tools: [tool('linked', { type: 'object', properties: { a: { $ref: `http://127.0.0.1:${schemaPort}/schema.json` } } })],
    };
  }
  if (pathname === '/legacy') return { tools: [tool('legacy_search', undefined, 'Read a legacy record')] };
  if (pathname === '/change') {
    return { tools: [tool('search', undefined, revision === 1 ? 'Search the catalog' : 'Search the revised catalog')] };
  }
  if (pathname === '/collide') return { tools: [tool('search'), tool('search', undefined, 'Second search')] };
  if (pathname === '/dup' || pathname === '/modern') return { tools: [tool('search')] };
  return { tools: [tool('search')] };
}

function discoverResult(pathname: string): Record<string, unknown> {
  return {
    resultType: 'complete',
    ttlMs: 300_000,
    cacheScope: 'public',
    supportedVersions: pathname === '/mismatch' ? ['2025-11-25'] : [PROTOCOL],
    capabilities: { tools: { listChanged: false } },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

async function handleMock(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  const url = request.url ?? '/';
  const pathname = url.split('?')[0] ?? '/';
  hits.push({
    method: request.method ?? '',
    url: pathname,
    body,
    protocolHeader: String(request.headers['mcp-protocol-version'] ?? ''),
    methodHeader: String(request.headers['mcp-method'] ?? ''),
    authorization: String(request.headers.authorization ?? ''),
  });
  if (request.method === 'GET') {
    response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    response.end('{"error":"method not allowed"}');
    return;
  }
  if (pathname === '/redirect') {
    response.writeHead(302, { location: `http://127.0.0.1:${redirectPort}/stolen` });
    response.end();
    return;
  }
  let message: { id?: unknown; method?: string; params?: { cursor?: string } };
  try {
    message = JSON.parse(body) as { id?: unknown; method?: string; params?: { cursor?: string } };
  } catch {
    sendJson(response, 400, { error: 'invalid json' });
    return;
  }
  if (message.method === 'tools/call') {
    sendJson(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (message.method === 'notifications/initialized') {
    response.writeHead(202);
    response.end();
    return;
  }
  if (message.method === 'initialize') {
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mock', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'server/discover') {
    if (pathname === '/legacy') {
      sendJson(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    sendJson(response, 200, { jsonrpc: '2.0', id: message.id, result: discoverResult(pathname) });
    return;
  }
  if (message.method === 'tools/list') {
    const cursor = typeof message.params?.cursor === 'string' ? message.params.cursor : '';
    const page = toolsFor(pathname, cursor);
    const legacy = pathname === '/legacy';
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        ...(legacy ? {} : { resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' }),
        tools: page.tools,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    });
    return;
  }
  sendJson(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-tenant-id': tenantId, authorization: `Bearer ${secret}` };
}

function endpoint(pathname: string): string {
  return `http://127.0.0.1:${serverPort}${pathname}`;
}

describe('MCP catalog', () => {
  const db: TestDatabase = loadTestDatabase();
  const evidence: Record<string, unknown> = {};
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let lines: string[] = [];
  let closeApp: () => Promise<void> = async () => undefined;
  let closeServers: () => Promise<void> = async () => undefined;
  let tenant: { tenantId: string; secret: string };
  let other: { tenantId: string; secret: string };
  let alphaId = '';

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    const mock = await listen((request, response) => {
      void handleMock(request, response);
    });
    const redirect = await listen((_request, response) => {
      redirectHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const schema = await listen((_request, response) => {
      schemaHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"type":"object"}');
    });
    serverPort = mock.port;
    redirectPort = redirect.port;
    schemaPort = schema.port;
    closeServers = async () => {
      await mock.close();
      await redirect.close();
      await schema.close();
    };
    const ctx = await createTestApp(db, { credentialKey, inferenceEnabled: true });
    app = ctx.app;
    lines = ctx.lines;
    tenant = provisionTenant(db, 'MCP catalog');
    other = provisionTenant(db, 'MCP other');
    closeApp = async () => {
      await app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
    };
  });

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'discovery-result.json'), `${JSON.stringify(evidence.discovery ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'api-responses.json'), `${JSON.stringify(evidence.api ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'mock-tests.json'), `${JSON.stringify(evidence.mock ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'rls-proof.json'), `${JSON.stringify(evidence.rls ?? {}, null, 2)}\n`);
    await closeApp();
    await closeServers();
  });

  async function post(path: string, body: unknown, caller = tenant): Promise<{ statusCode: number; json: () => unknown; body: string }> {
    const response = await app.inject({ method: 'POST', url: path, headers: authHeaders(caller.tenantId, caller.secret), payload: body });
    return { statusCode: response.statusCode, json: () => response.json(), body: response.body };
  }

  async function get(path: string, caller = tenant): Promise<{ statusCode: number; json: () => unknown; body: string }> {
    const response = await app.inject({ method: 'GET', url: path, headers: authHeaders(caller.tenantId, caller.secret) });
    return { statusCode: response.statusCode, json: () => response.json(), body: response.body };
  }

  function methods(pathname: string, methodName: string): Hit[] {
    return hits.filter((hit) => hit.url === pathname && hit.body.includes(`"${methodName}"`));
  }

  it('serves the catalog page', async () => {
    const response = await app.inject({ method: 'GET', url: '/internal/v1/mcp' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Register server');
    expect(response.body).toContain('Test connection');
    expect(response.body).toContain('Discover tools');
    expect(response.body).toContain('does not call a tool');
  });

  it('rejects a non-https endpoint, a metadata address, and a local executable', async () => {
    const httpHost = await post('/internal/v1/mcp/servers', {
      serverKey: 'rejected',
      displayName: 'Rejected',
      endpoint: 'http://example.com/mcp',
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    expect(httpHost.statusCode).toBe(400);
    expect(httpHost.body).toContain('The endpoint is not allowed.');
    const metadata = await post('/internal/v1/mcp/servers', {
      serverKey: 'metadata',
      displayName: 'Metadata',
      endpoint: 'https://169.254.169.254/mcp',
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    expect(metadata.statusCode).toBe(400);
    const command = await post('/internal/v1/mcp/servers', {
      serverKey: 'local',
      displayName: 'Local',
      endpoint: endpoint('/modern'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
      command: 'touch evidence/slice-10f/spawned-marker',
    });
    expect(command.statusCode).toBe(400);
    expect(command.body).toContain('A local executable is not allowed.');
    expect(readdirSync(EVIDENCE).includes('spawned-marker')).toBe(false);
  });

  it('registers a modern server and stores a protected credential', async () => {
    const created = await post('/internal/v1/mcp/servers', {
      serverKey: 'alpha',
      displayName: 'Alpha search',
      endpoint: endpoint('/modern'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { server: { id: string; serverKey: string; connectionStatus: string; protocolMode: string } };
    alphaId = body.server.id;
    expect(body.server.serverKey).toBe('alpha');
    expect(body.server.connectionStatus).toBe('unknown');
    expect(body.server.protocolMode).toBe('modern');
    expect(created.body).not.toContain(OLD_SECRET);
    expect(created.body).not.toContain('aes-256-gcm$');
    const admin = adminPool(db);
    const stored = await admin.query<{ credential_ref: string }>('SELECT credential_ref FROM mcp_servers WHERE id = $1', [alphaId]);
    await admin.end();
    const protectedRef = stored.rows[0]?.credential_ref ?? '';
    expect(protectedRef.startsWith('aes-256-gcm$')).toBe(true);
    expect(protectedRef).not.toContain(OLD_SECRET);
    evidence.api = { ...(evidence.api as object), register: body };
  });

  it('tests the modern connection and records protocol 2026-07-28', async () => {
    const before = methods('/modern', 'tools/list').length;
    const tested = await post(`/internal/v1/mcp/servers/${alphaId}/test`, {});
    expect(tested.statusCode).toBe(200);
    const body = tested.json() as { server: { connectionStatus: string; protocolVersion: string }; toolCalls: number };
    expect(body.server.connectionStatus).toBe('ok');
    expect(body.server.protocolVersion).toBe(PROTOCOL);
    expect(body.toolCalls).toBe(0);
    expect(methods('/modern', 'tools/list').length).toBe(before);
    expect(methods('/modern', 'tools/call').length).toBe(0);
    expect(methods('/modern', 'server/discover').length).toBeGreaterThan(0);
    const discover = methods('/modern', 'server/discover').at(-1);
    expect(discover?.protocolHeader).toBe(PROTOCOL);
    expect(discover?.body).toContain('io.modelcontextprotocol/protocolVersion');
    expect(tested.body).not.toContain(OLD_SECRET);
    evidence.api = { ...(evidence.api as object), test: body };
  });

  it('discovers a modern catalog and a following tools page', async () => {
    const paged = await post('/internal/v1/mcp/servers', {
      serverKey: 'paged',
      displayName: 'Paged tools',
      endpoint: endpoint('/page'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const pagedId = (paged.json() as { server: { id: string } }).server.id;
    const discovered = await post(`/internal/v1/mcp/servers/${pagedId}/discover`, {});
    expect(discovered.statusCode).toBe(200);
    const body = discovered.json() as {
      changed: boolean;
      catalogVersion: number;
      fingerprint: string;
      protocolVersion: string;
      ttlMs: number;
      cacheScope: string;
      pages: number;
      toolCalls: number;
      server: { cacheAgeMs: number; catalogFingerprint: string };
      tools: Array<{ namespacedName: string }>;
    };
    expect(body.protocolVersion).toBe(PROTOCOL);
    expect(body.ttlMs).toBe(300_000);
    expect(body.cacheScope).toBe('public');
    expect(body.pages).toBe(2);
    expect(body.toolCalls).toBe(0);
    expect(body.changed).toBe(true);
    expect(body.catalogVersion).toBe(1);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.server.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(body.tools.map((item) => item.namespacedName)).toEqual(['paged/tool0', 'paged/tool1', 'paged/tool2']);
    const lists = methods('/page', 'tools/list');
    expect(lists.length).toBe(2);
    expect(lists[1]?.body).toContain('page-2');
    expect(methods('/page', 'tools/call').length).toBe(0);
    expect(discovered.body).not.toContain(OLD_SECRET);
    evidence.discovery = body;
    evidence.mock = { pages: lists.length, toolCalls: methods('/page', 'tools/call').length };
  });

  it('detects a catalog change and keeps the version when the catalog is unchanged', async () => {
    const created = await post('/internal/v1/mcp/servers', {
      serverKey: 'revise',
      displayName: 'Revise',
      endpoint: endpoint('/change'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const id = (created.json() as { server: { id: string } }).server.id;
    const first = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    expect((first.json() as { changed: boolean; catalogVersion: number }).changed).toBe(true);
    revision = 2;
    const second = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    expect(second.statusCode).toBe(200);
    expect((second.json() as { changed: boolean; catalogVersion: number }).changed).toBe(true);
    expect((second.json() as { catalogVersion: number }).catalogVersion).toBe(2);
    const third = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    expect((third.json() as { changed: boolean; catalogVersion: number }).changed).toBe(false);
    expect((third.json() as { catalogVersion: number }).catalogVersion).toBe(2);
  });

  it('namespaces the same remote tool name from two servers', async () => {
    const beta = await post('/internal/v1/mcp/servers', {
      serverKey: 'beta',
      displayName: 'Beta search',
      endpoint: endpoint('/dup'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const betaId = (beta.json() as { server: { id: string } }).server.id;
    const alpha = await post('/internal/v1/mcp/servers', {
      serverKey: 'gamma',
      displayName: 'Gamma search',
      endpoint: endpoint('/modern'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const gammaId = (alpha.json() as { server: { id: string } }).server.id;
    const left = await post(`/internal/v1/mcp/servers/${betaId}/discover`, {});
    const right = await post(`/internal/v1/mcp/servers/${gammaId}/discover`, {});
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    expect((left.json() as { tools: Array<{ namespacedName: string }> }).tools[0]?.namespacedName).toBe('beta/search');
    expect((right.json() as { tools: Array<{ namespacedName: string }> }).tools[0]?.namespacedName).toBe('gamma/search');
    await post('/internal/v1/mcp/permissions', { serverId: betaId, remoteName: 'search', allowed: true });
    await post('/internal/v1/mcp/permissions', { serverId: gammaId, remoteName: 'search', allowed: true });
    await post(`/internal/v1/mcp/servers/${betaId}/enabled`, { enabled: true });
    await post(`/internal/v1/mcp/servers/${gammaId}/enabled`, { enabled: true });
    const catalog = await get('/internal/v1/mcp/catalog');
    const names = (catalog.json() as { catalog: Array<{ namespacedName: string }> }).catalog.map((item) => item.namespacedName);
    expect(names).toContain('beta/search');
    expect(names).toContain('gamma/search');
    const collided = await post('/internal/v1/mcp/servers', {
      serverKey: 'collide',
      displayName: 'Collide',
      endpoint: endpoint('/collide'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const collideId = (collided.json() as { server: { id: string } }).server.id;
    const duplicate = await post(`/internal/v1/mcp/servers/${collideId}/discover`, {});
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toContain('The tool name is duplicated.');
    const stored = await get(`/internal/v1/mcp/servers/${collideId}/tools`);
    expect((stored.json() as { tools: unknown[] }).tools).toEqual([]);
  });

  it('rejects a malformed schema, an external reference, and a schema past the bounds', async () => {
    async function rejected(path: string, key: string): Promise<string> {
      const created = await post('/internal/v1/mcp/servers', {
        serverKey: key,
        displayName: key,
        endpoint: endpoint(path),
        credential: OLD_SECRET,
        protocolMode: 'modern',
      });
      const id = (created.json() as { server: { id: string } }).server.id;
      const result = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
      expect(result.statusCode).toBe(400);
      const tools = await get(`/internal/v1/mcp/servers/${id}/tools`);
      expect((tools.json() as { tools: unknown[] }).tools).toEqual([]);
      return result.body;
    }
    expect(await rejected('/bad', 'badschema')).toContain('The tool schema is invalid.');
    expect(schemaHits).toBe(0);
    expect(await rejected('/external', 'extschema')).toContain('The tool schema is invalid.');
    expect(schemaHits).toBe(0);
    expect(await rejected('/deep', 'deepschema')).toContain('The tool schema is invalid.');
    expect(await rejected('/wide', 'wideschema')).toContain('The tool schema is invalid.');
    expect(await rejected('/size', 'sizeschema')).toContain('The tool schema is invalid.');
  });

  it('rejects a catalog past the tool bound', async () => {
    const created = await post('/internal/v1/mcp/servers', {
      serverKey: 'bulky',
      displayName: 'Bulky',
      endpoint: endpoint('/large'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const id = (created.json() as { server: { id: string } }).server.id;
    const result = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('The catalog is too large.');
    const lists = methods('/large', 'tools/list');
    expect(lists.length).toBeGreaterThan(1);
    expect(lists.length).toBeLessThan(6);
    const tools = await get(`/internal/v1/mcp/servers/${id}/tools`);
    expect((tools.json() as { tools: unknown[] }).tools).toEqual([]);
    expect(methods('/large', 'tools/call').length).toBe(0);
    evidence.mock = { ...(evidence.mock as object), largePages: lists.length, schemaFetches: schemaHits };
  });

  it('rejects a catalog that still has a cursor after the page bound', async () => {
    const created = await post('/internal/v1/mcp/servers', {
      serverKey: 'remainder',
      displayName: 'Remainder',
      endpoint: endpoint('/rest'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const id = (created.json() as { server: { id: string } }).server.id;
    const result = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('The catalog is too large.');
    const lists = methods('/rest', 'tools/list');
    expect(lists).toHaveLength(8);
    expect(lists[7]?.body).toContain('page-28');
    expect(lists.some((hit) => hit.body.includes('page-32'))).toBe(false);
    const tools = await get(`/internal/v1/mcp/servers/${id}/tools`);
    expect((tools.json() as { tools: unknown[] }).tools).toEqual([]);
    expect(methods('/rest', 'tools/call')).toHaveLength(0);
  });

  it('stores a 32 character server key and a 64 character tool name', async () => {
    const serverKey = `k${'a'.repeat(31)}`;
    const remoteName = `t${'o'.repeat(63)}`;
    const created = await post('/internal/v1/mcp/servers', {
      serverKey,
      displayName: 'Long names',
      endpoint: endpoint('/long'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { server: { id: string } }).server.id;
    const discovered = await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    expect(discovered.statusCode).toBe(200);
    const namespacedName = `${serverKey}/${remoteName}`;
    expect(namespacedName).toHaveLength(97);
    const body = discovered.json() as { tools: Array<{ namespacedName: string }> };
    expect(body.tools[0]?.namespacedName).toBe(namespacedName);
    const tools = await get(`/internal/v1/mcp/servers/${id}/tools`);
    expect((tools.json() as { tools: Array<{ namespacedName: string }> }).tools[0]?.namespacedName).toBe(namespacedName);
    expect(methods('/long', 'tools/call')).toHaveLength(0);
  });

  it('records an unavailable server and refuses a redirect', async () => {
    const closed = await post('/internal/v1/mcp/servers', {
      serverKey: 'closed',
      displayName: 'Closed',
      endpoint: 'http://127.0.0.1:9/mcp',
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const closedId = (closed.json() as { server: { id: string } }).server.id;
    const down = await post(`/internal/v1/mcp/servers/${closedId}/test`, {});
    expect(down.statusCode).toBe(503);
    expect(down.body).toContain('The server is unavailable.');
    const health = await get(`/internal/v1/mcp/servers/${closedId}/health`);
    expect((health.json() as { connectionStatus: string }).connectionStatus).toBe('failed');
    const redirect = await post('/internal/v1/mcp/servers', {
      serverKey: 'bounce',
      displayName: 'Bounce',
      endpoint: endpoint('/redirect'),
      credential: OLD_SECRET,
      protocolMode: 'modern',
    });
    const redirectId = (redirect.json() as { server: { id: string } }).server.id;
    const bounced = await post(`/internal/v1/mcp/servers/${redirectId}/discover`, {});
    expect(bounced.statusCode).toBe(502);
    expect(bounced.body).toContain('The endpoint redirected.');
    expect(redirectHits).toBe(0);
    const tools = await get(`/internal/v1/mcp/servers/${redirectId}/tools`);
    expect((tools.json() as { tools: unknown[] }).tools).toEqual([]);
  });

  it('rotates the credential and leaves the previous secret unreadable', async () => {
    const admin = adminPool(db);
    const before = await admin.query<{ credential_ref: string }>('SELECT credential_ref FROM mcp_servers WHERE id = $1', [alphaId]);
    const previous = before.rows[0]?.credential_ref ?? '';
    const rotated = await post(`/internal/v1/mcp/servers/${alphaId}/credential`, { credential: NEW_SECRET });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain(OLD_SECRET);
    expect(rotated.body).not.toContain(NEW_SECRET);
    const after = await admin.query<{ credential_ref: string }>('SELECT credential_ref FROM mcp_servers WHERE id = $1', [alphaId]);
    await admin.end();
    const current = after.rows[0]?.credential_ref ?? '';
    expect(current).not.toBe(previous);
    expect(current).not.toContain(OLD_SECRET);
    expect(current).not.toContain(NEW_SECRET);
    const store = createCredentialStore(credentialKey);
    expect(store.open(current)).toBe(NEW_SECRET);
    expect(store.open(current)).not.toBe(OLD_SECRET);
    const discovered = await post(`/internal/v1/mcp/servers/${alphaId}/discover`, {});
    expect(discovered.statusCode).toBe(200);
    const bearers = methods('/modern', 'tools/list').map((hit) => hit.authorization);
    expect(bearers.at(-1)).toBe(`Bearer ${NEW_SECRET}`);
    expect(lines.join('')).not.toContain(OLD_SECRET);
    expect(lines.join('')).not.toContain(NEW_SECRET);
  });

  it('refuses a legacy server on the modern path and discovers an explicit legacy server', async () => {
    const modern = await post('/internal/v1/mcp/servers', {
      serverKey: 'mixed',
      displayName: 'Mixed',
      endpoint: endpoint('/legacy'),
      credential: NEW_SECRET,
      protocolMode: 'modern',
    });
    const mixedId = (modern.json() as { server: { id: string } }).server.id;
    const beforeInitialize = methods('/legacy', 'initialize').length;
    const mismatch = await post(`/internal/v1/mcp/servers/${mixedId}/discover`, {});
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.body).toContain('The protocol version does not match.');
    expect(methods('/legacy', 'initialize').length).toBe(beforeInitialize);
    expect(methods('/legacy', 'tools/call').length).toBe(0);
    const legacy = await post('/internal/v1/mcp/servers', {
      serverKey: 'oldsrv',
      displayName: 'Old server',
      endpoint: endpoint('/legacy'),
      credential: NEW_SECRET,
      protocolMode: 'legacy',
    });
    const legacyId = (legacy.json() as { server: { id: string } }).server.id;
    const discovered = await post(`/internal/v1/mcp/servers/${legacyId}/discover`, {});
    expect(discovered.statusCode).toBe(200);
    const body = discovered.json() as { protocolVersion: string; toolCalls: number; tools: Array<{ namespacedName: string }> };
    expect(body.protocolVersion).toBe('2025-11-25');
    expect(body.toolCalls).toBe(0);
    expect(body.tools[0]?.namespacedName).toBe('oldsrv/legacy_search');
    expect(methods('/legacy', 'tools/call').length).toBe(0);
    evidence.api = { ...(evidence.api as object), legacy: body, mismatch: mismatch.json() };
  });

  it('hides another tenant, a denied tool, and a disabled server', async () => {
    const created = await post('/internal/v1/mcp/servers', {
      serverKey: 'shown',
      displayName: 'Shown',
      endpoint: endpoint('/modern'),
      credential: NEW_SECRET,
      protocolMode: 'modern',
    });
    const id = (created.json() as { server: { id: string } }).server.id;
    await post(`/internal/v1/mcp/servers/${id}/discover`, {});
    const hidden = await get('/internal/v1/mcp/catalog');
    const before = (hidden.json() as { catalog: Array<{ namespacedName: string }> }).catalog.map((item) => item.namespacedName);
    expect(before).not.toContain('shown/search');
    await post('/internal/v1/mcp/permissions', { serverId: id, remoteName: 'search', allowed: true });
    await post(`/internal/v1/mcp/servers/${id}/enabled`, { enabled: true });
    const exposed = await get('/internal/v1/mcp/catalog');
    expect((exposed.json() as { catalog: Array<{ namespacedName: string }> }).catalog.map((item) => item.namespacedName)).toContain('shown/search');
    await post(`/internal/v1/mcp/servers/${id}/enabled`, { enabled: false });
    const disabled = await get('/internal/v1/mcp/catalog');
    expect((disabled.json() as { catalog: Array<{ namespacedName: string }> }).catalog.map((item) => item.namespacedName)).not.toContain('shown/search');
    const foreign = await get('/internal/v1/mcp/servers', other);
    expect((foreign.json() as { servers: unknown[] }).servers).toEqual([]);
    const denied = await get(`/internal/v1/mcp/servers/${id}/tools`, other);
    expect(denied.statusCode).toBe(400);
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    const empty = await runtime.query('SELECT id FROM mcp_servers');
    expect(empty.rows).toEqual([]);
    await expect(runtime.query('SELECT credential_ref FROM mcp_servers')).rejects.toThrow();
    const isolated = await withTenant(runtime, other.tenantId, (client) => client.query('SELECT id FROM mcp_servers'));
    expect(isolated.rows).toEqual([]);
    await runtime.end();
    const health = await get(`/internal/v1/mcp/servers/${id}/health`);
    expect((health.json() as { serverKey: string; connectionStatus: string }).serverKey).toBe('shown');
    expect(health.body).not.toContain(NEW_SECRET);
    evidence.api = { ...(evidence.api as object), catalog: disabled.json(), health: health.json() };
    evidence.rls = { otherTenantServers: 0, runtimeRowsWithoutTenant: 0, credentialColumnDenied: true };
    const files = ['discovery-result.json', 'api-responses.json', 'mock-tests.json', 'rls-proof.json'];
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'discovery-result.json'), `${JSON.stringify(evidence.discovery ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'api-responses.json'), `${JSON.stringify(evidence.api ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'mock-tests.json'), `${JSON.stringify(evidence.mock ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'rls-proof.json'), `${JSON.stringify(evidence.rls ?? {}, null, 2)}\n`);
    const combined = files.map((name) => readFileSync(join(EVIDENCE, name), 'utf8')).join('\n');
    expect(combined).not.toContain(OLD_SECRET);
    expect(combined).not.toContain(NEW_SECRET);
    expect(combined).not.toContain('PRIVATE KEY');
  });
});
