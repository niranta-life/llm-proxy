import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import { createPool } from '../src/db/pools.js';
import { latestMigrationVersion } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { createLogger, type LogLevel, type Logger } from '../src/logger.js';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadTestDatabase(): TestDatabase {
  const raw = readFileSync(join(projectRoot, 'test', '.pg.json'), 'utf8');
  return JSON.parse(raw) as TestDatabase;
}
export const serverEntry = join(projectRoot, 'dist', 'index.js');
export const cliEntry = join(projectRoot, 'dist', 'cli.js');

export type TestDatabase = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  passwords: {
    migrator: string;
    auth: string;
    runtime: string;
  };
};

export function serviceEnv(
  db: TestDatabase,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    HOST: '127.0.0.1',
    PORT: '8080',
    LOG_LEVEL: 'info',
    DATABASE_HOST: db.host,
    DATABASE_PORT: String(db.port),
    DATABASE_NAME: db.database,
    MIGRATOR_USER: 'llm_migrator',
    MIGRATOR_PASSWORD: db.passwords.migrator,
    AUTH_USER: 'llm_auth',
    AUTH_PASSWORD: db.passwords.auth,
    RUNTIME_USER: 'llm_runtime',
    RUNTIME_PASSWORD: db.passwords.runtime,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function configFor(db: TestDatabase, port = '8080'): Config {
  return loadConfig(serviceEnv(db, { PORT: port }));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function captureLogger(level: LogLevel = 'info'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { logger: createLogger(level, stream), lines };
}

export async function createTestApp(
  db: TestDatabase,
  options: {
    inferenceEnabled?: boolean;
    upstreamBaseUrl?: string;
    credentialKey?: Buffer | null;
  } = {},
) {
  const config = configFor(db);
  const captured = captureLogger();
  const authPool = createPool(config, 'auth', captured.logger);
  const runtimePool = createPool(config, 'runtime', captured.logger);
  const app = buildApp({
    logger: captured.logger,
    authPool,
    runtimePool,
    readyVersion: await latestMigrationVersion(),
    inferenceEnabled: options.inferenceEnabled ?? false,
    upstreamBaseUrl: options.upstreamBaseUrl ?? 'https://api.openai.com/v1',
    credentialKey: options.credentialKey ?? null,
  });
  return { app, ...captured, authPool, runtimePool, config };
}

export function runCli(
  db: TestDatabase,
  args: string[],
  overrides: Record<string, string | undefined> = {},
): {
  tenantId?: string;
  keyId?: string;
  secret?: string;
  name?: string;
  revoked?: boolean;
} {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: projectRoot,
    env: serviceEnv(db, overrides),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`cli exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as {
    tenantId?: string;
    keyId?: string;
    secret?: string;
    name?: string;
    revoked?: boolean;
  };
}

export function spawnServer(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    buffer += String(chunk);
  });
  return { child, output: () => buffer };
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process exit timed out')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function stopChild(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  child.kill('SIGTERM');
  try {
    return await waitForExit(child, 8_000);
  } catch {
    child.kill('SIGKILL');
    return waitForExit(child, 5_000);
  }
}

export async function waitForReady(port: number): Promise<{ status: string; database: string }> {
  const started = Date.now();
  let last = 'not started';
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      const text = await response.text();
      last = `${response.status} ${text}`;
      if (response.ok) return JSON.parse(text) as { status: string; database: string };
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`readiness timeout: ${last}`);
}
