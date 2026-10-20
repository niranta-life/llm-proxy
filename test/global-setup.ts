import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { bootstrapRoles } from '../src/db/bootstrap-roles.js';
import { migrate } from '../src/db/migrate.js';
import { useActiveDockerContext } from './docker-env.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = join(root, 'test', '.pg.json');

let container: { stop: () => Promise<unknown> } | undefined;

export async function setup(): Promise<void> {
  if (!process.version.startsWith('v24.')) {
    throw new Error(`Slice 00 tests require Node.js 24, got ${process.version}`);
  }
  process.stdout.write(`runtime ${process.version}\n`);
  useActiveDockerContext();

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const build = Promise.resolve().then(() => {
    execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
      cwd: root,
      stdio: 'inherit',
    });
  });

  const started = new PostgreSqlContainer('postgres:16')
    .withDatabase('llm_proxy')
    .withUsername('postgres')
    .withPassword('postgres')
    .withStartupTimeout(120_000)
    .start();

  const [, postgres] = await Promise.all([build, started]);
  container = postgres;

  const passwords = {
    migrator: 'migrator_test_pw',
    auth: 'auth_test_pw',
    runtime: 'runtime_test_pw',
  };
  const admin = new pg.Pool({
    host: postgres.getHost(),
    port: postgres.getPort(),
    database: postgres.getDatabase(),
    user: postgres.getUsername(),
    password: postgres.getPassword(),
    max: 1,
  });
  await bootstrapRoles(admin, postgres.getDatabase(), passwords);
  await admin.end();

  const migrator = new pg.Pool({
    host: postgres.getHost(),
    port: postgres.getPort(),
    database: postgres.getDatabase(),
    user: 'llm_migrator',
    password: passwords.migrator,
    max: 1,
  });
  await migrate(migrator);
  await migrator.end();

  writeFileSync(
    statePath,
    JSON.stringify({
      host: postgres.getHost(),
      port: postgres.getPort(),
      database: postgres.getDatabase(),
      username: postgres.getUsername(),
      password: postgres.getPassword(),
      passwords,
    }),
  );
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
