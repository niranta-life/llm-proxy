import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCredentialStore } from '../src/credentials.js';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { cliEntry, configFor, createTestApp, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKey, provisionTenant, registerAnthropic, registerInference } from './inference-support.js';
import { startMockAnthropic } from './mock-anthropic.js';
import { startMockUpstream } from './mock-openai.js';

const MIGRATION_SHA256: Record<string, string> = {
  '001_schema.sql': '5fb271999098068ddce35308d3b1c182edad4f4d87d1d35c3a9117ee164361b9',
  '002_security.sql': '45638c9b9a377c2d335c771d943eb44a8f72bf85eb722b11e6d3e5fa70b24bf4',
  '003_inference.sql': '0dba7a3c8ca8bec3dd9958ca3b3f1f92e27a8ae0da11ad59e336e7402ee3aba9',
  '004_anthropic.sql': '993a7c477615441538062460f3af81a372747ea74f15c1acaf4e8dcfb76a2585',
  '005_openai_streaming.sql': '1568f883c9731873f051c1c6c9dc1f9e8cdac3ca00aecca7f768ad1c44709e01',
  '006_anthropic_streaming.sql': '72dcec3056c13811ac10cfc12b9c72ff3ea888b66585ba76e05720de942fe27b',
  '007_stream_interrupted.sql': 'de86494160977b01a2b5789131d1918c755a2a815cc0f6fa50d26ff274d129db',
};

const VERTEX_EMAIL = 'vertex-bot@example.iam.gserviceaccount.com';
const VERTEX_SECRET = `{"client_email":"${VERTEX_EMAIL}","private_key":"${'k'.repeat(400)}\n"}`;
const VERTEX_MINIFIED = `{"client_email":"${VERTEX_EMAIL}","private_key":"${'k'.repeat(400)}"}`;
const VERTEX_RESOURCE = 'projects/acme-vertex-proj/serviceAccounts/123456789012345';

function cliRaw(db: TestDatabase, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: projectRoot,
    env: serviceEnv(db, cliEnv()),
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function cliOk(db: TestDatabase, args: string[]): Record<string, unknown> {
  const result = cliRaw(db, args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function cliAsync(db: TestDatabase, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: projectRoot,
      env: serviceEnv(db, cliEnv()),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

function connectionCount(admin: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ count: string }> }> }, tenantId: string, provider: string): Promise<number> {
  return admin
    .query('SELECT count(*)::text AS count FROM provider_connections WHERE tenant_id = $1 AND provider = $2', [tenantId, provider])
    .then((result) => Number(result.rows[0]?.count ?? 0));
}

describe('provider registry', () => {
  const db = loadTestDatabase();
  const pools: { end: () => Promise<unknown> }[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('keeps migrations 001 through 007 and adds the registry columns', async () => {
    const names = readdirSync(join(projectRoot, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
    expect(names).toEqual([
      ...Object.keys(MIGRATION_SHA256),
      '008_provider_registry.sql',
      '009_vertex_provider.sql',
      '010_compatible_providers.sql',
      '011_private_endpoint.sql',
      '012_cost_accounting.sql',
      '013_execution_policy.sql',
      '014_provider_breaker.sql',
      '015_tenant_limits.sql',
      '016_fallback_policy.sql',
      '017_request_features.sql',
    ]);
    for (const [name, hash] of Object.entries(MIGRATION_SHA256)) {
      const body = readFileSync(join(projectRoot, 'migrations', name));
      expect(createHash('sha256').update(body).digest('hex')).toBe(hash);
    }
    const added = readFileSync(join(projectRoot, 'migrations', '008_provider_registry.sql'), 'utf8');
    expect(added).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const compatible = readFileSync(join(projectRoot, 'migrations', '010_compatible_providers.sql'), 'utf8');
    expect(compatible).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const privateEndpoint = readFileSync(join(projectRoot, 'migrations', '011_private_endpoint.sql'), 'utf8');
    expect(privateEndpoint).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const costAccounting = readFileSync(join(projectRoot, 'migrations', '012_cost_accounting.sql'), 'utf8');
    expect(costAccounting).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const executionPolicy = readFileSync(join(projectRoot, 'migrations', '013_execution_policy.sql'), 'utf8');
    expect(executionPolicy).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const providerBreaker = readFileSync(join(projectRoot, 'migrations', '014_provider_breaker.sql'), 'utf8');
    expect(providerBreaker).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const tenantLimits = readFileSync(join(projectRoot, 'migrations', '015_tenant_limits.sql'), 'utf8');
    expect(tenantLimits).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const fallbackPolicy = readFileSync(join(projectRoot, 'migrations', '016_fallback_policy.sql'), 'utf8');
    expect(fallbackPolicy).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const requestFeatures = readFileSync(join(projectRoot, 'migrations', '017_request_features.sql'), 'utf8');
    expect(requestFeatures).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const admin = adminPool(db);
    pools.push(admin);
    const versions = await admin.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(versions.rows.map((row) => row.version)).toEqual(names);
    const columns = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'provider_connections' AND column_name IN ('auth_mode', 'config_version', 'project_id', 'location'))
           OR (table_name = 'model_deployments' AND column_name IN ('validation_status', 'health_status'))
         )
       ORDER BY table_name, column_name`,
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      'model_deployments.health_status',
      'model_deployments.validation_status',
      'provider_connections.auth_mode',
      'provider_connections.config_version',
      'provider_connections.location',
      'provider_connections.project_id',
    ]);
    const index = await admin.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [
      'model_deployments_tenant_validation_idx',
    ]);
    expect(index.rowCount).toBe(1);
    const security = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = 'provider_connections'`,
    );
    expect(security.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('serves OpenAI, Anthropic, and an enabled Vertex deployment on one tenant', async () => {
    const openai = await startMockUpstream();
    const anthropic = await startMockAnthropic();
    try {
      const tenant = provisionTenant(db, 'Registry Existing');
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: 'sk-test-registry-openai',
        deployment: 'registry-openai',
        upstreamModel: 'gpt-registry',
      });
      registerAnthropic(db, {
        tenantId: tenant.tenantId,
        apiKey: 'sk-ant-registry',
        endpoint: anthropic.origin,
        deployment: 'registry-claude',
        upstreamModel: 'claude-registry',
      });
      const registered = cliOk(db, [
        'register-vertex-connection',
        '--tenant-id',
        tenant.tenantId,
        '--api-key',
        VERTEX_SECRET,
        '--project',
        'acme-vertex-proj',
        '--location',
        'us-central1',
      ]);
      expect(registered).toMatchObject({
        provider: 'vertex',
        authMode: 'service_account',
        enabled: true,
        endpoint: null,
        projectId: 'acme-vertex-proj',
        location: 'us-central1',
        configVersion: 1,
      });
      expect(JSON.stringify(registered)).not.toContain(VERTEX_EMAIL);
      expect(JSON.stringify(registered)).not.toContain('private_key');
      expect(JSON.stringify(registered)).not.toContain('aes-256-gcm$');
      cliOk(db, [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'vertex',
        '--name',
        'vertex-chat',
        '--upstream-model',
        'gemini-registry',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
      ]);
      const seen: string[] = [];
      const ctx = await createTestApp(db, {
        inferenceEnabled: true,
        upstreamBaseUrl: openai.baseUrl,
        credentialKey,
        vertexClientFactory: async (spec) => {
          seen.push(spec.projectId);
          return {
            async generateContent() {
              return {
                responseId: 'vertex-registry-1',
                modelVersion: 'gemini-registry',
                candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'vertex-ok' }] } }],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
              };
            },
            generateContentStream() {
              return (async function* empty() {})();
            },
            async listModels() {},
          };
        },
      });
      pools.push(ctx.authPool, ctx.runtimePool);
      const headers = {
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
        'content-type': 'application/json',
      };
      const openaiResponse = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: chatPayload('registry-openai', 'openai-still-works'),
      });
      const anthropicResponse = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: chatPayload('registry-claude', 'claude-still-works'),
      });
      const before = openai.hits.length + anthropic.hits.length;
      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: chatPayload('vertex-chat', 'do-not-call-vertex'),
      });
      const callerUrl = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: chatPayload('vertex-chat', 'caller-url', { base_url: 'https://api.openai.com/v1' }),
      });
      expect(openaiResponse.statusCode).toBe(200);
      expect(anthropicResponse.statusCode).toBe(200);
      expect(blocked.statusCode).toBe(200);
      expect(blocked.json().choices[0].message.content).toBe('vertex-ok');
      expect(seen).toEqual(['acme-vertex-proj']);
      expect(callerUrl.statusCode).toBe(400);
      expect(openai.hits.length + anthropic.hits.length).toBe(before);
      const admin = adminPool(db);
      pools.push(admin);
      const attempts = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM proxy_requests r
         JOIN model_deployments d ON d.id = r.deployment_id
         WHERE r.tenant_id = $1 AND d.name = 'vertex-chat'`,
        [tenant.tenantId],
      );
      expect(attempts.rows[0]?.count).toBe('1');
      const stored = await admin.query<{ protected_credential: string; auth_mode: string }>(
        `SELECT protected_credential, auth_mode
         FROM provider_connections
         WHERE tenant_id = $1 AND provider = 'vertex'`,
        [tenant.tenantId],
      );
      expect(stored.rows[0]?.auth_mode).toBe('service_account');
      expect(stored.rows[0]?.protected_credential.startsWith('aes-256-gcm$')).toBe(true);
      expect(stored.rows[0]?.protected_credential).not.toContain('@');
      expect(stored.rows[0]?.protected_credential).not.toContain(VERTEX_EMAIL);
      const logs = ctx.lines.join('\n');
      expect(logs).not.toContain(VERTEX_EMAIL);
      expect(logs).not.toContain('private_key');
      expect(logs).not.toContain('aes-256-gcm$');
    } finally {
      await openai.close();
      await anthropic.close();
    }
  });

  it('registers each new provider and rejects invalid configuration before a write', async () => {
    const tenant = provisionTenant(db, 'Registry Schemas');
    const admin = adminPool(db);
    pools.push(admin);
    const xai = cliOk(db, [
      'register-xai-connection',
      '--tenant-id',
      tenant.tenantId,
      '--api-key',
      'xai-test-key-0123456789',
    ]);
    const openrouter = cliOk(db, [
      'register-openrouter-connection',
      '--tenant-id',
      tenant.tenantId,
      '--api-key',
      'openrouter-test-key-012345',
    ]);
    const dgx = cliOk(db, [
      'register-dgx-connection',
      '--tenant-id',
      tenant.tenantId,
      '--api-key',
      'dgx-test-key-012345678',
      '--endpoint',
      'https://dgx.lab.internal:8443/v1/',
    ]);
    expect(xai).toMatchObject({ provider: 'xai', authMode: 'api_key', endpoint: null, projectId: null, location: null });
    expect(openrouter).toMatchObject({ provider: 'openrouter', authMode: 'api_key', endpoint: null });
    expect(dgx).toMatchObject({ provider: 'dgx', authMode: 'api_key', endpoint: 'https://dgx.lab.internal:8443/v1' });
    expect(VERTEX_MINIFIED).not.toMatch(/\s/);
    const minifiedTenant = provisionTenant(db, 'Registry Minified Key');
    const minified = cliOk(db, [
      'register-vertex-connection',
      '--tenant-id',
      minifiedTenant.tenantId,
      '--api-key',
      VERTEX_MINIFIED,
      '--project',
      'minified-vertex-proj',
      '--location',
      'us-central1',
    ]);
    expect(minified).toMatchObject({
      provider: 'vertex',
      authMode: 'service_account',
      endpoint: null,
      projectId: 'minified-vertex-proj',
      location: 'us-central1',
    });
    expect(JSON.stringify(minified)).not.toContain(VERTEX_EMAIL);
    expect(JSON.stringify(minified)).not.toContain('private_key');
    const storedMinified = await admin.query<{ protected_credential: string }>(
      `SELECT protected_credential FROM provider_connections WHERE tenant_id = $1 AND provider = 'vertex'`,
      [minifiedTenant.tenantId],
    );
    expect(storedMinified.rows[0]?.protected_credential.startsWith('aes-256-gcm$')).toBe(true);
    expect(storedMinified.rows[0]?.protected_credential).not.toContain('@');
    expect(storedMinified.rows[0]?.protected_credential).not.toContain(VERTEX_EMAIL);
    expect(storedMinified.rows[0]?.protected_credential).not.toContain('private_key');
    for (const [provider, secret] of [
      ['xai', 'xai-test-key-0123456789'],
      ['openrouter', 'openrouter-test-key-012345'],
      ['dgx', 'dgx-test-key-012345678'],
    ] as const) {
      const transcript = JSON.stringify(provider === 'xai' ? xai : provider === 'openrouter' ? openrouter : dgx);
      expect(transcript).not.toContain(secret);
      expect(transcript).not.toContain('aes-256-gcm$');
    }

    const cases: Array<{ args: string[]; provider: string; message: string }> = [
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_EMAIL, '--project', 'acme-vertex-proj', '--location', 'us-central1'],
        provider: 'vertex',
        message: 'service account identity is not a credential',
      },
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_RESOURCE, '--project', 'acme-vertex-proj', '--location', 'us-central1'],
        provider: 'vertex',
        message: 'service account identity is not a credential',
      },
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_SECRET, '--project', 'Bad_Project', '--location', 'us-central1'],
        provider: 'vertex',
        message: 'project is invalid',
      },
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_SECRET, '--project', 'acme-vertex-proj', '--location', 'US-CENTRAL1'],
        provider: 'vertex',
        message: 'location is invalid',
      },
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_SECRET, '--project', 'acme-vertex-proj', '--location', 'us-central1', '--auth-mode', 'api_key'],
        provider: 'vertex',
        message: 'auth mode is not supported',
      },
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_SECRET, '--project', 'acme-vertex-proj', '--location', 'us-central1', '--endpoint', 'https://aiplatform.googleapis.com'],
        provider: 'vertex',
        message: 'endpoint is not allowed',
      },
      {
        args: ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--api-key', VERTEX_SECRET, '--project', 'acme-vertex-proj', '--location', 'global', '--client-email', VERTEX_EMAIL],
        provider: 'vertex',
        message: 'invalid command arguments',
      },
      {
        args: ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-test-key-0123456789', '--endpoint', 'https://api.x.ai/v1'],
        provider: 'xai',
        message: 'endpoint is not allowed',
      },
      {
        args: ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-test-key-0123456789', '--auth-mode', 'service_account'],
        provider: 'xai',
        message: 'auth mode is not supported',
      },
      {
        args: ['register-openrouter-connection', '--tenant-id', tenant.tenantId, '--api-key', 'openrouter-test-key-012345', '--endpoint', 'https://openrouter.ai/api/v1'],
        provider: 'openrouter',
        message: 'endpoint is not allowed',
      },
      {
        args: ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-test-key-012345678'],
        provider: 'dgx',
        message: 'endpoint is invalid',
      },
      {
        args: ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-test-key-012345678', '--endpoint', 'http://dgx.lab.internal/v1'],
        provider: 'dgx',
        message: 'endpoint is invalid',
      },
      {
        args: ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-test-key-012345678', '--endpoint', 'https://user:pass@dgx.lab.internal/v1'],
        provider: 'dgx',
        message: 'endpoint is invalid',
      },
      {
        args: ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-test-key-012345678', '--endpoint', 'https://api.openai.com/v1'],
        provider: 'dgx',
        message: 'endpoint is invalid',
      },
      {
        args: ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-test-key-012345678', '--endpoint', 'https://aiplatform.googleapis.com/v1'],
        provider: 'dgx',
        message: 'endpoint is invalid',
      },
      {
        args: ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-second-key-012345', '--endpoint', 'https://dgx.lab.internal/v1'],
        provider: 'dgx',
        message: 'provider connection already exists',
      },
      {
        args: ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'xai', '--name', 'bad-caps', '--upstream-model', 'grok-test', '--timeout-ms', '5000', '--capabilities', 'tools', '--enabled', 'true'],
        provider: 'xai',
        message: 'deployment arguments are invalid',
      },
    ];
    for (const item of cases) {
      const before = await connectionCount(admin, tenant.tenantId, item.provider);
      const failed = cliRaw(db, item.args);
      expect(failed.status, failed.stderr).not.toBe(0);
      expect(failed.stderr).toContain(item.message);
      expect(failed.stdout).not.toContain(VERTEX_EMAIL);
      expect(failed.stderr).not.toContain(VERTEX_RESOURCE);
      expect(failed.stderr).not.toContain(VERTEX_SECRET);
      expect(failed.stderr).not.toContain('aes-256-gcm$');
      expect(await connectionCount(admin, tenant.tenantId, item.provider)).toBe(before);
    }

    const migrator = createPool(configFor(db), 'migrator', undefined, 1);
    pools.push(migrator);
    const protectedKey = createCredentialStore(credentialKey).protect('xai-test-key-0123456789');
    await expect(
      migrator.query('SELECT * FROM register_registry_connection($1::uuid, $2, $3, $4, $5, $6, $7)', [
        tenant.tenantId,
        'xai',
        protectedKey,
        'bearer',
        null,
        null,
        null,
      ]),
    ).rejects.toThrow(/auth mode is not supported/);
    const fake = `aes-256-gcm$${'a'.repeat(48)}`;
    await expect(
      admin.query(
        `INSERT INTO provider_connections (tenant_id, provider, protected_credential, auth_mode, project_id, location)
         VALUES ($1, 'vertex', $2, 'api_key', 'not-an-email@example.com', 'us-central1')`,
        [tenant.tenantId, fake],
      ),
    ).rejects.toThrow(/provider_connections_registry_shape_check/);
    const deployments = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_deployments WHERE tenant_id = $1 AND name = 'bad-caps'`,
      [tenant.tenantId],
    );
    expect(deployments.rows[0]?.count).toBe('0');
    expect(await connectionCount(admin, tenant.tenantId, 'vertex')).toBe(0);
  });

  it('separates validation status from health and increments configuration version', async () => {
    const openai = await startMockUpstream();
    try {
      const tenant = provisionTenant(db, 'Registry Versions');
      const connection = cliOk(db, [
        'register-vertex-connection',
        '--tenant-id',
        tenant.tenantId,
        '--api-key',
        VERTEX_SECRET,
        '--project',
        'version-vertex-proj',
        '--location',
        'europe-west1',
      ]);
      expect(connection.configVersion).toBe(1);
      const disabled = cliOk(db, [
        'set-connection-enabled',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'vertex',
        '--enabled',
        'false',
      ]);
      expect(disabled).toMatchObject({ enabled: false, credentialVersion: 2 });
      cliOk(db, [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'vertex',
        '--name',
        'version-chat',
        '--upstream-model',
        'gemini-version',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ]);
      const beforeHits = openai.hits.length;
      const validated = cliOk(db, [
        'validate-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'version-chat',
        '--status',
        'valid',
      ]);
      expect(openai.hits.length).toBe(beforeHits);
      expect(validated).toMatchObject({ validationStatus: 'valid', healthStatus: 'unknown', configVersion: 2 });
      const unhealthy = cliOk(db, [
        'set-deployment-health',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'version-chat',
        '--status',
        'unhealthy',
      ]);
      expect(unhealthy).toMatchObject({ validationStatus: 'valid', healthStatus: 'unhealthy', configVersion: 2 });
      const deploymentOff = cliOk(db, [
        'set-deployment-enabled',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'version-chat',
        '--enabled',
        'false',
      ]);
      expect(deploymentOff.configVersion).toBe(3);
      cliOk(db, [
        'set-connection-enabled',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'vertex',
        '--enabled',
        'true',
      ]);
      cliOk(db, [
        'set-deployment-enabled',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'version-chat',
        '--enabled',
        'true',
      ]);
      const listing = cliOk(db, ['list-inference', '--tenant-id', tenant.tenantId]);
      const text = JSON.stringify(listing);
      expect(text).not.toContain(VERTEX_EMAIL);
      expect(text).not.toContain('private_key');
      expect(text).not.toContain('aes-256-gcm$');
      const connections = listing.connections as Array<Record<string, unknown>>;
      const deployments = listing.deployments as Array<Record<string, unknown>>;
      expect(connections[0]).toMatchObject({
        provider: 'vertex',
        authMode: 'service_account',
        enabled: true,
        projectId: 'version-vertex-proj',
        location: 'europe-west1',
        endpoint: null,
      });
      expect(Number(connections[0]?.configVersion)).toBeGreaterThan(1);
      expect(deployments[0]).toMatchObject({
        name: 'version-chat',
        enabled: true,
        validationStatus: 'valid',
        healthStatus: 'unhealthy',
        capabilities: ['temperature'],
      });
      const badValidation = cliRaw(db, [
        'validate-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'version-chat',
        '--status',
        'guess',
      ]);
      expect(badValidation.status).not.toBe(0);
      expect(badValidation.stderr).toContain('validation status is invalid');
      const after = cliOk(db, ['list-inference', '--tenant-id', tenant.tenantId]);
      const afterDeployment = (after.deployments as Array<Record<string, unknown>>)[0];
      expect(afterDeployment).toMatchObject({ validationStatus: 'valid', healthStatus: 'unhealthy' });
    } finally {
      await openai.close();
    }
  });

  it('isolates tenant configuration, validation, and credential references', async () => {
    const alpha = provisionTenant(db, 'Registry Alpha');
    const beta = provisionTenant(db, 'Registry Beta');
    const [alphaResult, betaResult] = await Promise.all([
      cliAsync(db, [
        'register-vertex-connection',
        '--tenant-id',
        alpha.tenantId,
        '--api-key',
        VERTEX_SECRET,
        '--project',
        'alpha-vertex-proj',
        '--location',
        'us-central1',
      ]),
      cliAsync(db, [
        'register-xai-connection',
        '--tenant-id',
        beta.tenantId,
        '--api-key',
        'xai-beta-key-0123456789',
      ]),
    ]);
    expect(alphaResult.status, alphaResult.stderr).toBe(0);
    expect(betaResult.status, betaResult.stderr).toBe(0);
    expect(alphaResult.stdout).not.toContain(VERTEX_EMAIL);
    expect(betaResult.stdout).not.toContain('xai-beta-key-0123456789');
    cliOk(db, [
      'register-deployment',
      '--tenant-id',
      alpha.tenantId,
      '--provider',
      'vertex',
      '--name',
      'alpha-vertex',
      '--upstream-model',
      'gemini-alpha',
      '--timeout-ms',
      '5000',
      '--capabilities',
      'temperature',
      '--enabled',
      'true',
    ]);
    cliOk(db, [
      'validate-deployment',
      '--tenant-id',
      alpha.tenantId,
      '--deployment',
      'alpha-vertex',
      '--status',
      'valid',
    ]);
    const alphaList = JSON.stringify(runCli(db, ['list-inference', '--tenant-id', alpha.tenantId], cliEnv()));
    const betaList = JSON.stringify(runCli(db, ['list-inference', '--tenant-id', beta.tenantId], cliEnv()));
    expect(alphaList).toContain('alpha-vertex-proj');
    expect(alphaList).not.toContain('xai-beta-key-0123456789');
    expect(alphaList).not.toContain(beta.tenantId);
    expect(betaList).toContain('xai');
    expect(betaList).not.toContain('alpha-vertex-proj');
    expect(betaList).not.toContain(VERTEX_EMAIL);
    expect(betaList).not.toContain(alpha.tenantId);

    const admin = adminPool(db);
    pools.push(admin);
    const alphaConnection = await admin.query<{ id: string }>(
      `SELECT id FROM provider_connections WHERE tenant_id = $1 AND provider = 'vertex'`,
      [alpha.tenantId],
    );
    const connectionId = alphaConnection.rows[0]?.id ?? '';
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    pools.push(runtime);
    await withTenant(runtime, beta.tenantId, async (client) => {
      const visible = await client.query<{ id: string; provider: string }>('SELECT id, provider FROM provider_connections');
      expect(visible.rows.map((row) => row.provider)).toEqual(['xai']);
      expect(visible.rows[0]?.id).not.toBe(connectionId);
      const deployments = await client.query<{ name: string }>('SELECT name FROM model_deployments');
      expect(deployments.rows).toEqual([]);
      const credential = await client.query<{ protected_credential: string | null }>(
        'SELECT load_provider_credential($1::uuid, $2::uuid) AS protected_credential',
        [alpha.tenantId, connectionId],
      );
      expect(credential.rows[0]?.protected_credential ?? null).toBeNull();
    });
    await expect(
      withTenant(runtime, beta.tenantId, (client) =>
        client.query(`UPDATE model_deployments SET validation_status = 'invalid' WHERE tenant_id = $1`, [alpha.tenantId]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(runtime, beta.tenantId, (client) => client.query('SELECT protected_credential FROM provider_connections')),
    ).rejects.toThrow(/permission denied/i);
    await withTenant(runtime, alpha.tenantId, async (client) => {
      const own = await client.query<{ provider: string }>(
        'SELECT provider FROM provider_connections ORDER BY provider',
      );
      expect(own.rows.map((row) => row.provider)).toEqual(['vertex']);
      const credential = await client.query<{ protected_credential: string | null }>(
        'SELECT load_provider_credential($1::uuid, $2::uuid) AS protected_credential',
        [alpha.tenantId, connectionId],
      );
      expect(credential.rows[0]?.protected_credential?.startsWith('aes-256-gcm$')).toBe(true);
    });
    const stillValid = await admin.query<{ validation_status: string }>(
      `SELECT validation_status FROM model_deployments WHERE tenant_id = $1 AND name = 'alpha-vertex'`,
      [alpha.tenantId],
    );
    expect(stillValid.rows[0]?.validation_status).toBe('valid');
    await expect(
      admin.query(
        `INSERT INTO model_deployments (tenant_id, connection_id, name, upstream_model, timeout_ms, capabilities)
         VALUES ($1, $2, 'stolen', 'gemini-stolen', 1000, '{}')`,
        [beta.tenantId, connectionId],
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });
});
