import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATION_LOCK = 424242;

export function migrationsDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'migrations');
}

export async function listMigrationFiles(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => name.endsWith('.sql')).sort();
}

export async function latestMigrationVersion(directory = migrationsDirectory()): Promise<string> {
  const files = await listMigrationFiles(directory);
  const latest = files.at(-1);
  if (latest === undefined) throw new Error('no migrations found');
  return latest;
}

export async function migrate(pool: Pool, directory = migrationsDirectory()): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = await listMigrationFiles(directory);
    for (const file of files) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if ((existing.rowCount ?? 0) > 0) continue;
      const sql = await readFile(join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
