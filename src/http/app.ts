import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/authenticate.js';
import { createCredentialStore, type ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import { executeChat } from '../inference/execute.js';
import type { VertexClientFactory } from '../inference/vertex-client.js';
import type { StreamHttp } from '../inference/execute-stream.js';
import { ProxyError, proxyError } from '../inference/errors.js';
import { listVisibleModels, summarizeMetrics } from '../inference/store.js';
import { createStreamGate, drainStreams, type DrainResult, type StreamGate } from '../inference/stream.js';
import { parseMetricsWindow } from '../inference/window.js';
import type { Logger } from '../logger.js';

export type AppDeps = {
  logger: Logger;
  authPool: Pool;
  runtimePool: Pool;
  readyVersion: string;
  inferenceEnabled: boolean;
  upstreamBaseUrl: string;
  credentialKey: Buffer | null;
  maxActiveStreams: number;
  maxStreamsPerTenant: number;
  vertexClientFactory?: VertexClientFactory;
  compatibleFetch?: typeof fetch;
  privateResolve?: (host: string) => Promise<readonly string[]>;
};

export type ProxyApp = FastifyInstance & {
  streamGate: StreamGate;
  drainStreams(drainMs: number): Promise<DrainResult>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function streamReply(reply: FastifyReply): StreamHttp {
  return {
    write(chunk: string): boolean {
      return reply.raw.write(chunk);
    },
    once(event: 'drain', listener: () => void): void {
      reply.raw.once(event, listener);
    },
    off(event: 'drain', listener: () => void): void {
      reply.raw.off(event, listener);
    },
    hijack(): void {
      reply.hijack();
    },
    writeHead(status: number, headers: Record<string, string>): void {
      reply.raw.writeHead(status, headers);
    },
    end(): void {
      reply.raw.end();
    },
    headersSent(): boolean {
      return reply.raw.headersSent;
    },
  };
}

export function buildApp(deps: AppDeps): ProxyApp {
  const app = Fastify({ logger: false }) as unknown as ProxyApp;
  const credentialStore: ProviderCredentialStore | null =
    deps.credentialKey === null ? null : createCredentialStore(deps.credentialKey);
  const streamGate = createStreamGate(deps.maxActiveStreams, deps.maxStreamsPerTenant);
  app.streamGate = streamGate;
  app.drainStreams = (drainMs: number) => drainStreams(streamGate, drainMs);

  async function rejectUnauthenticated(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    try {
      const auth = await authenticate(deps.authPool, request.headers);
      if (auth === null) {
        deps.logger.info('credential rejected');
        await reply
          .code(401)
          .send(proxyError(401, 'authentication_error', 'invalid_api_key', null, 'Invalid authentication.').body());
        return null;
      }
      return auth.tenantId;
    } catch (error) {
      deps.logger.error('authentication failed', { message: errorMessage(error) });
      await reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
      return null;
    }
  }

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

  app.post('/v1/chat/completions', async (request, reply) => {
    const tenantId = await rejectUnauthenticated(request, reply);
    if (tenantId === null) return;
    const controller = new AbortController();
    const abortUpstream = (): void => {
      if (!controller.signal.aborted) controller.abort();
    };
    const onClose = (): void => {
      if (!reply.raw.writableEnded) abortUpstream();
    };
    // The request stream also closes after a normal body read. Abort only
    // when the response is still open, which means the caller went away.
    // Injected sockets use a fake setTimeout that rejects a missing callback.
    if (!('isLightMyRequest' in request.raw) && typeof request.raw.setTimeout === 'function') {
      request.raw.setTimeout(0);
    }
    if (!('isLightMyRequest' in reply.raw) && typeof reply.raw.setTimeout === 'function') {
      reply.raw.setTimeout(0);
    }
    request.raw.on('aborted', abortUpstream);
    reply.raw.on('close', onClose);
    try {
      const result = await executeChat({
        runtimePool: deps.runtimePool,
        logger: deps.logger,
        inferenceEnabled: deps.inferenceEnabled,
        upstreamBaseUrl: deps.upstreamBaseUrl,
        store: credentialStore,
        tenantId,
        body: request.body,
        signal: controller.signal,
        reply: streamReply(reply),
        gate: streamGate,
        vertexClientFactory: deps.vertexClientFactory,
        fetchImpl: deps.compatibleFetch,
        resolveHost: deps.privateResolve,
      });
      if (reply.sent || reply.raw.headersSent) return;
      return result;
    } catch (error) {
      if (reply.sent || reply.raw.headersSent) return;
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('chat request failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    } finally {
      request.raw.off('aborted', abortUpstream);
      reply.raw.off('close', onClose);
    }
  });

  app.get('/v1/models', async (request, reply) => {
    const tenantId = await rejectUnauthenticated(request, reply);
    if (tenantId === null) return;
    try {
      const data = await withTenant(deps.runtimePool, tenantId, (client) => listVisibleModels(client));
      return { object: 'list', data };
    } catch (error) {
      deps.logger.error('model list failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/internal/v1/metrics/summary',
    async (request, reply) => {
      const tenantId = await rejectUnauthenticated(request, reply);
      if (tenantId === null) return;
      try {
        const window = parseMetricsWindow(request.query.from, request.query.to);
        return await withTenant(deps.runtimePool, tenantId, (client) =>
          summarizeMetrics(client, window.from, window.to),
        );
      } catch (error) {
        if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
        deps.logger.error('metrics read failed', { message: errorMessage(error) });
        return reply
          .code(500)
          .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
      }
    },
  );

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((error, _request, reply) => {
    deps.logger.error('request failed', { message: errorMessage(error) });
    reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
