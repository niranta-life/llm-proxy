import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';

export const MCP_SERVER_PROTOCOL = '2026-07-28';
export const MCP_SERVER_REQUEST_MAX_BYTES = 65_536;
export const MCP_SERVER_OUTPUT_MAX_BYTES = 16_384;
export const MCP_SERVER_CONCURRENCY = 4;
export const HEADER_MISMATCH_CODE = -32020;
export const UNSUPPORTED_PROTOCOL_CODE = -32022;

export const READ_TOOL_NAMES = ['list_models', 'get_model_capabilities'] as const;
export const OPTIONAL_TOOL_NAMES = ['create_chat_completion', 'create_embedding'] as const;
export const SERVER_TOOL_NAMES = [...READ_TOOL_NAMES, ...OPTIONAL_TOOL_NAMES] as const;

export type ServerToolName = (typeof SERVER_TOOL_NAMES)[number];
export type ServerToolKind = 'read' | 'inference' | 'embedding';
export type ServerToolPermission = 'allowed' | 'denied' | 'approval_required';

const SUPPORTED_REQUEST_METHODS = new Set(['ping', 'server/discover', 'tools/list', 'tools/call']);

const NAME_FIELDS: Record<string, 'name' | 'uri' | 'taskId'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
  'tasks/get': 'taskId',
  'tasks/update': 'taskId',
  'tasks/cancel': 'taskId',
};

const RECURSION_URL_KEYS = new Set(['url', 'endpoint', 'uri']);

export type ProtocolRejection = {
  status: number;
  code: number;
  message: string;
};

export function isServerToolName(value: string): value is ServerToolName {
  return (SERVER_TOOL_NAMES as readonly string[]).includes(value);
}

export function toolKind(name: ServerToolName): ServerToolKind {
  if (name === 'create_chat_completion') return 'inference';
  if (name === 'create_embedding') return 'embedding';
  return 'read';
}

export function toolIsAllowed(name: ServerToolName, approved: boolean | undefined): boolean {
  if (approved === false) return false;
  if (approved === true) return true;
  return name === 'list_models' || name === 'get_model_capabilities';
}

export function toolPermission(name: ServerToolName, approved: boolean | undefined): ServerToolPermission {
  if (approved === false) return 'denied';
  if (toolIsAllowed(name, approved)) return 'allowed';
  return 'approval_required';
}

export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true;
  if (host === undefined || host.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.host.toLowerCase() === host.trim().toLowerCase();
}

export function outputWithinLimit(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= MCP_SERVER_OUTPUT_MAX_BYTES;
}

export function recursiveMcpCall(value: unknown): boolean {
  return scanRecursive(value, 0);
}

export function checkProtocolMessage(
  body: unknown,
  headers: { protocol: string | undefined; method: string | undefined; name: string | undefined },
): ProtocolRejection | null {
  if (!isRecord(body) || Array.isArray(body)) {
    return { status: 400, code: -32600, message: 'The request is not valid JSON-RPC.' };
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || body.method.length === 0) {
    return { status: 400, code: -32600, message: 'The request is not valid JSON-RPC.' };
  }
  const notification = !Object.prototype.hasOwnProperty.call(body, 'id');
  const method = body.method;
  if (!notification) {
    if (headers.protocol === undefined || headers.protocol.trim() === '') {
      return { status: 400, code: HEADER_MISMATCH_CODE, message: 'MCP-Protocol-Version is required.' };
    }
    if (headers.method === undefined || headers.method.trim() === '') {
      return { status: 400, code: HEADER_MISMATCH_CODE, message: 'Mcp-Method is required.' };
    }
  }
  if (headers.method !== undefined && headers.method !== method) {
    return { status: 400, code: HEADER_MISMATCH_CODE, message: 'Mcp-Method does not match the request.' };
  }
  const claimed = protocolClaim(body.params);
  if (headers.protocol !== undefined && claimed !== undefined && headers.protocol !== claimed) {
    return { status: 400, code: HEADER_MISMATCH_CODE, message: 'MCP-Protocol-Version does not match the request.' };
  }
  const protocol = headers.protocol ?? claimed;
  if (protocol !== undefined && protocol !== MCP_SERVER_PROTOCOL) {
    return { status: 400, code: UNSUPPORTED_PROTOCOL_CODE, message: 'The protocol version is not supported.' };
  }
  if (!notification && protocol === undefined) {
    return { status: 400, code: UNSUPPORTED_PROTOCOL_CODE, message: 'The protocol version is not supported.' };
  }
  const nameField = Object.prototype.hasOwnProperty.call(NAME_FIELDS, method) ? NAME_FIELDS[method] : undefined;
  if (nameField !== undefined && !notification) {
    const bodyName = isRecord(body.params) && typeof body.params[nameField] === 'string' ? body.params[nameField] : undefined;
    if (headers.name === undefined || headers.name.trim() === '') {
      return { status: 400, code: HEADER_MISMATCH_CODE, message: 'Mcp-Name is required.' };
    }
    const decoded = decodeHeaderValue(headers.name.trim());
    if (decoded === undefined || bodyName === undefined || decoded !== bodyName) {
      return { status: 400, code: HEADER_MISMATCH_CODE, message: 'Mcp-Name does not match the request.' };
    }
  }
  if (method === 'tools/call' && recursiveMcpCall(isRecord(body.params) ? body.params.arguments : undefined)) {
    return { status: 400, code: -32602, message: 'A tool call cannot start another MCP call.' };
  }
  if (!notification && !SUPPORTED_REQUEST_METHODS.has(method)) {
    return { status: 400, code: -32601, message: 'The method is not supported.' };
  }
  return null;
}

export function createConcurrencyGate(limit: number): { enter: () => (() => void) | null } {
  let active = 0;
  return {
    enter() {
      if (active >= limit) return null;
      active += 1;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        active -= 1;
      };
    },
  };
}

function protocolClaim(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return undefined;
  const value = params._meta[PROTOCOL_VERSION_META_KEY];
  return typeof value === 'string' ? value : undefined;
}

function scanRecursive(value: unknown, depth: number): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => scanRecursive(item, depth + 1));
  if (!isRecord(value)) return false;
  if (value.method === 'tools/call') return true;
  if (typeof value.serverId === 'string' && typeof value.remoteName === 'string') return true;
  if (isRecord(value.mcp)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (RECURSION_URL_KEYS.has(key) && typeof child === 'string' && mcpUrl(child)) return true;
    if (isRecord(child) || Array.isArray(child)) {
      if (scanRecursive(child, depth + 1)) return true;
    }
  }
  return false;
}

function mcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === '/mcp' || url.pathname.endsWith('/mcp');
  } catch {
    return false;
  }
}

function decodeHeaderValue(value: string): string | undefined {
  const prefix = '=?base64?';
  const suffix = '?=';
  if (!(value.startsWith(prefix) && value.endsWith(suffix))) return value;
  const payload = value.slice(prefix.length, value.length - suffix.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) return undefined;
  return Buffer.from(payload, 'base64').toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
