import { Client, StreamableHTTPClientTransport, UnsupportedProtocolVersionError } from '@modelcontextprotocol/client';
import {
  MCP_CATALOG_MAX_PAGES,
  MCP_CATALOG_MAX_TOOLS,
  MCP_LEGACY_VERSIONS,
  MCP_PROTOCOL_VERSION,
  MCP_TTL_MAX_MS,
} from './bounds.js';
import { assertSameTarget } from './endpoint.js';
import { McpFailure, mcpFailure } from './errors.js';
import { assertDescription, assertRemoteName, namespacedToolName } from './names.js';
import { assertToolSchema } from './schema.js';

export type CatalogTool = {
  remoteName: string;
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
};

export type CatalogPage = {
  protocolVersion: string;
  ttlMs: number;
  cacheScope: 'public' | 'private';
  tools: CatalogTool[];
  pages: number;
  toolCalls: number;
};

type ProbeMode = 'modern' | 'legacy';

const REQUEST_TIMEOUT_MS = 3_000;

function requestUrl(input: string | URL | { url: string }): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.name} ${error.message}`;
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|network|timeout|AbortError|RequestTimeout|socket/i.test(text);
}

function failureText(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return `${error.message} ${cause}`;
}

function asFailure(error: unknown): McpFailure {
  if (error instanceof McpFailure) return error;
  const text = failureText(error);
  if (text.includes('The endpoint redirected.')) return mcpFailure('redirect', 'The endpoint redirected.');
  if (text.includes('The proxy does not call a tool.')) return mcpFailure('rejected', 'The proxy does not call a tool.');
  if (text.includes('The endpoint is not allowed.')) return mcpFailure('rejected', 'The endpoint is not allowed.');
  if (text.includes('The tool schema is invalid.')) return mcpFailure('schema', 'The tool schema is invalid.');
  if (text.includes('The catalog is too large.')) return mcpFailure('large', 'The catalog is too large.');
  if (text.includes('The tool name is invalid.') || text.includes('The tool name is duplicated.')) {
    return mcpFailure('invalid', 'The tool name is invalid.');
  }
  if (text.includes('The tool description is invalid.')) return mcpFailure('invalid', 'The tool description is invalid.');
  if (error instanceof UnsupportedProtocolVersionError) {
    return mcpFailure('mismatch', 'The protocol version does not match.');
  }
  if (networkFailure(error)) return mcpFailure('unavailable', 'The server is unavailable.');
  return mcpFailure('mismatch', 'The protocol version does not match.');
}

function guardedFetch(approved: URL, base: typeof fetch, state: { toolCalls: number }): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    assertSameTarget(url, approved);
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    let body: Uint8Array | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const request = new Request(input, init);
      const text = await request.text();
      if (text.includes('"tools/call"')) {
        state.toolCalls += 1;
        throw mcpFailure('rejected', 'The proxy does not call a tool.');
      }
      body = new TextEncoder().encode(text);
    }
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    const response = await base(url, { method, headers, body, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw mcpFailure('redirect', 'The endpoint redirected.');
    }
    return response;
  };
}

function readCache(result: Record<string, unknown>, mode: ProbeMode): { ttlMs: number; cacheScope: 'public' | 'private' } {
  const ttl = result.ttlMs;
  const scope = result.cacheScope;
  if (mode === 'legacy') {
    const ttlMs = typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= 0 && ttl <= MCP_TTL_MAX_MS ? ttl : 0;
    const cacheScope = scope === 'public' || scope === 'private' ? scope : 'private';
    return { ttlMs, cacheScope };
  }
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > MCP_TTL_MAX_MS) {
    throw mcpFailure('invalid', 'The catalog lifetime is invalid.');
  }
  if (scope !== 'public' && scope !== 'private') throw mcpFailure('invalid', 'The cache scope is invalid.');
  return { ttlMs: ttl, cacheScope: scope };
}

function readTools(result: Record<string, unknown>, serverKey: string, seen: Set<string>): CatalogTool[] {
  if (!Array.isArray(result.tools)) throw mcpFailure('invalid', 'The tool page is invalid.');
  const page: CatalogTool[] = [];
  for (const entry of result.tools) {
    if (!isRecord(entry) || typeof entry.name !== 'string') throw mcpFailure('invalid', 'The tool name is invalid.');
    const remoteName = assertRemoteName(entry.name);
    if (seen.has(remoteName)) throw mcpFailure('invalid', 'The tool name is duplicated.');
    seen.add(remoteName);
    const description = assertDescription(typeof entry.description === 'string' ? entry.description : '');
    const inputSchema = assertToolSchema(entry.inputSchema);
    const outputSchema =
      entry.outputSchema === undefined || entry.outputSchema === null ? null : assertToolSchema(entry.outputSchema);
    page.push({
      remoteName,
      namespacedName: namespacedToolName(serverKey, remoteName),
      description,
      inputSchema,
      outputSchema,
    });
  }
  return page;
}

async function openClient(
  mode: ProbeMode,
  endpoint: URL,
  credential: string,
  fetchImpl: typeof fetch,
  state: { toolCalls: number },
): Promise<Client> {
  const client = new Client(
    { name: 'llm-proxy', version: '1.0.0' },
    {
      versionNegotiation: mode === 'modern' ? { mode: { pin: MCP_PROTOCOL_VERSION } } : { mode: 'legacy' },
      listMaxPages: 1,
    },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: guardedFetch(endpoint, fetchImpl, state),
    requestInit: { redirect: 'manual' },
    authProvider: { token: async () => credential },
  });
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw asFailure(error);
  }
  return client;
}

function assertEra(client: Client, mode: ProbeMode): string {
  const era = client.getProtocolEra();
  if (mode === 'modern') {
    if (era !== 'modern') throw mcpFailure('mismatch', 'The protocol version does not match.');
    const offered = client.getDiscoverResult()?.supportedVersions ?? [];
    if (!offered.includes(MCP_PROTOCOL_VERSION)) throw mcpFailure('mismatch', 'The protocol version does not match.');
    return MCP_PROTOCOL_VERSION;
  }
  const version = client.getNegotiatedProtocolVersion();
  if (era !== 'legacy' || version === undefined || !MCP_LEGACY_VERSIONS.includes(version as (typeof MCP_LEGACY_VERSIONS)[number])) {
    throw mcpFailure('mismatch', 'The protocol version does not match.');
  }
  return version;
}

export async function probeMcpServer(input: {
  mode: ProbeMode;
  endpoint: URL;
  credential: string;
  fetchImpl?: typeof fetch;
}): Promise<{ protocolVersion: string; toolCalls: number }> {
  const state = { toolCalls: 0 };
  const client = await openClient(input.mode, input.endpoint, input.credential, input.fetchImpl ?? fetch, state);
  try {
    const protocolVersion = assertEra(client, input.mode);
    if (state.toolCalls !== 0) throw mcpFailure('rejected', 'The proxy does not call a tool.');
    return { protocolVersion, toolCalls: state.toolCalls };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function discoverMcpCatalog(input: {
  mode: ProbeMode;
  endpoint: URL;
  credential: string;
  serverKey: string;
  fetchImpl?: typeof fetch;
}): Promise<CatalogPage> {
  const state = { toolCalls: 0 };
  const client = await openClient(input.mode, input.endpoint, input.credential, input.fetchImpl ?? fetch, state);
  try {
    const protocolVersion = assertEra(client, input.mode);
    const tools: CatalogTool[] = [];
    const seen = new Set<string>();
    let cursor = '';
    let ttlMs = 0;
    let cacheScope: 'public' | 'private' = 'private';
    let pages = 0;
    let pendingCursor: string | undefined;
    const seenCursors = new Set<string>();
    while (pages < MCP_CATALOG_MAX_PAGES) {
      if (seenCursors.has(cursor)) throw mcpFailure('invalid', 'The tool page is invalid.');
      seenCursors.add(cursor);
      const listed = await client.listTools({ cursor }, { timeout: REQUEST_TIMEOUT_MS });
      pages += 1;
      const result = listed as unknown as Record<string, unknown>;
      const cache = readCache(result, input.mode);
      if (pages === 1) {
        ttlMs = cache.ttlMs;
        cacheScope = cache.cacheScope;
      } else if (cache.ttlMs !== ttlMs || cache.cacheScope !== cacheScope) {
        throw mcpFailure('invalid', 'The tool page is invalid.');
      }
      tools.push(...readTools(result, input.serverKey, seen));
      if (tools.length > MCP_CATALOG_MAX_TOOLS) throw mcpFailure('large', 'The catalog is too large.');
      const next = result.nextCursor;
      if (next === undefined || next === null || next === '') {
        pendingCursor = undefined;
        break;
      }
      if (typeof next !== 'string') throw mcpFailure('invalid', 'The tool page is invalid.');
      pendingCursor = next;
      cursor = next;
    }
    if (pendingCursor !== undefined) throw mcpFailure('large', 'The catalog is too large.');
    if (state.toolCalls !== 0) throw mcpFailure('rejected', 'The proxy does not call a tool.');
    return { protocolVersion, ttlMs, cacheScope, tools, pages, toolCalls: state.toolCalls };
  } catch (error) {
    throw asFailure(error);
  } finally {
    await client.close().catch(() => undefined);
  }
}
