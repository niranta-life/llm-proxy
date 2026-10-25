import pg from 'pg';
import type { Config, DatabaseRole } from '../config.js';
import type { Logger } from '../logger.js';

// 'bounded' fails any query after 5 s on the client. 'migration' is only for the startup
// migrator: it waits on the advisory lock and runs long DDL, so the server enforces its limits.
export type PoolTimeoutPolicy = 'bounded' | 'migration';

export function createPool(
  config: Config,
  role: DatabaseRole,
  logger?: Logger,
  max = 10,
  timeoutPolicy: PoolTimeoutPolicy = 'bounded',
): pg.Pool {
  const credentials = config.roles[role];
  const migrating = timeoutPolicy === 'migration';
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
    ...(migrating ? {} : { query_timeout: 5_000 }),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    options: migrating
      ? `-c search_path=public -c lock_timeout=${config.migrationLockTimeoutMs} -c statement_timeout=${config.migrationStatementTimeoutMs}`
      : '-c search_path=public',
  });
  pool.on('error', (error: Error) => {
    logger?.error('database pool error', { role, message: error.message });
  });
  return pool;
}
