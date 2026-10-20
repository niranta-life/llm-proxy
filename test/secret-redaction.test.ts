import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';
import { generateTenantSecret, hashSecret } from '../src/secrets.js';
import { createTestApp, loadTestDatabase, runCli } from './helpers.js';

describe('secret redaction', () => {
  it('removes secrets, bearer tokens, and verifiers from a log event', async () => {
    const secret = generateTenantSecret();
    const verifier = await hashSecret('another-high-entropy-secret-value');
    const event = redact({
      time: '2026-01-01T00:00:00.000Z',
      level: 'info',
      msg: `presented Bearer ${secret} and ${verifier}`,
      authorization: `Bearer ${secret}`,
      password: 'db-password',
      verifier,
      nested: { token: secret, ok: true },
      items: [secret, 'visible'],
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(verifier);
    expect(text).not.toContain('db-password');
    expect(event.authorization).toBe('[REDACTED]');
    expect(event.password).toBe('[REDACTED]');
    expect(event.verifier).toBe('[REDACTED]');
    expect(event.nested.token).toBe('[REDACTED]');
    expect(event.nested.ok).toBe(true);
    expect(event.items[1]).toBe('visible');
    expect(text.match(/\{/g)?.length).toBeGreaterThan(0);
    expect(text).not.toContain('\n');
  });

  describe('request logs', () => {
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

    it('does not write a presented tenant secret or verifier to the log', async () => {
      const created = runCli(db, ['provision-tenant', '--name', 'Redaction']);
      const secret = created.secret ?? '';
      const rejected = await ctx.app.inject({
        method: 'GET',
        url: '/v1/tenant',
        headers: {
          'x-tenant-id': created.tenantId,
          authorization: `Bearer yck_wrongwrongwrongwrongwrongwrongwrong`,
        },
      });
      const accepted = await ctx.app.inject({
        method: 'GET',
        url: '/v1/tenant',
        headers: {
          'x-tenant-id': created.tenantId,
          authorization: `Bearer ${secret}`,
        },
      });
      expect(rejected.statusCode).toBe(401);
      expect(accepted.statusCode).toBe(200);
      const text = ctx.lines.join('');
      const records = text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { msg: string });
      expect(records.length).toBeGreaterThan(0);
      expect(text).not.toContain(secret);
      expect(text).not.toContain('scrypt$');
      expect(text).not.toContain('yck_wrongwrongwrongwrongwrongwrongwrong');
      expect(records.some((record) => record.msg === 'credential rejected')).toBe(true);
      expect(records.some((record) => record.msg === 'tenant request accepted')).toBe(true);
    });
  });
});
