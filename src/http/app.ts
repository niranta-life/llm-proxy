import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/authenticate.js';
import { createCredentialStore, type ProviderCredentialStore } from '../credentials.js';
import { createSampleKeyManager, type SampleKeyManager } from '../inference/sample-crypto.js';
import {
  addEvaluationProfileVersion,
  approveEvaluationProfile,
  createEvaluationProfile,
  parseProfileId,
  parseProfileVersion,
  readEvaluationProfileVersion,
  storeEvaluationReference,
} from '../inference/evaluation-profiles.js';
import {
  listEvaluationRecommendations,
  parseRecommendationQuery,
  readEvaluationReport,
} from '../inference/evaluation-report.js';
import {
  cancelEvaluation,
  createEvaluation,
  listEvaluationItems,
  listEvaluations,
  parseEvaluationId,
  parseEvaluationListQuery,
  parseEvaluationPlan,
  parseIdempotencyKey,
  preflightStoredPlan,
  readEvaluation,
} from '../inference/evaluations.js';
import {
  addEvaluationRubricVersion,
  approveEvaluationRubric,
  createEvaluationRubric,
  parseRubricId,
  parseRubricVersion,
  readEvaluationRubricVersion,
} from '../inference/judge-rubrics.js';
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
import { createRequestAdmission } from './request-admission.js';
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
  keepAliveTimeoutMs?: number;
};

export type ProxyApp = FastifyInstance & {
  streamGate: StreamGate;
  drainStreams(drainMs: number): Promise<DrainResult>;
  drain(drainMs: number): Promise<{ requestsIdle: boolean }>;
  drainRequests(timeoutMs: number): Promise<boolean>;
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
    deps.credentialKey === null
      ? null
      : createCredentialStore(deps.credentialKey, deps.previousCredentialKeys ?? []);
  const sampleKeyManager: SampleKeyManager | null =
    deps.sampleKeyManager !== undefined
      ? deps.sampleKeyManager
      : deps.credentialKey === null
        ? null
        : createSampleKeyManager(deps.credentialKey, deps.previousCredentialKeys ?? []);
  const streamGate = createStreamGate(deps.maxActiveStreams, deps.maxStreamsPerTenant);
  const admission = createRequestAdmission();
  const nowMs = deps.now ?? ((): number => Date.now());
  const leaves = new WeakMap<object, () => void>();
  app.streamGate = streamGate;
  app.drain = (drainMs: number) => admission.drain(drainMs);
  app.drainRequests = (timeoutMs: number) => admission.drainRequests(timeoutMs);
  app.drainStreams = async (drainMs: number) => {
    const httpDrain = admission.drain(drainMs);
    const streamDrain = drainStreams(streamGate, drainMs);
    const httpResult = await httpDrain;
    if (!httpResult.requestsIdle) app.server.closeAllConnections();
    return streamDrain;
  };
  app.server.keepAliveTimeout = deps.keepAliveTimeoutMs ?? 620_000;
  app.server.headersTimeout = 60_000;

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (admission.shuttingDown()) {
      if (path === '/health/live') return;
      reply.header('connection', 'close');
      if (path === '/health/ready') {
        return reply.code(503).send({ status: 'not_ready', reason: 'shutting_down' });
      }
      reply.header('retry-after', '1');
      return reply
        .code(503)
        .send(proxyError(503, 'server_error', 'shutting_down', null, 'The server is shutting down.').body());
    }
    leaves.set(request, admission.enter());
  });
  app.addHook('preSerialization', async (request, _reply, payload) => {
    leaves.get(request)?.();
    return payload;
  });
  app.addHook('onResponse', async (request) => {
    leaves.get(request)?.();
  });
  app.addHook('onError', async (request) => {
    leaves.get(request)?.();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (admission.shuttingDown()) reply.header('connection', 'close');
    return payload;
  });

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

  function sendEvaluationError(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof ProxyError) return reply.code(error.status).send(error.body());
    deps.logger.error('evaluation request failed', { message: errorMessage(error) });
    return reply
      .code(500)
      .send(proxyError(500, 'server_error', 'internal_error', null, 'The request failed.').body());
  }

  app.post('/internal/v1/evaluation-profiles', { bodyLimit: 65_536 }, async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const profile = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        createEvaluationProfile(client, auth.tenantId, request.body),
      );
      return reply.code(201).send(profile);
    } catch (error) {
      return sendEvaluationError(reply, error);
    }
  });

  app.post<{ Params: { profileId: string } }>(
    '/internal/v1/evaluation-profiles/:profileId/versions',
    { bodyLimit: 65_536 },
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const profileId = parseProfileId(request.params.profileId);
        const profile = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          addEvaluationProfileVersion(client, auth.tenantId, profileId, request.body),
        );
        return reply.code(201).send(profile);
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.post<{ Params: { profileId: string; version: string } }>(
    '/internal/v1/evaluation-profiles/:profileId/versions/:version/approve',
    { bodyLimit: 65_536 },
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const profileId = parseProfileId(request.params.profileId);
        const version = parseProfileVersion(request.params.version);
        const profile = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          approveEvaluationProfile(client, profileId, version),
        );
        return profile;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.post<{ Params: { profileId: string; version: string } }>(
    '/internal/v1/evaluation-profiles/:profileId/versions/:version/references',
    { bodyLimit: 65_536 },
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const profileId = parseProfileId(request.params.profileId);
        const version = parseProfileVersion(request.params.version);
        return await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          storeEvaluationReference(client, auth.tenantId, profileId, version, request.body),
        );
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.get<{ Params: { profileId: string; version: string } }>(
    '/internal/v1/evaluation-profiles/:profileId/versions/:version',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const profileId = parseProfileId(request.params.profileId);
        const version = parseProfileVersion(request.params.version);
        const profile = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          readEvaluationProfileVersion(client, profileId, version),
        );
        if (profile === null) {
          return reply
            .code(404)
            .send(proxyError(404, 'invalid_request_error', 'not_found', 'profile_id', 'The profile was not found.').body());
        }
        return profile;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.post('/internal/v1/evaluation-rubrics', { bodyLimit: 65_536 }, async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const rubric = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        createEvaluationRubric(client, auth.tenantId, request.body),
      );
      return reply.code(201).send(rubric);
    } catch (error) {
      return sendEvaluationError(reply, error);
    }
  });

  app.post<{ Params: { rubricId: string } }>(
    '/internal/v1/evaluation-rubrics/:rubricId/versions',
    { bodyLimit: 65_536 },
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const rubricId = parseRubricId(request.params.rubricId);
        const rubric = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          addEvaluationRubricVersion(client, auth.tenantId, rubricId, request.body),
        );
        return reply.code(201).send(rubric);
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.post<{ Params: { rubricId: string; version: string } }>(
    '/internal/v1/evaluation-rubrics/:rubricId/versions/:version/approve',
    { bodyLimit: 65_536 },
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const rubricId = parseRubricId(request.params.rubricId);
        const version = parseRubricVersion(request.params.version);
        const rubric = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          approveEvaluationRubric(client, rubricId, version),
        );
        return rubric;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.get<{ Params: { rubricId: string; version: string } }>(
    '/internal/v1/evaluation-rubrics/:rubricId/versions/:version',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const rubricId = parseRubricId(request.params.rubricId);
        const version = parseRubricVersion(request.params.version);
        const rubric = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          readEvaluationRubricVersion(client, rubricId, version),
        );
        if (rubric === null) {
          return reply
            .code(404)
            .send(proxyError(404, 'invalid_request_error', 'not_found', 'rubric_id', 'The rubric was not found.').body());
        }
        return rubric;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.post('/internal/v1/evaluations/preflight', { bodyLimit: 65_536 }, async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const plan = parseEvaluationPlan(request.body);
      const result = await withTenant(deps.runtimePool, auth.tenantId, (client) => preflightStoredPlan(client, plan));
      return {
        accepted: result.accepted,
        itemCount: result.itemCount,
        mode: plan.mode,
        modelExecution: 'off' as const,
        sampleCategory: plan.sampleCategory,
        challengerDeployment: plan.challengerDeployment,
        judgeDeployment: plan.judgeDeployment,
        budgetEstimate: plan.budgetEstimate,
      };
    } catch (error) {
      return sendEvaluationError(reply, error);
    }
  });

  app.post('/internal/v1/evaluations', { bodyLimit: 65_536 }, async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const plan = parseEvaluationPlan(request.body);
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
      const created = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
        createEvaluation(client, auth.tenantId, idempotencyKey, plan),
      );
      return reply.code(created.replayed ? 200 : 201).send(created.run);
    } catch (error) {
      return sendEvaluationError(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/internal/v1/evaluations', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const query = parseEvaluationListQuery(request.query);
      return await withTenant(deps.runtimePool, auth.tenantId, (client) => listEvaluations(client, query));
    } catch (error) {
      return sendEvaluationError(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; tenantId?: string } }>(
    '/internal/v1/evaluations/recommendations',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const query = parseRecommendationQuery(request.query);
        if (query.tenantId !== null && query.tenantId !== auth.tenantId) {
          return { recommendations: [], nextCursor: null };
        }
        return await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          listEvaluationRecommendations(client, query, new Date().toISOString()),
        );
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.get<{ Params: { evaluationId: string } }>('/internal/v1/evaluations/:evaluationId', async (request, reply) => {
    const auth = await rejectUnauthenticated(request, reply);
    if (auth === null) return;
    try {
      const evaluationId = parseEvaluationId(request.params.evaluationId);
      const run = await withTenant(deps.runtimePool, auth.tenantId, (client) => readEvaluation(client, evaluationId));
      if (run === null) {
        return reply
          .code(404)
          .send(proxyError(404, 'invalid_request_error', 'not_found', 'evaluation_id', 'The evaluation was not found.').body());
      }
      return run;
    } catch (error) {
      return sendEvaluationError(reply, error);
    }
  });

  app.get<{ Params: { evaluationId: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/internal/v1/evaluations/:evaluationId/items',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const evaluationId = parseEvaluationId(request.params.evaluationId);
        const query = parseEvaluationListQuery(request.query);
        const page = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          listEvaluationItems(client, evaluationId, query),
        );
        if (page === null) {
          return reply
            .code(404)
            .send(
              proxyError(404, 'invalid_request_error', 'not_found', 'evaluation_id', 'The evaluation was not found.').body(),
            );
        }
        return page;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.get<{ Params: { evaluationId: string } }>(
    '/internal/v1/evaluations/:evaluationId/report',
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const evaluationId = parseEvaluationId(request.params.evaluationId);
        const report = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          readEvaluationReport(client, evaluationId, new Date().toISOString()),
        );
        if (report === null) {
          return reply
            .code(404)
            .send(
              proxyError(404, 'invalid_request_error', 'not_found', 'evaluation_id', 'The evaluation was not found.').body(),
            );
        }
        return report;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.post<{ Params: { evaluationId: string } }>(
    '/internal/v1/evaluations/:evaluationId/cancel',
    { bodyLimit: 65_536 },
    async (request, reply) => {
      const auth = await rejectUnauthenticated(request, reply);
      if (auth === null) return;
      try {
        const evaluationId = parseEvaluationId(request.params.evaluationId);
        const run = await withTenant(deps.runtimePool, auth.tenantId, (client) =>
          cancelEvaluation(client, evaluationId),
        );
        if (run === null) {
          return reply
            .code(404)
            .send(
              proxyError(404, 'invalid_request_error', 'not_found', 'evaluation_id', 'The evaluation was not found.').body(),
            );
        }
        return run;
      } catch (error) {
        return sendEvaluationError(reply, error);
      }
    },
  );

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    const path = request.url.split('?')[0] ?? '';
    if (
      (path.startsWith('/internal/v1/evaluations') ||
        path.startsWith('/internal/v1/evaluation-profiles') ||
        path.startsWith('/internal/v1/evaluation-rubrics')) &&
      statusCode === 413
    ) {
      reply
        .code(413)
        .send(proxyError(413, 'invalid_request_error', 'request_too_large', null, 'The request is too large.').body());
      return;
    }
    deps.logger.error('request failed', { message: errorMessage(error) });
    reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
