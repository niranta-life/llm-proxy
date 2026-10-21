import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { listPrivateModels } from '../src/inference/private-serve.js';
import { cliEntry, loadTestDatabase, projectRoot, runCli, serviceEnv } from './helpers.js';
import { adminPool, cliEnv } from './inference-support.js';
import { startPrivateMock } from './mock-private.js';
import {
  PRIVATE_ENDPOINT,
  PRIVATE_HOST,
  PRIVATE_KEY,
  PRIVATE_PIN,
  UPSTREAM_MODEL,
  bridgePrivateMock,
  chatHeaders,
  closedPort,
  credentialStore,
  listenPrivate,
  pinResolver,
  postChat,
  provision,
  registerPrivate,
  streamOn,
  type PrivateHit,
} from './private-support.js';

const SECRET = 'upstream-secret-text';

type AttemptRow = {
  status: string;
  error_code: string | null;
  upstream_model: string;
  serving_model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  stream_status: string | null;
  chunk_count: number | null;
};

async function attempts(admin: ReturnType<typeof adminPool>, tenantId: string): Promise<AttemptRow[]> {
  const result = await admin.query<AttemptRow>(
    `SELECT status, error_code, upstream_model, serving_model, prompt_tokens, completion_tokens, total_tokens, stream_status, chunk_count
     FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return result.rows;
}

async function waitStatus(admin: ReturnType<typeof adminPool>, tenantId: string, status: string): Promise<AttemptRow> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const rows = await attempts(admin, tenantId);
    const latest = rows.at(-1);
    if (latest?.stream_status === status) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const rows = await attempts(admin, tenantId);
  throw new Error(`stream status ${status} was not stored; latest=${rows.at(-1)?.stream_status ?? 'none'}`);
}

function doneCount(text: string): number {
  return text.split('data: [DONE]').length - 1;
}

describe('private endpoint chat', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  async function openSession(input: {
    name: string;
    timeoutMs?: number;
    streaming?: boolean;
    backpressureTimeoutMs?: number;
    concurrency?: number;
    approve?: boolean;
  }) {
    const tenant = provision(db, input.name);
    registerPrivate(db, {
      tenantId: tenant.tenantId,
      timeoutMs: input.timeoutMs,
      approve: input.approve,
      concurrency: input.concurrency,
    });
    if (input.streaming) streamOn(db, tenant.tenantId, 'dgx-chat', input.backpressureTimeoutMs);
    const mock = await startPrivateMock();
    const bridge = bridgePrivateMock(mock, await closedPort());
    const app = await listenPrivate(db, bridge.fetch, pinResolver(PRIVATE_PIN));
    const admin = adminPool(db);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      await mock.close();
      await admin.end();
    };
    closers.push(close);
    return { tenant, mock, bridge, app, admin, close };
  }

  it('keeps a new deployment disabled, then serves the stored model on the approved endpoint', async () => {
    const session = await openSession({ name: 'Private Disabled' });
    const headers = chatHeaders(session.tenant.tenantId, session.tenant.secret);
    const disabled = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(disabled.status).toBe(404);
    expect(session.bridge.hits).toHaveLength(0);
    expect(session.mock.hits).toHaveLength(0);

    runCli(db, ['set-deployment-enabled', '--tenant-id', session.tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    const response = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      temperature: 0.2,
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    const raw = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(raw) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      provider?: string;
    };
    expect(body.model).toBe('private-model-actual');
    expect(body.choices?.[0]?.message?.content).toBe('private-ok');
    expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 });
    expect(body.provider).toBeUndefined();
    expect(raw).not.toContain(PRIVATE_KEY);
    expect(session.app.lines.join('\n')).not.toContain(PRIVATE_KEY);
    const sent = JSON.parse(session.bridge.hits[0]?.body ?? '{}') as { model?: string; temperature?: number };
    expect(session.bridge.hits).toHaveLength(1);
    expect(session.mock.hits).toHaveLength(1);
    expect(session.bridge.hits[0]?.url).toBe(`${PRIVATE_ENDPOINT}/chat/completions`);
    expect(session.bridge.hits[0]?.authorization).toBe(`Bearer ${PRIVATE_KEY}`);
    expect(session.bridge.hits[0]?.metadata).toBe('');
    expect(session.bridge.hits[0]?.redirect).toBe('manual');
    expect(session.bridge.hits[0]?.rejectUnauthorized).toBe(true);
    expect(session.bridge.hits[0]?.servername).toBe(PRIVATE_HOST);
    expect(sent.model).toBe(UPSTREAM_MODEL);
    expect(sent.temperature).toBe(0.2);
    expect(session.mock.hits[0]?.path).toBe('/v1/chat/completions');
    expect(session.mock.hits[0]?.authorization).toBe(`Bearer ${PRIVATE_KEY}`);
    expect(session.mock.hits.some((hit) => hit.path.includes('health') || hit.path.includes('admin'))).toBe(false);

    const visible = await fetch(`${session.app.baseURL}/models`, { headers });
    expect(visible.status).toBe(200);
    const models = await visible.json() as { data?: Array<{ id?: string }> };
    expect(models.data?.some((item) => item.id === 'dgx-chat')).toBe(true);
    expect(session.mock.hits).toHaveLength(1);

    const upstream = await listPrivateModels({
      runtimePool: session.app.runtimePool,
      store: credentialStore(),
      tenantId: session.tenant.tenantId,
      deployment: 'dgx-chat',
      fetchImpl: session.bridge.fetch,
      resolveHost: pinResolver(PRIVATE_PIN),
    });
    expect(upstream.models).toEqual(['private-model']);
    expect(session.mock.hits.map((hit) => hit.path)).toContain('/v1/models');
    const modelHit = session.bridge.hits.find((hit) => hit.url.endsWith('/models'));
    expect(modelHit?.url).toBe(`${PRIVATE_ENDPOINT}/models`);
    expect(modelHit?.authorization).toBe(`Bearer ${PRIVATE_KEY}`);
    expect(modelHit?.method).toBe('GET');

    const stored = await attempts(session.admin, session.tenant.tenantId);
    expect(stored).toMatchObject([
      {
        status: 'succeeded',
        upstream_model: UPSTREAM_MODEL,
        serving_model: 'private-model-actual',
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 40,
        stream_status: null,
      },
    ]);
    await session.close();
  });

  it('ends a stream and a delayed first token with one DONE marker', async () => {
    const session = await openSession({ name: 'Private Stream', streaming: true });
    runCli(db, ['set-deployment-enabled', '--tenant-id', session.tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    const streamed = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'scene-stream' }],
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain('private-ok');
    expect(text).toContain('private-model-actual');
    expect(text).toContain('"prompt_tokens":11');
    expect(doneCount(text)).toBe(1);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    const outbound = JSON.parse(session.bridge.hits[0]?.body ?? '{}') as { model?: string; stream?: boolean };
    expect(outbound.model).toBe(UPSTREAM_MODEL);
    expect(outbound.stream).toBe(true);
    expect(session.bridge.hits[0]?.url).toBe(`${PRIVATE_ENDPOINT}/chat/completions`);
    expect(session.bridge.hits[0]?.authorization).toBe(`Bearer ${PRIVATE_KEY}`);

    const started = Date.now();
    const delayed = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      stream: true,
      messages: [{ role: 'user', content: 'scene-delay' }],
    });
    const delayedText = await delayed.text();
    expect(delayed.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(delayedText).toContain('private-ok');
    expect(doneCount(delayedText)).toBe(1);
    expect(delayedText.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(session.bridge.hits).toHaveLength(2);
    expect(session.mock.hits).toHaveLength(2);
    const stored = await attempts(session.admin, session.tenant.tenantId);
    expect(stored.map((row) => row.stream_status)).toEqual(['completed', 'completed']);
    await session.close();
  });

  it('normalizes malformed SSE, missing usage, timeout, refusal, 429, and 5xx without a second call', async () => {
    const session = await openSession({ name: 'Private Errors', timeoutMs: 800, streaming: true });
    runCli(db, ['set-deployment-enabled', '--tenant-id', session.tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());

    const malformed = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      stream: true,
      messages: [{ role: 'user', content: 'scene-bad' }],
    });
    const malformedText = await malformed.text();
    expect(malformed.status).toBe(200);
    expect(doneCount(malformedText)).toBe(0);
    expect(malformedText).not.toContain('[DONE]');
    const malformedRow = await waitStatus(session.admin, session.tenant.tenantId, 'provider_failed');
    expect(malformedRow.error_code).toBe('invalid_upstream_response');
    expect(session.bridge.hits).toHaveLength(1);

    const missing = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-nousage' }],
    });
    const missingBody = await missing.json() as { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
    expect(missing.status).toBe(200);
    expect(missingBody.usage).toBeUndefined();
    expect(missingBody.choices?.[0]?.message?.content).toBe('private-ok');
    const missingRow = (await attempts(session.admin, session.tenant.tenantId)).at(-1);
    expect(missingRow).toMatchObject({
      status: 'succeeded',
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
    });
    expect(session.bridge.hits).toHaveLength(2);

    const beforeTimeout = session.bridge.hits.length;
    const timed = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-timeout' }],
    });
    const timedBody = await timed.json() as { error?: { code?: string; message?: string } };
    expect(timed.status).toBe(504);
    expect(timedBody.error?.code).toBe('timeout');
    expect(timedBody.error?.message).not.toContain(PRIVATE_KEY);
    expect(session.bridge.hits).toHaveLength(beforeTimeout + 1);

    const beforeRefuse = session.bridge.hits.length;
    const beforeMock = session.mock.hits.length;
    const refused = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-refuse' }],
    });
    const refusedBody = await refused.json() as { error?: { code?: string; message?: string } };
    expect(refused.status).toBe(502);
    expect(refusedBody.error?.code).toBe('upstream_error');
    expect(refusedBody.error?.message).not.toContain(PRIVATE_KEY);
    expect(session.bridge.hits).toHaveLength(beforeRefuse + 1);
    expect(session.mock.hits).toHaveLength(beforeMock);

    const beforeRate = session.bridge.hits.length;
    const limited = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-rate' }],
    });
    const limitedText = await limited.text();
    expect(limited.status).toBe(429);
    expect(limitedText).toContain('rate_limit');
    expect(limitedText).not.toContain(SECRET);
    expect(limitedText).not.toContain(PRIVATE_KEY);
    expect(session.bridge.hits).toHaveLength(beforeRate + 1);

    const beforeDown = session.bridge.hits.length;
    const failed = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-down' }],
    });
    const failedText = await failed.text();
    expect(failed.status).toBe(502);
    expect(failedText).toContain('upstream_error');
    expect(failedText).not.toContain(SECRET);
    expect(failedText).not.toContain(PRIVATE_KEY);
    expect(session.bridge.hits).toHaveLength(beforeDown + 1);
    expect(session.mock.hits.filter((hit) => hit.body.includes('scene-rate') || hit.body.includes('scene-down'))).toHaveLength(2);
    await session.close();
  });

  it('omits DONE when the caller cancels or the consumer stalls', async () => {
    const session = await openSession({
      name: 'Private Cancel',
      timeoutMs: 15000,
      streaming: true,
      backpressureTimeoutMs: 300,
    });
    runCli(db, ['set-deployment-enabled', '--tenant-id', session.tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    const controller = new AbortController();
    const pending = postChat(
      session.app.baseURL,
      session.tenant.tenantId,
      session.tenant.secret,
      { model: 'dgx-chat', stream: true, messages: [{ role: 'user', content: 'scene-cancel' }] },
      controller.signal,
    );
    await session.mock.waitFor('cancel');
    controller.abort();
    await expect(pending).rejects.toThrow();
    const cancelled = await waitStatus(session.admin, session.tenant.tenantId, 'client_aborted');
    expect(cancelled.error_code).toBe('request_cancelled');
    expect(cancelled.chunk_count).toBe(0);
    expect(session.bridge.hits).toHaveLength(1);

    const payload = JSON.stringify({
      model: 'dgx-chat',
      stream: true,
      messages: [{ role: 'user', content: 'scene-pressure' }],
    });
    const stalled = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: session.app.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-tenant-id': session.tenant.tenantId,
            authorization: `Bearer ${session.tenant.secret}`,
          },
        },
        (res) => {
          res.pause();
          void waitStatus(session.admin, session.tenant.tenantId, 'slow_consumer')
            .then(() => {
              const parts: Buffer[] = [];
              res.resume();
              res.on('data', (chunk: Buffer) => parts.push(chunk));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
            })
            .catch(reject);
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    expect(stalled.status).toBe(200);
    expect(doneCount(stalled.raw)).toBe(0);
    expect(stalled.raw).not.toContain('[DONE]');
    expect(session.bridge.hits).toHaveLength(2);
    const row = await waitStatus(session.admin, session.tenant.tenantId, 'slow_consumer');
    expect(row.error_code).toBe('slow_consumer');
    expect(stalled.raw).not.toContain(PRIVATE_KEY);
    await session.close();
  });

  it('records validated_mock and rejects validated_live', async () => {
    const session = await openSession({ name: 'Private Mock Status' });
    runCli(db, ['set-deployment-enabled', '--tenant-id', session.tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    const response = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(response.status).toBe(200);
    const marked = runCli(
      db,
      ['validate-deployment', '--tenant-id', session.tenant.tenantId, '--deployment', 'dgx-chat', '--status', 'validated_mock'],
      cliEnv(),
    ) as unknown as { validationStatus?: string };
    expect(marked.validationStatus).toBe('validated_mock');
    const live = spawnSync(
      process.execPath,
      [cliEntry, 'validate-deployment', '--tenant-id', session.tenant.tenantId, '--deployment', 'dgx-chat', '--status', 'validated_live'],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(live.status).not.toBe(0);
    expect(`${live.stderr}`).toContain('validation status is not available');
    const stored = await session.admin.query<{ validation_status: string }>(
      `SELECT validation_status FROM model_deployments WHERE tenant_id = $1 AND name = 'dgx-chat'`,
      [session.tenant.tenantId],
    );
    expect(stored.rows[0]?.validation_status).toBe('validated_mock');
    expect(session.bridge.hits).toHaveLength(1);
    const unused: PrivateHit[] = session.bridge.hits;
    expect(unused[0]?.url.startsWith(`https://${PRIVATE_HOST}:`)).toBe(true);
    await session.close();
  });
});
