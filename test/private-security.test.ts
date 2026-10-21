import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import { probePrivateHealth } from '../src/inference/private-serve.js';
import { createPrivateFetch, decidePrivateChat, normalizeApproval } from '../src/inference/private.js';
import { cliEntry, loadTestDatabase, projectRoot, runCli, serviceEnv } from './helpers.js';
import { cliEnv } from './inference-support.js';
import { startPrivateMock } from './mock-private.js';
import {
  PRIVATE_ENDPOINT,
  PRIVATE_HOST,
  PRIVATE_KEY,
  PRIVATE_PIN,
  PRIVATE_PORT,
  bridgePrivateMock,
  closedPort,
  credentialStore,
  listenPrivate,
  pinResolver,
  postChat,
  provision,
  registerPrivate,
  streamOn,
} from './private-support.js';

describe('private endpoint security', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  async function openApproved(name: string, concurrency?: number) {
    const tenant = provision(db, name);
    registerPrivate(db, { tenantId: tenant.tenantId, concurrency });
    runCli(db, ['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    const mock = await startPrivateMock();
    const bridge = bridgePrivateMock(mock, await closedPort());
    const app = await listenPrivate(db, bridge.fetch, pinResolver(PRIVATE_PIN));
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      await mock.close();
    };
    closers.push(close);
    return { tenant, mock, bridge, app, close };
  }

  it('rejects a caller endpoint before any upstream call', async () => {
    const session = await openApproved('Private Caller Url');
    for (const extra of [
      { endpoint: 'https://evil.example/v1' },
      { base_url: 'https://evil.example/v1' },
      { health_endpoint: 'https://evil.example/health' },
    ]) {
      const response = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
        model: 'dgx-chat',
        messages: [{ role: 'user', content: 'scene-text' }],
        ...extra,
      });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('unknown_parameter');
      expect(text).not.toContain(PRIVATE_KEY);
    }
    expect(session.bridge.hits).toHaveLength(0);
    expect(session.mock.hits).toHaveLength(0);
    await session.close();
  });

  it('does not resolve or contact a host that the tenant has not approved', async () => {
    const tenant = provision(db, 'Private Unapproved');
    registerPrivate(db, { tenantId: tenant.tenantId, approve: false, enabled: true });
    streamOn(db, tenant.tenantId);
    const seen: string[] = [];
    const mock = await startPrivateMock();
    const bridge = bridgePrivateMock(mock, await closedPort());
    const app = await listenPrivate(db, bridge.fetch, async (host) => {
      seen.push(host);
      return [PRIVATE_PIN];
    });
    closers.push(async () => {
      await app.close();
      await mock.close();
    });
    const chat = await postChat(app.baseURL, tenant.tenantId, tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(chat.status).toBe(503);
    const streamed = await postChat(app.baseURL, tenant.tenantId, tenant.secret, {
      model: 'dgx-chat',
      stream: true,
      messages: [{ role: 'user', content: 'scene-stream' }],
    });
    expect(streamed.status).toBe(503);
    expect(await streamed.text()).not.toContain('[DONE]');
    expect(seen).toEqual([]);
    expect(bridge.hits).toHaveLength(0);
    expect(mock.hits).toHaveLength(0);
    await app.close();
    await mock.close();
  });

  it('does not follow a DNS rebind or a redirect', async () => {
    const tenant = provision(db, 'Private Rebind');
    registerPrivate(db, { tenantId: tenant.tenantId });
    runCli(db, ['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    const seen: string[] = [];
    const mock = await startPrivateMock();
    const bridge = bridgePrivateMock(mock, await closedPort());
    const app = await listenPrivate(db, bridge.fetch, async (host) => {
      seen.push(host);
      return ['203.0.113.9'];
    });
    closers.push(async () => {
      await app.close();
      await mock.close();
    });
    const rebound = await postChat(app.baseURL, tenant.tenantId, tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(rebound.status).toBe(503);
    expect(seen).toEqual([PRIVATE_HOST]);
    expect(bridge.hits).toHaveLength(0);
    expect(mock.hits).toHaveLength(0);
    await app.close();

    const allowed = await listenPrivate(db, bridge.fetch, pinResolver(PRIVATE_PIN));
    closers.push(() => allowed.close());
    const redirected = await postChat(allowed.baseURL, tenant.tenantId, tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-redirect' }],
    });
    const redirectedText = await redirected.text();
    expect(redirected.status).toBe(502);
    expect(redirectedText).toContain('endpoint_redirect');
    expect(redirectedText).not.toContain('evil.example');
    expect(redirectedText).not.toContain('redirect-secret-token');
    expect(redirectedText).not.toContain(PRIVATE_KEY);
    expect(mock.hits).toHaveLength(1);
    expect(mock.hits[0]?.path).toBe('/v1/chat/completions');
    expect(bridge.hits).toHaveLength(1);
    expect(bridge.hits[0]?.redirect).toBe('manual');
    await allowed.close();
    await mock.close();
  });

  it('keeps TLS verification on and blocks management and health paths from chat', async () => {
    const session = await openApproved('Private Tls');
    const response = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(PRIVATE_KEY);
    const hit = session.bridge.hits[0];
    expect(hit?.rejectUnauthorized).toBe(true);
    expect(hit?.servername).toBe(PRIVATE_HOST);
    expect(hit?.redirect).toBe('manual');
    const pinned = await new Promise<Array<{ address?: string }>>((resolve, reject) => {
      hit?.lookup?.(PRIVATE_HOST, { all: true }, (error, value) => {
        if (error) reject(error);
        else resolve(Array.isArray(value) ? value as Array<{ address?: string }> : []);
      });
    });
    expect(pinned.map((record) => record.address)).toEqual([PRIVATE_PIN]);
    const wrong = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      hit?.lookup?.('evil.example', {}, (error) => resolve(error));
    });
    expect(wrong).not.toBeNull();

    const decision = decidePrivateChat({
      storedEndpoint: PRIVATE_ENDPOINT,
      approval: {
        host: PRIVATE_HOST,
        port: PRIVATE_PORT,
        addresses: [PRIVATE_PIN],
        tlsVerify: true,
        healthEndpoint: `https://${PRIVATE_HOST}:${PRIVATE_PORT}/health`,
      },
      resolvedAddresses: [PRIVATE_PIN],
    });
    expect(decision.rejectUnauthorized).toBe(true);
    let inner = 0;
    const serving = createPrivateFetch({
      decision,
      mode: 'serving',
      fetchImpl: async () => {
        inner += 1;
        return new Response('no');
      },
    });
    await expect(serving.fetch(`${PRIVATE_ENDPOINT}/admin`)).rejects.toMatchObject({ status: 503 });
    await expect(serving.fetch(`${PRIVATE_ENDPOINT.replace('/v1', '')}/metrics`)).rejects.toMatchObject({ status: 503 });
    await expect(serving.fetch(`https://${PRIVATE_HOST}:${PRIVATE_PORT}/health`)).rejects.toMatchObject({ status: 503 });
    const health = createPrivateFetch({
      decision,
      mode: 'health',
      fetchImpl: async () => {
        inner += 1;
        return new Response('no');
      },
    });
    await expect(health.fetch(`${PRIVATE_ENDPOINT}/chat/completions`)).rejects.toMatchObject({ status: 503 });
    await expect(health.fetch(`${PRIVATE_ENDPOINT}/models`)).rejects.toMatchObject({ status: 503 });
    expect(inner).toBe(0);
    await serving.close();
    await health.close();
    expect(() => normalizeApproval({
      host: PRIVATE_HOST,
      port: PRIVATE_PORT,
      addresses: [PRIVATE_PIN],
      tlsVerify: false,
      healthEndpoint: null,
    })).toThrow(/tls verification is required/);
    await session.close();
  });

  it('rejects disabled TLS on a production host through the operator command', async () => {
    const tenant = provision(db, 'Private Tls Required');
    const result = spawnSync(
      process.execPath,
      [
        cliEntry,
        'approve-private-endpoint',
        '--tenant-id',
        tenant.tenantId,
        '--host',
        PRIVATE_HOST,
        '--port',
        String(PRIVATE_PORT),
        '--addresses',
        PRIVATE_PIN,
        '--tls-verify',
        'false',
      ],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}`).toContain('tls verification is required');
  });

  it('uses the stored health endpoint only for an operator probe and hides the credential', async () => {
    const session = await openApproved('Private Health');
    const chat = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    const chatText = await chat.text();
    expect(chat.status).toBe(200);
    expect(session.mock.hits.map((hit) => hit.path)).toEqual(['/v1/chat/completions']);
    const probed = await probePrivateHealth({
      runtimePool: session.app.runtimePool,
      store: credentialStore(),
      tenantId: session.tenant.tenantId,
      deployment: 'dgx-chat',
      fetchImpl: session.bridge.fetch,
      resolveHost: pinResolver(PRIVATE_PIN),
    });
    expect(probed.status).toBe(200);
    expect(session.mock.hits.map((hit) => hit.path)).toEqual(['/v1/chat/completions', '/health']);
    const healthHit = session.bridge.hits.find((hit) => hit.url.endsWith('/health'));
    expect(healthHit?.url).toBe(`https://${PRIVATE_HOST}:${PRIVATE_PORT}/health`);
    expect(healthHit?.authorization).toBe(`Bearer ${PRIVATE_KEY}`);
    expect(session.mock.hits.every((hit) => hit.path === '/v1/chat/completions' || hit.path === '/health' || hit.path === '/v1/models')).toBe(true);

    const listing = runCli(db, ['list-inference', '--tenant-id', session.tenant.tenantId], cliEnv());
    const listed = JSON.stringify(listing);
    expect(listed).not.toContain(PRIVATE_KEY);
    expect(listed).toContain(PRIVATE_HOST);
    expect(chatText).not.toContain(PRIVATE_KEY);
    expect(session.app.lines.join('\n')).not.toContain(PRIVATE_KEY);
    await session.close();
  });

  it('isolates tenant endpoints and credentials', async () => {
    const alpha = provision(db, 'Private Alpha');
    const beta = provision(db, 'Private Beta');
    const alphaKey = PRIVATE_KEY;
    const betaKey = 'dgx-beta-isolation-key';
    registerPrivate(db, { tenantId: alpha.tenantId, apiKey: alphaKey });
    runCli(
      db,
      ['register-deployment', '--tenant-id', alpha.tenantId, '--provider', 'dgx', '--name', 'alpha-only', '--upstream-model', 'alpha-model', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'],
      cliEnv(),
    );
    runCli(db, ['set-deployment-enabled', '--tenant-id', alpha.tenantId, '--name', 'dgx-chat', '--enabled', 'true'], cliEnv());
    registerPrivate(db, {
      tenantId: beta.tenantId,
      apiKey: betaKey,
      approve: false,
      enabled: true,
    });
    const mock = await startPrivateMock();
    const refused = await closedPort();
    const alphaBridge = bridgePrivateMock(mock, refused);
    const betaSeen: string[] = [];
    const betaBridge = bridgePrivateMock(mock, refused);
    const alphaApp = await listenPrivate(db, alphaBridge.fetch, pinResolver(PRIVATE_PIN));
    const betaApp = await listenPrivate(db, betaBridge.fetch, async (host) => {
      betaSeen.push(host);
      return [PRIVATE_PIN];
    });
    closers.push(async () => {
      await alphaApp.close();
      await betaApp.close();
      await mock.close();
    });

    const denied = await postChat(betaApp.baseURL, beta.tenantId, beta.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(denied.status).toBe(503);
    expect(betaSeen).toEqual([]);
    expect(betaBridge.hits).toHaveLength(0);
    expect(mock.hits).toHaveLength(0);

    runCli(
      db,
      ['approve-private-endpoint', '--tenant-id', beta.tenantId, '--host', PRIVATE_HOST, '--port', String(PRIVATE_PORT), '--addresses', PRIVATE_PIN, '--tls-verify', 'true'],
      cliEnv(),
    );
    const alphaChat = await postChat(alphaApp.baseURL, alpha.tenantId, alpha.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(alphaChat.status).toBe(200);
    const foreign = await postChat(betaApp.baseURL, beta.tenantId, beta.secret, {
      model: 'alpha-only',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(foreign.status).toBe(404);
    const betaChat = await postChat(betaApp.baseURL, beta.tenantId, beta.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-text' }],
    });
    expect(betaChat.status).toBe(200);
    expect(alphaBridge.hits.map((hit) => hit.authorization)).toEqual([`Bearer ${alphaKey}`]);
    expect(betaBridge.hits.map((hit) => hit.authorization)).toEqual([`Bearer ${betaKey}`]);
    expect(alphaBridge.hits[0]?.url.startsWith(`https://${PRIVATE_HOST}:`)).toBe(true);
    expect(JSON.stringify(alphaBridge.hits)).not.toContain(betaKey);
    expect(JSON.stringify(betaBridge.hits)).not.toContain(alphaKey);
    expect(await alphaChat.text()).not.toContain(alphaKey);
    expect(await betaChat.text()).not.toContain(betaKey);
    expect(alphaApp.lines.join('\n')).not.toContain(alphaKey);
    expect(betaApp.lines.join('\n')).not.toContain(betaKey);

    const alphaList = JSON.stringify(runCli(db, ['list-inference', '--tenant-id', alpha.tenantId], cliEnv()));
    const betaList = JSON.stringify(runCli(db, ['list-inference', '--tenant-id', beta.tenantId], cliEnv()));
    expect(alphaList).not.toContain(betaKey);
    expect(betaList).not.toContain(alphaKey);
    expect(betaList).not.toContain('alpha-only');

    await withTenant(alphaApp.runtimePool, beta.tenantId, async (client) => {
      const rows = await client.query<{ host: string }>('SELECT host FROM private_endpoint_allowlist');
      expect(rows.rows).toHaveLength(1);
    });
    await withTenant(alphaApp.runtimePool, alpha.tenantId, async (client) => {
      const rows = await client.query<{ host: string }>('SELECT host FROM private_endpoint_allowlist');
      expect(rows.rows).toEqual([{ host: PRIVATE_HOST }]);
      const foreignRows = await client.query('SELECT id FROM model_deployments WHERE name = $1 AND tenant_id = $2', ['alpha-only', beta.tenantId]);
      expect(foreignRows.rows).toHaveLength(0);
    });
    await alphaApp.close();
    await betaApp.close();
    await mock.close();
  });

  it('stops an extra request at the concurrency limit before upstream work', async () => {
    const session = await openApproved('Private Concurrency', 1);
    const first = postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-hold' }],
    });
    await session.mock.waitFor('hold');
    const second = await postChat(session.app.baseURL, session.tenant.tenantId, session.tenant.secret, {
      model: 'dgx-chat',
      messages: [{ role: 'user', content: 'scene-second' }],
    });
    const secondText = await second.text();
    expect(second.status).toBe(429);
    expect(secondText).toContain('concurrency_limit');
    expect(secondText).not.toContain(PRIVATE_KEY);
    expect(session.bridge.hits).toHaveLength(1);
    expect(session.mock.hits).toHaveLength(1);
    expect(session.mock.hits.some((hit) => hit.body.includes('scene-second'))).toBe(false);
    session.mock.release('hold');
    const completed = await first;
    expect(completed.status).toBe(200);
    expect(session.bridge.hits).toHaveLength(1);
    expect(session.mock.hits).toHaveLength(1);
    await session.close();
  });
});
