import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import { addDecimal, canonicalDecimal, multiplyDecimal } from '../src/inference/cost.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  credentialKeyText,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const db = loadTestDatabase();
const admins: pg.Pool[] = [];
const EFFECTIVE = '2025-12-01T00:00:00.000Z';

afterAll(async () => {
  await Promise.all(admins.map((pool) => pool.end()));
});

type Tenant = { tenantId: string; keyId: string; secret: string; name: string };
type ChildResult = { status: number | null; code: string | null; exit: number | null; stderr: string };
type AttemptRow = {
  id: string;
  ordinal: string;
  status: string;
  expense: string | null;
  dispatched: boolean;
  reservation_status: string | null;
  reserved: string | null;
  reservation_cost: string | null;
  cost_amount: string | null;
  stored_cost: string | null;
};

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

function trace(name: string, fields: Record<string, unknown>): void {
  console.log(`BUDGET_CASE ${JSON.stringify({ case: name, ...fields })}`);
}

function contentOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

function money(value: unknown): string {
  return canonicalDecimal(String(value));
}

function cli(args: string[]): Record<string, unknown> {
  return runCli(db, args, cliEnv()) as unknown as Record<string, unknown>;
}

function pool(): pg.Pool {
  const admin = adminPool(db);
  admins.push(admin);
  return admin;
}

function prepare(name: string, model: string, timeoutMs = 5000, capabilities?: string): Tenant {
  const tenant = provisionTenant(db, name);
  registerInference(db, {
    tenantId: tenant.tenantId,
    apiKey: `sk-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    deployment: 'budget-chat',
    upstreamModel: model,
    timeoutMs,
    capabilities,
  });
  return tenant;
}

function price(
  model: string,
  rates: { input?: string; output?: string; cacheRead?: string; allocated?: string },
): void {
  const args = [
    'register-price',
    '--provider',
    'openai',
    '--upstream-model',
    model,
    '--effective-at',
    EFFECTIVE,
    '--source',
    'fixture',
    '--status',
    'verified',
  ];
  if (rates.input !== undefined) args.push('--input-rate', rates.input);
  if (rates.output !== undefined) args.push('--output-rate', rates.output);
  if (rates.cacheRead !== undefined) args.push('--cache-read-rate', rates.cacheRead);
  if (rates.allocated !== undefined) args.push('--allocated-rate', rates.allocated);
  cli(args);
}

function setBudget(tenantId: string, mode: string, amount: string): void {
  cli(['set-tenant-budget', '--tenant-id', tenantId, '--mode', mode, '--monthly-amount', amount]);
}

async function openApp(baseUrl: string, now?: () => number) {
  return createTestApp(db, {
    inferenceEnabled: true,
    upstreamBaseUrl: baseUrl,
    credentialKey,
    now,
  });
}

async function openMock(
  hold: Set<string>,
  usageFor: (content: string) => Record<string, number> | null | undefined = () => undefined,
): Promise<{
  hits: MockHit[];
  baseUrl: string;
  release: (content: string) => void;
  close: () => Promise<void>;
}> {
  const held = new Map<string, ServerResponse>();
  const mock = await startMockUpstream((hit, _request: IncomingMessage, response) => {
    const content = contentOf(hit.body);
    if (hold.has(content)) {
      held.set(content, response);
      return;
    }
    const usage = usageFor(content);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(completionBody('gpt-test', 'ok', usage)));
  });
  return {
    ...mock,
    release(content: string): void {
      const response = held.get(content);
      if (response === undefined || response.writableEnded) return;
      held.delete(content);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', 'ok', usageFor(content))));
    },
  };
}

async function poll(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runChild(env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(projectRoot, 'test/limit-child.mjs')], {
      cwd: projectRoot,
      env: serviceEnv(db, env),
    });
    let out = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (exit) => {
      const line = out.trim().split('\n').at(-1) ?? '';
      try {
        const parsed = JSON.parse(line) as { status: number; code: string | null };
        resolve({ status: parsed.status, code: parsed.code, exit, stderr });
      } catch {
        resolve({ status: null, code: null, exit, stderr });
      }
    });
  });
}

async function rows(tenantId: string): Promise<AttemptRow[]> {
  const result = await pool().query<AttemptRow>(
    `SELECT a.id::text, a.attempt_ordinal::text AS ordinal, a.status, a.expense_certainty AS expense, a.dispatched,
            r.status AS reservation_status, r.reserved_amount::text AS reserved, r.cost_status AS reservation_cost,
            c.amount::text AS cost_amount, c.cost_status AS stored_cost
     FROM model_attempts a
     LEFT JOIN budget_reservations r ON r.tenant_id = a.tenant_id AND r.attempt_id = a.id
     LEFT JOIN attempt_costs c ON c.tenant_id = a.tenant_id AND c.attempt_id = a.id
     WHERE a.tenant_id = $1
     ORDER BY a.created_at, a.attempt_ordinal`,
    [tenantId],
  );
  return result.rows;
}

async function ledger(tenantId: string): Promise<{
  recognized: string;
  active: string;
  provisional: string;
  unknown: string;
  settles: string;
  releases: string;
  zeroSettles: string;
}> {
  const result = await pool().query<{
    recognized: string;
    active: string;
    provisional: string;
    unknown: string;
    settles: string;
    releases: string;
    zero_settles: string;
  }>(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'settle'), 0)::text AS recognized,
       COALESCE((SELECT SUM(reserved_amount) FROM budget_reservations WHERE tenant_id = $1 AND status = 'active' AND reserved_amount IS NOT NULL), 0)::text AS active,
       COALESCE((SELECT SUM(reserved_amount) FROM budget_reservations WHERE tenant_id = $1 AND status = 'provisional' AND reserved_amount IS NOT NULL), 0)::text AS provisional,
       (SELECT count(*) FROM budget_reservations WHERE tenant_id = $1 AND status = 'provisional' AND reserved_amount IS NULL)::text AS unknown,
       (SELECT count(*) FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'settle')::text AS settles,
       (SELECT count(*) FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'release')::text AS releases,
       (SELECT count(*) FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'settle' AND amount = 0)::text AS zero_settles`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('ledger is missing');
  return {
    recognized: money(row.recognized),
    active: money(row.active),
    provisional: money(row.provisional),
    unknown: row.unknown,
    settles: row.settles,
    releases: row.releases,
    zeroSettles: row.zero_settles,
  };
}

async function ledgerEntries(tenantId: string): Promise<Map<string, {
  reserve: string | null;
  settle: string | null;
  release: string | null;
  provisional: string | null;
}>> {
  const entries = await pool().query<{
    attempt_id: string;
    entry_type: string;
    amount: string | null;
  }>(
    `SELECT attempt_id::text, entry_type, amount::text AS amount
     FROM cost_ledger
     WHERE tenant_id = $1`,
    [tenantId],
  );
  const byAttempt = new Map<string, {
    reserve: string | null;
    settle: string | null;
    release: string | null;
    provisional: string | null;
  }>();
  for (const entry of entries.rows) {
    const slot = byAttempt.get(entry.attempt_id) ?? {
      reserve: null,
      settle: null,
      release: null,
      provisional: null,
    };
    if (
      entry.entry_type === 'reserve'
      || entry.entry_type === 'settle'
      || entry.entry_type === 'release'
      || entry.entry_type === 'provisional'
    ) {
      slot[entry.entry_type] = entry.amount === null ? null : money(entry.amount);
    }
    byAttempt.set(entry.attempt_id, slot);
  }
  return byAttempt;
}

async function splitKnown(
  mode: string,
  allocation: string,
  recognizedAlready: string,
  reserved: string | null,
  known: string,
): Promise<{ recognized: string; provisional: string; released: string }> {
  const result = await pool().query<{ recognized: string; provisional: string; released: string }>(
    `SELECT recognized::text, provisional::text, released::text
     FROM split_known_charge($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric)`,
    [mode, allocation, recognizedAlready, reserved, known],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('split is missing');
  return {
    recognized: money(row.recognized),
    provisional: money(row.provisional),
    released: money(row.released),
  };
}

async function expectReconciled(tenantId: string): Promise<void> {
  const totals = await ledger(tenantId);
  const attempts = await rows(tenantId);
  const reserved = attempts.filter((row) => row.reservation_status !== null);
  const settled = reserved.filter((row) => row.reservation_status === 'settled');
  const active = reserved.filter((row) => row.reservation_status === 'active' && row.reserved !== null);
  const provisional = reserved.filter((row) => row.reservation_status === 'provisional' && row.reserved !== null);
  const byAttempt = await ledgerEntries(tenantId);
  const budget = await pool().query<{ mode: string; monthly_amount: string }>(
    `SELECT mode, monthly_amount::text AS monthly_amount FROM tenant_budgets WHERE tenant_id = $1`,
    [tenantId],
  );
  const splitMode = budget.rows[0]?.mode === 'observe' ? 'observe' : 'hard';
  const allocation = budget.rows[0]?.monthly_amount ?? '0';
  const closed = await pool().query<{ id: string; status: string; cost_amount: string | null }>(
    `SELECT a.id::text, r.status, c.amount::text AS cost_amount
     FROM model_attempts a
     JOIN budget_reservations r ON r.tenant_id = a.tenant_id AND r.attempt_id = a.id
     LEFT JOIN attempt_costs c ON c.tenant_id = a.tenant_id AND c.attempt_id = a.id
     WHERE a.tenant_id = $1
       AND r.status IN ('settled', 'provisional')
     ORDER BY r.settled_at NULLS LAST,
       (
         SELECT min(l.xmin::text::bigint)
         FROM cost_ledger l
         WHERE l.reservation_id = r.id
           AND l.entry_type IN ('settle', 'release')
       ) NULLS LAST,
       a.created_at`,
    [tenantId],
  );
  let recognizedAlready = '0';
  let recognizedFromRows = '0';
  for (const row of closed.rows) {
    if (row.cost_amount === null) continue;
    const entry = byAttempt.get(row.id);
    const original = entry?.reserve ?? null;
    const split = await splitKnown(splitMode, allocation, recognizedAlready, original, row.cost_amount);
    if (splitMode === 'observe' && split.recognized === '0') {
      expect(entry?.settle ?? null).toBeNull();
    } else {
      expect(entry?.settle ?? null).toBe(split.recognized);
    }
    if (split.provisional === '0') {
      if (entry?.provisional != null) expect(entry.provisional).toBe('0');
    } else {
      expect(entry?.provisional ?? null).toBe(split.provisional);
    }
    if (original === null) {
      expect(entry?.release ?? null).toBeNull();
    } else {
      expect(entry?.release ?? null).toBe(split.released);
      expect(addDecimal(addDecimal(split.recognized, split.provisional), split.released)).toBe(money(original));
    }
    if (row.status === 'provisional' && split.provisional !== '0') {
      const current = attempts.find((item) => item.id === row.id);
      expect(money(current?.reserved)).toBe(split.provisional);
    }
    recognizedAlready = addDecimal(recognizedAlready, split.recognized);
    recognizedFromRows = addDecimal(recognizedFromRows, split.recognized);
  }
  const withSettle = reserved.filter((row) => byAttempt.get(row.id)?.settle != null);
  expect(totals.recognized).toBe(recognizedFromRows);
  expect(totals.active).toBe(sum(active.map((row) => row.reserved ?? '0')));
  expect(totals.provisional).toBe(sum(provisional.map((row) => row.reserved ?? '0')));
  expect(totals.settles).toBe(String(withSettle.length));
  expect(totals.zeroSettles).toBe('0');
  const duplicates = await pool().query<{ reservation_id: string }>(
    `SELECT reservation_id::text
     FROM cost_ledger
     WHERE tenant_id = $1 AND entry_type = 'settle'
     GROUP BY reservation_id
     HAVING count(*) > 1`,
    [tenantId],
  );
  expect(duplicates.rows).toHaveLength(0);
  for (const row of settled) {
    expect(row.cost_amount).not.toBeNull();
    expect(money(row.cost_amount)).not.toBe('0');
  }
}

function sum(values: string[]): string {
  return values.reduce((total, value) => addDecimal(total, money(value)), '0');
}

async function closeAttempt(tenantId: string, attemptId: string): Promise<string> {
  return withTenant(pool(), tenantId, async (client) => {
    const result = await client.query<{ close_attempt_admission: string }>(
      'SELECT close_attempt_admission($1, $2, $3) AS close_attempt_admission',
      [tenantId, attemptId, new Date('2026-08-01T00:00:00.000Z')],
    );
    return result.rows[0]?.close_attempt_admission ?? '';
  });
}

function recover(tenantId: string): number {
  const result = cli(['recover-budget', '--tenant-id', tenantId]);
  return Number(result.closed ?? -1);
}

describe('tenant budgets', () => {
  it('keeps observe, hard, and disabled distinct and rejects unknown or unbounded cost before upstream', async () => {
    const watch = prepare('Budget Watch', 'gpt-budget-watch');
    const tight = prepare('Budget Tight', 'gpt-budget-tight');
    const missing = prepare('Budget Missing', 'gpt-budget-missing');
    const open = prepare('Budget Open', 'gpt-budget-open');
    const off = prepare('Budget Off', 'gpt-budget-off');
    price('gpt-budget-watch', { input: '0.01' });
    price('gpt-budget-tight', { input: '0.01' });
    price('gpt-budget-open', { output: '0.2' });
    setBudget(watch.tenantId, 'observe', '0.01');
    setBudget(tight.tenantId, 'hard', '0.01');
    setBudget(missing.tenantId, 'hard', '5');
    setBudget(open.tenantId, 'hard', '5');
    setBudget(off.tenantId, 'disabled', '0.01');
    cli([
      'set-tenant-limits',
      '--tenant-id',
      off.tenantId,
      '--mode',
      'hard',
      '--requests-per-minute',
      '1',
    ]);
    const mock = await openMock(new Set());
    const ctx = await openApp(mock.baseUrl);
    try {
      const watched = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(watch.tenantId, watch.secret),
        payload: chatPayload('budget-chat', 'abcd'),
      });
      expect(watched.statusCode).toBe(200);
      const watchedUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(watch.tenantId, watch.secret),
      });
      expect(watchedUsage.statusCode).toBe(200);
      const watchRows = await rows(watch.tenantId);
      const watchLedger = await ledgerEntries(watch.tenantId);
      const watchEstimate = multiplyDecimal('0.01', 'abcd'.length);
      const watchActual = '0.03';
      const watchOverage = addDecimal(watchActual, '-0.01');
      expect(money(watchRows[0]?.cost_amount)).toBe(watchActual);
      expect(watchLedger.get(watchRows[0]?.id ?? '')?.reserve).toBe(money(watchEstimate));
      expect(money(watchedUsage.json().budget.recognized)).toBe('0.01');
      expect(money(watchedUsage.json().budget.provisional)).toBe(watchOverage);
      expect(money(watchedUsage.json().reservedCapacity.provisional)).toBe(watchOverage);
      expect(money(watchRows[0]?.reserved)).toBe(watchOverage);
      expect(watchRows[0]?.reservation_status).toBe('provisional');
      expect(watchRows[0]?.reservation_cost).toBe('provisional');
      expect(watchedUsage.json().costStatus).toBe('provisional');
      expect(watchedUsage.json().reservedCapacity.unknownCharges).toBe('0');
      expect(money(watchedUsage.json().remainingBudget)).toBe('0');
      expect(String(watchedUsage.json().remainingBudget).startsWith('-')).toBe(false);
      const watchAgain = await closeAttempt(watch.tenantId, watchRows[0]?.id ?? '');
      expect(watchAgain).toBe('provisional');
      expect(money((await ledger(watch.tenantId)).recognized)).toBe('0.01');
      expect(money((await ledger(watch.tenantId)).provisional)).toBe(watchOverage);
      await expectReconciled(watch.tenantId);

      const emptyBudget = prepare('Budget Observe Empty', 'gpt-budget-observe-empty');
      price('gpt-budget-observe-empty', { input: '0.01' });
      setBudget(emptyBudget.tenantId, 'observe', '0');
      const emptyChat = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(emptyBudget.tenantId, emptyBudget.secret),
        payload: chatPayload('budget-chat', 'zero-left'),
      });
      expect(emptyChat.statusCode).toBe(200);
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'zero-left')).toHaveLength(1);
      const emptyUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(emptyBudget.tenantId, emptyBudget.secret),
      });
      const emptyRows = await rows(emptyBudget.tenantId);
      const emptyLedger = await ledgerEntries(emptyBudget.tenantId);
      expect(money(emptyRows[0]?.cost_amount)).toBe('0.03');
      expect(emptyRows[0]?.reserved).not.toBeNull();
      expect(emptyRows[0]?.reservation_status).toBe('provisional');
      expect(emptyRows[0]?.reservation_cost).toBe('provisional');
      expect(money(emptyRows[0]?.reserved)).toBe('0.03');
      expect(emptyLedger.get(emptyRows[0]?.id ?? '')?.reserve).toBe(money(multiplyDecimal('0.01', 'zero-left'.length)));
      expect(emptyLedger.get(emptyRows[0]?.id ?? '')?.provisional).toBe('0.03');
      expect(money(emptyUsage.json().budget.recognized)).toBe('0');
      expect(money(emptyUsage.json().budget.provisional)).toBe('0.03');
      expect(emptyUsage.json().costStatus).toBe('provisional');
      expect(emptyUsage.json().reservedCapacity.unknownCharges).toBe('0');
      expect(money(emptyUsage.json().remainingBudget)).toBe('0');
      expect(String(emptyUsage.json().remainingBudget).startsWith('-')).toBe(false);
      expect(await closeAttempt(emptyBudget.tenantId, emptyRows[0]?.id ?? '')).toBe('provisional');
      expect(money((await ledger(emptyBudget.tenantId)).provisional)).toBe('0.03');
      expect(money((await ledger(emptyBudget.tenantId)).recognized)).toBe('0');
      await expectReconciled(emptyBudget.tenantId);

      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tight.tenantId, tight.secret),
        payload: chatPayload('budget-chat', 'abcd'),
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('budget_exceeded');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'abcd')).toHaveLength(1);

      const unknown = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(missing.tenantId, missing.secret),
        payload: chatPayload('budget-chat', 'no-price'),
      });
      expect(unknown.statusCode).toBe(429);
      expect(unknown.json().error.code).toBe('budget_unknown');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'no-price')).toHaveLength(0);

      const unbounded = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(open.tenantId, open.secret),
        payload: chatPayload('budget-chat', 'no-output-bound'),
      });
      expect(unbounded.statusCode).toBe(429);
      expect(unbounded.json().error.code).toBe('budget_unbounded');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'no-output-bound')).toHaveLength(0);

      const observedUnknown = prepare('Budget Observe Unknown', 'gpt-budget-observe-unknown');
      setBudget(observedUnknown.tenantId, 'observe', '4');
      const proceeded = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(observedUnknown.tenantId, observedUnknown.secret),
        payload: chatPayload('budget-chat', 'unknown-observe'),
      });
      expect(proceeded.statusCode).toBe(200);
      const unknownRows = await rows(observedUnknown.tenantId);
      expect(unknownRows[0]?.reservation_status).toBe('provisional');
      expect(unknownRows[0]?.reserved).toBeNull();
      expect(unknownRows[0]?.reservation_cost).toBe('unknown');
      const unknownUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(observedUnknown.tenantId, observedUnknown.secret),
      });
      expect(unknownUsage.json().costStatus).toBe('unknown');
      expect(money(unknownUsage.json().remainingBudget)).toBe('4');
      expect(unknownUsage.json().reservedCapacity.unknownCharges).toBe('1');

      const firstOff = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(off.tenantId, off.secret),
        payload: chatPayload('budget-chat', 'disabled-one'),
      });
      const secondOff = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(off.tenantId, off.secret),
        payload: chatPayload('budget-chat', 'disabled-two'),
      });
      expect(firstOff.statusCode).toBe(200);
      expect(secondOff.statusCode).toBe(429);
      expect(secondOff.json().error.code).toBe('tenant_rate_limited');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'disabled-two')).toHaveLength(0);
      const disabledUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(off.tenantId, off.secret),
      });
      expect(disabledUsage.json().budget.mode).toBe('disabled');
      expect(disabledUsage.json().remainingBudget).toBeNull();
      expect(money(disabledUsage.json().budget.allocated)).toBe('0.01');
      trace('modes', {
        watch: {
          remaining: watchedUsage.json().remainingBudget,
          recognized: watchedUsage.json().budget.recognized,
          provisional: watchedUsage.json().budget.provisional,
          costStatus: watchedUsage.json().costStatus,
          reserved: watchRows[0]?.reserved,
          estimate: watchLedger.get(watchRows[0]?.id ?? '')?.reserve,
        },
        empty: {
          remaining: emptyUsage.json().remainingBudget,
          recognized: emptyUsage.json().budget.recognized,
          provisional: emptyUsage.json().budget.provisional,
          costStatus: emptyUsage.json().costStatus,
          reserved: emptyRows[0]?.reserved,
        },
        tight: blocked.json().error.code,
        missing: unknown.json().error.code,
        unbounded: unbounded.json().error.code,
        disabled: secondOff.json().error.code,
        hits: mock.hits.length,
      });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('reserves a finite cache split and rejects a price that has no external rate', async () => {
    const cached = prepare('Budget Cache', 'gpt-budget-cache', 5000, 'temperature,max_tokens');
    const costly = prepare('Budget Cache High', 'gpt-budget-cache-high');
    const allocated = prepare('Budget Allocated', 'gpt-budget-allocated');
    const empty = prepare('Budget Empty Price', 'gpt-budget-empty');
    price('gpt-budget-cache', { input: '0.01', output: '0.02', cacheRead: '0.001' });
    price('gpt-budget-cache-high', { input: '0.01', cacheRead: '1' });
    price('gpt-budget-allocated', { allocated: '0.5' });
    price('gpt-budget-empty', {});
    setBudget(cached.tenantId, 'hard', '100');
    setBudget(costly.tenantId, 'hard', '1');
    setBudget(allocated.tenantId, 'hard', '100');
    setBudget(empty.tenantId, 'hard', '100');
    const mock = await openMock(new Set());
    const ctx = await openApp(mock.baseUrl);
    try {
      const allowed = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(cached.tenantId, cached.secret),
        payload: chatPayload('budget-chat', 'hi', { max_tokens: 4 }),
      });
      expect(allowed.statusCode).toBe(200);
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'hi')).toHaveLength(1);
      const cachedRows = await rows(cached.tenantId);
      expect(money(cachedRows[0]?.reserved)).toBe(addDecimal(multiplyDecimal('0.01', 2), multiplyDecimal('0.02', 4)));
      const high = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(costly.tenantId, costly.secret),
        payload: chatPayload('budget-chat', 'hi'),
      });
      expect(high.statusCode).toBe(429);
      expect(high.json().error.code).toBe('budget_exceeded');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'hi')).toHaveLength(1);
      const onlyAllocated = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(allocated.tenantId, allocated.secret),
        payload: chatPayload('budget-chat', 'allocated-only'),
      });
      expect(onlyAllocated.statusCode).toBe(429);
      expect(onlyAllocated.json().error.code).toBe('budget_unknown');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'allocated-only')).toHaveLength(0);
      const noRate = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(empty.tenantId, empty.secret),
        payload: chatPayload('budget-chat', 'no-rate'),
      });
      expect(noRate.statusCode).toBe(429);
      expect(noRate.json().error.code).toBe('budget_unknown');
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'no-rate')).toHaveLength(0);
      trace('bounds', {
        cache: cachedRows[0]?.reserved,
        high: high.json().error.code,
        allocated: onlyAllocated.json().error.code,
        empty: noRate.json().error.code,
        hits: mock.hits.length,
      });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('settles fixed-precision expense, caps recognized at the reservation, and ignores a second settlement', async () => {
    const exact = prepare('Budget Exact', 'gpt-budget-exact');
    const clamp = prepare('Budget Clamp', 'gpt-budget-clamp');
    price('gpt-budget-exact', { input: '0.01' });
    price('gpt-budget-clamp', { input: '1' });
    setBudget(exact.tenantId, 'hard', '1');
    setBudget(clamp.tenantId, 'hard', '2');
    cli([
      'set-tenant-limits',
      '--tenant-id',
      exact.tenantId,
      '--mode',
      'observe',
      '--requests-per-minute',
      '20',
    ]);
    const mock = await openMock(new Set(), (content) =>
      content === 'x' ? { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } : undefined,
    );
    const ctx = await openApp(mock.baseUrl);
    try {
      const settled = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(exact.tenantId, exact.secret),
        payload: chatPayload('budget-chat', 'abcd'),
      });
      expect(settled.statusCode).toBe(200);
      const usage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(exact.tenantId, exact.secret),
      });
      const body = usage.json();
      expect(body.configuredLimits).toBeDefined();
      expect(body.observedUsage.requestsInWindow).toBe('1');
      expect(body.reservedCapacity).toBeDefined();
      expect(money(body.budget.recognized)).toBe(multiplyDecimal('0.01', 3));
      expect(money(body.remainingBudget)).toBe('0.97');
      expect(body.costStatus).toBe('estimated');
      expect(money(body.budget.allocated)).toBe('1');
      const exactRows = await rows(exact.tenantId);
      expect(exactRows).toHaveLength(1);
      expect(exactRows[0]?.reservation_status).toBe('settled');
      expect(money(exactRows[0]?.reserved)).toBe(multiplyDecimal('0.01', 'abcd'.length));
      const release = await pool().query<{ amount: string }>(
        `SELECT amount::text AS amount FROM cost_ledger WHERE tenant_id = $1 AND entry_type = 'release'`,
        [exact.tenantId],
      );
      expect(release.rows.map((row) => money(row.amount))).toEqual(['0.01']);
      const before = await ledger(exact.tenantId);
      const again = await closeAttempt(exact.tenantId, exactRows[0]?.id ?? '');
      const after = await ledger(exact.tenantId);
      expect(again).toBe('settled');
      expect(after.recognized).toBe(before.recognized);
      expect(after.settles).toBe('1');
      await expectReconciled(exact.tenantId);

      const clamped = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(clamp.tenantId, clamp.secret),
        payload: chatPayload('budget-chat', 'x'),
      });
      expect(clamped.statusCode).toBe(200);
      const clampUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(clamp.tenantId, clamp.secret),
      });
      const clampRows = await rows(clamp.tenantId);
      expect(money(clampRows[0]?.reserved)).toBe('1');
      expect(money(clampRows[0]?.cost_amount)).toBe('5');
      expect(money(clampUsage.json().budget.recognized)).toBe('1');
      expect(money(clampUsage.json().remainingBudget)).toBe('1');
      expect(money(clampUsage.json().remainingBudget)).toBe(
        addDecimal('2', `-${money(clampUsage.json().budget.recognized)}`),
      );
      expect(String(clampUsage.json().remainingBudget).startsWith('-')).toBe(false);
      await expectReconciled(clamp.tenantId);
      trace('reconcile', {
        exact: { recognized: body.budget.recognized, remaining: body.remainingBudget, again },
        clamp: { recognized: clampUsage.json().budget.recognized, remaining: clampUsage.json().remainingBudget },
      });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('gives the next UTC month its own capacity', async () => {
    const tenant = prepare('Budget Month', 'gpt-budget-month');
    price('gpt-budget-month', { input: '0.01' });
    setBudget(tenant.tenantId, 'hard', '1');
    let now = Date.parse('2026-01-15T12:00:00.000Z');
    const mock = await openMock(new Set());
    const ctx = await openApp(mock.baseUrl, () => now);
    try {
      const january = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('budget-chat', 'abcd'),
      });
      expect(january.statusCode).toBe(200);
      const januaryUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(money(januaryUsage.json().remainingBudget)).toBe('0.97');
      now = Date.parse('2026-02-01T00:00:00.000Z');
      const february = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(money(february.json().remainingBudget)).toBe('1');
      expect(money(february.json().budget.recognized)).toBe('0');
      expect(money(february.json().reservedCapacity.activeReservations)).toBe('0');
      const next = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('budget-chat', 'abcd'),
      });
      expect(next.statusCode).toBe(200);
      const spent = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(money(spent.json().remainingBudget)).toBe('0.97');
      expect(mock.hits).toHaveLength(2);
      trace('rollover', { january: januaryUsage.json().remainingBudget, february: february.json().remainingBudget });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('admits only the available capacity when two processes reserve together', async () => {
    const tenant = prepare('Budget Race', 'gpt-budget-race');
    price('gpt-budget-race', { input: '0.01' });
    setBudget(tenant.tenantId, 'hard', '0.04');
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const mock = await openMock(new Set(['abcd']));
    const ctx = await openApp(mock.baseUrl, () => now);
    const pending = [
      runChild({
        UPSTREAM_BASE_URL: mock.baseUrl,
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
        LIMIT_NOW_MS: String(now),
        TENANT_ID: tenant.tenantId,
        TENANT_SECRET: tenant.secret,
        CHAT_MODEL: 'budget-chat',
        CHAT_CONTENT: 'abcd',
      }),
      runChild({
        UPSTREAM_BASE_URL: mock.baseUrl,
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
        LIMIT_NOW_MS: String(now),
        TENANT_ID: tenant.tenantId,
        TENANT_SECRET: tenant.secret,
        CHAT_MODEL: 'budget-chat',
        CHAT_CONTENT: 'abcd',
      }),
    ];
    const settled: ChildResult[] = [];
    for (const item of pending) void item.then((result) => settled.push(result));
    try {
      await poll(() => settled.length >= 1 && mock.hits.length === 1, 'budget race');
      expect(settled[0]?.code).toBe('budget_exceeded');
      expect(mock.hits).toHaveLength(1);
      const during = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(money(during.json().remainingBudget)).toBe('0');
      expect(money(during.json().reservedCapacity.activeReservations)).toBe('0.04');
      expect(String(during.json().remainingBudget).startsWith('-')).toBe(false);
      const active = (await rows(tenant.tenantId)).filter((row) => row.reservation_status === 'active');
      expect(active).toHaveLength(1);
      mock.release('abcd');
      const done = await Promise.all(pending);
      expect(done.filter((item) => item.status === 200)).toHaveLength(1);
      expect(done.filter((item) => item.code === 'budget_exceeded')).toHaveLength(1);
      const after = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(money(after.json().budget.recognized)).toBe('0.03');
      expect(money(after.json().remainingBudget)).toBe('0.01');
      expect(String(after.json().remainingBudget).startsWith('-')).toBe(false);
      await expectReconciled(tenant.tenantId);
      const totals = await ledger(tenant.tenantId);
      expect(totals.settles).toBe('1');
      trace('race', {
        during: during.json().remainingBudget,
        after: after.json().remainingBudget,
        results: done.map((item) => ({ status: item.status, code: item.code })),
        hits: mock.hits.length,
      });
    } finally {
      mock.release('abcd');
      await Promise.allSettled(pending);
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('recognizes overlapping observe closes against settled expense only', async () => {
    const tenant = prepare('Budget Overlap', 'gpt-budget-overlap');
    price('gpt-budget-overlap', { input: '0.01' });
    setBudget(tenant.tenantId, 'observe', '1');
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const left = 'L'.repeat(80);
    const right = 'R'.repeat(80);
    const usage = { prompt_tokens: 70, completion_tokens: 0, total_tokens: 70 };
    const mock = await openMock(new Set([left, right]), () => usage);
    const ctx = await openApp(mock.baseUrl, () => now);
    const childEnv = {
      UPSTREAM_BASE_URL: mock.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      LIMIT_NOW_MS: String(now),
      TENANT_ID: tenant.tenantId,
      TENANT_SECRET: tenant.secret,
      CHAT_MODEL: 'budget-chat',
    };
    const pending = [
      runChild({ ...childEnv, CHAT_CONTENT: left }),
      runChild({ ...childEnv, CHAT_CONTENT: right }),
    ];
    try {
      await poll(async () => {
        if (mock.hits.length < 2) return false;
        const active = (await rows(tenant.tenantId)).filter((row) => row.reservation_status === 'active');
        return active.length === 2 && active.every((row) => money(row.reserved) === money('0.80'));
      }, 'observe overlap hold', 20_000);
      const held = await rows(tenant.tenantId);
      expect(held.filter((row) => row.reservation_status === 'active')).toHaveLength(2);
      expect(held.every((row) => row.reservation_status !== 'settled' && row.reservation_status !== 'provisional')).toBe(true);
      mock.release(left);
      mock.release(right);
      const done = await Promise.all(pending);
      expect(done.map((item) => item.status)).toEqual([200, 200]);
      const usageResponse = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(usageResponse.statusCode).toBe(200);
      const body = usageResponse.json();
      expect(money(body.budget.recognized)).toBe(money('1.00'));
      expect(money(body.budget.provisional)).toBe(money('0.40'));
      expect(money(body.reservedCapacity.provisional)).toBe(money('0.40'));
      expect(money(body.remainingBudget)).toBe('0');
      expect(String(body.remainingBudget).startsWith('-')).toBe(false);
      expect(body.costStatus).toBe('provisional');
      expect(body.reservedCapacity.unknownCharges).toBe('0');
      await expectReconciled(tenant.tenantId);
      const totals = await ledger(tenant.tenantId);
      expect(totals.recognized).toBe(money('1.00'));
      expect(totals.provisional).toBe(money('0.40'));
      expect(totals.active).toBe('0');
      expect(totals.settles).toBe('2');
      expect(totals.zeroSettles).toBe('0');
      trace('overlap', {
        recognized: body.budget.recognized,
        provisional: body.budget.provisional,
        remaining: body.remainingBudget,
        costStatus: body.costStatus,
        hits: mock.hits.length,
        results: done.map((item) => item.status),
      });
    } finally {
      mock.release(left);
      mock.release(right);
      await Promise.allSettled(pending);
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('reserves a retry on its own and does not settle that attempt twice', async () => {
    const tenant = prepare('Budget Retry', 'gpt-budget-retry');
    price('gpt-budget-retry', { input: '0.01' });
    setBudget(tenant.tenantId, 'hard', '10');
    cli([
      'set-execution-policy',
      '--tenant-id',
      tenant.tenantId,
      '--deployment',
      'budget-chat',
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
    ]);
    let calls = 0;
    const mock = await startMockUpstream((_hit, _request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'slow', type: 'rate_limit_error', code: 'rate_limit' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
    });
    const ctx = await openApp(mock.baseUrl);
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('budget-chat', 'retry-me'),
      });
      expect(response.statusCode).toBe(200);
      expect(mock.hits).toHaveLength(2);
      const attempts = await rows(tenant.tenantId);
      expect(attempts.map((row) => row.ordinal)).toEqual(['1', '2']);
      expect(attempts[0]?.reservation_status).toBe('provisional');
      expect(money(attempts[0]?.reserved)).toBe(multiplyDecimal('0.01', 'retry-me'.length));
      expect(attempts[0]?.cost_amount).toBeNull();
      expect(attempts[1]?.reservation_status).toBe('settled');
      expect(money(attempts[1]?.cost_amount)).toBe('0.03');
      const before = await ledger(tenant.tenantId);
      expect(before.recognized).toBe('0.03');
      expect(before.provisional).toBe(multiplyDecimal('0.01', 'retry-me'.length));
      expect(before.settles).toBe('1');
      const first = await closeAttempt(tenant.tenantId, attempts[0]?.id ?? '');
      const second = await closeAttempt(tenant.tenantId, attempts[1]?.id ?? '');
      const after = await ledger(tenant.tenantId);
      expect(first).toBe('provisional');
      expect(second).toBe('settled');
      expect(after.recognized).toBe(before.recognized);
      expect(after.provisional).toBe(before.provisional);
      expect(after.settles).toBe('1');
      await expectReconciled(tenant.tenantId);
      trace('retry', { recognized: after.recognized, provisional: after.provisional, settles: after.settles });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('keeps a timeout reservation provisional and does not store a zero charge', async () => {
    const tenant = prepare('Budget Timeout', 'gpt-budget-timeout', 400);
    price('gpt-budget-timeout', { input: '0.01' });
    setBudget(tenant.tenantId, 'hard', '5');
    const estimate = multiplyDecimal('0.01', 'timeout-hold'.length);
    const mock = await startMockUpstream((hit, _request, response) => {
      if (contentOf(hit.body) !== 'timeout-hold') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody('gpt-test', 'ok')));
        return;
      }
    });
    const ctx = await openApp(mock.baseUrl);
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('budget-chat', 'timeout-hold'),
      });
      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('timeout');
      expect(mock.hits).toHaveLength(1);
      const attempts = await rows(tenant.tenantId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.expense).toBe('uncertain');
      expect(attempts[0]?.dispatched).toBe(true);
      expect(attempts[0]?.reservation_status).toBe('provisional');
      expect(money(attempts[0]?.reserved)).toBe(estimate);
      expect(attempts[0]?.cost_amount).toBeNull();
      const totals = await ledger(tenant.tenantId);
      expect(totals.settles).toBe('0');
      expect(totals.provisional).toBe(estimate);
      expect(totals.zeroSettles).toBe('0');
      expect(recover(tenant.tenantId)).toBe(0);
      const kept = await rows(tenant.tenantId);
      expect(kept[0]?.reservation_status).toBe('provisional');
      expect(money(kept[0]?.reserved)).toBe(estimate);
      const usage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(tenant.tenantId, tenant.secret),
      });
      expect(usage.json().costStatus).toBe('provisional');
      expect(money(usage.json().reservedCapacity.provisional)).toBe(estimate);
      expect(money(usage.json().remainingBudget)).toBe(addDecimal('5', `-${estimate}`));
      expect(String(usage.json().remainingBudget).startsWith('-')).toBe(false);
      trace('timeout', {
        status: response.statusCode,
        reserved: kept[0]?.reserved,
        remaining: usage.json().remainingBudget,
        hits: mock.hits.length,
      });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('keeps a reservation after a crash and settles a finished attempt once', async () => {
    const before = prepare('Budget Crash Before', 'gpt-budget-crash-before');
    const after = prepare('Budget Crash After', 'gpt-budget-crash-after');
    price('gpt-budget-crash-before', { input: '0.01' });
    price('gpt-budget-crash-after', { input: '0.01' });
    setBudget(before.tenantId, 'hard', '5');
    setBudget(after.tenantId, 'hard', '5');
    const now = Date.now();
    const mock = await openMock(new Set());
    const ctx = await openApp(mock.baseUrl, () => now);
    const base = {
      UPSTREAM_BASE_URL: mock.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      LIMIT_NOW_MS: String(now),
      CHAT_MODEL: 'budget-chat',
    };
    try {
      const early = await runChild({
        ...base,
        TENANT_ID: before.tenantId,
        TENANT_SECRET: before.secret,
        CHAT_CONTENT: 'crash-before',
        CRASH_AT: 'after_admit',
      });
      expect(early.exit).toBe(86);
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'crash-before')).toHaveLength(0);
      const held = await rows(before.tenantId);
      expect(held).toHaveLength(1);
      expect(held[0]?.status).toBe('pending');
      expect(held[0]?.reservation_status).toBe('active');
      expect(money(held[0]?.reserved)).toBe(multiplyDecimal('0.01', 'crash-before'.length));
      expect(recover(before.tenantId)).toBe(0);
      const still = await rows(before.tenantId);
      expect(still[0]?.reservation_status).toBe('active');
      const during = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(before.tenantId, before.secret),
      });
      expect(money(during.json().reservedCapacity.activeReservations)).toBe(multiplyDecimal('0.01', 'crash-before'.length));

      const late = await runChild({
        ...base,
        TENANT_ID: after.tenantId,
        TENANT_SECRET: after.secret,
        CHAT_CONTENT: 'crash-after',
        CRASH_AT: 'before_settle',
      });
      expect(late.exit).toBe(86);
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'crash-after')).toHaveLength(1);
      const unfinished = await rows(after.tenantId);
      expect(unfinished[0]?.status).toBe('succeeded');
      expect(unfinished[0]?.reservation_status).toBe('active');
      expect(money(unfinished[0]?.cost_amount)).toBe('0.03');
      expect(recover(after.tenantId)).toBe(1);
      const once = await ledger(after.tenantId);
      expect(once.recognized).toBe('0.03');
      expect(once.settles).toBe('1');
      expect(recover(after.tenantId)).toBe(0);
      const repeated = await closeAttempt(after.tenantId, unfinished[0]?.id ?? '');
      const twice = await ledger(after.tenantId);
      expect(repeated).toBe('settled');
      expect(twice.recognized).toBe(once.recognized);
      expect(twice.settles).toBe('1');
      await expectReconciled(after.tenantId);
      const visible = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(after.tenantId, after.secret),
      });
      expect(money(visible.json().budget.recognized)).toBe('0.03');
      expect(money(visible.json().remainingBudget)).toBe(addDecimal('5', '-0.03'));
      trace('crash', {
        early: { exit: early.exit, status: still[0]?.reservation_status, hits: mock.hits.length },
        late: { exit: late.exit, recognized: twice.recognized, remaining: visible.json().remainingBudget },
      });
    } finally {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('does not apply one tenant reservation to another tenant', async () => {
    const alpha = prepare('Budget Alpha', 'gpt-budget-alpha');
    const beta = prepare('Budget Beta', 'gpt-budget-beta');
    price('gpt-budget-alpha', { input: '0.01' });
    price('gpt-budget-beta', { input: '0.01' });
    setBudget(alpha.tenantId, 'hard', '1');
    setBudget(beta.tenantId, 'hard', '3');
    const mock = await openMock(new Set(['iso-hold']));
    const ctx = await openApp(mock.baseUrl);
    try {
      const held = ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(alpha.tenantId, alpha.secret),
        payload: chatPayload('budget-chat', 'iso-hold'),
      });
      await poll(() => mock.hits.length === 1, 'isolation hold');
      const alphaUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(alpha.tenantId, alpha.secret),
      });
      const betaUsage = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(beta.tenantId, beta.secret),
      });
      expect(money(alphaUsage.json().remainingBudget)).toBe(addDecimal('1', `-${multiplyDecimal('0.01', 'iso-hold'.length)}`));
      expect(money(betaUsage.json().remainingBudget)).toBe('3');
      expect(money(betaUsage.json().reservedCapacity.activeReservations)).toBe('0');
      expect(JSON.stringify(betaUsage.json())).not.toContain(alpha.tenantId);
      const visible = await withTenant(ctx.runtimePool, beta.tenantId, async (client) => {
        const result = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id::text FROM budget_reservations',
        );
        return result.rows.map((row) => row.tenant_id);
      });
      expect(visible).not.toContain(alpha.tenantId);
      const betaCall = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(beta.tenantId, beta.secret),
        payload: chatPayload('budget-chat', 'iso-beta'),
      });
      expect(betaCall.statusCode).toBe(200);
      const alphaStill = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/budgets/usage',
        headers: authHeaders(alpha.tenantId, alpha.secret),
      });
      expect(money(alphaStill.json().reservedCapacity.activeReservations)).toBe(multiplyDecimal('0.01', 'iso-hold'.length));
      expect(money(alphaStill.json().budget.recognized)).toBe('0');
      mock.release('iso-hold');
      expect((await held).statusCode).toBe(200);
      trace('isolation', {
        alpha: alphaUsage.json().remainingBudget,
        beta: betaUsage.json().remainingBudget,
        visible,
      });
    } finally {
      mock.release('iso-hold');
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });

  it('fails closed when a hard budget cannot reach PostgreSQL', async () => {
    const tenant = prepare('Budget Outage', 'gpt-budget-outage');
    price('gpt-budget-outage', { input: '0.01' });
    setBudget(tenant.tenantId, 'hard', '5');
    const mock = await openMock(new Set());
    const ctx = await openApp(mock.baseUrl);
    const client = new pg.Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.username,
      password: db.password,
    });
    await client.connect();
    await client.query(`SELECT pg_advisory_lock(hashtextextended('admit:' || $1::text, 0))`, [tenant.tenantId]);
    try {
      const denied = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(tenant.tenantId, tenant.secret),
        payload: chatPayload('budget-chat', 'db-down'),
      });
      expect(denied.statusCode).toBe(503);
      expect(denied.json().error.code).toBe('admission_unavailable');
      expect(mock.hits).toHaveLength(0);
      const attempts = await rows(tenant.tenantId);
      expect(attempts.every((row) => row.reservation_status === null || row.dispatched === false)).toBe(true);
      expect(mock.hits.filter((hit) => contentOf(hit.body) === 'db-down')).toHaveLength(0);
      trace('outage', { status: denied.statusCode, code: denied.json().error.code, hits: mock.hits.length });
    } finally {
      await client.query('SELECT pg_advisory_unlock_all()');
      await client.end();
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    }
  });
});
