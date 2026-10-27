import type { PoolClient } from 'pg';
import { invalidRequest, proxyError } from './errors.js';
import { lockEvaluationRow } from './evaluations.js';
import { parseRubricConfig, parseRubricTask, type RubricConfig } from './judge.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RubricVersionView = {
  id: string;
  versionId: string;
  name: string;
  version: number;
  status: 'draft' | 'approved';
  taskCategory: string;
  config: RubricConfig;
  activatedAt: string | null;
};

type VersionRow = {
  id: string;
  rubric_id: string;
  name: string;
  version: number;
  status: string;
  task_category: string;
  config: unknown;
  activated_at: Date | string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export function parseRubricId(rubricId: string): string {
  if (!UUID.test(rubricId)) throw invalidRequest('rubric_id', 'invalid_parameter', 'rubric id is invalid.');
  return rubricId.toLowerCase();
}

export function parseRubricVersion(version: string): number {
  if (!/^[1-9][0-9]{0,3}$/.test(version)) {
    throw invalidRequest('rubric_version', 'invalid_parameter', 'rubric version is invalid.');
  }
  return Number(version);
}

function versionView(row: VersionRow): RubricVersionView {
  if (row.status !== 'draft' && row.status !== 'approved') {
    throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  }
  const taskCategory = parseRubricTask(row.task_category);
  return {
    id: row.rubric_id,
    versionId: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    taskCategory,
    config: parseRubricConfig(row.config, taskCategory),
    activatedAt:
      row.activated_at === null
        ? null
        : row.activated_at instanceof Date
          ? row.activated_at.toISOString()
          : new Date(row.activated_at).toISOString(),
  };
}

const VERSION_SELECT = `SELECT v.id::text AS id, v.rubric_id::text AS rubric_id, r.name, v.version, v.status,
            v.task_category, v.config, v.activated_at
     FROM evaluation_rubric_versions v
     JOIN evaluation_rubrics r ON r.tenant_id = v.tenant_id AND r.id = v.rubric_id`;

async function readVersion(client: PoolClient, rubricId: string, version: number): Promise<RubricVersionView | null> {
  const result = await client.query<VersionRow>(`${VERSION_SELECT} WHERE v.rubric_id = $1 AND v.version = $2`, [
    rubricId,
    version,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : versionView(row);
}

function parseCreateBody(body: unknown): { name: string; taskCategory: ReturnType<typeof parseRubricTask>; config: RubricConfig } {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The rubric body is invalid.');
  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'taskCategory' && key !== 'config') {
      throw invalidRequest(key, 'invalid_parameter', 'The rubric body is invalid.');
    }
  }
  if (typeof body.name !== 'string' || !NAME.test(body.name)) {
    throw invalidRequest('name', 'invalid_parameter', 'name is invalid.');
  }
  const taskCategory = parseRubricTask(body.taskCategory);
  return { name: body.name, taskCategory, config: parseRubricConfig(body.config, taskCategory) };
}

function parseVersionBody(body: unknown): { taskCategory: ReturnType<typeof parseRubricTask>; config: RubricConfig } {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The rubric body is invalid.');
  for (const key of Object.keys(body)) {
    if (key !== 'taskCategory' && key !== 'config') throw invalidRequest(key, 'invalid_parameter', 'The rubric body is invalid.');
  }
  const taskCategory = parseRubricTask(body.taskCategory);
  return { taskCategory, config: parseRubricConfig(body.config, taskCategory) };
}

export async function createEvaluationRubric(client: PoolClient, tenantId: string, body: unknown): Promise<RubricVersionView> {
  const parsed = parseCreateBody(body);
  await client.query('SAVEPOINT evaluation_rubric');
  let rubricId: string | undefined;
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO evaluation_rubrics (tenant_id, name) VALUES ($1, $2) RETURNING id::text AS id`,
      [tenantId, parsed.name],
    );
    rubricId = inserted.rows[0]?.id;
    await client.query('RELEASE SAVEPOINT evaluation_rubric');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT evaluation_rubric');
    await client.query('RELEASE SAVEPOINT evaluation_rubric');
    if (isUniqueViolation(error)) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'name', 'The rubric name is already in use.');
    }
    throw error;
  }
  if (rubricId === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  await insertVersion(client, tenantId, rubricId, 1, parsed.taskCategory, parsed.config);
  const stored = await readVersion(client, rubricId, 1);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return stored;
}

export async function addEvaluationRubricVersion(
  client: PoolClient,
  tenantId: string,
  rubricId: string,
  body: unknown,
): Promise<RubricVersionView> {
  const parsed = parseVersionBody(body);
  await lockEvaluationRow(client, rubricId);
  const rubric = await client.query(`SELECT 1 FROM evaluation_rubrics WHERE id = $1`, [rubricId]);
  if ((rubric.rowCount ?? 0) === 0) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rubric_id', 'The rubric was not found.');
  }
  const next = await client.query<{ version: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS version FROM evaluation_rubric_versions WHERE rubric_id = $1`,
    [rubricId],
  );
  const version = next.rows[0]?.version;
  if (version === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  await insertVersion(client, tenantId, rubricId, version, parsed.taskCategory, parsed.config);
  const stored = await readVersion(client, rubricId, version);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return stored;
}

async function insertVersion(
  client: PoolClient,
  tenantId: string,
  rubricId: string,
  version: number,
  taskCategory: string,
  config: RubricConfig,
): Promise<void> {
  await client.query(
    `INSERT INTO evaluation_rubric_versions (tenant_id, rubric_id, version, status, task_category, config)
     VALUES ($1, $2, $3, 'draft', $4, $5::jsonb)`,
    [tenantId, rubricId, version, taskCategory, JSON.stringify(config)],
  );
}

export async function approveEvaluationRubric(
  client: PoolClient,
  rubricId: string,
  version: number,
): Promise<RubricVersionView> {
  await lockEvaluationRow(client, rubricId);
  const current = await readVersion(client, rubricId, version);
  if (current === null) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rubric_id', 'The rubric was not found.');
  }
  if (current.status === 'approved') return current;
  const updated = await client.query(
    `UPDATE evaluation_rubric_versions
     SET status = 'approved', activated_at = statement_timestamp()
     WHERE id = $1 AND status = 'draft'`,
    [current.versionId],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw proxyError(409, 'invalid_request_error', 'illegal_transition', 'status', 'The rubric version is not a draft.');
  }
  const stored = await readVersion(client, rubricId, version);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return stored;
}

export async function readEvaluationRubricVersion(
  client: PoolClient,
  rubricId: string,
  version: number,
): Promise<RubricVersionView | null> {
  return readVersion(client, rubricId, version);
}

export async function enqueueJudgeJob(client: PoolClient, tenantId: string, runId: string, itemId: string): Promise<void> {
  const pinned = await client.query<{ rubric_version_id: string | null; judge_deployment: string | null }>(
    `SELECT rubric_version_id::text AS rubric_version_id, judge_deployment
     FROM evaluation_runs WHERE id = $1`,
    [runId],
  );
  const row = pinned.rows[0];
  if (row === undefined || row.rubric_version_id === null || row.judge_deployment === null) return;
  await client.query('SAVEPOINT judge_job');
  try {
    await client.query(
      `INSERT INTO evaluation_judge_jobs (tenant_id, run_id, item_id, idempotency_key, status, payload)
       VALUES ($1, $2, $3, $4, 'pending', jsonb_build_object('kind', 'judge'))`,
      [tenantId, runId, itemId, `judge:${itemId}`],
    );
    await client.query('RELEASE SAVEPOINT judge_job');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT judge_job');
    await client.query('RELEASE SAVEPOINT judge_job');
    if (!isUniqueViolation(error)) throw error;
  }
}
