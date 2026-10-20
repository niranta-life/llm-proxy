import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { withTenant } from '../src/db/tenant-context.js';
import { createPool } from '../src/db/pools.js';
import {
  configFor,
  createTestApp,
  loadTestDatabase,
  runCli,
  type TestDatabase,
} from './helpers.js';

describe('tenant isolation', () => {
  const db = loadTestDatabase();
  const pools: pg.Pool[] = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('prevents tenant A from reading or changing tenant B rows', async () => {
    const alpha = requireCreated(runCli(db, ['provision-tenant', '--name', 'Isolation A']));
    const beta = requireCreated(runCli(db, ['provision-tenant', '--name', 'Isolation B']));
    const runtime = track(createPool(configFor(db), 'runtime', undefined, 2));
    const appCtx = await createTestApp(db);
    pools.push(appCtx.authPool, appCtx.runtimePool);

    try {
      await withTenant(runtime, alpha.tenantId, async (client) => {
        const tenants = await client.query<{ id: string; name: string }>('SELECT id, name FROM tenants');
        expect(tenants.rows.map((row) => row.id)).toEqual([alpha.tenantId]);
        const keys = await client.query<{ id: string; tenant_id: string }>(
          'SELECT id, tenant_id FROM tenant_api_keys',
        );
        expect(keys.rows.every((row) => row.tenant_id === alpha.tenantId)).toBe(true);
        expect(keys.rows.map((row) => row.id)).not.toContain(beta.keyId);
      });

      const asAlpha = await appCtx.app.inject({
        method: 'GET',
        url: '/v1/tenant',
        headers: {
          'x-tenant-id': alpha.tenantId,
          authorization: `Bearer ${alpha.secret}`,
        },
      });
      expect(asAlpha.statusCode).toBe(200);
      const alphaBody = asAlpha.json();
      expect(alphaBody.id).toBe(alpha.tenantId);
      expect(JSON.stringify(alphaBody)).not.toContain(beta.tenantId);
      expect(JSON.stringify(alphaBody)).not.toContain('Isolation B');
      expect(JSON.stringify(alphaBody)).not.toContain(alpha.secret);

      const crossed = await appCtx.app.inject({
        method: 'GET',
        url: '/v1/tenant',
        headers: {
          'x-tenant-id': beta.tenantId,
          authorization: `Bearer ${alpha.secret}`,
        },
      });
      expect(crossed.statusCode).toBe(401);
      expect(crossed.json()).toEqual({ error: 'unauthorized' });
      expect(crossed.body).not.toContain('Isolation B');

      const admin = adminPool(db);
      pools.push(admin);
      await admin.query('GRANT UPDATE (label, tenant_id) ON tenant_api_keys TO llm_runtime');
      try {
        const hidden = await withTenant(runtime, alpha.tenantId, async (client) => {
          return client.query('UPDATE tenant_api_keys SET label = $1 WHERE tenant_id = $2', [
            'hacked',
            beta.tenantId,
          ]);
        });
        expect(hidden.rowCount).toBe(0);
        await expect(
          withTenant(runtime, alpha.tenantId, async (client) => {
            await client.query('UPDATE tenant_api_keys SET tenant_id = $1 WHERE tenant_id = $2', [
              beta.tenantId,
              alpha.tenantId,
            ]);
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await admin.query('REVOKE UPDATE (label, tenant_id) ON tenant_api_keys FROM llm_runtime');
      }

      const betaLabel = await admin.query<{ label: string }>(
        'SELECT label FROM tenant_api_keys WHERE id = $1',
        [beta.keyId],
      );
      expect(betaLabel.rows[0]?.label).not.toBe('hacked');
    } finally {
      await appCtx.app.close();
    }
  });

  it('fails closed without tenant context and keeps the runtime role off RLS bypass', async () => {
    const runtime = track(createPool(configFor(db), 'runtime', undefined, 1));
    const auth = track(createPool(configFor(db), 'auth', undefined, 1));
    const migrator = track(createPool(configFor(db), 'migrator', undefined, 1));
    const admin = adminPool(db);
    pools.push(admin);

    const roles = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolinherit: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
       FROM pg_roles
       WHERE rolname IN ('llm_owner', 'llm_migrator', 'llm_auth', 'llm_runtime')
       ORDER BY rolname`,
    );
    const byName = new Map(roles.rows.map((row) => [row.rolname, row]));
    expect(byName.get('llm_runtime')).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolinherit: false,
    });
    expect(byName.get('llm_auth')).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    expect(byName.get('llm_migrator')).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolinherit: false,
    });
    expect(byName.get('llm_owner')).toMatchObject({
      rolsuper: false,
      rolbypassrls: true,
      rolcanlogin: false,
    });

    const membership = await admin.query(
      `SELECT count(*)::int AS members
       FROM pg_auth_members m
       JOIN pg_roles parent ON parent.oid = m.roleid
       JOIN pg_roles child ON child.oid = m.member
       WHERE parent.rolname = 'llm_owner'
         AND child.rolname IN ('llm_runtime', 'llm_auth')`,
    );
    expect(membership.rows[0]?.members).toBe(0);

    const forced = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname IN ('tenants', 'tenant_api_keys')
       ORDER BY relname`,
    );
    expect(forced.rows).toEqual([
      { relname: 'tenant_api_keys', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'tenants', relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const client = await runtime.connect();
    try {
      const seen = await client.query('SELECT id FROM tenants');
      expect(seen.rows).toEqual([]);
      await expect(client.query('SELECT verifier FROM tenant_api_keys')).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }

    await expect(auth.query('SELECT id FROM tenants')).rejects.toThrow(/permission denied/i);
    await expect(runtime.query('SELECT key_id FROM list_active_key_verifiers($1::uuid)', [
      '00000000-0000-4000-8000-000000000000',
    ])).rejects.toThrow(/permission denied/i);
    await expect(migrator.query('SELECT id, name FROM tenants')).rejects.toThrow(/permission denied/i);
    await expect(runtime.query('SET ROLE llm_owner')).rejects.toThrow();
  });

  it('keeps existing tenant rows when migrations run again', async () => {
    const created = requireCreated(runCli(db, ['provision-tenant', '--name', 'Survives migration']));
    const admin = adminPool(db);
    pools.push(admin);
    const before = await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM tenants');
    const migrator = track(createPool(configFor(db), 'migrator', undefined, 1));
    const applied = await migrate(migrator);
    expect(applied).toEqual([]);
    const after = await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM tenants');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const stillThere = await admin.query('SELECT 1 FROM tenants WHERE id = $1', [created.tenantId]);
    expect(stillThere.rowCount).toBe(1);
  });

  function track<T extends pg.Pool>(pool: T): T {
    pools.push(pool);
    return pool;
  }
});

function adminPool(db: TestDatabase): pg.Pool {
  return new pg.Pool({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.username,
    password: db.password,
    max: 1,
  });
}

function requireCreated(value: {
  tenantId?: string;
  keyId?: string;
  secret?: string;
  name?: string;
}): { tenantId: string; keyId: string; secret: string; name: string } {
  if (!value.tenantId || !value.keyId || !value.secret || !value.name) {
    throw new Error('provisioning did not return a tenant credential');
  }
  return { tenantId: value.tenantId, keyId: value.keyId, secret: value.secret, name: value.name };
}
