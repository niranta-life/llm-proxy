import type { RegistryProviderName } from './contract.js';
import type { StoredExecutionPolicy } from './execution-policy.js';

export type DeploymentCandidate = {
  id: string;
  name: string;
  upstreamModel: string;
  timeoutMs: number;
  capabilities: readonly string[];
  configVersion: number;
  connectionId: string;
  connectionVersion: number;
  enabled: boolean;
  connectionEnabled: boolean;
  provider: RegistryProviderName;
  endpoint: string | null;
  workspaceId: string | null;
  defaultMaxOutputTokens: number | null;
  streamingEnabled: boolean;
  streamConnectTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  streamTotalTimeoutMs: number | null;
  streamBackpressureTimeoutMs: number | null;
  projectId: string | null;
  location: string | null;
  authMode: string | null;
  serviceAccountIdentity: string | null;
  apiVersion: string | null;
  connectionConfigVersion: number;
  downstreamProviders: readonly string[] | null;
  dataCollection: 'allow' | 'deny' | null;
  allowFallbacks: boolean | null;
  requireServingProvider: boolean;
  maxConcurrency: number | null;
  executionPolicy?: StoredExecutionPolicy | null;
  validationStatus?: string;
  contextLimit?: number | null;
};

export type FallbackPolicy = {
  id: string;
  version: number;
  enabled: boolean;
  maxAttempts: number;
  deploymentIds: readonly string[];
  allowedFailures: readonly string[];
  requiredCapabilities: readonly string[];
  allowedProviders: readonly string[];
  allowedRegions: readonly string[];
  dataCollection: 'allow' | 'deny';
  minRemainingDeadlineMs: number;
};

export type AliasCandidate = {
  alias: string;
  deploymentId: string;
  fallbackPolicy?: FallbackPolicy | null;
};

export type ResolvedRoute = {
  requestedModel: string;
  deploymentId: string;
  deploymentName: string;
  upstreamModel: string;
  timeoutMs: number;
  capabilities: readonly string[];
  configVersion: number;
  connectionId: string;
  connectionVersion: number;
  provider: RegistryProviderName;
  endpoint: string | null;
  workspaceId: string | null;
  defaultMaxOutputTokens: number | null;
  streamingEnabled: boolean;
  streamConnectTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  streamTotalTimeoutMs: number | null;
  streamBackpressureTimeoutMs: number | null;
  projectId: string | null;
  location: string | null;
  authMode: string | null;
  serviceAccountIdentity: string | null;
  apiVersion: string | null;
  connectionConfigVersion: number;
  downstreamProviders: readonly string[] | null;
  dataCollection: 'allow' | 'deny' | null;
  allowFallbacks: boolean | null;
  requireServingProvider: boolean;
  maxConcurrency: number | null;
  executionPolicy?: StoredExecutionPolicy | null;
  routedByAlias?: boolean;
  fallbackPolicy?: FallbackPolicy | null;
  validationStatus?: string;
  contextLimit?: number | null;
};

export function routeForDeployment(
  requestedModel: string,
  deployment: DeploymentCandidate,
  routedByAlias: boolean,
  policy: FallbackPolicy | null,
): ResolvedRoute {
  return {
    requestedModel,
    deploymentId: deployment.id,
    deploymentName: deployment.name,
    upstreamModel: deployment.upstreamModel,
    timeoutMs: deployment.timeoutMs,
    capabilities: deployment.capabilities,
    configVersion: deployment.configVersion,
    connectionId: deployment.connectionId,
    connectionVersion: deployment.connectionVersion,
    provider: deployment.provider,
    endpoint: deployment.endpoint,
    workspaceId: deployment.workspaceId,
    defaultMaxOutputTokens: deployment.defaultMaxOutputTokens,
    streamingEnabled: deployment.streamingEnabled,
    streamConnectTimeoutMs: deployment.streamConnectTimeoutMs,
    streamIdleTimeoutMs: deployment.streamIdleTimeoutMs,
    streamTotalTimeoutMs: deployment.streamTotalTimeoutMs,
    streamBackpressureTimeoutMs: deployment.streamBackpressureTimeoutMs,
    projectId: deployment.projectId ?? null,
    location: deployment.location ?? null,
    authMode: deployment.authMode ?? null,
    serviceAccountIdentity: deployment.serviceAccountIdentity ?? null,
    apiVersion: deployment.apiVersion ?? null,
    connectionConfigVersion: deployment.connectionConfigVersion ?? 0,
    downstreamProviders: deployment.downstreamProviders ?? null,
    dataCollection: deployment.dataCollection ?? null,
    allowFallbacks: deployment.allowFallbacks ?? null,
    requireServingProvider: deployment.requireServingProvider ?? false,
    maxConcurrency: deployment.maxConcurrency ?? null,
    executionPolicy: deployment.executionPolicy ?? null,
    routedByAlias,
    fallbackPolicy: policy,
    validationStatus: deployment.validationStatus ?? 'unvalidated',
    contextLimit: deployment.contextLimit ?? null,
  };
}

export function resolveModel(
  requestedModel: string,
  deployments: readonly DeploymentCandidate[],
  aliases: readonly AliasCandidate[],
): ResolvedRoute | null {
  const alias = aliases.find((item) => item.alias === requestedModel);
  const deployment = alias
    ? deployments.find((item) => item.id === alias.deploymentId)
    : deployments.find((item) => item.name === requestedModel);
  if (deployment === undefined || !deployment.enabled || !deployment.connectionEnabled) return null;
  return routeForDeployment(requestedModel, deployment, alias !== undefined, alias?.fallbackPolicy ?? null);
}
