import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it } from 'vitest';
import { bootstrapRoles } from '../src/db/bootstrap-roles.js';
import {
  freePort,
  runCli,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForExit,
  waitForReady,
  type TestDatabase,
} from './helpers.js';

describe('readiness failure', () => {
  it('reports the database ready only while postgres is up, and SIGTERM closes the pools', async () => {
    const container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('llm_proxy')
      .withUsername('postgres')
      .withPassword('postgres')
      .withStartupTimeout(120_000)
      .start();
    const passwords = {
      migrator: 'migrator_test_pw',
      auth: 'auth_test_pw',
      runtime: 'runtime_test_pw',
    };
    const db: TestDatabase = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      password: container.getPassword(),
      passwords,
    };
    const admin = new pg.Pool({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.username,
      password: db.password,
      max: 1,
    });
    admin.on('error', () => undefined);
    let child: ReturnType<typeof spawnServer> | undefined;
    try {
      await bootstrapRoles(admin, db.database, passwords);
      await admin.end();
      const port = await freePort();
      child = spawnServer(serviceEnv(db, { PORT: String(port) }));
      const ready = await waitForReady(port);
      expect(ready).toEqual({ status: 'ready', database: 'ready' });
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'live' });

      const created = runCli(db, ['provision-tenant', '--name', 'Ready Tenant']);
      expect(created.tenantId).toBeTruthy();
      expect(created.secret).toBeTruthy();

      const firstExit = await stopChild(child.child);
      expect(firstExit).toBe(0);
      expect(child.output()).toContain('"pools":"closed"');
      const firstLogs = child.output();
      expect(firstLogs).not.toContain(created.secret);

      child = spawnServer(serviceEnv(db, { PORT: String(port) }));
      const readyAgain = await waitForReady(port);
      expect(readyAgain).toEqual({ status: 'ready', database: 'ready' });
      const authed = await fetch(`http://127.0.0.1:${port}/v1/tenant`, {
        headers: {
          'x-tenant-id': created.tenantId ?? '',
          authorization: `Bearer ${created.secret}`,
        },
      });
      expect(authed.status).toBe(200);
      const body = (await authed.json()) as { id: string; name: string };
      expect(body).toMatchObject({ id: created.tenantId, name: 'Ready Tenant' });
      expect(JSON.stringify(body)).not.toContain(created.secret);

      await container.stop({ timeout: 5_000 });
      const notReady = await waitForNotReady(port);
      expect(notReady.status).toBe(503);
      expect(notReady.body).toMatchObject({ status: 'not_ready' });
      expect(JSON.stringify(notReady.body)).not.toContain('"database":"ready"');
      const stillLive = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(stillLive.status).toBe(200);
      expect(await stillLive.json()).toEqual({ status: 'live' });

      child.child.kill('SIGTERM');
      const code = await waitForExit(child.child, 10_000);
      expect(code).toBe(0);
      expect(child.output()).toContain('"pools":"closed"');
      expect(child.output()).not.toContain(created.secret);
    } finally {
      if (child) await stopChild(child.child);
      await admin.end().catch(() => undefined);
      await container.stop({ timeout: 5_000 }).catch(() => undefined);
    }
  });
});

async function waitForNotReady(port: number): Promise<{ status: number; body: unknown }> {
  const started = Date.now();
  let lastStatus = 0;
  let lastBody: unknown = null;
  while (Date.now() - started < 20_000) {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    lastStatus = response.status;
    lastBody = await response.json();
    if (response.status === 503) return { status: lastStatus, body: lastBody };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { status: lastStatus, body: lastBody };
}
