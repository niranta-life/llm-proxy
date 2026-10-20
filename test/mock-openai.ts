import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type MockHit = {
  method: string;
  url: string;
  authorization: string;
  body: string;
};

export function completionBody(
  model: string,
  content: string,
  usage?: Record<string, number> | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
  if (usage === undefined) {
    body.usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  } else if (usage !== null) {
    body.usage = usage;
  }
  return body;
}

export async function startMockUpstream(
  handle?: (hit: MockHit, request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ hits: MockHit[]; baseUrl: string; close: () => Promise<void> }> {
  const hits: MockHit[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const hit: MockHit = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      hits.push(hit);
      if (handle) {
        handle(hit, request, response);
        return;
      }
      const parsed = JSON.parse(hit.body) as { model?: string };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? 'gpt-test', 'ok')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock upstream has no port');
  return {
    hits,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
