import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type AnthropicHit = {
  method: string;
  url: string;
  apiKey: string;
  workspaceId: string;
  body: string;
};

export function anthropicMessage(
  model: string,
  text: string,
  stopReason = 'end_turn',
  usage?: Record<string, number | null> | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    content: [{ type: 'text', text }],
  };
  if (usage === undefined) {
    body.usage = {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    };
  } else if (usage !== null) {
    body.usage = usage;
  }
  return body;
}

export async function startMockAnthropic(
  handle?: (hit: AnthropicHit, request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ hits: AnthropicHit[]; origin: string; close: () => Promise<void> }> {
  const hits: AnthropicHit[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const hit: AnthropicHit = {
        method: request.method ?? '',
        url: request.url ?? '',
        apiKey: String(request.headers['x-api-key'] ?? ''),
        workspaceId: String(request.headers['anthropic-workspace-id'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      hits.push(hit);
      if (handle) {
        handle(hit, request, response);
        return;
      }
      const parsed = JSON.parse(hit.body) as { model?: string };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(anthropicMessage(parsed.model ?? 'claude-test', 'claude-ok')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock anthropic has no port');
  return {
    hits,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
