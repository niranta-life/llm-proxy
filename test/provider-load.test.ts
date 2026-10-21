import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTestDatabase } from './helpers.js';
import { chatPayload, enableStreaming, provisionTenant, registerInference } from './inference-support.js';
import {
  TIMEOUT_MS,
  UPSTREAM,
  chat,
  doneCount,
  grewOnly,
  listenProxy,
  openDb,
  openPost,
  registerSix,
  snapshot,
  startDoubles,
  vertexKey,
  waitFor,
  type Doubles,
  type ProviderName,
  type SixKeys,
  type SixNames,
  defaultNames,
} from './hardening-support.js';

const PROVIDERS = Object.keys(UPSTREAM) as ProviderName[];
const CONTENT: Record<ProviderName, string> = {
  openai: 'openai-ok',
  anthropic: 'claude-ok',
  vertex: 'vertex-ok',
  xai: 'xai-ok',
  openrouter: 'router-ok',
  dgx: 'private-ok',
};

describe('provider load, failure, and shutdown', () => {
  const db = loadTestDatabase();
  const names: SixNames = defaultNames('load');
  const email = 'load-bot@load-vertex-proj.iam.gserviceaccount.com';
  const keys: SixKeys = {
    openai: 'sk-load-openai-key1',
    anthropic: 'sk-ant-load-key1',
    vertexEmail: email,
    vertexKey: vertexKey(email),
    vertexProject: 'load-vertex-proj',
    xai: 'xai-load-key-123456',
    openrouter: 'or-load-key-1234567',
    dgx: 'dgx-load-key-123456',
  };
  const tenant = { tenantId: '', secret: '' };
  let doubles: Doubles;
  let port = 0;
  let app: Awaited<ReturnType<typeof listenProxy>>['app'];
  let closeApp: () => Promise<void> = async () => undefined;
  let admin: ReturnType<typeof openDb>;

  beforeAll(async () => {
    doubles = await startDoubles();
    const created = provisionTenant(db, 'Load Tenant');
    tenant.tenantId = created.tenantId;
    tenant.secret = created.secret;
    registerSix(db, tenant.tenantId, names, keys, doubles.anthropicOrigin);
    const listened = await listenProxy(db, doubles);
    port = listened.port;
    app = listened.app;
    closeApp = listened.close;
    admin = openDb(db);
  }, 180_000);

  afterAll(async () => {
    await closeApp();
    await admin.end();
    await doubles.close();
  });

  it('keeps concurrent chats on the selected provider', async () => {
    const started = performance.now();
    const results = await Promise.all(
      PROVIDERS.flatMap((provider) =>
        [1, 2].map(async (copy) => {
          const callStarted = performance.now();
          const response = await chat(port, tenant.tenantId, tenant.secret, {
            model: names[provider],
            messages: [{ role: 'user', content: 'ok' }],
          });
          const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
          return {
            provider,
            copy,
            status: response.status,
            content: body.choices?.[0]?.message?.content ?? '',
            ms: Math.round(performance.now() - callStarted),
          };
        }),
      ),
    );
    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.content).toBe(CONTENT[result.provider]);
    }
    const rows = await admin.query<{ provider: string; upstream_model: string; requests: number }>(
      `SELECT c.provider, a.upstream_model, count(*)::int AS requests
       FROM model_attempts a
       JOIN model_deployments d ON d.id = a.deployment_id AND d.tenant_id = a.tenant_id
       JOIN provider_connections c ON c.id = d.connection_id AND c.tenant_id = d.tenant_id
       WHERE a.tenant_id = $1
       GROUP BY c.provider, a.upstream_model
       ORDER BY c.provider`,
      [tenant.tenantId],
    );
    expect(rows.rows).toHaveLength(6);
    for (const row of rows.rows) {
      expect(row.requests).toBe(2);
      expect(row.upstream_model).toBe(UPSTREAM[row.provider as ProviderName]);
    }
    const elapsed = Math.round(performance.now() - started);
    console.log(JSON.stringify({
      load: {
        requests: results.length,
        ok: results.filter((item) => item.status === 200).length,
        elapsedMs: elapsed,
        maxMs: Math.max(...results.map((item) => item.ms)),
        perProvider: Object.fromEntries(
          PROVIDERS.map((provider) => [
            provider,
            {
              requests: results.filter((item) => item.provider === provider).length,
              maxMs: Math.max(...results.filter((item) => item.provider === provider).map((item) => item.ms)),
            },
          ]),
        ),
      },
    }));
  });

  it('reports a connection failure without calling another provider', async () => {
    const before = snapshot(doubles);
    const started = performance.now();
    const failed = await chat(port, tenant.tenantId, tenant.secret, {
      model: names.xai,
      messages: [{ role: 'user', content: 'refuse' }],
    });
    const body = (await failed.json()) as { error?: { code?: string } };
    expect(failed.status).toBe(502);
    expect(body.error?.code).toBe('upstream_error');
    expect(grewOnly(before, snapshot(doubles), 'xai')).toBe(true);
    const recovered = await chat(port, tenant.tenantId, tenant.secret, {
      model: names.openai,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content).toBe('openai-ok');
    console.log(JSON.stringify({
      connectionFailure: { provider: 'xai', status: failed.status, code: body.error?.code, ms: Math.round(performance.now() - started) },
    }));
  });

  it('ends a cancelled stream without DONE', async () => {
    const before = snapshot(doubles);
    const pending = openPost(
      port,
      tenant.tenantId,
      tenant.secret,
      chatPayload(names.openai, 'cancel', { stream: true }),
    );
    await waitFor(async () => snapshot(doubles).openai === before.openai + 1, 'load cancel hit');
    pending.destroy();
    const body = await pending.settled;
    expect(doneCount(body.raw)).toBe(0);
    expect(body.raw.includes('[DONE]')).toBe(false);
    await waitFor(async () => {
      const row = await admin.query<{ stream_status: string | null }>(
        `SELECT stream_status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenant.tenantId],
      );
      return row.rows[0]?.stream_status === 'client_aborted';
    }, 'load cancel stored');
    expect(grewOnly(before, snapshot(doubles), 'openai')).toBe(true);
    console.log(JSON.stringify({ streamTermination: { done: doneCount(body.raw), provider: 'openai' } }));
  });

  it('drains an open stream without a false DONE', async () => {
    const shutdownTenant = provisionTenant(db, 'Shutdown Tenant');
    registerInference(db, {
      tenantId: shutdownTenant.tenantId,
      apiKey: 'sk-load-shutdown-key',
      deployment: 'drain-chat',
      upstreamModel: UPSTREAM.openai,
      timeoutMs: TIMEOUT_MS,
    });
    enableStreaming(db, {
      tenantId: shutdownTenant.tenantId,
      deployment: 'drain-chat',
      connectTimeoutMs: 15_000,
      idleTimeoutMs: 15_000,
      totalTimeoutMs: 15_000,
    });
    const started = new Date();
    const finish = openPost(
      port,
      shutdownTenant.tenantId,
      shutdownTenant.secret,
      chatPayload('drain-chat', 'finish-in-drain', { stream: true }),
    );
    const hold = openPost(
      port,
      shutdownTenant.tenantId,
      shutdownTenant.secret,
      chatPayload('drain-chat', 'hold-open', { stream: true }),
    );
    await waitFor(async () => {
      const rows = await admin.query(
        `SELECT stream_status FROM model_attempts
         WHERE tenant_id = $1 AND created_at >= $2 AND stream_status = 'streaming'`,
        [shutdownTenant.tenantId, started],
      );
      return (rows.rowCount ?? 0) >= 2;
    }, 'shutdown streams');
    const hitsBefore = doubles.openaiHits.length;
    const draining = app.drainStreams(1_500);
    doubles.releaseFinish();
    const drained = await draining;
    const finished = await finish.settled;
    const held = await hold.settled;
    expect(doneCount(finished.raw)).toBe(1);
    expect(doneCount(held.raw)).toBe(0);
    expect(held.raw.includes('[DONE]')).toBe(false);
    expect(drained.activeAfter).toBe(0);
    const rows = await admin.query<{ stream_status: string; status: string; error_code: string | null }>(
      `SELECT stream_status, status, error_code
       FROM model_attempts
       WHERE tenant_id = $1 AND created_at >= $2`,
      [shutdownTenant.tenantId, started],
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream_status: 'completed', status: 'succeeded', error_code: null }),
        expect.objectContaining({ stream_status: 'interrupted', status: 'failed', error_code: 'interrupted' }),
      ]),
    );
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': shutdownTenant.tenantId,
        authorization: `Bearer ${shutdownTenant.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('drain-chat', 'after-shutdown', { stream: true }),
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe('shutting_down');
    expect(doubles.openaiHits).toHaveLength(hitsBefore);
    console.log(JSON.stringify({
      shutdown: {
        activeAfter: drained.activeAfter,
        aborted: drained.aborted,
        finishDone: doneCount(finished.raw),
        holdDone: doneCount(held.raw),
        interrupted: rows.rows.filter((row) => row.stream_status === 'interrupted').length,
      },
    }));
  });
});
