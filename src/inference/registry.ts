const NEW_PROVIDERS = ['vertex', 'xai', 'openrouter', 'dgx'] as const;

export type NewRegistryProvider = (typeof NEW_PROVIDERS)[number];

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^(?:global|[a-z]+(?:-[a-z0-9]+){1,3})$/;
const PUBLIC_SUFFIXES = ['openai.com', 'anthropic.com', 'x.ai', 'openrouter.ai', 'googleapis.com'];

export type PreparedRegistryConnection = {
  provider: NewRegistryProvider;
  authMode: 'api_key' | 'service_account';
  endpoint: string | null;
  projectId: string | null;
  location: string | null;
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
  if (publicProviderHost(url.hostname)) return undefined;
  return trimmed;
}

function assertVertexCredential(credential: string): void {
  const trimmed = credential.trim();
  if (!/private[_-]key/i.test(trimmed)) {
    throw new Error('service account identity is not a credential');
  }
}

export function prepareRegistryConnection(input: {
  provider: string;
  authMode: string | undefined;
  endpoint: string | undefined;
  projectId: string | undefined;
  location: string | undefined;
  credential: string;
}): PreparedRegistryConnection {
  if (!isNewProvider(input.provider)) throw new Error('provider is invalid');
  const provider = input.provider;
  const requestedAuth = blankToNull(input.authMode) ?? (provider === 'vertex' ? 'service_account' : 'api_key');
  if (requestedAuth !== 'api_key' && requestedAuth !== 'service_account') {
    throw new Error('auth mode is not supported');
  }
  if (provider === 'vertex' && requestedAuth !== 'service_account') throw new Error('auth mode is not supported');
  if (provider !== 'vertex' && requestedAuth !== 'api_key') throw new Error('auth mode is not supported');
  if (provider === 'vertex') assertVertexCredential(input.credential);

  const projectId = blankToNull(input.projectId);
  const location = blankToNull(input.location);
  const endpointText = blankToNull(input.endpoint);

  if (provider === 'vertex') {
    if (endpointText !== null) throw new Error('endpoint is not allowed');
    if (projectId === null || !PROJECT_ID.test(projectId)) throw new Error('project is invalid');
    if (location === null || !LOCATION.test(location)) throw new Error('location is invalid');
    return { provider, authMode: 'service_account', endpoint: null, projectId, location };
  }

  if (projectId !== null) throw new Error('project is not allowed');
  if (location !== null) throw new Error('location is not allowed');
  if (provider !== 'dgx') {
    if (endpointText !== null) throw new Error('endpoint is not allowed');
    return { provider, authMode: 'api_key', endpoint: null, projectId: null, location: null };
  }

  if (endpointText === null) throw new Error('endpoint is invalid');
  const endpoint = approvedDgxEndpoint(endpointText);
  if (endpoint === undefined) throw new Error('endpoint is invalid');
  return { provider, authMode: 'api_key', endpoint, projectId: null, location: null };
}
