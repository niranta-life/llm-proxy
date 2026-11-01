const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  'request_id',
  'attempt_ordinal',
  'status',
  'upstream_model',
  'duration_ms',
  'first_text_delta_ms',
  'stream_status',
  'chunk_count',
  'bytes_written',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'thoughts_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'uncached_input_tokens',
  'failure_class',
  'error_code',
  'trigger_reason',
  'stop_reason',
  'serving_model',
  'expense_certainty',
  'cost_status',
  'amount',
  'latency_ms',
  'input_token_estimate',
  'input_size',
  'complexity_estimate',
  'stream_requested',
  'message_count',
  'task_category',
  'selected_deployment',
] as const;

export type ServerPatch = {
  storedAmount: number | null;
  prompt: number | null;
  completion: number | null;
  total: number | null;
  thoughts: number | null;
  serverDurationMs: number | null;
  serverTtftMs: number | null;
  streamStatus: string | null;
  serverChunks: number | null;
  serverBytes: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  uncachedInput: number | null;
  upstreamModel: string | null;
  servingModel: string | null;
  failureClass: string | null;
  providerStop: string | null;
  triggerReason: string | null;
  expenseCertainty: string | null;
  storedCostStatus: string | null;
  attemptOrdinal: number | null;
  featureLatencyMs: number | null;
  inputTokenEstimate: number | null;
  inputSize: number | null;
  complexity: string | null;
  messageCount: number | null;
  taskCategory: string | null;
  selectedDeployment: string | null;
  fallback: boolean;
};

type RawRow = {
  requestId: string;
  ordinal: number | null;
  status: string;
  upstreamModel: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  streamStatus: string | null;
  chunks: number | null;
  bytes: number | null;
  prompt: number | null;
  completion: number | null;
  total: number | null;
  thoughts: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  uncachedInput: number | null;
  failureClass: string | null;
  triggerReason: string | null;
  providerStop: string | null;
  servingModel: string | null;
  expenseCertainty: string | null;
  costStatus: string | null;
  amount: number | null;
  featureLatencyMs: number | null;
  inputTokenEstimate: number | null;
  inputSize: number | null;
  complexity: string | null;
  messageCount: number | null;
  taskCategory: string | null;
  selectedDeployment: string | null;
};

function cell(cols: string[], index: number): string {
  return cols[index]?.trim() ?? '';
}

function num(value: string): number | null {
  if (value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: string): string | null {
  return value.length === 0 ? null : value;
}

export function enrichSql(tenantId: string, ids: readonly string[]): string | null {
  if (!TENANT_UUID.test(tenantId)) return null;
  const safe = ids.filter((id) => TENANT_UUID.test(id));
  if (safe.length === 0) return null;
  const list = safe.map((id) => `'${id}'`).join(',');
  const select = [
    'a.request_id::text',
    'a.attempt_ordinal::text',
    'a.status',
    'a.upstream_model',
    'a.duration_ms::text',
    'a.first_text_delta_ms::text',
    'a.stream_status',
    'a.chunk_count::text',
    'a.bytes_written::text',
    'a.prompt_tokens::text',
    'a.completion_tokens::text',
    'a.total_tokens::text',
    'a.thoughts_tokens::text',
    'a.cache_read_input_tokens::text',
    'a.cache_creation_input_tokens::text',
    'a.uncached_input_tokens::text',
    'a.failure_class',
    'a.error_code',
    'a.trigger_reason',
    'a.stop_reason',
    'a.serving_model',
    'a.expense_certainty',
    'c.cost_status',
    'c.amount::text',
    'f.latency_ms::text',
    'f.input_token_estimate::text',
    'f.input_size::text',
    'f.complexity_estimate',
    'f.stream_requested::text',
    'f.message_count::text',
    'f.task_category',
    'f.selected_deployment',
  ].join(', ');
  return `SELECT ${select} FROM model_attempts a LEFT JOIN attempt_costs c ON c.tenant_id = a.tenant_id AND c.attempt_id = a.id LEFT JOIN request_features f ON f.tenant_id = a.tenant_id AND f.request_id = a.request_id WHERE a.tenant_id = '${tenantId}'::uuid AND a.request_id::text IN (${list}) ORDER BY a.request_id::text, a.attempt_ordinal`;
}

function parseRow(line: string): RawRow | null {
  const cols = line.split('|');
  if (cols.length < COLUMNS.length) return null;
  const requestId = cell(cols, 0);
  if (!TENANT_UUID.test(requestId)) return null;
  // Indices follow COLUMNS. error_code (17) and stream_requested (28) keep select width only.
  return {
    requestId,
    ordinal: num(cell(cols, 1)),
    status: cell(cols, 2),
    upstreamModel: text(cell(cols, 3)),
    durationMs: num(cell(cols, 4)),
    ttftMs: num(cell(cols, 5)),
    streamStatus: text(cell(cols, 6)),
    chunks: num(cell(cols, 7)),
    bytes: num(cell(cols, 8)),
    prompt: num(cell(cols, 9)),
    completion: num(cell(cols, 10)),
    total: num(cell(cols, 11)),
    thoughts: num(cell(cols, 12)),
    cacheRead: num(cell(cols, 13)),
    cacheWrite: num(cell(cols, 14)),
    uncachedInput: num(cell(cols, 15)),
    failureClass: text(cell(cols, 16)),
    triggerReason: text(cell(cols, 18)),
    providerStop: text(cell(cols, 19)),
    servingModel: text(cell(cols, 20)),
    expenseCertainty: text(cell(cols, 21)),
    costStatus: text(cell(cols, 22)),
    amount: num(cell(cols, 23)),
    featureLatencyMs: num(cell(cols, 24)),
    inputTokenEstimate: num(cell(cols, 25)),
    inputSize: num(cell(cols, 26)),
    complexity: text(cell(cols, 27)),
    messageCount: num(cell(cols, 29)),
    taskCategory: text(cell(cols, 30)),
    selectedDeployment: text(cell(cols, 31)),
  };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

export function foldRows(rows: readonly RawRow[]): ServerPatch | null {
  if (rows.length === 0) return null;
  const succeeded = rows.find((row) => row.status === 'succeeded') ?? rows[rows.length - 1]!;
  const highestOrdinal = rows.reduce(
    (max, row) => (row.ordinal !== null && row.ordinal > max ? row.ordinal : max),
    0,
  );
  return {
    storedAmount: sumKnown(rows.map((row) => row.amount)),
    prompt: succeeded.prompt,
    completion: succeeded.completion,
    total: succeeded.total,
    thoughts: succeeded.thoughts,
    serverDurationMs: sumKnown(rows.map((row) => row.durationMs)),
    serverTtftMs: succeeded.ttftMs,
    streamStatus: succeeded.streamStatus,
    serverChunks: succeeded.chunks,
    serverBytes: succeeded.bytes,
    cacheRead: succeeded.cacheRead,
    cacheWrite: succeeded.cacheWrite,
    uncachedInput: succeeded.uncachedInput,
    upstreamModel: succeeded.upstreamModel,
    servingModel: succeeded.servingModel,
    failureClass: rows.find((row) => row.failureClass !== null)?.failureClass ?? null,
    providerStop: succeeded.providerStop,
    triggerReason: rows.find((row) => row.triggerReason !== null)?.triggerReason ?? null,
    expenseCertainty: succeeded.expenseCertainty,
    storedCostStatus: succeeded.costStatus,
    attemptOrdinal: highestOrdinal || null,
    featureLatencyMs: succeeded.featureLatencyMs,
    inputTokenEstimate: succeeded.inputTokenEstimate,
    inputSize: succeeded.inputSize,
    complexity: succeeded.complexity,
    messageCount: succeeded.messageCount,
    taskCategory: succeeded.taskCategory,
    selectedDeployment: succeeded.selectedDeployment,
    fallback: rows.length > 1 || rows.some((row) => row.triggerReason !== null && row.triggerReason !== 'primary'),
  };
}

export function parseEnrich(raw: string): Map<string, ServerPatch> {
  const grouped = new Map<string, RawRow[]>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const row = parseRow(trimmed);
    if (row === null) continue;
    const list = grouped.get(row.requestId) ?? [];
    list.push(row);
    grouped.set(row.requestId, list);
  }
  const out = new Map<string, ServerPatch>();
  for (const [requestId, rows] of grouped) {
    const patch = foldRows(rows);
    if (patch !== null) out.set(requestId, patch);
  }
  return out;
}

export { COLUMNS };
