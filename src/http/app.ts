import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/authenticate.js';
import type { Logger } from '../logger.js';
import { withTenant } from '../db/tenant-context.js';

export type AppDeps = {
  logger: Logger;
  authPool: Pool;
  runtimePool: Pool;
  readyVersion: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health/live', async () => ({ status: 'live' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      const result = await deps.runtimePool.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [deps.readyVersion],
      );
      if ((result.rowCount ?? 0) !== 1) {
        return reply.code(503).send({ status: 'not_ready', database: 'unavailable' });
      }
      return { status: 'ready', database: 'ready' };
    } catch (error) {
      deps.logger.error('readiness check failed', { message: errorMessage(error) });
      return reply.code(503).send({ status: 'not_ready', database: 'unavailable' });
    }
  });

  app.get('/v1/tenant', async (request, reply) => {
    let auth: Awaited<ReturnType<typeof authenticate>>;
    try {
      auth = await authenticate(deps.authPool, request.headers);
    } catch (error) {
      deps.logger.error('authentication failed', { message: errorMessage(error) });
      return reply.code(500).send({ error: 'internal_error' });
    }
    if (auth === null) {
      deps.logger.info('credential rejected');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const tenantId = auth.tenantId;
    try {
      const body = await withTenant(deps.runtimePool, tenantId, async (client) => {
        const tenant = await client.query<{ id: string; name: string }>(
          'SELECT id, name FROM tenants WHERE id = $1',
          [tenantId],
        );
        const keys = await client.query<{
          id: string;
          label: string;
          created_at: Date;
          revoked_at: Date | null;
        }>(
          `SELECT id, label, created_at, revoked_at
           FROM tenant_api_keys
           WHERE tenant_id = $1
           ORDER BY created_at ASC, id ASC`,
          [tenantId],
        );
        return { tenant: tenant.rows[0], keys: keys.rows };
      });
      if (body.tenant === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      deps.logger.info('tenant request accepted', { tenantId });
      return {
        id: body.tenant.id,
        name: body.tenant.name,
        keys: body.keys.map((key) => ({
          id: key.id,
          label: key.label,
          createdAt: key.created_at,
          revokedAt: key.revoked_at,
        })),
      };
    } catch (error) {
      deps.logger.error('tenant read failed', { message: errorMessage(error) });
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((error, _request, reply) => {
    deps.logger.error('request failed', { message: errorMessage(error) });
    reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
