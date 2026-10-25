import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addDecimal, canonicalDecimal, multiplyDecimal } from '../src/inference/cost.js';
import { extractRequestFeatures } from '../src/inference/request-features.js';
import { runSampleCleanup } from '../src/inference/sample-jobs.js';
import { createSampleKeyManager, decryptSample } from '../src/inference/sample-crypto.js';
import type { VertexGenerateClient } from '../src/inference/vertex-client.js';
import { buildApp } from '../src/http/app.js';
import {
  captureLogger,
  cliEntry,
  configFor,
  createTestApp,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForExit,
  waitForReady,
} from './helpers.js';
import {
  adminPool,
  cliEnv,
  credentialKey,
  credentialKeyText,
  enableStreaming,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockAnthropic } from './mock-anthropic.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const EVIDENCE = process.env.SLICE_06E_EVIDENCE;
const MARKER = 'h06e-';
const KEY_B = Buffer.alloc(32, 4);
const KEY_WRONG = Buffer.alloc(32, 7);
const VERTEX_KEY = JSON.stringify({
  client_email: 'harden-bot@harden-vertex-proj.iam.gserviceaccount.com',
  private_key: `harden-${'k'.repeat(80)}`,
});

type Tenant = { tenantId: string; secret: string };
type Child = ReturnType<typeof spawnServer>;
type EnvelopeRow = {
  id: string;
  schema_version: number;
  wrapping_key_version: number;
  wrapped_key_iv: Buffer;
  wrapped_key_tag: Buffer;
  wrapped_key_ciphertext: Buffer;
  content_iv: Buffer;
  content_tag: Buffer;
  content_ciphertext: Buffer;
};

const db = loadTestDatabase();
const tenantIds: string[] = [];
const holds = new Map<string, () => void>();
const seen = new Map<string, number>();
const seamLines: string[] = [];
const notes = {
  encryption: [] as string[],
  isolation: [] as string[],
  distribution: [] as string[],
  retention: [] as string[],
  worker: [] as string[],
  rollback: [] as string[],
  measure: [] as string[],
};

const figures = {
  disabledMs: [] as number[],
  selectionMs: [] as number[],
  captureMs: [] as number[],
  featureUserUs: 0,
  featureSystemUs: 0,
  featureWallMs: 0,
  featureIterations: 0,
  captureAttempts: 0,
  captureStored: 0,
  rssBeforeKb: 0,
  rssDuringKb: 0,
  storageStart: 0,
  storageEnd: 0,
  backlogAfterCrash: 0,
  backlogAfterRecovery: 0,
  expiryDelayMs: 0,
  decryptFailures: 0,
  decryptSuccesses: 0,
  isolationPass: 0,
};

describe('learning history production hardening', () => {
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let anthropic: Awaited<ReturnType<typeof startMockAnthropic>>;
  let admin: ReturnType<typeof adminPool>;
  let portA = 0;
  let portB = 0;
  let childA: Child | undefined;
  let childB: Child | undefined;
  let vertexCalls = 0;

  function contentOf(body: string): string {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    const content = parsed.messages?.[0]?.content;
    return typeof content === 'string' ? content : '';
  }

  function frame(model: string, choice: Record<string, unknown>): string {
    return `data: ${JSON.stringify({
      id: 'chatcmpl-h',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [choice],
    })}\n\n`;
  }

  function frames(model: string, deltas: string[], finish: boolean): string {
    const parts = [frame(model, { index: 0, delta: { role: 'assistant' }, finish_reason: null })];
    for (const delta of deltas) parts.push(frame(model, { index: 0, delta: { content: delta }, finish_reason: null }));
    if (finish) {
      parts.push(frame(model, { index: 0, delta: {}, finish_reason: 'stop' }));
      parts.push('data: [DONE]\n\n');
    }
    return parts.join('');
  }

  function policy(
    tenantId: string,
    options: {
      mode?: string;
      content?: boolean;
      streaming?: boolean;
      replay?: boolean;
      rate?: string;
      count?: number;
      retention?: number;
      deployments?: string;
      providers?: string;
    } = {},
  ): void {
    const args = [
      'set-sample-policy',
      '--tenant-id',
      tenantId,
      '--mode',
      options.mode ?? 'encrypted_sample',
      '--content-capture',
      options.content === false ? 'false' : 'true',
      '--streaming-capture',
      options.streaming ? 'true' : 'false',
      '--replay',
      options.replay ? 'true' : 'false',
      '--judge-disclosure',
      'false',
      '--sample-rate',
      options.rate ?? '1',
      '--max-sample-bytes',
      '1000000',
      '--classifications',
      'internal',
      '--providers',
      options.providers ?? 'openai,anthropic,vertex',
      '--deployments',
      options.deployments ?? 'chat',
    ];
    if (options.count !== undefined) args.push('--max-sample-count', String(options.count));
    if (options.retention !== undefined) args.push('--retention-seconds', String(options.retention));
    runCli(db, args, cliEnv());
  }

  function makeTenant(name: string, model = 'gpt-h06e'): Tenant {
    const created = provisionTenant(db, name);
    registerInference(db, {
      tenantId: created.tenantId,
      apiKey: `sk-h-${created.tenantId.slice(0, 8)}`,
      deployment: 'chat',
      upstreamModel: model,
      timeoutMs: 20_000,
    });
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', created.tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    tenantIds.push(created.tenantId);
    return created;
  }

  async function chat(
    port: number,
    tenant: Tenant,
    content: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ status: number; text: string; ms: number; requestId: string; attemptCount: string; deployment: string; fallback: string }> {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content }], ...extra }),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      ms: performance.now() - started,
      requestId: response.headers.get('x-request-id') ?? '',
      attemptCount: response.headers.get('x-attempt-count') ?? '',
      deployment: response.headers.get('x-deployment') ?? '',
      fallback: response.headers.get('x-fallback') ?? '',
    };
  }

  async function storedCount(tenantId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function samplesFor(tenantId: string, requestId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1 AND request_id = $2',
      [tenantId, requestId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function track(port: number, tenant: Tenant, content: string, extra: Record<string, unknown> = {}) {
    figures.captureAttempts += 1;
    const result = await chat(port, tenant, content, extra);
    const stored = result.requestId.length > 0 && (await samplesFor(tenant.tenantId, result.requestId)) > 0;
    if (stored) figures.captureStored += 1;
    return { ...result, stored };
  }

  async function envelope(tenantId: string, requestId: string): Promise<EnvelopeRow> {
    const result = await admin.query<EnvelopeRow>(
      `SELECT id::text, schema_version, wrapping_key_version,
              wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext
       FROM request_samples WHERE tenant_id = $1 AND request_id = $2`,
      [tenantId, requestId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('sample row is missing');
    return row;
  }

  function opened(manager: ReturnType<typeof createSampleKeyManager>, tenantId: string, row: EnvelopeRow): unknown | null {
    const value = decryptSample(
      manager,
      { tenantId, sampleId: row.id, schemaVersion: row.schema_version },
      {
        schemaVersion: row.schema_version,
        wrappingKeyVersion: row.wrapping_key_version,
        wrappedKeyIv: row.wrapped_key_iv,
        wrappedKeyTag: row.wrapped_key_tag,
        wrappedKeyCiphertext: row.wrapped_key_ciphertext,
        contentIv: row.content_iv,
        contentTag: row.content_tag,
        contentCiphertext: row.content_ciphertext,
      },
    );
    if (value === null) figures.decryptFailures += 1;
    else figures.decryptSuccesses += 1;
    return value;
  }

  async function relationBytes(): Promise<number> {
    const result = await admin.query<{ bytes: string }>(
      `SELECT pg_total_relation_size('public.request_samples')::bigint::text AS bytes`,
    );
    return Number(result.rows[0]?.bytes ?? 0);
  }

  function rssKb(pid: number | undefined): number {
    if (pid === undefined) return Number.NaN;
    const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return Number(result.stdout.trim());
  }

  function codeOf(text: string): string | null {
    try {
      const body = JSON.parse(text) as { error?: { code?: string } };
      return body.error?.code ?? null;
    } catch {
      return null;
    }
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitHold(content: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      if (holds.has(content)) return;
      await sleep(15);
    }
    throw new Error('upstream hold did not start');
  }

  async function streamStatus(tenantId: string, requestId: string): Promise<string | null> {
    const result = await admin.query<{ stream_status: string | null }>(
      `SELECT stream_status FROM model_attempts WHERE tenant_id = $1 AND request_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, requestId],
    );
    return result.rows[0]?.stream_status ?? null;
  }

  async function waitStream(tenantId: string, requestId: string, status: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      if ((await streamStatus(tenantId, requestId)) === status) return;
      await sleep(20);
    }
    throw new Error(`stream status ${status} did not arrive`);
  }

  function openPaused(port: number, tenant: Tenant, payload: string): { destroy: () => void } {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
      },
      (res) => {
        res.pause();
      },
    );
    req.on('error', () => undefined);
    req.write(payload);
    req.end();
    return { destroy: () => req.destroy() };
  }

  function logs(): string {
    return `${childA?.output() ?? ''}\n${childB?.output() ?? ''}\n${seamLines.join('\n')}`;
  }

  beforeAll(async () => {
    openai = await startMockUpstream((hit, request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; stream?: boolean };
      const content = contentOf(hit.body);
      const model = parsed.model ?? 'gpt-h06e';
      const count = (seen.get(content) ?? 0) + 1;
      seen.set(content, count);
      if (content.startsWith(`${MARKER}hold`)) {
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        holds.set(content, release);
        void gate.then(() => {
          if (response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completionBody(model, `${MARKER}out-hold`)));
        });
        return;
      }
      if (content.startsWith(`${MARKER}retry`) && count === 1) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream' } }));
        return;
      }
      if (model === 'gpt-fb-primary') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream' } }));
        return;
      }
      if (content.startsWith(`${MARKER}partial`) && parsed.stream !== true) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream' } }));
        return;
      }
      if (parsed.stream === true) {
        if (content.startsWith(`${MARKER}slow`)) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = frame(model, { index: 0, delta: { content: 'z'.repeat(256 * 1024) }, finish_reason: null });
          let writes = 0;
          const pump = (): void => {
            if (response.writableEnded || response.destroyed || request.aborted || request.socket?.destroyed === true) return;
            if (writes >= 24) return;
            writes += 1;
            response.write(chunk);
            setTimeout(pump, 20);
          };
          pump();
          return;
        }
        if (content.startsWith(`${MARKER}cancel`)) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(frames(model, [`${MARKER}delta-cancel`], false));
          const stop = (): void => {
            if (!response.writableEnded) response.end();
          };
          request.on('aborted', stop);
          request.socket?.on('close', stop);
          return;
        }
        if (content.startsWith(`${MARKER}cut`)) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frames(model, [`${MARKER}delta-cut`], false));
          return;
        }
        if (content.startsWith(`${MARKER}over`)) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frames(model, ['a'.repeat(600_000), 'b'.repeat(500_000)], true));
          return;
        }
        if (content.startsWith(`${MARKER}mem`)) {
          let release = (): void => undefined;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          holds.set(content, release);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(frames(model, [`${MARKER}delta-mem`], false));
          void gate.then(() => {
            if (response.writableEnded) return;
            response.end(`${frame(model, { index: 0, delta: {}, finish_reason: 'stop' })}data: [DONE]\n\n`);
          });
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frames(model, [`${MARKER}delta`], true));
        return;
      }
      if (content.startsWith(`${MARKER}huge`)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(model, 'y'.repeat(1_000_000))));
        return;
      }
      const visible = content.startsWith(`${MARKER}fb`) ? `${MARKER}out-fb` : `${MARKER}out`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(model, visible)));
    });
    anthropic = await startMockAnthropic();
    admin = adminPool(db);
    figures.storageStart = await relationBytes();
    portA = await freePort();
    portB = await freePort();
    const shared = {
      INFERENCE_ENABLED: 'true',
      OPENAI_BASE_URL: openai.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      MAX_ACTIVE_STREAMS: '8',
      MAX_STREAMS_PER_TENANT: '4',
    };
    childA = spawnServer(serviceEnv(db, { ...shared, PORT: String(portA) }));
    childB = spawnServer(serviceEnv(db, { ...shared, PORT: String(portB) }));
    await waitForReady(portA);
    await waitForReady(portB);
  }, 180_000);

  afterAll(async () => {
    if (childA !== undefined) await stopChild(childA.child);
    if (childB !== undefined) await stopChild(childB.child);
    await admin.end();
    await openai.close();
    await anthropic.close();
  });

  it('serves concurrent tenants and captures only the approved tenant', async () => {
    const alpha = makeTenant('Slice 06E Alpha');
    const beta = makeTenant('Slice 06E Beta');
    policy(alpha.tenantId, { mode: 'metadata_only', content: false, deployments: 'chat' });
    policy(beta.tenantId, { mode: 'disabled', content: false, deployments: 'chat' });
    const meta = await chat(portA, alpha, `${MARKER}meta-1`, { task: 'coding' });
    expect(meta.status).toBe(200);
    expect(await storedCount(alpha.tenantId)).toBe(0);
    const features = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_features WHERE tenant_id = $1',
      [alpha.tenantId],
    );
    expect(features.rows[0]?.count).toBe(1);

    policy(alpha.tenantId, { streaming: true, retention: 86_400, count: 100, deployments: 'chat' });
    const paired = await Promise.all([
      track(portA, alpha, `${MARKER}pair-a`, { task: 'summarization' }),
      track(portB, beta, `${MARKER}pair-b`, { task: 'translation' }),
      track(portB, alpha, `${MARKER}pair-c`, { task: 'extraction' }),
      chat(portA, beta, `${MARKER}pair-d`),
    ]);
    expect(paired.map((item) => item.status)).toEqual([200, 200, 200, 200]);
    expect(await storedCount(alpha.tenantId)).toBe(2);
    expect(await storedCount(beta.tenantId)).toBe(0);
    const attempts = await admin.query<{ tenant_id: string; count: number }>(
      `SELECT tenant_id::text, count(*)::int AS count FROM model_attempts
       WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id`,
      [[alpha.tenantId, beta.tenantId]],
    );
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows.every((row) => row.count >= 1)).toBe(true);

    const listed = await fetch(`http://127.0.0.1:${portB}/internal/v1/samples`, {
      headers: { 'x-tenant-id': beta.tenantId, authorization: `Bearer ${beta.secret}` },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { samples: Array<{ id: string }> };
    const alphaRows = await admin.query<{ id: string }>(
      'SELECT id::text FROM request_samples WHERE tenant_id = $1',
      [alpha.tenantId],
    );
    const alphaId = alphaRows.rows[0]?.id ?? '';
    expect(alphaId.length).toBeGreaterThan(0);
    expect(body.samples.some((item) => item.id === alphaId)).toBe(false);
    const foreign = await fetch(`http://127.0.0.1:${portA}/internal/v1/samples/${alphaId}`, {
      headers: { 'x-tenant-id': beta.tenantId, authorization: `Bearer ${beta.secret}` },
    });
    expect(foreign.status).toBe(404);
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    try {
      const visible = await withTenant(runtime, beta.tenantId, async (client) => {
        const result = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1',
          [alpha.tenantId],
        );
        return result.rows[0]?.count ?? -1;
      });
      expect(visible).toBe(0);
    } finally {
      await runtime.end();
    }
    figures.isolationPass += 1;
    notes.isolation.push(
      'two proxy processes served two tenants at the same time',
      'content capture was on for one tenant',
      'the other tenant stored no sample',
      'the other tenant received 404 for the stored sample',
      'row level security returned no foreign sample row',
    );
  });

  it('keeps a different retention on each tenant', async () => {
    const left = makeTenant('Slice 06E Retain A');
    const right = makeTenant('Slice 06E Retain B');
    policy(left.tenantId, { retention: 7_200, count: 10 });
    policy(right.tenantId, { retention: 1_800, count: 10 });
    const a = await track(portA, left, `${MARKER}ret-a`);
    const b = await track(portB, right, `${MARKER}ret-b`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.stored).toBe(true);
    expect(b.stored).toBe(true);
    const spans = await admin.query<{ tenant_id: string; seconds: number }>(
      `SELECT tenant_id::text, EXTRACT(EPOCH FROM (expires_at - created_at))::int AS seconds
       FROM request_samples WHERE tenant_id = ANY($1::uuid[])`,
      [[left.tenantId, right.tenantId]],
    );
    const byTenant = new Map(spans.rows.map((row) => [row.tenant_id, row.seconds]));
    expect(byTenant.get(left.tenantId)).toBe(7_200);
    expect(byTenant.get(right.tenantId)).toBe(1_800);
    notes.retention.push('one tenant keeps a sample for 7200 seconds', 'the other tenant keeps a sample for 1800 seconds');
  });

  it('enforces one cap and skips a duplicate', async () => {
    const capped = makeTenant('Slice 06E Cap');
    policy(capped.tenantId, { count: 2, retention: 86_400 });
    const calls = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) => chat(index % 2 === 0 ? portA : portB, capped, `${MARKER}cap-${index}`)),
    );
    expect(calls.every((item) => item.status === 200)).toBe(true);
    const retained = await storedCount(capped.tenantId);
    figures.captureAttempts += calls.length;
    figures.captureStored += retained;
    expect(retained).toBeLessThanOrEqual(2);
    expect(retained).toBeGreaterThan(0);

    const dup = makeTenant('Slice 06E Dup');
    policy(dup.tenantId, { count: 10, retention: 86_400 });
    const first = await track(portA, dup, `${MARKER}dup`);
    const second = await track(portB, dup, `${MARKER}dup`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(await storedCount(dup.tenantId)).toBe(1);
  });

  it('accepts a large request and a large output without storing an over-size sample', async () => {
    const tenant = makeTenant('Slice 06E Large');
    policy(tenant.tenantId, { count: 10, retention: 86_400, streaming: true });
    const large = await track(portA, tenant, `${MARKER}large-${'n'.repeat(80_000)}`);
    expect(large.status).toBe(200);
    expect(large.stored).toBe(true);
    const before = await storedCount(tenant.tenantId);
    const huge = await chat(portB, tenant, `${MARKER}huge`);
    expect(huge.status).toBe(200);
    expect(huge.text.length).toBeGreaterThan(1_000_000);
    expect(await samplesFor(tenant.tenantId, huge.requestId)).toBe(0);
    expect(await storedCount(tenant.tenantId)).toBe(before);
    figures.captureAttempts += 1;
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'chat' });
    const over = await chat(portA, tenant, `${MARKER}over`, { stream: true });
    expect(over.status).toBe(200);
    expect(over.text).toContain('[DONE]');
    await waitStream(tenant.tenantId, over.requestId, 'completed');
    expect(await samplesFor(tenant.tenantId, over.requestId)).toBe(0);
    figures.captureAttempts += 1;
  });

  it('drops an incomplete stream under backpressure, cancel, and a missing terminal', async () => {
    const tenant = makeTenant('Slice 06E Stream');
    policy(tenant.tenantId, { streaming: true, count: 10, retention: 86_400 });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'chat', backpressureTimeoutMs: 200 });
    const before = await storedCount(tenant.tenantId);
    const paused = openPaused(
      portA,
      tenant,
      JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: `${MARKER}slow` }], stream: true }),
    );
    const started = Date.now();
    let status: string | null = null;
    while (Date.now() - started < 8_000) {
      const row = await admin.query<{ stream_status: string | null; request_id: string }>(
        `SELECT stream_status, request_id::text FROM model_attempts
         WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenant.tenantId],
      );
      status = row.rows[0]?.stream_status ?? null;
      if (status === 'slow_consumer') break;
      await sleep(20);
    }
    paused.destroy();
    expect(status).toBe('slow_consumer');
    figures.captureAttempts += 1;

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${portB}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: `${MARKER}cancel-live` }], stream: true }),
    });
    const cancelStarted = Date.now();
    while (Date.now() - cancelStarted < 5_000) {
      const row = await admin.query(
        `SELECT 1 FROM model_attempts
         WHERE tenant_id = $1 AND stream_status IN ('connecting', 'streaming')`,
        [tenant.tenantId],
      );
      if ((row.rowCount ?? 0) > 0) break;
      await sleep(20);
    }
    controller.abort();
    await pending.catch(() => undefined);
    const abortStarted = Date.now();
    let aborted = false;
    while (Date.now() - abortStarted < 8_000) {
      const row = await admin.query(
        `SELECT 1 FROM model_attempts WHERE tenant_id = $1 AND stream_status = 'client_aborted'`,
        [tenant.tenantId],
      );
      if ((row.rowCount ?? 0) > 0) {
        aborted = true;
        break;
      }
      await sleep(20);
    }
    expect(aborted).toBe(true);
    figures.captureAttempts += 1;

    const cut = await chat(portB, tenant, `${MARKER}cut`, { stream: true });
    expect(cut.status).toBe(200);
    expect(cut.text).not.toContain('[DONE]');
    await waitStream(tenant.tenantId, cut.requestId, 'stream_truncated');
    const partial = await chat(portA, tenant, `${MARKER}partial`);
    expect(partial.status).toBe(502);
    expect(codeOf(partial.text)).toBe('upstream_error');
    expect(await storedCount(tenant.tenantId)).toBe(before);
    expect(await samplesFor(tenant.tenantId, cut.requestId)).toBe(0);
    figures.captureAttempts += 2;
  });

  it('stores nothing when the policy is revoked during the provider call', async () => {
    const tenant = makeTenant('Slice 06E Revoke');
    policy(tenant.tenantId, { count: 10, retention: 86_400 });
    const before = await storedCount(tenant.tenantId);
    const content = `${MARKER}hold-revoke`;
    const pending = chat(portA, tenant, content);
    await waitHold(content);
    policy(tenant.tenantId, { mode: 'disabled', content: false });
    holds.get(content)?.();
    holds.delete(content);
    const done = await pending;
    expect(done.status).toBe(200);
    expect(await samplesFor(tenant.tenantId, done.requestId)).toBe(0);
    expect(await storedCount(tenant.tenantId)).toBe(before);
    figures.captureAttempts += 1;
    notes.rollback.push('a policy change to disabled during the provider call stored no sample');
  });

  it('keeps the chat when feature extraction or capture fails', async () => {
    const tenant = makeTenant('Slice 06E Seam');
    policy(tenant.tenantId, { count: 10, retention: 86_400 });
    const throwingKey = {
      current(): { version: number; key: Buffer } {
        throw new Error('wrapping key is unavailable');
      },
      previous(): readonly { version: number; key: Buffer }[] {
        return [];
      },
    };
    const outage = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      sampleKeyManager: throwingKey,
    });
    seamLines.push(...outage.lines);
    try {
      const before = await storedCount(tenant.tenantId);
      const denied = await outage.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
        payload: { model: 'chat', messages: [{ role: 'user', content: `${MARKER}outage` }] },
      });
      expect(denied.statusCode).toBe(200);
      expect(await storedCount(tenant.tenantId)).toBe(before);
    } finally {
      seamLines.push(...outage.lines);
      await outage.app.close();
      await outage.authPool.end();
      await outage.runtimePool.end();
    }

    const extractor = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      extractFeatures: () => {
        throw new Error('extractor failed');
      },
    });
    try {
      const kept = await extractor.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
        payload: { model: 'chat', messages: [{ role: 'user', content: `${MARKER}feat` }] },
      });
      expect(kept.statusCode).toBe(200);
      expect(extractor.lines.some((line) => line.includes('request features were not recorded'))).toBe(true);
      expect(extractor.lines.some((line) => line.includes(MARKER))).toBe(false);
    } finally {
      seamLines.push(...extractor.lines);
      await extractor.app.close();
      await extractor.authPool.end();
      await extractor.runtimePool.end();
    }

    const broken = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      failSampleInsert: () => true,
    });
    try {
      const before = await storedCount(tenant.tenantId);
      const kept = await broken.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
        payload: { model: 'chat', messages: [{ role: 'user', content: `${MARKER}insert` }] },
      });
      expect(kept.statusCode).toBe(200);
      expect(await storedCount(tenant.tenantId)).toBe(before);
      expect(broken.lines.some((line) => line.includes('sample was not stored'))).toBe(true);
      expect(broken.lines.some((line) => line.includes(MARKER))).toBe(false);
    } finally {
      seamLines.push(...broken.lines);
      await broken.app.close();
      await broken.authPool.end();
      await broken.runtimePool.end();
    }
  });

  it('opens a rotated key, rejects the wrong key, and rejects a tampered payload', async () => {
    const tenant = makeTenant('Slice 06E Rotate');
    policy(tenant.tenantId, { count: 10, retention: 86_400 });
    const first = await track(portA, tenant, `${MARKER}rotate-old`);
    expect(first.stored).toBe(true);
    const oldRow = await envelope(tenant.tenantId, first.requestId);
    expect(oldRow.wrapping_key_version).toBe(1);
    const portC = await freePort();
    const childC = spawnServer(
      serviceEnv(db, {
        PORT: String(portC),
        INFERENCE_ENABLED: 'true',
        OPENAI_BASE_URL: openai.baseUrl,
        PROVIDER_CREDENTIAL_KEY: KEY_B.toString('base64'),
        PROVIDER_CREDENTIAL_KEY_PREVIOUS: credentialKeyText,
        MAX_ACTIVE_STREAMS: '4',
        MAX_STREAMS_PER_TENANT: '2',
      }),
    );
    try {
      await waitForReady(portC);
      const second = await track(portC, tenant, `${MARKER}rotate-new`);
      expect(second.status).toBe(200);
      expect(second.stored).toBe(true);
      const newRow = await envelope(tenant.tenantId, second.requestId);
      expect(newRow.wrapping_key_version).toBe(2);
      const rotated = createSampleKeyManager(KEY_B, [credentialKey]);
      expect(opened(rotated, tenant.tenantId, oldRow)).not.toBeNull();
      expect(opened(rotated, tenant.tenantId, newRow)).not.toBeNull();
      expect(opened(createSampleKeyManager(KEY_WRONG), tenant.tenantId, oldRow)).toBeNull();
      const tampered: EnvelopeRow = {
        ...newRow,
        content_ciphertext: Buffer.from(newRow.content_ciphertext),
      };
      tampered.content_ciphertext[tampered.content_ciphertext.length - 1] ^= 0xff;
      expect(opened(rotated, tenant.tenantId, tampered)).toBeNull();
      expect(opened(rotated, tenant.tenantId, newRow)).not.toBeNull();
      notes.encryption.push(
        `old wrapping version ${oldRow.wrapping_key_version}`,
        `new wrapping version ${newRow.wrapping_key_version}`,
        'rotated manager opened both samples',
        'the rotated process opened the provider credential with the retained key',
        'wrong key opened nothing',
        'tampered ciphertext opened nothing',
        'the stored row still opens after the tamper check',
      );
    } finally {
      await stopChild(childC.child);
    }
  });

  it('keeps cost, retry, and fallback results for the same inputs', async () => {
    const priced = makeTenant('Slice 06E Cost', 'gpt-h06e-cost');
    runCli(
      db,
      [
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        'gpt-h06e-cost',
        '--effective-at',
        new Date(Date.now() - 60_000).toISOString(),
        '--source',
        'fixture',
        '--status',
        'verified',
        '--input-rate',
        '0.01',
      ],
      cliEnv(),
    );
    runCli(db, ['set-tenant-budget', '--tenant-id', priced.tenantId, '--mode', 'hard', '--monthly-amount', '10'], cliEnv());
    const cost = await chat(portA, priced, `${MARKER}cost-1`);
    expect(cost.status).toBe(200);
    expect(cost.attemptCount).toBe('1');
    const usage = await fetch(`http://127.0.0.1:${portB}/internal/v1/budgets/usage`, {
      headers: { 'x-tenant-id': priced.tenantId, authorization: `Bearer ${priced.secret}` },
    });
    expect(usage.status).toBe(200);
    const budget = (await usage.json()) as { budget: { recognized: string }; costStatus: string };
    expect(canonicalDecimal(budget.budget.recognized)).toBe(canonicalDecimal(multiplyDecimal('0.01', 3)));
    expect(budget.costStatus).toBe('estimated');
    const costHits = openai.hits.filter((hit) => contentOf(hit.body) === `${MARKER}cost-1`).length;
    expect(costHits).toBe(1);

    const unknown = makeTenant('Slice 06E Unknown', 'gpt-h06e-unknown');
    runCli(db, ['set-tenant-budget', '--tenant-id', unknown.tenantId, '--mode', 'hard', '--monthly-amount', '5'], cliEnv());
    const hitsBefore = openai.hits.length;
    const missing = await chat(portB, unknown, `${MARKER}unknown-price`);
    expect(missing.status).toBe(429);
    expect(codeOf(missing.text)).toBe('budget_unknown');
    expect(openai.hits.length).toBe(hitsBefore);

    const retry = makeTenant('Slice 06E Retry');
    runCli(
      db,
      [
        'set-execution-policy',
        '--tenant-id',
        retry.tenantId,
        '--deployment',
        'chat',
        '--retries',
        'true',
        '--connection-deadline-ms',
        '5000',
        '--attempt-deadline-ms',
        '5000',
        '--total-deadline-ms',
        '5000',
        '--initial-backoff-ms',
        '0',
        '--max-backoff-ms',
        '0',
      ],
      cliEnv(),
    );
    const retried = await chat(portA, retry, `${MARKER}retry-1`, { model: 'auto' });
    expect(retried.status).toBe(200);
    expect(retried.attemptCount).toBe('2');
    const ordinals = await admin.query<{ ordinal: number; failure_class: string | null; status: string }>(
      `SELECT attempt_ordinal AS ordinal, failure_class, status
       FROM model_attempts WHERE tenant_id = $1 ORDER BY attempt_ordinal`,
      [retry.tenantId],
    );
    expect(ordinals.rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(ordinals.rows[0]?.failure_class).toBe('rate_limit');
    expect(ordinals.rows[1]?.status).toBe('succeeded');

    const fb = provisionTenant(db, 'Slice 06E Fallback');
    tenantIds.push(fb.tenantId);
    registerInference(db, {
      tenantId: fb.tenantId,
      apiKey: 'sk-h-fallback',
      deployment: 'fb-primary',
      upstreamModel: 'gpt-fb-primary',
      timeoutMs: 20_000,
      capabilities: 'temperature',
    });
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        fb.tenantId,
        '--provider',
        'openai',
        '--name',
        'fb-secondary',
        '--upstream-model',
        'gpt-fb-secondary',
        '--timeout-ms',
        '20000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    for (const name of ['fb-primary', 'fb-secondary']) {
      await admin.query(
        `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = $2`,
        [fb.tenantId, name],
      );
      runCli(
        db,
        ['set-deployment-context-limit', '--tenant-id', fb.tenantId, '--deployment', name, '--context-limit', '128'],
        cliEnv(),
      );
      runCli(
        db,
        ['set-deployment-data-collection', '--tenant-id', fb.tenantId, '--deployment', name, '--data-collection', 'allow'],
        cliEnv(),
      );
    }
    runCli(
      db,
      [
        'set-fallback-policy',
        '--tenant-id',
        fb.tenantId,
        '--alias',
        'auto',
        '--enabled',
        'true',
        '--deployments',
        'fb-secondary',
        '--failures',
        'unavailable',
        '--max-attempts',
        '2',
        '--capabilities',
        'temperature',
        '--providers',
        'openai',
        '--data-collection',
        'allow',
        '--min-remaining-deadline-ms',
        '0',
      ],
      cliEnv(),
    );
    const fell = await chat(portB, fb, `${MARKER}fb-1`, { model: 'auto' });
    expect(fell.status).toBe(200);
    expect(fell.attemptCount).toBe('2');
    expect(fell.fallback).toBe('true');
    expect(fell.deployment).toBe('fb-secondary');
    expect(addDecimal(multiplyDecimal('0.01', 3), '0')).toBe(canonicalDecimal(multiplyDecimal('0.01', 3)));
  });

  it('calls only the approved provider', async () => {
    const tenant = makeTenant('Slice 06E Provider');
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-harden',
      endpoint: anthropic.origin,
      deployment: 'claude-chat',
      upstreamModel: 'claude-h06e',
      timeoutMs: 20_000,
      alias: false,
    });
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', tenant.tenantId, '--deployment', 'claude-chat', '--data-class', 'internal'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-vertex-connection',
        '--tenant-id',
        tenant.tenantId,
        '--api-key',
        VERTEX_KEY,
        '--project',
        'harden-vertex-proj',
        '--location',
        'us-central1',
        '--service-account',
        'harden-bot@harden-vertex-proj.iam.gserviceaccount.com',
      ],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'vertex',
        '--name',
        'gemini-us',
        '--upstream-model',
        'gemini-2.5-flash',
        '--timeout-ms',
        '20000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', tenant.tenantId, '--deployment', 'gemini-us', '--data-class', 'internal'],
      cliEnv(),
    );
    policy(tenant.tenantId, { count: 10, retention: 86_400, deployments: 'chat,claude-chat,gemini-us' });
    const openaiBefore = openai.hits.length;
    const anthropicBefore = anthropic.hits.length;
    const claude = await chat(portA, tenant, `${MARKER}anth`, { model: 'claude-chat' });
    expect(claude.status).toBe(200);
    expect(anthropic.hits.length).toBe(anthropicBefore + 1);
    expect(openai.hits.length).toBe(openaiBefore);
    expect(await samplesFor(tenant.tenantId, claude.requestId)).toBe(1);

    const factory = async (): Promise<VertexGenerateClient> => ({
      async generateContent() {
        vertexCalls += 1;
        return {
          responseId: 'resp-h',
          modelVersion: 'gemini-2.5-flash',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: `${MARKER}vertex-out` }] } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        };
      },
      generateContentStream() {
        vertexCalls += 1;
        return (async function* empty() {
          yield {};
        })();
      },
      async listModels() {},
    });
    const vertex = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      vertexClientFactory: factory,
    });
    try {
      const hitsBefore = openai.hits.length;
      const anthBefore = anthropic.hits.length;
      const response = await vertex.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
        payload: { model: 'gemini-us', messages: [{ role: 'user', content: `${MARKER}vertex` }] },
      });
      expect(response.statusCode).toBe(200);
      expect(vertexCalls).toBe(1);
      expect(openai.hits.length).toBe(hitsBefore);
      expect(anthropic.hits.length).toBe(anthBefore);
    } finally {
      seamLines.push(...vertex.lines);
      await vertex.app.close();
      await vertex.authPool.end();
      await vertex.runtimePool.end();
    }

    const quiet = openai.hits.length;
    runCli(db, ['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'chat', '--enabled', 'false'], cliEnv());
    const blocked = await chat(portB, tenant, `${MARKER}blocked`);
    expect(blocked.status).toBe(404);
    expect(codeOf(blocked.text)).toBe('model_not_found');
    expect(openai.hits.length).toBe(quiet);
    expect(vertexCalls).toBe(1);
  });

  it('recovers a crashed cleanup and lets two workers delete once', async () => {
    const tenant = makeTenant('Slice 06E Cleanup');
    policy(tenant.tenantId, { retention: 1, count: 10 });
    const first = await track(portA, tenant, `${MARKER}expire-1`);
    const second = await track(portB, tenant, `${MARKER}expire-2`);
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    const expires = await admin.query<{ id: string; expires_at: Date }>(
      `SELECT id::text, expires_at FROM request_samples WHERE tenant_id = $1 AND request_id = $2`,
      [tenant.tenantId, first.requestId],
    );
    const expiresAt = expires.rows[0]?.expires_at;
    expect(expiresAt).toBeInstanceOf(Date);
    await sleep(1_500);
    const migrator = createPool(configFor(db), 'migrator', undefined, 1);
    const crashKey = 'expire-cleanup:harden-crash';
    try {
      await expect(
        runSampleCleanup(migrator, { idempotencyKey: crashKey, tenantId: tenant.tenantId, crashAfterCommit: true }),
      ).rejects.toThrow('sample cleanup crashed');
      expect(await storedCount(tenant.tenantId)).toBe(0);
      const audits = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM sample_deletions WHERE tenant_id = $1 AND reason = 'expired'`,
        [tenant.tenantId],
      );
      expect(audits.rows[0]?.count).toBe(2);
      const deleted = await admin.query<{ deleted_at: Date }>(
        'SELECT deleted_at FROM sample_deletions WHERE sample_id = $1',
        [expires.rows[0]?.id],
      );
      const deletedAt = deleted.rows[0]?.deleted_at;
      expect(deletedAt).toBeInstanceOf(Date);
      figures.expiryDelayMs = (deletedAt?.getTime() ?? 0) - (expiresAt?.getTime() ?? 0);
      const backlog = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM sample_jobs WHERE status <> 'succeeded'`,
      );
      figures.backlogAfterCrash = backlog.rows[0]?.count ?? 0;
      expect(figures.backlogAfterCrash).toBeGreaterThan(0);
      await admin.query(`UPDATE sample_jobs SET locked_until = now() - interval '1 minute' WHERE idempotency_key = $1`, [
        crashKey,
      ]);
      const retried = await runSampleCleanup(migrator, { idempotencyKey: crashKey, tenantId: tenant.tenantId });
      expect(retried.status).toBe('succeeded');
      expect(retried.removed).toBe(0);
      const auditsAfter = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM sample_deletions WHERE tenant_id = $1 AND reason = 'expired'`,
        [tenant.tenantId],
      );
      expect(auditsAfter.rows[0]?.count).toBe(2);
      const after = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM sample_jobs WHERE status <> 'succeeded' AND idempotency_key = $1`,
        [crashKey],
      );
      figures.backlogAfterRecovery = after.rows[0]?.count ?? -1;
      expect(figures.backlogAfterRecovery).toBe(0);

      policy(tenant.tenantId, { retention: 1, count: 10 });
      const againA = await track(portA, tenant, `${MARKER}expire-3`);
      const againB = await track(portB, tenant, `${MARKER}expire-4`);
      expect(againA.stored && againB.stored).toBe(true);
      await sleep(1_500);
      const bucket = new Date().toISOString().slice(0, 16);
      const args = ['cleanup-expired-samples', '--tenant-id', tenant.tenantId];
      const live = (label: string) =>
        new Promise<{ status: number; stdout: string }>((resolve) => {
          const child = spawn(process.execPath, [cliEntry, ...args], {
            cwd: projectRoot,
            env: serviceEnv(db, { ...cliEnv(), CLEANUP_LABEL: label }),
          });
          let stdout = '';
          child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
          });
          child.on('close', (status) => resolve({ status: status ?? 1, stdout }));
        });
      const [left, right] = await Promise.all([live('a'), live('b')]);
      expect(left.status).toBe(0);
      expect(right.status).toBe(0);
      const removed = [left, right].map((item) => JSON.parse(item.stdout) as { status: string; removed: number });
      expect(removed.reduce((sum, item) => sum + item.removed, 0)).toBe(2);
      expect(await storedCount(tenant.tenantId)).toBe(0);
      const reasons = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM sample_deletions WHERE tenant_id = $1 AND reason = 'expired'`,
        [tenant.tenantId],
      );
      expect(reasons.rows[0]?.count).toBe(4);
      notes.worker.push(
        `crash key ${crashKey} committed the delete and left the job unfinished`,
        'the retry finished the job and did not add a deletion audit',
        `concurrent cleanup bucket ${bucket}`,
        `concurrent removed ${removed.map((item) => item.removed).join(',')}`,
        'two workers deleted each expired sample once',
      );
      expect(bucket.length).toBe(16);
    } finally {
      await migrator.end();
    }
  });

  it('hides a restored expired sample and deletes it again', async () => {
    const tenant = makeTenant('Slice 06E Restore');
    policy(tenant.tenantId, { retention: 86_400, count: 10 });
    const stored = await track(portA, tenant, `${MARKER}restore`);
    expect(stored.stored).toBe(true);
    const row = await admin.query(`SELECT * FROM request_samples WHERE tenant_id = $1 AND request_id = $2`, [
      tenant.tenantId,
      stored.requestId,
    ]);
    const sample = row.rows[0] as Record<string, unknown>;
    const sampleId = String(sample.id);
    const remover = createPool(configFor(db), 'migrator', undefined, 1);
    try {
      const removed = await runSampleCleanup(remover, {
        idempotencyKey: 'expire-cleanup:harden-restore-clear',
        tenantId: tenant.tenantId,
        now: new Date(Date.now() + 200_000_000),
      });
      expect(removed.removed).toBe(1);
    } finally {
      await remover.end();
    }
    await admin.query(
      `INSERT INTO request_samples (
         id, tenant_id, request_id, policy_id, policy_version, provider, deployment_name,
         data_classification, schema_version, size_bytes, wrapping_key_version,
         wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
         content_iv, content_tag, content_ciphertext, created_at, expires_at,
         fingerprint, slot, task_category, input_size, complexity
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17, $18, $19,
         $20, $21, $22, $23, $24
       )`,
      [
        sample.id,
        sample.tenant_id,
        sample.request_id,
        sample.policy_id,
        sample.policy_version,
        sample.provider,
        sample.deployment_name,
        sample.data_classification,
        sample.schema_version,
        sample.size_bytes,
        sample.wrapping_key_version,
        sample.wrapped_key_iv,
        sample.wrapped_key_tag,
        sample.wrapped_key_ciphertext,
        sample.content_iv,
        sample.content_tag,
        sample.content_ciphertext,
        new Date(Date.now() - 86_400_000),
        new Date(Date.now() - 3_600_000),
        sample.fingerprint,
        sample.slot,
        sample.task_category,
        sample.input_size,
        sample.complexity,
      ],
    );
    const hidden = await fetch(`http://127.0.0.1:${portB}/internal/v1/samples/${sampleId}`, {
      headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
    });
    expect(hidden.status).toBe(404);
    const migrator = createPool(configFor(db), 'migrator', undefined, 1);
    try {
      const cleaned = await runSampleCleanup(migrator, {
        idempotencyKey: 'expire-cleanup:harden-restore',
        tenantId: tenant.tenantId,
      });
      expect(cleaned.removed).toBe(1);
      expect(await storedCount(tenant.tenantId)).toBe(0);
      const reason = await admin.query<{ reason: string }>(
        'SELECT reason FROM sample_deletions WHERE sample_id = $1',
        [sampleId],
      );
      expect(reason.rows[0]?.reason).toBe('expired');
    } finally {
      await migrator.end();
    }
    notes.retention.push('an expired row put back by an administrator stayed hidden', 'cleanup deleted that row again');
  });

  it('fails closed when admission cannot lock and then serves the same database', async () => {
    const locked = makeTenant('Slice 06E Lock');
    const other = makeTenant('Slice 06E Lock Other');
    runCli(
      db,
      [
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        'gpt-h06e',
        '--effective-at',
        new Date(Date.now() - 60_000).toISOString(),
        '--source',
        'fixture',
        '--status',
        'verified',
        '--input-rate',
        '0.01',
      ],
      cliEnv(),
    );
    runCli(db, ['set-tenant-budget', '--tenant-id', locked.tenantId, '--mode', 'hard', '--monthly-amount', '5'], cliEnv());
    const client = new (await import('pg')).default.Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.username,
      password: db.password,
    });
    await client.connect();
    await client.query(`SELECT pg_advisory_lock(hashtextextended('admit:' || $1::text, 0))`, [locked.tenantId]);
    try {
      const hitsBefore = openai.hits.length;
      const denied = await chat(portA, locked, `${MARKER}db-locked`);
      const during = await chat(portB, other, `${MARKER}db-open`);
      expect(denied.status).toBe(503);
      expect(codeOf(denied.text)).toBe('admission_unavailable');
      expect(openai.hits.filter((hit) => contentOf(hit.body) === `${MARKER}db-locked`)).toHaveLength(0);
      expect(during.status).toBe(200);
      expect(openai.hits.length).toBeGreaterThan(hitsBefore);
    } finally {
      await client.query('SELECT pg_advisory_unlock_all()');
      await client.end();
    }
    const after = await chat(portB, locked, `${MARKER}db-after`);
    expect(after.status).toBe(200);
    const still = await admin.query('SELECT 1 AS ok');
    expect(still.rows[0]?.ok).toBe(1);
  });

  it('keeps a stored sample when one proxy process is killed', async () => {
    const tenant = makeTenant('Slice 06E Crash');
    policy(tenant.tenantId, { count: 10, retention: 86_400 });
    const stored = await track(portA, tenant, `${MARKER}crash`);
    expect(stored.stored).toBe(true);
    const pid = childB?.child.pid;
    childB?.child.kill('SIGKILL');
    if (childB !== undefined) await waitForExit(childB.child, 5_000);
    const live = await chat(portA, tenant, `${MARKER}crash-live`);
    expect(live.status).toBe(200);
    expect(await samplesFor(tenant.tenantId, stored.requestId)).toBe(1);
    portB = await freePort();
    childB = spawnServer(
      serviceEnv(db, {
        PORT: String(portB),
        INFERENCE_ENABLED: 'true',
        OPENAI_BASE_URL: openai.baseUrl,
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
        MAX_ACTIVE_STREAMS: '8',
        MAX_STREAMS_PER_TENANT: '4',
      }),
    );
    await waitForReady(portB);
    const again = await chat(portB, tenant, `${MARKER}crash-again`);
    expect(again.status).toBe(200);
    expect(pid).toBeGreaterThan(0);
    notes.worker.push('one proxy was killed after a sample was stored', 'the other proxy still served chat', 'the sample row remained');
  });

  it('records measurements, rollback, and the absence of raw content', async () => {
    const tenant = makeTenant('Slice 06E Measure');
    policy(tenant.tenantId, { mode: 'disabled', content: false });
    for (let index = 0; index < 4; index += 1) {
      const timed = await chat(index % 2 === 0 ? portA : portB, tenant, `${MARKER}time-off-${index}`);
      expect(timed.status).toBe(200);
      figures.disabledMs.push(timed.ms);
    }
    policy(tenant.tenantId, { rate: '0', count: 10, retention: 86_400 });
    for (let index = 0; index < 4; index += 1) {
      const timed = await chat(index % 2 === 0 ? portA : portB, tenant, `${MARKER}time-miss-${index}`);
      expect(timed.status).toBe(200);
      figures.selectionMs.push(timed.ms);
    }
    expect(await storedCount(tenant.tenantId)).toBe(0);
    policy(tenant.tenantId, { rate: '1', streaming: true, count: 20, retention: 86_400 });
    for (let index = 0; index < 4; index += 1) {
      const timed = await track(index % 2 === 0 ? portA : portB, tenant, `${MARKER}time-on-${index}`, {
        task: index % 2 === 0 ? 'coding' : 'writing',
      });
      expect(timed.status).toBe(200);
      expect(timed.stored).toBe(true);
      figures.captureMs.push(timed.ms);
    }

    const cpuStarted = process.cpuUsage();
    const wallStarted = performance.now();
    const iterations = 400;
    for (let index = 0; index < iterations; index += 1) {
      extractRequestFeatures({
        messages: [{ role: 'user', content: `${MARKER}extract ${index}` }],
        stream: false,
        requestedModel: 'chat',
        taskHint: 'coding',
        structuredOutput: false,
        toolRequired: false,
      });
    }
    const cpu = process.cpuUsage(cpuStarted);
    figures.featureUserUs = cpu.user;
    figures.featureSystemUs = cpu.system;
    figures.featureWallMs = performance.now() - wallStarted;
    figures.featureIterations = iterations;

    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'chat' });
    figures.rssBeforeKb = rssKb(childA?.child.pid);
    const memContent = `${MARKER}mem`;
    const mem = chat(portA, tenant, memContent, { stream: true });
    await waitHold(memContent);
    await sleep(50);
    figures.rssDuringKb = rssKb(childA?.child.pid);
    holds.get(memContent)?.();
    holds.delete(memContent);
    const memResult = await mem;
    expect(memResult.status).toBe(200);
    const settledAt = Date.now();
    let finished = false;
    while (Date.now() - settledAt < 8_000) {
      finished = (childA?.output() ?? '')
        .split('\n')
        .some((line) => line.includes('stream sample capture finished') && line.includes(memResult.requestId));
      if (finished) break;
      await sleep(20);
    }
    expect(finished).toBe(true);

    figures.storageEnd = await relationBytes();
    const categories = await admin.query<{ task_category: string; count: number }>(
      `SELECT task_category, count(*)::int AS count
       FROM request_samples WHERE tenant_id = ANY($1::uuid[])
       GROUP BY task_category ORDER BY task_category`,
      [tenantIds],
    );
    expect(categories.rows.length).toBeGreaterThan(0);
    notes.distribution.push(
      'SELECT task_category, count(*) FROM request_samples WHERE tenant_id = ANY($1) GROUP BY task_category',
      ...categories.rows.map((row) => `${row.task_category} ${row.count}`),
    );

    const kept = await track(portB, tenant, `${MARKER}rollback-keep`);
    expect(kept.stored).toBe(true);
    const beforeDisable = await storedCount(tenant.tenantId);
    policy(tenant.tenantId, { mode: 'disabled', content: false });
    const after = await chat(portA, tenant, `${MARKER}rollback-new`);
    expect(after.status).toBe(200);
    expect(await samplesFor(tenant.tenantId, after.requestId)).toBe(0);
    expect(await storedCount(tenant.tenantId)).toBe(beforeDisable);
    const hidden = await fetch(`http://127.0.0.1:${portA}/internal/v1/samples/${(await envelope(tenant.tenantId, kept.requestId)).id}`, {
      headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
    });
    expect(hidden.status).toBe(404);
    const ready = await fetch(`http://127.0.0.1:${portB}/health/ready`);
    expect(ready.status).toBe(200);
    const readyBody = await ready.json();
    expect(readyBody).toEqual({ status: 'ready', database: 'ready' });
    const readyPools = {
      auth: createPool(configFor(db), 'auth', undefined, 1),
      runtime: createPool(configFor(db), 'runtime', undefined, 1),
    };
    const older = buildApp({
      logger: captureLogger().logger,
      authPool: readyPools.auth,
      runtimePool: readyPools.runtime,
      readyVersion: '019_sample_retention.sql',
      inferenceEnabled: false,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey: null,
      maxActiveStreams: 1,
      maxStreamsPerTenant: 1,
    });
    const olderReady = await older.inject({ method: 'GET', url: '/health/ready' });
    expect(olderReady.statusCode).toBe(200);
    await older.close();
    await readyPools.auth.end();
    await readyPools.runtime.end();
    notes.rollback.push(
      'metadata mode stored no content',
      'disabled mode stored no new sample',
      'the earlier ciphertext row remained until cleanup',
      'the sample route returned 404 after capture was disabled',
      `readiness ${ready.status} ${JSON.stringify(readyBody)}`,
      'readiness for 019_sample_retention.sql returned 200',
    );

    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const summary = await fetch(
      `http://127.0.0.1:${portA}/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` } },
    );
    const features = await fetch(`http://127.0.0.1:${portA}/internal/v1/request-features`, {
      headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
    });
    const samples = await fetch(`http://127.0.0.1:${portA}/internal/v1/samples`, {
      headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
    });
    expect(summary.status).toBe(200);
    const metricText = `${await summary.text()}\n${await features.text()}\n${await samples.text()}`;
    expect(metricText).not.toContain(MARKER);
    expect(logs()).not.toContain(MARKER);
    expect(logs()).not.toContain('z'.repeat(64));

    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    const disabledMean = mean(figures.disabledMs);
    const selectionMean = mean(figures.selectionMs);
    const captureMean = mean(figures.captureMs);
    const source = readFileSync(join(projectRoot, 'src/inference/sample-jobs.ts'), 'utf8');
    const interval = Number((source.match(/CLEANUP_INTERVAL_MS = ([\d_]+)/)?.[1] ?? '').replaceAll('_', ''));
    expect(Number.isFinite(disabledMean)).toBe(true);
    expect(Number.isFinite(selectionMean)).toBe(true);
    expect(Number.isFinite(captureMean)).toBe(true);
    expect(figures.featureIterations).toBe(iterations);
    expect(figures.captureAttempts).toBeGreaterThan(0);
    expect(figures.decryptSuccesses).toBeGreaterThan(0);
    expect(figures.decryptFailures).toBeGreaterThan(0);
    expect(figures.isolationPass).toBe(1);
    expect(Number.isFinite(figures.expiryDelayMs)).toBe(true);
    expect(Number.isFinite(figures.rssBeforeKb)).toBe(true);
    expect(Number.isFinite(figures.rssDuringKb)).toBe(true);
    expect(interval).toBe(60_000);

    const successRate = figures.captureStored / figures.captureAttempts;
    notes.measure.push(
      'command: npm test -- test/production-hardening.test.ts',
      'host figures from this run are not a production SLO',
      `additional_inference_latency_ms ${captureMean - disabledMean}`,
      `capture_on_mean_ms ${captureMean}`,
      `capture_off_mean_ms ${disabledMean}`,
      `selection_overhead_ms ${selectionMean - disabledMean}`,
      `selection_mean_ms ${selectionMean}`,
      `feature_cpu_user_us ${figures.featureUserUs}`,
      `feature_cpu_system_us ${figures.featureSystemUs}`,
      `feature_wall_ms ${figures.featureWallMs}`,
      `feature_iterations ${figures.featureIterations}`,
      `capture_attempts ${figures.captureAttempts}`,
      `capture_stored ${figures.captureStored}`,
      `capture_miss ${figures.captureAttempts - figures.captureStored}`,
      `capture_success_rate ${successRate}`,
      `rss_before_kb ${figures.rssBeforeKb}`,
      `rss_during_kb ${figures.rssDuringKb}`,
      `rss_delta_kb ${figures.rssDuringKb - figures.rssBeforeKb}`,
      `request_samples_bytes_start ${figures.storageStart}`,
      `request_samples_bytes_end ${figures.storageEnd}`,
      `request_samples_bytes_growth ${figures.storageEnd - figures.storageStart}`,
      `cleanup_backlog_after_crash ${figures.backlogAfterCrash}`,
      `cleanup_backlog_after_recovery ${figures.backlogAfterRecovery}`,
      `expiry_to_deletion_ms ${figures.expiryDelayMs}`,
      `worker_interval_ms ${interval}`,
      `decrypt_failures ${figures.decryptFailures}`,
      `decrypt_successes ${figures.decryptSuccesses}`,
      `tenant_isolation ${figures.isolationPass === 1 ? 'pass' : 'fail'}`,
    );
    for (const line of notes.measure) expect(line.includes(MARKER)).toBe(false);

    if (EVIDENCE !== undefined && EVIDENCE.length > 0) {
      mkdirSync(EVIDENCE, { recursive: true });
      const files: Array<[string, string[]]> = [
        ['measurements.txt', notes.measure],
        ['encryption.txt', notes.encryption],
        ['tenant-isolation.txt', notes.isolation],
        ['sample-distribution.txt', notes.distribution],
        ['retention.txt', notes.retention],
        ['worker-recovery.txt', notes.worker],
        ['rollback.txt', notes.rollback],
      ];
      for (const [name, lines] of files) {
        const text = `${lines.join('\n')}\n`;
        if (text.includes(MARKER)) throw new Error(`evidence contains sample text: ${name}`);
        writeFileSync(join(EVIDENCE, name), text);
      }
    }
  });
});
