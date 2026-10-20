import pg from 'pg';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { loadCatalog } from '../src/inference/store.js';
import { resolveModel } from '../src/inference/resolve.js';
import { configFor, runCli, type TestDatabase } from './helpers.js';

export const credentialKey = Buffer.alloc(32, 9);
export const credentialKeyText = credentialKey.toString('base64');

export function cliEnv(): { PROVIDER_CREDENTIAL_KEY: string } {
  return { PROVIDER_CREDENTIAL_KEY: credentialKeyText };
}

export function provisionTenant(db: TestDatabase, name: string): {
  tenantId: string;
  keyId: string;
  secret: string;
  name: string;
} {
  const created = runCli(db, ['provision-tenant', '--name', name]);
  if (!created.tenantId || !created.secret || !created.keyId || !created.name) {
    throw new Error('tenant was not provisioned');
  }
  return { tenantId: created.tenantId, keyId: created.keyId, secret: created.secret, name: created.name };
}

export function registerAnthropic(
  db: TestDatabase,
  input: {
    tenantId: string;
    apiKey: string;
    endpoint: string;
    deployment: string;
    upstreamModel: string;
    timeoutMs?: number;
    capabilities?: string;
    enabled?: boolean;
    workspaceId?: string;
    defaultMaxOutputTokens?: number;
    alias?: boolean;
  },
): void {
  const env = cliEnv();
  const connection = [
    'register-anthropic-connection',
    '--tenant-id',
    input.tenantId,
    '--api-key',
    input.apiKey,
    '--endpoint',
    input.endpoint,
  ];
  if (input.workspaceId) connection.push('--workspace-id', input.workspaceId);
  runCli(db, connection, env);
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      input.tenantId,
      '--provider',
      'anthropic',
      '--name',
      input.deployment,
      '--upstream-model',
      input.upstreamModel,
      '--timeout-ms',
      String(input.timeoutMs ?? 5000),
      '--capabilities',
      input.capabilities ?? 'temperature,stop,max_completion_tokens',
      '--enabled',
      input.enabled === false ? 'false' : 'true',
      '--default-max-output-tokens',
      String(input.defaultMaxOutputTokens ?? 64),
    ],
    env,
  );
  if (input.alias) {
    runCli(
      db,
      ['set-alias', '--tenant-id', input.tenantId, '--alias', 'auto', '--deployment', input.deployment],
      env,
    );
  }
}

export function registerInference(
  db: TestDatabase,
  input: {
    tenantId: string;
    apiKey: string;
    deployment: string;
    upstreamModel: string;
    timeoutMs?: number;
    capabilities?: string;
    enabled?: boolean;
  },
): void {
  const env = cliEnv();
  runCli(db, ['register-openai-connection', '--tenant-id', input.tenantId, '--api-key', input.apiKey], env);
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      input.tenantId,
      '--name',
      input.deployment,
      '--upstream-model',
      input.upstreamModel,
      '--timeout-ms',
      String(input.timeoutMs ?? 5000),
      '--capabilities',
      input.capabilities ?? 'temperature',
      '--enabled',
      input.enabled === false ? 'false' : 'true',
    ],
    env,
  );
  runCli(
    db,
    ['set-alias', '--tenant-id', input.tenantId, '--alias', 'auto', '--deployment', input.deployment],
    env,
  );
}

export function enableStreaming(
  db: TestDatabase,
  input: {
    tenantId: string;
    deployment: string;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
    backpressureTimeoutMs?: number;
  },
): void {
  const env = cliEnv();
  runCli(db, ['set-tenant-streaming', '--tenant-id', input.tenantId, '--enabled', 'true'], env);
  const args = [
    'set-deployment-streaming',
    '--tenant-id',
    input.tenantId,
    '--deployment',
    input.deployment,
    '--enabled',
    'true',
  ];
  if (input.connectTimeoutMs !== undefined) args.push('--connect-timeout-ms', String(input.connectTimeoutMs));
  if (input.idleTimeoutMs !== undefined) args.push('--idle-timeout-ms', String(input.idleTimeoutMs));
  if (input.totalTimeoutMs !== undefined) args.push('--total-timeout-ms', String(input.totalTimeoutMs));
  if (input.backpressureTimeoutMs !== undefined) {
    args.push('--backpressure-timeout-ms', String(input.backpressureTimeoutMs));
  }
  runCli(db, args, env);
}

export function adminPool(db: TestDatabase): pg.Pool {
  const pool = new pg.Pool({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.username,
    password: db.password,
    max: 1,
  });
  pool.on('error', () => undefined);
  return pool;
}

export async function resolvedUpstream(db: TestDatabase, tenantId: string, model: string): Promise<string | null> {
  const runtime = createPool(configFor(db), 'runtime', undefined, 1);
  try {
    return await withTenant(runtime, tenantId, async (client) => {
      const catalog = await loadCatalog(client);
      return resolveModel(model, catalog.deployments, catalog.aliases)?.upstreamModel ?? null;
    });
  } finally {
    await runtime.end();
  }
}

export function chatPayload(model: string, content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content }],
    ...extra,
  });
}
