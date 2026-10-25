import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERACTIVE_GROUPS, interactiveFields } from '../src/cli-interactive.js';
import { cliEntry, loadTestDatabase, projectRoot, serviceEnv, type TestDatabase } from './helpers.js';
import { adminPool, cliEnv } from './inference-support.js';

const COMMANDS = [
  'provision-tenant',
  'add-key',
  'revoke-key',
  'register-openai-connection',
  'set-openai-credential',
  'register-anthropic-connection',
  'set-anthropic-credential',
  'register-vertex-connection',
  'register-xai-connection',
  'register-openrouter-connection',
  'register-dgx-connection',
  'set-connection-enabled',
  'register-deployment',
  'set-deployment-enabled',
  'set-alias',
  'set-tenant-streaming',
  'set-deployment-streaming',
  'set-deployment-concurrency',
  'validate-deployment',
  'set-deployment-health',
  'validate-vertex-credential',
  'validate-vertex-access',
  'test-vertex-inference',
  'approve-private-endpoint',
  'list-private-models',
  'probe-private-health',
  'register-price',
  'set-deployment-service-tier',
  'reconcile-attempt-cost',
  'set-execution-policy',
  'set-deployment-breaker',
  'reset-deployment-breaker',
  'set-fallback-policy',
  'show-fallback-policy',
  'set-deployment-context-limit',
  'set-deployment-data-collection',
  'set-tenant-limits',
  'set-api-key-limits',
  'set-connection-limit',
  'set-deployment-limit',
  'set-tenant-budget',
  'recover-budget',
  'list-inference',
  'set-sample-policy',
  'set-deployment-data-class',
  'show-sample-policy',
  'delete-sample',
  'cleanup-expired-samples',
  'show-sample-stats',
] as const;

const VERTEX_KEY = '{"private_key":"abc"}';
const PROJECT = 'acme-vertex-proj';
const LOCATION = 'us-central1';
const IDENTITY = 'vertex-bot@example.iam.gserviceaccount.com';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const DGX_ENDPOINT = 'https://dgx.invalid:443/v1';
const PRICE = {
  provider: 'openai',
  'upstream-model': 'gpt-interactive-price',
  'effective-at': '2026-01-15T00:00:00Z',
  source: 'card',
  status: 'verified',
  location: 'global',
  'service-tier': 'batch',
  'serving-provider': 'openai',
  'input-rate': '0.1',
  'output-rate': '0.2',
  'cache-read-rate': '0.01',
  'cache-write-rate': '0.02',
  'thinking-rate': '0.3',
  'request-fee': '0',
  'allocated-rate': '0.05',
};

type Values = Record<string, string | undefined>;
type Action = 'create' | 'update' | 'validate';
type Run = { status: number; stdout: string; stderr: string; signal: NodeJS.Signals | null };
type Spec = {
  action: Action;
  command: string;
  configuration: string;
  expectFailure?: boolean;
  prepare: (db: TestDatabase) => Promise<Values>;
};

const db = loadTestDatabase();
const evidenceDir = process.env.CLI_INTERACTIVE_EVIDENCE;
const evidence: string[] = [];
let admin: ReturnType<typeof adminPool>;

function run(args: string[], input?: string): Run {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: projectRoot,
    env: serviceEnv(db, cliEnv()),
    encoding: 'utf8',
    input,
    timeout: 20_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
  };
}

function ok(args: string[]): Record<string, unknown> {
  const result = run(args);
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(`${args.join(' ')} failed ${result.status} ${result.signal ?? ''}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function errorOf(stderr: string): { msg?: string; message?: string } {
  const logs: { level?: string; msg?: string; message?: string }[] = [];
  for (const match of stderr.matchAll(/\{.*?\}/g)) {
    try {
      const parsed = JSON.parse(match[0]) as { level?: string; msg?: string; message?: string };
      if (parsed.level === 'error') logs.push(parsed);
    } catch {
      // A prompt can share a line with a log.
    }
  }
  const last = logs.at(-1);
  return { msg: last?.msg, message: last?.message };
}

function stable(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'secret' || key === 'id' || key.endsWith('Id') || key === 'createdAt' || key === 'updatedAt' || key === 'completedAt') continue;
      out[key] = stable(item);
    }
    return out;
  }
  return value;
}

function script(action: Action, command: string, values: Values): string {
  const fields = interactiveFields(action, command);
  if (fields === undefined) throw new Error(`${action} ${command} is not in the catalog`);
  const lines = [action, command];
  for (const field of fields) lines.push(values[field] ?? '');
  lines.push('done');
  return `${lines.join('\n')}\n`;
}

function flags(command: string, values: Values): string[] {
  const args = [command];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) args.push(`--${key}`, value);
  }
  return args;
}

async function tenantCount(): Promise<number> {
  const result = await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM tenants');
  return Number(result.rows[0]?.count ?? 0);
}

async function provision(): Promise<{ tenantId: string; keyId: string }> {
  const created = ok(['provision-tenant', '--name', 'cli-tenant', '--label', 'ops']);
  return { tenantId: String(created.tenantId), keyId: String(created.keyId) };
}

async function openaiWithAlias(): Promise<string> {
  const created = await openaiChat();
  ok(['set-alias', '--tenant-id', created.tenantId, '--alias', 'auto', '--deployment', 'chat']);
  return created.tenantId;
}

async function openaiChat(): Promise<{ tenantId: string; keyId: string }> {
  const created = await provision();
  ok(['register-openai-connection', '--tenant-id', created.tenantId, '--api-key', 'sk-openai-test']);
  ok([
    'register-deployment',
    '--tenant-id',
    created.tenantId,
    '--name',
    'chat',
    '--upstream-model',
    'gpt-test',
    '--timeout-ms',
    '5000',
    '--capabilities',
    'temperature',
    '--enabled',
    'true',
  ]);
  return created;
}

async function providerConnection(provider: string, extra: string[] = []): Promise<string> {
  const created = await provision();
  ok([`register-${provider}-connection`, '--tenant-id', created.tenantId, '--api-key', `sk-${provider}-test`, ...extra]);
  return created.tenantId;
}

async function vertexTenant(authMode: string, apiKey?: string, identity?: string): Promise<string> {
  const created = await provision();
  const args = [
    'register-vertex-connection',
    '--tenant-id',
    created.tenantId,
    '--auth-mode',
    authMode,
    '--project',
    PROJECT,
    '--location',
    LOCATION,
  ];
  if (apiKey !== undefined) args.push('--api-key', apiKey);
  if (identity !== undefined) args.push('--service-account', identity);
  ok(args);
  return created.tenantId;
}

async function estimatedAttempt(tenantId: string): Promise<string> {
  const found = await admin.query<{ id: string; connection_id: string; config_version: number; connection_version: number }>(
    `SELECT d.id, d.connection_id, d.config_version, c.credential_version AS connection_version
     FROM model_deployments d
     JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE d.tenant_id = $1 AND d.name = 'chat'`,
    [tenantId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('deployment is missing');
  const request = await admin.query<{ id: string }>(
    `INSERT INTO proxy_requests (
       tenant_id, deployment_id, deployment_config_version, connection_id, connection_version, requested_model, status
     ) VALUES ($1, $2, $3, $4, $5, 'gpt-test', 'succeeded') RETURNING id`,
    [tenantId, row.id, row.config_version, row.connection_id, row.connection_version],
  );
  const requestId = request.rows[0]?.id;
  if (requestId === undefined) throw new Error('request was not stored');
  const attempt = await admin.query<{ id: string }>(
    `INSERT INTO model_attempts (
       tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status
     ) VALUES ($1, $2, $3, $4, 'gpt-test', 'succeeded') RETURNING id`,
    [tenantId, requestId, row.id, row.config_version],
  );
  const attemptId = attempt.rows[0]?.id;
  if (attemptId === undefined) throw new Error('attempt was not stored');
  await admin.query(
    `INSERT INTO attempt_costs (tenant_id, attempt_id, cost_status, amount) VALUES ($1, $2, 'estimated', 1.25)`,
    [tenantId, attemptId],
  );
  return attemptId;
}

function deploymentValues(tenantId: string, provider: string, extra: Values = {}): Values {
  return {
    'tenant-id': tenantId,
    name: 'chat',
    'upstream-model': provider === 'dgx' ? 'private-model' : 'gpt-test',
    'timeout-ms': '5000',
    capabilities: 'temperature',
    enabled: provider === 'openai' ? 'true' : 'false',
    provider,
    ...extra,
  };
}

const specs: Spec[] = [
  {
    action: 'create',
    command: 'provision-tenant',
    configuration: 'tenant name and label',
    prepare: async () => ({ name: 'cli-tenant', label: 'ops' }),
  },
  {
    action: 'create',
    command: 'add-key',
    configuration: 'tenant api key label',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId, label: 'extra' }),
  },
  {
    action: 'create',
    command: 'register-openai-connection',
    configuration: 'openai api key connection',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId, 'api-key': 'sk-openai-test' }),
  },
  {
    action: 'create',
    command: 'register-anthropic-connection',
    configuration: 'anthropic endpoint and workspace',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'api-key': 'sk-anthropic-test',
      endpoint: ANTHROPIC_ENDPOINT,
      'workspace-id': 'ws-1',
    }),
  },
  {
    action: 'create',
    command: 'register-vertex-connection',
    configuration: 'vertex service_account project and location',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'api-key': VERTEX_KEY,
      'auth-mode': 'service_account',
      project: PROJECT,
      location: LOCATION,
      'api-version': 'v1',
    }),
  },
  {
    action: 'create',
    command: 'register-vertex-connection',
    configuration: 'vertex adc without an api key',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'auth-mode': 'adc',
      project: PROJECT,
      location: LOCATION,
    }),
  },
  {
    action: 'create',
    command: 'register-vertex-connection',
    configuration: 'vertex workload_identity without an api key',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'auth-mode': 'workload_identity',
      project: PROJECT,
      location: LOCATION,
    }),
  },
  {
    action: 'create',
    command: 'register-vertex-connection',
    configuration: 'vertex impersonation service account',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'auth-mode': 'impersonation',
      project: PROJECT,
      location: LOCATION,
      'service-account': IDENTITY,
    }),
  },
  {
    action: 'create',
    command: 'register-xai-connection',
    configuration: 'xai api key connection',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId, 'api-key': 'sk-xai-test' }),
  },
  {
    action: 'create',
    command: 'register-openrouter-connection',
    configuration: 'openrouter api key connection',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId, 'api-key': 'sk-openrouter-test' }),
  },
  {
    action: 'create',
    command: 'register-dgx-connection',
    configuration: 'dgx private endpoint connection',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'api-key': 'dgx-secret',
      endpoint: DGX_ENDPOINT,
    }),
  },
  {
    action: 'create',
    command: 'register-deployment',
    configuration: 'openai deployment',
    prepare: async () => deploymentValues(await providerConnection('openai'), 'openai'),
  },
  {
    action: 'create',
    command: 'register-deployment',
    configuration: 'anthropic deployment with default max output tokens',
    prepare: async () => deploymentValues(
      await providerConnection('anthropic', ['--endpoint', ANTHROPIC_ENDPOINT]),
      'anthropic',
      { 'default-max-output-tokens': '64', capabilities: 'temperature,stop,max_completion_tokens' },
    ),
  },
  {
    action: 'create',
    command: 'register-deployment',
    configuration: 'vertex deployment',
    prepare: async () => deploymentValues(await vertexTenant('service_account', VERTEX_KEY), 'vertex'),
  },
  {
    action: 'create',
    command: 'register-deployment',
    configuration: 'xai deployment',
    prepare: async () => deploymentValues(await providerConnection('xai'), 'xai'),
  },
  {
    action: 'create',
    command: 'register-deployment',
    configuration: 'openrouter downstream providers and data collection',
    prepare: async () => deploymentValues(await providerConnection('openrouter'), 'openrouter', {
      'downstream-providers': 'openai',
      'data-collection': 'deny',
      'allow-fallbacks': 'false',
      'require-serving-provider': 'true',
    }),
  },
  {
    action: 'create',
    command: 'register-deployment',
    configuration: 'dgx deployment',
    prepare: async () => deploymentValues(
      await providerConnection('dgx', ['--endpoint', DGX_ENDPOINT]),
      'dgx',
    ),
  },
  {
    action: 'create',
    command: 'register-price',
    configuration: 'price version rates region tier and serving provider',
    prepare: async () => ({ ...PRICE }),
  },
  {
    action: 'create',
    command: 'approve-private-endpoint',
    configuration: 'private host port addresses tls and health endpoint',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      host: 'dgx.lab.internal',
      port: '8443',
      addresses: '10.0.0.8',
      'tls-verify': 'true',
      'health-endpoint': 'https://dgx.lab.internal:8443/health',
    }),
  },
  {
    action: 'update',
    command: 'revoke-key',
    configuration: 'revoke a tenant api key',
    prepare: async () => {
      const created = await provision();
      const extra = ok(['add-key', '--tenant-id', created.tenantId, '--label', 'extra']);
      return { 'tenant-id': created.tenantId, 'key-id': String(extra.keyId) };
    },
  },
  {
    action: 'update',
    command: 'set-openai-credential',
    configuration: 'replace openai api key',
    prepare: async () => ({
      'tenant-id': await providerConnection('openai'),
      'api-key': 'sk-openai-rotated',
    }),
  },
  {
    action: 'update',
    command: 'set-anthropic-credential',
    configuration: 'replace anthropic api key',
    prepare: async () => ({
      'tenant-id': await providerConnection('anthropic', ['--endpoint', ANTHROPIC_ENDPOINT]),
      'api-key': 'sk-anthropic-rotated',
    }),
  },
  {
    action: 'update',
    command: 'set-connection-enabled',
    configuration: 'disable openai connection',
    prepare: async () => ({
      'tenant-id': await providerConnection('openai'),
      enabled: 'false',
      provider: 'openai',
    }),
  },
  {
    action: 'update',
    command: 'set-connection-enabled',
    configuration: 'disable anthropic connection',
    prepare: async () => ({
      'tenant-id': await providerConnection('anthropic', ['--endpoint', ANTHROPIC_ENDPOINT]),
      enabled: 'false',
      provider: 'anthropic',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-enabled',
    configuration: 'disable a deployment',
    prepare: async () => ({ 'tenant-id': (await openaiChat()).tenantId, name: 'chat', enabled: 'false' }),
  },
  {
    action: 'update',
    command: 'set-alias',
    configuration: 'alias auto to a deployment',
    prepare: async () => ({ 'tenant-id': (await openaiChat()).tenantId, alias: 'auto', deployment: 'chat' }),
  },
  {
    action: 'update',
    command: 'set-tenant-streaming',
    configuration: 'enable tenant streaming',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId, enabled: 'true' }),
  },
  {
    action: 'update',
    command: 'set-deployment-streaming',
    configuration: 'deployment streaming timeouts',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      enabled: 'true',
      'connect-timeout-ms': '5000',
      'idle-timeout-ms': '5000',
      'total-timeout-ms': '5000',
      'backpressure-timeout-ms': '5000',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-concurrency',
    configuration: 'dgx deployment max concurrency',
    prepare: async () => {
      const tenantId = await providerConnection('dgx', ['--endpoint', DGX_ENDPOINT]);
      ok([
        'register-deployment',
        '--tenant-id',
        tenantId,
        '--provider',
        'dgx',
        '--name',
        'chat',
        '--upstream-model',
        'private-model',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
      ]);
      return { 'tenant-id': tenantId, deployment: 'chat', 'max-concurrency': '2' };
    },
  },
  {
    action: 'update',
    command: 'set-deployment-health',
    configuration: 'deployment health status',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      status: 'healthy',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-service-tier',
    configuration: 'deployment service tier',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      'service-tier': 'batch',
    }),
  },
  {
    action: 'update',
    command: 'reconcile-attempt-cost',
    configuration: 'reconcile an estimated attempt cost',
    prepare: async () => {
      const created = await openaiChat();
      return { 'tenant-id': created.tenantId, 'attempt-id': await estimatedAttempt(created.tenantId) };
    },
  },
  {
    action: 'update',
    command: 'set-execution-policy',
    configuration: 'retries and deadlines',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      retries: 'true',
      'connection-deadline-ms': '5000',
      'attempt-deadline-ms': '5000',
      'total-deadline-ms': '5000',
      'initial-backoff-ms': '100',
      'max-backoff-ms': '1000',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-breaker',
    configuration: 'enabled breaker window samples threshold cooldown and probes',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      enabled: 'true',
      'window-ms': '60000',
      'min-samples': '4',
      'failure-threshold': '2',
      'cooldown-ms': '30000',
      'max-probes': '1',
    }),
  },
  {
    action: 'update',
    command: 'reset-deployment-breaker',
    configuration: 'reset breaker to closed',
    prepare: async () => ({ 'tenant-id': (await openaiChat()).tenantId, deployment: 'chat' }),
  },
  {
    action: 'update',
    command: 'set-fallback-policy',
    configuration: 'fallback alias deployments failures capabilities and providers',
    prepare: async () => ({
      'tenant-id': await openaiWithAlias(),
      alias: 'auto',
      enabled: 'true',
      deployments: 'chat',
      failures: 'unavailable',
      'max-attempts': '2',
      capabilities: 'temperature',
      providers: 'openai',
      'data-collection': 'allow',
      'min-remaining-deadline-ms': '0',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-context-limit',
    configuration: 'deployment context limit',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      'context-limit': '8192',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-data-collection',
    configuration: 'deployment data collection',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      'data-collection': 'deny',
    }),
  },
  {
    action: 'update',
    command: 'set-tenant-limits',
    configuration: 'tenant request concurrency stream token and lease limits',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      mode: 'hard',
      'requests-per-minute': '60',
      'concurrent-requests': '4',
      'concurrent-streams': '2',
      'token-rate': '1000',
      'lease-ms': '120000',
    }),
  },
  {
    action: 'update',
    command: 'set-api-key-limits',
    configuration: 'api key limits',
    prepare: async () => {
      const created = await provision();
      return {
        'tenant-id': created.tenantId,
        'key-id': created.keyId,
        mode: 'observe',
        'requests-per-minute': '30',
        'concurrent-requests': '2',
        'concurrent-streams': '1',
        'token-rate': '500',
      };
    },
  },
  {
    action: 'update',
    command: 'set-connection-limit',
    configuration: 'connection concurrency and share group',
    prepare: async () => ({
      'tenant-id': await providerConnection('openai'),
      provider: 'openai',
      mode: 'hard',
      'max-concurrency': '4',
      'share-group': 'team-a',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-limit',
    configuration: 'deployment admission concurrency',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      mode: 'hard',
      'max-concurrency': '3',
    }),
  },
  {
    action: 'update',
    command: 'set-tenant-budget',
    configuration: 'tenant monthly budget',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      mode: 'hard',
      'monthly-amount': '25.5',
    }),
  },
  {
    action: 'update',
    command: 'recover-budget',
    configuration: 'close open budget reservations',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId }),
  },
  {
    action: 'validate',
    command: 'validate-deployment',
    configuration: 'deployment validation status',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      status: 'valid',
    }),
  },
  {
    action: 'validate',
    command: 'validate-vertex-credential',
    configuration: 'stored vertex credential that fails before the network',
    expectFailure: true,
    prepare: async () => ({ 'tenant-id': await vertexTenant('service_account', VERTEX_KEY) }),
  },
  {
    action: 'validate',
    command: 'validate-vertex-access',
    configuration: 'stored vertex access that fails before the network',
    expectFailure: true,
    prepare: async () => ({ 'tenant-id': await vertexTenant('service_account', VERTEX_KEY) }),
  },
  {
    action: 'validate',
    command: 'test-vertex-inference',
    configuration: 'stored vertex deployment that fails before the network',
    expectFailure: true,
    prepare: async () => {
      const tenantId = await vertexTenant('service_account', VERTEX_KEY);
      ok([
        'register-deployment',
        '--tenant-id',
        tenantId,
        '--provider',
        'vertex',
        '--name',
        'chat',
        '--upstream-model',
        'gemini-test',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
      ]);
      return { 'tenant-id': tenantId, deployment: 'chat' };
    },
  },
  {
    action: 'validate',
    command: 'list-private-models',
    configuration: 'stored dgx route that fails before a live provider',
    expectFailure: true,
    prepare: async () => ({ 'tenant-id': await privateRoute(), deployment: 'chat' }),
  },
  {
    action: 'validate',
    command: 'probe-private-health',
    configuration: 'stored dgx health route that fails before a live provider',
    expectFailure: true,
    prepare: async () => ({ 'tenant-id': await privateRoute(), deployment: 'chat' }),
  },
  {
    action: 'validate',
    command: 'show-fallback-policy',
    configuration: 'stored fallback policy',
    prepare: async () => {
      const tenantId = await openaiWithAlias();
      ok([
        'set-fallback-policy',
        '--tenant-id',
        tenantId,
        '--alias',
        'auto',
        '--enabled',
        'true',
        '--deployments',
        'chat',
        '--failures',
        'unavailable',
        '--max-attempts',
        '2',
        '--capabilities',
        'temperature',
        '--providers',
        'openai',
        '--data-collection',
        'allow',
        '--min-remaining-deadline-ms',
        '0',
      ]);
      return { 'tenant-id': tenantId, alias: 'auto' };
    },
  },
  {
    action: 'validate',
    command: 'list-inference',
    configuration: 'tenant connections deployments and aliases',
    prepare: async () => ({ 'tenant-id': (await openaiChat()).tenantId }),
  },
  {
    action: 'update',
    command: 'set-sample-policy',
    configuration: 'metadata only sample policy',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      mode: 'metadata_only',
      'content-capture': 'false',
      'streaming-capture': 'false',
      replay: 'false',
      'judge-disclosure': 'false',
      'sample-rate': '0',
      'max-sample-bytes': '0',
      'max-sample-count': '0',
      'retention-seconds': '0',
    }),
  },
  {
    action: 'update',
    command: 'set-deployment-data-class',
    configuration: 'deployment data class',
    prepare: async () => ({
      'tenant-id': (await openaiChat()).tenantId,
      deployment: 'chat',
      'data-class': 'internal',
    }),
  },
  {
    action: 'validate',
    command: 'show-sample-policy',
    configuration: 'stored sample policy',
    prepare: async () => {
      const tenantId = (await openaiChat()).tenantId;
      ok([
        'set-sample-policy',
        '--tenant-id',
        tenantId,
        '--mode',
        'metadata_only',
      ]);
      return { 'tenant-id': tenantId };
    },
  },
  {
    action: 'update',
    command: 'delete-sample',
    configuration: 'missing sample',
    prepare: async () => ({
      'tenant-id': (await provision()).tenantId,
      'sample-id': '00000000-0000-4000-8000-000000000000',
    }),
  },
  {
    action: 'update',
    command: 'cleanup-expired-samples',
    configuration: 'expired sample cleanup',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId }),
  },
  {
    action: 'validate',
    command: 'show-sample-stats',
    configuration: 'empty sample stats',
    prepare: async () => ({ 'tenant-id': (await provision()).tenantId }),
  },
];

async function privateRoute(): Promise<string> {
  const tenantId = await providerConnection('dgx', ['--endpoint', DGX_ENDPOINT]);
  ok([
    'register-deployment',
    '--tenant-id',
    tenantId,
    '--provider',
    'dgx',
    '--name',
    'chat',
    '--upstream-model',
    'private-model',
    '--timeout-ms',
    '5000',
    '--capabilities',
    'temperature',
  ]);
  ok([
    'approve-private-endpoint',
    '--tenant-id',
    tenantId,
    '--host',
    'dgx.invalid',
    '--port',
    '443',
    '--addresses',
    '10.0.0.8',
    '--tls-verify',
    'true',
    '--health-endpoint',
    'https://dgx.invalid:443/health',
  ]);
  return tenantId;
}

function record(spec: Spec, text: string): void {
  evidence.push(`command: ${spec.command}\naction: ${spec.action}\nconfiguration: ${spec.configuration}\n${text}\n`);
}

async function compare(spec: Spec): Promise<void> {
  const flagValues = await spec.prepare(db);
  const interactiveValues = await spec.prepare(db);
  const flagRun = run(flags(spec.command, flagValues));
  const interactiveRun = run(['--interactive'], script(spec.action, spec.command, interactiveValues));
  expect(flagRun.signal, flagRun.stderr).toBeNull();
  expect(interactiveRun.signal, interactiveRun.stderr).toBeNull();
  expect(interactiveRun.status, interactiveRun.stderr).toBe(flagRun.status);
  if (spec.expectFailure) {
    expect(flagRun.status, flagRun.stderr).toBe(1);
    expect(errorOf(interactiveRun.stderr)).toEqual(errorOf(flagRun.stderr));
    record(spec, `status: ${flagRun.status}\nerror: ${JSON.stringify(errorOf(flagRun.stderr))}`);
    return;
  }
  expect(flagRun.status, flagRun.stderr).toBe(0);
  const flagBody = stable(JSON.parse(flagRun.stdout));
  const interactiveBody = stable(JSON.parse(interactiveRun.stdout));
  expect(interactiveBody).toEqual(flagBody);
  record(spec, `status: 0\nresult: ${JSON.stringify(flagBody)}`);
}

function waitFor(text: () => string, needle: string, from: number, child: { exitCode: number | null }): Promise<number> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = text().indexOf(needle, from);
      if (found >= 0) {
        clearInterval(timer);
        resolve(found + needle.length);
        return;
      }
      if (child.exitCode !== null || Date.now() - started > 15_000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${JSON.stringify(needle)}\n${text()}`));
      }
    }, 15);
  });
}

async function journey(name: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliEntry, '--interactive'], {
    cwd: projectRoot,
    env: serviceEnv(db, cliEnv()),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let seen = 0;
  const ask = async (prompt: string, answer: string) => {
    seen = await waitFor(() => stderr, prompt, seen, child);
    child.stdin.write(`${answer}\n`);
  };
  await ask('action: ', 'create');
  await ask('command: ', 'provision-tenant');
  await ask('name: ', name);
  await ask('label: ', 'ops');
  const createdAt = Date.now();
  while (!stdout.includes('\n')) {
    if (Date.now() - createdAt > 15_000) throw new Error(`tenant json missing\n${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const created = JSON.parse(stdout.trim().split('\n')[0] ?? '') as { tenantId?: string };
  if (typeof created.tenantId !== 'string') throw new Error('tenant id missing');
  await ask('action: ', 'create');
  await ask('command: ', 'register-openai-connection');
  await ask('tenant-id: ', created.tenantId);
  await ask('api-key: ', 'sk-journey-openai');
  await ask('action: ', 'update');
  await ask('command: ', 'set-openai-credential');
  await ask('tenant-id: ', created.tenantId);
  await ask('api-key: ', 'sk-journey-rotated');
  await ask('action: ', 'validate');
  await ask('command: ', 'list-inference');
  await ask('tenant-id: ', created.tenantId);
  await ask('action: ', 'done');
  child.stdin.end();
  const status = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`journey timed out\n${stdout}\n${stderr}`));
    }, 20_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { status, stdout, stderr };
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('interactive CLI', () => {
  beforeAll(() => {
    admin = adminPool(db);
  });

  afterAll(async () => {
    await admin.end();
    if (evidenceDir === undefined || evidence.length === 0) return;
    mkdirSync(evidenceDir, { recursive: true });
    const inventory = Object.entries(INTERACTIVE_GROUPS)
      .flatMap(([action, commands]) => Object.entries(commands).map(([command, fields]) => `${action} ${command}: ${fields.join(', ')}`))
      .join('\n');
    writeFileSync(join(evidenceDir, 'commands.txt'), `catalog\n${inventory}\n\n${evidence.join('\n')}`);
  });

  it('lists every current command in one action group', () => {
    const listed = Object.values(INTERACTIVE_GROUPS).flatMap((group) => Object.keys(group));
    expect(listed.sort()).toEqual([...COMMANDS].sort());
    expect(new Set(listed).size).toBe(COMMANDS.length);
    const covered = new Set(specs.map((spec) => spec.command));
    expect([...covered].sort()).toEqual([...COMMANDS].sort());
  });

  it('keeps the HTTP server free of configuration routes', () => {
    const source = readFileSync(join(projectRoot, 'src/http/app.ts'), 'utf8');
    const posts = [...source.matchAll(/app\.post\('([^']+)'/g)].map((match) => match[1]);
    expect(posts).toEqual(['/v1/chat/completions']);
  });

  it('rejects --interactive mixed with another argument', () => {
    const mixed = run(['--interactive', 'provision-tenant']);
    const trailing = run(['provision-tenant', '--name', 'kept', '--interactive']);
    expect(mixed.status).toBe(1);
    expect(trailing.status).toBe(1);
    expect(errorOf(mixed.stderr).msg).toBe('invalid command arguments');
    expect(errorOf(trailing.stderr).msg).toBe('invalid command arguments');
  });

  it('rejects a stray flag on the existing flag path', () => {
    const result = run(['provision-tenant', '--name', 'kept', '--host', 'nope']);
    expect(result.status).toBe(1);
    expect(errorOf(result.stderr).msg).toBe('invalid command arguments');
  });

  it('rejects an unknown interactive action and leaves tenants unchanged', async () => {
    const before = await tenantCount();
    const result = run(['--interactive'], 'nope\n');
    expect(result.status).toBe(1);
    expect(errorOf(result.stderr).msg).toBe('invalid command arguments');
    expect(await tenantCount()).toBe(before);
  });

  it('rejects a blank tenant name the same way as the flag command', async () => {
    const before = await tenantCount();
    const flagRun = run(['provision-tenant']);
    const interactiveRun = run(['--interactive'], 'create\nprovision-tenant\n\n\ndone\n');
    expect(flagRun.status).toBe(1);
    expect(interactiveRun.status).toBe(1);
    expect(errorOf(interactiveRun.stderr).msg).toBe(errorOf(flagRun.stderr).msg);
    expect(errorOf(flagRun.stderr).msg).toBe('name is required');
    expect(await tenantCount()).toBe(before);
  });

  for (const spec of specs) {
    it(`${spec.action} ${spec.command} (${spec.configuration})`, async () => {
      await compare(spec);
    });
  }

  it('runs a scripted create update and validate journey twice', async () => {
    const first = await journey('journey-one');
    const second = await journey('journey-two');
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const firstLines = jsonLines(first.stdout);
    const secondLines = jsonLines(second.stdout);
    expect(firstLines).toHaveLength(4);
    expect(secondLines).toHaveLength(4);
    expect(firstLines.map((line) => Object.keys(line).sort())).toEqual(secondLines.map((line) => Object.keys(line).sort()));
    expect(firstLines[0]?.name).toBe('journey-one');
    expect(secondLines[0]?.name).toBe('journey-two');
    expect(String(firstLines[0]?.secret)).toMatch(/^yck_/);
    expect(String(secondLines[0]?.secret)).toMatch(/^yck_/);
    expect(firstLines[2]?.credentialVersion).toBe(2);
    expect(secondLines[2]?.credentialVersion).toBe(2);
    const firstList = firstLines[3] as { connections?: Array<{ provider?: string; credentialVersion?: number }> };
    const secondList = secondLines[3] as { connections?: Array<{ provider?: string; credentialVersion?: number }> };
    expect(firstList.connections?.[0]?.provider).toBe('openai');
    expect(secondList.connections?.[0]?.provider).toBe('openai');
    expect(firstList.connections?.[0]?.credentialVersion).toBe(2);
    expect(secondList.connections?.[0]?.credentialVersion).toBe(2);
    if (evidenceDir !== undefined) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'journey-1.txt'), `status: ${first.status}\n\nstdout\n${first.stdout}\nstderr\n${first.stderr}`);
      writeFileSync(join(evidenceDir, 'journey-2.txt'), `status: ${second.status}\n\nstdout\n${second.stdout}\nstderr\n${second.stderr}`);
    }
  });
});
