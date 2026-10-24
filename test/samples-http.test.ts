import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSampleKeyManager, decryptSample } from '../src/inference/sample-crypto.js';
import { ADAPTER_VERSION } from '../src/inference/samples.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import {
  adminPool,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const PROMPT = 'sample-capture-prompt-zeta-06b';
const COMPLETION = 'sample-capture-completion-zeta-06b';
const evidenceDir = process.env.SLICE_06B_EVIDENCE;

type Tenant = { tenantId: string; secret: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;
type Summary = {
  disabledStatus: number;
  enabledStatus: number;
  bodiesMatch: boolean;
  attemptCount: string;
  sampleCount: number;
  metadataStatus: number;
  foreignList: number;
  foreignById: number;
  afterDisableCount: number;
  policyMode: string;
  disabledMode: string;
  replay: boolean;
  judgeDisclosure: boolean;
};

const journeyNotes: string[] = [];
const failureNotes: string[] = [];
const apiNotes: string[] = [];
const isolationNotes: string[] = [];
const logBuckets: string[][] = [];

function headers(tenant: Tenant): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
  };
}

function chatBody(): Record<string, unknown> {
  return {
    model: 'chat',
    messages: [{ role: 'user', content: PROMPT }],
    temperature: 0,
  };
}

function sseSuccess(model: string): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
  const text = raw.replaceAll('__MODEL__', model);
  return text.endsWith('\n\n') ? text : `${text.replace(/\n*$/, '')}\n\n`;
}

function safe(text: string): string {
  if (text.includes(PROMPT) || text.includes(COMPLETION)) throw new Error('evidence contains sample text');
  return text.endsWith('\n') ? text : `${text}\n`;
}

describe('encrypted samples over HTTP', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;

  beforeAll(async () => {
    openai = await startMockUpstream((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; stream?: boolean };
      if (parsed.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseSuccess(parsed.model ?? 'gpt-test'));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? 'gpt-test', COMPLETION)));
    });
    admin = adminPool(db);
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
    logBuckets.push(ctx.lines);
  });

  afterAll(async () => {
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'journey.txt'), safe(journeyNotes.join('\n\n')));
      writeFileSync(join(evidenceDir, 'capture-failures.txt'), safe(failureNotes.join('\n\n')));
      writeFileSync(join(evidenceDir, 'api-output.txt'), safe(apiNotes.join('\n\n')));
      writeFileSync(join(evidenceDir, 'tenant-isolation.txt'), safe(isolationNotes.join('\n\n')));
    }
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  async function post(app: AppCtx, tenant: Tenant, body: Record<string, unknown> = chatBody()) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: body,
    });
  }

  async function sampleCount(tenantId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  function tenantPair(label: string): { a: Tenant; b: Tenant } {
    const a = provisionTenant(db, `${label} A`);
    const b = provisionTenant(db, `${label} B`);
    for (const tenant of [a, b]) {
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: 'sk-test-samples',
        deployment: 'chat',
        upstreamModel: 'gpt-samples',
      });
    }
    return { a, b };
  }

  function setPolicy(tenantId: string, mode: string, extra: string[] = []): void {
    runCli(
      db,
      ['set-sample-policy', '--tenant-id', tenantId, '--mode', mode, ...extra],
      cliEnv(),
    );
  }

  function enableCapture(tenantId: string, extra: string[] = []): void {
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    setPolicy(tenantId, 'encrypted_sample', [
      '--content-capture',
      'true',
      '--replay',
      'false',
      '--judge-disclosure',
      'false',
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
      'chat',
      ...extra,
    ]);
  }

  async function withApp(
    options: Parameters<typeof createTestApp>[1],
    run: (app: AppCtx) => Promise<void>,
  ): Promise<void> {
    const app = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      ...options,
    });
    logBuckets.push(app.lines);
    try {
      await run(app);
    } finally {
      await app.app.close();
      await app.authPool.end();
      await app.runtimePool.end();
    }
  }

  async function journey(label: string): Promise<Summary> {
    const { a, b } = tenantPair(label);
    const disabled = await post(ctx, a);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().choices[0].message.content).toBe(COMPLETION);
    expect(await sampleCount(a.tenantId)).toBe(0);

    enableCapture(a.tenantId);
    const shown = runCli(db, ['show-sample-policy', '--tenant-id', a.tenantId], cliEnv()) as {
      mode?: string;
      contentCapture?: boolean;
      replay?: boolean;
      judgeDisclosure?: boolean;
      policyVersion?: number;
    };
    expect(shown.mode).toBe('encrypted_sample');
    expect(shown.contentCapture).toBe(true);
    expect(shown.replay).toBe(false);
    expect(shown.judgeDisclosure).toBe(false);
    expect(shown.policyVersion).toBe(1);

    const enabled = await post(ctx, a);
    expect(enabled.statusCode).toBe(disabled.statusCode);
    expect(enabled.json()).toEqual(disabled.json());
    expect(enabled.headers['x-attempt-count']).toBe('1');
    expect(await sampleCount(a.tenantId)).toBe(1);

    const requestId = String(enabled.headers['x-request-id']);
    const stored = await admin.query<{
      id: string;
      schema_version: number;
      wrapping_key_version: number;
      wrapped_key_iv: Buffer;
      wrapped_key_tag: Buffer;
      wrapped_key_ciphertext: Buffer;
      content_iv: Buffer;
      content_tag: Buffer;
      content_ciphertext: Buffer;
      bytes: number;
    }>(
      `SELECT id::text, schema_version, wrapping_key_version,
              wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext,
              octet_length(content_ciphertext)::int AS bytes
       FROM request_samples WHERE tenant_id = $1 AND request_id = $2`,
      [a.tenantId, requestId],
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();
    expect(row?.bytes ?? 0).toBeGreaterThan(0);
    const opened = decryptSample(
      createSampleKeyManager(credentialKey),
      { tenantId: a.tenantId, sampleId: row?.id ?? '', schemaVersion: row?.schema_version ?? 0 },
      {
        schemaVersion: row?.schema_version ?? 0,
        wrappingKeyVersion: row?.wrapping_key_version ?? 0,
        wrappedKeyIv: row?.wrapped_key_iv ?? Buffer.alloc(0),
        wrappedKeyTag: row?.wrapped_key_tag ?? Buffer.alloc(0),
        wrappedKeyCiphertext: row?.wrapped_key_ciphertext ?? Buffer.alloc(0),
        contentIv: row?.content_iv ?? Buffer.alloc(0),
        contentTag: row?.content_tag ?? Buffer.alloc(0),
        contentCiphertext: row?.content_ciphertext ?? Buffer.alloc(0),
      },
    );
    const payload = opened as {
      request: { messages: Array<{ content: string }>; parameters: { temperature?: number } };
      output: { choices: Array<{ content: string }> };
      configuration: { deployment: string; provider: string; stream: boolean; dataClassification: string };
      providerMetadata: { provider: string; adapterVersion: number };
    };
    expect(payload.request.messages[0]?.content).toBe(PROMPT);
    expect(payload.request.parameters.temperature).toBe(0);
    expect(payload.output.choices[0]?.content).toBe(COMPLETION);
    expect(payload.configuration).toMatchObject({
      deployment: 'chat',
      provider: 'openai',
      stream: false,
      dataClassification: 'internal',
    });
    expect(payload.providerMetadata).toEqual({ provider: 'openai', adapterVersion: ADAPTER_VERSION });
    expect(JSON.stringify(payload)).not.toContain('thinking');

    const list = await ctx.app.inject({ method: 'GET', url: '/internal/v1/samples', headers: headers(a) });
    expect(list.statusCode).toBe(200);
    const listed = list.json() as { samples: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(listed.samples).toHaveLength(1);
    expect(listed.samples[0]?.id).toBe(row?.id);
    expect(Object.keys(listed.samples[0] ?? {}).sort()).toEqual([
      'createdAt',
      'deployment',
      'expiresAt',
      'id',
      'policyVersion',
      'provider',
      'requestId',
      'sizeBytes',
    ]);
    expect(JSON.stringify(listed)).not.toContain(PROMPT);
    expect(JSON.stringify(listed)).not.toContain(COMPLETION);
    expect(JSON.stringify(listed)).not.toContain('ciphertext');

    const one = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${row?.id}`,
      headers: headers(a),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(listed.samples[0]);

    const foreignList = await ctx.app.inject({ method: 'GET', url: '/internal/v1/samples', headers: headers(b) });
    const foreignOne = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${row?.id}`,
      headers: headers(b),
    });
    expect(foreignList.statusCode).toBe(200);
    expect(foreignList.json().samples).toEqual([]);
    expect(foreignOne.statusCode).toBe(404);
    const foreignChat = await post(ctx, b);
    expect(foreignChat.statusCode).toBe(200);
    expect(await sampleCount(b.tenantId)).toBe(0);

    const raw = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${row?.id}/content`,
      headers: headers(a),
    });
    expect(raw.statusCode).toBe(404);
    expect(raw.json()).toEqual({ error: 'not_found' });

    setPolicy(a.tenantId, 'disabled');
    const disabledPolicy = runCli(db, ['show-sample-policy', '--tenant-id', a.tenantId], cliEnv()) as { mode?: string };
    expect(disabledPolicy.mode).toBe('disabled');
    const after = await post(ctx, a);
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(disabled.json());
    expect(await sampleCount(a.tenantId)).toBe(1);
    const thirdId = String(after.headers['x-request-id']);
    const third = await admin.query('SELECT 1 FROM request_samples WHERE request_id = $1', [thirdId]);
    expect(third.rowCount).toBe(0);

    const features = await admin.query('SELECT 1 FROM request_features WHERE request_id = $1', [requestId]);
    expect(features.rowCount).toBe(1);

    journeyNotes.push(
      [
        label,
        'disabled chat status 200 and no sample',
        'enabled chat status 200 and body matched',
        `attempt count ${enabled.headers['x-attempt-count']}`,
        `ciphertext bytes ${row?.bytes}`,
        'decrypted payload matched the visible chat',
        `metadata ${list.statusCode}`,
        `tenant B list ${foreignList.statusCode} empty`,
        `tenant B by id ${foreignOne.statusCode}`,
        'disabled mode stored no new sample',
      ].join('\n'),
    );
    apiNotes.push(list.body);
    apiNotes.push(one.body);
    isolationNotes.push(`${label} tenant B list ${foreignList.body}`);
    isolationNotes.push(`${label} tenant B by id status ${foreignOne.statusCode}`);

    return {
      disabledStatus: disabled.statusCode,
      enabledStatus: enabled.statusCode,
      bodiesMatch: true,
      attemptCount: String(enabled.headers['x-attempt-count']),
      sampleCount: 1,
      metadataStatus: list.statusCode,
      foreignList: foreignList.statusCode,
      foreignById: foreignOne.statusCode,
      afterDisableCount: 1,
      policyMode: 'encrypted_sample',
      disabledMode: 'disabled',
      replay: false,
      judgeDisclosure: false,
    };
  }

  it('runs the two-tenant capture journey twice', async () => {
    const first = await journey('pass-1');
    const second = await journey('pass-2');
    expect(second).toEqual(first);
  });

  it('skips capture for a missing permission, a rejected class, a tiny limit, and a full count', async () => {
    const { a } = tenantPair('gates');
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', a.tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    setPolicy(a.tenantId, 'encrypted_sample', [
      '--content-capture',
      'false',
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
      'chat',
    ]);
    const missing = await post(ctx, a);
    expect(missing.statusCode).toBe(200);
    expect(missing.headers['x-attempt-count']).toBe('1');
    expect(await sampleCount(a.tenantId)).toBe(0);

    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', a.tenantId, '--deployment', 'chat', '--data-class', 'restricted'],
      cliEnv(),
    );
    setPolicy(a.tenantId, 'encrypted_sample', [
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
      'chat',
    ]);
    const rejected = await post(ctx, a);
    expect(rejected.statusCode).toBe(200);
    expect(await sampleCount(a.tenantId)).toBe(0);

    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', a.tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    setPolicy(a.tenantId, 'encrypted_sample', [
      '--content-capture',
      'true',
      '--sample-rate',
      '1',
      '--max-sample-bytes',
      '1',
      '--max-sample-count',
      '10',
      '--retention-seconds',
      '86400',
      '--classifications',
      'internal',
      '--providers',
      'openai',
      '--deployments',
      'chat',
    ]);
    const oversized = await post(ctx, a);
    expect(oversized.statusCode).toBe(200);
    expect(oversized.headers['x-attempt-count']).toBe('1');
    expect(await sampleCount(a.tenantId)).toBe(0);

    setPolicy(a.tenantId, 'encrypted_sample', [
      '--content-capture',
      'true',
      '--sample-rate',
      '1',
      '--max-sample-bytes',
      '1000000',
      '--max-sample-count',
      '1',
      '--retention-seconds',
      '86400',
      '--classifications',
      'internal',
      '--providers',
      'openai',
      '--deployments',
      'chat',
    ]);
    const first = await post(ctx, a);
    const second = await post(ctx, a);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-attempt-count']).toBe('1');
    expect(await sampleCount(a.tenantId)).toBe(1);
    failureNotes.push('missing permission, rejected class, size, and count left the chat at status 200');
  });

  it('does not capture a streaming chat', async () => {
    const { a } = tenantPair('stream');
    enableStreaming(db, { tenantId: a.tenantId, deployment: 'chat' });
    enableCapture(a.tenantId);
    const streamed = await post(ctx, a, { ...chatBody(), stream: true });
    expect(streamed.statusCode).toBe(200);
    expect(await sampleCount(a.tenantId)).toBe(0);
    failureNotes.push('streaming chat stored no sample');
  });

  it('stores nothing when capture is revoked before storage', async () => {
    const { a } = tenantPair('revoke');
    enableCapture(a.tenantId);
    let revoke = true;
    await withApp(
      {
        beforeSampleStore: () => {
          if (!revoke) return;
          revoke = false;
          setPolicy(a.tenantId, 'disabled');
        },
      },
      async (app) => {
        const response = await post(app, a);
        expect(response.statusCode).toBe(200);
        expect(response.json().choices[0].message.content).toBe(COMPLETION);
        expect(response.headers['x-attempt-count']).toBe('1');
        const attempts = await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM model_attempts WHERE request_id = $1',
          [String(response.headers['x-request-id'])],
        );
        expect(attempts.rows[0]?.count).toBe(1);
        expect(await sampleCount(a.tenantId)).toBe(0);
        const features = await admin.query('SELECT 1 FROM request_features WHERE request_id = $1', [
          String(response.headers['x-request-id']),
        ]);
        expect(features.rowCount).toBe(1);
      },
    );
    failureNotes.push('revocation before storage kept the chat and stored no sample');
  });

  it('returns the chat when the sample insert fails', async () => {
    const { a } = tenantPair('insert-fail');
    enableCapture(a.tenantId);
    let fail = true;
    await withApp(
      {
        failSampleInsert: () => {
          if (!fail) return false;
          fail = false;
          return true;
        },
      },
      async (app) => {
        const response = await post(app, a);
        expect(response.statusCode).toBe(200);
        expect(response.json().choices[0].message.content).toBe(COMPLETION);
        expect(response.headers['x-attempt-count']).toBe('1');
        const attempts = await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM model_attempts WHERE request_id = $1',
          [String(response.headers['x-request-id'])],
        );
        expect(attempts.rows[0]?.count).toBe(1);
        expect(await sampleCount(a.tenantId)).toBe(0);
        const features = await admin.query('SELECT 1 FROM request_features WHERE request_id = $1', [
          String(response.headers['x-request-id']),
        ]);
        expect(features.rowCount).toBe(1);
        expect(app.lines.join('\n')).not.toContain(PROMPT);
        expect(app.lines.join('\n')).not.toContain(COMPLETION);
      },
    );
    failureNotes.push('insert failure kept status 200, one attempt, and the feature row');
  });

  it('stores nothing when the key manager is missing or throws', async () => {
    const missing = tenantPair('no-key');
    enableCapture(missing.a.tenantId);
    await withApp({ sampleKeyManager: null }, async (app) => {
      const response = await post(app, missing.a);
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-attempt-count']).toBe('1');
      expect(await sampleCount(missing.a.tenantId)).toBe(0);
    });
    const throwing = tenantPair('throw-key');
    enableCapture(throwing.a.tenantId);
    await withApp(
      {
        sampleKeyManager: {
          current() {
            throw new Error('key manager unavailable');
          },
          previous() {
            return [];
          },
        },
      },
      async (app) => {
        const response = await post(app, throwing.a);
        expect(response.statusCode).toBe(200);
        expect(await sampleCount(throwing.a.tenantId)).toBe(0);
        expect(app.lines.join('\n')).not.toContain(PROMPT);
      },
    );
    failureNotes.push('missing and throwing key managers stored no sample');
  });

  it('pages metadata and rejects a bad filter', async () => {
    const { a, b } = tenantPair('page');
    enableCapture(a.tenantId);
    await post(ctx, a, { model: 'chat', messages: [{ role: 'user', content: 'page-one' }], temperature: 0 });
    await post(ctx, a, { model: 'chat', messages: [{ role: 'user', content: 'page-two' }], temperature: 0 });
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/samples?limit=1',
      headers: headers(a),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json() as { samples: Array<{ id: string }>; nextCursor: string | null };
    expect(page.samples).toHaveLength(1);
    expect(page.nextCursor).toBe(page.samples[0]?.id);
    const second = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples?limit=1&cursor=${page.nextCursor}`,
      headers: headers(a),
    });
    const next = second.json() as { samples: Array<{ id: string }>; nextCursor: string | null };
    expect(next.samples).toHaveLength(1);
    expect(next.samples[0]?.id).not.toBe(page.samples[0]?.id);
    expect(next.nextCursor).toBeNull();
    const badLimit = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/samples?limit=0',
      headers: headers(a),
    });
    const badProvider = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/samples?provider=nope',
      headers: headers(a),
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badProvider.statusCode).toBe(400);
    const badId = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/samples/not-a-uuid',
      headers: headers(a),
    });
    expect(badId.statusCode).toBe(400);
    const hidden = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${page.samples[0]?.id}`,
      headers: headers(b),
    });
    expect(hidden.statusCode).toBe(404);
    apiNotes.push(first.body);
    apiNotes.push(second.body);
    isolationNotes.push(`page tenant B by id status ${hidden.statusCode}`);
  });

  it('keeps sample plaintext out of logs and database columns', async () => {
    const logs = logBuckets.map((lines) => lines.join('\n')).join('\n');
    expect(logs).not.toContain(PROMPT);
    expect(logs).not.toContain(COMPLETION);
    const found = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM request_samples
       WHERE position($1::bytea IN content_ciphertext) > 0
          OR position($1::bytea IN wrapped_key_ciphertext) > 0
          OR position($1::bytea IN wrapped_key_iv) > 0
          OR position($1::bytea IN wrapped_key_tag) > 0
          OR position($1::bytea IN content_iv) > 0
          OR position($1::bytea IN content_tag) > 0
          OR position($2::bytea IN content_ciphertext) > 0
          OR position($2::bytea IN wrapped_key_ciphertext) > 0
          OR provider LIKE '%' || $3 || '%'
          OR deployment_name LIKE '%' || $3 || '%'
          OR data_classification LIKE '%' || $3 || '%'
          OR provider LIKE '%' || $4 || '%'
          OR deployment_name LIKE '%' || $4 || '%'
          OR data_classification LIKE '%' || $4 || '%'`,
      [Buffer.from(PROMPT), Buffer.from(COMPLETION), PROMPT, COMPLETION],
    );
    expect(found.rows[0]?.count).toBe(0);
    failureNotes.push('logs and non-ciphertext columns did not contain the sample text');
  });

  it('keeps migration 017 ready after the sample migration', async () => {
    const ready = await ctx.runtimePool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      '017_request_features.sql',
    ]);
    const added = await ctx.runtimePool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      '018_sample_capture.sql',
    ]);
    expect(ready.rowCount).toBe(1);
    expect(added.rowCount).toBe(1);
    const sql = readFileSync(join(projectRoot, 'migrations/018_sample_capture.sql'), 'utf8');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const columns = await admin.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_name IN ('sample_policies', 'request_samples')
          OR (table_name = 'model_deployments' AND column_name = 'data_classification')
       ORDER BY table_name, ordinal_position`,
    );
    const proof = [
      'readiness version 017_request_features.sql row count 1',
      'applied version 018_sample_capture.sql row count 1',
      '018_sample_capture.sql does not drop a table or a column',
      ...columns.rows.map((row) => `${row.table_name}.${row.column_name} ${row.data_type}`),
    ].join('\n');
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'rollback.txt'), safe(proof));
      writeFileSync(join(evidenceDir, 'schema.txt'), safe(proof));
    }
  });
});
