import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractRequestFeatures } from '../src/inference/request-features.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import {
  adminPool,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockAnthropic } from './mock-anthropic.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const NEEDLE = 'NEEDLE-06A-PROMPT';
const COMPLETION_NEEDLE = 'NEEDLE-COMPLETION-06A';
const THROW_PROMPT = 'THROW-PROMPT-06A';
const evidenceDir = process.env.SLICE_06A_EVIDENCE;

type Tenant = { tenantId: string; secret: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;

function headers(tenant: Tenant): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
  };
}

function sseSuccess(model: string): string {
  const raw = readFileSync(join(projectRoot, 'test/fixtures/openai-stream-success.sse'), 'utf8');
  const text = raw.replaceAll('__MODEL__', model);
  return text.endsWith('\n\n') ? text : `${text.replace(/\n*$/, '')}\n\n`;
}

describe('request features over HTTP', () => {
  const db = loadTestDatabase();
  const notes: string[] = [];
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let anthropic: Awaited<ReturnType<typeof startMockAnthropic>>;
  let ctx: AppCtx;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let pageTenant: Tenant;

  beforeAll(async () => {
    openai = await startMockUpstream((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as {
        model?: string;
        stream?: boolean;
        messages?: Array<{ content?: string }>;
      };
      const content = parsed.messages?.map((message) => message.content ?? '').join('\n') ?? '';
      if (parsed.model === 'gpt-fallback-primary') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      if (parsed.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseSuccess(parsed.model ?? 'gpt-test'));
        return;
      }
      const omitUsage = content.includes('usage-omitted');
      const completion = content.includes(NEEDLE) ? COMPLETION_NEEDLE : 'ok-text';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? 'gpt-test', completion, omitUsage ? null : undefined)));
    });
    anthropic = await startMockAnthropic();
    tenantA = provisionTenant(db, 'Features A');
    tenantB = provisionTenant(db, 'Features B');
    pageTenant = provisionTenant(db, 'Features Page');
    for (const tenant of [tenantA, tenantB, pageTenant]) {
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: 'sk-test-features',
        deployment: 'chat',
        upstreamModel: 'gpt-features',
        capabilities: 'temperature',
      });
      enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'chat' });
    }
    registerAnthropic(db, {
      tenantId: tenantA.tenantId,
      apiKey: 'sk-ant-features',
      endpoint: anthropic.origin,
      deployment: 'claude',
      upstreamModel: 'claude-features',
    });
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
  });

  afterAll(async () => {
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'api-examples.txt'), `${notes.join('\n\n')}\n`);
    }
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await openai.close();
    await anthropic.close();
  });

  async function post(tenant: Tenant, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: body,
    });
  }

  async function list(tenant: Tenant, query = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/request-features${query}`,
      headers: headers(tenant),
    });
  }

  async function byId(tenant: Tenant, requestId: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/request-features/${requestId}`,
      headers: headers(tenant),
    });
  }

  function featureOf(response: { json: () => unknown }): Record<string, unknown> {
    return response.json() as Record<string, unknown>;
  }

  it('records hinted and inferred tasks and hides them from the other tenant', async () => {
    const classification = await post(tenantA, {
      model: 'auto',
      task: 'classification',
      messages: [{ role: 'user', content: 'HINT-CLASSIFY extract the invoice number' }],
    });
    const extraction = await post(tenantA, {
      model: 'auto',
      task: 'extraction',
      messages: [{ role: 'user', content: 'HINT-EXTRACT hello there' }],
    });
    const reasoning = await post(tenantA, {
      model: 'auto',
      messages: [{ role: 'user', content: 'usage-omitted Explain this step by step.' }],
    });
    expect(classification.statusCode).toBe(200);
    expect(extraction.statusCode).toBe(200);
    expect(reasoning.statusCode).toBe(200);
    const ids = [classification, extraction, reasoning].map((response) => String(response.headers['x-request-id']));
    expect(new Set(ids).size).toBe(3);

    const listed = await list(tenantA);
    expect(listed.statusCode).toBe(200);
    const page = featureOf(listed);
    const features = page.features as Array<Record<string, unknown>>;
    const byRequest = new Map(features.map((row) => [row.requestId, row]));
    const classRow = byRequest.get(ids[0]);
    const extractRow = byRequest.get(ids[1]);
    const reasonRow = byRequest.get(ids[2]);
    expect(classRow).toMatchObject({
      taskCategory: 'classification',
      classificationSource: 'caller_hint',
      extractorVersion: 1,
      requestedModel: 'auto',
      selectedDeployment: 'chat',
      executionStatus: 'succeeded',
      structuredOutput: false,
      toolRequired: false,
    });
    expect(extractRow).toMatchObject({
      taskCategory: 'extraction',
      classificationSource: 'caller_hint',
      requestedModel: 'auto',
      selectedDeployment: 'chat',
    });
    expect(reasonRow).toMatchObject({
      taskCategory: 'reasoning',
      classificationSource: 'rules',
      requestedModel: 'auto',
      selectedDeployment: 'chat',
    });
    expect(reasonRow?.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
    expect((reasonRow?.inputTokenEstimate as number) > 0).toBe(true);

    const one = await byId(tenantA, ids[0] ?? '');
    expect(one.statusCode).toBe(200);
    expect(featureOf(one).requestId).toBe(ids[0]);
    const body = JSON.stringify(page) + JSON.stringify(featureOf(one));
    expect(body).not.toContain('HINT-CLASSIFY');
    expect(body).not.toContain('HINT-EXTRACT');
    expect(body).not.toContain('usage-omitted');
    expect(body).not.toContain('sk-test-features');
    expect(body).not.toContain(tenantA.secret);

    const foreignList = await list(tenantB);
    const foreignAgain = await list(tenantB);
    expect(foreignList.statusCode).toBe(200);
    expect(foreignAgain.statusCode).toBe(200);
    const foreignIds = (featureOf(foreignList).features as Array<{ requestId: string }>).map((row) => row.requestId);
    const foreignIdsAgain = (featureOf(foreignAgain).features as Array<{ requestId: string }>).map((row) => row.requestId);
    for (const id of ids) {
      expect(foreignIds).not.toContain(id);
      expect(foreignIdsAgain).not.toContain(id);
      const hidden = await byId(tenantB, id);
      const hiddenAgain = await byId(tenantB, id);
      expect(hidden.statusCode).toBe(404);
      expect(hiddenAgain.statusCode).toBe(404);
      expect(hidden.body).not.toContain('HINT-CLASSIFY');
    }

    const upstream = JSON.parse(openai.hits[0]?.body ?? '{}') as { task?: string };
    expect(upstream.task).toBeUndefined();
    notes.push(`journey list ${JSON.stringify(page)}`);
    notes.push(`journey by id ${one.body}`);
    notes.push(`tenant B list ${foreignList.body}`);
    notes.push(`tenant B by id ${JSON.stringify({ status: 404 })}`);
  });

  it('keeps the same structure across stream, provider, and model choice', async () => {
    const messages = [
      { role: 'system', content: 'Follow the instruction.' },
      { role: 'user', content: 'Explain this step by step.' },
    ];
    const silent = await post(tenantA, { model: 'auto', messages });
    const named = await post(tenantA, { model: 'chat', messages });
    const streamed = await post(tenantA, { model: 'auto', messages, stream: true });
    const claude = await post(tenantA, { model: 'claude', messages });
    expect(silent.statusCode).toBe(200);
    expect(named.statusCode).toBe(200);
    expect(streamed.statusCode).toBe(200);
    expect(claude.statusCode).toBe(200);
    expect(named.headers['x-deployment']).toBe('chat');

    const rows = await Promise.all(
      [silent, named, streamed, claude].map(async (response) => {
        const id = String(response.headers['x-request-id']);
        const read = await byId(tenantA, id);
        expect(read.statusCode).toBe(200);
        return featureOf(read);
      }),
    );
    const structural = (row: Record<string, unknown>) => ({
      taskCategory: row.taskCategory,
      classificationSource: row.classificationSource,
      messageCount: row.messageCount,
      instructionPresent: row.instructionPresent,
      conversationDepth: row.conversationDepth,
      inputSize: row.inputSize,
    });
    const expected = structural(rows[0] ?? {});
    expect(expected).toEqual({
      taskCategory: 'reasoning',
      classificationSource: 'rules',
      messageCount: 2,
      instructionPresent: true,
      conversationDepth: 1,
      inputSize: 'Follow the instruction.'.length + 'Explain this step by step.'.length,
    });
    for (const row of rows) expect(structural(row)).toEqual(expected);
    expect(rows[0]).toMatchObject({ requestedModel: 'auto', selectedDeployment: 'chat', streamRequested: false });
    expect(rows[1]).toMatchObject({ requestedModel: 'chat', selectedDeployment: 'chat', streamRequested: false });
    expect(rows[2]).toMatchObject({ requestedModel: 'auto', selectedDeployment: 'chat', streamRequested: true });
    expect(rows[3]).toMatchObject({ requestedModel: 'claude', selectedDeployment: 'claude', streamRequested: false });
    expect(rows.every((row) => row.structuredOutput === false && row.toolRequired === false)).toBe(true);
    notes.push(`shape rows ${JSON.stringify(rows.map(structural))}`);
  });

  it('stores size only for a long prompt and rejects tools and structured output', async () => {
    const prompt = `${NEEDLE} ${'alpha '.repeat(2000)}`;
    const before = openai.hits.length;
    const tools = await post(tenantA, {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    });
    const format = await post(tenantA, {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: { type: 'json_object' },
    });
    expect(tools.statusCode).toBe(400);
    expect(format.statusCode).toBe(400);
    expect(openai.hits.length).toBe(before);

    const response = await post(tenantA, {
      model: 'chat',
      messages: [{ role: 'user', content: prompt }],
    });
    expect(response.statusCode).toBe(200);
    const id = String(response.headers['x-request-id']);
    const read = await byId(tenantA, id);
    const row = featureOf(read);
    expect(row.inputSize).toBe(prompt.length);
    expect(row.inputTokenEstimate).toBe(Math.ceil(prompt.length / 4));
    expect(row.taskCategory).toBe('unknown');
    const encoded = JSON.stringify(row);
    expect(encoded).not.toContain(NEEDLE);
    expect(encoded).not.toContain(COMPLETION_NEEDLE);
    expect(encoded).not.toContain(tenantA.secret);

    const admin = adminPool(db);
    const stored = await admin.query<{ text: string }>(
      `SELECT row_to_json(request_features)::text AS text
       FROM request_features
       WHERE tenant_id = $1 AND request_id = $2`,
      [tenantA.tenantId, id],
    );
    const raw = stored.rows[0]?.text ?? '';
    expect(raw).not.toContain(NEEDLE);
    expect(raw).not.toContain(COMPLETION_NEEDLE);
    expect(raw).not.toContain(tenantA.secret);
    expect(raw).not.toContain('sk-test-features');
    await admin.end();
    notes.push(`long row ${encoded}`);
    notes.push(`stored row ${raw}`);
  });

  it('pages without repeating ids, filters, and keeps concurrent chats apart', async () => {
    const made: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await post(pageTenant, {
        model: 'auto',
        task: 'classification',
        messages: [{ role: 'user', content: `page item ${index}` }],
      });
      expect(response.statusCode).toBe(200);
      made.push(String(response.headers['x-request-id']));
    }
    const extra = await post(pageTenant, {
      model: 'auto',
      task: 'extraction',
      messages: [{ role: 'user', content: 'page extract' }],
    });
    expect(extra.statusCode).toBe(200);

    const first = await list(pageTenant, '?limit=2&category=classification');
    expect(first.statusCode).toBe(200);
    const firstPage = featureOf(first);
    const firstIds = (firstPage.features as Array<{ id: string; requestId: string }>).map((row) => row.requestId);
    expect(firstIds).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const second = await list(pageTenant, `?limit=2&category=classification&cursor=${String(firstPage.nextCursor)}`);
    expect(second.statusCode).toBe(200);
    const secondPage = featureOf(second);
    const secondIds = (secondPage.features as Array<{ requestId: string }>).map((row) => row.requestId);
    expect(secondIds).toHaveLength(1);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(made));

    const onlyExtraction = await list(pageTenant, '?category=extraction');
    const extractionIds = (featureOf(onlyExtraction).features as Array<{ requestId: string; taskCategory: string }>).map(
      (row) => row.taskCategory,
    );
    expect(extractionIds).toEqual(['extraction']);

    expect((await list(pageTenant, '?category=nope')).statusCode).toBe(400);
    expect((await list(pageTenant, '?limit=0')).statusCode).toBe(400);
    expect((await list(pageTenant, '?limit=51')).statusCode).toBe(400);
    expect((await list(pageTenant, '?cursor=not-a-uuid')).statusCode).toBe(400);

    const [left, right] = await Promise.all([
      post(pageTenant, {
        model: 'auto',
        task: 'writing',
        messages: [{ role: 'user', content: 'concurrent write one' }],
      }),
      post(pageTenant, {
        model: 'auto',
        task: 'translation',
        messages: [{ role: 'user', content: 'concurrent translate two' }],
      }),
    ]);
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    const leftId = String(left.headers['x-request-id']);
    const rightId = String(right.headers['x-request-id']);
    expect(leftId).not.toBe(rightId);
    const leftRow = featureOf(await byId(pageTenant, leftId));
    const rightRow = featureOf(await byId(pageTenant, rightId));
    expect(leftRow.taskCategory).toBe('writing');
    expect(rightRow.taskCategory).toBe('translation');
    expect(leftRow.requestId).toBe(leftId);
    expect(rightRow.requestId).toBe(rightId);

    const started = performance.now();
    await list(pageTenant, '?limit=2');
    const listMs = performance.now() - started;
    const extractStarted = performance.now();
    extractRequestFeatures({
      messages: [{ role: 'user', content: 'alpha '.repeat(4000) }],
      stream: false,
      requestedModel: 'auto',
      taskHint: null,
      structuredOutput: false,
      toolRequired: false,
    });
    const extractMs = performance.now() - extractStarted;
    notes.push(`page first ${first.body}`);
    notes.push(`page second ${second.body}`);
    notes.push(`filter extraction ${onlyExtraction.body}`);
    notes.push(`performance listMs=${listMs.toFixed(3)} extractMs=${extractMs.toFixed(3)}`);
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, 'performance-measurements.txt'),
        `list route ${listMs.toFixed(3)} ms\nextract ${extractMs.toFixed(3)} ms\n`,
      );
      writeFileSync(join(evidenceDir, 'tenant-isolation.txt'), `tenant B cannot read tenant A\n${notes.join('\n')}\n`);
    }
  });

  it('still succeeds when the extractor throws', async () => {
    const throwing = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      extractFeatures() {
        throw new Error('extractor failed');
      },
    });
    try {
      const response = await throwing.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: headers(tenantA),
        payload: { model: 'auto', messages: [{ role: 'user', content: THROW_PROMPT }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ choices: [{ message: { content: 'ok-text' } }] });
      const id = String(response.headers['x-request-id']);
      const admin = adminPool(db);
      const status = await admin.query<{ status: string }>(`SELECT status FROM proxy_requests WHERE id = $1`, [id]);
      const count = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM request_features WHERE request_id = $1`,
        [id],
      );
      expect(status.rows[0]?.status).toBe('succeeded');
      expect(count.rows[0]?.count).toBe('0');
      await admin.end();
      const logged = throwing.lines.join('\n');
      expect(logged).toContain('request features were not recorded');
      expect(logged).not.toContain(THROW_PROMPT);
      const missing = await byId(tenantA, id);
      expect(missing.statusCode).toBe(404);
    } finally {
      await throwing.app.close();
      await throwing.authPool.end();
      await throwing.runtimePool.end();
    }
  });

  it('returns the other row from the same millisecond on the next page', async () => {
    const tenant = provisionTenant(db, 'Features Same Millisecond');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-features',
      deployment: 'chat',
      upstreamModel: 'gpt-features',
      capabilities: 'temperature',
    });
    const first = await post(tenant, {
      model: 'auto',
      task: 'classification',
      messages: [{ role: 'user', content: 'same millisecond one' }],
    });
    const second = await post(tenant, {
      model: 'auto',
      task: 'classification',
      messages: [{ role: 'user', content: 'same millisecond two' }],
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const earlierId = String(first.headers['x-request-id']);
    const laterId = String(second.headers['x-request-id']);
    const admin = adminPool(db);
    await admin.query(
      `UPDATE request_features
       SET created_at = CASE request_id
         WHEN $1::uuid THEN timestamptz '2026-10-22 18:00:00.000100+00'
         WHEN $2::uuid THEN timestamptz '2026-10-22 18:00:00.000900+00'
       END
       WHERE tenant_id = $3 AND request_id IN ($1::uuid, $2::uuid)`,
      [earlierId, laterId, tenant.tenantId],
    );
    await admin.end();

    const page = await list(tenant, '?limit=1');
    expect(page.statusCode).toBe(200);
    const firstPage = featureOf(page);
    const firstRows = firstPage.features as Array<{ requestId: string }>;
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]?.requestId).toBe(laterId);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const next = await list(tenant, `?limit=1&cursor=${String(firstPage.nextCursor)}`);
    expect(next.statusCode).toBe(200);
    const secondPage = featureOf(next);
    const secondRows = secondPage.features as Array<{ requestId: string }>;
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]?.requestId).toBe(earlierId);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('records the finished attempt when fallback credential open throws', async () => {
    const tenant = provisionTenant(db, 'Features Fallback Open');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-features',
      deployment: 'feat-primary',
      upstreamModel: 'gpt-fallback-primary',
      capabilities: 'temperature',
    });
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-features-fallback',
      endpoint: anthropic.origin,
      deployment: 'feat-secondary',
      upstreamModel: 'claude-fallback',
    });
    const env = cliEnv();
    runCli(
      db,
      [
        'set-deployment-context-limit',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'feat-secondary',
        '--context-limit',
        '128',
      ],
      env,
    );
    runCli(
      db,
      [
        'set-deployment-data-collection',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'feat-secondary',
        '--data-collection',
        'allow',
      ],
      env,
    );
    const admin = adminPool(db);
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live'
       WHERE tenant_id = $1 AND name = 'feat-secondary'`,
      [tenant.tenantId],
    );
    runCli(
      db,
      [
        'set-fallback-policy',
        '--tenant-id',
        tenant.tenantId,
        '--alias',
        'auto',
        '--enabled',
        'true',
        '--deployments',
        'feat-secondary',
        '--failures',
        'unavailable',
        '--max-attempts',
        '2',
        '--capabilities',
        'temperature',
        '--providers',
        'anthropic',
        '--data-collection',
        'allow',
        '--min-remaining-deadline-ms',
        '0',
      ],
      env,
    );
    const broken = `aes-256-gcm$9$${'x'.repeat(30)}`;
    await admin.query(
      `UPDATE provider_connections
       SET protected_credential = $2
       WHERE tenant_id = $1 AND provider = 'anthropic'`,
      [tenant.tenantId, broken],
    );

    const prompt = 'FALLBACK-OPEN-06A classify this ticket';
    const response = await post(tenant, {
      model: 'auto',
      messages: [{ role: 'user', content: prompt }],
    });
    expect(response.statusCode).toBe(503);
    const requestId = String(response.headers['x-request-id']);
    const attempts = await admin.query<{ ordinal: number; duration_ms: number | null; name: string }>(
      `SELECT a.attempt_ordinal AS ordinal, a.duration_ms, d.name
       FROM model_attempts a
       JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
       WHERE a.request_id = $1
       ORDER BY a.attempt_ordinal`,
      [requestId],
    );
    expect(attempts.rows.map((row) => row.name)).toEqual(['feat-primary', 'feat-secondary']);
    expect(attempts.rows[0]?.duration_ms).toEqual(expect.any(Number));
    expect(attempts.rows[1]?.duration_ms).toBeNull();
    await admin.end();

    const read = await byId(tenant, requestId);
    expect(read.statusCode).toBe(200);
    const row = featureOf(read);
    expect(row.executionStatus).toBe('failed');
    expect(row.selectedDeployment).toBe('feat-primary');
    expect(row.requestedModel).toBe('auto');
    expect(row.taskCategory).toBe('classification');
    expect(row.classificationSource).toBe('rules');
    expect(JSON.stringify(row)).not.toContain(prompt);
    expect(JSON.stringify(row)).not.toContain('sk-ant-features-fallback');
    expect(JSON.stringify(row)).not.toContain(tenant.secret);
  });

  it('keeps migration 016 readable after the additive file', async () => {
    const ready = await ctx.runtimePool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      '016_fallback_policy.sql',
    ]);
    const added = await ctx.runtimePool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      '017_request_features.sql',
    ]);
    expect(ready.rowCount).toBe(1);
    expect(added.rowCount).toBe(1);
    const sql = readFileSync(join(projectRoot, 'migrations/017_request_features.sql'), 'utf8');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const proof = [
      'readiness version 016_fallback_policy.sql row count 1',
      'applied version 017_request_features.sql row count 1',
      '017_request_features.sql does not drop a table or a column',
    ].join('\n');
    notes.push(proof);
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'rollback.txt'), `${proof}\n`);
      writeFileSync(join(evidenceDir, 'schema-and-migration.txt'), sql);
    }
  });
});
