import { MCP_DESCRIPTION_MAX, MCP_REMOTE_NAME, MCP_SERVER_KEY } from './bounds.js';
import { mcpFailure } from './errors.js';

export function assertServerKey(value: string): string {
  if (!MCP_SERVER_KEY.test(value)) throw mcpFailure('invalid', 'The server name is invalid.');
  return value;
}

export function assertDisplayName(value: string): string {
  if (value.length < 1 || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw mcpFailure('invalid', 'The display name is invalid.');
  }
  return value;
}

export function assertRemoteName(value: string): string {
  if (!MCP_REMOTE_NAME.test(value)) throw mcpFailure('invalid', 'The tool name is invalid.');
  return value;
}

export function assertDescription(value: string): string {
  if (value.length > MCP_DESCRIPTION_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw mcpFailure('invalid', 'The tool description is invalid.');
  }
  return value;
}

export function namespacedToolName(serverKey: string, remoteName: string): string {
  return `${serverKey}/${remoteName}`;
}
