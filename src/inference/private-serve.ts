import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { withTenant } from '../db/tenant-context.js';
import { providerChatBaseUrl } from './compatible.js';
import { proxyError } from './errors.js';
import {
  acquirePrivateConcurrency,
  createPrivateFetch,
  decidePrivateChat,
  endpointPort,
  parseStoredPrivateEndpoint,
  resolvePrivateHost,
  type PrivateDecision,
} from './private.js';
import type { ResolvedRoute } from './resolve.js';
import { loadCatalog, loadPrivateApproval } from './store.js';

export type RouteTransport = {
  baseURL: string;
  fetchImpl?: typeof fetch;
  release: () => Promise<void>;
};

function unavailable(): never {
  throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function decideForRoute(input: {
  runtimePool: Pool;
  tenantId: string;
  route: ResolvedRoute;
  resolveHost?: (host: string) => Promise<readonly string[]>;
}): Promise<PrivateDecision> {
  const stored = input.route.endpoint;
  const parsed = stored === null ? undefined : parseStoredPrivateEndpoint(stored);
  if (stored === null || parsed === undefined) unavailable();
  const host = parsed.hostname.toLowerCase();
  const approval = await withTenant(input.runtimePool, input.tenantId, (client) =>
    loadPrivateApproval(client, host, endpointPort(parsed)),
  );
  if (approval === null) unavailable();
  const resolved = await (input.resolveHost ?? resolvePrivateHost)(host);
  return decidePrivateChat({ storedEndpoint: stored, approval, resolvedAddresses: resolved });
}

export async function bindRouteTransport(input: {
  runtimePool: Pool;
  tenantId: string;
  route: ResolvedRoute;
  upstreamBaseUrl: string;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
}): Promise<RouteTransport> {
  if (input.route.provider !== 'dgx') {
    return {
      baseURL: providerChatBaseUrl(input.route.provider, input.route.endpoint, input.upstreamBaseUrl),
      fetchImpl: input.fetchImpl,
      release: async () => {},
    };
  }
  const decision = await decideForRoute(input);
  const releaseSlot = acquirePrivateConcurrency(input.tenantId, input.route.deploymentId, input.route.maxConcurrency);
  const guarded = createPrivateFetch({
    fetchImpl: input.fetchImpl ?? fetch,
    decision,
    mode: 'serving',
  });
  let closed = false;
  return {
    baseURL: decision.baseUrl,
    fetchImpl: guarded.fetch,
    release: async () => {
      releaseSlot();
      if (closed) return;
      closed = true;
      await guarded.close();
    },
  };
}

async function openPrivateCredential(
  runtimePool: Pool,
  store: ProviderCredentialStore,
  tenantId: string,
  route: ResolvedRoute,
): Promise<string> {
  return withTenant(runtimePool, tenantId, async (client) => {
    const credential = await client.query<{ protected_credential: string | null; enabled: boolean; auth_mode: string }>(
      `SELECT c.auth_mode, c.enabled, load_provider_credential($1::uuid, $2::uuid) AS protected_credential
       FROM provider_connections c
       WHERE c.id = $2 AND c.tenant_id = $1`,
      [tenantId, route.connectionId],
    );
    const row = credential.rows[0];
    if (row === undefined || !row.enabled || row.auth_mode !== 'api_key' || row.protected_credential === null) {
      unavailable();
    }
    return store.open(row.protected_credential);
  });
}

async function routeByName(runtimePool: Pool, tenantId: string, deployment: string): Promise<ResolvedRoute> {
  const route = await withTenant(runtimePool, tenantId, async (client) => {
    const catalog = await loadCatalog(client);
    const found = catalog.deployments.find((item) => item.name === deployment && item.provider === 'dgx');
    if (found === undefined || !found.connectionEnabled) return null;
    return {
      requestedModel: deployment,
      deploymentId: found.id,
      deploymentName: found.name,
      upstreamModel: found.upstreamModel,
      timeoutMs: found.timeoutMs,
      capabilities: found.capabilities,
      configVersion: found.configVersion,
      connectionId: found.connectionId,
      connectionVersion: found.connectionVersion,
      provider: found.provider,
      endpoint: found.endpoint,
      workspaceId: found.workspaceId,
      defaultMaxOutputTokens: found.defaultMaxOutputTokens,
      streamingEnabled: found.streamingEnabled,
      streamConnectTimeoutMs: found.streamConnectTimeoutMs,
      streamIdleTimeoutMs: found.streamIdleTimeoutMs,
      streamTotalTimeoutMs: found.streamTotalTimeoutMs,
      streamBackpressureTimeoutMs: found.streamBackpressureTimeoutMs,
      projectId: found.projectId ?? null,
      location: found.location ?? null,
      authMode: found.authMode ?? null,
      serviceAccountIdentity: found.serviceAccountIdentity ?? null,
      apiVersion: found.apiVersion ?? null,
      connectionConfigVersion: found.connectionConfigVersion ?? 0,
      downstreamProviders: found.downstreamProviders ?? null,
      dataCollection: found.dataCollection ?? null,
      allowFallbacks: found.allowFallbacks ?? null,
      requireServingProvider: found.requireServingProvider ?? false,
      maxConcurrency: found.maxConcurrency ?? null,
    } satisfies ResolvedRoute;
  });
  if (route === null) unavailable();
  return route;
}

export async function listPrivateModels(input: {
  runtimePool: Pool;
  store: ProviderCredentialStore;
  tenantId: string;
  deployment: string;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
}): Promise<{ models: string[] }> {
  const route = await routeByName(input.runtimePool, input.tenantId, input.deployment);
  const decision = await decideForRoute({ ...input, route });
  const guarded = createPrivateFetch({
    fetchImpl: input.fetchImpl ?? fetch,
    decision,
    mode: 'serving',
  });
  let apiKey = '';
  try {
    apiKey = await openPrivateCredential(input.runtimePool, input.store, input.tenantId, route);
    const response = await guarded.fetch(`${decision.baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (!response.ok) unavailable();
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.data)) unavailable();
    const models = body.data.map((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 256) unavailable();
      return item.id;
    });
    return { models };
  } finally {
    apiKey = '';
    await guarded.close();
  }
}

export async function probePrivateHealth(input: {
  runtimePool: Pool;
  store: ProviderCredentialStore;
  tenantId: string;
  deployment: string;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
}): Promise<{ status: number }> {
  const route = await routeByName(input.runtimePool, input.tenantId, input.deployment);
  const decision = await decideForRoute({ ...input, route });
  if (decision.healthEndpoint === null) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The health endpoint is not configured.');
  }
  const guarded = createPrivateFetch({
    fetchImpl: input.fetchImpl ?? fetch,
    decision,
    mode: 'health',
  });
  let apiKey = '';
  try {
    apiKey = await openPrivateCredential(input.runtimePool, input.store, input.tenantId, route);
    const response = await guarded.fetch(decision.healthEndpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    return { status: response.status };
  } finally {
    apiKey = '';
    await guarded.close();
  }
}
