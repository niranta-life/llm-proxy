export const MCP_PROTOCOL_VERSION = '2026-07-28';

export const MCP_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;

export const MCP_SCHEMA_MAX_DEPTH = 8;
export const MCP_SCHEMA_MAX_BYTES = 16384;
export const MCP_SCHEMA_MAX_NODES = 64;
export const MCP_CATALOG_MAX_TOOLS = 32;
export const MCP_CATALOG_MAX_PAGES = 8;
export const MCP_DESCRIPTION_MAX = 512;
export const MCP_TTL_MAX_MS = 2_592_000_000;

export const MCP_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MCP_SERVER_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
