import type { PoolClient } from 'pg';
import { invalidRequest, proxyError } from './errors.js';
import { lockEvaluationRow } from './evaluations.js';
import { SAMPLE_SCHEMA_VERSION, decryptSample, type SampleKeyManager } from './sample-crypto.js';
import {
  parseProfileConfig,
  parseProfileTask,
  parseTrustedReference,
  runProfileValidators,
  type ProfileConfig,
  type ValidatorOutcome,
} from './validators.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ProfileVersionView = {
  id: string;
  versionId: string;
  name: string;
  version: number;
  status: 'draft' | 'approved';
  taskCategory: string;
  config: ProfileConfig;
  activatedAt: string | null;
};

type VersionRow = {
  id: string;
  profile_id: string;
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

export function parseProfileId(profileId: string): string {
  if (!UUID.test(profileId)) throw invalidRequest('profile_id', 'invalid_parameter', 'profile id is invalid.');
  return profileId.toLowerCase();
}

export function parseProfileVersion(version: string): number {
  if (!/^[1-9][0-9]{0,3}$/.test(version)) {
    throw invalidRequest('profile_version', 'invalid_parameter', 'profile version is invalid.');
  }
  return Number(version);
}

function versionView(row: VersionRow): ProfileVersionView {
  if (row.status !== 'draft' && row.status !== 'approved') {
    throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  }
  return {
    id: row.profile_id,
    versionId: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    taskCategory: row.task_category,
    config: parseProfileConfig(row.config),
    activatedAt: row.activated_at === null ? null : row.activated_at instanceof Date ? row.activated_at.toISOString() : new Date(row.activated_at).toISOString(),
  };
}

const VERSION_SELECT = `SELECT v.id::text AS id, v.profile_id::text AS profile_id, p.name, v.version, v.status,
            v.task_category, v.config, v.activated_at
     FROM evaluation_profile_versions v
     JOIN evaluation_profiles p ON p.tenant_id = v.tenant_id AND p.id = v.profile_id`;

async function readVersion(client: PoolClient, profileId: string, version: number): Promise<ProfileVersionView | null> {
  const result = await client.query<VersionRow>(`${VERSION_SELECT} WHERE v.profile_id = $1 AND v.version = $2`, [
    profileId,
    version,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : versionView(row);
}

function parseCreateBody(body: unknown): { name: string; taskCategory: ReturnType<typeof parseProfileTask>; config: ProfileConfig } {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The profile body is invalid.');
  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'taskCategory' && key !== 'config') {
      throw invalidRequest(key, 'invalid_parameter', 'The profile body is invalid.');
    }
  }
  if (typeof body.name !== 'string' || !NAME.test(body.name)) {
    throw invalidRequest('name', 'invalid_parameter', 'name is invalid.');
  }
  return { name: body.name, taskCategory: parseProfileTask(body.taskCategory), config: parseProfileConfig(body.config) };
}

function parseVersionBody(body: unknown): { taskCategory: ReturnType<typeof parseProfileTask>; config: ProfileConfig } {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The profile body is invalid.');
  for (const key of Object.keys(body)) {
    if (key !== 'taskCategory' && key !== 'config') throw invalidRequest(key, 'invalid_parameter', 'The profile body is invalid.');
  }
  return { taskCategory: parseProfileTask(body.taskCategory), config: parseProfileConfig(body.config) };
}

export async function createEvaluationProfile(client: PoolClient, tenantId: string, body: unknown): Promise<ProfileVersionView> {
  const parsed = parseCreateBody(body);
  await client.query('SAVEPOINT evaluation_profile');
  let profileId: string | undefined;
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO evaluation_profiles (tenant_id, name) VALUES ($1, $2) RETURNING id::text AS id`,
      [tenantId, parsed.name],
    );
    profileId = inserted.rows[0]?.id;
    await client.query('RELEASE SAVEPOINT evaluation_profile');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT evaluation_profile');
    await client.query('RELEASE SAVEPOINT evaluation_profile');
    if (isUniqueViolation(error)) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'name', 'The profile name is already in use.');
    }
    throw error;
  }
  if (profileId === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  await insertVersion(client, tenantId, profileId, 1, parsed.taskCategory, parsed.config);
  const stored = await readVersion(client, profileId, 1);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return stored;
}

export async function addEvaluationProfileVersion(
  client: PoolClient,
  tenantId: string,
  profileId: string,
  body: unknown,
): Promise<ProfileVersionView> {
  const parsed = parseVersionBody(body);
  await lockEvaluationRow(client, profileId);
  const profile = await client.query(`SELECT 1 FROM evaluation_profiles WHERE id = $1`, [profileId]);
  if ((profile.rowCount ?? 0) === 0) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'profile_id', 'The profile was not found.');
  }
  const next = await client.query<{ version: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS version FROM evaluation_profile_versions WHERE profile_id = $1`,
    [profileId],
  );
  const version = next.rows[0]?.version;
  if (version === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  await insertVersion(client, tenantId, profileId, version, parsed.taskCategory, parsed.config);
  const stored = await readVersion(client, profileId, version);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return stored;
}

async function insertVersion(
  client: PoolClient,
  tenantId: string,
  profileId: string,
  version: number,
  taskCategory: string,
  config: ProfileConfig,
): Promise<void> {
  await client.query(
    `INSERT INTO evaluation_profile_versions (tenant_id, profile_id, version, status, task_category, config)
     VALUES ($1, $2, $3, 'draft', $4, $5::jsonb)`,
    [tenantId, profileId, version, taskCategory, JSON.stringify(config)],
  );
}

export async function approveEvaluationProfile(
  client: PoolClient,
  profileId: string,
  version: number,
): Promise<ProfileVersionView> {
  await lockEvaluationRow(client, profileId);
  const current = await readVersion(client, profileId, version);
  if (current === null) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'profile_id', 'The profile was not found.');
  }
  if (current.status === 'approved') return current;
  const updated = await client.query(
    `UPDATE evaluation_profile_versions
     SET status = 'approved', activated_at = statement_timestamp()
     WHERE id = $1 AND status = 'draft'`,
    [current.versionId],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw proxyError(409, 'invalid_request_error', 'illegal_transition', 'status', 'The profile version is not a draft.');
  }
  const stored = await readVersion(client, profileId, version);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return stored;
}

export async function readEvaluationProfileVersion(
  client: PoolClient,
  profileId: string,
  version: number,
): Promise<ProfileVersionView | null> {
  return readVersion(client, profileId, version);
}

export async function storeEvaluationReference(
  client: PoolClient,
  tenantId: string,
  profileId: string,
  version: number,
  body: unknown,
): Promise<{ sampleId: string; referencePresent: true }> {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The reference body is invalid.');
  for (const key of Object.keys(body)) {
    if (key !== 'sampleId' && key !== 'reference') throw invalidRequest(key, 'invalid_parameter', 'The reference body is invalid.');
  }
  if (typeof body.sampleId !== 'string' || !UUID.test(body.sampleId)) {
    throw invalidRequest('sample_id', 'invalid_parameter', 'sampleId is invalid.');
  }
  const sampleId = body.sampleId.toLowerCase();
  const reference = parseTrustedReference(body.reference);
  await lockEvaluationRow(client, profileId);
  const current = await readVersion(client, profileId, version);
  if (current === null) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'profile_id', 'The profile was not found.');
  }
  if (current.status !== 'draft') {
    throw proxyError(409, 'invalid_request_error', 'illegal_transition', 'status', 'The profile version is immutable.');
  }
  const sample = await client.query(`SELECT 1 FROM request_samples WHERE id = $1`, [sampleId]);
  if ((sample.rowCount ?? 0) === 0) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'sample_id', 'The sample was not found.');
  }
  await client.query(
    `DELETE FROM evaluation_references WHERE profile_version_id = $1 AND sample_id = $2`,
    [current.versionId, sampleId],
  );
  await client.query(
    `INSERT INTO evaluation_references (tenant_id, profile_version_id, sample_id, reference)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [tenantId, current.versionId, sampleId, JSON.stringify(reference)],
  );
  return { sampleId, referencePresent: true };
}

function outputText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const output = payload.output;
  if (!isRecord(output) || !Array.isArray(output.choices) || !isRecord(output.choices[0])) return null;
  const content = output.choices[0].content;
  return typeof content === 'string' ? content : null;
}

function bufferOf(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function openSampleText(
  client: PoolClient,
  manager: SampleKeyManager,
  tenantId: string,
  sampleId: string,
): Promise<string | null> {
  const result = await client.query<{
    schema_version: number;
    wrapping_key_version: number;
    wrapped_key_iv: Buffer;
    wrapped_key_tag: Buffer;
    wrapped_key_ciphertext: Buffer;
    content_iv: Buffer;
    content_tag: Buffer;
    content_ciphertext: Buffer;
  }>(
    `SELECT schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
            content_iv, content_tag, content_ciphertext
     FROM load_replay_sample_envelope($1)`,
    [sampleId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const payload = decryptSample(
    manager,
    { tenantId, sampleId, schemaVersion: row.schema_version },
    {
      schemaVersion: row.schema_version,
      wrappingKeyVersion: row.wrapping_key_version,
      wrappedKeyIv: bufferOf(row.wrapped_key_iv),
      wrappedKeyTag: bufferOf(row.wrapped_key_tag),
      wrappedKeyCiphertext: bufferOf(row.wrapped_key_ciphertext),
      contentIv: bufferOf(row.content_iv),
      contentTag: bufferOf(row.content_tag),
      contentCiphertext: bufferOf(row.content_ciphertext),
    },
  );
  return outputText(payload);
}

async function openAttemptText(
  client: PoolClient,
  manager: SampleKeyManager,
  tenantId: string,
  attemptId: string,
): Promise<string | null> {
  const result = await client.query<{
    schema_version: number;
    wrapping_key_version: number;
    wrapped_key_iv: Buffer;
    wrapped_key_tag: Buffer;
    wrapped_key_ciphertext: Buffer;
    content_iv: Buffer;
    content_tag: Buffer;
    content_ciphertext: Buffer;
  }>(
    `SELECT schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
            content_iv, content_tag, content_ciphertext
     FROM load_evaluation_attempt_envelope($1)`,
    [attemptId],
  );
  const row = result.rows[0];
  if (row === undefined || row.schema_version === null) return null;
  const payload = decryptSample(
    manager,
    { tenantId, sampleId: attemptId, schemaVersion: row.schema_version },
    {
      schemaVersion: row.schema_version,
      wrappingKeyVersion: row.wrapping_key_version,
      wrappedKeyIv: bufferOf(row.wrapped_key_iv),
      wrappedKeyTag: bufferOf(row.wrapped_key_tag),
      wrappedKeyCiphertext: bufferOf(row.wrapped_key_ciphertext),
      contentIv: bufferOf(row.content_iv),
      contentTag: bufferOf(row.content_tag),
      contentCiphertext: bufferOf(row.content_ciphertext),
    },
  );
  return outputText(payload);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function insertOutcome(
  client: PoolClient,
  input: {
    tenantId: string;
    runId: string;
    itemId: string;
    profileVersionId: string;
    candidate: 'original' | 'challenger';
    outcome: ValidatorOutcome;
  },
): Promise<void> {
  const measured = JSON.stringify(input.outcome.measured);
  const storedMeasured = measured.length <= 512 ? measured : '{"omitted":true}';
  await client.query('SAVEPOINT validator_result');
  try {
    await client.query(
      `INSERT INTO evaluation_validator_results (
         tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
         result, measured, evidence_code, error_classification, reference_present
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
      [
        input.tenantId,
        input.runId,
        input.itemId,
        input.profileVersionId,
        input.candidate,
        input.outcome.validatorId,
        input.outcome.version,
        input.outcome.result,
        storedMeasured,
        input.outcome.evidenceCode,
        input.outcome.errorClassification,
        input.outcome.referencePresent,
      ],
    );
    await client.query('RELEASE SAVEPOINT validator_result');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT validator_result');
    await client.query('RELEASE SAVEPOINT validator_result');
    if (!isUniqueViolation(error)) throw error;
  }
}

export async function scoreCompletedReplay(
  client: PoolClient,
  manager: SampleKeyManager,
  input: { tenantId: string; runId: string; itemId: string; sampleId: string; attemptId: string },
): Promise<void> {
  await lockEvaluationRow(client, input.runId);
  await lockEvaluationRow(client, input.itemId);
  const pinned = await client.query<{ profile_version_id: string | null; sample_category: string }>(
    `SELECT profile_version_id::text AS profile_version_id, sample_category
     FROM evaluation_runs WHERE id = $1`,
    [input.runId],
  );
  const profileVersionId = pinned.rows[0]?.profile_version_id ?? null;
  const sampleCategory = pinned.rows[0]?.sample_category;
  if (profileVersionId === null || sampleCategory === undefined) return;
  const version = await client.query<{ status: string; task_category: string; config: unknown }>(
    `SELECT status, task_category, config FROM evaluation_profile_versions WHERE id = $1`,
    [profileVersionId],
  );
  const row = version.rows[0];
  if (row === undefined || row.status !== 'approved') return;
  const config = parseProfileConfig(row.config);
  const referenceRow = await client.query<{ reference: unknown }>(
    `SELECT reference FROM evaluation_references WHERE profile_version_id = $1 AND sample_id = $2`,
    [profileVersionId, input.sampleId],
  );
  const storedReference = referenceRow.rows[0]?.reference;
  const referencePresent = storedReference !== undefined;
  const reference = referencePresent && isRecord(storedReference) ? storedReference : null;
  const incompatible = row.task_category !== sampleCategory;
  const originalText = incompatible ? null : await openSampleText(client, manager, input.tenantId, input.sampleId);
  const challengerText = incompatible ? null : await openAttemptText(client, manager, input.tenantId, input.attemptId);
  const candidates: Array<{ candidate: 'original' | 'challenger'; text: string | null }> = [
    { candidate: 'original', text: originalText },
    { candidate: 'challenger', text: challengerText },
  ];
  for (const candidate of candidates) {
    const outcomes = runProfileValidators({
      config,
      text: candidate.text,
      reference: referencePresent ? reference : null,
      referencePresent,
      incompatible,
    });
    for (const outcome of outcomes) {
      await insertOutcome(client, { ...input, profileVersionId, candidate: candidate.candidate, outcome });
    }
  }
}
