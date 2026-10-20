import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySecret } from '../src/secrets.js';
import { createTestApp, loadTestDatabase, runCli, type TestDatabase } from './helpers.js';

describe('authentication', () => {
  const db = loadTestDatabase();
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let created: { tenantId: string; keyId: string; secret: string; name: string };

  beforeAll(async () => {
    ctx = await createTestApp(db);
    const provisioned = runCli(db, ['provision-tenant', '--name', 'Alpha']);
    if (!provisioned.tenantId || !provisioned.keyId || !provisioned.secret || !provisioned.name) {
      throw new Error('provisioning did not return a tenant credential');
    }
    created = {
      tenantId: provisioned.tenantId,
      keyId: provisioned.keyId,
      secret: provisioned.secret,
      name: provisioned.name,
    };
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
  });

  it('accepts a matching active tenant and secret', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/tenant',
      headers: {
        'x-tenant-id': created.tenantId,
        authorization: `Bearer ${created.secret}`,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(created.tenantId);
    expect(body.name).toBe('Alpha');
    expect(Object.keys(body).sort()).toEqual(['id', 'keys', 'name']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(created.secret);
    expect(serialized).not.toContain('scrypt$');
    expect(body.keys.map((key: { id: string }) => key.id)).toContain(created.keyId);
  });

  it('rejects missing, malformed, unknown, and mismatched credentials with no tenant data', async () => {
    const cases = [
      { headers: { authorization: `Bearer ${created.secret}` } },
      { headers: { 'x-tenant-id': created.tenantId } },
      { headers: { 'x-tenant-id': created.tenantId, authorization: 'Basic abc' } },
      { headers: { 'x-tenant-id': 'not-a-uuid', authorization: `Bearer ${created.secret}` } },
      {
        headers: {
          'x-tenant-id': '00000000-0000-4000-8000-000000000000',
          authorization: `Bearer ${created.secret}`,
        },
      },
      {
        headers: {
          'x-tenant-id': created.tenantId,
          authorization: 'Bearer yck_wrongwrongwrongwrongwrongwrongwrong',
        },
      },
    ];
    for (const item of cases) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/tenant',
        headers: item.headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
      expect(response.body).not.toContain('Alpha');
      expect(response.body).not.toContain(created.secret);
      expect(response.body).not.toContain(created.tenantId);
    }
  });

  it('stores only a protected verifier for the secret', async () => {
    const admin = adminPool(db);
    try {
      const result = await admin.query<{ verifier: string }>(
        'SELECT verifier FROM tenant_api_keys WHERE id = $1',
        [created.keyId],
      );
      const verifier = result.rows[0]?.verifier;
      expect(verifier).toBeTruthy();
      expect(verifier).not.toContain(created.secret);
      expect(verifier?.startsWith('scrypt$')).toBe(true);
      expect(await verifySecret(created.secret, verifier ?? '')).toBe(true);
      const leaked = await admin.query(
        `SELECT count(*)::int AS matches
         FROM (
           SELECT name AS value FROM tenants
           UNION ALL SELECT verifier FROM tenant_api_keys
           UNION ALL SELECT label FROM tenant_api_keys
         ) rows
         WHERE value LIKE $1`,
        [`%${created.secret}%`],
      );
      expect(leaked.rows[0]?.matches).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('does not accept a model request or caller provider configuration', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': created.tenantId,
        authorization: `Bearer ${created.secret}`,
        'content-type': 'application/json',
      },
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'openai',
        apiKey: 'sk-live',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { type?: string }; choices?: unknown; object?: string };
    expect(body.error?.type).toBe('invalid_request_error');
    expect(JSON.stringify(body)).not.toContain('sk-live');
    expect(body.choices).toBeUndefined();
    expect(body.object).not.toBe('chat.completion');
  });
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
