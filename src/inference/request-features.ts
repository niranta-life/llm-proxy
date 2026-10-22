import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import type { TokenUsage } from './adapter.js';
import { invalidRequest } from './errors.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';
import type { ChatRequest } from './validate.js';

export { isTaskCategory };

export const FEATURE_EXTRACTOR_VERSION = 1;
export const FEATURE_PAGE_CAP = 50;

export type { TaskCategory };
export type ClassificationSource = 'caller_hint' | 'rules' | 'unknown';
export type ComplexityEstimate = 'low' | 'medium' | 'high';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RULES: ReadonlyArray<{ category: TaskCategory; pattern: RegExp }> = [
  { category: 'classification', pattern: /\b(classify|classification|categorize|categorise)\b/i },
  { category: 'extraction', pattern: /\b(extract|extraction)\b/i },
  { category: 'summarization', pattern: /\b(summarize|summarise|summarization|summarisation|summary|tldr)\b|tl;dr/i },
  { category: 'translation', pattern: /\b(translate|translation)\b/i },
  { category: 'coding', pattern: /\b(code|coding|function|implement|debug|refactor)\b/i },
  { category: 'reasoning', pattern: /\b(reason|reasoning|prove)\b|step by step/i },
  { category: 'writing', pattern: /\b(write|draft|essay|compose)\b/i },
];

export type FeatureMessage = {
  role: string;
  content: string;
};

export type FeatureExtractInput = {
  messages: readonly FeatureMessage[];
  stream: boolean;
  requestedModel: string;
  taskHint: string | null;
  structuredOutput: boolean;
  toolRequired: boolean;
};

export type ExtractedFeatures = {
  extractorVersion: number;
  taskCategory: TaskCategory;
  classificationSource: ClassificationSource;
  inputTokenEstimate: number;
  messageCount: number;
  instructionPresent: boolean;
  streamRequested: boolean;
  structuredOutput: boolean;
  toolRequired: boolean;
  conversationDepth: number;
  inputSize: number;
  complexityEstimate: ComplexityEstimate;
  requestedModel: string;
};

export type StoredRequestFeature = ExtractedFeatures & {
  id: string;
  requestId: string;
  usage: TokenUsage;
  selectedDeployment: string;
  executionStatus: 'succeeded' | 'failed';
  latencyMs: number;
  cost: {
    attemptId: string | null;
    status: 'estimated' | 'provisional' | 'reconciled' | 'unknown' | null;
  };
  createdAt: string;
};

export function featureInputFromChat(request: ChatRequest): FeatureExtractInput {
  return {
    messages: request.messages,
    stream: request.stream,
    requestedModel: request.model,
    taskHint: request.taskHint,
    structuredOutput: false,
    toolRequired: false,
  };
}

export function extractRequestFeatures(input: FeatureExtractInput): ExtractedFeatures {
  const messageCount = input.messages.length;
  let inputSize = 0;
  let instructionPresent = false;
  let conversationDepth = 0;
  const parts: string[] = [];
  for (const message of input.messages) {
    inputSize += message.content.length;
    parts.push(message.content);
    if (message.role === 'system') instructionPresent = true;
    if (message.role === 'user') conversationDepth += 1;
  }
  const decision = classify(input.taskHint, parts.join('\n'));
  return {
    extractorVersion: FEATURE_EXTRACTOR_VERSION,
    taskCategory: decision.category,
    classificationSource: decision.source,
    inputTokenEstimate: Math.ceil(inputSize / 4),
    messageCount,
    instructionPresent,
    streamRequested: input.stream,
    structuredOutput: input.structuredOutput,
    toolRequired: input.toolRequired,
    conversationDepth,
    inputSize,
    complexityEstimate: complexityOf(inputSize),
    requestedModel: input.requestedModel,
  };
}

function classify(hint: string | null, text: string): { category: TaskCategory; source: ClassificationSource } {
  if (hint !== null && isTaskCategory(hint)) {
    return { category: hint, source: 'caller_hint' };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { category: rule.category, source: 'rules' };
  }
  if (isGeneralQuestion(text)) return { category: 'general_qa', source: 'rules' };
  return { category: 'unknown', source: 'unknown' };
}

function isGeneralQuestion(text: string): boolean {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.endsWith('?')) return true;
    if (/^(what|who|when|where|why|how)\b/i.test(trimmed)) return true;
  }
  return false;
}

function complexityOf(inputSize: number): ComplexityEstimate {
  if (inputSize >= 8000) return 'high';
  if (inputSize >= 800) return 'medium';
  return 'low';
}

type AttemptFacts = {
  attemptId: string;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  deploymentName: string;
  status: 'succeeded' | 'failed';
  requestedModel: string;
};

export async function recordChatFeatures(input: {
  pool: Pool;
  logger: Logger;
  tenantId: string;
  requestId: string;
  request: FeatureExtractInput;
  extract?: (value: FeatureExtractInput) => ExtractedFeatures;
}): Promise<void> {
  try {
    const extract = input.extract ?? extractRequestFeatures;
    const features = extract(input.request);
    await withTenant(input.pool, input.tenantId, async (client) => {
      const facts = await loadClosedAttempt(client, input.tenantId, input.requestId);
      if (facts === null) return;
      const cost = await loadCostStatus(client, input.tenantId, facts.attemptId);
      await client.query(
        `INSERT INTO request_features (
           tenant_id, request_id, extractor_version, task_category, classification_source,
           input_token_estimate, prompt_tokens, completion_tokens, total_tokens,
           message_count, instruction_present, stream_requested, structured_output, tool_required,
           conversation_depth, input_size, complexity_estimate, requested_model, selected_deployment,
           execution_status, latency_ms, cost_attempt_id, cost_status
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19,
           $20, $21, $22, $23
         )
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [
          input.tenantId,
          input.requestId,
          features.extractorVersion,
          features.taskCategory,
          features.classificationSource,
          features.inputTokenEstimate,
          facts.promptTokens,
          facts.completionTokens,
          facts.totalTokens,
          features.messageCount,
          features.instructionPresent,
          features.streamRequested,
          features.structuredOutput,
          features.toolRequired,
          features.conversationDepth,
          features.inputSize,
          features.complexityEstimate,
          input.request.requestedModel,
          facts.deploymentName,
          facts.status,
          facts.durationMs,
          cost.attemptId,
          cost.status,
        ],
      );
    });
  } catch (error) {
    input.logger.error('request features were not recorded', {
      requestId: input.requestId,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function loadClosedAttempt(client: PoolClient, tenantId: string, requestId: string): Promise<AttemptFacts | null> {
  const result = await client.query<{
    id: string;
    duration_ms: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    deployment_name: string;
    status: string;
    requested_model: string;
  }>(
    `SELECT a.id, a.duration_ms, a.prompt_tokens, a.completion_tokens, a.total_tokens,
            d.name AS deployment_name, r.status, r.requested_model
     FROM proxy_requests r
     JOIN model_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
     JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
     WHERE r.tenant_id = $1 AND r.id = $2 AND r.status IN ('succeeded', 'failed')
       AND a.duration_ms >= 0
     ORDER BY a.attempt_ordinal DESC
     LIMIT 1`,
    [tenantId, requestId],
  );
  const row = result.rows[0];
  if (row === undefined || (row.status !== 'succeeded' && row.status !== 'failed')) return null;
  const durationMs = asInt(row.duration_ms);
  if (durationMs === null || durationMs < 0) return null;
  return {
    attemptId: row.id,
    durationMs,
    promptTokens: countOrNull(row.prompt_tokens),
    completionTokens: countOrNull(row.completion_tokens),
    totalTokens: countOrNull(row.total_tokens),
    deploymentName: row.deployment_name,
    status: row.status,
    requestedModel: row.requested_model,
  };
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function countOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = asInt(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

async function loadCostStatus(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<{ attemptId: string | null; status: StoredRequestFeature['cost']['status'] }> {
  const result = await client.query<{ cost_status: string }>(
    `SELECT cost_status FROM attempt_costs WHERE tenant_id = $1 AND attempt_id = $2`,
    [tenantId, attemptId],
  );
  const status = result.rows[0]?.cost_status ?? null;
  if (status === 'estimated' || status === 'provisional' || status === 'reconciled' || status === 'unknown') {
    return { attemptId, status };
  }
  return { attemptId: null, status: null };
}

export function parseFeatureListQuery(query: { limit?: string; cursor?: string; category?: string }): {
  limit: number;
  cursor: string | null;
  category: TaskCategory | null;
} {
  let limit = FEATURE_PAGE_CAP;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(query.limit)) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > FEATURE_PAGE_CAP) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
  }
  let cursor: string | null = null;
  if (query.cursor !== undefined) {
    if (!UUID.test(query.cursor)) {
      throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
    }
    cursor = query.cursor;
  }
  let category: TaskCategory | null = null;
  if (query.category !== undefined) {
    if (!isTaskCategory(query.category)) {
      throw invalidRequest('category', 'invalid_parameter', 'category is not a supported value.');
    }
    category = query.category;
  }
  return { limit, cursor, category };
}

export function parseFeatureRequestId(requestId: string): string {
  if (!UUID.test(requestId)) {
    throw invalidRequest('request_id', 'invalid_parameter', 'request id is invalid.');
  }
  return requestId;
}

export async function listRequestFeatures(
  client: PoolClient,
  query: { limit: number; cursor: string | null; category: TaskCategory | null },
): Promise<{ features: StoredRequestFeature[]; nextCursor: string | null }> {
  if (query.cursor !== null) {
    const found = await client.query(`SELECT 1 FROM request_features WHERE id = $1`, [query.cursor]);
    if ((found.rowCount ?? 0) === 0) {
      throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
    }
  }
  const result = await client.query<FeatureRow>(
    `SELECT ${FEATURE_COLUMNS}
     FROM request_features
     WHERE ($1::text IS NULL OR task_category = $1)
       AND (
         $2::uuid IS NULL
         OR (created_at, id) < (
           SELECT c.created_at, c.id FROM request_features c WHERE c.id = $2
         )
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [query.category, query.cursor, query.limit + 1],
  );
  const page = result.rows.slice(0, query.limit).map(featureFromRow);
  const last = page.at(-1);
  const nextCursor = result.rows.length > query.limit && last !== undefined ? last.id : null;
  return { features: page, nextCursor };
}

export async function readRequestFeature(client: PoolClient, requestId: string): Promise<StoredRequestFeature | null> {
  const result = await client.query<FeatureRow>(
    `SELECT ${FEATURE_COLUMNS} FROM request_features WHERE request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  return row === undefined ? null : featureFromRow(row);
}

const FEATURE_COLUMNS = `id, request_id, extractor_version, task_category, classification_source,
  input_token_estimate, prompt_tokens, completion_tokens, total_tokens,
  message_count, instruction_present, stream_requested, structured_output, tool_required,
  conversation_depth, input_size, complexity_estimate, requested_model, selected_deployment,
  execution_status, latency_ms, cost_attempt_id, cost_status, created_at`;

type FeatureRow = {
  id: string;
  request_id: string;
  extractor_version: number;
  task_category: TaskCategory;
  classification_source: ClassificationSource;
  input_token_estimate: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  message_count: number;
  instruction_present: boolean;
  stream_requested: boolean;
  structured_output: boolean;
  tool_required: boolean;
  conversation_depth: number;
  input_size: number;
  complexity_estimate: ComplexityEstimate;
  requested_model: string;
  selected_deployment: string;
  execution_status: 'succeeded' | 'failed';
  latency_ms: number;
  cost_attempt_id: string | null;
  cost_status: StoredRequestFeature['cost']['status'];
  created_at: Date;
};

function featureFromRow(row: FeatureRow): StoredRequestFeature {
  return {
    id: row.id,
    requestId: row.request_id,
    extractorVersion: row.extractor_version,
    taskCategory: row.task_category,
    classificationSource: row.classification_source,
    inputTokenEstimate: row.input_token_estimate,
    usage: {
      promptTokens: countOrNull(row.prompt_tokens),
      completionTokens: countOrNull(row.completion_tokens),
      totalTokens: countOrNull(row.total_tokens),
    },
    messageCount: row.message_count,
    instructionPresent: row.instruction_present,
    streamRequested: row.stream_requested,
    structuredOutput: row.structured_output,
    toolRequired: row.tool_required,
    conversationDepth: row.conversation_depth,
    inputSize: row.input_size,
    complexityEstimate: row.complexity_estimate,
    requestedModel: row.requested_model,
    selectedDeployment: row.selected_deployment,
    executionStatus: row.execution_status,
    latencyMs: row.latency_ms,
    cost: {
      attemptId: row.cost_attempt_id,
      status: row.cost_status,
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}
