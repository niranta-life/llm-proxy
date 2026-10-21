import { createServer, request as httpRequest } from 'node:http';
import { Agent } from 'undici';
import { createCredentialStore } from '../src/credentials.js';
import { createTestApp, freePort, runCli, type TestDatabase } from './helpers.js';
import { cliEnv, credentialKey, enableStreaming, provisionTenant } from './inference-support.js';
import { startPrivateMock, type PrivateMockHit } from './mock-private.js';

export const PRIVATE_HOST = 'dgx.lab.internal';
export const PRIVATE_PORT = 8443;
export const PRIVATE_ENDPOINT = `https://${PRIVATE_HOST}:${PRIVATE_PORT}/v1`;
export const PRIVATE_PIN = '10.0.0.8';
export const PRIVATE_KEY = 'dgx-secret-isolation-key';
export const UPSTREAM_MODEL = 'private-model';

export type PrivateHit = {
  url: string;
  method: string;
  authorization: string;
  body: string;
  redirect: string;
  metadata: string;
  rejectUnauthorized: boolean | null;
  servername: string | null;
  lookup: ((hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, value: unknown) => void) => void) | null;
};

type Mock = Awaited<ReturnType<typeof startPrivateMock>>;

function readUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string {
  const headers = new Headers(init?.headers);
  const direct = headers.get(name);
  if (direct) return direct;
  if (input instanceof Request) return input.headers.get(name) ?? '';
  return '';
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8');
  if (input instanceof Request) return input.clone().text();
  return '';
}

function messageContent(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

function connectOptions(dispatcher: unknown): { rejectUnauthorized?: boolean; servername?: string; lookup?: Function } | undefined {
  if (typeof dispatcher !== 'object' || dispatcher === null) return undefined;
  if (!(dispatcher instanceof Agent)) return undefined;
  for (const symbol of Object.getOwnPropertySymbols(dispatcher)) {
    const value = (dispatcher as unknown as Record<symbol, unknown>)[symbol];
    if (typeof value !== 'object' || value === null || !('connect' in value)) continue;
    const connect = (value as { connect?: unknown }).connect;
    if (typeof connect === 'object' && connect !== null) {
      return connect as { rejectUnauthorized?: boolean; servername?: string; lookup?: Function };
    }
  }
  return undefined;
}

export function bridgePrivateMock(mock: Mock, refusedPort: number): { hits: PrivateHit[]; fetch: typeof fetch } {
  const hits: PrivateHit[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = await readBody(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const connect = connectOptions((init as { dispatcher?: unknown } | undefined)?.dispatcher);
    const hit: PrivateHit = {
      url: readUrl(input),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      authorization: headerValue(input, init, 'authorization'),
      body,
      redirect: init?.redirect ?? '',
      metadata: headerValue(input, init, 'x-openrouter-metadata'),
      rejectUnauthorized: connect?.rejectUnauthorized ?? null,
      servername: connect?.servername ?? null,
      lookup: connect?.lookup ?? null,
    };
    hits.push(hit);
    if (messageContent(body) === 'scene-refuse') {
      return fetch(`http://127.0.0.1:${refusedPort}/connection-refused`, { signal: signal ?? undefined });
    }
    return forward(mock.port, hit, signal);
  };
  return { hits, fetch: fetchImpl };
}

function forward(port: number, hit: PrivateHit, signal: AbortSignal | null): Promise<Response> {
  const target = new URL(hit.url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: `${target.pathname}${target.search}`,
        method: hit.method,
        headers: {
          authorization: hit.authorization,
          accept: 'application/json',
          'content-type': 'application/json',
        },
      },
      (incoming) => {
        settled = true;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            incoming.on('end', () => controller.close());
            incoming.on('error', (error) => controller.error(error));
          },
          cancel() {
            incoming.destroy();
          },
        });
        resolve(new Response(stream, {
          status: incoming.statusCode ?? 502,
          headers: { 'content-type': String(incoming.headers['content-type'] ?? 'application/json') },
        }));
      },
    );
    const fail = (error: Error): void => {
      req.destroy();
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('error', fail);
    if (signal !== null) {
      if (signal.aborted) {
        fail(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => fail(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
    }
    if (hit.body.length > 0) req.write(hit.body);
    req.end();
  });
}

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

export function registerPrivate(
  db: TestDatabase,
  input: {
    tenantId: string;
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    upstreamModel?: string;
    timeoutMs?: number;
    enabled?: boolean;
    host?: string;
    port?: number;
    addresses?: string[];
    approve?: boolean;
    health?: boolean;
    concurrency?: number | null;
  },
): void {
  const env = cliEnv();
  const host = input.host ?? PRIVATE_HOST;
  const port = input.port ?? PRIVATE_PORT;
  const endpoint = input.endpoint ?? `https://${host}:${port}/v1`;
  runCli(
    db,
    ['register-dgx-connection', '--tenant-id', input.tenantId, '--api-key', input.apiKey ?? PRIVATE_KEY, '--endpoint', endpoint],
    env,
  );
  const deployment = [
    'register-deployment',
    '--tenant-id',
    input.tenantId,
    '--provider',
    'dgx',
    '--name',
    input.deployment ?? 'dgx-chat',
    '--upstream-model',
    input.upstreamModel ?? UPSTREAM_MODEL,
    '--timeout-ms',
    String(input.timeoutMs ?? 5000),
    '--capabilities',
    'temperature',
  ];
  if (input.enabled === true) deployment.push('--enabled', 'true');
  runCli(db, deployment, env);
  if (input.approve !== false) {
    const approval = [
      'approve-private-endpoint',
      '--tenant-id',
      input.tenantId,
      '--host',
      host,
      '--port',
      String(port),
      '--addresses',
      (input.addresses ?? [PRIVATE_PIN]).join(','),
      '--tls-verify',
      'true',
    ];
    if (input.health !== false) approval.push('--health-endpoint', `https://${host}:${port}/health`);
    runCli(db, approval, env);
  }
  if (input.concurrency !== undefined) {
    runCli(
      db,
      [
        'set-deployment-concurrency',
        '--tenant-id',
        input.tenantId,
        '--deployment',
        input.deployment ?? 'dgx-chat',
        '--max-concurrency',
        input.concurrency === null ? 'none' : String(input.concurrency),
      ],
      env,
    );
  }
}

export async function listenPrivate(
  db: TestDatabase,
  fetchImpl: typeof fetch,
  resolveHost: (host: string) => Promise<readonly string[]>,
): Promise<{
  baseURL: string;
  port: number;
  lines: string[];
  runtimePool: import('pg').Pool;
  close: () => Promise<void>;
}> {
  const ctx = await createTestApp(db, {
    inferenceEnabled: true,
    upstreamBaseUrl: 'http://127.0.0.1:9/v1',
    credentialKey,
    compatibleFetch: fetchImpl,
    privateResolve: resolveHost,
  });
  const port = await freePort();
  await ctx.app.listen({ host: '127.0.0.1', port });
  let closed = false;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    lines: ctx.lines,
    runtimePool: ctx.runtimePool,
    close: async () => {
      if (closed) return;
      closed = true;
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
    },
  };
}

export function pinResolver(address: string): (host: string) => Promise<readonly string[]> {
  return async () => [address];
}

export function credentialStore(): ReturnType<typeof createCredentialStore> {
  return createCredentialStore(credentialKey);
}

export function chatHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
  };
}

export async function postChat(
  baseURL: string,
  tenantId: string,
  secret: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(tenantId, secret),
    body: JSON.stringify(body),
    signal,
  });
}

export function provision(db: TestDatabase, name: string): ReturnType<typeof provisionTenant> {
  return provisionTenant(db, name);
}

export function streamOn(db: TestDatabase, tenantId: string, deployment = 'dgx-chat', backpressureTimeoutMs?: number): void {
  enableStreaming(db, { tenantId, deployment, ...(backpressureTimeoutMs === undefined ? {} : { backpressureTimeoutMs }) });
}

export type { PrivateMockHit, Mock };
