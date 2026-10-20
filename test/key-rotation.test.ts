import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loadTestDatabase, runCli } from './helpers.js';

describe('key rotation and revocation', () => {
  const db = loadTestDatabase();
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    ctx = await createTestApp(db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
  });

  it('keeps another active key working after one key is revoked', async () => {
    const first = runCli(db, ['provision-tenant', '--name', 'Rotation', '--label', 'primary']);
    const second = runCli(db, [
      'add-key',
      '--tenant-id',
      required(first.tenantId),
      '--label',
      'secondary',
    ]);
    expect(first.secret).toBeTruthy();
    expect(second.secret).toBeTruthy();
    expect(second.secret).not.toBe(first.secret);
    expect(first.keyId).not.toBe(second.keyId);

    expect((await call(required(first.tenantId), required(first.secret))).statusCode).toBe(200);
    expect((await call(required(first.tenantId), required(second.secret))).statusCode).toBe(200);

    const revoked = runCli(db, [
      'revoke-key',
      '--tenant-id',
      required(first.tenantId),
      '--key-id',
      required(first.keyId),
    ]);
    expect(revoked.revoked).toBe(true);

    const rejected = await call(required(first.tenantId), required(first.secret));
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: 'unauthorized' });
    expect(rejected.body).not.toContain(required(first.secret));

    const stillActive = await call(required(first.tenantId), required(second.secret));
    expect(stillActive.statusCode).toBe(200);
    const body = stillActive.json();
    expect(body.id).toBe(first.tenantId);
    expect(body.name).toBe('Rotation');
    expect(JSON.stringify(body)).not.toContain(required(second.secret));
    expect(JSON.stringify(body)).not.toContain('scrypt$');
    const keyIds = body.keys.map((key: { id: string }) => key.id);
    expect(keyIds).toContain(first.keyId);
    expect(keyIds).toContain(second.keyId);
  });

  async function call(tenantId: string, secret: string) {
    return ctx.app.inject({
      method: 'GET',
      url: '/v1/tenant',
      headers: {
        'x-tenant-id': tenantId,
        authorization: `Bearer ${secret}`,
      },
    });
  }
});

function required(value: string | undefined): string {
  if (!value) throw new Error('missing cli field');
  return value;
}
