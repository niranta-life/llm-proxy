import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai';
import { Compute, GoogleAuth, Impersonated, JWT, type AuthClient } from 'google-auth-library';
import { proxyError } from './errors.js';
import type { VertexContent } from './vertex-convert.js';

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';
const REFRESH_SKEW_MS = 60_000;
const CACHE_LIMIT = 128;
const GUARDED_ENV = [
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_VERTEX_BASE_URL',
] as const;

export type VertexAuthMode = 'service_account' | 'adc' | 'workload_identity' | 'impersonation';

export type VertexApiVersion = 'v1' | 'v1beta1';

export type VertexClientSpec = {
  tenantId: string;
  connectionId: string;
  connectionConfigVersion: number;
  credentialVersion: number;
  projectId: string;
  location: string;
  apiVersion: VertexApiVersion;
  authMode: VertexAuthMode;
  serviceAccountIdentity: string | null;
  credentialJson: string | null;
};

export type VertexGenerateRequest = {
  model: string;
  contents: VertexContent[];
  config: {
    systemInstruction?: string;
    maxOutputTokens?: number;
    temperature?: number;
    stopSequences?: string[];
    abortSignal?: AbortSignal;
    automaticContinuation: false;
  };
};

export type VertexGenerateClient = {
  generateContent(request: VertexGenerateRequest): Promise<unknown>;
  generateContentStream(request: VertexGenerateRequest): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  listModels(signal?: AbortSignal): Promise<void>;
};

export type VertexClientFactory = (spec: VertexClientSpec) => Promise<VertexGenerateClient>;

type CacheEntry = {
  tenantId: string;
  connectionId: string;
  client: VertexGenerateClient;
  expiresAtMs: number;
};

type Mint = (spec: VertexClientSpec) => Promise<{ client: VertexGenerateClient; expiresAtMs: number }>;

const cache = new Map<string, CacheEntry>();

export function vertexLocationBaseUrl(location: string): string {
  if (location === 'global') return 'https://aiplatform.googleapis.com/';
  if (location === 'us' || location === 'eu') return `https://aiplatform.${location}.rep.googleapis.com/`;
  return `https://${location}-aiplatform.googleapis.com/`;
}

export function impersonatedPrincipal(identity: string): string {
  const marker = '/serviceAccounts/';
  const index = identity.lastIndexOf(marker);
  if (index < 0) return identity;
  return identity.slice(index + marker.length);
}

export function vertexCacheKey(spec: VertexClientSpec): string {
  return [
    spec.tenantId,
    spec.connectionId,
    spec.serviceAccountIdentity ?? '',
    String(spec.connectionConfigVersion),
    String(spec.credentialVersion),
    spec.apiVersion,
    spec.authMode,
    spec.projectId,
    spec.location,
  ].join('\n');
}

export function clearVertexClientCache(): void {
  cache.clear();
}

export function evictVertexClient(spec: VertexClientSpec): void {
  cache.delete(vertexCacheKey(spec));
}

function snapshotEnv(): Array<string | undefined> {
  return GUARDED_ENV.map((key) => process.env[key]);
}

function assertEnvUnchanged(before: Array<string | undefined>): void {
  const after = snapshotEnv();
  for (let index = 0; index < before.length; index += 1) {
    if (after[index] !== before[index]) {
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }
  }
}

function parseServiceAccount(credentialJson: string | null): { email: string; key: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialJson ?? '');
  } catch {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  const record = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof record.client_email !== 'string' || typeof record.private_key !== 'string' || record.private_key.length === 0) {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return { email: record.client_email, key: record.private_key };
}

export function describeVertexClientOptions(spec: VertexClientSpec, sourceClient?: AuthClient): GoogleGenAIOptions {
  const options: GoogleGenAIOptions = {
    vertexai: true,
    project: spec.projectId,
    location: spec.location,
    apiVersion: spec.apiVersion,
    httpOptions: { baseUrl: vertexLocationBaseUrl(spec.location) },
  };
  if (spec.authMode === 'service_account') {
    const parsed = parseServiceAccount(spec.credentialJson);
    const jwt = new JWT({ email: parsed.email, key: parsed.key, scopes: [CLOUD_PLATFORM] });
    options.googleAuthOptions = { authClient: jwt, scopes: [CLOUD_PLATFORM], projectId: spec.projectId };
    return options;
  }
  if (spec.authMode === 'workload_identity') {
    const compute = new Compute({
      serviceAccountEmail: spec.serviceAccountIdentity ?? undefined,
      scopes: [CLOUD_PLATFORM],
      projectId: spec.projectId,
    });
    options.googleAuthOptions = { authClient: compute, scopes: [CLOUD_PLATFORM], projectId: spec.projectId };
    return options;
  }
  if (spec.authMode === 'impersonation') {
    if (sourceClient === undefined || spec.serviceAccountIdentity === null) {
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }
    const impersonated = new Impersonated({
      sourceClient,
      targetPrincipal: impersonatedPrincipal(spec.serviceAccountIdentity),
      delegates: [],
      lifetime: 3600,
      targetScopes: [CLOUD_PLATFORM],
    });
    options.googleAuthOptions = { authClient: impersonated, scopes: [CLOUD_PLATFORM], projectId: spec.projectId };
    return options;
  }
  options.googleAuthOptions = { scopes: [CLOUD_PLATFORM], projectId: spec.projectId };
  return options;
}

export async function vertexClientOptions(spec: VertexClientSpec): Promise<GoogleGenAIOptions> {
  if (spec.authMode !== 'impersonation') return describeVertexClientOptions(spec);
  const before = snapshotEnv();
  const source = new GoogleAuth({ scopes: [CLOUD_PLATFORM], projectId: spec.projectId });
  const sourceClient = await source.getClient();
  assertEnvUnchanged(before);
  return describeVertexClientOptions(spec, sourceClient);
}

function readExpiry(client: AuthClient): number | null {
  const credentials = (client as { credentials?: { expiry_date?: number | null } }).credentials;
  const expiry = credentials?.expiry_date;
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) return null;
  return expiry;
}

export function vertexGenerateClient(ai: GoogleGenAI): VertexGenerateClient {
  return wrapClient(ai);
}

function wrapClient(ai: GoogleGenAI): VertexGenerateClient {
  return {
    generateContent(request) {
      return ai.models.generateContent({
        model: request.model,
        contents: request.contents,
        config: request.config,
      });
    },
    generateContentStream(request) {
      return ai.models.generateContentStream({
        model: request.model,
        contents: request.contents,
        config: request.config,
      });
    },
    async listModels(signal) {
      // The default list is the publisher catalog and omits the project.
      await ai.models.list({ config: { pageSize: 1, queryBase: false, abortSignal: signal } });
    },
  };
}

export async function mintVertexClient(spec: VertexClientSpec): Promise<{ client: VertexGenerateClient; expiresAtMs: number }> {
  const before = snapshotEnv();
  try {
    const options = await vertexClientOptions(spec);
    const auth = new GoogleAuth({
      scopes: [CLOUD_PLATFORM],
      projectId: spec.projectId,
      authClient: options.googleAuthOptions?.authClient,
    });
    const authClient = options.googleAuthOptions?.authClient ?? (await auth.getClient());
    const access = await authClient.getAccessToken();
    const token = typeof access === 'string' ? access : access?.token;
    if (token === undefined || token === null || token.length === 0) {
      throw proxyError(401, 'authentication_error', 'expired_credentials', null, 'The upstream provider rejected the credential.', 'expired_credentials');
    }
    const expiresAtMs = readExpiry(authClient) ?? Date.now() + 5 * 60_000;
    const ai = new GoogleGenAI({
      ...options,
      googleAuthOptions: { authClient, scopes: [CLOUD_PLATFORM], projectId: spec.projectId },
    });
    assertEnvUnchanged(before);
    return { client: vertexGenerateClient(ai), expiresAtMs };
  } catch (error) {
    assertEnvUnchanged(before);
    throw error;
  }
}

export async function cachedVertexClient(
  spec: VertexClientSpec,
  deps: { now: () => number; mint: Mint } = { now: () => Date.now(), mint: mintVertexClient },
): Promise<VertexGenerateClient> {
  const key = vertexCacheKey(spec);
  const now = deps.now();
  const current = cache.get(key);
  if (current !== undefined && current.expiresAtMs - now > REFRESH_SKEW_MS) return current.client;
  if (current !== undefined) cache.delete(key);
  const minted = await deps.mint(spec);
  for (const [existingKey, entry] of cache) {
    if (entry.tenantId === spec.tenantId && entry.connectionId === spec.connectionId) cache.delete(existingKey);
  }
  while (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, {
    tenantId: spec.tenantId,
    connectionId: spec.connectionId,
    client: minted.client,
    expiresAtMs: minted.expiresAtMs,
  });
  return minted.client;
}

export function defaultVertexClientFactory(spec: VertexClientSpec): Promise<VertexGenerateClient> {
  return cachedVertexClient(spec);
}
