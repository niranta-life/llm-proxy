import { MCP_SCHEMA_MAX_BYTES, MCP_SCHEMA_MAX_DEPTH, MCP_SCHEMA_MAX_NODES } from './bounds.js';
import { mcpFailure } from './errors.js';

const LOCAL_REF = /^#(?:\/(?:[A-Za-z0-9_~.-]|%[0-9A-Fa-f]{2})*)*$/;

function reject(): never {
  throw mcpFailure('schema', 'The tool schema is invalid.');
}

function walk(value: unknown, depth: number, state: { nodes: number }): void {
  if (depth > MCP_SCHEMA_MAX_DEPTH) reject();
  if (value === null || typeof value !== 'object') reject();
  state.nodes += 1;
  if (state.nodes > MCP_SCHEMA_MAX_NODES) reject();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') walk(item, depth + 1, state);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, '$ref')) {
    const ref = record.$ref;
    if (typeof ref !== 'string' || !LOCAL_REF.test(ref)) reject();
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'properties') {
      if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) reject();
      for (const child of Object.values(nested as Record<string, unknown>)) walk(child, depth + 1, state);
      continue;
    }
    if (nested !== null && typeof nested === 'object') walk(nested, depth + 1, state);
  }
}

export function assertToolSchema(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
  const record = value as Record<string, unknown>;
  if (record.type !== 'object') reject();
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    reject();
  }
  if (encoded.length > MCP_SCHEMA_MAX_BYTES) reject();
  walk(value, 1, { nodes: 0 });
  return record;
}
