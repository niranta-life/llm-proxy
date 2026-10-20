import http from 'node:http';

const hits = [];
let mode = 'ok';
const hanging = new Set();

function completion(model, content, usage) {
  const body = {
    id: 'chatcmpl-check',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
  if (usage !== null) {
    body.usage = usage ?? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  }
  return body;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'llm-proxy-check-mock',
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && (url.pathname === '/hits' || url.pathname === '/health')) {
    send(response, 200, url.pathname === '/health' ? { status: 'ok', mode } : hits);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/reset') {
    hits.length = 0;
    for (const pending of hanging) send(pending, 204);
    hanging.clear();
    mode = 'ok';
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/control') {
    const raw = await readBody(request);
    const body = raw ? JSON.parse(raw) : {};
    if (typeof body.mode === 'string') mode = body.mode;
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const raw = await readBody(request);
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const content = parsed.messages?.[0]?.content;
    hits.push({
      authorization: String(request.headers.authorization || ''),
      model: typeof parsed.model === 'string' ? parsed.model : '',
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : null,
      content: typeof content === 'string' ? content : '',
    });
    if (mode === 'hang') {
      hanging.add(response);
      request.on('aborted', () => hanging.delete(response));
      return;
    }
    if (mode === 'error500') {
      send(response, 500, {
        error: { message: 'upstream blew up sk-check-upstream-secret', type: 'server_error' },
      });
      return;
    }
    if (mode === 'rate429') {
      send(response, 429, {
        error: { message: 'slow down sk-check-upstream-secret', type: 'rate_limit_error' },
      });
      return;
    }
    if (mode === 'invalid') {
      send(response, 200, { nope: true });
      return;
    }
    if (mode === 'omit-usage') {
      send(response, 200, completion(parsed.model || 'gpt', 'no-usage', null));
      return;
    }
    const text = typeof content === 'string' ? `saw ${content}` : 'ok';
    send(response, 200, completion(parsed.model || 'gpt', text, undefined));
    return;
  }
  send(response, 404, { error: 'not_found' });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
server.listen(8081, '0.0.0.0');
