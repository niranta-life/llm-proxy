import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import type { UpstreamCompletion } from './adapter.js';
import { invalidRequest } from './errors.js';
import type { ResolvedRoute } from './resolve.js';
import { isTaskCategory } from './request-features.js';
import {
  CAPTURE_BUDGET_MS,
  CAPTURE_BYTE_CEILING,
  SAMPLE_SCHEMA_VERSION,
  decryptSample,
  encryptSample,
  type EncryptedEnvelope,
  type SampleKeyManager,
} from './sample-crypto.js';
import {
  decideSampleCapture,
  isDataClass,
  isSampleMode,
  SAMPLE_PROVIDERS,
  type CaptureFacts,
  type SamplePolicy,
} from './sample-policy.js';
import {
  DEFAULT_RECENT_SHARE,
  contentFingerprint,
  deterministicDraw,
  diversityKey,
  selectSample,
  visibleSampleText,
  type HeldSample,
  type SampleSlot,
} from './sample-selection.js';
import type { ChatRequest } from './validate.js';

export const SAMPLE_PAGE_CAP = 50;
export const ADAPTER_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SamplePayload = {
  schemaVersion: number;
  request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    task: string | null;
    parameters: Record<string, unknown>;
  };
  output: {
    choices: Array<{ index: number; content: string; finishReason: string | null }>;
  };
  configuration: {
    requestedModel: string;
    deployment: string;
    provider: string;
    upstreamModel: string;
    timeoutMs: number;
    dataClassification: string;
    stream: false;
  };
  providerMetadata: {
    provider: string;
    adapterVersion: number;
  };
};

export type StoredSample = {
  id: string;
  requestId: string;
  policyVersion: number;
  provider: string;
  deployment: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
};

export type SampleStats = {
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

type PolicyRow = {
  id: string;
  policy_version: number;
  mode: string;
  content_capture: boolean;
  replay_permitted: boolean;
  judge_disclosure_permitted: boolean;
  sample_rate: string;
  max_sample_bytes: number;
  max_sample_count: number;
  retention_seconds: number;
  recent_share: string;
  approved_classifications: string[];
  allowed_providers: string[];
  allowed_deployments: string[];
};

type LoadedPolicy = {
  id: string;
  version: number;
  retentionSeconds: number;
  recentShare: number;
  policy: SamplePolicy;
};

type Coverage = {
  key: string;
  taskCategory: string;
  inputSize: number;
  complexity: string;
};

type SampleMetaRow = {
  id: string;
  request_id: string;
  policy_version: number;
  provider: string;
  deployment_name: string;
  size_bytes: number;
  created_at: Date | string;
  expires_at: Date | string;
};

const META_COLUMNS = `id, request_id, policy_version, provider, deployment_name, size_bytes, created_at, expires_at`;

export function buildSamplePayload(input: {
  request: ChatRequest;
  response: UpstreamCompletion['response'];
  route: Pick<ResolvedRoute, 'requestedModel' | 'deploymentName' | 'provider' | 'upstreamModel' | 'timeoutMs'>;
  dataClass: string;
}): SamplePayload {
  return {
    schemaVersion: SAMPLE_SCHEMA_VERSION,
    request: {
      model: input.request.model,
      messages: input.request.messages.map((message) => ({ role: message.role, content: message.content })),
      task: input.request.taskHint,
      parameters: { ...input.request.optional },
    },
    output: {
      choices: input.response.choices.map((choice) => ({
        index: choice.index,
        content: choice.message.content,
        finishReason: choice.finish_reason,
      })),
    },
    configuration: {
      requestedModel: input.route.requestedModel,
      deployment: input.route.deploymentName,
      provider: input.route.provider,
      upstreamModel: input.route.upstreamModel,
      timeoutMs: input.route.timeoutMs,
      dataClassification: input.dataClass,
      stream: false,
    },
    providerMetadata: {
      provider: input.route.provider,
      adapterVersion: ADAPTER_VERSION,
    },
  };
}

export function payloadBytes(payload: SamplePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

export async function captureChatSample(input: {
  pool: Pool;
  logger: Logger;
  tenantId: string;
  requestId: string;
  request: ChatRequest;
  response: UpstreamCompletion['response'];
  route: Pick<ResolvedRoute, 'deploymentId' | 'requestedModel' | 'deploymentName' | 'provider' | 'upstreamModel' | 'timeoutMs'>;
  keyManager: SampleKeyManager | null;
  nowMs?: () => number;
  draw?: number;
  beforeStore?: () => Promise<void> | void;
  beforeInsert?: () => Promise<void> | void;
  failInsert?: () => boolean;
}): Promise<void> {
  try {
    if (input.request.stream || input.keyManager === null) return;
    const nowMs = input.nowMs ?? Date.now;
    const started = nowMs();
    const draw = input.draw ?? deterministicDraw(input.tenantId, input.requestId);
    const now = new Date(started);
    const early = await withTenant(input.pool, input.tenantId, (client) =>
      loadGate(client, input.route, now, { sampleBytes: 0, draw, ageMs: 0 }),
    );
    if (!early.decision.capture || early.loaded === null) return;
    if (overBudget(started, nowMs())) return;
    const dataClass = early.facts.dataClass;
    if (dataClass === null) return;
    const payload = buildSamplePayload({
      request: input.request,
      response: input.response,
      route: input.route,
      dataClass,
    });
    const sampleBytes = payloadBytes(payload);
    if (sampleBytes > CAPTURE_BYTE_CEILING || sampleBytes > early.loaded.policy.maxSampleBytes) return;
    const sampleId = randomUUID();
    const envelope = encryptSample(input.keyManager, {
      tenantId: input.tenantId,
      sampleId,
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      payload,
    });
    if (envelope === null || overBudget(started, nowMs())) return;
    if (input.beforeStore) await input.beforeStore();
    if (overBudget(started, nowMs())) return;
    const storedAt = new Date(nowMs());
    const output = payload.output.choices.map((choice) => choice.content).join('\n');
    const fingerprint = contentFingerprint(input.tenantId, visibleSampleText(payload.request.messages, output));
    const stored = await withTenant(input.pool, input.tenantId, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        `sample-cap:${input.tenantId}`,
      ]);
      const again = await loadGate(client, input.route, storedAt, { sampleBytes, draw, ageMs: 0 });
      if (!again.decision.capture || again.loaded === null || again.facts.dataClass !== dataClass) return false;
      const coverage = await loadCoverage(client, input.requestId, input.request, input.route.deploymentName);
      const held = await loadHeld(client);
      const selected = selectSample({
        policy: again.loaded.policy,
        facts: { ...again.facts, storedCount: held.length },
        fingerprintHex: fingerprint.toString('hex'),
        held,
        diversityKey: coverage.key,
        candidateId: sampleId,
        createdAtMs: storedAt.getTime(),
        recentShare: again.loaded.recentShare,
      });
      if (!selected.keep) return false;
      if (input.failInsert?.()) throw new Error('sample store failed');
      for (const evictId of selected.evictIds) {
        await client.query(`SELECT delete_request_sample($1, $2, 'cap')`, [input.tenantId, evictId]);
      }
      if (input.beforeInsert) await input.beforeInsert();
      const inserted = await insertSample(client, {
        sampleId,
        tenantId: input.tenantId,
        requestId: input.requestId,
        provider: input.route.provider,
        deployment: input.route.deploymentName,
        dataClass,
        sizeBytes: sampleBytes,
        envelope,
        fingerprint,
        slot: selected.slot,
        taskCategory: coverage.taskCategory,
        inputSize: coverage.inputSize,
        complexity: coverage.complexity,
        createdAt: storedAt,
      });
      if (!inserted) throw new Error('sample capture is no longer authorized');
      return true;
    });
    if (stored) input.logger.info('sample stored', { requestId: input.requestId, sampleId });
  } catch {
    input.logger.error('sample was not stored', { requestId: input.requestId });
  }
}

export function parseSampleListQuery(query: { limit?: string; cursor?: string; provider?: string }): {
  limit: number;
  cursor: string | null;
  provider: string | null;
} {
  let limit = SAMPLE_PAGE_CAP;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(query.limit)) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > SAMPLE_PAGE_CAP) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
  }
  let cursor: string | null = null;
  if (query.cursor !== undefined) {
    if (!UUID.test(query.cursor)) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
    cursor = query.cursor;
  }
  let provider: string | null = null;
  if (query.provider !== undefined) {
    if (!(SAMPLE_PROVIDERS as readonly string[]).includes(query.provider)) {
      throw invalidRequest('provider', 'invalid_parameter', 'provider is not a supported value.');
    }
    provider = query.provider;
  }
  return { limit, cursor, provider };
}

export function parseSampleId(sampleId: string): string {
  if (!UUID.test(sampleId)) throw invalidRequest('sample_id', 'invalid_parameter', 'sample id is invalid.');
  return sampleId;
}

export async function listSamples(
  client: PoolClient,
  query: { limit: number; cursor: string | null; provider: string | null },
): Promise<{ samples: StoredSample[]; nextCursor: string | null }> {
  if (query.cursor !== null) {
    const found = await client.query(
      `SELECT 1 FROM request_samples WHERE id = $1 AND request_sample_visible(expires_at, tenant_id)`,
      [query.cursor],
    );
    if ((found.rowCount ?? 0) === 0) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
  }
  const result = await client.query<SampleMetaRow>(
    `SELECT ${META_COLUMNS}
     FROM request_samples
     WHERE request_sample_visible(expires_at, tenant_id)
       AND ($1::text IS NULL OR provider = $1)
       AND (
         $2::uuid IS NULL
         OR (created_at, id) < (
           SELECT c.created_at, c.id FROM request_samples c WHERE c.id = $2
         )
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [query.provider, query.cursor, query.limit + 1],
  );
  const page = result.rows.slice(0, query.limit).map(sampleFromRow);
  const last = page.at(-1);
  const nextCursor = result.rows.length > query.limit && last !== undefined ? last.id : null;
  return { samples: page, nextCursor };
}

export async function readSample(client: PoolClient, sampleId: string): Promise<StoredSample | null> {
  const result = await client.query<SampleMetaRow>(
    `SELECT ${META_COLUMNS}
     FROM request_samples
     WHERE id = $1
       AND request_sample_visible(expires_at, tenant_id)`,
    [sampleId],
  );
  const row = result.rows[0];
  return row === undefined ? null : sampleFromRow(row);
}

export async function readSampleStats(client: PoolClient, tenantId: string): Promise<SampleStats> {
  const result = await client.query<{ show_sample_stats: SampleStats }>(
    `SELECT show_sample_stats($1) AS show_sample_stats`,
    [tenantId],
  );
  const stats = result.rows[0]?.show_sample_stats;
  if (stats === undefined) throw new Error('sample stats were not read');
  return stats;
}

export async function deleteStoredSample(client: PoolClient, tenantId: string, sampleId: string): Promise<boolean> {
  const result = await client.query<{ delete_request_sample: boolean }>(
    `SELECT delete_request_sample($1, $2, 'manual') AS delete_request_sample`,
    [tenantId, sampleId],
  );
  return result.rows[0]?.delete_request_sample === true;
}

export { decryptSample };

async function loadGate(
  client: PoolClient,
  route: { deploymentId: string; provider: string; deploymentName: string },
  now: Date,
  measured: { sampleBytes: number; draw: number; ageMs: number },
): Promise<{ loaded: LoadedPolicy | null; facts: CaptureFacts; decision: ReturnType<typeof decideSampleCapture> }> {
  const loaded = await loadPolicy(client);
  const dataClass = await loadDataClass(client, route.deploymentId);
  const storedCount = await countOpenSamples(client, now);
  const facts: CaptureFacts = {
    dataClass,
    provider: route.provider,
    deployment: route.deploymentName,
    sampleBytes: measured.sampleBytes,
    storedCount,
    draw: measured.draw,
    ageMs: measured.ageMs,
  };
  return { loaded, facts, decision: decideSampleCapture(loaded?.policy ?? null, authorizationFacts(loaded?.policy ?? null, facts)) };
}

function authorizationFacts(policy: SamplePolicy | null, measured: CaptureFacts): CaptureFacts {
  const cap = policy?.maxSampleCount ?? 0;
  if (cap > 0 && measured.storedCount >= cap) return { ...measured, storedCount: cap - 1 };
  return measured;
}

async function loadPolicy(client: PoolClient): Promise<LoadedPolicy | null> {
  const result = await client.query<PolicyRow>(
    `SELECT id, policy_version, mode, content_capture, replay_permitted, judge_disclosure_permitted,
            sample_rate::text AS sample_rate, max_sample_bytes, max_sample_count, retention_seconds,
            recent_share::text AS recent_share,
            approved_classifications, allowed_providers, allowed_deployments
     FROM sample_policies
     ORDER BY policy_version DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined || !isSampleMode(row.mode)) return null;
  return {
    id: row.id,
    version: row.policy_version,
    retentionSeconds: row.retention_seconds,
    recentShare: recentShareOf(row.recent_share),
    policy: {
      mode: row.mode,
      contentCapture: row.content_capture,
      replay: row.replay_permitted,
      judgeDisclosure: row.judge_disclosure_permitted,
      sampleRate: Number(row.sample_rate),
      maxSampleBytes: row.max_sample_bytes,
      maxSampleCount: row.max_sample_count,
      retentionSeconds: row.retention_seconds,
      approvedClassifications: row.approved_classifications,
      allowedProviders: row.allowed_providers,
      allowedDeployments: row.allowed_deployments,
    },
  };
}

async function loadDataClass(client: PoolClient, deploymentId: string): Promise<string | null> {
  const result = await client.query<{ data_classification: string | null }>(
    `SELECT data_classification FROM model_deployments WHERE id = $1`,
    [deploymentId],
  );
  const value = result.rows[0]?.data_classification ?? null;
  return value !== null && isDataClass(value) ? value : null;
}

async function countOpenSamples(client: PoolClient, now: Date): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM request_samples WHERE expires_at > $1`,
    [now],
  );
  return result.rows[0]?.count ?? 0;
}

async function insertSample(
  client: PoolClient,
  input: {
    sampleId: string;
    tenantId: string;
    requestId: string;
    provider: string;
    deployment: string;
    dataClass: string;
    sizeBytes: number;
    envelope: EncryptedEnvelope;
    fingerprint: Buffer;
    slot: SampleSlot;
    taskCategory: string;
    inputSize: number;
    complexity: string;
    createdAt: Date;
  },
): Promise<boolean> {
  // Read the latest policy in this statement. A revocation that commits after
  // loadGate must not store a row, and locking the previously read version would miss it.
  const result = await client.query(
    `INSERT INTO request_samples (
       id, tenant_id, request_id, policy_id, policy_version, provider, deployment_name,
       data_classification, schema_version, size_bytes, wrapping_key_version,
       wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
       content_iv, content_tag, content_ciphertext, created_at, expires_at,
       fingerprint, slot, task_category, input_size, complexity
     )
     SELECT
       $1, $2, $3, policy.id, policy.policy_version, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12,
       $13, $14, $15, $16,
       $16::timestamptz + (policy.retention_seconds * interval '1 second'),
       $17, $18, $19, $20, $21
     FROM sample_policies AS policy
     WHERE policy.tenant_id = $2::uuid
       AND policy.mode = 'encrypted_sample'
       AND policy.content_capture = true
       AND policy.policy_version = (
         SELECT max(latest.policy_version)
         FROM sample_policies AS latest
         WHERE latest.tenant_id = $2::uuid
       )`,
    [
      input.sampleId,
      input.tenantId,
      input.requestId,
      input.provider,
      input.deployment,
      input.dataClass,
      input.envelope.schemaVersion,
      input.sizeBytes,
      input.envelope.wrappingKeyVersion,
      input.envelope.wrappedKeyIv,
      input.envelope.wrappedKeyTag,
      input.envelope.wrappedKeyCiphertext,
      input.envelope.contentIv,
      input.envelope.contentTag,
      input.envelope.contentCiphertext,
      input.createdAt,
      input.fingerprint,
      input.slot,
      input.taskCategory,
      input.inputSize,
      input.complexity,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

async function loadCoverage(
  client: PoolClient,
  requestId: string,
  request: ChatRequest,
  deploymentName: string,
): Promise<Coverage> {
  const result = await client.query<{
    task_category: string;
    input_size: number;
    complexity_estimate: string;
    selected_deployment: string;
  }>(
    `SELECT task_category, input_size, complexity_estimate, selected_deployment
     FROM request_features
     WHERE request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  const inputSize = row?.input_size ?? request.messages.reduce((sum, message) => sum + message.content.length, 0);
  const taskCategory = row !== undefined && isTaskCategory(row.task_category)
    ? row.task_category
    : request.taskHint !== null && isTaskCategory(request.taskHint)
      ? request.taskHint
      : 'unknown';
  const complexity = row?.complexity_estimate ?? complexityBand(inputSize);
  const deployment = row?.selected_deployment ?? deploymentName;
  return {
    key: diversityKey({ taskCategory, inputSize, complexity, deployment }),
    taskCategory,
    inputSize,
    complexity,
  };
}

async function loadHeld(client: PoolClient): Promise<HeldSample[]> {
  const result = await client.query<{
    id: string;
    slot: string | null;
    task_category: string | null;
    input_size: number | null;
    complexity: string | null;
    deployment_name: string;
    fingerprint_hex: string | null;
    created_at: Date | string;
  }>(
    `SELECT id::text AS id, slot, task_category, input_size, complexity, deployment_name,
            encode(fingerprint, 'hex') AS fingerprint_hex, created_at
     FROM request_samples
     WHERE expires_at > statement_timestamp()`,
  );
  return result.rows.map((row) => {
    const taskCategory = row.task_category ?? 'unknown';
    const inputSize = row.input_size ?? 0;
    const complexity = row.complexity ?? 'low';
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    const slot: SampleSlot = row.slot === 'diverse' ? 'diverse' : 'recent';
    return {
      id: row.id,
      createdAtMs: createdAt.getTime(),
      slot,
      diversityKey: diversityKey({
        taskCategory,
        inputSize,
        complexity,
        deployment: row.deployment_name,
      }),
      fingerprintHex: row.fingerprint_hex ?? '',
    };
  });
}

function recentShareOf(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_RECENT_SHARE;
}

function complexityBand(inputSize: number): string {
  if (inputSize >= 8000) return 'high';
  if (inputSize >= 800) return 'medium';
  return 'low';
}

function sampleFromRow(row: SampleMetaRow): StoredSample {
  return {
    id: row.id,
    requestId: row.request_id,
    policyVersion: row.policy_version,
    provider: row.provider,
    deployment: row.deployment_name,
    sizeBytes: row.size_bytes,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function overBudget(started: number, now: number): boolean {
  return now - started > CAPTURE_BUDGET_MS;
}
