import type { Pool } from 'pg';
import type { ProviderCredentialStore } from '../credentials.js';
import { breakerAllows } from '../db/breaker.js';
import { withTenant } from '../db/tenant-context.js';
import { fallbackResourcesAllow } from './admission.js';
import { bindRouteTransport, type RouteTransport } from './private-serve.js';
import {
  routeForDeployment,
  type DeploymentCandidate,
  type FallbackPolicy,
  type ResolvedRoute,
} from './resolve.js';
import { insertAttempt, loadCatalog, openRouteCredential } from './store.js';
import type { ChatRequest } from './validate.js';

export function contextNeed(request: ChatRequest): number {
  const requested = positiveInteger(request.optional.max_tokens) ?? positiveInteger(request.optional.max_completion_tokens);
  return requested ?? 1;
}

export function fallbackAttemptCap(policy: FallbackPolicy | null | undefined): number {
  if (policy === null || policy === undefined || !policy.enabled) return 1;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) return 1;
  if (policy.maxAttempts > 2) return 2;
  return policy.maxAttempts;
}

export function fallbackPermitted(input: {
  route: ResolvedRoute;
  failureClass: string;
  ordinal: number;
  outputStarted: boolean;
  callerAborted: boolean;
  fallbackUsed: boolean;
  remainingMs: number;
}): boolean {
  const policy = input.route.fallbackPolicy ?? null;
  if (input.route.routedByAlias !== true || policy === null || !policy.enabled) return false;
  if (input.outputStarted || input.callerAborted || input.fallbackUsed) return false;
  if (input.remainingMs <= 0 || input.remainingMs < policy.minRemainingDeadlineMs) return false;
  if (input.ordinal >= fallbackAttemptCap(policy)) return false;
  return policy.allowedFailures.includes(input.failureClass);
}

export function fallbackCandidates(
  policy: FallbackPolicy,
  deployments: readonly DeploymentCandidate[],
  failed: ResolvedRoute,
  request: ChatRequest,
): ResolvedRoute[] {
  const need = contextNeed(request);
  const requested = requestCapabilities(request);
  const selected: ResolvedRoute[] = [];
  for (const id of policy.deploymentIds) {
    if (id === failed.deploymentId) continue;
    const deployment = deployments.find((item) => item.id === id);
    if (deployment === undefined) continue;
    if (!deployment.enabled || !deployment.connectionEnabled) continue;
    if (deployment.validationStatus !== 'validated_live') continue;
    if (!policy.allowedProviders.includes(deployment.provider)) continue;
    if (deployment.dataCollection === null || deployment.dataCollection !== policy.dataCollection) continue;
    if (!policy.requiredCapabilities.every((capability) => deployment.capabilities.includes(capability))) continue;
    if (!requested.every((capability) => deployment.capabilities.includes(capability))) continue;
    if (deployment.contextLimit === null || deployment.contextLimit === undefined || deployment.contextLimit < need) continue;
    if (policy.allowedRegions.length > 0) {
      if (deployment.location === null || !policy.allowedRegions.includes(deployment.location)) continue;
    }
    selected.push(routeForDeployment(failed.requestedModel, deployment, true, policy));
  }
  return selected;
}

export async function chooseFallback(input: {
  pool: Pool;
  tenantId: string;
  apiKeyId: string;
  request: ChatRequest;
  failedRoute: ResolvedRoute;
  now: Date;
  stream: boolean;
  releasingAttemptId: string;
}): Promise<ResolvedRoute | null> {
  const policy = input.failedRoute.fallbackPolicy ?? null;
  if (policy === null || !policy.enabled) return null;
  try {
    const catalog = await withTenant(input.pool, input.tenantId, (client) => loadCatalog(client));
    const candidates = fallbackCandidates(policy, catalog.deployments, input.failedRoute, input.request);
    for (const candidate of candidates) {
      const breaker = await breakerAllows(input.pool, input.tenantId, candidate.deploymentId, input.now);
      if (!breaker) continue;
      const resources = await fallbackResourcesAllow(input.pool, {
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        route: candidate,
        request: input.request,
        stream: input.stream,
        now: input.now,
        releasingAttemptId: input.releasingAttemptId,
      });
      if (!resources) continue;
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

export async function beginFallbackAttempt(input: {
  runtimePool: Pool;
  tenantId: string;
  requestId: string;
  route: ResolvedRoute;
  ordinal: number;
  triggerReason: string;
  store: ProviderCredentialStore;
  upstreamBaseUrl: string;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  prepare: (route: ResolvedRoute) => void;
}): Promise<{ transport: RouteTransport; apiKey: string; attemptId: string }> {
  const transport = await bindRouteTransport({
    runtimePool: input.runtimePool,
    tenantId: input.tenantId,
    route: input.route,
    upstreamBaseUrl: input.upstreamBaseUrl,
    fetchImpl: input.fetchImpl,
    resolveHost: input.resolveHost,
  });
  try {
    input.prepare(input.route);
    const created = await withTenant(input.runtimePool, input.tenantId, async (client) => {
      const protectedCredential = await openRouteCredential(client, input.tenantId, input.route.connectionId);
      const attemptId = await insertAttempt(
        client,
        input.tenantId,
        input.requestId,
        input.route,
        input.ordinal,
        { triggerReason: input.triggerReason },
      );
      return { attemptId, protectedCredential };
    });
    const apiKey = created.protectedCredential === null ? '' : input.store.open(created.protectedCredential);
    return { transport, apiKey, attemptId: created.attemptId };
  } catch (error) {
    await transport.release();
    throw error;
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function requestCapabilities(request: ChatRequest): string[] {
  return Object.keys(request.optional).map((key) => (key === 'response_format' ? 'response_format_text' : key));
}
