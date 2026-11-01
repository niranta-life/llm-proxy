import { createHash, randomBytes } from 'node:crypto';
import {
  MCP_ARGUMENT_MAX_BYTES,
  MCP_EXECUTION_CONCURRENCY_DEFAULT,
  MCP_EXECUTION_CONCURRENCY_MAX,
  MCP_EXECUTION_COST_DEFAULT,
  MCP_EXECUTION_COST_MAX,
  MCP_EXECUTION_IDENTITY_TTL_DEFAULT_MS,
  MCP_EXECUTION_IDENTITY_TTL_MAX_MS,
  MCP_EXECUTION_IDENTITY_TTL_MIN_MS,
  MCP_EXECUTION_LOOP_DEFAULT,
  MCP_EXECUTION_LOOP_MAX,
  MCP_EXECUTION_TIMEOUT_DEFAULT_MS,
  MCP_EXECUTION_TIMEOUT_MAX_MS,
  MCP_EXECUTION_TIMEOUT_MIN_MS,
  MCP_RESULT_MAX_BYTES,
  MCP_SCHEMA_MAX_DEPTH,
} from './bounds.js';
import { mcpFailure } from './errors.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ToolEffect = 'read' | 'write';

export type ExecutionPolicy = {
  writeApproval: 'required';
  maxConcurrent: number;
  timeoutMs: number;
  maxCostUnits: number;
  maxLoopDepth: number;
  identityTtlMs: number;
  modelFollowup: boolean;
};

export type ExecutionRequest = {
  serverId: string;
  remoteName: string;
  schemaVersion: number;
  requestId: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  depth: number;
  parentExecutionId: string | null;
  costUnits: number;
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  writeApproval: 'required',
  maxConcurrent: MCP_EXECUTION_CONCURRENCY_DEFAULT,
  timeoutMs: MCP_EXECUTION_TIMEOUT_DEFAULT_MS,
  maxCostUnits: MCP_EXECUTION_COST_DEFAULT,
  maxLoopDepth: MCP_EXECUTION_LOOP_DEFAULT,
  identityTtlMs: MCP_EXECUTION_IDENTITY_TTL_DEFAULT_MS,
  modelFollowup: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectArguments(): never {
  throw mcpFailure('schema', 'The arguments are invalid.');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function argumentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function identityDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintExecutionIdentity(): string {
  return randomBytes(32).toString('base64url');
}

export function assertIdentityToken(value: string): string {
  if (!IDENTITY_TOKEN.test(value)) throw mcpFailure('invalid', 'The execution identity is invalid.');
  return value;
}

// A tool description is stored text. It is not a command and it cannot name another call.
export function commandsFromDescription(_description: string): readonly string[] {
  return [];
}

export function assertAtMostOnce(dispatchCount: number): void {
  if (dispatchCount > 0) throw mcpFailure('conflict', 'The execution identity was replayed.');
}

export function assertEffect(effect: string | null, expected: ToolEffect): void {
  if (effect !== expected) throw mcpFailure('rejected', 'The tool is not approved.');
}

function integerIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export function parsePolicyPatch(body: Record<string, unknown>, current: ExecutionPolicy): ExecutionPolicy {
  const next: ExecutionPolicy = { ...current, writeApproval: 'required' };
  if (body.maxConcurrent !== undefined) {
    const value = integerIn(body.maxConcurrent, 1, MCP_EXECUTION_CONCURRENCY_MAX);
    if (value === null) throw mcpFailure('invalid', 'The request is invalid.');
    next.maxConcurrent = value;
  }
  if (body.timeoutMs !== undefined) {
    const value = integerIn(body.timeoutMs, MCP_EXECUTION_TIMEOUT_MIN_MS, MCP_EXECUTION_TIMEOUT_MAX_MS);
    if (value === null) throw mcpFailure('invalid', 'The request is invalid.');
    next.timeoutMs = value;
  }
  if (body.maxCostUnits !== undefined) {
    const value = integerIn(body.maxCostUnits, 1, MCP_EXECUTION_COST_MAX);
    if (value === null) throw mcpFailure('invalid', 'The request is invalid.');
    next.maxCostUnits = value;
  }
  if (body.maxLoopDepth !== undefined) {
    const value = integerIn(body.maxLoopDepth, 1, MCP_EXECUTION_LOOP_MAX);
    if (value === null) throw mcpFailure('invalid', 'The request is invalid.');
    next.maxLoopDepth = value;
  }
  if (body.identityTtlMs !== undefined) {
    const value = integerIn(body.identityTtlMs, MCP_EXECUTION_IDENTITY_TTL_MIN_MS, MCP_EXECUTION_IDENTITY_TTL_MAX_MS);
    if (value === null) throw mcpFailure('invalid', 'The request is invalid.');
    next.identityTtlMs = value;
  }
  if (body.modelFollowup !== undefined) {
    if (typeof body.modelFollowup !== 'boolean') throw mcpFailure('invalid', 'The request is invalid.');
    next.modelFollowup = body.modelFollowup;
  }
  if (body.writeApproval !== undefined && body.writeApproval !== 'required') {
    throw mcpFailure('rejected', 'The write approval is required.');
  }
  return next;
}

export function parseExecutionRequest(body: Record<string, unknown>): ExecutionRequest {
  const serverId = body.serverId;
  const remoteName = body.remoteName;
  const schemaVersion = body.schemaVersion;
  const requestId = body.requestId;
  const toolCallId = body.toolCallId;
  if (typeof serverId !== 'string' || typeof remoteName !== 'string') throw mcpFailure('invalid', 'The request is invalid.');
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw mcpFailure('invalid', 'The schema version does not match.');
  }
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw mcpFailure('invalid', 'The request is invalid.');
  if (typeof toolCallId !== 'string' || !TOOL_CALL_ID.test(toolCallId)) throw mcpFailure('invalid', 'The tool call does not belong to the request.');
  if (typeof body.arguments === 'string' || !isRecord(body.arguments)) rejectArguments();
  const depth = body.depth === undefined ? 1 : body.depth;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) {
    throw mcpFailure('limit', 'The tool loop is too deep.');
  }
  const parent = body.parentExecutionId === undefined || body.parentExecutionId === null ? null : body.parentExecutionId;
  if (parent !== null && typeof parent !== 'string') throw mcpFailure('invalid', 'The request is invalid.');
  const costUnits = body.costUnits === undefined ? 1 : body.costUnits;
  if (typeof costUnits !== 'number' || !Number.isInteger(costUnits) || costUnits < 1) {
    throw mcpFailure('limit', 'The cost limit is reached.');
  }
  if (body.runMode !== undefined) throw mcpFailure('rejected', 'A model request is not authorized.');
  return {
    serverId,
    remoteName,
    schemaVersion,
    requestId,
    toolCallId,
    arguments: body.arguments,
    depth,
    parentExecutionId: parent,
    costUnits,
  };
}

function resolveRef(root: Record<string, unknown>, ref: string, depth: number): Record<string, unknown> {
  if (!ref.startsWith('#/') || depth > MCP_SCHEMA_MAX_DEPTH) rejectArguments();
  const parts = ref.slice(2).split('/');
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) rejectArguments();
    current = current[part];
  }
  if (!isRecord(current)) rejectArguments();
  return current;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  return false;
}

function checkBounds(schema: Record<string, unknown>, value: unknown): void {
  if (typeof value === 'string') {
    const min = schema.minLength;
    const max = schema.maxLength;
    if (typeof min === 'number' && value.length < min) rejectArguments();
    if (typeof max === 'number' && value.length > max) rejectArguments();
  }
  if (typeof value === 'number') {
    const min = schema.minimum;
    const max = schema.maximum;
    if (typeof min === 'number' && value < min) rejectArguments();
    if (typeof max === 'number' && value > max) rejectArguments();
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) rejectArguments();
}

function validateNode(root: Record<string, unknown>, schema: Record<string, unknown>, value: unknown, depth: number): void {
  if (depth > MCP_SCHEMA_MAX_DEPTH) rejectArguments();
  const source = typeof schema.$ref === 'string' ? resolveRef(root, schema.$ref, depth) : schema;
  const type = source.type;
  if (typeof type === 'string' && !matchesType(value, type)) rejectArguments();
  checkBounds(source, value);
  if (type === 'object' && isRecord(value)) {
    const properties = isRecord(source.properties) ? source.properties : {};
    const required = Array.isArray(source.required) ? source.required : [];
    for (const key of required) {
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(value, key)) rejectArguments();
    }
    const keys = Object.keys(value);
    for (const key of keys) {
      const child = properties[key];
      if (child === undefined) {
        if (source.additionalProperties === false) rejectArguments();
        if (isRecord(source.additionalProperties)) validateNode(root, source.additionalProperties, value[key], depth + 1);
        continue;
      }
      if (!isRecord(child)) rejectArguments();
      validateNode(root, child, value[key], depth + 1);
    }
  }
  if (type === 'array' && Array.isArray(value) && isRecord(source.items)) {
    for (const item of value) validateNode(root, source.items, item, depth + 1);
  }
}

export function assertCompleteArguments(schema: unknown, args: unknown): Record<string, unknown> {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(args)) rejectArguments();
  let encoded = '';
  try {
    encoded = JSON.stringify(args);
  } catch {
    rejectArguments();
  }
  if (encoded.length > MCP_ARGUMENT_MAX_BYTES) throw mcpFailure('large', 'The arguments are invalid.');
  validateNode(schema, schema, args, 1);
  return args;
}

export type LoopLink = {
  id: string;
  remoteName: string;
  depth: number;
  parentExecutionId: string | null;
};

export function assertLoopBound(input: {
  remoteName: string;
  depth: number;
  maxDepth: number;
  parent: LoopLink | null;
  chain: readonly LoopLink[];
}): void {
  if (input.depth < 1 || input.depth > input.maxDepth || input.depth > MCP_EXECUTION_LOOP_MAX) {
    throw mcpFailure('limit', 'The tool loop is too deep.');
  }
  if (input.parent === null) {
    if (input.depth !== 1) throw mcpFailure('limit', 'The tool loop is too deep.');
    return;
  }
  if (input.depth !== input.parent.depth + 1) throw mcpFailure('limit', 'The tool loop is too deep.');
  const seen = new Set<string>([input.remoteName]);
  let cursor: string | null = input.parent.id;
  let guard = 0;
  const byId = new Map(input.chain.map((link) => [link.id, link]));
  byId.set(input.parent.id, input.parent);
  while (cursor !== null) {
    guard += 1;
    if (guard > input.maxDepth) throw mcpFailure('limit', 'The tool loop is too deep.');
    const link = byId.get(cursor);
    if (link === undefined) throw mcpFailure('limit', 'The tool loop is too deep.');
    if (seen.has(link.remoteName)) throw mcpFailure('limit', 'The tool loop is too deep.');
    seen.add(link.remoteName);
    cursor = link.parentExecutionId;
  }
}

export function boundedToolResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw mcpFailure('invalid', 'The tool result is invalid.');
  const content = Array.isArray(value.content) ? value.content : [];
  const result: Record<string, unknown> = {
    content,
    isError: value.isError === true,
  };
  if (value.structuredContent !== undefined) result.structuredContent = value.structuredContent;
  let encoded = '';
  try {
    encoded = JSON.stringify(result);
  } catch {
    throw mcpFailure('large', 'The tool result is invalid.');
  }
  if (encoded.length > MCP_RESULT_MAX_BYTES) throw mcpFailure('large', 'The tool result is invalid.');
  return result;
}

export function scrubSecret(value: unknown, secret: string): unknown {
  if (secret.length === 0) return value;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || !encoded.includes(secret)) return value;
  return JSON.parse(encoded.split(secret).join('[redacted]')) as unknown;
}
