import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCredentialStore } from '../src/credentials.js';
import { withTenant } from '../src/db/tenant-context.js';
import type { EvaluationWorkerOptions } from '../src/inference/evaluation-worker.js';
import { pollEvaluationOnce } from '../src/inference/evaluation-worker.js';
import { scoreCompletedReplay } from '../src/inference/evaluation-profiles.js';
import { createSampleKeyManager } from '../src/inference/sample-crypto.js';
import { captureLogger, createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant } from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const SOURCE_MODEL = 'gpt-07c-source';
const CHALLENGER_MODEL = 'gpt-07c-challenger';
const EFFECTIVE = '2025-12-01T00:00:00.000Z';
const PROMPT_MARK = 'eval-07c-prompt';
const CORRECT = '{"invoice_id":"INV-17","amount":"10"}';
const MISSING = '{"invoice_id":"INV-17"}';
const WRONG = '{"invoice_id":"INV-17","amount":"99"}';
const INVALID = 'not-json';
const LONG = 'x'.repeat(300);
const CLASS_OK = '{"label":"refund"}';
const CLASS_BAD = '{"label":"other"}';
const SECRET_TEXT = [PROMPT_MARK, 'INV-17', 'refund', 'not-json'];

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['invoice_id', 'amount'],
  properties: {
    invoice_id: { type: 'string', minLength: 1, maxLength: 32 },
    amount: { type: 'string', minLength: 1, maxLength: 16 },
  },
};

const classificationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 32, enum: ['refund', 'charge'] },
  },
};

function limits(patch: Record<string, number> = {}): Record<string, number> {
  return { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200, ...patch };
}

function extractionConfig(patch: Record<string, number> = {}): Record<string, unknown> {
  const bounded = limits(patch);
  return {
    limits: bounded,
    validators: [
      { id: 'json_parse', version: 1 },
      { id: 'json_schema', version: 1, schema: extractionSchema },
      { id: 'required_fields', version: 1, fields: ['invoice_id', 'amount'] },
      { id: 'exact_label', version: 1, field: 'label' },
      { id: 'accepted_labels', version: 1, field: 'label', labels: ['refund', 'charge'] },
      { id: 'reference_fields', version: 1, fields: ['invoice_id', 'amount'] },
      { id: 'format_length', version: 1, minChars: 2, maxChars: Math.min(200, bounded.maxInputChars) },
    ],
  };
}

function depthConfig(): Record<string, unknown> {
  return {
    limits: limits({ maxInputChars: 8192 }),
    validators: [
      { id: 'json_parse', version: 1 },
      { id: 'json_schema', version: 1, schema: { type: 'object', enum: ['kept'] } },
      { id: 'exact_label', version: 1, field: 'amount' },
      { id: 'reference_fields', version: 1, fields: ['amount'] },
      { id: 'format_length', version: 1, minChars: 2, maxChars: 8192 },
    ],
  };
}

function classificationConfig(): Record<string, unknown> {
  return {
    limits: limits(),
    validators: [
      { id: 'json_parse', version: 1 },
      { id: 'json_schema', version: 1, schema: classificationSchema },
      { id: 'required_fields', version: 1, fields: ['label'] },
      { id: 'exact_label', version: 1, field: 'label' },
      { id: 'accepted_labels', version: 1, field: 'label', labels: ['refund', 'charge'] },
      { id: 'reference_fields', version: 1, fields: ['label'] },
      { id: 'format_length', version: 1, minChars: 2, maxChars: 200 },
    ],
  };
}

type Tenant = { tenantId: string; secret: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;
type ResultRow = {
  validatorId: string;
  version: number;
  candidate: 'original' | 'challenger';
  result: 'pass' | 'fail' | 'not_applicable' | 'unknown';
  measured: Record<string, unknown>;
  evidenceCode: string;
  errorClassification: string | null;
  referencePresent: boolean;
  createdAt: string;
};
type ItemBody = { sampleId: string; status: string; reasonCode: string | null; validators: ResultRow[] };
type ProfileBody = { id: string; versionId: string; name: string; version: number; status: string; config: { validators: Array<{ id: string }> } };

describe('deterministic quality evaluation', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;
  const workerLogger = captureLogger();
  const credentialStore = createCredentialStore(credentialKey);
  const sampleKeyManager = createSampleKeyManager(credentialKey);
  const outputs = new Map<string, { capture: string; replay: string }>();
  let phase: 'capture' | 'replay' = 'capture';

  beforeAll(async () => {
    openai = await startMockUpstream((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; messages?: Array<{ content?: string }> };
      const prompt = parsed.messages?.[0]?.content ?? '';
      const pair = outputs.get(prompt);
      const content = pair === undefined ? '{}' : phase === 'capture' ? pair.capture : pair.replay;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? CHALLENGER_MODEL, content)));
    });
    admin = adminPool(db);
    ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: openai.baseUrl, credentialKey });
    for (const model of [SOURCE_MODEL, CHALLENGER_MODEL]) {
      runCli(
        db,
        ['register-price', '--provider', 'openai', '--upstream-model', model, '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.002', '--output-rate', '0.003'],
        cliEnv(),
      );
    }
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  function headers(tenant: Tenant, extra: Record<string, string> = {}): Record<string, string> {
    return { 'content-type': 'application/json', 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}`, ...extra };
  }

  function workerOptions(tenantId: string, counter = { count: 0 }): EvaluationWorkerOptions {
    return {
      workerId: 'validator-worker',
      dryRun: false,
      executionEnabled: true,
      replayTenantIds: [tenantId],
      upstreamBaseUrl: openai.baseUrl,
      credentialStore,
      sampleKeyManager,
      logger: workerLogger.logger,
      callCounter: counter,
    };
  }

  function prepare(label: string): Tenant {
    const tenant = provisionTenant(db, label);
    runCli(db, ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-test-eval-07c'], cliEnv());
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--name', 'chat', '--upstream-model', SOURCE_MODEL, '--timeout-ms', '5000', '--capabilities', 'temperature,max_tokens', '--enabled', 'true'],
      cliEnv(),
    );
    runCli(db, ['set-alias', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--deployment', 'chat'], cliEnv());
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--name', 'challenger', '--upstream-model', CHALLENGER_MODEL, '--timeout-ms', '5000', '--capabilities', 'temperature,max_tokens', '--enabled', 'true'],
      cliEnv(),
    );
    runCli(db, ['set-deployment-data-class', '--tenant-id', tenant.tenantId, '--deployment', 'chat', '--data-class', 'internal'], cliEnv());
    runCli(
      db,
      ['set-sample-policy', '--tenant-id', tenant.tenantId, '--mode', 'encrypted_sample', '--content-capture', 'true', '--replay', 'true', '--judge-disclosure', 'true', '--sample-rate', '1', '--max-sample-bytes', '1000000', '--max-sample-count', '100', '--retention-seconds', '86400', '--classifications', 'internal', '--providers', 'openai', '--deployments', 'chat,challenger'],
      cliEnv(),
    );
    runCli(db, ['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '10'], cliEnv());
    return tenant;
  }

  async function capture(tenant: Tenant, task: string, prompt: string, captureText: string, replayText = captureText): Promise<string> {
    outputs.set(prompt, { capture: captureText, replay: replayText });
    phase = 'capture';
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: { model: 'chat', messages: [{ role: 'user', content: prompt }], task, temperature: 0, max_tokens: 16 },
    });
    expect(response.statusCode).toBe(200);
    const stored = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    const sampleId = stored.rows[0]?.id;
    if (sampleId === undefined) throw new Error('sample was not stored');
    return sampleId;
  }

  async function postProfile(tenant: Tenant, body: Record<string, unknown>): Promise<{ statusCode: number; body: ProfileBody }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: headers(tenant),
      payload: body,
    });
    return { statusCode: response.statusCode, body: response.json() as ProfileBody };
  }

  async function addVersion(tenant: Tenant, profileId: string, body: Record<string, unknown>): Promise<ProfileBody> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${profileId}/versions`,
      headers: headers(tenant),
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as ProfileBody;
  }

  async function approve(tenant: Tenant, profile: ProfileBody): Promise<void> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${profile.id}/versions/${profile.version}/approve`,
      headers: headers(tenant),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'approved', version: profile.version });
  }

  async function putReference(tenant: Tenant, profile: ProfileBody, sampleId: string, reference: Record<string, unknown>, status = 200): Promise<void> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${profile.id}/versions/${profile.version}/references`,
      headers: headers(tenant),
      payload: { sampleId, reference },
    });
    expect(response.statusCode).toBe(status);
  }

  async function readProfile(tenant: Tenant, profile: ProfileBody): Promise<ProfileBody> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-profiles/${profile.id}/versions/${profile.version}`,
      headers: headers(tenant),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ProfileBody;
  }

  async function replay(tenant: Tenant, sampleIds: string[], category: string, profileVersionId: string, key: string): Promise<{ id: string; items: ItemBody[]; calls: number }> {
    phase = 'replay';
    const hitsBefore = openai.hits.length;
    const counter = { count: 0 };
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(tenant, { 'idempotency-key': key }),
      payload: {
        name: 'extraction-run',
        sampleCategory: category,
        sampleIds,
        challengerDeployment: 'challenger',
        budgetEstimate: '0.25',
        mode: 'replay',
        profileVersionId,
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; profileVersionId: string; profileName: string };
    expect(created.profileVersionId).toBe(profileVersionId);
    for (let step = 0; step < sampleIds.length; step += 1) {
      const polled = await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId, counter));
      expect(polled).toEqual({ claimed: true, outcome: 'completed' });
    }
    const idle = await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId, counter));
    expect(idle).toEqual({ claimed: false, outcome: 'idle' });
    expect(counter.count).toBe(sampleIds.length);
    expect(openai.hits.length - hitsBefore).toBe(sampleIds.length);
    const items = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${created.id}/items`,
      headers: headers(tenant),
    });
    expect(items.statusCode).toBe(200);
    const page = items.json() as { items: ItemBody[] };
    expect(page.items).toHaveLength(sampleIds.length);
    const serialized = JSON.stringify(page);
    for (const secret of SECRET_TEXT) expect(serialized).not.toContain(secret);
    for (const line of workerLogger.lines) {
      for (const secret of SECRET_TEXT) expect(line).not.toContain(secret);
    }
    console.log(JSON.stringify(page.items.map((item) => ({ sampleId: item.sampleId, status: item.status, validators: item.validators.map((row) => ({ candidate: row.candidate, validatorId: row.validatorId, result: row.result, evidenceCode: row.evidenceCode, errorClassification: row.errorClassification, referencePresent: row.referencePresent })) }))));
    return { id: created.id, items: page.items, calls: counter.count };
  }

  function bySample(items: ItemBody[], sampleId: string): ItemBody {
    const item = items.find((entry) => entry.sampleId === sampleId);
    if (item === undefined) throw new Error('item was not returned');
    return item;
  }

  function expectCheck(item: ItemBody, candidate: 'original' | 'challenger', validatorId: string, result: ResultRow['result'], evidenceCode: string, referencePresent: boolean): ResultRow {
    const found = item.validators.find((row) => row.candidate === candidate && row.validatorId === validatorId);
    expect(found).toMatchObject({ version: 1, result, evidenceCode, referencePresent });
    expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    return found as ResultRow;
  }

  function expectPair(item: ItemBody, validatorId: string, result: ResultRow['result'], evidenceCode: string, referencePresent: boolean): void {
    expectCheck(item, 'original', validatorId, result, evidenceCode, referencePresent);
    expectCheck(item, 'challenger', validatorId, result, evidenceCode, referencePresent);
  }

  it('keeps the validator path free of code, urls, shells, and judge calls', () => {
    const validator = readFileSync(`${projectRoot}/src/inference/validators.ts`, 'utf8');
    const profiles = readFileSync(`${projectRoot}/src/inference/evaluation-profiles.ts`, 'utf8');
    const replay = readFileSync(`${projectRoot}/src/inference/replay-execution.ts`, 'utf8');
    const index = readFileSync(`${projectRoot}/src/index.ts`, 'utf8');
    const dockerfile = readFileSync(`${projectRoot}/Dockerfile`, 'utf8');
    for (const source of [validator, profiles]) {
      expect(source).not.toContain('child_process');
      expect(source).not.toContain('eval(');
      expect(source).not.toContain('new Function');
      expect(source).not.toContain('fetch(');
      expect(source).not.toContain('https://');
      expect(source).not.toContain('http://');
      expect(source).not.toContain('chat/completions');
    }
    expect(replay).not.toContain('resolveModel');
    expect(replay).not.toContain('executeChat');
    expect(replay).not.toContain('guardUpstream');
    expect(replay).not.toContain('claimProbe');
    expect(index).not.toContain('evaluation-worker');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
  });

  it('rejects a malformed validator configuration before it can run', async () => {
    const tenant = prepare('Validator Malformed');
    const hits = openai.hits.length;
    const remote = await postProfile(tenant, {
      name: 'remote-schema',
      taskCategory: 'extraction',
      config: { limits: limits(), validators: [{ id: 'json_schema', version: 1, schema: { $ref: 'https://example.test/s' } }] },
    });
    const unknown = await postProfile(tenant, {
      name: 'shell-check',
      taskCategory: 'extraction',
      config: { limits: limits(), validators: [{ id: 'shell', version: 1 }] },
    });
    const negative = await postProfile(tenant, {
      name: 'negative-limit',
      taskCategory: 'extraction',
      config: { limits: limits({ maxInputChars: -1 }), validators: [{ id: 'json_parse', version: 1 }] },
    });
    expect(remote.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(negative.statusCode).toBe(400);
    const names = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_profiles WHERE tenant_id = $1 AND name IN ('remote-schema', 'shell-check', 'negative-limit')`,
      [tenant.tenantId],
    );
    expect(names.rows[0]?.count).toBe(0);
    expect(openai.hits.length).toBe(hits);
  });

  it('does not score a draft profile', async () => {
    const tenant = prepare('Validator Draft');
    const prompt = `${PROMPT_MARK}-draft`;
    const sampleId = await capture(tenant, 'extraction', prompt, CORRECT);
    const created = await postProfile(tenant, { name: 'extraction-v1', taskCategory: 'extraction', config: extractionConfig() });
    expect(created.statusCode).toBe(201);
    await putReference(tenant, created.body, sampleId, { invoice_id: 'INV-17', amount: '10' });
    const hits = openai.hits.length;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(tenant, { 'idempotency-key': 'draft-profile' }),
      payload: {
        name: 'extraction-run',
        sampleCategory: 'extraction',
        sampleIds: [sampleId],
        challengerDeployment: 'challenger',
        budgetEstimate: '0.25',
        mode: 'replay',
        profileVersionId: created.body.versionId,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'profile_not_approved' } });
    const results = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_validator_results WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(results.rows[0]?.count).toBe(0);
    expect(openai.hits.length).toBe(hits);
  });

  it('scores original and challenger outputs for the synthetic fixtures', async () => {
    const tenant = prepare('Validator Fixtures');
    const correctId = await capture(tenant, 'extraction', `${PROMPT_MARK}-correct`, CORRECT);
    const missingId = await capture(tenant, 'extraction', `${PROMPT_MARK}-missing`, MISSING);
    const wrongId = await capture(tenant, 'extraction', `${PROMPT_MARK}-wrong`, WRONG);
    const invalidId = await capture(tenant, 'extraction', `${PROMPT_MARK}-invalid`, INVALID);
    const missingReferenceId = await capture(tenant, 'extraction', `${PROMPT_MARK}-noref`, CORRECT);
    const longId = await capture(tenant, 'extraction', `${PROMPT_MARK}-long`, LONG);
    const splitId = await capture(tenant, 'extraction', `${PROMPT_MARK}-split`, CORRECT, WRONG);
    const classOkId = await capture(tenant, 'classification', `${PROMPT_MARK}-class-ok`, CLASS_OK);
    const classBadId = await capture(tenant, 'classification', `${PROMPT_MARK}-class-bad`, CLASS_BAD);
    const otherId = await capture(tenant, 'extraction', `${PROMPT_MARK}-other`, CORRECT);
    const timeoutId = await capture(tenant, 'extraction', `${PROMPT_MARK}-timeout`, CORRECT);
    const sizeId = await capture(tenant, 'extraction', `${PROMPT_MARK}-size`, '0123456789');

    const extraction = (await postProfile(tenant, { name: 'extraction-v1', taskCategory: 'extraction', config: extractionConfig() })).body;
    const classification = (await postProfile(tenant, { name: 'classification-v1', taskCategory: 'classification', config: classificationConfig() })).body;
    const incompatible = (await postProfile(tenant, { name: 'summary-v1', taskCategory: 'summarization', config: extractionConfig() })).body;
    const timeout = (await postProfile(tenant, { name: 'timeout-v1', taskCategory: 'extraction', config: extractionConfig({ timeBudgetMs: 0 }) })).body;
    const size = (await postProfile(tenant, { name: 'size-v1', taskCategory: 'extraction', config: extractionConfig({ maxInputChars: 8 }) })).body;
    const nested = '['.repeat(3000) + ']'.repeat(3000);
    const deepDocument = `{"amount":${nested}}`;
    expect(deepDocument.length).toBeGreaterThan(4096);
    expect(deepDocument.length).toBeLessThan(8192);
    const deepId = await capture(tenant, 'extraction', `${PROMPT_MARK}-depth`, deepDocument);
    const depth = (await postProfile(tenant, { name: 'depth-v1', taskCategory: 'extraction', config: depthConfig() })).body;

    for (const sampleId of [correctId, missingId, wrongId, invalidId, longId, splitId]) {
      await putReference(tenant, extraction, sampleId, { invoice_id: 'INV-17', amount: '10' });
    }
    await putReference(tenant, classification, classOkId, { label: 'refund' });
    await putReference(tenant, classification, classBadId, { label: 'refund' });
    await approve(tenant, extraction);
    await approve(tenant, classification);
    await approve(tenant, incompatible);
    await approve(tenant, timeout);
    await approve(tenant, size);
    await putReference(tenant, depth, deepId, { amount: '10' });
    await approve(tenant, depth);
    await putReference(tenant, extraction, correctId, { invoice_id: 'INV-18', amount: '1' }, 409);

    const extracted = await replay(
      tenant,
      [correctId, missingId, wrongId, invalidId, missingReferenceId, longId, splitId],
      'extraction',
      extraction.versionId,
      'fixtures-extraction',
    );
    const correct = bySample(extracted.items, correctId);
    const missing = bySample(extracted.items, missingId);
    const wrong = bySample(extracted.items, wrongId);
    const invalid = bySample(extracted.items, invalidId);
    const noReference = bySample(extracted.items, missingReferenceId);
    const long = bySample(extracted.items, longId);
    const split = bySample(extracted.items, splitId);
    for (const item of [correct, missing, wrong, invalid, noReference, long, split]) {
      expect(item.status).toBe('completed');
      expect(item.validators.filter((row) => row.candidate === 'original')).toHaveLength(7);
      expect(item.validators.filter((row) => row.candidate === 'challenger')).toHaveLength(7);
    }

    expectPair(correct, 'json_parse', 'pass', 'json_parsed', true);
    expectPair(correct, 'json_schema', 'pass', 'schema_valid', true);
    expectPair(correct, 'required_fields', 'pass', 'fields_present', true);
    expectPair(correct, 'reference_fields', 'pass', 'fields_match', true);
    expectPair(correct, 'format_length', 'pass', 'length_within', true);
    expectPair(correct, 'exact_label', 'not_applicable', 'label_shape', true);
    expectPair(correct, 'accepted_labels', 'not_applicable', 'label_shape', true);
    expect(expectCheck(correct, 'original', 'json_parse', 'pass', 'json_parsed', true).measured).toEqual({ parsed: true });

    expectPair(missing, 'json_parse', 'pass', 'json_parsed', true);
    expectPair(missing, 'required_fields', 'fail', 'field_missing', true);
    expectPair(missing, 'json_schema', 'fail', 'schema_violation', true);
    expectPair(missing, 'reference_fields', 'fail', 'field_mismatch', true);
    expect(expectCheck(missing, 'original', 'required_fields', 'fail', 'field_missing', true).measured).toEqual({ missing: ['amount'] });

    expectPair(wrong, 'json_parse', 'pass', 'json_parsed', true);
    expectPair(wrong, 'json_schema', 'pass', 'schema_valid', true);
    expectPair(wrong, 'required_fields', 'pass', 'fields_present', true);
    expectPair(wrong, 'reference_fields', 'fail', 'field_mismatch', true);
    expect(expectCheck(wrong, 'challenger', 'reference_fields', 'fail', 'field_mismatch', true).measured).toEqual({ mismatched: ['amount'] });

    expectPair(invalid, 'json_parse', 'fail', 'json_invalid', true);
    expectPair(invalid, 'json_schema', 'not_applicable', 'not_json', true);
    expectPair(invalid, 'required_fields', 'not_applicable', 'not_object', true);
    expectPair(invalid, 'format_length', 'pass', 'length_within', true);
    expect(expectCheck(invalid, 'original', 'json_parse', 'fail', 'json_invalid', true).errorClassification).toBe('parse_error');

    expectPair(noReference, 'json_parse', 'pass', 'json_parsed', false);
    expectPair(noReference, 'reference_fields', 'unknown', 'reference_absent', false);
    expectPair(noReference, 'exact_label', 'unknown', 'reference_absent', false);
    expectPair(noReference, 'required_fields', 'pass', 'fields_present', false);

    expectPair(long, 'format_length', 'fail', 'length_exceeded', true);
    expectPair(long, 'json_parse', 'fail', 'json_invalid', true);
    expect(expectCheck(long, 'original', 'format_length', 'fail', 'length_exceeded', true).errorClassification).toBeNull();

    expectCheck(split, 'original', 'reference_fields', 'pass', 'fields_match', true);
    expectCheck(split, 'challenger', 'reference_fields', 'fail', 'field_mismatch', true);
    expectCheck(split, 'original', 'json_parse', 'pass', 'json_parsed', true);
    expectCheck(split, 'challenger', 'json_parse', 'pass', 'json_parsed', true);

    const classified = await replay(tenant, [classOkId, classBadId], 'classification', classification.versionId, 'fixtures-classification');
    const classOk = bySample(classified.items, classOkId);
    const classBad = bySample(classified.items, classBadId);
    expectPair(classOk, 'exact_label', 'pass', 'label_match', true);
    expectPair(classOk, 'accepted_labels', 'pass', 'label_accepted', true);
    expectPair(classOk, 'reference_fields', 'pass', 'fields_match', true);
    expectPair(classOk, 'json_schema', 'pass', 'schema_valid', true);
    expectPair(classBad, 'exact_label', 'fail', 'label_mismatch', true);
    expectPair(classBad, 'accepted_labels', 'fail', 'label_rejected', true);
    expectPair(classBad, 'reference_fields', 'fail', 'field_mismatch', true);
    expectPair(classBad, 'json_parse', 'pass', 'json_parsed', true);
    expectPair(classBad, 'json_schema', 'fail', 'schema_violation', true);

    const foreign = await replay(tenant, [otherId], 'extraction', incompatible.versionId, 'fixtures-incompatible');
    const foreignItem = bySample(foreign.items, otherId);
    expect(foreignItem.validators.every((row) => row.result === 'not_applicable')).toBe(true);
    expect(foreignItem.validators.every((row) => row.evidenceCode === 'profile_incompatible')).toBe(true);
    expect(foreignItem.validators.some((row) => row.result === 'pass' || row.result === 'fail')).toBe(false);

    const started = Date.now();
    const timed = await replay(tenant, [timeoutId], 'extraction', timeout.versionId, 'fixtures-timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    const timedItem = bySample(timed.items, timeoutId);
    expect(timedItem.validators.every((row) => row.result === 'unknown' && row.errorClassification === 'timeout' && row.evidenceCode === 'validator_timeout')).toBe(true);

    const sized = await replay(tenant, [sizeId], 'extraction', size.versionId, 'fixtures-size');
    const sizedItem = bySample(sized.items, sizeId);
    expect(sizedItem.validators.every((row) => row.result === 'unknown' && row.errorClassification === 'size_exceeded' && row.evidenceCode === 'validator_size')).toBe(true);

    const deep = await replay(tenant, [deepId], 'extraction', depth.versionId, 'fixtures-depth');
    const deepItem = bySample(deep.items, deepId);
    expect(deepItem.status).toBe('completed');
    expect(deep.calls).toBe(1);
    expectPair(deepItem, 'json_parse', 'pass', 'json_parsed', true);
    expectPair(deepItem, 'format_length', 'pass', 'length_within', true);
    expectPair(deepItem, 'reference_fields', 'unknown', 'validator_size', true);
    expectPair(deepItem, 'exact_label', 'unknown', 'validator_size', true);
    expectPair(deepItem, 'json_schema', 'unknown', 'validator_size', true);
    const deepCheck = expectCheck(deepItem, 'original', 'reference_fields', 'unknown', 'validator_size', true);
    expect(deepCheck.errorClassification).toBe('size_exceeded');
    expect(deepCheck.measured).toEqual({ maxSchemaDepth: 8 });
    expect(expectCheck(deepItem, 'challenger', 'exact_label', 'unknown', 'validator_size', true).measured).toEqual({ maxSchemaDepth: 8 });
    expect(JSON.stringify(deepItem)).not.toContain(nested.slice(0, 12));

    const sealed = await admin.query<{ bytes: number }>(
      `SELECT octet_length(content_ciphertext)::int AS bytes FROM evaluation_attempts WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(sealed.rows.length).toBeGreaterThan(0);
    expect(sealed.rows.every((row) => row.bytes > 0)).toBe(true);

    const aliases = await admin.query<{ alias: string; name: string }>(
      `SELECT a.alias, d.name FROM model_aliases a JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id WHERE a.tenant_id = $1`,
      [tenant.tenantId],
    );
    const hitsBefore = openai.hits.length;
    const production = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: { model: 'auto', messages: [{ role: 'user', content: 'routing-check' }], max_tokens: 16 },
    });
    expect(production.statusCode).toBe(200);
    expect(JSON.parse((openai.hits.at(-1) as MockHit).body).model).toBe(SOURCE_MODEL);
    expect(openai.hits.length - hitsBefore).toBe(1);
    const aliasesAfter = await admin.query<{ alias: string; name: string }>(
      `SELECT a.alias, d.name FROM model_aliases a JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id WHERE a.tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(aliasesAfter.rows).toEqual(aliases.rows);

    const other = prepare('Validator Other Tenant');
    const hiddenItems = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${extracted.id}/items`,
      headers: headers(other),
    });
    expect(hiddenItems.statusCode).toBe(404);
    const hiddenProfile = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-profiles/${extraction.id}/versions/1`,
      headers: headers(other),
    });
    expect(hiddenProfile.statusCode).toBe(404);
    const visible = await withTenant(ctx.runtimePool, other.tenantId, (client) =>
      client.query(`SELECT id FROM evaluation_validator_results`),
    );
    expect(visible.rows).toEqual([]);
  });

  it('keeps one result when scoring runs again and a later profile version stays separate', async () => {
    const tenant = prepare('Validator History');
    const firstId = await capture(tenant, 'extraction', `${PROMPT_MARK}-history`, CORRECT);
    const secondId = await capture(tenant, 'extraction', `${PROMPT_MARK}-history-next`, CORRECT);
    const created = await postProfile(tenant, { name: 'extraction-v1', taskCategory: 'extraction', config: extractionConfig() });
    await putReference(tenant, created.body, firstId, { invoice_id: 'INV-17', amount: '10' });
    await putReference(tenant, created.body, secondId, { invoice_id: 'INV-17', amount: '10' });
    await approve(tenant, created.body);
    const first = await replay(tenant, [firstId], 'extraction', created.body.versionId, 'history-v1');
    const before = await admin.query<{ id: string; result: string; evidence_code: string }>(
      `SELECT id::text AS id, result, evidence_code
       FROM evaluation_validator_results WHERE tenant_id = $1 AND run_id = $2 ORDER BY id`,
      [tenant.tenantId, first.id],
    );
    expect(before.rows.some((row) => row.evidence_code === 'fields_match')).toBe(true);
    const next = await addVersion(tenant, created.body.id, {
      taskCategory: 'extraction',
      config: { limits: limits(), validators: [{ id: 'json_parse', version: 1 }] },
    });
    await approve(tenant, next);
    const storedV1 = await readProfile(tenant, created.body);
    expect(storedV1.config.validators.map((row) => row.id)).toContain('reference_fields');
    expect(storedV1.status).toBe('approved');
    await expect(
      admin.query(`UPDATE evaluation_profile_versions SET config = '{"limits":{"maxInputChars":8,"timeBudgetMs":0,"maxSchemaDepth":1,"maxSchemaNodes":1},"validators":[{"id":"json_parse","version":1}]}'::jsonb WHERE id = $1`, [created.body.versionId]),
    ).rejects.toThrow(/immutable/);
    const afterUpdate = await admin.query<{ id: string; result: string }>(
      `SELECT id::text AS id, result FROM evaluation_validator_results WHERE tenant_id = $1 AND run_id = $2 ORDER BY id`,
      [tenant.tenantId, first.id],
    );
    expect(afterUpdate.rows).toEqual(before.rows.map((row) => ({ id: row.id, result: row.result })));

    const attempt = await admin.query<{ id: string; sample_id: string; item_id: string }>(
      `SELECT id::text AS id, sample_id::text AS sample_id, item_id::text AS item_id
       FROM evaluation_attempts WHERE tenant_id = $1 AND run_id = $2`,
      [tenant.tenantId, first.id],
    );
    const row = attempt.rows[0];
    if (row === undefined) throw new Error('attempt was not stored');
    const hits = openai.hits.length;
    await withTenant(ctx.runtimePool, tenant.tenantId, (client) =>
      scoreCompletedReplay(client, sampleKeyManager, {
        tenantId: tenant.tenantId,
        runId: first.id,
        itemId: row.item_id,
        sampleId: row.sample_id,
        attemptId: row.id,
      }),
    );
    const secondPoll = await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId));
    expect(secondPoll).toEqual({ claimed: false, outcome: 'idle' });
    expect(openai.hits.length).toBe(hits);
    const afterScore = await admin.query<{ id: string; result: string }>(
      `SELECT id::text AS id, result FROM evaluation_validator_results WHERE tenant_id = $1 AND run_id = $2 ORDER BY id`,
      [tenant.tenantId, first.id],
    );
    expect(afterScore.rows).toEqual(afterUpdate.rows);
    const passRow = before.rows.find((entry) => entry.evidence_code === 'json_parsed');
    if (passRow === undefined) throw new Error('parse result was not stored');
    await expect(
      admin.query(
        `INSERT INTO evaluation_validator_results (
           tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
           result, measured, evidence_code, reference_present
         )
         SELECT tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
                'fail', measured, evidence_code, reference_present
         FROM evaluation_validator_results WHERE id = $1`,
        [passRow.id],
      ),
    ).rejects.toThrow(/duplicate key/);
    const stillPass = await admin.query<{ result: string }>(`SELECT result FROM evaluation_validator_results WHERE id = $1`, [passRow.id]);
    expect(stillPass.rows[0]?.result).toBe('pass');

    const pinned = await replay(tenant, [secondId], 'extraction', created.body.versionId, 'history-v1-again');
    expect(bySample(pinned.items, secondId).validators.some((entry) => entry.validatorId === 'reference_fields')).toBe(true);
    const versionTwo = await replay(tenant, [firstId], 'extraction', next.versionId, 'history-v2');
    const onlyParse = bySample(versionTwo.items, firstId).validators;
    expect(onlyParse.every((entry) => entry.validatorId === 'json_parse')).toBe(true);
    expect(onlyParse).toHaveLength(2);
    const unchanged = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_validator_results WHERE tenant_id = $1 AND run_id = $2`,
      [tenant.tenantId, first.id],
    );
    expect(unchanged.rows[0]?.count).toBe(before.rows.length);
  });
});
