import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { configFor, loadTestDatabase, runCli } from './helpers.js';

describe('connection-pool context leakage', () => {
  const db = loadTestDatabase();
  const pools: Array<{ end: () => Promise<unknown> }> = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('clears tenant context before a connection returns to the pool', async () => {
    const alpha = runCli(db, ['provision-tenant', '--name', 'Pool A']);
    const beta = runCli(db, ['provision-tenant', '--name', 'Pool B']);
    const pool = createPool(configFor(db), 'runtime', undefined, 1);
    pools.push(pool);

    let backendPid = 0;
    await withTenant(pool, required(alpha.tenantId), async (client) => {
      const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      backendPid = pid.rows[0]?.pid ?? 0;
      const rows = await client.query<{ id: string }>('SELECT id FROM tenants');
      expect(rows.rows.map((row) => row.id)).toEqual([alpha.tenantId]);
    });

    const client = await pool.connect();
    try {
      const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(pid.rows[0]?.pid).toBe(backendPid);
      const setting = await client.query<{ tenant_id: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS tenant_id`,
      );
      const tenantId = setting.rows[0]?.tenant_id;
      expect(tenantId === null || tenantId === '').toBe(true);
      const leaked = await client.query('SELECT id FROM tenants');
      expect(leaked.rows).toEqual([]);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [beta.tenantId]);
      const seen = await client.query<{ id: string }>('SELECT id FROM tenants');
      expect(seen.rows.map((row) => row.id)).toEqual([beta.tenantId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const clientAgain = await pool.connect();
    try {
      const setting = await clientAgain.query<{ tenant_id: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS tenant_id`,
      );
      const tenantId = setting.rows[0]?.tenant_id;
      expect(tenantId === null || tenantId === '').toBe(true);
      const leaked = await clientAgain.query('SELECT id FROM tenants');
      expect(leaked.rows).toEqual([]);
    } finally {
      clientAgain.release();
    }
  });
});

function required(value: string | undefined): string {
  if (!value) throw new Error('missing cli field');
  return value;
}
