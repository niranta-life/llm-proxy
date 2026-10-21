import type { ResolvedRoute } from './resolve.js';
import { proxyError, type ProxyError } from './errors.js';

// The registry stores a null endpoint for these providers.
// The caller cannot choose a base URL, and OPENAI_BASE_URL must not receive the call.
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const REPORTED_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EXPLICIT_PROVIDER_KEYS = ['provider', 'provider_name', 'serving_provider'] as const;

// OpenRouter omits serving identity unless the caller opts in.
export const OPENROUTER_METADATA_HEADER = 'X-OpenRouter-Metadata';
export const OPENROUTER_METADATA_VALUE = 'enabled';

export type DataCollection = 'allow' | 'deny';

export type OpenRouterPolicy = {
  downstreamProviders: readonly string[] | null;
  dataCollection: DataCollection | null;
  allowFallbacks: boolean | null;
  requireServingProvider: boolean;
};

export function providerChatBaseUrl(provider: string, endpoint: string | null, openAiBaseUrl: string): string {
  if (provider === 'anthropic') return endpoint ?? '';
  if (provider === 'xai') return XAI_BASE_URL;
  if (provider === 'openrouter') return OPENROUTER_BASE_URL;
  if (provider === 'openai' || provider === 'vertex') return openAiBaseUrl;
  throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
}

export function routePolicy(route: ResolvedRoute): OpenRouterPolicy {
  return {
    downstreamProviders: route.downstreamProviders ?? null,
    dataCollection: route.dataCollection ?? null,
    allowFallbacks: route.allowFallbacks ?? null,
    requireServingProvider: route.requireServingProvider ?? false,
  };
}

// Send only the restrictions an operator stored.
// A missing allow_fallbacks or data_collection is not sent, because the upstream default would widen it.
export function openRouterRoutingBody(policy: OpenRouterPolicy): Record<string, unknown> | undefined {
  const provider: Record<string, unknown> = {};
  if (policy.downstreamProviders !== null) {
    if (policy.downstreamProviders.length === 0) {
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }
    provider.only = [...policy.downstreamProviders];
  }
  if (policy.dataCollection !== null) provider.data_collection = policy.dataCollection;
  if (policy.allowFallbacks !== null) provider.allow_fallbacks = policy.allowFallbacks;
  if (Object.keys(provider).length === 0) return undefined;
  return provider;
}

export function compatibleRequestFields(
  provider: string,
  policy: OpenRouterPolicy,
  optional: Record<string, unknown>,
): Record<string, unknown> {
  const fields = { ...optional };
  delete fields.provider;
  delete fields.models;
  delete fields.route;
  if (provider !== 'openrouter') return fields;
  const routing = openRouterRoutingBody(policy);
  if (routing === undefined) return fields;
  return { ...fields, provider: routing };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameProvider(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function oneProvider(names: readonly string[]): string | null {
  const first = names[0];
  if (first === undefined) return null;
  for (const name of names) {
    if (!sameProvider(first, name)) throw servingIdentityError();
  }
  return first;
}

function explicitProviders(value: Record<string, unknown>, strict: boolean): string[] {
  const found: string[] = [];
  for (const key of EXPLICIT_PROVIDER_KEYS) {
    const candidate = value[key];
    if (typeof candidate !== 'string') continue;
    if (!REPORTED_PROVIDER.test(candidate)) {
      if (strict && candidate.length > 0) throw servingIdentityError();
      continue;
    }
    if (!strict) return [candidate];
    found.push(candidate);
  }
  return found;
}

// Selected router metadata is the documented serving provider.
// A summary sentence and a model slug are not that provider.
function selectedRouterProviders(value: Record<string, unknown>): string[] {
  const metadata = value.openrouter_metadata;
  if (!isRecord(metadata)) return [];
  const endpoints = metadata.endpoints;
  if (!isRecord(endpoints) || !Array.isArray(endpoints.available)) return [];
  const found: string[] = [];
  for (const item of endpoints.available) {
    if (!isRecord(item) || item.selected !== true || !('provider' in item)) continue;
    const provider = item.provider;
    if (typeof provider !== 'string' || !REPORTED_PROVIDER.test(provider)) throw servingIdentityError();
    found.push(provider);
  }
  return found;
}

// A model slug is not a serving provider. Only an explicit provider id counts.
// OpenRouter identity also includes the selected provider in openrouter_metadata.
// Conflicting names fail closed. The returned spelling is the reported name.
export function readReportedProvider(value: unknown, routerMetadata = false): string | null {
  if (!isRecord(value)) return null;
  const explicit = explicitProviders(value, routerMetadata);
  if (!routerMetadata) return explicit[0] ?? null;
  const selected = selectedRouterProviders(value);
  const explicitName = oneProvider(explicit);
  const selectedName = oneProvider(selected);
  if (explicitName !== null && selectedName !== null && !sameProvider(explicitName, selectedName)) {
    throw servingIdentityError();
  }
  return selectedName ?? explicitName;
}

export function servingProviderAllowed(reported: string, allowed: readonly string[]): boolean {
  return allowed.some((slug) => sameProvider(reported, slug));
}

export function servingIdentityError(): ProxyError {
  return proxyError(
    502,
    'server_error',
    'serving_provider_unverified',
    null,
    'The serving provider was not verified.',
  );
}

export function assertServingIdentity(policy: OpenRouterPolicy, reported: string | null): void {
  const allowed = policy.downstreamProviders;
  const outside = reported !== null && allowed !== null && !servingProviderAllowed(reported, allowed);
  if (outside) throw servingIdentityError();
  if (!policy.requireServingProvider) return;
  if (reported === null || outside) throw servingIdentityError();
}
