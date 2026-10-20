import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { configFor, loadTestDatabase, runCli, serviceEnv } from './helpers.js';
import { adminPool, cliEnv, credentialKeyText, provisionTenant, registerInference, resolvedUpstream } from './inference-support.js';

describe('configuration lookup', () => {
  const db = loadTestDatabase();
  const pools: { end: () => Promise<unknown> }[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('registers, enables, and lists a tenant configuration without credential material', async () => {
    const tenant = provisionTenant(db, 'Config Lookup');
    const apiKey = 'sk-test-config-lookup-key';
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey,
      deployment: 'lookup-chat',
      upstreamModel: 'gpt-lookup',
      enabled: false,
    });
    const enabled = runCli(
      db,
      ['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'lookup-chat', '--enabled', 'true'],
      cliEnv(),
    );
    expect(enabled).toMatchObject({ enabled: true });
    const listing = runCli(db, ['list-inference', '--tenant-id', tenant.tenantId], cliEnv()) as {
      streamingEnabled?: boolean;
      connections?: unknown;
      deployments?: Array<{
        name: string;
        upstreamModel: string;
        enabled: boolean;
        configVersion: number;
        streamingEnabled?: boolean;
      }>;
      aliases?: Array<{ alias: string }>;
    };
    const text = JSON.stringify(listing);
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain('aes-256-gcm$');
    expect(listing.streamingEnabled).toBe(false);
    expect(listing.deployments?.[0]?.streamingEnabled).toBe(false);
    expect(listing.aliases?.map((alias) => alias.alias)).toEqual(['auto']);
    expect(listing.deployments?.[0]?.upstreamModel).toBe('gpt-lookup');
    expect(listing.deployments?.[0]?.enabled).toBe(true);
    expect((listing.deployments?.[0]?.configVersion ?? 0) > 1).toBe(true);

    const admin = adminPool(db);
    pools.push(admin);
    const stored = await admin.query<{ protected_credential: string }>(
      'SELECT protected_credential FROM provider_connections WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    expect(stored.rows[0]?.protected_credential.startsWith('aes-256-gcm$')).toBe(true);
    expect(stored.rows[0]?.protected_credential).not.toContain(apiKey);

    expect(await resolvedUpstream(db, tenant.tenantId, 'auto')).toBe('gpt-lookup');
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    pools.push(runtime);
    const client = await runtime.connect();
    try {
      await expect(client.query('SELECT protected_credential FROM provider_connections')).rejects.toThrow(
        /permission denied/i,
      );
      const hidden = await client.query('SELECT id FROM model_deployments');
      expect(hidden.rows).toEqual([]);
    } finally {
      client.release();
    }
    await withTenant(runtime, tenant.tenantId, async (scoped) => {
      await expect(scoped.query('SELECT protected_credential FROM provider_connections')).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  it('requires a credential key when inference is enabled and does not echo it', () => {
    const secret = 'super-secret-provider-key-value';
    expect(() =>
      loadConfig(serviceEnv(db, { INFERENCE_ENABLED: 'true', PROVIDER_CREDENTIAL_KEY: secret })),
    ).toThrow(/32 bytes/);
    try {
      loadConfig(serviceEnv(db, { INFERENCE_ENABLED: 'true', PROVIDER_CREDENTIAL_KEY: secret }));
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(secret);
    }
    const configured = loadConfig(
      serviceEnv(db, { INFERENCE_ENABLED: 'true', PROVIDER_CREDENTIAL_KEY: credentialKeyText }),
    );
    expect(configured.inferenceEnabled).toBe(true);
    expect(loadConfig(serviceEnv(db)).maxActiveStreams).toBe(32);
    expect(() => loadConfig(serviceEnv(db, { MAX_ACTIVE_STREAMS: '0' }))).toThrow(/MAX_ACTIVE_STREAMS/);
    expect(configured.providerCredentialKey?.equals(Buffer.from(credentialKeyText, 'base64'))).toBe(true);
  });
});
