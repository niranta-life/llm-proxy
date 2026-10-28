import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withTenant } from '../src/db/tenant-context.js';
import { createTestApp, loadTestDatabase, runCli, type TestDatabase } from './helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function authHeaders(tenantId: string, secret: string, idempotencyKey?: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
  };
}

function policyBody(input: {
  name?: string;
  baseline?: string;
  candidates?: string[];
  segments?: string[];
} = {}): Record<string, unknown> {
  return {
    name: input.name ?? 'auto-shadow',
    alias: 'auto',
    baselineDeployment: input.baseline ?? 'alpha-chat',
    candidateDeployments: input.candidates ?? ['alpha-chat', 'alpha-spare'],
    qualityMinPassRate: '0.90000',
    qualityMinValidPairs: 20,
    maxCostPerRequest: '0.05000000',
    maxLatencyMs: 4000,
    taskSegments: input.segments ?? ['coding', 'general_qa'],
  };
}

async function grantRouting(admin: pg.Pool, tenantId: string, keyId: string): Promise<void> {
  await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [tenantId, keyId]);
  await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [tenantId, keyId]);
}

async function boot(
  db: TestDatabase,
  input: { name: string; deployment?: string; upstream?: string; spare?: boolean },
) {
  const deployment = input.deployment ?? 'alpha-chat';
  const mock = await startMockUpstream();
  const tenant = provisionTenant(db, input.name);
  registerInference(db, {
    tenantId: tenant.tenantId,
    apiKey: `sk-route-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
    deployment,
    upstreamModel: input.upstream ?? 'gpt-baseline',
  });
  if (input.spare !== false) {
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'alpha-spare',
        '--upstream-model',
        'gpt-spare',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
  }
  const chat = runCli(db, ['add-key', '--tenant-id', tenant.tenantId, '--label', 'chat']);
  const ctx = await createTestApp(db, {
    inferenceEnabled: true,
    upstreamBaseUrl: mock.baseUrl,
    credentialKey,
  });
  const admin = adminPool(db);
  await grantRouting(admin, tenant.tenantId, tenant.keyId);
  closers.push(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await mock.close();
  });
  return { mock, tenant, chat, ctx, admin, deployment };
}

describe('routing policy foundation', () => {
  const db = loadTestDatabase();

  it('stores an immutable version and replays the same idempotency key', async () => {
    const harness = await boot(db, { name: 'Route Immutable' });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret, 'policy-create-1');
    const created = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers,
      payload: policyBody(),
    });
    expect(created.statusCode).toBe(201);
    const policy = created.json();
    expect(policy.status).toBe('draft');
    expect(policy.epoch).toBe(1);
    expect(policy.version).toBe(1);
    expect(policy.alias).toBe('auto');
    expect(policy.baselineDeployment).toBe('alpha-chat');
    expect(policy.candidateDeployments).toEqual(['alpha-chat', 'alpha-spare']);
    expect(policy.qualityMinPassRate).toBe('0.90000');
    expect(policy.maxCostPerRequest).toBe('0.05000000');
    expect(policy.taskSegments).toEqual(['coding', 'general_qa']);
    expect(policy.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.events).toEqual([{ status: 'draft', epoch: 1, versionId: policy.versionId }]);
    console.log(`EVIDENCE policy-api ${JSON.stringify(policy)}`);

    const replay = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers,
      payload: policyBody(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(policy.id);
    expect(replay.json().versionId).toBe(policy.versionId);

    const conflict = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret, 'policy-create-1'),
      payload: { ...policyBody(), maxLatencyMs: 1000 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');

    const renamed = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret, 'policy-create-2'),
      payload: policyBody({ name: 'auto-shadow' }),
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().error.code).toBe('policy_name_conflict');

    const listed = await harness.ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/policies',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().policies.map((item: { id: string }) => item.id)).toEqual([policy.id]);

    const read = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies/${policy.id}`,
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().versionId).toBe(policy.versionId);

    await expect(
      harness.admin.query('UPDATE routing_policy_versions SET max_latency_ms = 10 WHERE id = $1', [policy.versionId]),
    ).rejects.toThrow(/immutable/i);
    const stored = await harness.admin.query<{ max_latency_ms: number; versions: number }>(
      `SELECT max(v.max_latency_ms) AS max_latency_ms, count(*)::int AS versions
       FROM routing_policy_versions v
       WHERE v.policy_id = $1`,
      [policy.id],
    );
    expect(stored.rows[0]).toEqual({ max_latency_ms: 4000, versions: 1 });
  });

  it('rejects an invalid policy, a missing baseline, a disabled deployment, an unknown alias, and a foreign candidate', async () => {
    const harness = await boot(db, { name: 'Route Reject' });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    const invalid = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: { ...headers, 'idempotency-key': 'bad-body' },
      payload: { ...policyBody(), alias: 'manual', extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_parameter');

    const missing = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: { ...headers, 'idempotency-key': 'missing-baseline' },
      payload: policyBody({ baseline: 'missing-chat' }),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('missing_baseline');

    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        harness.tenant.tenantId,
        '--name',
        'alpha-off',
        '--upstream-model',
        'gpt-off',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'false',
      ],
      cliEnv(),
    );
    const disabledCandidate = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: { ...headers, 'idempotency-key': 'disabled-candidate' },
      payload: policyBody({ candidates: ['alpha-off'] }),
    });
    expect(disabledCandidate.statusCode).toBe(400);
    expect(disabledCandidate.json().error.code).toBe('deployment_disabled');
    const disabledBaseline = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: { ...headers, 'idempotency-key': 'disabled-baseline' },
      payload: policyBody({ baseline: 'alpha-off', candidates: ['alpha-spare'] }),
    });
    expect(disabledBaseline.statusCode).toBe(400);
    expect(disabledBaseline.json().error.code).toBe('deployment_disabled');

    const other = provisionTenant(db, 'Route Other Candidate');
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-route-other-candidate',
      deployment: 'beta-chat',
      upstreamModel: 'gpt-beta',
    });
    const foreign = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: { ...headers, 'idempotency-key': 'foreign-candidate' },
      payload: policyBody({ candidates: ['beta-chat'] }),
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('candidate_not_in_tenant');
    const beta = await harness.admin.query<{ id: string }>(
      `SELECT id::text AS id FROM model_deployments WHERE tenant_id = $1 AND name = 'beta-chat'`,
      [other.tenantId],
    );
    const stored = await harness.admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM routing_policy_versions
       WHERE baseline_deployment_id = $1 OR $1 = ANY(candidate_deployment_ids)`,
      [beta.rows[0]?.id],
    );
    expect(stored.rows[0]?.count).toBe(0);

    await harness.admin.query('DELETE FROM model_aliases WHERE tenant_id = $1', [harness.tenant.tenantId]);
    const unknown = await harness.ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: { ...headers, 'idempotency-key': 'unknown-alias' },
      payload: policyBody({ name: 'auto-later' }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('unknown_alias');
  });

  it('rejects a stale update and a second shadow activation', async () => {
    const harness = await boot(db, { name: 'Route Activation' });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    const first = await createPolicy(harness, 'shadow-a', 'act-a');
    const second = await createPolicy(harness, 'shadow-b', 'act-b');
    const [left, right] = await Promise.all([
      harness.ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/policies/${first.id}/validate`,
        headers: { ...headers, 'idempotency-key': 'validate-left' },
        payload: { expectedEpoch: 1 },
      }),
      harness.ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/policies/${first.id}/validate`,
        headers: { ...headers, 'idempotency-key': 'validate-right' },
        payload: { expectedEpoch: 1 },
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const stale = left.statusCode === 409 ? left : right;
    expect(stale.json().error.code).toBe('stale_activation');
    const validated = left.statusCode === 200 ? left.json() : right.json();
    expect(validated.status).toBe('validated');
    expect(validated.epoch).toBe(2);
    expect(validated.versionId).toBe(first.versionId);

    const secondValidated = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${second.id}/validate`,
      headers: { ...headers, 'idempotency-key': 'validate-b' },
      payload: { expectedEpoch: 1 },
    });
    expect(secondValidated.statusCode).toBe(200);

    const shadow = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${first.id}/status`,
      headers: { ...headers, 'idempotency-key': 'shadow-a' },
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(shadow.statusCode).toBe(200);
    expect(shadow.json().status).toBe('shadow');
    expect(shadow.json().events.map((event: { status: string }) => event.status)).toEqual(['draft', 'validated', 'shadow']);

    const conflict = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${second.id}/status`,
      headers: { ...headers, 'idempotency-key': 'shadow-b' },
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('activation_conflict');
    console.log(`EVIDENCE activation-conflict ${JSON.stringify(conflict.json())}`);

    const early = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${second.id}/status`,
      headers: { ...headers, 'idempotency-key': 'shadow-too-soon' },
      payload: { status: 'canary', expectedEpoch: 2 },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('invalid_transition');
  });

  it('keeps auto on the baseline, records the decision, and hides the policy from another tenant', async () => {
    const prompt = 'routing-shadow-prompt-zeta';
    const harness = await boot(db, { name: 'Route Trace' });
    const operator = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    const caller = authHeaders(harness.tenant.tenantId, harness.chat.secret ?? '');
    const denied = await harness.ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/policies',
      headers: caller,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');

    const before = harness.mock.hits.length;
    const plain = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('auto', prompt),
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['x-deployment']).toBe('alpha-chat');
    expect(plain.json().choices[0].message.content).toBe('ok');
    expect(plain.json().routingMode).toBeUndefined();
    expect(harness.mock.hits.length - before).toBe(1);
    expect(JSON.parse(harness.mock.hits.at(-1)?.body ?? '{}').model).toBe('gpt-baseline');
    const plainId = String(plain.headers['x-request-id']);
    const plainDecision = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${plainId}`,
      headers: operator,
    });
    expect(plainDecision.statusCode).toBe(200);
    expect(plainDecision.json()).toMatchObject({
      tenantId: harness.tenant.tenantId,
      requestId: plainId,
      alias: 'auto',
      baselineDeployment: 'alpha-chat',
      selectedDeployment: 'alpha-chat',
      policyVersionId: null,
      activationEpoch: null,
      featureExtractorVersion: 1,
      routingMode: 'static',
      reasonCodes: ['static_alias'],
    });
    expect(JSON.stringify(plainDecision.json())).not.toContain(prompt);

    const policy = await createPolicy(harness, 'trace-policy', 'trace-create');
    const validated = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policy.id}/validate`,
      headers: { ...operator, 'idempotency-key': 'trace-validate' },
      payload: { expectedEpoch: 1 },
    });
    expect(validated.statusCode).toBe(200);
    const shadow = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policy.id}/status`,
      headers: { ...operator, 'idempotency-key': 'trace-shadow' },
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(shadow.statusCode).toBe(200);

    const shadowedHits = harness.mock.hits.length;
    const shadowed = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('auto', prompt),
    });
    expect(shadowed.statusCode).toBe(200);
    expect(shadowed.headers['x-deployment']).toBe('alpha-chat');
    expect(shadowed.json().choices[0].message.content).toBe('ok');
    expect(harness.mock.hits.length - shadowedHits).toBe(1);
    expect(JSON.parse(harness.mock.hits.at(-1)?.body ?? '{}').model).toBe('gpt-baseline');
    const shadowedId = String(shadowed.headers['x-request-id']);
    const decision = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${shadowedId}`,
      headers: operator,
    });
    expect(decision.statusCode).toBe(200);
    const trace = decision.json();
    expect(trace).toMatchObject({
      tenantId: harness.tenant.tenantId,
      requestId: shadowedId,
      alias: 'auto',
      baselineDeployment: 'alpha-chat',
      selectedDeployment: 'alpha-chat',
      policyVersionId: policy.versionId,
      activationEpoch: 3,
      featureExtractorVersion: 1,
      routingMode: 'shadow',
      reasonCodes: ['shadow_observed'],
    });
    expect(JSON.stringify(trace)).not.toContain(prompt);
    expect(JSON.stringify(trace)).not.toContain('ok');
    console.log(`EVIDENCE decision-trace ${JSON.stringify(trace)}`);
    const columns = await harness.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'routing_decisions'`,
    );
    expect(columns.rows.map((row) => row.column_name).join(' ')).not.toMatch(/prompt|completion|message|content|ciphertext/);
    const raw = await harness.admin.query<{ body: string }>(
      `SELECT row_to_json(routing_decisions)::text AS body FROM routing_decisions WHERE request_id = $1`,
      [shadowedId],
    );
    expect(raw.rows[0]?.body).not.toContain(prompt);

    const namedHits = harness.mock.hits.length;
    const named = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('alpha-chat', prompt),
    });
    expect(named.statusCode).toBe(200);
    expect(named.headers['x-deployment']).toBe('alpha-chat');
    expect(harness.mock.hits.length - namedHits).toBe(1);
    const namedDecision = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${String(named.headers['x-request-id'])}`,
      headers: operator,
    });
    expect(namedDecision.json()).toMatchObject({
      alias: null,
      baselineDeployment: null,
      selectedDeployment: 'alpha-chat',
      policyVersionId: null,
      activationEpoch: null,
      routingMode: 'bypass',
      reasonCodes: ['named_model'],
    });

    const other = await boot(db, { name: 'Route Tenant B', deployment: 'beta-chat', upstream: 'gpt-beta', spare: false });
    const hidden = await other.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies/${policy.id}`,
      headers: authHeaders(other.tenant.tenantId, other.tenant.secret),
    });
    expect(hidden.statusCode).toBe(404);
    const hiddenList = await other.ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/policies',
      headers: authHeaders(other.tenant.tenantId, other.tenant.secret),
    });
    expect(hiddenList.json().policies).toEqual([]);
    const hiddenDecision = await other.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${shadowedId}`,
      headers: authHeaders(other.tenant.tenantId, other.tenant.secret),
    });
    expect(hiddenDecision.statusCode).toBe(404);
    const filtered = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies?tenantId=${other.tenant.tenantId}`,
      headers: operator,
    });
    expect(filtered.json().policies).toEqual([]);
    const seen = await withTenant(harness.ctx.runtimePool, other.tenant.tenantId, (client) =>
      client.query<{ count: number }>('SELECT count(*)::int AS count FROM routing_policies'),
    );
    expect(seen.rows[0]?.count).toBe(0);
    await expect(
      withTenant(harness.ctx.runtimePool, harness.tenant.tenantId, (client) => client.query('DELETE FROM routing_decisions')),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      harness.ctx.runtimePool.query('SELECT permission FROM tenant_key_grants'),
    ).rejects.toThrow(/permission denied/i);
    console.log(
      `EVIDENCE isolation ${JSON.stringify({
        tenantBPolicy: hidden.statusCode,
        tenantBList: hiddenList.json(),
        tenantBDecision: hiddenDecision.statusCode,
        tenantBVisiblePolicies: seen.rows[0]?.count,
      })}`,
    );

    const disabled = await harness.ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policy.id}/status`,
      headers: { ...operator, 'idempotency-key': 'trace-disable' },
      payload: { status: 'disabled', expectedEpoch: 3 },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().status).toBe('disabled');
    const rollbackHits = harness.mock.hits.length;
    const rolled = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('auto', prompt),
    });
    expect(rolled.statusCode).toBe(200);
    expect(rolled.headers['x-deployment']).toBe('alpha-chat');
    expect(harness.mock.hits.length - rollbackHits).toBe(1);
    expect(JSON.parse(harness.mock.hits.at(-1)?.body ?? '{}').model).toBe('gpt-baseline');
    const rolledDecision = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${String(rolled.headers['x-request-id'])}`,
      headers: operator,
    });
    expect(rolledDecision.json()).toMatchObject({
      alias: 'auto',
      baselineDeployment: 'alpha-chat',
      selectedDeployment: 'alpha-chat',
      policyVersionId: null,
      activationEpoch: null,
      routingMode: 'static',
      reasonCodes: ['static_alias'],
    });
    const migration = await harness.admin.query(
      `SELECT 1 FROM schema_migrations WHERE version = '026_routing_policies.sql'`,
    );
    expect(migration.rowCount).toBe(1);
    console.log(
      `EVIDENCE rollback ${JSON.stringify({
        migrationApplied: '026_routing_policies.sql',
        status: 'disabled',
        deployment: rolled.headers['x-deployment'],
        providerCallsAdded: harness.mock.hits.length - rollbackHits,
        upstreamModel: JSON.parse(harness.mock.hits.at(-1)?.body ?? '{}').model,
        routingMode: rolledDecision.json().routingMode,
        selectedDeployment: rolledDecision.json().selectedDeployment,
      })}`,
    );
  });
});

async function createPolicy(
  harness: Awaited<ReturnType<typeof boot>>,
  name: string,
  key: string,
): Promise<{ id: string; versionId: string }> {
  const response = await harness.ctx.app.inject({
    method: 'POST',
    url: '/internal/v1/routing/policies',
    headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret, key),
    payload: policyBody({ name }),
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}
