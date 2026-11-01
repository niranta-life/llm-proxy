import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { blockedAddress, loopbackHost } from '../inference/private.js';
import { mcpFailure } from './errors.js';

function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (blockedAddress(value)) return true;
  const kind = isIP(value);
  if (kind === 4) {
    const parts = value.split('.').map((item) => Number(item));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
    if (value.startsWith('::ffff:')) return true;
    return false;
  }
  return true;
}

export function parseApprovedEndpoint(value: string): URL {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512 || /\s/.test(trimmed) || trimmed.includes('@')) {
    throw mcpFailure('rejected', 'The endpoint is not allowed.');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw mcpFailure('rejected', 'The endpoint is not allowed.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw mcpFailure('rejected', 'The endpoint is not allowed.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = host === '127.0.0.1' || host === 'localhost';
  const https = url.protocol === 'https:';
  const httpLoopback = url.protocol === 'http:' && loopback;
  if (!https && !httpLoopback) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (host === '' || host.includes('%')) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (url.port !== '' && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw mcpFailure('rejected', 'The endpoint is not allowed.');
  }
  url.hostname = host;
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export async function assertResolvableEndpoint(url: URL): Promise<void> {
  if (loopbackHost(url.hostname) && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return;
  const literal = isIP(url.hostname);
  const addresses = literal ? [url.hostname] : await lookup(url.hostname, { all: true, verbatim: true }).then(
    (rows) => rows.map((row) => row.address),
    () => {
      throw mcpFailure('rejected', 'The endpoint is not allowed.');
    },
  );
  if (addresses.length === 0 || addresses.some((address) => privateAddress(address))) {
    throw mcpFailure('rejected', 'The endpoint is not allowed.');
  }
}

export function assertSameTarget(candidate: URL, approved: URL): void {
  if (candidate.protocol !== approved.protocol) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (candidate.hostname !== approved.hostname) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (candidate.port !== approved.port) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (candidate.pathname !== approved.pathname) throw mcpFailure('rejected', 'The endpoint is not allowed.');
  if (candidate.username !== '' || candidate.password !== '' || candidate.search !== '' || candidate.hash !== '') {
    throw mcpFailure('rejected', 'The endpoint is not allowed.');
  }
}
