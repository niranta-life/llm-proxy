import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { classifyBreakerOutcome, decideAdmission, decideTransition } from '../src/inference/breaker.js';
import { createTestApp, freePort, loadTestDatabase, projectRoot, runCli, serviceEnv } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  credentialKeyText,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const ORIGIN = Date.parse('2026-01-15T00:00:00.000Z');
const WINDOW_MS = 60_000;
const MIN_SAMPLES = 3;
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 10_000;
const MAX_PROBES = 1;

type Mode =
  | { type: 'ok' }
  | { type: 'status'; status: number }
  | { type: 'hang' }
  | { type: 'hold' };

type BreakerBody = {
  deployment: string;
  enabled: boolean;
  state: string;
  reason: string;
  changedAt: string | null;
  samples: number;
  failures: number;
  rateLimits: number;
  probesInflight: number;
};

type DeploymentRow = {
  id: string;
  enabled: boolean;
  health_status: string;
  config_version: number;
  alias_deployment_id: string | null;
};

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

function trace(name: string, fields: Record<string, unknown>): void {
  console.log(`BREAKER_CASE ${JSON.stringify({ case: name, ...fields })}`);
}

describe('breaker decisions', () => {
  it('keeps caller failures and rate limits out of the health count', () => {
    expect(classifyBreakerOutcome({ succeeded: true, callerAborted: false, failureClass: null })).toBe('success');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: true, failureClass: 'timeout_after_dispatch' })).toBe('ignore');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: 'cancelled' })).toBe('ignore');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: 'stream_started' })).toBe('ignore');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: 'rate_limit' })).toBe('rate_limit');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: 'client_error' })).toBe('ignore');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: 'unauthorized' })).toBe('ignore');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: 'ambiguous_network' })).toBe('ignore');
    expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass: null })).toBe('ignore');
    for (const failureClass of ['timeout_before_dispatch', 'timeout_after_dispatch', 'total_deadline', 'connection_failure', 'unavailable', 'upstream_error']) {
      expect(classifyBreakerOutcome({ succeeded: false, callerAborted: false, failureClass })).toBe('failure');
    }
  });

  it('admits a closed breaker and claims one probe after cooldown', () => {
    expect(decideAdmission(null, ORIGIN)).toBe('skip');
    expect(decideAdmission({
      enabled: false,
      state: 'open',
      cooldownUntilMs: ORIGIN + COOLDOWN_MS,
      probesInflight: 0,
      maxProbes: 1,
    }, ORIGIN)).toBe('skip');
    expect(decideAdmission({
      enabled: true,
      state: 'closed',
      cooldownUntilMs: null,
      probesInflight: 0,
      maxProbes: 1,
    }, ORIGIN)).toBe('allow');
    expect(decideAdmission({
      enabled: true,
      state: 'open',
      cooldownUntilMs: ORIGIN + COOLDOWN_MS,
      probesInflight: 0,
      maxProbes: 1,
    }, ORIGIN)).toBe('reject');
    expect(decideAdmission({
      enabled: true,
      state: 'open',
      cooldownUntilMs: ORIGIN + COOLDOWN_MS,
      probesInflight: 0,
      maxProbes: 1,
    }, ORIGIN + COOLDOWN_MS)).toBe('claim');
    expect(decideAdmission({
      enabled: true,
      state: 'half_open',
      cooldownUntilMs: null,
      probesInflight: 1,
      maxProbes: 1,
    }, ORIGIN + COOLDOWN_MS)).toBe('reject');
    expect(decideAdmission({
      enabled: true,
      state: 'half_open',
      cooldownUntilMs: null,
      probesInflight: 0,
      maxProbes: 1,
    }, ORIGIN + COOLDOWN_MS)).toBe('claim');
  });

  it('opens only after the sample threshold and closes only a half-open probe', () => {
    expect(decideTransition({
      state: 'closed',
      probe: false,
      kind: 'failure',
      samples: 2,
      failures: 2,
      minSamples: 3,
      failureThreshold: 2,
    })).toBe('record');
    expect(decideTransition({
      state: 'closed',
      probe: false,
      kind: 'failure',
      samples: 3,
      failures: 2,
      minSamples: 3,
      failureThreshold: 2,
    })).toBe('open');
    expect(decideTransition({
      state: 'closed',
      probe: false,
      kind: 'rate_limit',
      samples: 0,
      failures: 0,
      minSamples: 3,
      failureThreshold: 2,
    })).toBe('record');
    expect(decideTransition({
      state: 'half_open',
      probe: true,
      kind: 'success',
      samples: 1,
      failures: 0,
      minSamples: 3,
      failureThreshold: 2,
    })).toBe('close');
    expect(decideTransition({
      state: 'half_open',
      probe: true,
      kind: 'failure',
      samples: 1,
      failures: 1,
      minSamples: 3,
      failureThreshold: 2,
    })).toBe('reopen');
    expect(decideTransition({
      state: 'half_open',
      probe: true,
      kind: 'ignore',
      samples: 0,
      failures: 0,
      minSamples: 3,
      failureThreshold: 2,
    })).toBe('release');
  });
});

describe('provider circuit breaker', () => {
  const db = loadTestDatabase();
  const pools: Array<{ end: () => Promise<unknown> }> = [];
  const held: ServerResponse[] = [];
  const children = new Set<ChildProcess>();
  let mode: Mode = { type: 'ok' };
  let nowMs = ORIGIN;
  let onHang: (() => void) | undefined;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: pg.Pool;
  let tenant: ReturnType<typeof provisionTenant>;
  let other: ReturnType<typeof provisionTenant>;
  let listening = false;

  beforeAll(async () => {
    mock = await startMockUpstream((hit, request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string };
      if (mode.type === 'hold') {
        held.push(response);
        return;
      }
      if (mode.type === 'hang') {
        onHang?.();
        return;
      }
      if (mode.type === 'status') {
        response.writeHead(mode.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? 'gpt-test', 'ok')));
    });
    tenant = provisionTenant(db, 'Breaker Primary');
    other = provisionTenant(db, 'Breaker Other');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-breaker-primary',
      deployment: 'breaker-chat',
      upstreamModel: 'gpt-test',
    });
    registerDeployment('breaker-off', 5_000);
    registerDeployment('breaker-plain', 5_000);
    registerDeployment('breaker-slow', 300);
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-test-breaker-other',
      deployment: 'other-chat',
      upstreamModel: 'gpt-test',
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'breaker-chat' });
    runCli(db, [
      'set-deployment-enabled',
      '--tenant-id',
      tenant.tenantId,
      '--name',
      'breaker-off',
      '--enabled',
      'false',
    ], cliEnv());
    runCli(db, [
      'set-deployment-health',
      '--tenant-id',
      tenant.tenantId,
      '--deployment',
      'breaker-chat',
      '--status',
      'healthy',
    ], cliEnv());
    runCli(db, [
      'set-alias',
      '--tenant-id',
      tenant.tenantId,
      '--alias',
      'auto',
      '--deployment',
      'breaker-chat',
    ], cliEnv());
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      now: () => nowMs,
    });
    admin = adminPool(db);
    pools.push(ctx.authPool, ctx.runtimePool, admin);
  });

  beforeEach(() => {
    nowMs = ORIGIN;
    mode = { type: 'ok' };
    onHang = undefined;
    held.length = 0;
    mock.hits.length = 0;
    enableBreaker(tenant.tenantId, 'breaker-chat');
  });

  afterAll(async () => {
    releaseHeld();
    for (const child of children) child.kill('SIGKILL');
    await mock.close();
    await ctx.app.close();
    await Promise.all(pools.map((pool) => pool.end()));
  });

  function registerDeployment(name: string, timeoutMs: number): void {
    runCli(db, [
      'register-deployment',
      '--tenant-id',
      tenant.tenantId,
      '--name',
      name,
      '--upstream-model',
      'gpt-test',
      '--timeout-ms',
      String(timeoutMs),
      '--capabilities',
      'temperature',
      '--enabled',
      'true',
    ], cliEnv());
  }

  function enableBreaker(
    tenantId: string,
    deployment: string,
    settings: { min?: number; threshold?: number; cooldown?: number; probes?: number } = {},
  ): void {
    runCli(db, [
      'set-deployment-breaker',
      '--tenant-id',
      tenantId,
      '--deployment',
      deployment,
      '--enabled',
      'true',
      '--window-ms',
      String(WINDOW_MS),
      '--min-samples',
      String(settings.min ?? MIN_SAMPLES),
      '--failure-threshold',
      String(settings.threshold ?? FAILURE_THRESHOLD),
      '--cooldown-ms',
      String(settings.cooldown ?? COOLDOWN_MS),
      '--max-probes',
      String(settings.probes ?? MAX_PROBES),
    ], cliEnv());
  }

  function releaseHeld(): void {
    const pending = held.splice(0);
    for (const response of pending) {
      if (response.writableEnded) continue;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
    }
  }

  async function chat(
    caller: { tenantId: string; secret: string },
    model: string,
    content: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ status: number; code: string | null; hits: number }> {
    const before = mock.hits.length;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(caller.tenantId, caller.secret),
      payload: chatPayload(model, content, extra),
    });
    const body = response.json() as { error?: { code?: string } };
    return {
      status: response.statusCode,
      code: body.error?.code ?? null,
      hits: mock.hits.length - before,
    };
  }

  async function closedBaseUrl(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('closed port is missing');
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return `http://127.0.0.1:${port}/v1`;
  }

  async function withClosedApp<T>(run: (app: typeof ctx.app) => Promise<T>): Promise<T> {
    const closed = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: await closedBaseUrl(),
      credentialKey,
      now: () => nowMs,
    });
    pools.push(closed.authPool, closed.runtimePool);
    try {
      return await run(closed.app);
    } finally {
      await closed.app.close();
    }
  }

  async function closedChat(
    app: typeof ctx.app,
    content: string,
  ): Promise<{ status: number; code: string | null }> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: chatPayload('breaker-chat', content, { stream: true }),
    });
    const body = response.json() as { error?: { code?: string } };
    return { status: response.statusCode, code: body.error?.code ?? null };
  }

  async function latestAttempt(): Promise<{ failure_class: string | null; error_code: string | null }> {
    const stored = await admin.query<{ failure_class: string | null; error_code: string | null }>(
      `SELECT failure_class, error_code
       FROM model_attempts
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenant.tenantId],
    );
    return stored.rows[0] ?? { failure_class: null, error_code: null };
  }

  async function listenAddress(): Promise<string> {
    if (!listening) {
      const port = await freePort();
      await ctx.app.listen({ host: '127.0.0.1', port });
      listening = true;
    }
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('listen address is missing');
    return `http://127.0.0.1:${address.port}`;
  }

  async function inspect(caller: { tenantId: string; secret: string }, deployment: string): Promise<BreakerBody> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/breakers?deployment=${encodeURIComponent(deployment)}`,
      headers: authHeaders(caller.tenantId, caller.secret),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { breakers: BreakerBody[] };
    expect(body.breakers).toHaveLength(1);
    const row = body.breakers[0];
    if (row === undefined) throw new Error('breaker row is missing');
    return row;
  }

  async function deploymentRow(tenantId: string, name: string): Promise<DeploymentRow> {
    const result = await admin.query<DeploymentRow>(
      `SELECT d.id, d.enabled, d.health_status, d.config_version, a.deployment_id AS alias_deployment_id
       FROM model_deployments d
       LEFT JOIN model_aliases a ON a.tenant_id = d.tenant_id AND a.alias = 'auto'
       WHERE d.tenant_id = $1 AND d.name = $2`,
      [tenantId, name],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('deployment is missing');
    return row;
  }

  async function openMain(): Promise<BreakerBody> {
    mode = { type: 'status', status: 503 };
    for (let index = 0; index < MIN_SAMPLES; index += 1) {
      const result = await chat(tenant, 'breaker-chat', `open-${index}`);
      expect(result.hits).toBe(1);
    }
    mode = { type: 'ok' };
    const view = await inspect(tenant, 'breaker-chat');
    expect(view.state).toBe('open');
    expect(view.reason).toBe('failure_threshold');
    expect(view.changedAt).toBe(new Date(ORIGIN).toISOString());
    return view;
  }

  function spawnChat(at: number, content: string): Promise<{ status: number; code: string | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(projectRoot, 'test', 'breaker-child.mjs')], {
        cwd: projectRoot,
        env: serviceEnv(db, {
          INFERENCE_ENABLED: 'true',
          PROVIDER_CREDENTIAL_KEY: credentialKeyText,
          UPSTREAM_BASE_URL: mock.baseUrl,
          BREAKER_NOW_MS: String(at),
          TENANT_ID: tenant.tenantId,
          TENANT_SECRET: tenant.secret,
          CHAT_MODEL: 'breaker-chat',
          CHAT_CONTENT: content,
        }),
      });
      children.add(child);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child timed out: ${stderr}`));
      }, 20_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += String(chunk);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        children.delete(child);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        children.delete(child);
        if (code !== 0) {
          reject(new Error(`child exited ${code}: ${stderr}\n${stdout}`));
          return;
        }
        resolve(JSON.parse(stdout) as { status: number; code: string | null });
      });
    });
  }

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > 15_000) throw new Error(label);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('keeps a healthy provider closed', async () => {
    for (let index = 0; index < 3; index += 1) {
      const result = await chat(tenant, 'breaker-chat', `healthy-${index}`);
      expect(result.status).toBe(200);
      expect(result.hits).toBe(1);
    }
    const view = await inspect(tenant, 'breaker-chat');
    expect(view).toMatchObject({
      enabled: true,
      state: 'closed',
      reason: 'enabled',
      samples: 3,
      failures: 0,
      rateLimits: 0,
    });
    trace('healthy-closed', view);
  });

  it('does not open before the sample threshold', async () => {
    mode = { type: 'status', status: 503 };
    for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
      const result = await chat(tenant, 'breaker-chat', `short-${index}`);
      expect(result.hits).toBe(1);
      expect(result.status).not.toBe(200);
    }
    const view = await inspect(tenant, 'breaker-chat');
    expect(view.state).toBe('closed');
    expect(view.samples).toBe(FAILURE_THRESHOLD);
    expect(view.failures).toBe(FAILURE_THRESHOLD);
    expect(mock.hits).toHaveLength(FAILURE_THRESHOLD);
    trace('below-threshold', view);
  });

  it('opens after the configured sample threshold', async () => {
    const before = await deploymentRow(tenant.tenantId, 'breaker-chat');
    const view = await openMain();
    expect(view.failures).toBe(MIN_SAMPLES);
    expect(view.samples).toBe(MIN_SAMPLES);
    const after = await deploymentRow(tenant.tenantId, 'breaker-chat');
    expect(after.enabled).toBe(true);
    expect(after.health_status).toBe('healthy');
    expect(after.health_status).toBe(before.health_status);
    expect(after.config_version).toBe(before.config_version);
    expect(after.alias_deployment_id).toBe(before.id);
    const blocked = await chat(tenant, 'breaker-chat', 'blocked');
    const autoBlocked = await chat(tenant, 'auto', 'blocked-auto');
    const stream = await chat(tenant, 'breaker-chat', 'blocked-stream', { stream: true });
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    expect(autoBlocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    expect(stream).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    const stored = await admin.query<{ error_code: string; failure_class: string | null; dispatched: boolean }>(
      `SELECT error_code, failure_class, dispatched
       FROM model_attempts
       WHERE tenant_id = $1 AND error_code = 'circuit_open'
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenant.tenantId],
    );
    expect(stored.rows[0]).toMatchObject({ error_code: 'circuit_open', failure_class: null, dispatched: false });
    const still = await inspect(tenant, 'breaker-chat');
    expect(still.failures).toBe(view.failures);
    expect(still.samples).toBe(view.samples);
    trace('opened', {
      state: still.state,
      reason: still.reason,
      changedAt: still.changedAt,
      failures: still.failures,
      samples: still.samples,
      blocked,
      autoBlocked,
      stream,
      alias: after.alias_deployment_id,
      health: after.health_status,
      enabled: after.enabled,
      configVersion: after.config_version,
    });
  });

  it('counts HTTP 429 apart from provider health', async () => {
    mode = { type: 'status', status: 429 };
    for (let index = 0; index < 4; index += 1) {
      const result = await chat(tenant, 'breaker-chat', `rate-${index}`);
      expect(result.status).toBe(429);
      expect(result.code).toBe('rate_limit');
      expect(result.hits).toBe(1);
    }
    const view = await inspect(tenant, 'breaker-chat');
    expect(view).toMatchObject({
      state: 'closed',
      samples: 0,
      failures: 0,
      rateLimits: 4,
    });
    trace('rate-limit', view);
  });

  it('ignores invalid caller input', async () => {
    const before = await inspect(tenant, 'breaker-chat');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: JSON.stringify({ model: 'breaker-chat', messages: [] }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_parameter');
    expect(mock.hits).toHaveLength(0);
    const after = await inspect(tenant, 'breaker-chat');
    expect(after).toMatchObject({
      state: 'closed',
      samples: before.samples,
      failures: before.failures,
      rateLimits: before.rateLimits,
    });
    trace('invalid-input', { status: response.statusCode, hits: mock.hits.length, failures: after.failures });
  });

  it('ignores a rejected tenant secret', async () => {
    const before = await inspect(tenant, 'breaker-chat');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, 'not-the-secret'),
      payload: chatPayload('breaker-chat', 'secret'),
    });
    expect(response.statusCode).toBe(401);
    expect(mock.hits).toHaveLength(0);
    const after = await inspect(tenant, 'breaker-chat');
    expect(after.samples).toBe(before.samples);
    expect(after.failures).toBe(before.failures);
    expect(after.rateLimits).toBe(before.rateLimits);
    expect(after.state).toBe('closed');
    trace('auth-rejected', { status: response.statusCode, failures: after.failures });
  });

  it('ignores caller cancellation', async () => {
    if (!listening) {
      const port = await freePort();
      await ctx.app.listen({ host: '127.0.0.1', port });
      listening = true;
    }
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('listen address is missing');
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    onHang = () => release?.();
    mode = { type: 'hang' };
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      body: chatPayload('breaker-chat', 'cancel-me'),
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toThrow();
    const started = Date.now();
    let errorCode: string | null = null;
    while (Date.now() - started < 5_000) {
      const stored = await admin.query<{ error_code: string | null }>(
        `SELECT error_code FROM model_attempts
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenant.tenantId],
      );
      errorCode = stored.rows[0]?.error_code ?? null;
      if (errorCode === 'request_cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errorCode).toBe('request_cancelled');
    expect(mock.hits).toHaveLength(1);
    const view = await inspect(tenant, 'breaker-chat');
    expect(view).toMatchObject({ state: 'closed', samples: 0, failures: 0, rateLimits: 0 });
    trace('cancelled', { hits: mock.hits.length, errorCode, failures: view.failures });
  });

  it('counts a timeout and then opens on the sample threshold', async () => {
    enableBreaker(tenant.tenantId, 'breaker-slow');
    mode = { type: 'hang' };
    const timed = await chat(tenant, 'breaker-slow', 'slow-one');
    expect(timed.status).toBe(504);
    expect(timed.code).toBe('timeout');
    expect(timed.hits).toBe(1);
    const partial = await inspect(tenant, 'breaker-slow');
    expect(partial).toMatchObject({ state: 'closed', samples: 1, failures: 1, rateLimits: 0 });
    mode = { type: 'status', status: 503 };
    for (let index = 0; index < 2; index += 1) {
      const result = await chat(tenant, 'breaker-slow', `slow-fail-${index}`);
      expect(result.hits).toBe(1);
    }
    const opened = await inspect(tenant, 'breaker-slow');
    expect(opened.state).toBe('open');
    expect(opened.reason).toBe('failure_threshold');
    expect(opened.failures).toBe(3);
    const blocked = await chat(tenant, 'breaker-slow', 'slow-blocked');
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    trace('timeout-open', { partial, opened, blocked });
  });

  it('lets one probe through after cooldown and closes on success', async () => {
    await openMain();
    const blocked = await chat(tenant, 'breaker-chat', 'during-cooldown');
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    nowMs = ORIGIN + COOLDOWN_MS;
    const probe = await chat(tenant, 'breaker-chat', 'probe-ok');
    expect(probe).toMatchObject({ status: 200, hits: 1 });
    const closed = await inspect(tenant, 'breaker-chat');
    expect(closed).toMatchObject({
      state: 'closed',
      reason: 'probe_succeeded',
      samples: 0,
      failures: 0,
      probesInflight: 0,
    });
    const next = await chat(tenant, 'breaker-chat', 'after-close');
    expect(next).toMatchObject({ status: 200, hits: 1 });
    trace('probe-close', { blocked, probe, closed, next });
  });

  it('opens again when the recovery probe fails', async () => {
    await openMain();
    nowMs = ORIGIN + COOLDOWN_MS;
    mode = { type: 'status', status: 503 };
    const probe = await chat(tenant, 'breaker-chat', 'probe-fail');
    expect(probe.hits).toBe(1);
    expect(probe.status).not.toBe(200);
    const reopened = await inspect(tenant, 'breaker-chat');
    expect(reopened.state).toBe('open');
    expect(reopened.reason).toBe('probe_failed');
    expect(reopened.changedAt).toBe(new Date(nowMs).toISOString());
    const next = await chat(tenant, 'breaker-chat', 'after-reopen');
    expect(next).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    trace('probe-reopen', { probe, reopened, next });
  });

  it('reopens a streamed probe when the connection is refused', async () => {
    await openMain();
    nowMs = ORIGIN + COOLDOWN_MS;
    const before = mock.hits.length;
    const probe = await withClosedApp((app) => closedChat(app, 'stream-refused'));
    expect(probe.status).not.toBe(200);
    expect(probe.code).not.toBe('circuit_open');
    const attempt = await latestAttempt();
    expect(attempt.failure_class).toBe('connection_failure');
    const reopened = await inspect(tenant, 'breaker-chat');
    expect(reopened.state).toBe('open');
    expect(reopened.reason).toBe('probe_failed');
    expect(reopened.probesInflight).toBe(0);
    expect(reopened.changedAt).toBe(new Date(nowMs).toISOString());
    const blocked = await chat(tenant, 'breaker-chat', 'stream-refused-blocked', { stream: true });
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    expect(mock.hits).toHaveLength(before);
    const view = await inspect(tenant, 'breaker-chat');
    expect(view.probesInflight).toBe(0);
    expect(view.state).toBe('open');
    trace('stream-refused-probe', { probe, attempt, reopened, blocked });
  });

  it('opens a closed breaker from streamed connection failures', async () => {
    const before = mock.hits.length;
    const results = await withClosedApp(async (app) => {
      const seen: Array<{ status: number; code: string | null }> = [];
      for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
        const result = await closedChat(app, `stream-closed-${index}`);
        seen.push(result);
      }
      return seen;
    });
    expect(results).toHaveLength(FAILURE_THRESHOLD);
    expect(results.every((result) => result.code !== 'circuit_open')).toBe(true);
    const partial = await inspect(tenant, 'breaker-chat');
    expect(partial.state).toBe('closed');
    expect(partial.samples).toBe(FAILURE_THRESHOLD);
    expect(partial.failures).toBe(FAILURE_THRESHOLD);
    expect(partial.probesInflight).toBe(0);
    const opening = await withClosedApp((app) => closedChat(app, 'stream-closed-open'));
    expect(opening.code).not.toBe('circuit_open');
    const attempt = await latestAttempt();
    expect(attempt.failure_class).toBe('connection_failure');
    const opened = await inspect(tenant, 'breaker-chat');
    expect(opened.state).toBe('open');
    expect(opened.reason).toBe('failure_threshold');
    expect(opened.failures).toBe(MIN_SAMPLES);
    expect(opened.probesInflight).toBe(0);
    const blocked = await chat(tenant, 'breaker-chat', 'stream-closed-blocked', { stream: true });
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    expect(mock.hits).toHaveLength(before);
    trace('stream-connection-open', { partial, opening, attempt, opened, blocked });
  });

  it('reopens a streamed probe when the connect timer fires', async () => {
    enableBreaker(tenant.tenantId, 'breaker-slow');
    mode = { type: 'status', status: 503 };
    for (let index = 0; index < MIN_SAMPLES; index += 1) {
      const result = await chat(tenant, 'breaker-slow', `stream-timeout-open-${index}`);
      expect(result.hits).toBe(1);
    }
    const opened = await inspect(tenant, 'breaker-slow');
    expect(opened.state).toBe('open');
    nowMs = ORIGIN + COOLDOWN_MS;
    enableStreaming(db, {
      tenantId: tenant.tenantId,
      deployment: 'breaker-slow',
      connectTimeoutMs: 100,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 5_000,
      backpressureTimeoutMs: 5_000,
    });
    mode = { type: 'hang' };
    const before = mock.hits.length;
    const probe = await chat(tenant, 'breaker-slow', 'stream-timeout-probe', { stream: true });
    expect(probe).toMatchObject({ status: 504, code: 'timeout', hits: 1 });
    const attempt = await latestAttempt();
    expect(attempt.failure_class === 'timeout_before_dispatch' || attempt.failure_class === 'timeout_after_dispatch').toBe(true);
    const reopened = await inspect(tenant, 'breaker-slow');
    expect(reopened.state).toBe('open');
    expect(reopened.reason).toBe('probe_failed');
    expect(reopened.probesInflight).toBe(0);
    expect(reopened.changedAt).toBe(new Date(nowMs).toISOString());
    mode = { type: 'ok' };
    const blocked = await chat(tenant, 'breaker-slow', 'stream-timeout-blocked', { stream: true });
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    expect(mock.hits).toHaveLength(before + 1);
    trace('stream-timeout-probe', { probe, attempt, reopened, blocked });
  });

  it('releases a streamed probe when the caller aborts', async () => {
    await openMain();
    nowMs = ORIGIN + COOLDOWN_MS;
    const base = await listenAddress();
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    onHang = () => release?.();
    mode = { type: 'hang' };
    const controller = new AbortController();
    const pending = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      body: chatPayload('breaker-chat', 'stream-cancel', { stream: true }),
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toThrow();
    const started = Date.now();
    let errorCode: string | null = null;
    while (Date.now() - started < 5_000) {
      const stored = await latestAttempt();
      errorCode = stored.error_code;
      if (errorCode === 'request_cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errorCode).toBe('request_cancelled');
    const released = await inspect(tenant, 'breaker-chat');
    expect(released.state).toBe('half_open');
    expect(released.reason).toBe('cooldown_elapsed');
    expect(released.probesInflight).toBe(0);
    expect(released.failures).toBe(MIN_SAMPLES);
    mode = { type: 'ok' };
    onHang = undefined;
    const next = await chat(tenant, 'breaker-chat', 'stream-cancel-next');
    expect(next).toMatchObject({ status: 200, hits: 1 });
    const closed = await inspect(tenant, 'breaker-chat');
    expect(closed).toMatchObject({ state: 'closed', reason: 'probe_succeeded', probesInflight: 0 });
    trace('stream-cancel-probe', { errorCode, released, next, closed });
  });

  it('admits one shared probe from two processes', async () => {
    await openMain();
    mock.hits.length = 0;
    mode = { type: 'hold' };
    const probeAt = ORIGIN + COOLDOWN_MS;
    const finished: Array<{ status: number; code: string | null }> = [];
    const pending = [spawnChat(probeAt, 'probe-a'), spawnChat(probeAt, 'probe-b')];
    for (const child of pending) {
      void child.then(
        (result) => {
          finished.push(result);
        },
        () => undefined,
      );
    }
    await waitFor(
      () => mock.hits.length > 1 || (mock.hits.length === 1 && finished.some((result) => result.code === 'circuit_open')),
      `probe coordination hits=${mock.hits.length} finished=${JSON.stringify(finished)}`,
    );
    expect(mock.hits).toHaveLength(1);
    expect(finished.filter((result) => result.code === 'circuit_open')).toHaveLength(1);
    releaseHeld();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.code === 'circuit_open')).toHaveLength(1);
    expect(mock.hits).toHaveLength(1);
    const view = await inspect(tenant, 'breaker-chat');
    expect(view.state).toBe('closed');
    expect(view.reason).toBe('probe_succeeded');
    trace('replica-probes', { hits: mock.hits.map((hit) => hit.url), results, state: view.state, reason: view.reason });
  });

  it('keeps an open breaker closed to a new process', async () => {
    await openMain();
    const before = mock.hits.length;
    const restarted = await spawnChat(ORIGIN, 'restarted');
    expect(restarted).toEqual({ status: 503, code: 'circuit_open' });
    expect(mock.hits).toHaveLength(before);
    const view = await inspect(tenant, 'breaker-chat');
    expect(view.state).toBe('open');
    expect(view.reason).toBe('failure_threshold');
    trace('restart', { restarted, hits: mock.hits.length, before, state: view.state, changedAt: view.changedAt });
  });

  it('does not serve a disabled deployment', async () => {
    const row = await deploymentRow(tenant.tenantId, 'breaker-off');
    expect(row.enabled).toBe(false);
    const result = await chat(tenant, 'breaker-off', 'disabled');
    expect(result).toMatchObject({ status: 404, code: 'model_not_found', hits: 0 });
    const after = await deploymentRow(tenant.tenantId, 'breaker-off');
    expect(after.enabled).toBe(false);
    trace('deployment-disabled', { status: result.status, code: result.code, enabled: after.enabled });
  });

  it('does not change another tenant', async () => {
    await openMain();
    const alias = await deploymentRow(tenant.tenantId, 'breaker-chat');
    const result = await chat(other, 'other-chat', 'isolated');
    expect(result).toMatchObject({ status: 200, hits: 1 });
    const otherView = await inspect(other, 'other-chat');
    expect(otherView).toMatchObject({ enabled: false, state: 'closed', reason: 'disabled', samples: 0, failures: 0 });
    const mine = await inspect(tenant, 'breaker-chat');
    expect(mine.state).toBe('open');
    const aliasAfter = await deploymentRow(tenant.tenantId, 'breaker-chat');
    expect(aliasAfter.alias_deployment_id).toBe(alias.id);
    trace('tenant-isolation', { other: result, otherView, mine: mine.state, alias: aliasAfter.alias_deployment_id });
  });

  it('leaves an unconfigured deployment disabled', async () => {
    mode = { type: 'status', status: 503 };
    for (let index = 0; index < 3; index += 1) {
      const result = await chat(tenant, 'breaker-plain', `plain-${index}`);
      expect(result.hits).toBe(1);
      expect(result.status).not.toBe(200);
    }
    const view = await inspect(tenant, 'breaker-plain');
    expect(view).toMatchObject({
      enabled: false,
      state: 'closed',
      reason: 'disabled',
      changedAt: null,
      samples: 0,
      failures: 0,
      rateLimits: 0,
    });
    const again = await chat(tenant, 'breaker-plain', 'plain-again');
    expect(again.hits).toBe(1);
    trace('disabled-default', { view, hits: mock.hits.length });
  });

  it('reaches upstream after an emergency disable', async () => {
    await openMain();
    runCli(db, [
      'set-deployment-breaker',
      '--tenant-id',
      tenant.tenantId,
      '--deployment',
      'breaker-chat',
      '--enabled',
      'false',
    ], cliEnv());
    const view = await inspect(tenant, 'breaker-chat');
    expect(view).toMatchObject({ enabled: false, state: 'closed', reason: 'disabled', probesInflight: 0 });
    const result = await chat(tenant, 'breaker-chat', 'after-disable');
    expect(result).toMatchObject({ status: 200, hits: 1 });
    mode = { type: 'status', status: 503 };
    const failed = await chat(tenant, 'breaker-chat', 'after-disable-fail');
    expect(failed.hits).toBe(1);
    const still = await inspect(tenant, 'breaker-chat');
    expect(still.enabled).toBe(false);
    expect(still.state).toBe('closed');
    const row = await deploymentRow(tenant.tenantId, 'breaker-chat');
    expect(row.enabled).toBe(true);
    expect(row.health_status).toBe('healthy');
    trace('cli-disable', { view, result, still, health: row.health_status });
  });

  it('reaches upstream after a protected reset', async () => {
    await openMain();
    const reset = runCli(db, [
      'reset-deployment-breaker',
      '--tenant-id',
      tenant.tenantId,
      '--deployment',
      'breaker-chat',
    ], cliEnv()) as { deploymentId?: string; state?: string };
    expect(reset.state).toBe('closed');
    const view = await inspect(tenant, 'breaker-chat');
    expect(view).toMatchObject({ enabled: true, state: 'closed', reason: 'reset', samples: 0, failures: 0 });
    const result = await chat(tenant, 'breaker-chat', 'after-reset');
    expect(result).toMatchObject({ status: 200, hits: 1 });
    trace('cli-reset', { reset, view, result });
  });

  it('shows breaker state on the tenant inspection route', async () => {
    mode = { type: 'status', status: 429 };
    const limited = await chat(tenant, 'breaker-chat', 'inspect-rate');
    expect(limited.hits).toBe(1);
    mode = { type: 'status', status: 503 };
    const failed = await chat(tenant, 'breaker-chat', 'inspect-fail');
    expect(failed.hits).toBe(1);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/metrics/breakers?deployment=breaker-chat',
      headers: authHeaders(tenant.tenantId, tenant.secret),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { breakers: BreakerBody[] };
    expect(body.breakers[0]).toMatchObject({
      deployment: 'breaker-chat',
      enabled: true,
      state: 'closed',
      reason: 'enabled',
      samples: 1,
      failures: 1,
      rateLimits: 1,
      probesInflight: 0,
    });
    expect(typeof body.breakers[0]?.changedAt).toBe('string');
    expect(JSON.stringify(body)).not.toContain('health_status');
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/metrics/breakers',
      headers: authHeaders(tenant.tenantId, 'not-the-secret'),
    });
    expect(missing.statusCode).toBe(401);
    trace('inspect', body.breakers[0] ?? {});
  });

  it('does not reset the breaker from a caller route', async () => {
    await openMain();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/breaker/reset',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: JSON.stringify({ deployment: 'breaker-chat' }),
    });
    expect(response.statusCode).toBe(404);
    const internal = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/metrics/breakers',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: JSON.stringify({ deployment: 'breaker-chat' }),
    });
    expect(internal.statusCode).toBe(404);
    const view = await inspect(tenant, 'breaker-chat');
    expect(view.state).toBe('open');
    expect(view.reason).toBe('failure_threshold');
    const blocked = await chat(tenant, 'breaker-chat', 'still-open');
    expect(blocked).toMatchObject({ status: 503, code: 'circuit_open', hits: 0 });
    trace('no-public-reset', { status: response.statusCode, internal: internal.statusCode, state: view.state });
  });
});
