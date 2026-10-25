import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/authenticate.js';
import { createCredentialStore, type ProviderCredentialStore } from '../credentials.js';
import { createSampleKeyManager, type SampleKeyManager } from '../inference/sample-crypto.js';
import { parseEligibilityBody, readSampleEligibility } from '../inference/sample-eligibility.js';
import { deleteStoredSample, listSamples, parseSampleId, parseSampleListQuery, readSample, readSampleStats } from '../inference/samples.js';
import { withTenant } from '../db/tenant-context.js';
import { executeChat } from '../inference/execute.js';
import type { VertexClientFactory } from '../inference/vertex-client.js';
import type { StreamHttp } from '../inference/execute-stream.js';
import { ProxyError, proxyError } from '../inference/errors.js';
import { parseCostFilters, summarizeCosts } from '../inference/cost-store.js';
import { readTenantCapacity } from '../db/admission.js';
import { listBreakers } from '../db/breaker.js';
import {
  listRequestFeatures,
  parseFeatureListQuery,
  parseFeatureRequestId,
  readRequestFeature,
  type ExtractedFeatures,
  type FeatureExtractInput,
} from '../inference/request-features.js';
import { listAttemptHistory, listVisibleModels, summarizeMetrics } from '../inference/store.js';
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
  previousCredentialKeys?: readonly Buffer[];
  sampleKeyManager?: SampleKeyManager | null;
  sampleDraw?: number;
  beforeSampleStore?: () => Promise<void> | void;
  beforeSampleInsert?: () => Promise<void> | void;
  failSampleInsert?: () => boolean;
  maxActiveStreams: number;
  maxStreamsPerTenant: number;
  vertexClientFactory?: VertexClientFactory;
  compatibleFetch?: typeof fetch;
  privateResolve?: (host: string) => Promise<readonly string[]>;
  now?: () => number;
  afterAdmit?: () => Promise<void> | void;
  beforeSettle?: () => Promise<void> | void;
  extractFeatures?: (value: FeatureExtractInput) => ExtractedFeatures;
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
    header(name: string, value: string): void {
      reply.header(name, value);
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
  const sampleKeyManager: SampleKeyManager | null =
    deps.sampleKeyManager !== undefined
      ? deps.sampleKeyManager
      : deps.credentialKey === null
        ? null
        : createSampleKeyManager(deps.credentialKey, deps.previousCredentialKeys ?? []);
  const streamGate = createStreamGate(deps.maxActiveStreams, deps.maxStreamsPerTenant);
  const nowMs = deps.now ?? ((): number => Date.now());
  app.streamGate = streamGate;
  app.drainStreams = (drainMs: number) => drainStreams(streamGate, drainMs);

  async function rejectUnauthenticated(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ tenantId: string; keyId: string } | null> {
    try {
      const auth = await authenticate(deps.authPool, request.headers);
      if (auth === null) {
        deps.logger.info('credential rejected');
        await reply
          .code(401)
          .send(proxyError(401, 'authentication_error', 'invalid_api_key', null, 'Invalid authentication.').body());
        return null;
      }
      return auth;
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
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    const tenantId = auth.tenantId;
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
        apiKeyId: auth.keyId,
        body: request.body,
        signal: controller.signal,
        reply: streamReply(reply),
        gate: streamGate,
        vertexClientFactory: deps.vertexClientFactory,
        fetchImpl: deps.compatibleFetch,
        resolveHost: deps.privateResolve,
        nowMs,
        afterAdmit: deps.afterAdmit,
        beforeSettle: deps.beforeSettle,
        extractFeatures: deps.extractFeatures,
        sampleKeyManager,
        sampleDraw: deps.sampleDraw,
        beforeSampleStore: deps.beforeSampleStore,
        beforeSampleInsert: deps.beforeSampleInsert,
        failSampleInsert: deps.failSampleInsert,
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
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    const tenantId = auth.tenantId;
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
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      const tenantId = auth.tenantId;
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

  app.get<{
    Querystring: { from?: string; to?: string; provider?: string; deployment?: string; model?: string };
  }>('/internal/v1/metrics/costs', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    const tenantId = auth.tenantId;
    try {
      const window = parseMetricsWindow(request.query.from, request.query.to);
      const filters = parseCostFilters(request.query);
      return await withTenant(deps.runtimePool, tenantId, (client) =>
        summarizeCosts(client, window.from, window.to, filters),
      );
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('cost read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.get<{
    Querystring: { from?: string; to?: string; provider?: string; deployment?: string; model?: string };
  }>('/internal/v1/metrics/attempts', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    const tenantId = auth.tenantId;
    try {
      const window = parseMetricsWindow(request.query.from, request.query.to);
      const filters = parseCostFilters(request.query);
      const attempts = await withTenant(deps.runtimePool, tenantId, (client) =>
        listAttemptHistory(client, window.from, window.to, filters),
      );
      return {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        attempts,
      };
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('attempt history read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.get<{ Querystring: { deployment?: string } }>('/internal/v1/metrics/breakers', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    const tenantId = auth.tenantId;
    const deployment = request.query.deployment?.trim() ?? '';
    if (request.query.deployment !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(deployment)) {
      return reply
        .code(400)
        .send(proxyError(400, 'invalid_request_error', 'invalid_parameter', 'deployment', 'The deployment name is invalid.').body());
    }
    try {
      const breakers = await withTenant(deps.runtimePool, tenantId, (client) =>
        listBreakers(client, new Date(nowMs()), deployment.length === 0 ? null : deployment),
      );
      return { breakers };
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('breaker read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  async function capacity(request: FastifyRequest, reply: FastifyReply) {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      return await readTenantCapacity(deps.runtimePool, auth.tenantId, new Date(nowMs()));
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('capacity read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  }

  app.get('/internal/v1/limits', capacity);
  app.get('/internal/v1/budgets/usage', capacity);

  app.get<{ Querystring: { limit?: string; cursor?: string; category?: string } }>(
    '/internal/v1/request-features',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const query = parseFeatureListQuery(request.query);
        return await withTenant(deps.runtimePool, auth.tenantId, (client) => listRequestFeatures(client, query));
      } catch (error) {
        if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
        deps.logger.error('request features read failed', { message: errorMessage(error) });
        return reply
          .code(500)
          .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
      }
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string; provider?: string } }>(
    '/internal/v1/samples',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const query = parseSampleListQuery(request.query);
        return await withTenant(deps.runtimePool, auth.tenantId, (client) => listSamples(client, query));
      } catch (error) {
        if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
        deps.logger.error('sample read failed', { message: errorMessage(error) });
        return reply
          .code(500)
          .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
      }
    },
  );

  app.get('/internal/v1/samples/stats', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      return await withTenant(deps.runtimePool, auth.tenantId, (client) => readSampleStats(client, auth.tenantId));
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('sample read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.get<{ Params: { sampleId: string } }>('/internal/v1/samples/:sampleId', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const sampleId = parseSampleId(request.params.sampleId);
      const row = await withTenant(deps.runtimePool, auth.tenantId, (client) => readSample(client, sampleId));
      if (row === null) {
        return reply
          .code(404)
          .send(proxyError(404, 'invalid_request_error', 'not_found', 'sample_id', 'The sample was not found.').body());
      }
      return row;
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('sample read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.post<{ Params: { sampleId: string } }>('/internal/v1/samples/:sampleId/eligibility-check', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const sampleId = parseSampleId(request.params.sampleId);
      const body = parseEligibilityBody(request.body);
      const report = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        readSampleEligibility(client, sampleId, body.deployment),
      );
      if (report === null) {
        return reply
          .code(404)
          .send(proxyError(404, 'invalid_request_error', 'not_found', 'sample_id', 'The sample was not found.').body());
      }
      return report;
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('sample eligibility failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.delete<{ Params: { sampleId: string } }>('/internal/v1/samples/:sampleId', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const sampleId = parseSampleId(request.params.sampleId);
      const deleted = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        deleteStoredSample(client, auth.tenantId, sampleId),
      );
      if (!deleted) {
        return reply
          .code(404)
          .send(proxyError(404, 'invalid_request_error', 'not_found', 'sample_id', 'The sample was not found.').body());
      }
      return { deleted: true };
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('sample read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
    }
  });

  app.get<{ Params: { requestId: string } }>('/internal/v1/request-features/:requestId', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const requestId = parseFeatureRequestId(request.params.requestId);
      const row = await withTenant(deps.runtimePool, auth.tenantId, (client) => readRequestFeature(client, requestId));
      if (row === null) {
        return reply
          .code(404)
          .send(proxyError(404, 'invalid_request_error', 'not_found', 'request_id', 'The request was not found.').body());
      }
      return row;
    } catch (error) {
      if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
      deps.logger.error('request feature read failed', { message: errorMessage(error) });
      return reply
        .code(500)
        .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
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
