import pg from 'pg';
import type { Config, DatabaseRole } from '../config.js';
import type { Logger } from '../logger.js';

export function createPool(
  config: Config,
  role: DatabaseRole,
  logger?: Logger,
  max = 10,
): pg.Pool {
  const credentials = config.roles[role];
  const pool = new pg.Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: credentials.user,
    password: credentials.password,
    max,
    application_name: `llm-proxy-${role}`,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    keepAlive: true,
    options: '-c search_path=public',
  });
  pool.on('error', (error: Error) => {
    logger?.error('database pool error', { role, message: error.message });
  });
  return pool;
}
