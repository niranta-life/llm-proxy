import { Client, ProtocolError, SdkError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_PROTOCOL_VERSION } from './bounds.js';
import { assertSameTarget } from './endpoint.js';
import { McpFailure, mcpFailure } from './errors.js';
import { boundedToolResult } from './govern.js';

export class McpDispatchAbort extends Error {
  constructor() {
    super('The worker stopped after dispatch.');
    this.name = 'McpDispatchAbort';
  }
}

export type DispatchedTool = {
  result: Record<string, unknown> | null;
  protocolError: { code: number; message: string } | null;
  toolCalls: number;
  uncertain: boolean;
};

function requestUrl(input: string | URL | { url: string }): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function executionFetch(approved: URL, toolName: string, base: typeof fetch, state: { toolCalls: number }): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    assertSameTarget(url, approved);
    const method = init?.method ?? 'GET';
    let body: Uint8Array | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const request = new Request(input, init);
      const text = await request.text();
      if (text.includes('"tools/call"')) {
        let name = '';
        try {
          const parsed = JSON.parse(text) as { method?: string; params?: { name?: string } };
          if (parsed.method === 'tools/call' && typeof parsed.params?.name === 'string') name = parsed.params.name;
        } catch {
          name = '';
        }
        if (name !== toolName || state.toolCalls >= 1) {
          throw mcpFailure('rejected', 'The tool call was refused.');
        }
        state.toolCalls += 1;
      }
      body = new TextEncoder().encode(text);
    }
    const headers = new Headers(init?.headers);
    const response = await base(url, { method, headers, body, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw mcpFailure('redirect', 'The endpoint redirected.');
    }
    return response;
  };
}

function protocolErrorOf(error: unknown): { code: number; message: string } | null {
  if (!ProtocolError.isInstance(error)) return null;
  const code = error.code;
  const message = error.message;
  if (typeof code !== 'number' || typeof message !== 'string' || message.length < 1 || message.length > 200) return null;
  return { code, message };
}

function uncertainFailure(error: unknown): boolean {
  if (SdkError.isInstance(error)) return error.code === 'REQUEST_TIMEOUT' || error.code === 'CONNECTION_CLOSED' || error.code === 'SEND_FAILED';
  return false;
}

export async function dispatchApprovedTool(input: {
  endpoint: URL;
  credential: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  abortAfterDispatch?: boolean;
}): Promise<DispatchedTool> {
  const state = { toolCalls: 0 };
  const client = new Client(
    { name: 'llm-proxy', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } }, listMaxPages: 1 },
  );
  const transport = new StreamableHTTPClientTransport(input.endpoint, {
    fetch: executionFetch(input.endpoint, input.remoteName, input.fetchImpl ?? fetch, state),
    requestInit: { redirect: 'manual' },
    authProvider: { token: async () => input.credential },
  });
  try {
    await client.connect(transport, { timeout: input.timeoutMs });
    if (client.getProtocolEra() !== 'modern') throw mcpFailure('mismatch', 'The protocol version does not match.');
    const offered = client.getDiscoverResult()?.supportedVersions ?? [];
    if (!offered.includes(MCP_PROTOCOL_VERSION)) throw mcpFailure('mismatch', 'The protocol version does not match.');
    const result = await client.callTool(
      { name: input.remoteName, arguments: input.arguments },
      {
        timeout: input.timeoutMs,
        toolDefinition: {
          name: input.remoteName,
          description: input.description,
          inputSchema: input.inputSchema as { type: 'object' },
        },
      },
    );
    if (state.toolCalls !== 1) throw mcpFailure('rejected', 'The tool call was refused.');
    if (input.abortAfterDispatch === true) throw new McpDispatchAbort();
    return { result: boundedToolResult(result), protocolError: null, toolCalls: state.toolCalls, uncertain: false };
  } catch (error) {
    if (error instanceof McpDispatchAbort) throw error;
    if (error instanceof McpFailure && state.toolCalls === 0) throw error;
    const protocolError = protocolErrorOf(error);
    if (protocolError !== null && state.toolCalls === 1) {
      return { result: null, protocolError, toolCalls: state.toolCalls, uncertain: false };
    }
    if (state.toolCalls >= 1 || uncertainFailure(error)) {
      return { result: null, protocolError: null, toolCalls: state.toolCalls, uncertain: true };
    }
    if (error instanceof McpFailure) throw error;
    throw mcpFailure('unavailable', 'The server is unavailable.');
  } finally {
    await client.close().catch(() => undefined);
  }
}
