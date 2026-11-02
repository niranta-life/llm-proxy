import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';
import type { VertexEmbedRequest, VertexGenerateClient } from '../src/inference/vertex-client.js';
import { canonicalDecimal } from '../src/inference/cost.js';
import {
  cliEntry,
  createTestApp,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
  type TestDatabase,
} from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant, registerAnthropic } from './inference-support.js';
import { startMockUpstream, type MockHit } from './mock-openai.js';
import { pinResolver, registerPrivate } from './private-support.js';

const EVIDENCE = join(projectRoot, 'evidence', 'slice-10e');
const PHRASE = 'embed-secret-phrase';
const MARKER = 0.424242;
const SAFE = [0.5, 0.25, -0.5, 0.125];
const UNIT = [0.5, 0.5, 0.5, 0.5];
const EFFECTIVE = '2026-01-01T00:00:00.000Z';
const WINDOW = `from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`;
const VERTEX_EMAIL = 'embed-bot@embed-vertex-proj.iam.gserviceaccount.com';
const VERTEX_KEY = JSON.stringify({ client_email: VERTEX_EMAIL, private_key: `embed-${'k'.repeat(80)}` });

const db = loadTestDatabase();
const closers: Array<() => Promise<void>> = [];
const vertexCalls: VertexEmbedRequest[] = [];
let openaiHits: MockHit[] = [];
let privateHits = 0;
let liveHits = 0;
let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let lines: string[] = [];
let admin: ReturnType<typeof adminPool>;
let port = 0;

const caller = { tenantId: '', secret: '' };
const other = { tenantId: '', secret: '' };
const budgetTenant = { tenantId: '', secret: '' };
const rateTenant = { tenantId: '', secret: '' };
const privateTenant = { tenantId: '', secret: '' };
const rawTenant = { tenantId: '', secret: '' };
const liveTenant = { tenantId: '', secret: '' };

const saved: {
  fixtures: Record<string, unknown>;
  api: Record<string, unknown>;
  db: Record<string, unknown>;
} = { fixtures: {}, api: {}, db: {} };

function markerVector(index: number, dimension: number): number[] {
  const values = Array.from({ length: dimension }, () => 0);
  if (dimension > 0) values[0] = MARKER;
  if (dimension > 1) values[1] = (index + 1) / 10;
  return values;
}

function encodeFloat32(values: readonly number[]): string {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer.toString('base64');
}

function decodeFloat32(encoded: string): number[] {
  const buffer = Buffer.from(encoded, 'base64');
  const values: number[] = [];
  for (let offset = 0; offset < buffer.length; offset += 4) values.push(buffer.readFloatLE(offset));
  return values;
}

function vectorFor(model: string, text: string, index: number, dimension: number): number[] {
  if (model === 'text-embedding-ada-002') return Array.from({ length: 1536 }, () => 0.001);
  if (text.includes('safe-float')) return [...SAFE];
  if (text.includes('unit-vector')) return [...UNIT];
  if (text.includes('skew-vector')) return [MARKER, 0, 0, 0];
  return markerVector(index, dimension);
}

function embeddingPayload(parsed: {
  model?: string;
  input?: string[];
  dimensions?: number;
  encoding_format?: string;
}): { status: number; body: string } {
  const inputs = Array.isArray(parsed.input) ? parsed.input : [];
  const model = parsed.model ?? '';
  if (inputs.some((item) => item.includes('provider-error'))) {
    return { status: 500, body: JSON.stringify({ error: PHRASE, embedding: [MARKER] }) };
  }
  const dimension = typeof parsed.dimensions === 'number' ? parsed.dimensions : model === 'text-embedding-ada-002' ? 1536 : 0;
  const prompt = inputs[0] === PHRASE ? 303 : 4 * Math.max(inputs.length, 1);
  const usage = { prompt_tokens: prompt, total_tokens: prompt };
  if (inputs.some((item) => item.includes('bad-count'))) {
    return {
      status: 200,
      body: JSON.stringify({ object: 'list', model, data: [{ index: 0, embedding: markerVector(0, dimension) }], usage }),
    };
  }
  if (inputs.some((item) => item.includes('non-finite'))) {
    return {
      status: 200,
      body: `{"object":"list","model":${JSON.stringify(model)},"data":[{"index":0,"embedding":[1e309,0,0,0]}],"usage":{"prompt_tokens":4,"total_tokens":4}}`,
    };
  }
  if (inputs.some((item) => item.includes('null-component'))) {
    return {
      status: 200,
      body: JSON.stringify({ object: 'list', model, data: [{ index: 0, embedding: [null, 0, 0, 0] }], usage }),
    };
  }
  if (inputs.some((item) => item.includes('short-vector'))) {
    return {
      status: 200,
      body: JSON.stringify({ object: 'list', model, data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage }),
    };
  }
  if (inputs.some((item) => item.includes('switched-model'))) {
    return {
      status: 200,
      body: JSON.stringify({
        object: 'list',
        model: 'other-embedding',
        data: inputs.map((text, index) => ({ index, embedding: vectorFor(model, text, index, dimension) })),
        usage,
      }),
    };
  }
  let data = inputs.map((text, index) => {
    const values = vectorFor(model, text, index, dimension);
    const embedding = parsed.encoding_format === 'base64' ? encodeFloat32(values) : values;
    return { object: 'embedding', index, embedding };
  });
  if (inputs.some((item) => item.includes('reversed-batch'))) data = [...data].reverse();
  return { status: 200, body: JSON.stringify({ object: 'list', model, data, usage }) };
}

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
  };
}

async function post(
  tenant: { tenantId: string; secret: string },
  body: unknown,
): Promise<{ statusCode: number; json: () => unknown }> {
  return app.inject({
    method: 'POST',
    url: '/v1/embeddings',
    headers: authHeaders(tenant.tenantId, tenant.secret),
    payload: body,
  });
}

function messageOf(response: { json: () => unknown }): string {
  const body = response.json() as { error?: { message?: string; code?: string } };
  return body.error?.message ?? '';
}

function codeOf(response: { json: () => unknown }): string {
  const body = response.json() as { error?: { code?: string } };
  return body.error?.code ?? '';
}

function price(provider: string, model: string): void {
  runCli(
    db,
    [
      'register-price',
      '--provider',
      provider,
      '--upstream-model',
      model,
      '--effective-at',
      EFFECTIVE,
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '0.01',
    ],
    cliEnv(),
  );
}

function pin(tenantId: string, deployment: string, dimension: number, normalization: 'none' | 'l2'): void {
  runCli(
    db,
    [
      'register-embedding-contract',
      '--tenant-id',
      tenantId,
      '--deployment',
      deployment,
      '--dimension',
      String(dimension),
      '--normalization',
      normalization,
    ],
    cliEnv(),
  );
}

function openaiDeployment(
  tenantId: string,
  name: string,
  model: string,
  dimension: number,
  normalization: 'none' | 'l2' = 'none',
  enabled = true,
): void {
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--name',
      name,
      '--upstream-model',
      model,
      '--timeout-ms',
      '5000',
      '--capabilities',
      'embeddings',
      '--enabled',
      enabled ? 'true' : 'false',
    ],
    cliEnv(),
  );
  pin(tenantId, name, dimension, normalization);
}

function vertexDeployment(tenantId: string, name: string, model: string, dimension: number): void {
  runCli(
    db,
    [
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--provider',
      'vertex',
      '--name',
      name,
      '--upstream-model',
      model,
      '--timeout-ms',
      '5000',
      '--capabilities',
      'embeddings',
      '--enabled',
      'true',
    ],
    cliEnv(),
  );
  pin(tenantId, name, dimension, 'none');
}

describe('embeddings', () => {
  beforeAll(async () => {
    const openai = await startMockUpstream((hit, _request, response) => {
      openaiHits.push(hit);
      const parsed = JSON.parse(hit.body) as {
        model?: string;
        input?: string[];
        dimensions?: number;
        encoding_format?: string;
      };
      const result = embeddingPayload(parsed);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    });
    const created = provisionTenant(db, 'Embeddings');
    const outsider = provisionTenant(db, 'Embeddings Other');
    const budgeted = provisionTenant(db, 'Embeddings Budget');
    const rated = provisionTenant(db, 'Embeddings Rate');
    const loopback = provisionTenant(db, 'Embeddings Private');
    const raw = provisionTenant(db, 'Embeddings Raw');
    const live = provisionTenant(db, 'Embeddings Live');
    caller.tenantId = created.tenantId;
    caller.secret = created.secret;
    other.tenantId = outsider.tenantId;
    other.secret = outsider.secret;
    budgetTenant.tenantId = budgeted.tenantId;
    budgetTenant.secret = budgeted.secret;
    rateTenant.tenantId = rated.tenantId;
    rateTenant.secret = rated.secret;
    privateTenant.tenantId = loopback.tenantId;
    privateTenant.secret = loopback.secret;
    rawTenant.tenantId = raw.tenantId;
    rawTenant.secret = raw.secret;
    liveTenant.tenantId = live.tenantId;
    liveTenant.secret = live.secret;
    const env = cliEnv();
    runCli(db, ['register-openai-connection', '--tenant-id', caller.tenantId, '--api-key', 'sk-embed-openai'], env);
    openaiDeployment(caller.tenantId, 'embed-small', 'text-embedding-3-small', 4);
    openaiDeployment(caller.tenantId, 'embed-large', 'text-embedding-3-large', 4);
    openaiDeployment(caller.tenantId, 'embed-ada', 'text-embedding-ada-002', 1536);
    openaiDeployment(caller.tenantId, 'embed-ada-bad', 'text-embedding-ada-002', 4);
    openaiDeployment(caller.tenantId, 'embed-chat', 'gpt-4o', 4);
    openaiDeployment(caller.tenantId, 'embed-giant', 'text-embedding-3-giant', 4);
    openaiDeployment(caller.tenantId, 'embed-unit', 'text-embedding-3-small', 4, 'l2');
    openaiDeployment(caller.tenantId, 'embed-switch', 'text-embedding-3-small', 4);
    openaiDeployment(caller.tenantId, 'embed-off', 'text-embedding-3-small', 4, 'none', false);
    price('openai', 'text-embedding-3-small');
    price('openai', 'text-embedding-3-large');
    price('openai', 'text-embedding-ada-002');
    runCli(
      db,
      [
        'set-deployment-data-class',
        '--tenant-id',
        caller.tenantId,
        '--deployment',
        'embed-small',
        '--data-class',
        'internal',
      ],
      env,
    );
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        caller.tenantId,
        '--mode',
        'encrypted_sample',
        '--content-capture',
        'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '10',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        'openai',
        '--deployments',
        'embed-small',
      ],
      env,
    );
    runCli(
      db,
      [
        'register-vertex-connection',
        '--tenant-id',
        caller.tenantId,
        '--api-key',
        VERTEX_KEY,
        '--project',
        'embed-vertex-proj',
        '--location',
        'us-central1',
        '--service-account',
        VERTEX_EMAIL,
      ],
      env,
    );
    vertexDeployment(caller.tenantId, 'embed-004', 'text-embedding-004', 4);
    vertexDeployment(caller.tenantId, 'embed-005', 'text-embedding-005', 4);
    vertexDeployment(caller.tenantId, 'embed-gemini', 'gemini-embedding-001', 8);
    vertexDeployment(caller.tenantId, 'embed-flash', 'gemini-2.5-flash', 4);
    vertexDeployment(caller.tenantId, 'embed-004-wide', 'text-embedding-004', 800);
    price('vertex', 'text-embedding-004');
    price('vertex', 'text-embedding-005');
    price('vertex', 'gemini-embedding-001');
    registerPrivate(db, {
      tenantId: privateTenant.tenantId,
      apiKey: 'dgx-embed-secret',
      host: '127.0.0.1',
      port: 8443,
      addresses: ['127.0.0.1'],
      endpoint: 'https://127.0.0.1:8443/v1',
      deployment: 'embed-private',
      upstreamModel: 'private-embed',
      enabled: true,
    });
    registerPrivate(db, {
      tenantId: rawTenant.tenantId,
      apiKey: 'dgx-raw-secret',
      host: '127.0.0.1',
      port: 8444,
      addresses: ['127.0.0.1'],
      endpoint: 'https://127.0.0.1:8444/v1',
      deployment: 'embed-raw',
      upstreamModel: 'private-embed-raw',
      enabled: true,
    });
    registerPrivate(db, {
      tenantId: liveTenant.tenantId,
      apiKey: 'dgx-live-secret',
      deployment: 'embed-live',
      upstreamModel: 'private-embed-live',
      enabled: true,
    });
    for (const ready of [
      { tenantId: privateTenant.tenantId, deployment: 'embed-private', validate: true },
      { tenantId: rawTenant.tenantId, deployment: 'embed-raw', validate: false },
      { tenantId: liveTenant.tenantId, deployment: 'embed-live', validate: true },
    ]) {
      runCli(
        db,
        ['set-deployment-capabilities', '--tenant-id', ready.tenantId, '--deployment', ready.deployment, '--capabilities', 'embeddings'],
        env,
      );
      if (ready.validate) {
        runCli(
          db,
          ['validate-deployment', '--tenant-id', ready.tenantId, '--deployment', ready.deployment, '--status', 'validated_mock'],
          env,
        );
        pin(ready.tenantId, ready.deployment, 4, 'none');
      }
    }
    for (const tenant of [budgetTenant, rateTenant]) {
      runCli(db, ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-embed-limited'], env);
      openaiDeployment(tenant.tenantId, 'embed-small', 'text-embedding-3-small', 4);
    }
    runCli(
      db,
      ['set-tenant-budget', '--tenant-id', budgetTenant.tenantId, '--mode', 'hard', '--monthly-amount', '0'],
      env,
    );
    runCli(
      db,
      ['set-tenant-limits', '--tenant-id', rateTenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1'],
      env,
    );
    price('dgx', 'private-embed');
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('dgx.lab.internal')) {
        liveHits += 1;
        return new Response('live', { status: 500 });
      }
      if (url.includes('127.0.0.1:8443') || url.includes('127.0.0.1:8444')) {
        privateHits += 1;
        const body = typeof init?.body === 'string' ? init.body : '';
        const result = embeddingPayload(JSON.parse(body) as { model?: string; input?: string[]; dimensions?: number });
        return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
      }
      return fetch(input, init);
    };
    const factory = async (): Promise<VertexGenerateClient> => ({
      async generateContent() {
        throw new Error('embeddings do not use vertex chat');
      },
      generateContentStream() {
        throw new Error('embeddings do not use vertex stream');
      },
      async listModels() {},
      async embedContent(request) {
        vertexCalls.push(request);
        const contents = request.contents;
        const dimension = request.config?.outputDimensionality ?? 0;
        if (contents.some((item) => item.includes('vertex-down'))) throw new Error(PHRASE);
        if (contents.some((item) => item.includes('vertex-truncated'))) {
          return {
            embeddings: contents.map((_, index) => ({
              values: markerVector(index, dimension),
              statistics: { tokenCount: 4, truncated: true },
            })),
          };
        }
        if (contents.some((item) => item.includes('vertex-bad-count'))) {
          return { embeddings: [{ values: markerVector(0, dimension), statistics: { tokenCount: 4 } }] };
        }
        if (contents.some((item) => item.includes('vertex-non-finite'))) {
          return { embeddings: [{ values: [Number.POSITIVE_INFINITY, 0, 0, 0], statistics: { tokenCount: 4 } }] };
        }
        return {
          embeddings: contents.map((text, index) => ({
            values: vectorFor('vertex', text, index, dimension),
            statistics: { tokenCount: 4 },
          })),
        };
      },
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      vertexClientFactory: factory,
      compatibleFetch: fetchImpl,
      privateResolve: pinResolver('127.0.0.1'),
    });
    app = ctx.app;
    lines = ctx.lines;
    admin = adminPool(db);
    port = await freePort();
    await app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
      await openai.close();
    });
  });

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'fixtures.json'), `${JSON.stringify(saved.fixtures, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'api-proof.json'), `${JSON.stringify(saved.api, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'db-proof.json'), `${JSON.stringify(saved.db, null, 2)}\n`);
    console.log(`SDK_PROOF ${JSON.stringify(saved.api.sdk ?? {})}`);
    console.log(`DB_PROOF ${JSON.stringify(saved.db)}`);
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('returns one finite vector for one text input', async () => {
    const before = openaiHits.length;
    const response = await post(caller, { model: 'embed-small', input: 'one text' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: string;
      model: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('list');
    expect(body.model).toBe('embed-small');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ object: 'embedding', index: 0 });
    expect(body.data[0]?.embedding).toEqual(markerVector(0, 4));
    expect(body.usage).toEqual({ prompt_tokens: 4, total_tokens: 4 });
    expect(body.usage).not.toHaveProperty('completion_tokens');
    expect(openaiHits).toHaveLength(before + 1);
    const upstream = JSON.parse(openaiHits[before]?.body ?? '{}') as { input?: unknown; dimensions?: number; encoding_format?: string };
    expect(upstream.input).toEqual(['one text']);
    expect(upstream.dimensions).toBe(4);
    expect(upstream.encoding_format).toBe('float');
    saved.fixtures.one = { input: 'one text', vector: body.data[0]?.embedding, dimension: 4 };
  });

  it('returns one vector per input in input order', async () => {
    const response = await post(caller, { model: 'embed-small', input: ['alpha', 'beta'] });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ index: number; embedding: number[] }> };
    expect(body.data.map((item) => item.index)).toEqual([0, 1]);
    expect(body.data[0]?.embedding).toEqual(markerVector(0, 4));
    expect(body.data[1]?.embedding).toEqual(markerVector(1, 4));
  });

  it('keeps provider index order on the public body', async () => {
    const response = await post(caller, { model: 'embed-small', input: ['reversed-batch', 'beta', 'gamma'] });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ index: number; embedding: number[] }> };
    expect(body.data.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(body.data[2]?.embedding[1]).toBe(0.3);
  });

  it('serves the three-input journey on the pinned deployment', async () => {
    const before = openaiHits.length;
    const logFrom = lines.length;
    const inputs = [PHRASE, 'second text', 'third text'];
    const response = await post(caller, { model: 'embed-small', input: inputs });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: string;
      model: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body).toMatchObject({ object: 'list', model: 'embed-small' });
    expect(body.data).toHaveLength(3);
    body.data.forEach((item, index) => {
      expect(item.object).toBe('embedding');
      expect(item.index).toBe(index);
      expect(item.embedding).toEqual(markerVector(index, 4));
      expect(item.embedding.every((value) => Number.isFinite(value))).toBe(true);
    });
    expect(body.usage).toEqual({ prompt_tokens: 303, total_tokens: 303 });
    expect(openaiHits).toHaveLength(before + 1);
    const logged = lines.slice(logFrom).join('\n');
    expect(logged).toContain('embedding completed');
    expect(logged).not.toContain(PHRASE);
    expect(logged).not.toContain(String(MARKER));
    expect(redact({ embedding: [MARKER], embeddings: [[MARKER]], note: 'kept' })).toEqual({
      embedding: '[REDACTED]',
      embeddings: '[REDACTED]',
      note: 'kept',
    });
    saved.fixtures.journey = { inputs, vectors: body.data.map((item) => item.embedding), dimension: 4 };
    saved.api.journey = body;
    saved.db.log = {
      containsInput: logged.includes(PHRASE),
      containsVectorComponent: logged.includes(String(MARKER)),
      recordedCompletion: logged.includes('embedding completed'),
    };
  });

  it('rejects empty input before the provider call', async () => {
    const before = openaiHits.length;
    const attempts = await attemptCount(caller.tenantId);
    const missing = await post(caller, { model: 'embed-small' });
    const blank = await post(caller, { model: 'embed-small', input: '' });
    const emptyBatch = await post(caller, { model: 'embed-small', input: [] });
    const hole = await post(caller, { model: 'embed-small', input: ['kept', ''] });
    for (const response of [missing, blank, emptyBatch, hole]) {
      expect(response.statusCode).toBe(400);
      expect(messageOf(response)).toBe('The input is empty.');
      expect(JSON.stringify(response.json())).not.toContain(String(MARKER));
    }
    expect(openaiHits).toHaveLength(before);
    expect(await attemptCount(caller.tenantId)).toBe(attempts);
  });

  it('rejects an over-long input and an over-long batch before the provider call', async () => {
    const before = openaiHits.length;
    const tooLong = await post(caller, { model: 'embed-small', input: 'x'.repeat(8193) });
    const batch = await post(caller, { model: 'embed-small', input: Array.from({ length: 33 }, () => 'a') });
    expect(tooLong.statusCode).toBe(400);
    expect(messageOf(tooLong)).toBe('The input is too long.');
    expect(batch.statusCode).toBe(400);
    expect(messageOf(batch)).toBe('The input batch is too long.');
    expect(openaiHits).toHaveLength(before);
  });

  it('rejects a dimension that is not the pin', async () => {
    const before = openaiHits.length;
    const mismatch = await post(caller, { model: 'embed-small', input: 'sized', dimensions: 8 });
    const fraction = await post(caller, { model: 'embed-small', input: 'sized', dimensions: 4.5 });
    const text = await post(caller, { model: 'embed-small', input: 'sized', dimensions: '4' });
    const empty = await post(caller, { model: 'embed-small', input: 'sized', dimensions: null });
    expect(mismatch.statusCode).toBe(400);
    expect(messageOf(mismatch)).toBe('The dimension does not match the contract.');
    for (const response of [fraction, text, empty]) {
      expect(response.statusCode).toBe(400);
      expect(messageOf(response)).toBe('The dimension is invalid.');
    }
    expect(openaiHits).toHaveLength(before);
    saved.fixtures.dimensions = [
      { model: 'text-embedding-3-small', pin: 4, request: 8, accepted: false },
      { model: 'text-embedding-ada-002', pin: 4, accepted: false },
      { model: 'text-embedding-004', pin: 800, accepted: false },
    ];
  });

  it('rejects ada-002 unless the pin is 1536 and omits dimensions upstream', async () => {
    const before = openaiHits.length;
    const rejected = await post(caller, { model: 'embed-ada-bad', input: 'ada' });
    expect(rejected.statusCode).toBe(400);
    expect(messageOf(rejected)).toBe('The dimension is invalid.');
    expect(openaiHits).toHaveLength(before);
    const accepted = await post(caller, { model: 'embed-ada', input: 'ada' });
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json() as { data: Array<{ embedding: number[] }> };
    expect(body.data[0]?.embedding).toHaveLength(1536);
    expect(body.data[0]?.embedding.every((value) => value === 0.001)).toBe(true);
    const upstream = JSON.parse(openaiHits[before]?.body ?? '{}') as { dimensions?: number; model?: string };
    expect(upstream.model).toBe('text-embedding-ada-002');
    expect(upstream.dimensions).toBeUndefined();
    saved.fixtures.ada = { dimension: 1536, uniform: 0.001, upstreamDimensions: false };
  });

  it('rejects an unsupported encoding and accepts OpenAI base64 that decodes to the float vector', async () => {
    const before = openaiHits.length;
    const vertexBefore = vertexCalls.length;
    const privateBefore = privateHits;
    const int8 = await post(caller, { model: 'embed-small', input: 'safe-float', encoding_format: 'int8' });
    const absent = await post(caller, { model: 'embed-small', input: 'safe-float', encoding_format: null });
    const vertex = await post(caller, { model: 'embed-004', input: 'safe-float', encoding_format: 'base64' });
    const local = await post(privateTenant, { model: 'embed-private', input: 'safe-float', encoding_format: 'base64' });
    for (const response of [int8, absent, vertex, local]) {
      expect(response.statusCode).toBe(400);
      expect(messageOf(response)).toBe('The encoding is not supported.');
    }
    expect(openaiHits).toHaveLength(before);
    expect(vertexCalls).toHaveLength(vertexBefore);
    expect(privateHits).toBe(privateBefore);
    const floats = await post(caller, { model: 'embed-small', input: 'safe-float' });
    const encoded = await post(caller, { model: 'embed-small', input: 'safe-float', encoding_format: 'base64' });
    expect(floats.statusCode).toBe(200);
    expect(encoded.statusCode).toBe(200);
    const floatBody = floats.json() as { data: Array<{ embedding: number[] }> };
    const encodedBody = encoded.json() as { data: Array<{ embedding: string }> };
    expect(floatBody.data[0]?.embedding).toEqual(SAFE);
    expect(decodeFloat32(encodedBody.data[0]?.embedding ?? '')).toEqual(floatBody.data[0]?.embedding);
    saved.fixtures.base64 = {
      floats: SAFE,
      encoded: encodedBody.data[0]?.embedding,
      decoded: decodeFloat32(encodedBody.data[0]?.embedding ?? ''),
    };
  });

  it('rejects a bad vector count, a non-finite value, and a vector-space mismatch', async () => {
    const count = await post(caller, { model: 'embed-small', input: ['bad-count', 'second'] });
    const finite = await post(caller, { model: 'embed-small', input: 'non-finite' });
    const empty = await post(caller, { model: 'embed-small', input: 'null-component' });
    const space = await post(caller, { model: 'embed-small', input: 'short-vector' });
    const skew = await post(caller, { model: 'embed-unit', input: 'skew-vector' });
    const unit = await post(caller, { model: 'embed-unit', input: 'unit-vector' });
    expect(count.statusCode).toBe(502);
    expect(messageOf(count)).toBe('The embedding response is invalid.');
    expect(finite.statusCode).toBe(502);
    expect(messageOf(finite)).toBe('The embedding response is invalid.');
    expect(empty.statusCode).toBe(502);
    expect(messageOf(empty)).toBe('The embedding response is invalid.');
    expect(space.statusCode).toBe(502);
    expect(messageOf(space)).toBe('The vector space does not match the contract.');
    expect(skew.statusCode).toBe(502);
    expect(messageOf(skew)).toBe('The vector space does not match the contract.');
    expect(unit.statusCode).toBe(200);
    const unitBody = unit.json() as { data: Array<{ embedding: number[] }> };
    expect(unitBody.data[0]?.embedding).toEqual(UNIT);
    for (const response of [count, finite, empty, space, skew]) {
      expect(JSON.stringify(response.json())).not.toContain('"embedding":[');
    }
    saved.fixtures.unit = UNIT;
  });

  it('stores a provider failure and returns no vectors', async () => {
    const before = openaiHits.length;
    const response = await post(caller, { model: 'embed-small', input: 'provider-error' });
    expect(response.statusCode).toBe(502);
    expect(messageOf(response)).toBe('The upstream provider failed.');
    expect(JSON.stringify(response.json())).not.toContain(PHRASE);
    expect(JSON.stringify(response.json())).not.toContain(String(MARKER));
    expect(openaiHits).toHaveLength(before + 1);
    const logged = lines.join('\n');
    expect(logged).not.toContain(PHRASE);
  });

  it('refuses a chat model and an unapproved embedding model before the provider call', async () => {
    const before = openaiHits.length;
    const chat = await post(caller, { model: 'embed-chat', input: 'chat' });
    const giant = await post(caller, { model: 'embed-giant', input: 'giant' });
    const flash = await post(caller, { model: 'embed-flash', input: 'flash' });
    for (const response of [chat, giant, flash]) {
      expect(response.statusCode).toBe(400);
      expect(messageOf(response)).toBe('The embedding model is not approved.');
    }
    expect(openaiHits).toHaveLength(before);
    expect(vertexCalls).toHaveLength(0);
  });

  it('serves approved Vertex models and refuses a truncated or bad Vertex vector', async () => {
    const small = await post(caller, { model: 'embed-004', input: ['vertex one', 'vertex two', 'vertex three'] });
    const next = await post(caller, { model: 'embed-005', input: 'vertex five' });
    const gemini = await post(caller, { model: 'embed-gemini', input: 'vertex gemini' });
    expect(small.statusCode).toBe(200);
    const smallBody = small.json() as { object: string; model: string; data: Array<{ index: number; embedding: number[] }>; usage: { prompt_tokens: number; total_tokens: number } };
    expect(smallBody.object).toBe('list');
    expect(smallBody.model).toBe('embed-004');
    expect(smallBody.data).toHaveLength(3);
    expect(smallBody.data.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(smallBody.data[0]?.embedding).toHaveLength(4);
    expect(smallBody.usage.prompt_tokens).toBe(12);
    expect(smallBody.usage.total_tokens).toBe(12);
    expect(next.statusCode).toBe(200);
    expect(gemini.statusCode).toBe(200);
    const geminiBody = gemini.json() as { data: Array<{ embedding: number[] }> };
    expect(geminiBody.data[0]?.embedding).toHaveLength(8);
    const sent = vertexCalls.find((call) => call.model === 'text-embedding-004');
    expect(sent?.config?.autoTruncate).toBe(false);
    expect(sent?.config?.outputDimensionality).toBe(4);
    expect(sent?.contents).toEqual(['vertex one', 'vertex two', 'vertex three']);
    const truncated = await post(caller, { model: 'embed-004', input: 'vertex-truncated' });
    const count = await post(caller, { model: 'embed-004', input: ['vertex-bad-count', 'other'] });
    const finite = await post(caller, { model: 'embed-004', input: 'vertex-non-finite' });
    const down = await post(caller, { model: 'embed-004', input: 'vertex-down' });
    expect(messageOf(truncated)).toBe('The vector space does not match the contract.');
    expect(messageOf(count)).toBe('The embedding response is invalid.');
    expect(messageOf(finite)).toBe('The embedding response is invalid.');
    expect(down.statusCode).toBe(502);
    expect(messageOf(down)).toBe('The upstream provider failed.');
    expect(JSON.stringify(down.json())).not.toContain(PHRASE);
    expect(lines.join('\n')).not.toContain(PHRASE);
    saved.api.vertex = { model: smallBody.model, count: smallBody.data.length, dimension: 4, usage: smallBody.usage };
  });

  it('refuses a wide Vertex pin and a disabled deployment before the provider call', async () => {
    const before = vertexCalls.length;
    const wide = await post(caller, { model: 'embed-004-wide', input: 'wide' });
    expect(wide.statusCode).toBe(400);
    expect(messageOf(wide)).toBe('The dimension is invalid.');
    const off = await post(caller, { model: 'embed-off', input: 'off' });
    expect(off.statusCode).toBe(404);
    expect(messageOf(off)).toBe('The model is not available.');
    expect(vertexCalls).toHaveLength(before);
  });

  it('serves a loopback private mock and refuses a live or unvalidated host', async () => {
    const raw = await post(rawTenant, { model: 'embed-raw', input: 'too soon' });
    expect(raw.statusCode).toBe(400);
    expect(messageOf(raw)).toBe('A live private host does not receive embeddings.');
    expect(privateHits).toBe(0);
    expect(liveHits).toBe(0);
    const accepted = await post(privateTenant, { model: 'embed-private', input: ['local one', 'local two', 'local three'] });
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json() as { object: string; model: string; data: Array<{ index: number; embedding: number[] }> };
    expect(body.object).toBe('list');
    expect(body.model).toBe('embed-private');
    expect(body.data).toHaveLength(3);
    expect(body.data[0]?.embedding).toHaveLength(4);
    expect(privateHits).toBe(1);
    expect(liveHits).toBe(0);
    runCli(
      db,
      ['confirm-live-deployment', '--tenant-id', privateTenant.tenantId, '--deployment', 'embed-private'],
      cliEnv(),
    );
    const confirmed = await post(privateTenant, { model: 'embed-private', input: 'after live' });
    expect(confirmed.statusCode).toBe(400);
    expect(messageOf(confirmed)).toBe('A live private host does not receive embeddings.');
    expect(privateHits).toBe(1);
    const remote = await post(liveTenant, { model: 'embed-live', input: 'remote' });
    expect(remote.statusCode).toBe(400);
    expect(messageOf(remote)).toBe('A live private host does not receive embeddings.');
    expect(liveHits).toBe(0);
    saved.api.private = { model: body.model, count: body.data.length, dimension: body.data[0]?.embedding.length };
  });

  it('denies a hard budget and a rate limit before the provider call', async () => {
    const before = openaiHits.length;
    const blocked = await post(budgetTenant, { model: 'embed-small', input: 'budget-me' });
    expect(blocked.statusCode).toBe(429);
    expect(codeOf(blocked)).toBe('budget_exceeded');
    expect(messageOf(blocked)).toBe('The budget limit was reached.');
    expect(openaiHits).toHaveLength(before);
    const first = await post(rateTenant, { model: 'embed-small', input: 'rate-one' });
    expect(first.statusCode).toBe(200);
    const second = await post(rateTenant, { model: 'embed-small', input: 'rate-two' });
    expect(second.statusCode).toBe(429);
    expect(codeOf(second)).toBe('tenant_rate_limited');
    expect(openaiHits).toHaveLength(before + 1);
    const denied = await admin.query<{ status: string; error_code: string; dispatched: boolean }>(
      `SELECT status, error_code, dispatched
       FROM model_attempts
       WHERE tenant_id = $1 AND error_code = 'tenant_rate_limited'`,
      [rateTenant.tenantId],
    );
    expect(denied.rows[0]).toMatchObject({ status: 'failed', error_code: 'tenant_rate_limited', dispatched: false });
  });

  it('does not return another tenant vectors', async () => {
    const before = openaiHits.length;
    const response = await post(other, { model: 'embed-small', input: PHRASE });
    expect(response.statusCode).toBe(404);
    expect(messageOf(response)).toBe('The model is not available.');
    expect(JSON.stringify(response.json())).not.toContain(String(MARKER));
    expect(openaiHits).toHaveLength(before);
    expect(await attemptCount(other.tenantId)).toBe(0);
  });

  it('does not route model auto to the embedding deployment', async () => {
    const before = openaiHits.length;
    runCli(
      db,
      ['set-alias', '--tenant-id', caller.tenantId, '--alias', 'auto', '--deployment', 'embed-small'],
      cliEnv(),
    );
    const alias = await post(caller, { model: 'auto', input: 'alias' });
    expect(alias.statusCode).toBe(404);
    expect(messageOf(alias)).toBe('The model is not available.');
    expect(openaiHits).toHaveLength(before);
    const named = await post(caller, { model: 'embed-small', input: 'named' });
    expect(named.statusCode).toBe(200);
  });

  it('refuses a changed embedding model and does not serve the old vector space', async () => {
    const before = openaiHits.length;
    runCli(
      db,
      [
        'set-deployment-model',
        '--tenant-id',
        caller.tenantId,
        '--deployment',
        'embed-switch',
        '--upstream-model',
        'text-embedding-3-large',
      ],
      cliEnv(),
    );
    const stale = await post(caller, { model: 'embed-switch', input: 'stale space' });
    expect(stale.statusCode).toBe(400);
    expect(messageOf(stale)).toBe('The embedding model changed.');
    expect(openaiHits).toHaveLength(before);
    pin(caller.tenantId, 'embed-switch', 8, 'none');
    const next = await post(caller, { model: 'embed-switch', input: 'new space' });
    expect(next.statusCode).toBe(200);
    const body = next.json() as { model: string; data: Array<{ embedding: number[] }> };
    expect(body.model).toBe('embed-switch');
    expect(body.data[0]?.embedding).toHaveLength(8);
    const upstream = JSON.parse(openaiHits[before]?.body ?? '{}') as { model?: string; dimensions?: number };
    expect(upstream.model).toBe('text-embedding-3-large');
    expect(upstream.dimensions).toBe(8);
    const reported = await post(caller, { model: 'embed-small', input: 'switched-model' });
    expect(reported.statusCode).toBe(502);
    expect(messageOf(reported)).toBe('The embedding model changed.');
    const versions = await admin.query<{ version: number; model: string; dimension: number }>(
      `SELECT contract.version, contract.model, contract.dimension
       FROM embedding_contracts AS contract
       JOIN model_deployments AS deployment
         ON deployment.id = contract.deployment_id
        AND deployment.tenant_id = contract.tenant_id
       WHERE contract.tenant_id = $1 AND deployment.name = 'embed-switch'
       ORDER BY contract.version`,
      [caller.tenantId],
    );
    expect(versions.rows).toEqual([
      { version: 1, model: 'text-embedding-3-small', dimension: 4 },
      { version: 2, model: 'text-embedding-3-large', dimension: 8 },
    ]);
    await expect(
      admin.query(`UPDATE embedding_contracts SET dimension = 4 WHERE tenant_id = $1 AND version = 1`, [caller.tenantId]),
    ).rejects.toThrow(/embedding contract is immutable/);
    await expect(
      admin.query(`DELETE FROM embedding_contracts WHERE tenant_id = $1`, [caller.tenantId]),
    ).rejects.toThrow(/embedding contract is immutable/);
    saved.fixtures.spaces = versions.rows;
  });

  it('rejects embeddings on anthropic, xai, and openrouter', () => {
    const tenant = provisionTenant(db, 'Embeddings Blocked');
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-embed-blocked',
      endpoint: 'https://api.anthropic.com',
      deployment: 'claude-chat',
      upstreamModel: 'claude-embed',
      alias: false,
    });
    const anthropic = spawnSync(
      process.execPath,
      [
        cliEntry,
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'anthropic',
        '--name',
        'embed-claude',
        '--upstream-model',
        'claude-embed',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'embeddings',
        '--default-max-output-tokens',
        '64',
      ],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(anthropic.status).toBe(1);
    runCli(db, ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-embed-key-0123456789'], cliEnv());
    const xai = spawnSync(
      process.execPath,
      [
        cliEntry,
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'xai',
        '--name',
        'embed-grok',
        '--upstream-model',
        'grok-embed',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'embeddings',
      ],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(xai.status).toBe(1);
    runCli(
      db,
      ['register-openrouter-connection', '--tenant-id', tenant.tenantId, '--api-key', 'or-embed-key-012345678'],
      cliEnv(),
    );
    const router = spawnSync(
      process.execPath,
      [
        cliEntry,
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'openrouter',
        '--name',
        'embed-router',
        '--upstream-model',
        'openai/text-embedding-3-small',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'embeddings',
        '--downstream-providers',
        'openai',
        '--data-collection',
        'deny',
      ],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(router.status).toBe(1);
  });

  it('reads the official SDK twice and keeps usage on both calls', async () => {
    const client = new OpenAI({
      apiKey: caller.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      defaultHeaders: { 'X-Tenant-ID': caller.tenantId },
    });
    const input = ['sdk one', 'sdk two', 'sdk three'];
    const first = await client.embeddings.create({ model: 'embed-small', input, encoding_format: 'float' });
    const second = await client.embeddings.create({ model: 'embed-small', input, encoding_format: 'float' });
    for (const result of [first, second]) {
      expect(result.object).toBe('list');
      expect(result.model).toBe('embed-small');
      expect(result.data).toHaveLength(3);
      result.data.forEach((item, index) => {
        expect(item.object).toBe('embedding');
        expect(item.index).toBe(index);
        expect(item.embedding).toHaveLength(4);
        expect((item.embedding as number[]).every((value) => Number.isFinite(value))).toBe(true);
      });
      expect(result.usage.prompt_tokens).toBe(12);
      expect(result.usage.total_tokens).toBe(12);
    }
    expect(second.data.map((item) => item.embedding)).toEqual(first.data.map((item) => item.embedding));
    expect(second.usage).toEqual(first.usage);
    const encoded = await client.embeddings.create({ model: 'embed-small', input: 'safe-float', encoding_format: 'base64' });
    const decoded = decodeFloat32(String(encoded.data[0]?.embedding));
    expect(decoded).toEqual(SAFE);
    saved.api.sdk = {
      calls: 2,
      count: first.data.length,
      dimension: (first.data[0]?.embedding as number[]).length,
      indexes: first.data.map((item) => item.index),
      usage: first.usage,
      base64Decoded: decoded,
    };
  });

  it('stores tokens, latency, and cost and writes no chat evidence', async () => {
    const journey = await admin.query<{
      status: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      duration_ms: number;
      dispatched: boolean;
      expense_certainty: string;
      enforced_capabilities: string[];
      adapter_version: number;
      amount: string;
      cost_status: string;
      request_id: string;
    }>(
      `SELECT attempt.status, attempt.prompt_tokens, attempt.completion_tokens, attempt.total_tokens,
              attempt.duration_ms, attempt.dispatched, attempt.expense_certainty,
              attempt.enforced_capabilities, attempt.adapter_version,
              cost.amount::text AS amount, cost.cost_status, attempt.request_id
       FROM model_attempts AS attempt
       JOIN attempt_costs AS cost ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
       WHERE attempt.tenant_id = $1 AND attempt.prompt_tokens = 303 AND attempt.status = 'succeeded'`,
      [caller.tenantId],
    );
    expect(journey.rows).toHaveLength(1);
    const row = journey.rows[0];
    expect(row).toMatchObject({
      status: 'succeeded',
      prompt_tokens: 303,
      completion_tokens: 0,
      total_tokens: 303,
      dispatched: true,
      expense_certainty: 'known',
      adapter_version: 1,
    });
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row?.enforced_capabilities).toEqual(['embeddings']);
    expect(canonicalDecimal(row?.amount ?? '')).toBe(canonicalDecimal('3.03'));
    const failed = await admin.query<{ status: string; error_code: string; prompt_tokens: number | null; dispatched: boolean }>(
      `SELECT status, error_code, prompt_tokens, dispatched
       FROM model_attempts
       WHERE tenant_id = $1 AND error_code = 'upstream_error' AND upstream_model = 'text-embedding-3-small'`,
      [caller.tenantId],
    );
    expect(failed.rows.length).toBeGreaterThan(0);
    expect(failed.rows[0]).toMatchObject({ status: 'failed', error_code: 'upstream_error', prompt_tokens: null, dispatched: true });
    const requestId = row?.request_id ?? '';
    const evidence = await admin.query<{ samples: number; features: number; decisions: number; ranks: number; canaries: number; selections: number; snapshots: number }>(
      `SELECT
         (SELECT count(*)::int FROM request_samples WHERE tenant_id = $1 AND request_id = $2) AS samples,
         (SELECT count(*)::int FROM request_features WHERE tenant_id = $1 AND request_id = $2) AS features,
         (SELECT count(*)::int FROM routing_decisions WHERE tenant_id = $1 AND request_id = $2) AS decisions,
         (SELECT count(*)::int FROM routing_shadow_rankings WHERE tenant_id = $1 AND request_id = $2) AS ranks,
         (SELECT count(*)::int FROM routing_canary_assignments WHERE tenant_id = $1 AND request_id = $2) AS canaries,
         (SELECT count(*)::int FROM routing_selection_decisions WHERE tenant_id = $1 AND request_id = $2) AS selections,
         (SELECT count(*)::int FROM evidence_snapshots WHERE tenant_id = $1) AS snapshots`,
      [caller.tenantId, requestId],
    );
    expect(evidence.rows[0]).toEqual({
      samples: 0,
      features: 0,
      decisions: 0,
      ranks: 0,
      canaries: 0,
      selections: 0,
      snapshots: 0,
    });
    const attempts = await app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/attempts?${WINDOW}&deployment=embed-small`,
      headers: authHeaders(caller.tenantId, caller.secret),
    });
    expect(attempts.statusCode).toBe(200);
    const history = attempts.json() as { attempts: Array<{ model: string; status: string; costAmount: string | null; durationMs: number | null }> };
    const stored = history.attempts.find(
      (item) =>
        item.model === 'text-embedding-3-small' &&
        item.status === 'succeeded' &&
        canonicalDecimal(item.costAmount ?? '') === canonicalDecimal('3.03'),
    );
    expect(stored?.durationMs).toBeGreaterThanOrEqual(0);
    expect(canonicalDecimal(stored?.costAmount ?? '')).toBe(canonicalDecimal('3.03'));
    const costs = await app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/costs?${WINDOW}&deployment=embed-small`,
      headers: authHeaders(caller.tenantId, caller.secret),
    });
    expect(costs.statusCode).toBe(200);
    const report = costs.json() as { external?: { estimated?: { amount?: string | null } } };
    expect(report.external?.estimated?.amount).not.toBeNull();
    const dumped = JSON.stringify(saved);
    expect(dumped).not.toMatch(/sk-/);
    expect(dumped).not.toMatch(/private_key/);
    expect(dumped).not.toMatch(/yck_/);
    saved.db = {
      ...saved.db,
      journey: {
        status: row?.status,
        promptTokens: row?.prompt_tokens,
        completionTokens: row?.completion_tokens,
        totalTokens: row?.total_tokens,
        durationMs: row?.duration_ms,
        cost: canonicalDecimal(row?.amount ?? ''),
        costStatus: row?.cost_status,
        capabilities: row?.enforced_capabilities,
        adapterVersion: row?.adapter_version,
      },
      failure: failed.rows[0],
      evidence: evidence.rows[0],
      operatorCost: canonicalDecimal(stored?.costAmount ?? ''),
    };
  });
});

async function attemptCount(tenantId: string): Promise<number> {
  const result = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM model_attempts WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows[0]?.count ?? 0;
}
