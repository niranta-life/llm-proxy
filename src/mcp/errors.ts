export type McpFailureKind =
  | 'redirect'
  | 'unavailable'
  | 'mismatch'
  | 'schema'
  | 'large'
  | 'invalid'
  | 'rejected'
  | 'conflict'
  | 'limit'
  | 'not_found';

export class McpFailure extends Error {
  constructor(
    readonly kind: McpFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'McpFailure';
  }
}

export function mcpFailure(kind: McpFailureKind, message: string): McpFailure {
  return new McpFailure(kind, message);
}
