import type { Pool } from 'pg';

export type RolePasswords = {
  migrator: string;
  auth: string;
  runtime: string;
};

function assertPassword(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:@-]+$/.test(value)) {
    throw new Error(`${label} password has an unsupported character`);
  }
  return value;
}

function assertIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('invalid database name');
  return value;
}

// Role attributes match docker/postgres/init.sh. Tests apply this on a fresh cluster.
// Compose applies init.sh as the database superuser before the service starts.
export async function bootstrapRoles(
  pool: Pool,
  database: string,
  passwords: RolePasswords,
): Promise<void> {
  const databaseName = assertIdentifier(database);
  const migrator = assertPassword(passwords.migrator, 'migrator');
  const auth = assertPassword(passwords.auth, 'auth');
  const runtime = assertPassword(passwords.runtime, 'runtime');
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE ROLE llm_owner NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE',
    );
    await client.query(
      `CREATE ROLE llm_migrator LOGIN PASSWORD '${migrator}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
    );
    await client.query(
      `CREATE ROLE llm_auth LOGIN PASSWORD '${auth}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
    );
    await client.query(
      `CREATE ROLE llm_runtime LOGIN PASSWORD '${runtime}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
    );
    await client.query('GRANT llm_owner TO llm_migrator');
    await client.query(
      `GRANT CONNECT ON DATABASE ${databaseName} TO llm_migrator, llm_auth, llm_runtime`,
    );
    await client.query('GRANT USAGE, CREATE ON SCHEMA public TO llm_migrator');
    await client.query('GRANT USAGE, CREATE ON SCHEMA public TO llm_owner');
    await client.query('GRANT USAGE ON SCHEMA public TO llm_auth, llm_runtime');
  } finally {
    client.release();
  }
}
