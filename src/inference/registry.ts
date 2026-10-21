const NEW_PROVIDERS = ['vertex', 'xai', 'openrouter', 'dgx'] as const;

export type NewRegistryProvider = (typeof NEW_PROVIDERS)[number];

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^(?:global|[a-z]+(?:-[a-z0-9]+){1,3})$/;
const PUBLIC_SUFFIXES = ['openai.com', 'anthropic.com', 'x.ai', 'openrouter.ai', 'googleapis.com'];

const IDENTITY_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const IDENTITY_RESOURCE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/serviceAccounts\/[0-9]{6,30}$/;
const VERTEX_AUTH = new Set(['service_account', 'adc', 'workload_identity', 'impersonation']);

export type PreparedRegistryConnection = {
  provider: NewRegistryProvider;
  authMode: 'api_key' | 'service_account' | 'adc' | 'workload_identity' | 'impersonation';
  endpoint: string | null;
  projectId: string | null;
  location: string | null;
  serviceAccountIdentity: string | null;
  apiVersion: 'v1' | 'v1beta1';
};

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isNewProvider(value: string): value is NewRegistryProvider {
  return (NEW_PROVIDERS as readonly string[]).includes(value);
}

function publicProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return PUBLIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function approvedDgxEndpoint(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length < 8 || trimmed.length > 512 || /\s/.test(trimmed) || trimmed.includes('@')) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname.replace(/\/+$/, '') !== '/v1') return undefined;
  if (publicProviderHost(url.hostname)) return undefined;
  return trimmed;
}

function assertVertexCredential(credential: string): void {
  const trimmed = credential.trim();
  if (!/private[_-]key/i.test(trimmed)) {
    throw new Error('service account identity is not a credential');
  }
}

function parseIdentity(value: string | undefined, required: boolean): string | null {
  const identity = blankToNull(value);
  if (identity === null) {
    if (required) throw new Error('service account identity is required');
    return null;
  }
  if (!IDENTITY_EMAIL.test(identity) && !IDENTITY_RESOURCE.test(identity)) {
    throw new Error('service account identity is invalid');
  }
  return identity;
}

function parseApiVersion(value: string | undefined, allowBeta: boolean): 'v1' | 'v1beta1' {
  const version = blankToNull(value) ?? 'v1';
  if (version === 'v1') return 'v1';
  if (allowBeta && version === 'v1beta1') return 'v1beta1';
  throw new Error('api version is invalid');
}

export function prepareRegistryConnection(input: {
  provider: string;
  authMode: string | undefined;
  endpoint: string | undefined;
  projectId: string | undefined;
  location: string | undefined;
  credential: string;
  serviceAccountIdentity?: string;
  apiVersion?: string;
}): PreparedRegistryConnection {
  if (!isNewProvider(input.provider)) throw new Error('provider is invalid');
  const provider = input.provider;
  const requestedAuth = blankToNull(input.authMode) ?? (provider === 'vertex' ? 'service_account' : 'api_key');
  if (provider === 'vertex') {
    if (!VERTEX_AUTH.has(requestedAuth)) throw new Error('auth mode is not supported');
  } else if (requestedAuth !== 'api_key') {
    throw new Error('auth mode is not supported');
  }
  const identity = parseIdentity(input.serviceAccountIdentity, provider === 'vertex' && requestedAuth === 'impersonation');
  if (provider !== 'vertex' && identity !== null) throw new Error('service account identity is not allowed');
  const apiVersion = parseApiVersion(input.apiVersion, provider === 'vertex');
  if (provider === 'vertex' && requestedAuth === 'service_account') assertVertexCredential(input.credential);
  if (provider === 'vertex' && requestedAuth !== 'service_account' && input.credential.trim().length > 0) {
    throw new Error('api key is not allowed');
  }

  const projectId = blankToNull(input.projectId);
  const location = blankToNull(input.location);
  const endpointText = blankToNull(input.endpoint);

  if (provider === 'vertex') {
    if (endpointText !== null) throw new Error('endpoint is not allowed');
    if (projectId === null || !PROJECT_ID.test(projectId)) throw new Error('project is invalid');
    if (location === null || !LOCATION.test(location)) throw new Error('location is invalid');
    return {
      provider,
      authMode: requestedAuth as PreparedRegistryConnection['authMode'],
      endpoint: null,
      projectId,
      location,
      serviceAccountIdentity: identity,
      apiVersion,
    };
  }

  if (projectId !== null) throw new Error('project is not allowed');
  if (location !== null) throw new Error('location is not allowed');
  if (provider !== 'dgx') {
    if (endpointText !== null) throw new Error('endpoint is not allowed');
    return {
      provider,
      authMode: 'api_key',
      endpoint: null,
      projectId: null,
      location: null,
      serviceAccountIdentity: null,
      apiVersion: 'v1',
    };
  }

  if (endpointText === null) throw new Error('endpoint is invalid');
  const endpoint = approvedDgxEndpoint(endpointText);
  if (endpoint === undefined) throw new Error('endpoint is invalid');
  return {
    provider,
    authMode: 'api_key',
    endpoint,
    projectId: null,
    location: null,
    serviceAccountIdentity: null,
    apiVersion: 'v1',
  };
}
