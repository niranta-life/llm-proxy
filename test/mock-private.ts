import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type PrivateMockHit = {
  method: string;
  path: string;
  authorization: string;
  body: string;
};

type Scene = 'text' | 'stream' | 'delay' | 'bad' | 'nousage' | 'timeout' | 'rate' | 'down' | 'cancel' | 'pressure' | 'redirect' | 'hold' | 'models' | 'health';

const MODEL = 'private-model-actual';
const SECRET = 'upstream-secret-text';

function completion(content: string, usage: boolean): Record<string, unknown> {
  return {
    id: 'chatcmpl-private',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage
      ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 } }
      : {}),
  };
}

function chunk(choice: unknown, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-private',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: MODEL,
    choices: [choice],
    ...extra,
  })}\n\n`;
}

function successSse(): string {
  return [
    chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null }),
    chunk({ index: 0, delta: { content: 'private-ok' }, finish_reason: null }),
    chunk({ index: 0, delta: {}, finish_reason: 'stop' }),
    chunk({ index: 0, delta: {} }, {
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 },
    }),
    'data: [DONE]\n\n',
  ].join('');
}

function contentOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

function sceneOf(method: string, path: string, body: string): Scene {
  if (method === 'GET' && path === '/v1/models') return 'models';
  if (method === 'GET' && (path === '/health' || path === '/health/ready' || path === '/ready')) return 'health';
  const content = contentOf(body);
  if (content.startsWith('scene-')) return content.slice('scene-'.length) as Scene;
  return 'text';
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

export async function startPrivateMock(): Promise<{
  port: number;
  hits: PrivateMockHit[];
  release: (scene: string) => void;
  waitFor: (scene: string) => Promise<PrivateMockHit>;
  close: () => Promise<void>;
}> {
  const hits: PrivateMockHit[] = [];
  const held = new Map<string, ServerResponse>();
  const waiters: Array<{ scene: string; resolve: (hit: PrivateMockHit) => void }> = [];

  function notify(scene: string, hit: PrivateMockHit): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || waiter.scene !== scene) continue;
      waiters.splice(index, 1);
      waiter.resolve(hit);
    }
  }

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const body = Buffer.concat(chunks).toString('utf8');
      const hit = {
        method: request.method ?? 'GET',
        path,
        authorization: String(request.headers.authorization ?? ''),
        body,
      };
      hits.push(hit);
      const scene = sceneOf(hit.method, path, body);
      notify(scene, hit);
      respond(scene, request, response);
    });
  });

  function respond(scene: Scene, request: IncomingMessage, response: ServerResponse): void {
    if (scene === 'models') {
      json(response, 200, { object: 'list', data: [{ id: 'private-model', object: 'model' }] });
      return;
    }
    if (scene === 'health') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (scene === 'rate') {
      json(response, 429, { error: { message: SECRET } });
      return;
    }
    if (scene === 'down') {
      json(response, 500, { error: { message: SECRET } });
      return;
    }
    if (scene === 'redirect') {
      response.writeHead(302, { location: 'https://evil.example/admin' });
      response.end('redirect-secret-token');
      return;
    }
    if (scene === 'nousage') {
      json(response, 200, completion('private-ok', false));
      return;
    }
    if (scene === 'text') {
      json(response, 200, completion('private-ok', true));
      return;
    }
    if (scene === 'bad') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${chunk({ index: 0, delta: { content: 'private-ok' }, finish_reason: null })}data: {not-json}\n\n`);
      return;
    }
    if (scene === 'delay') {
      const timer = setTimeout(() => {
        if (response.writableEnded) return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(successSse());
      }, 300);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    if (scene === 'stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(successSse());
      return;
    }
    if (scene === 'pressure') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }));
      const big = 'y'.repeat(256 * 1024);
      let writes = 0;
      const pump = (): void => {
        if (response.writableEnded || response.destroyed) return;
        if (writes >= 24) return;
        writes += 1;
        response.write(chunk({ index: 0, delta: { content: big }, finish_reason: null }));
        setImmediate(pump);
      };
      setImmediate(pump);
      return;
    }
    held.set(scene, response);
    response.on('close', () => {
      if (held.get(scene) === response) held.delete(scene);
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    hits,
    release(scene: string): void {
      const response = held.get(scene);
      if (response === undefined || response.writableEnded) return;
      held.delete(scene);
      json(response, 200, completion('private-ok', true));
    },
    waitFor(scene: string): Promise<PrivateMockHit> {
      const existing = hits.find((hit) => sceneOf(hit.method, hit.path, hit.body) === scene);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ scene, resolve }));
    },
    close: () => new Promise((resolve) => {
      for (const response of held.values()) response.destroy();
      held.clear();
      server.close(() => resolve());
    }),
  };
}
