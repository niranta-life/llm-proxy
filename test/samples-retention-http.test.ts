import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import { buildApp } from '../src/http/app.js';
import { runSampleCleanup } from '../src/inference/sample-jobs.js';
import { configFor, createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const PROMPT = 'sample-retain-prompt-zeta-06c';
const COMPLETION = 'sample-retain-completion-zeta-06c';
const evidenceDir = process.env.SLICE_06C_EVIDENCE;
const TASKS = ['classification', 'extraction', 'summarization', 'reasoning', 'coding', 'translation', 'writing', 'general_qa'];

type Tenant = { tenantId: string; secret: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;
type Stats = {
  retained: number;
  cap: number;
  recentShare: number;
  recent: number;
  diverse: number;
  categories: Record<string, number>;
  sizeBands: Record<string, number>;
  complexity: Record<string, number>;
  deployments: Record<string, number>;
};
type JourneySummary = {
  retained: number;
  cap: number;
  recent: number;
  diverse: number;
  categories: number;
  bands: number;
  complexity: number;
  deployment: number;
  deleted: number;
  chats: number;
};

const journeyNotes: string[] = [];
const retentionNotes: string[] = [];
const apiNotes: string[] = [];
const isolationNotes: string[] = [];
const logBuckets: string[][] = [];
let rollbackProof = '';

function headers(tenant: Tenant, json = false): Record<string, string> {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
  };
}

function safe(text: string): string {
  if (text.includes(PROMPT) || text.includes(COMPLETION)) throw new Error('evidence contains sample text');
  return text.endsWith('\n') ? text : `${text}\n`;
}

function chatBody(index: number): Record<string, unknown> {
  const task = TASKS[index % TASKS.length] ?? 'unknown';
  const pad = index % 5 === 0 ? 'x'.repeat(900) : 'x'.repeat(12);
  return {
    model: 'chat',
    task,
    messages: [{ role: 'user', content: `${PROMPT} ${task} ${index} ${pad}` }],
    temperature: 0,
  };
}

describe('sample retention over HTTP', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;

  beforeAll(async () => {
    openai = await startMockUpstream((_hit, _request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', COMPLETION)));
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
      writeFileSync(join(evidenceDir, 'retention.txt'), safe(retentionNotes.join('\n\n')));
      writeFileSync(join(evidenceDir, 'api-output.txt'), safe(apiNotes.join('\n\n')));
      writeFileSync(join(evidenceDir, 'tenant-isolation.txt'), safe(isolationNotes.join('\n\n')));
      const schema = rollbackProof.length > 0 ? rollbackProof : await schemaNotes(admin);
      writeFileSync(join(evidenceDir, 'schema.txt'), safe(schema));
      writeFileSync(join(evidenceDir, 'rollback.txt'), safe(schema));
    }
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  async function post(app: AppCtx, tenant: Tenant, body: Record<string, unknown>) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant, true),
      payload: body,
    });
  }

  function tenantPair(label: string): { a: Tenant; b: Tenant } {
    const a = provisionTenant(db, `${label} A`);
    const b = provisionTenant(db, `${label} B`);
    for (const tenant of [a, b]) {
      registerInference(db, {
        tenantId: tenant.tenantId,
        apiKey: 'sk-test-retention',
        deployment: 'chat',
        upstreamModel: 'gpt-retention',
      });
    }
    return { a, b };
  }

  function enableCapture(tenantId: string, extra: string[] = []): void {
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        tenantId,
        '--mode',
        'encrypted_sample',
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
        '--classifications',
        'internal',
        '--providers',
        'openai',
        '--deployments',
        'chat',
        ...extra,
      ],
      cliEnv(),
    );
  }

  async function storedCount(tenantId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM request_samples WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function auditCount(tenantId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM sample_deletions WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function stats(tenant: Tenant): Promise<Stats> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/samples/stats',
      headers: headers(tenant),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Stats;
  }

  async function journey(label: string): Promise<JourneySummary> {
    const { a, b } = tenantPair(label);
    enableCapture(a.tenantId);
    const shown = runCli(db, ['show-sample-policy', '--tenant-id', a.tenantId], cliEnv()) as {
      maxSampleCount?: number;
      retentionSeconds?: number;
      recentShare?: number | string;
      mode?: string;
    };
    expect(shown.mode).toBe('encrypted_sample');
    expect(shown.maxSampleCount).toBe(100);
    expect(shown.retentionSeconds).toBe(604800);
    expect(Number(shown.recentShare)).toBeCloseTo(0.6, 5);

    let chats = 0;
    for (let index = 0; index < 110; index += 1) {
      const response = await post(ctx, a, chatBody(index));
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-attempt-count']).toBe('1');
      chats += 1;
    }
    const count = await storedCount(a.tenantId);
    expect(count).toBeLessThanOrEqual(100);
    expect(count).toBe(100);
    const body = await stats(a);
    expect(body.retained).toBe(count);
    expect(body.cap).toBe(100);
    expect(body.recent).toBe(60);
    expect(body.diverse).toBe(40);
    expect(body.recent + body.diverse).toBe(body.retained);
    expect(Object.keys(body.categories).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(body.sizeBands).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(body.complexity).length).toBeGreaterThanOrEqual(2);
    expect(body.deployments.chat).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(PROMPT);
    expect(JSON.stringify(body)).not.toContain(COMPLETION);
    expect(JSON.stringify(body)).not.toContain('ciphertext');

    const cliStats = runCli(db, ['show-sample-stats', '--tenant-id', a.tenantId], cliEnv()) as Stats;
    expect(cliStats.retained).toBe(body.retained);
    expect(cliStats.categories).toEqual(body.categories);

    const span = await admin.query<{ seconds: number }>(
      `SELECT extract(epoch FROM (expires_at - created_at))::float AS seconds
       FROM request_samples WHERE tenant_id = $1 LIMIT 1`,
      [a.tenantId],
    );
    expect(Math.abs((span.rows[0]?.seconds ?? 0) - 604800)).toBeLessThan(1);

    const list = await ctx.app.inject({ method: 'GET', url: '/internal/v1/samples?limit=1', headers: headers(a) });
    expect(list.statusCode).toBe(200);
    const sampleId = (list.json() as { samples: Array<{ id: string }> }).samples[0]?.id ?? '';
    expect(sampleId).not.toBe('');
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/internal/v1/samples/${sampleId}`,
      headers: headers(a),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ deleted: true });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${sampleId}`,
      headers: headers(a),
    });
    expect(denied.statusCode).toBe(404);
    expect(await storedCount(a.tenantId)).toBe(99);

    const foreignList = await ctx.app.inject({ method: 'GET', url: '/internal/v1/samples', headers: headers(b) });
    const foreignOne = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${sampleId}`,
      headers: headers(b),
    });
    const foreignDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/internal/v1/samples/${sampleId}`,
      headers: headers(b),
    });
    const foreignStats = await stats(b);
    expect(foreignList.statusCode).toBe(200);
    expect(foreignList.json().samples).toEqual([]);
    expect(foreignOne.statusCode).toBe(404);
    expect(foreignDelete.statusCode).toBe(404);
    expect(foreignStats.retained).toBe(0);
    expect(await storedCount(a.tenantId)).toBe(99);

    const summary: JourneySummary = {
      retained: body.retained,
      cap: body.cap,
      recent: body.recent,
      diverse: body.diverse,
      categories: Object.keys(body.categories).length,
      bands: Object.keys(body.sizeBands).length,
      complexity: Object.keys(body.complexity).length,
      deployment: body.deployments.chat ?? 0,
      deleted: denied.statusCode,
      chats,
    };
    journeyNotes.push(
      [
        label,
        `chats ${chats}`,
        `retained ${summary.retained} cap ${summary.cap}`,
        `recent ${summary.recent} diverse ${summary.diverse}`,
        `categories ${summary.categories} bands ${summary.bands} complexity ${summary.complexity}`,
        `deployment ${summary.deployment}`,
        `delete status ${removed.statusCode} read after delete ${denied.statusCode}`,
      ].join('\n'),
    );
    apiNotes.push(JSON.stringify(body));
    apiNotes.push(removed.body);
    isolationNotes.push(`${label} foreign list ${foreignList.statusCode} delete ${foreignDelete.statusCode} stats ${foreignStats.retained}`);
    return summary;
  }

  it('keeps at most the default cap and denies a deleted sample', async () => {
    const first = await journey('pass-1');
    const second = await journey('pass-2');
    expect(second).toEqual(first);
  }, 180_000);

  it('keeps one copy, stays inside a small cap, and isolates tenants under a race', async () => {
    const { a, b } = tenantPair('race');
    enableCapture(a.tenantId, ['--max-sample-count', '4', '--retention-seconds', '86400']);
    const same = chatBody(1);
    const first = await post(ctx, a, same);
    const second = await post(ctx, a, same);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await storedCount(a.tenantId)).toBe(1);

    await Promise.all(
      Array.from({ length: 8 }, (_item, index) => post(ctx, a, chatBody(100 + index))),
    );
    expect(await storedCount(a.tenantId)).toBeLessThanOrEqual(4);
    const attempts = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_attempts
       WHERE request_id IN (SELECT id FROM proxy_requests WHERE tenant_id = $1)`,
      [a.tenantId],
    );
    const requests = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM proxy_requests WHERE tenant_id = $1',
      [a.tenantId],
    );
    expect(attempts.rows[0]?.count).toBe(requests.rows[0]?.count);
    expect(await storedCount(b.tenantId)).toBe(0);
    retentionNotes.push(`race retained ${await storedCount(a.tenantId)} of cap 4`);
  }, 60_000);

  it('expires, revokes, restores, and cleans up once', async () => {
    const { a, b } = tenantPair('expire');
    enableCapture(a.tenantId, ['--max-sample-count', '10', '--retention-seconds', '1']);
    enableCapture(b.tenantId, ['--max-sample-count', '10', '--retention-seconds', '1']);
    const stored = await post(ctx, a, chatBody(3));
    const other = await post(ctx, b, chatBody(4));
    expect(stored.statusCode).toBe(200);
    expect(other.statusCode).toBe(200);
    expect(await storedCount(a.tenantId)).toBe(1);
    expect(await storedCount(b.tenantId)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const hidden = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/samples',
      headers: headers(a),
    });
    expect(hidden.json().samples).toEqual([]);
    expect(await storedCount(a.tenantId)).toBe(1);

    const migrator = createPool(configFor(db), 'migrator', undefined, 1);
    const key = 'expire-cleanup:once:retention';
    try {
      const first = await runSampleCleanup(migrator, { idempotencyKey: key, tenantId: a.tenantId });
      expect(first.status).toBe('succeeded');
      expect(first.removed).toBe(1);
      expect(await storedCount(a.tenantId)).toBe(0);
      expect(await storedCount(b.tenantId)).toBe(1);
      const audits = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM sample_deletions WHERE tenant_id = $1 AND reason = 'expired'`,
        [a.tenantId],
      );
      expect(audits.rows[0]?.count).toBe(1);
      const second = await runSampleCleanup(migrator, { idempotencyKey: key, tenantId: a.tenantId });
      expect(second.status).toBe('idle');
      expect(second.removed).toBe(0);
      expect(audits.rows[0]?.count).toBe(1);

      const crashKey = 'expire-cleanup:crash:retention';
      await expect(
        runSampleCleanup(migrator, {
          idempotencyKey: crashKey,
          tenantId: b.tenantId,
          crashAfterCommit: true,
        }),
      ).rejects.toThrow('sample cleanup crashed');
      expect(await storedCount(b.tenantId)).toBe(0);
      const beforeRetry = await auditCount(b.tenantId);
      expect(beforeRetry).toBe(1);
      await admin.query(
        `UPDATE sample_jobs SET locked_until = now() - interval '1 minute' WHERE idempotency_key = $1`,
        [crashKey],
      );
      const retried = await runSampleCleanup(migrator, { idempotencyKey: crashKey, tenantId: b.tenantId });
      expect(retried.status).toBe('succeeded');
      expect(retried.removed).toBe(0);
      expect(await auditCount(b.tenantId)).toBe(beforeRetry);
      const job = await admin.query<{ status: string; payload: string; last_error: string | null }>(
        `SELECT status, payload::text AS payload, last_error FROM sample_jobs WHERE idempotency_key = $1`,
        [crashKey],
      );
      expect(job.rows[0]?.status).toBe('succeeded');
      expect(job.rows[0]?.payload).toBe('{"kind": "expire_cleanup"}');
      expect(job.rows[0]?.last_error).toBeNull();

      const again = await runSampleCleanup(migrator, { idempotencyKey: crashKey, tenantId: b.tenantId });
      expect(again.status).toBe('idle');
      expect(await auditCount(b.tenantId)).toBe(beforeRetry);
    } finally {
      await migrator.end();
    }
    retentionNotes.push('expiry cleanup removed one row and the retry did not write a second audit');
  }, 60_000);

  it('rolls back a failed cleanup and hides revoked or restored rows', async () => {
    const { a, b } = tenantPair('revoke');
    enableCapture(a.tenantId, ['--max-sample-count', '10', '--retention-seconds', '86400']);
    enableCapture(b.tenantId, ['--max-sample-count', '10', '--retention-seconds', '86400']);
    const created = await post(ctx, a, chatBody(7));
    const neighbor = await post(ctx, b, chatBody(8));
    expect(created.statusCode).toBe(200);
    expect(neighbor.statusCode).toBe(200);
    const sampleId = String(
      (
        await admin.query<{ id: string }>(
          'SELECT id::text AS id FROM request_samples WHERE tenant_id = $1',
          [a.tenantId],
        )
      ).rows[0]?.id,
    );
    const visible = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${sampleId}`,
      headers: headers(a),
    });
    expect(visible.statusCode).toBe(200);

    let revoke = true;
    const app = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      beforeSampleStore: () => {
        if (!revoke) return;
        revoke = false;
        runCli(db, ['set-sample-policy', '--tenant-id', a.tenantId, '--mode', 'disabled'], cliEnv());
      },
    });
    logBuckets.push(app.lines);
    try {
      const during = await post(app, a, chatBody(9));
      expect(during.statusCode).toBe(200);
      expect(during.headers['x-attempt-count']).toBe('1');
      const attempts = await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM model_attempts WHERE request_id = $1',
        [String(during.headers['x-request-id'])],
      );
      expect(attempts.rows[0]?.count).toBe(1);
      expect(await storedCount(a.tenantId)).toBe(1);
    } finally {
      await app.app.close();
      await app.authPool.end();
      await app.runtimePool.end();
    }

    const list = await ctx.app.inject({ method: 'GET', url: '/internal/v1/samples', headers: headers(a) });
    const one = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/samples/${sampleId}`,
      headers: headers(a),
    });
    const revokedStats = await stats(a);
    expect(list.json().samples).toEqual([]);
    expect(one.statusCode).toBe(404);
    expect(revokedStats.retained).toBe(0);
    expect(await storedCount(a.tenantId)).toBe(1);

    const held = await admin.query(
      `SELECT * FROM request_samples WHERE id = $1`,
      [sampleId],
    );
    const row = held.rows[0] as Record<string, unknown>;
    expect(row).toBeDefined();

    const migrator = createPool(configFor(db), 'migrator', undefined, 1);
    try {
      const interrupted = await runSampleCleanup(migrator, {
        idempotencyKey: 'expire-cleanup:interrupt:retention',
        tenantId: null,
        interruptBeforeCommit: true,
      });
      expect(interrupted.status).toBe('failed');
      expect(interrupted.removed).toBe(0);
      expect(await storedCount(a.tenantId)).toBe(1);
      expect(await storedCount(b.tenantId)).toBe(1);
      const chat = await post(ctx, a, chatBody(11));
      expect(chat.statusCode).toBe(200);
      expect(chat.headers['x-attempt-count']).toBe('1');

      const cleaned = await runSampleCleanup(migrator, {
        idempotencyKey: 'expire-cleanup:revoked:retention',
        tenantId: a.tenantId,
      });
      expect(cleaned.removed).toBe(1);
      expect(await storedCount(a.tenantId)).toBe(0);
      expect(await storedCount(b.tenantId)).toBe(1);
      const reason = await admin.query<{ reason: string }>(
        `SELECT reason FROM sample_deletions WHERE tenant_id = $1`,
        [a.tenantId],
      );
      expect(reason.rows.map((item) => item.reason)).toContain('revoked');

      await restoreSample(admin, row, {
        createdAt: new Date(Date.now() - 86_400_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      });
      const expiredRead = await ctx.app.inject({
        method: 'GET',
        url: `/internal/v1/samples/${sampleId}`,
        headers: headers(a),
      });
      expect(expiredRead.statusCode).toBe(404);
      const expiredCleanup = await runSampleCleanup(migrator, {
        idempotencyKey: 'expire-cleanup:restored-expired:retention',
        tenantId: a.tenantId,
      });
      expect(expiredCleanup.removed).toBe(1);
      expect(await storedCount(a.tenantId)).toBe(0);

      await restoreSample(admin, row, {
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const restoredRead = await ctx.app.inject({
        method: 'GET',
        url: `/internal/v1/samples/${sampleId}`,
        headers: headers(a),
      });
      const restoredStats = await stats(a);
      expect(restoredRead.statusCode).toBe(404);
      expect(restoredStats.retained).toBe(0);
      const restoredCleanup = await runSampleCleanup(migrator, {
        idempotencyKey: 'expire-cleanup:restored-revoked:retention',
        tenantId: a.tenantId,
      });
      expect(restoredCleanup.removed).toBe(1);
      const repeat = await runSampleCleanup(migrator, {
        idempotencyKey: 'expire-cleanup:restored-revoked:retention',
        tenantId: a.tenantId,
      });
      expect(repeat.status).toBe('idle');
      expect(await storedCount(a.tenantId)).toBe(0);
      expect(await storedCount(b.tenantId)).toBe(1);
    } finally {
      await migrator.end();
    }

    await assertNoPlaintext(admin, a.tenantId, logBuckets);
    retentionNotes.push('revocation hid the row before cleanup and a restored row stayed unreadable');
  }, 60_000);

  it('keeps migration 018 ready after the retention migration', async () => {
    const ready = await ctx.runtimePool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      '018_sample_capture.sql',
    ]);
    const added = await ctx.runtimePool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      '019_sample_retention.sql',
    ]);
    expect(ready.rowCount).toBe(1);
    expect(added.rowCount).toBe(1);
    const sql = readFileSync(join(projectRoot, 'migrations/019_sample_retention.sql'), 'utf8');
    expect(sql).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    const rollback = buildApp({
      logger: ctx.logger,
      authPool: ctx.authPool,
      runtimePool: ctx.runtimePool,
      readyVersion: '018_sample_capture.sql',
      inferenceEnabled: false,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey: null,
      maxActiveStreams: 1,
      maxStreamsPerTenant: 1,
    });
    const response = await rollback.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', database: 'ready' });
    await rollback.close();
    rollbackProof = [
      `GET /health/ready for 018_sample_capture.sql status ${response.statusCode}`,
      response.body,
      'readiness version 018_sample_capture.sql row count 1',
      'applied version 019_sample_retention.sql row count 1',
      '019_sample_retention.sql does not drop a table or a column',
    ].join('\n');
  });
});

async function restoreSample(
  admin: ReturnType<typeof adminPool>,
  row: Record<string, unknown>,
  times: { createdAt: Date; expiresAt: Date },
): Promise<void> {
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
      row.id,
      row.tenant_id,
      row.request_id,
      row.policy_id,
      row.policy_version,
      row.provider,
      row.deployment_name,
      row.data_classification,
      row.schema_version,
      row.size_bytes,
      row.wrapping_key_version,
      row.wrapped_key_iv,
      row.wrapped_key_tag,
      row.wrapped_key_ciphertext,
      row.content_iv,
      row.content_tag,
      row.content_ciphertext,
      times.createdAt,
      times.expiresAt,
      row.fingerprint,
      row.slot,
      row.task_category,
      row.input_size,
      row.complexity,
    ],
  );
}

async function assertNoPlaintext(
  admin: ReturnType<typeof adminPool>,
  tenantId: string,
  buckets: string[][],
): Promise<void> {
  const leaked = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM request_samples
     WHERE tenant_id = $1
       AND (
         position($2::bytea IN content_ciphertext) > 0
         OR position($2::bytea IN wrapped_key_ciphertext) > 0
         OR position($3::bytea IN content_ciphertext) > 0
         OR coalesce(task_category, '') LIKE '%' || $4 || '%'
         OR coalesce(deployment_name, '') LIKE '%' || $4 || '%'
         OR coalesce(slot, '') LIKE '%' || $4 || '%'
       )`,
    [tenantId, Buffer.from(PROMPT), Buffer.from(COMPLETION), PROMPT],
  );
  expect(leaked.rows[0]?.count).toBe(0);
  const audit = await admin.query<{ text: string }>(
    `SELECT reason || ' ' || policy_version::text AS text FROM sample_deletions WHERE tenant_id = $1`,
    [tenantId],
  );
  for (const row of audit.rows) {
    expect(row.text).not.toContain(PROMPT);
    expect(row.text).not.toContain(COMPLETION);
  }
  const jobs = await admin.query<{ text: string }>(
    `SELECT coalesce(last_error, '') || ' ' || payload::text || ' ' || idempotency_key AS text FROM sample_jobs`,
  );
  for (const row of jobs.rows) {
    expect(row.text).not.toContain(PROMPT);
    expect(row.text).not.toContain(COMPLETION);
  }
  const logs = buckets.map((lines) => lines.join('\n')).join('\n');
  expect(logs).not.toContain(PROMPT);
  expect(logs).not.toContain(COMPLETION);
}

async function schemaNotes(admin: ReturnType<typeof adminPool>): Promise<string> {
  const ready = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM schema_migrations WHERE version = '018_sample_capture.sql'`,
  );
  const added = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM schema_migrations WHERE version = '019_sample_retention.sql'`,
  );
  const sql = readFileSync(join(projectRoot, 'migrations/019_sample_retention.sql'), 'utf8');
  const drops = /\bDROP\s+(COLUMN|TABLE)\b/i.test(sql);
  return [
    `readiness version 018_sample_capture.sql row count ${ready.rows[0]?.count ?? 0}`,
    `applied version 019_sample_retention.sql row count ${added.rows[0]?.count ?? 0}`,
    drops ? '019 drops a table or a column' : '019_sample_retention.sql does not drop a table or a column',
  ].join('\n');
}

