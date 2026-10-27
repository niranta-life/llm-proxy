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
    expect(loadConfig(serviceEnv(db)).maxStreamsPerTenant).toBe(32);
    expect(loadConfig(serviceEnv(db)).streamShutdownDrainMs).toBe(5000);
    expect(loadConfig(serviceEnv(db)).evaluationExecutionEnabled).toBe(false);
    expect(loadConfig(serviceEnv(db)).evaluationReplayTenantIds).toEqual([]);
    expect(loadConfig(serviceEnv(db)).evaluationJudgeTenantIds).toEqual([]);
    const replayTenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(loadConfig(serviceEnv(db, { EVALUATION_JUDGE_TENANTS: replayTenant.toUpperCase() })).evaluationJudgeTenantIds).toEqual([
      replayTenant,
    ]);
    expect(
      loadConfig(serviceEnv(db, { EVALUATION_JUDGE_TENANTS: `${replayTenant.toUpperCase()},${replayTenant}` }))
        .evaluationJudgeTenantIds,
    ).toEqual([replayTenant]);
    expect(() =>
      loadConfig(serviceEnv(db, { EVALUATION_JUDGE_TENANTS: `${replayTenant},bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee` })),
    ).toThrow(/EVALUATION_JUDGE_TENANTS accepts one tenant id/);
    expect(() => loadConfig(serviceEnv(db, { EVALUATION_JUDGE_TENANTS: 'not-a-tenant' }))).toThrow(
      /EVALUATION_JUDGE_TENANTS accepts one tenant id/,
    );
    expect(
      loadConfig(serviceEnv(db, { EVALUATION_REPLAY_TENANTS: `${replayTenant.toUpperCase()},${replayTenant}` }))
        .evaluationReplayTenantIds,
    ).toEqual([replayTenant]);
    expect(() => loadConfig(serviceEnv(db, { EVALUATION_REPLAY_TENANTS: 'not-a-tenant' }))).toThrow(
      /EVALUATION_REPLAY_TENANTS/,
    );
    expect(loadConfig(serviceEnv(db, { STREAM_SHUTDOWN_DRAIN_MS: '0' })).streamShutdownDrainMs).toBe(0);
    expect(() => loadConfig(serviceEnv(db, { MAX_ACTIVE_STREAMS: '0' }))).toThrow(/MAX_ACTIVE_STREAMS/);
    expect(() => loadConfig(serviceEnv(db, { MAX_STREAMS_PER_TENANT: '0' }))).toThrow(/MAX_STREAMS_PER_TENANT/);
    expect(() => loadConfig(serviceEnv(db, { STREAM_SHUTDOWN_DRAIN_MS: '-1' }))).toThrow(/STREAM_SHUTDOWN_DRAIN_MS/);
    expect(configured.providerCredentialKey?.equals(Buffer.from(credentialKeyText, 'base64'))).toBe(true);
    expect(configured.previousCredentialKeys).toEqual([]);
    const previous = Buffer.alloc(32, 4).toString('base64');
    const rotated = loadConfig(
      serviceEnv(db, {
        INFERENCE_ENABLED: 'true',
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
        PROVIDER_CREDENTIAL_KEY_PREVIOUS: previous,
      }),
    );
    expect(rotated.previousCredentialKeys).toHaveLength(1);
    expect(rotated.previousCredentialKeys[0]?.equals(Buffer.from(previous, 'base64'))).toBe(true);
    expect(() =>
      loadConfig(
        serviceEnv(db, {
          INFERENCE_ENABLED: 'true',
          PROVIDER_CREDENTIAL_KEY: credentialKeyText,
          PROVIDER_CREDENTIAL_KEY_PREVIOUS: 'not-a-key',
        }),
      ),
    ).toThrow(/PROVIDER_CREDENTIAL_KEY_PREVIOUS/);
  });
});
