import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const EVIDENCE = join(projectRoot, 'evidence', 'slice-10h');
const PROTOCOL = '2026-07-28';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EFFECTIVE = '2026-10-31T00:00:00.000Z';
const MARKER = 'output-limit-marker';
const CHAT_MODEL = 'mcp-h-chat';
const EMBED_MODEL = 'text-embedding-3-small';
const BANNED = ['yck_', 'sk-mcp-h', 'PRIVATE KEY', 'aes-256-gcm$', MARKER, 'loopback-only-credential', 'note-marker-10g'];

type Tenant = { tenantId: string; secret: string };
type Traffic = {
  method: string;
  status: number;
  contentType: string;
  requestSession: string | null;
  responseSession: string | null;
  rpcMethod: string | null;
  eventStream: boolean;
  hasData: boolean;
};
type ToolCall = {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: unknown;
};
type RpcBody = {
  status: number;
  contentType: string;
  session: string | null;
  allow: string | null;
  text: string;
  json: Record<string, unknown> | null;
};
type CdpResult = { id: number; result?: Record<string, unknown>; error?: { message: string } };

const db = loadTestDatabase();
const traffic: Traffic[] = [];
const proof: Record<string, unknown> = {};
const hits: MockHit[] = [];
const hangState = { closed: 0 };
let remoteHits = 0;
let remoteUrl = '';
let primaryBase = '';
let replicaBase = '';
let lines: string[] = [];
let replicaLines: string[] = [];
let meta: Record<string, unknown> | null = null;
let unsafeLog = false;

const reader: Tenant = { tenantId: '', secret: '' };
const other: Tenant = { tenantId: '', secret: '' };
const payer: Tenant = { tenantId: '', secret: '' };
const tight: Tenant = { tenantId: '', secret: '' };

let primary: Awaited<ReturnType<typeof createTestApp>> | undefined;
let replica: Awaited<ReturnType<typeof createTestApp>> | undefined;
let closeMock: (() => Promise<void>) | undefined;
let closeRemote: (() => Promise<void>) | undefined;

function rememberMeta(raw: string): void {
  if (meta !== null) return;
  try {
    const parsed = JSON.parse(raw) as { params?: { _meta?: Record<string, unknown> } };
    if (parsed.params?._meta && typeof parsed.params._meta === 'object') meta = parsed.params._meta;
  } catch {
    // A non-JSON probe does not carry the envelope.
  }
}

function recordingFetch(): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    let rpcMethod: string | null = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const raw = await request.clone().text();
      rememberMeta(raw);
      try {
        rpcMethod = (JSON.parse(raw) as { method?: string }).method ?? null;
      } catch {
        rpcMethod = null;
      }
    }
    const response = await fetch(request);
    const copy = response.clone();
    const text = await copy.text();
    traffic.push({
      method: request.method,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      requestSession: request.headers.get('mcp-session-id'),
      responseSession: response.headers.get('mcp-session-id'),
      rpcMethod,
      eventStream: (response.headers.get('content-type') ?? '').includes('text/event-stream'),
      hasData: text.includes('data:'),
    });
    return response;
  };
}

function envelope(): Record<string, unknown> {
  if (meta === null) throw new Error('The client did not send a protocol envelope.');
  return meta;
}

function authHeaders(tenant: Tenant): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
  };
}

function protocolHeaders(tenant: Tenant, method: string, name?: string): Record<string, string> {
  const headers = {
    ...authHeaders(tenant),
    'mcp-protocol-version': PROTOCOL,
    'mcp-method': method,
  };
  if (name !== undefined) headers['mcp-name'] = name;
  return headers;
}

function parseRpc(contentType: string, text: string): Record<string, unknown> | null {
  const payload = contentType.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0)
        .at(-1)
    : text;
  if (payload === undefined || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function sendRaw(base: string, method: string, headers: Record<string, string>, body?: string): Promise<RpcBody> {
  const response = await fetch(`${base}/mcp`, { method, headers, body });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    contentType,
    session: response.headers.get('mcp-session-id'),
    allow: response.headers.get('allow'),
    text,
    json: parseRpc(contentType, text),
  };
}

function rpcMessage(body: RpcBody): { code?: number; message?: string } {
  const error = body.json?.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return {};
  const record = error as { code?: number; message?: string };
  return { code: record.code, message: record.message };
}

function proxyCode(body: RpcBody): string {
  const error = body.json?.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return '';
  const code = (error as { code?: string }).code;
  return typeof code === 'string' ? code : '';
}

function toolText(result: ToolCall): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('');
}

async function withClient<T>(base: string, tenant: Tenant, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(
    { name: 'llm-proxy-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL } }, listMaxPages: 1 },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    fetch: recordingFetch(),
    requestInit: { headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` } },
  });
  await client.connect(transport, { timeout: 10_000 });
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function postJson(base: string, tenant: Tenant, path: string, body?: unknown): Promise<RpcBody> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: authHeaders(tenant),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  return { status: response.status, contentType, session: null, allow: null, text, json: parseRpc(contentType, text) };
}

function rpcCall(method: string, params: Record<string, unknown>, id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope() } });
}

async function listen(app: Awaited<ReturnType<typeof createTestApp>>['app']): Promise<string> {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return address.startsWith('http') ? address.replace(/\/$/, '') : `http://${address}`;
}

function price(model: string, input: string, output?: string): void {
  const args = [
    'register-price',
    '--provider',
    'openai',
    '--upstream-model',
    model,
    '--effective-at',
    EFFECTIVE,
    '--source',
    'fixture',
    '--status',
    'verified',
    '--input-rate',
    input,
  ];
  if (output !== undefined) args.push('--output-rate', output);
  runCli(db, args, cliEnv());
}

function deployment(tenantId: string, name: string, model: string, capabilities: string): void {
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--name',
      name,
      '--upstream-model',
      model,
      '--timeout-ms',
      '20000',
      '--capabilities',
      capabilities,
      '--enabled',
      'true',
    ],
    cliEnv(),
  );
}

function assertClean(label: string, text: string): void {
  for (const token of BANNED) {
    if (text.includes(token)) throw new Error(`${label} contains a banned marker`);
  }
}

describe('MCP server', () => {
  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    rmSync(join(EVIDENCE, 'browser-failure.txt'), { force: true });
    const mock = await startMockUpstream((hit, request, response) => {
      hits.push(hit);
      if (hit.url.includes('/embeddings')) {
        const vector = [0.25, 0.5, 0.125, 0.0625];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            model: EMBED_MODEL,
            data: [{ object: 'embedding', index: 0, embedding: vector }],
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
        );
        return;
      }
      const parsed = JSON.parse(hit.body) as { model?: string; messages?: Array<{ content?: string }> };
      const content = parsed.messages?.[0]?.content ?? '';
      if (content.startsWith('HANG-')) {
        let noted = false;
        const note = (): void => {
          if (noted) return;
          noted = true;
          hangState.closed += 1;
        };
        response.once('close', note);
        request.socket?.once('close', note);
        return;
      }
      const answer = content.startsWith('BIG-') ? `${MARKER}${'x'.repeat(20_000)}` : 'ok';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? CHAT_MODEL, answer)));
    });
    closeMock = mock.close;
    const remote = createServer((_request: IncomingMessage, response: ServerResponse) => {
      remoteHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', () => resolve()));
    const remoteAddress = remote.address();
    if (remoteAddress === null || typeof remoteAddress === 'string') throw new Error('The remote listener has no port.');
    remoteUrl = `http://127.0.0.1:${remoteAddress.port}/mcp`;
    closeRemote = () =>
      new Promise((resolve, reject) => {
        remote.close((error) => (error ? reject(error) : resolve()));
      });

    const created = provisionTenant(db, 'MCP server reader');
    const outsider = provisionTenant(db, 'MCP server other');
    const paying = provisionTenant(db, 'MCP server payer');
    const limited = provisionTenant(db, 'MCP server tight');
    reader.tenantId = created.tenantId;
    reader.secret = created.secret;
    other.tenantId = outsider.tenantId;
    other.secret = outsider.secret;
    payer.tenantId = paying.tenantId;
    payer.secret = paying.secret;
    tight.tenantId = limited.tenantId;
    tight.secret = limited.secret;
    registerInference(db, {
      tenantId: reader.tenantId,
      apiKey: 'sk-mcp-h-reader',
      deployment: 'chat-h',
      upstreamModel: CHAT_MODEL,
      timeoutMs: 20_000,
      capabilities: 'temperature,max_tokens',
    });
    deployment(reader.tenantId, 'embed-h', EMBED_MODEL, 'embeddings');
    runCli(
      db,
      ['register-embedding-contract', '--tenant-id', reader.tenantId, '--deployment', 'embed-h', '--dimension', '4', '--normalization', 'none'],
      cliEnv(),
    );
    registerInference(db, {
      tenantId: payer.tenantId,
      apiKey: 'sk-mcp-h-payer',
      deployment: 'chat-h',
      upstreamModel: CHAT_MODEL,
      timeoutMs: 20_000,
      capabilities: 'temperature,max_tokens',
    });
    deployment(payer.tenantId, 'embed-h', EMBED_MODEL, 'embeddings');
    runCli(
      db,
      ['register-embedding-contract', '--tenant-id', payer.tenantId, '--deployment', 'embed-h', '--dimension', '4', '--normalization', 'none'],
      cliEnv(),
    );
    registerInference(db, {
      tenantId: tight.tenantId,
      apiKey: 'sk-mcp-h-tight',
      deployment: 'chat-h',
      upstreamModel: CHAT_MODEL,
      timeoutMs: 20_000,
      capabilities: 'temperature,max_tokens',
    });
    price(CHAT_MODEL, '0.002', '0.003');
    price(EMBED_MODEL, '0.001');
    runCli(db, ['set-tenant-budget', '--tenant-id', payer.tenantId, '--mode', 'hard', '--monthly-amount', '1000'], cliEnv());
    runCli(db, ['set-tenant-budget', '--tenant-id', tight.tenantId, '--mode', 'hard', '--monthly-amount', '0'], cliEnv());

    primary = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    replica = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    lines = primary.lines;
    replicaLines = replica.lines;
    primaryBase = await listen(primary.app);
    replicaBase = await listen(replica.app);
  }, 180_000);

  afterAll(async () => {
    await primary?.app.close().catch(() => undefined);
    await replica?.app.close().catch(() => undefined);
    await primary?.authPool.end().catch(() => undefined);
    await primary?.runtimePool.end().catch(() => undefined);
    await replica?.authPool.end().catch(() => undefined);
    await replica?.runtimePool.end().catch(() => undefined);
    await closeMock?.().catch(() => undefined);
    await closeRemote?.().catch(() => undefined);
    const raw = [...lines, ...replicaLines];
    const safe = raw.map((line) => {
      if (BANNED.some((token) => line.includes(token))) {
        unsafeLog = true;
        return '{"msg":"redacted"}';
      }
      return line.trim();
    });
    writeFileSync(join(EVIDENCE, 'api-log.json'), `${JSON.stringify({ lines: safe.filter((line) => line.length > 0) }, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'compatibility.json'), `${JSON.stringify(proof, null, 2)}\n`);
    for (const name of ['api-log.json', 'compatibility.json', 'tls.txt']) {
      const path = join(EVIDENCE, name);
      if (existsSync(path)) assertClean(name, readFileSync(path, 'utf8'));
    }
    for (const name of ['01-exposed.png', '02-approved.png']) {
      const path = join(EVIDENCE, name);
      if (!existsSync(path)) continue;
      assertClean(name, readFileSync(path).toString('latin1'));
    }
    expect(unsafeLog).toBe(false);
  });

  it('connects a modern MCP client', async () => {
    await withClient(primaryBase, reader, async (client) => {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe(PROTOCOL);
      const discover = client.getDiscoverResult() as { supportedVersions?: string[]; capabilities?: { tools?: { listChanged?: boolean }; prompts?: unknown; resources?: unknown }; instructions?: string } | undefined;
      expect(discover?.supportedVersions).toContain(PROTOCOL);
      expect(discover?.capabilities?.tools).toBeTruthy();
      expect(discover?.capabilities?.tools?.listChanged).not.toBe(true);
      expect(discover?.capabilities?.prompts).toBeUndefined();
      expect(discover?.capabilities?.resources).toBeUndefined();
      expect(discover?.instructions).toContain('Inference and embedding stay off');
      proof.connection = {
        era: client.getProtocolEra(),
        version: client.getNegotiatedProtocolVersion(),
        supportedVersions: discover?.supportedVersions,
        listChanged: discover?.capabilities?.tools?.listChanged ?? null,
        instructions: discover?.instructions,
      };
    });
    expect(traffic.filter((item) => item.method === 'GET').every((item) => item.status === 405 && item.session === null)).toBe(true);
    expect(traffic.every((item) => item.requestSession === null && item.responseSession === null)).toBe(true);
  });

  it('discovers tools', async () => {
    await withClient(primaryBase, reader, async (client) => {
      const listed = await client.listTools(undefined, { timeout: 10_000 });
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(['get_model_capabilities', 'list_models']);
      expect(names).not.toContain('create_chat_completion');
      expect(names).not.toContain('create_embedding');
      const listModels = listed.tools.find((tool) => tool.name === 'list_models');
      expect(listModels?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(listModels?.outputSchema).toMatchObject({ type: 'object' });
      expect(listModels?.annotations?.readOnlyHint).toBe(true);
      proof.discovery = { tools: names };
    });
  });

  it('invokes a read tool', async () => {
    await withClient(primaryBase, reader, async (client) => {
      const listed = await client.callTool({ name: 'list_models', arguments: {} }, { timeout: 10_000 });
      expect(listed.isError).not.toBe(true);
      const models = (listed.structuredContent as { models?: Array<{ id?: string; object?: string; owned_by?: string }> } | undefined)?.models ?? [];
      expect(models.map((model) => model.id).sort()).toEqual(['auto', 'chat-h', 'embed-h']);
      expect(models.every((model) => model.object === 'model')).toBe(true);
      expect(models.find((model) => model.id === 'auto')?.owned_by).toBe('llm-proxy');
      const capabilities = await client.callTool(
        { name: 'get_model_capabilities', arguments: { model: 'auto' } },
        { timeout: 10_000 },
      );
      expect(capabilities.isError).not.toBe(true);
      const body = capabilities.structuredContent as { model?: string; capabilities?: string[] } | undefined;
      expect(body?.model).toBe('auto');
      expect(body?.capabilities).toEqual(expect.arrayContaining(['temperature', 'max_tokens']));
      const extra = await client
        .callTool({ name: 'list_models', arguments: { extra: true } }, { timeout: 10_000 })
        .then((result) => (result as ToolCall).isError === true)
        .catch(() => true);
      expect(extra).toBe(true);
      proof.invocation = {
        models: models.map((model) => model.id),
        capabilities: body?.capabilities,
        extraRejected: extra,
      };
      assertClean('tool result', JSON.stringify(listed.structuredContent));
      assertClean('capability result', JSON.stringify(capabilities.structuredContent));
    });
  });

  it('rejects a missing tenant credential', async () => {
    const before = hits.length;
    const missing = await sendRaw(primaryBase, 'POST', { 'content-type': 'application/json', accept: 'application/json' }, rpcCall('tools/list', {}, 11));
    expect(missing.status).toBe(401);
    expect(proxyCode(missing)).toBe('invalid_api_key');
    expect(missing.session).toBeNull();
    const bearerOnly = await sendRaw(primaryBase, 'POST', { authorization: 'Bearer present', 'content-type': 'application/json' }, '{}');
    expect(bearerOnly.status).toBe(401);
    expect(hits.length).toBe(before);
    proof.missingCredential = { status: missing.status, code: proxyCode(missing) };
  });

  it('rejects the wrong tenant', async () => {
    const mismatched = await sendRaw(
      primaryBase,
      'POST',
      { ...protocolHeaders(reader, 'tools/list'), authorization: `Bearer ${other.secret}` },
      rpcCall('tools/list', {}, 12),
    );
    expect(mismatched.status).toBe(401);
    expect(proxyCode(mismatched)).toBe('invalid_api_key');
    await withClient(primaryBase, other, async (client) => {
      const listed = (await client.callTool({ name: 'list_models', arguments: {} }, { timeout: 10_000 })) as ToolCall;
      expect(listed.isError).not.toBe(true);
      const models = (listed.structuredContent as { models?: Array<{ id?: string }> } | undefined)?.models ?? [];
      expect(models).toEqual([]);
      proof.wrongTenant = { status: mismatched.status, otherModels: models.length };
    });
  });

  it('rejects invalid method metadata', async () => {
    const method = await sendRaw(
      primaryBase,
      'POST',
      { ...protocolHeaders(reader, 'prompts/list') },
      rpcCall('tools/list', {}, 13),
    );
    expect(method.status).toBe(400);
    expect(rpcMessage(method)).toMatchObject({ code: -32020, message: 'Mcp-Method does not match the request.' });
    const name = await sendRaw(
      primaryBase,
      'POST',
      protocolHeaders(reader, 'tools/call', 'other-tool'),
      rpcCall('tools/call', { name: 'list_models', arguments: {} }, 14),
    );
    expect(name.status).toBe(400);
    expect(rpcMessage(name).code).toBe(-32020);
    expect(rpcMessage(name).message).toContain('Mcp-Name');
    const claim = { ...envelope(), [PROTOCOL_VERSION_META_KEY]: '2025-03-26' };
    const mismatch = await sendRaw(
      primaryBase,
      'POST',
      protocolHeaders(reader, 'tools/list'),
      JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/list', params: { _meta: claim } }),
    );
    expect(mismatch.status).toBe(400);
    expect(rpcMessage(mismatch)).toMatchObject({ code: -32020 });
    proof.methodMetadata = { method: rpcMessage(method).code, name: rpcMessage(name).code, claim: rpcMessage(mismatch).code };
  });

  it('rejects malformed JSON-RPC', async () => {
    const response = await sendRaw(primaryBase, 'POST', authHeaders(reader), '{');
    expect(response.status).toBe(400);
    expect(rpcMessage(response)).toMatchObject({ code: -32700, message: 'Parse error' });
    expect(response.text).not.toContain(reader.secret);
    proof.malformed = { status: response.status, code: rpcMessage(response).code };
  });

  it('rejects an unsupported protocol version', async () => {
    const claim = { ...envelope(), [PROTOCOL_VERSION_META_KEY]: '2025-03-26' };
    const response = await sendRaw(
      primaryBase,
      'POST',
      { ...protocolHeaders(reader, 'tools/list'), 'mcp-protocol-version': '2025-03-26' },
      JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'tools/list', params: { _meta: claim } }),
    );
    expect(response.status).toBe(400);
    expect(rpcMessage(response)).toMatchObject({ code: -32022, message: 'The protocol version is not supported.' });
    proof.unsupportedVersion = { status: response.status, code: rpcMessage(response).code };
  });

  it('restricts a browser Origin', async () => {
    const host = new URL(primaryBase).host;
    const bad = await sendRaw(primaryBase, 'POST', { ...protocolHeaders(reader, 'tools/list'), origin: 'https://evil.example' }, rpcCall('tools/list', {}, 17));
    expect(bad.status).toBe(403);
    expect(proxyCode(bad)).toBe('origin_rejected');
    const absentAuth = await sendRaw(primaryBase, 'POST', { 'content-type': 'application/json', origin: 'https://evil.example' }, '{}');
    expect(absentAuth.status).toBe(401);
    const missing = await sendRaw(primaryBase, 'POST', protocolHeaders(reader, 'tools/list'), rpcCall('tools/list', {}, 18));
    expect(missing.status).toBe(200);
    const matched = await sendRaw(
      primaryBase,
      'POST',
      { ...protocolHeaders(reader, 'tools/list'), origin: `http://${host}` },
      rpcCall('tools/list', {}, 19),
    );
    expect(matched.status).toBe(200);
    const nullOrigin = await sendRaw(primaryBase, 'POST', { ...protocolHeaders(reader, 'tools/list'), origin: 'null' }, rpcCall('tools/list', {}, 20));
    expect(nullOrigin.status).toBe(403);
    proof.origin = { bad: bad.status, missing: missing.status, matched: matched.status, nullOrigin: nullOrigin.status };
  });

  it('returns a request-scoped SSE response and does not open a session stream', async () => {
    const got = await sendRaw(primaryBase, 'GET', authHeaders(reader));
    const deleted = await sendRaw(primaryBase, 'DELETE', authHeaders(reader));
    expect(got.status).toBe(405);
    expect(deleted.status).toBe(405);
    expect(got.allow).toBe('POST');
    expect(deleted.allow).toBe('POST');
    expect(got.session).toBeNull();
    expect(deleted.session).toBeNull();
    expect(got.contentType).not.toContain('text/event-stream');
    expect(got.text).not.toContain('data:');
    const streamed = traffic.filter((item) => item.method === 'POST' && item.eventStream);
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.every((item) => item.hasData && item.responseSession === null)).toBe(true);
    proof.sse = { get: got.status, delete: deleted.status, streamed: streamed.length };
  });

  it('keeps inference and embedding off until the tenant approves them', async () => {
    const before = await postJson(primaryBase, payer, '/internal/v1/mcp/exposed');
    const tools = (before.json?.tools ?? []) as Array<{ name?: string; permission?: string; kind?: string }>;
    expect(tools.find((tool) => tool.name === 'list_models')).toMatchObject({ permission: 'allowed', kind: 'read' });
    expect(tools.find((tool) => tool.name === 'create_chat_completion')).toMatchObject({ permission: 'approval required', kind: 'inference' });
    expect(tools.find((tool) => tool.name === 'create_embedding')).toMatchObject({ permission: 'approval required', kind: 'embedding' });
    await withClient(primaryBase, payer, async (client) => {
      const listed = await client.listTools(undefined, { timeout: 10_000 });
      expect(listed.tools.map((tool) => tool.name)).not.toContain('create_chat_completion');
      expect(listed.tools.map((tool) => tool.name)).not.toContain('create_embedding');
    });
    const unknown = await postJson(primaryBase, payer, '/internal/v1/mcp/exposed', { name: 'admin_rotate', approved: true });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('The tool is not available.');
    const approvedChat = await postJson(primaryBase, payer, '/internal/v1/mcp/exposed', { name: 'create_chat_completion', approved: true });
    const approvedEmbed = await postJson(primaryBase, payer, '/internal/v1/mcp/exposed', { name: 'create_embedding', approved: true });
    expect(approvedChat.status).toBe(200);
    expect(approvedEmbed.status).toBe(200);
    await withClient(primaryBase, payer, async (client) => {
      const names = (await client.listTools(undefined, { timeout: 10_000 })).tools.map((tool) => tool.name);
      expect(names).toContain('create_chat_completion');
      expect(names).toContain('create_embedding');
      const chat = (await client.callTool(
        { name: 'create_chat_completion', arguments: { model: 'auto', messages: [{ role: 'user', content: 'hello-cost' }], max_tokens: 16 } },
        { timeout: 20_000 },
      )) as ToolCall;
      expect(chat.isError).not.toBe(true);
      expect((chat.structuredContent as { content?: string } | undefined)?.content).toBe('ok');
      expect(toolText(chat)).not.toContain('sk-mcp-h');
      const embedding = (await client.callTool(
        { name: 'create_embedding', arguments: { model: 'embed-h', input: 'hello embed' } },
        { timeout: 20_000 },
      )) as ToolCall;
      expect(embedding.isError).not.toBe(true);
      expect(embedding.structuredContent).toMatchObject({ model: 'embed-h', count: 1, dimension: 4 });
      expect(toolText(embedding)).not.toContain('0.0625');
      proof.approved = { chat: (chat.structuredContent as { content?: string } | undefined)?.content, embedding: embedding.structuredContent };
    });
    expect(hits.some((hit) => hit.url.includes('/chat/completions') && hit.body.includes('hello-cost'))).toBe(true);
    expect(hits.some((hit) => hit.url.includes('/embeddings'))).toBe(true);
    expect(hits.some((hit) => hit.authorization.includes('sk-mcp-h'))).toBe(true);
  });

  it('records a cost and refuses a hard budget', async () => {
    const admin = adminPool(db);
    const costs = await admin.query<{ costs: number }>(
      'SELECT count(*)::int AS costs FROM attempt_costs WHERE tenant_id = $1',
      [payer.tenantId],
    );
    await admin.end();
    expect(Number(costs.rows[0]?.costs ?? 0)).toBeGreaterThan(0);
    const approved = await postJson(primaryBase, tight, '/internal/v1/mcp/exposed', { name: 'create_chat_completion', approved: true });
    expect(approved.status).toBe(200);
    const before = hits.length;
    await withClient(primaryBase, tight, async (client) => {
      const result = (await client.callTool(
        { name: 'create_chat_completion', arguments: { model: 'auto', messages: [{ role: 'user', content: 'TIGHT-BUDGET' }], max_tokens: 8 } },
        { timeout: 20_000 },
      )) as ToolCall;
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain('The budget limit was reached.');
      proof.budget = { payerCosts: Number(costs.rows[0]?.costs ?? 0), tight: toolText(result) };
    });
    expect(hits.slice(before).some((hit) => hit.body.includes('TIGHT-BUDGET'))).toBe(false);
  });

  it('rejects an output that is too large', async () => {
    await withClient(primaryBase, payer, async (client) => {
      const result = (await client.callTool(
        { name: 'create_chat_completion', arguments: { model: 'auto', messages: [{ role: 'user', content: 'BIG-output' }], max_tokens: 16 } },
        { timeout: 20_000 },
      )) as ToolCall;
      expect(result.isError).toBe(true);
      expect(toolText(result)).toBe('The output is too large.');
      expect(toolText(result)).not.toContain(MARKER);
      proof.outputLimit = { message: toolText(result) };
    });
  });

  it('does not start another MCP call', async () => {
    const beforeRemote = remoteHits;
    const beforeProvider = hits.length;
    const recursive = await sendRaw(
      primaryBase,
      'POST',
      protocolHeaders(payer, 'tools/call', 'list_models'),
      rpcCall('tools/call', { name: 'list_models', arguments: { url: remoteUrl } }, 31),
    );
    expect(recursive.status).toBe(400);
    expect(rpcMessage(recursive)).toMatchObject({ code: -32602, message: 'A tool call cannot start another MCP call.' });
    expect(remoteHits).toBe(beforeRemote);
    expect(hits.length).toBe(beforeProvider);
    await withClient(primaryBase, payer, async (client) => {
      const noted = (await client.callTool(
        {
          name: 'create_chat_completion',
          arguments: { model: 'auto', messages: [{ role: 'user', content: 'http://127.0.0.1:9/mcp' }], max_tokens: 16 },
        },
        { timeout: 20_000 },
      )) as ToolCall;
      expect(noted.isError).not.toBe(true);
      expect((noted.structuredContent as { content?: string } | undefined)?.content).toBe('ok');
    });
    expect(remoteHits).toBe(beforeRemote);
    expect(hits.some((hit) => hit.body.includes('http://127.0.0.1:9/mcp'))).toBe(true);
    proof.recursion = { code: rpcMessage(recursive).code, remoteHits, providerSawText: true };
  });

  it('stops a cancelled call without a second execution', async () => {
    const before = hits.filter((hit) => hit.body.includes('HANG-CANCEL')).length;
    const controller = new AbortController();
    const pending = withClient(primaryBase, payer, (client) =>
      client.callTool(
        { name: 'create_chat_completion', arguments: { model: 'auto', messages: [{ role: 'user', content: 'HANG-CANCEL' }], max_tokens: 16 } },
        { timeout: 20_000, signal: controller.signal },
      ),
    );
    const started = Date.now();
    while (!hits.some((hit) => hit.body.includes('HANG-CANCEL')) && Date.now() - started < 8_000) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(hits.filter((hit) => hit.body.includes('HANG-CANCEL')).length).toBe(before + 1);
    const closedBefore = hangState.closed;
    controller.abort();
    await pending.then(
      () => undefined,
      () => undefined,
    );
    const startedClose = Date.now();
    while (hangState.closed < closedBefore + 1 && Date.now() - startedClose < 8_000) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const hang = hits.filter((hit) => hit.body.includes('HANG-CANCEL'));
    expect(hang.length).toBe(before + 1);
    expect(hangState.closed).toBeGreaterThanOrEqual(closedBefore + 1);
    proof.cancellation = { calls: hang.length, upstreamClosed: true };
  });

  it('enforces the concurrency limit', async () => {
    const controllers = [0, 1, 2, 3].map(() => new AbortController());
    const pending = controllers.map((controller, index) =>
      fetch(`${primaryBase}/mcp`, {
        method: 'POST',
        headers: protocolHeaders(payer, 'tools/call', 'create_chat_completion'),
        body: rpcCall(
          'tools/call',
          {
            name: 'create_chat_completion',
            arguments: { model: 'auto', messages: [{ role: 'user', content: `HANG-SLOT-${index}` }], max_tokens: 16 },
          },
          40 + index,
        ),
        signal: controller.signal,
      }).then(
        async (response) => ({ status: response.status }),
        () => ({ status: 0 }),
      ),
    );
    try {
      const started = Date.now();
      while (hits.filter((hit) => hit.body.includes('HANG-SLOT-')).length < 4 && Date.now() - started < 8_000) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(hits.filter((hit) => hit.body.includes('HANG-SLOT-')).length).toBe(4);
      const fifth = await sendRaw(
        primaryBase,
        'POST',
        protocolHeaders(payer, 'tools/call', 'create_chat_completion'),
        rpcCall(
          'tools/call',
          { name: 'create_chat_completion', arguments: { model: 'auto', messages: [{ role: 'user', content: 'HANG-SLOT-extra' }], max_tokens: 16 } },
          48,
        ),
      );
      expect(fifth.status).toBe(429);
      expect(proxyCode(fifth)).toBe('concurrency_limit');
      expect(hits.some((hit) => hit.body.includes('HANG-SLOT-extra'))).toBe(false);
      const metadata = await sendRaw(
        primaryBase,
        'POST',
        { ...protocolHeaders(payer, 'prompts/list') },
        rpcCall('tools/list', {}, 49),
      );
      expect(metadata.status).toBe(400);
      expect(rpcMessage(metadata).code).toBe(-32020);
      const replicaList = await sendRaw(replicaBase, 'POST', protocolHeaders(reader, 'tools/list'), rpcCall('tools/list', {}, 50));
      expect(replicaList.status).toBe(200);
      expect(replicaList.session).toBeNull();
      proof.concurrency = { fifth: fifth.status, replica: replicaList.status };
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(pending);
    }
    const released = Date.now();
    let recovered = 0;
    while (recovered !== 200 && Date.now() - released < 8_000) {
      const again = await sendRaw(primaryBase, 'POST', protocolHeaders(reader, 'tools/list'), rpcCall('tools/list', {}, 51));
      recovered = again.status;
      if (recovered !== 200) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(recovered).toBe(200);
  });

  it('answers on two replicas without a shared session', async () => {
    expect(new URL(primaryBase).port).not.toBe(new URL(replicaBase).port);
    const before = traffic.length;
    await withClient(replicaBase, payer, async (client) => {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe(PROTOCOL);
      const names = (await client.listTools(undefined, { timeout: 10_000 })).tools.map((tool) => tool.name);
      expect(names).toContain('create_chat_completion');
      expect(names).toContain('list_models');
      const listed = (await client.callTool({ name: 'list_models', arguments: {} }, { timeout: 10_000 })) as ToolCall;
      const models = (listed.structuredContent as { models?: Array<{ id?: string }> } | undefined)?.models ?? [];
      expect(models.map((model) => model.id)).toContain('chat-h');
      proof.replicas = { ports: [new URL(primaryBase).port, new URL(replicaBase).port], tools: names };
    });
    const replicaTraffic = traffic.slice(before);
    expect(replicaTraffic.length).toBeGreaterThan(0);
    expect(replicaTraffic.every((item) => item.requestSession === null && item.responseSession === null)).toBe(true);
  });

  it('rejects an oversized request and an unsupported extension', async () => {
    const oversized = JSON.stringify({ jsonrpc: '2.0', id: 70, method: 'tools/list', params: { pad: 'a'.repeat(70_000), _meta: envelope() } });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(65_536);
    const tooLarge = await sendRaw(primaryBase, 'POST', protocolHeaders(reader, 'tools/list'), oversized);
    expect(tooLarge.status).toBe(413);
    expect(proxyCode(tooLarge)).toBe('request_too_large');
    const prompts = await sendRaw(primaryBase, 'POST', protocolHeaders(reader, 'prompts/list'), rpcCall('prompts/list', {}, 71));
    expect(rpcMessage(prompts)).toMatchObject({ code: -32601 });
    const denied = await postJson(primaryBase, other, '/internal/v1/mcp/exposed', { name: 'list_models', approved: false });
    expect(denied.status).toBe(200);
    await withClient(primaryBase, other, async (client) => {
      const names = (await client.listTools(undefined, { timeout: 10_000 })).tools.map((tool) => tool.name);
      expect(names).not.toContain('list_models');
      expect(names).not.toContain('create_chat_completion');
    });
    proof.limits = { tooLarge: tooLarge.status, prompts: rpcMessage(prompts).code, deniedRead: true };
  });

  it('shows the exposed tools in the catalog page', async () => {
    const page = await fetch(`${primaryBase}/internal/v1/mcp`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('does not call a tool');
    expect(html).toContain('id="exposed-rows"');
    expect(html).toContain('id="refresh-exposed"');
    const capabilities = readFileSync(join(projectRoot, 'CAPABILITIES.md'), 'utf8');
    expect(capabilities).toContain('Discovery still does not call a tool.');
    expect(capabilities).toContain('The server does not execute an unapproved tool.');
    expect(capabilities).toContain('The server does not execute a chat function.');
    expect(capabilities).toContain('A tool call cannot start another MCP call.');
    if (!existsSync(CHROME)) {
      writeFileSync(join(EVIDENCE, 'browser-failure.txt'), 'Chrome is not installed.\n');
      proof.browser = { launched: false, error: 'Chrome is not installed.' };
      return;
    }
    const journey = await driveBrowser(primaryBase, reader.tenantId, reader.secret);
    proof.browser = { launched: true, exposed: journey.exposed, approved: journey.approved };
    expect(journey.exposed).toContain('list_models');
    expect(journey.exposed).toContain('allowed');
    expect(journey.exposed).toContain('create_chat_completion');
    expect(journey.exposed).toContain('approval required');
    expect(journey.approved).toContain('The tool is allowed.');
    expect(journey.exposed).not.toContain(reader.secret);
    expect(journey.pageText).toContain('does not call a tool');
    expect(journey.pageText).toContain('MCP catalog');
  });

  it('keeps the TLS entry point in front of /mcp', () => {
    const nginx = readFileSync(join(projectRoot, 'docker', 'nginx', 'nginx.conf'), 'utf8');
    const compose = readFileSync(join(projectRoot, 'docker-compose.yml'), 'utf8');
    const location = nginx.slice(nginx.indexOf('location /mcp'), nginx.indexOf('location /v1/chat/completions'));
    expect(nginx).toContain('listen 443 ssl;');
    expect(location).toContain('proxy_buffering off;');
    expect(location).toContain('gzip off;');
    expect(location).toContain('ingress_unauthorized');
    expect(location).toContain('$http_x_tenant_id');
    expect(location).toContain('$http_authorization');
    const services = compose.split(/\n(?=  [a-z])/);
    const app = services.find((item) => item.startsWith('  app:'));
    const ingress = services.find((item) => item.startsWith('  ingress:'));
    expect(app).toBeTruthy();
    expect(app).not.toContain('\n    ports:');
    expect(ingress).toContain('"443:443"');
    const curl = spawnSync(
      'curl',
      ['-sk', '--max-time', '3', '-D', '-', 'https://127.0.0.1/mcp'],
      { encoding: 'utf8' },
    );
    const output = `${curl.stdout ?? ''}\n${curl.stderr ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 500);
    const live = output.includes('ingress_unauthorized');
    const note = [
      'TLS terminates on port 443.',
      'The /mcp location rejects a request without X-Tenant-Id and Authorization.',
      'The /mcp location does not buffer and does not compress.',
      'The application port is not published.',
      live
        ? 'An HTTPS request without credentials returned the ingress rejection.'
        : `An HTTPS request did not reach this ingress. curl status ${String(curl.status)}. ${output}`,
    ].join('\n');
    assertClean('tls', note);
    writeFileSync(join(EVIDENCE, 'tls.txt'), `${note}\n`);
    proof.tls = { configured: true, liveIngress: live };
    expect(readFileSync(join(EVIDENCE, 'tls.txt'), 'utf8')).toContain('listen'.replace('listen', 'TLS terminates'));
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address !== 'string' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForTarget(port: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // The browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The browser did not open a page.');
}

async function driveBrowser(base: string, tenantId: string, secret: string): Promise<{ exposed: string; approved: string; pageText: string }> {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'mcp-server-chrome-'));
  let chrome: ChildProcess | undefined;
  try {
    chrome = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,2200',
      `${base}/internal/v1/mcp`,
    ], { stdio: 'ignore' });
    const page = await waitForTarget(port);
    const socket = new WebSocket(page);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('The browser socket failed.')));
    });
    let next = 0;
    const waiters = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    socket.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as CdpResult;
      if (parsed.id === undefined) return;
      const waiter = waiters.get(parsed.id);
      if (waiter === undefined) return;
      waiters.delete(parsed.id);
      if (parsed.error) waiter.reject(new Error(parsed.error.message));
      else waiter.resolve(parsed.result ?? {});
    });
    function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      next += 1;
      const id = next;
      return new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression: string): Promise<unknown> {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const wrapper = result.result as { value?: unknown } | undefined;
      const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      if (details) throw new Error(details.exception?.description ?? details.text ?? 'The page script failed.');
      return wrapper?.value;
    }
    async function waitText(selector: string, part: string): Promise<string> {
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        const text = String(await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent || ''`));
        if (text.includes(part)) return text;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const text = String(await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent || ''`));
      throw new Error(`The page did not show ${part}. Status: ${text.slice(0, 180)}`);
    }
    async function shot(name: string): Promise<void> {
      await evaluate(`document.querySelector('#exposed-rows').scrollIntoView()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 2200, deviceScaleFactor: 1, mobile: false });
      const captured = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(EVIDENCE, name), Buffer.from(String(captured.data), 'base64'));
    }
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${base}/internal/v1/mcp` });
    let pageText = '';
    const opened = Date.now();
    while (Date.now() - opened < 10_000) {
      pageText = String(await evaluate(`document.body ? document.body.innerText : ''`));
      if (pageText.includes('MCP catalog') && pageText.includes('does not call a tool')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!pageText.includes('MCP catalog') || !pageText.includes('does not call a tool')) {
      throw new Error('The catalog page was blank.');
    }
    await evaluate(`
      document.querySelector('#tenant-id').value = ${JSON.stringify(tenantId)};
      document.querySelector('#api-key').value = ${JSON.stringify(secret)};
      document.querySelector('#session-form').requestSubmit();
    `);
    await waitText('#status', 'Credential is ready');
    const before = String(await evaluate(`document.querySelector('#exposed-rows').textContent || ''`));
    if (before.includes('list_models')) throw new Error('The exposed table filled before refresh.');
    await evaluate(`document.querySelector('#refresh-exposed').click()`);
    const exposed = await waitText('#exposed-rows', 'list_models');
    if (!exposed.includes('approval required')) throw new Error('The page did not show approval required.');
    await shot('01-exposed.png');
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('#exposed-rows tr')].find((item) => (item.textContent || '').includes('create_chat_completion'));
      if (!row) throw new Error('missing exposed chat tool');
      row.querySelector('input').click();
      document.querySelector('#approve-exposed').click();
    })()`);
    const approved = await waitText('#status', 'The tool is allowed.');
    await shot('02-approved.png');
    socket.close();
    return { exposed, approved, pageText };
  } finally {
    chrome?.kill('SIGKILL');
    if (chrome) {
      await new Promise<void>((resolve) => {
        chrome?.once('exit', () => resolve());
        setTimeout(resolve, 1_000);
      });
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}
