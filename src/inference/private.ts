import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { proxyError } from './errors.js';

const PUBLIC_SUFFIXES = ['openai.com', 'anthropic.com', 'x.ai', 'openrouter.ai', 'googleapis.com'];
const BLOCKED_ADDRESSES = new Set(['0.0.0.0', '169.254.169.254', '::', '::1']);
const SERVING_PATHS = new Set(['/v1/models', '/v1/chat/completions']);
const HEALTH_PATHS = new Set(['/health', '/health/ready', '/ready', '/v1/health', '/v1/health/ready']);
const MANAGEMENT_PREFIXES = ['/admin', '/metrics', '/manage', '/management', '/debug'];
const ADDRESS_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;
const HOST_TEXT = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export type PrivateApproval = {
  host: string;
  port: number;
  addresses: readonly string[];
  tlsVerify: boolean;
  healthEndpoint: string | null;
};

export type PrivateDecision = {
  baseUrl: string;
  host: string;
  port: number;
  rejectUnauthorized: boolean;
  pinnedAddresses: readonly string[];
  healthEndpoint: string | null;
};

const inflight = new Map<string, number>();

function unavailable(): never {
  throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
}

export function cleanPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

export function loopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function publicProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return PUBLIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function endpointPort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

export function parseStoredPrivateEndpoint(value: string): URL | undefined {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length < 8 || trimmed.length > 512 || /\s/.test(trimmed) || trimmed.includes('@')) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  if (url.hostname === '' || publicProviderHost(url.hostname)) return undefined;
  if (cleanPath(url.pathname) !== '/v1') return undefined;
  return url;
}

function sameAddressSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  const pinned = [...left].map((item) => item.toLowerCase()).sort();
  const resolved = [...right].map((item) => item.toLowerCase()).sort();
  return pinned.every((item, index) => item === resolved[index]);
}

export function blockedAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (BLOCKED_ADDRESSES.has(value)) return true;
  return value.startsWith('169.254.');
}

export function normalizeApproval(input: {
  host: string;
  port: number;
  addresses: readonly string[];
  tlsVerify: boolean;
  healthEndpoint: string | null;
}): PrivateApproval {
  const host = input.host.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_TEXT.test(host) || publicProviderHost(host)) throw new Error('endpoint is not allowed');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('endpoint is invalid');
  if (input.addresses.length < 1 || input.addresses.length > 8) throw new Error('endpoint is invalid');
  const addresses = input.addresses.map((item) => item.trim().toLowerCase());
  if (new Set(addresses).size !== addresses.length) throw new Error('endpoint is invalid');
  if (addresses.some((item) => !ADDRESS_TEXT.test(item) || blockedAddress(item) || isIP(item) === 0)) {
    throw new Error('endpoint is invalid');
  }
  if (!input.tlsVerify && !loopbackHost(host)) throw new Error('tls verification is required');
  const healthEndpoint = normalizeHealthEndpoint(input.healthEndpoint, host, input.port);
  return { host, port: input.port, addresses, tlsVerify: input.tlsVerify, healthEndpoint };
}

function normalizeHealthEndpoint(value: string | null, host: string, port: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('endpoint is invalid');
  }
  const https = url.protocol === 'https:';
  const httpLoopback = url.protocol === 'http:' && loopbackHost(host);
  if ((!https && !httpLoopback) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('endpoint is invalid');
  }
  if (url.hostname.toLowerCase() !== host || endpointPort(url) !== port) throw new Error('endpoint is not allowed');
  if (privatePathKind(url.pathname) !== 'health') throw new Error('endpoint is not allowed');
  return url.toString().replace(/\/+$/, '');
}

export function privatePathKind(pathname: string): 'models' | 'chat' | 'health' | 'blocked' {
  const path = cleanPath(pathname);
  if (MANAGEMENT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 'blocked';
  if (path === '/v1/models') return 'models';
  if (path === '/v1/chat/completions') return 'chat';
  if (HEALTH_PATHS.has(path)) return 'health';
  return 'blocked';
}

export function decidePrivateChat(input: {
  storedEndpoint: string;
  approval: PrivateApproval | null;
  resolvedAddresses: readonly string[];
}): PrivateDecision {
  const stored = parseStoredPrivateEndpoint(input.storedEndpoint);
  if (stored === undefined || input.approval === null) unavailable();
  const host = stored.hostname.toLowerCase();
  const port = endpointPort(stored);
  if (input.approval.host !== host || input.approval.port !== port) unavailable();
  if (!sameAddressSet(input.approval.addresses, input.resolvedAddresses)) unavailable();
  if (input.resolvedAddresses.some((address) => blockedAddress(address))) unavailable();
  if (!input.approval.tlsVerify && !loopbackHost(host)) unavailable();
  return {
    baseUrl: stored.toString().replace(/\/+$/, ''),
    host,
    port,
    rejectUnauthorized: loopbackHost(host) ? input.approval.tlsVerify : true,
    pinnedAddresses: input.approval.addresses,
    healthEndpoint: input.approval.healthEndpoint,
  };
}

export function pinnedLookup(
  host: string,
  addresses: readonly string[],
): (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void) => void {
  return (hostname, options, callback) => {
    if (hostname.toLowerCase().replace(/\.$/, '') !== host) {
      callback(Object.assign(new Error('endpoint is not allowed'), { code: 'ENOTFOUND' }));
      return;
    }
    const records = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const all = typeof options === 'object' && options !== null && 'all' in options && (options as { all?: boolean }).all === true;
    if (all) {
      callback(null, records);
      return;
    }
    callback(null, records[0]?.address ?? '', records[0]?.family ?? 4);
  };
}

function requestUrl(resource: Parameters<typeof fetch>[0]): string {
  if (typeof resource === 'string') return resource;
  if (resource instanceof URL) return resource.toString();
  return resource.url;
}

export function createPrivateFetch(input: {
  fetchImpl: typeof fetch;
  decision: PrivateDecision;
  mode: 'serving' | 'health';
}): { fetch: typeof fetch; close: () => Promise<void> } {
  const agent = new Agent({
    connect: {
      rejectUnauthorized: input.decision.rejectUnauthorized,
      servername: input.decision.host,
      lookup: pinnedLookup(input.decision.host, input.decision.pinnedAddresses) as never,
    },
  });
  const wrapped: typeof fetch = async (resource, init) => {
    const raw = requestUrl(resource);
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      unavailable();
    }
    if (target.username !== '' || target.password !== '' || target.search !== '' || target.hash !== '') unavailable();
    if (target.protocol !== 'https:' || target.hostname.toLowerCase() !== input.decision.host) unavailable();
    if (endpointPort(target) !== input.decision.port) unavailable();
    const kind = privatePathKind(target.pathname);
    const health = input.decision.healthEndpoint?.replace(/\/+$/, '') ?? null;
    const allowed =
      input.mode === 'serving'
        ? kind === 'models' || kind === 'chat'
        : health !== null && kind === 'health' && target.toString().replace(/\/+$/, '') === health;
    if (!allowed) unavailable();
    const response = await input.fetchImpl(resource, {
      ...init,
      redirect: 'manual',
      dispatcher: agent,
    } as RequestInit);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw proxyError(502, 'server_error', 'endpoint_redirect', null, 'The upstream endpoint redirected.');
    }
    return response;
  };
  return {
    fetch: wrapped,
    close: async () => {
      await agent.close();
    },
  };
}

export async function resolvePrivateHost(host: string): Promise<string[]> {
  if (blockedAddress(host) || publicProviderHost(host)) unavailable();
  if (isIP(host) !== 0) return [host.toLowerCase()];
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    unavailable();
  }
}

export function acquirePrivateConcurrency(tenantId: string, deploymentId: string, limit: number | null): () => void {
  if (limit === null) return () => {};
  if (!Number.isInteger(limit) || limit < 1) unavailable();
  const key = `${tenantId}:${deploymentId}`;
  const current = inflight.get(key) ?? 0;
  if (current >= limit) {
    throw proxyError(429, 'rate_limit_error', 'concurrency_limit', null, 'The deployment concurrency limit was reached.');
  }
  inflight.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (inflight.get(key) ?? 1) - 1;
    if (next <= 0) inflight.delete(key);
    else inflight.set(key, next);
  };
}
