#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import {
  DEFAULT_CAPS,
  RESERVE,
  SpendLedger,
  deriveThoughts,
  JUDGE_OUTPUT_TOKENS,
  nearestRank,
  priceCall,
  rejectMaxUsd,
  reserveFor,
  scaleCeilings,
  smokeCeilings,
  type CeilingSet,
  type PerfModel,
  type ReserveModel,
  type StopReason,
} from './money.js';
import {
  QUALITY_ITEMS,
  agreePair,
  buildJudgeMessages,
  learningCurve,
  objectivePass,
  parseJudgeResponse,
  JUDGE_CRITERIA,
} from './quality.js';
import { lineChart, barChart } from './svg.js';
import { analyzeAttempts, compareHistory, renderAnalysis, type Analysis } from './analyze.js';
import { enrichSql, parseEnrich, type ServerPatch } from './telemetry.js';

const LOAD_TEXT = 'Reply with the word ready.';
const LOAD_MAX_TOKENS = 16;
const JUDGE_MAX_TOKENS = JUDGE_OUTPUT_TOKENS;
const UNARY_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 90_000;

type Profile = 'smoke' | 'scale';
type CallKind = 'load' | 'quality' | 'judge';

type PlannedCall = {
  kind: CallKind;
  model: ReserveModel;
  stream: boolean;
  maxTokens: number;
  task: string;
  content: string;
  system?: string;
  itemId: string | null;
  concurrency: number;
  judgeMeta?: { order: 'forward' | 'reverse'; itemId: string };
};

type AttemptRecord = {
  kind: CallKind;
  model: string;
  stream: boolean;
  http: number | null;
  requestId: string | null;
  deployment: string | null;
  attemptCount: number | null;
  fallback: boolean | null;
  wallMs: number | null;
  ttftMs: number | null;
  events: number | null;
  done: boolean | null;
  bytes: number | null;
  contentLen: number | null;
  error: string | null;
  usage: { prompt: number | null; completion: number | null; total: number | null };
  thoughts: number | null;
  costStatus: 'estimated' | 'unknown' | null;
  amount: number | null;
  storedAmount: number | null;
  itemId: string | null;
  objectivePass: boolean | null;
  concurrency: number;
  stopReason: StopReason | null;
  finishedAt?: string;
  judgeVote?: string | null;
  judgeOrder?: 'forward' | 'reverse' | null;
  serverDurationMs?: number | null;
  serverTtftMs?: number | null;
  streamStatus?: string | null;
  serverChunks?: number | null;
  serverBytes?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  uncachedInput?: number | null;
  upstreamModel?: string | null;
  servingModel?: string | null;
  failureClass?: string | null;
  providerStop?: string | null;
  triggerReason?: string | null;
  expenseCertainty?: string | null;
  storedCostStatus?: string | null;
  featureLatencyMs?: number | null;
  inputTokenEstimate?: number | null;
  inputSize?: number | null;
  complexity?: string | null;
  messageCount?: number | null;
  taskCategory?: string | null;
  selectedDeployment?: string | null;
};

type TenantAuth = { tenantId: string; secret: string };

type RunStop = StopReason | 'named_drift' | 'alias_unstable' | 'failures';

type CliOptions = {
  profile: Profile;
  maxUsd: number;
  acceptSpend: boolean;
  models: PerfModel[];
  baseUrl: string;
  outDir: string;
  tenantFile: string;
  skipLive: boolean;
  analyzeOnly: boolean;
};

function utcStamp(date = new Date()): string {
  return date.toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
}

function parseModels(raw: string | undefined): PerfModel[] {
  const list = (raw ?? 'openai,anthropic,xai')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set(['openai', 'anthropic', 'xai']);
  const out: PerfModel[] = [];
  for (const name of list) {
    if (!allowed.has(name)) throw new Error(`unknown model ${name}`);
    if (!out.includes(name as PerfModel)) out.push(name as PerfModel);
  }
  if (out.length === 0) throw new Error('models list is empty');
  return out;
}

function parseOptions(argv: string[]): CliOptions | { exitCode: 2; message: string } {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: 'string', default: 'smoke' },
      'max-usd': { type: 'string' },
      'i-accept-spend': { type: 'boolean', default: false },
      models: { type: 'string' },
      'base-url': { type: 'string', default: 'http://127.0.0.1:8080' },
      out: { type: 'string' },
      'tenant-file': { type: 'string', default: 'config/local-tenant.json' },
      'skip-live': { type: 'boolean', default: false },
      'analyze-only': { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const profileRaw = values.profile ?? 'smoke';
  if (profileRaw !== 'smoke' && profileRaw !== 'scale') {
    return { exitCode: 2, message: 'profile must be smoke or scale' };
  }
  const profile = profileRaw;
  const acceptSpend = values['i-accept-spend'] === true;
  let maxUsd: number = DEFAULT_CAPS[profile];
  if (values['max-usd'] !== undefined) {
    const parsed = Number(values['max-usd']);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { exitCode: 2, message: 'max-usd must be a non-negative number' };
    }
    maxUsd = parsed;
  }
  if (rejectMaxUsd(maxUsd, acceptSpend)) {
    return { exitCode: 2, message: 'max-usd above 2 needs --i-accept-spend' };
  }

  let models: PerfModel[];
  try {
    models = parseModels(values.models);
  } catch (error) {
    return { exitCode: 2, message: error instanceof Error ? error.message : 'invalid models' };
  }

  if (values['analyze-only'] === true && values.out === undefined) {
    return { exitCode: 2, message: 'analyze-only needs --out' };
  }

  return {
    profile,
    maxUsd,
    acceptSpend,
    models,
    baseUrl: values['base-url'] ?? 'http://127.0.0.1:8080',
    outDir: values.out ?? join('perf', 'runs', utcStamp()),
    tenantFile: values['tenant-file'] ?? 'config/local-tenant.json',
    skipLive: values['skip-live'] === true,
    analyzeOnly: values['analyze-only'] === true,
  };
}

function ceilingsFor(profile: Profile): CeilingSet {
  return profile === 'smoke' ? smokeCeilings() : scaleCeilings();
}

export function buildPlan(profile: Profile, models: PerfModel[]): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (profile === 'smoke') {
    for (const model of models) {
      calls.push({
        kind: 'load',
        model,
        stream: false,
        maxTokens: LOAD_MAX_TOKENS,
        task: 'general_qa',
        content: LOAD_TEXT,
        itemId: null,
        concurrency: 1,
      });
      calls.push({
        kind: 'load',
        model,
        stream: true,
        maxTokens: LOAD_MAX_TOKENS,
        task: 'general_qa',
        content: LOAD_TEXT,
        itemId: null,
        concurrency: 1,
      });
    }
    calls.push({
      kind: 'load',
      model: 'auto',
      stream: false,
      maxTokens: LOAD_MAX_TOKENS,
      task: 'general_qa',
      content: LOAD_TEXT,
      itemId: null,
      concurrency: 1,
    });
    const item = QUALITY_ITEMS.find((entry) => entry.id === 'json-ok');
    if (item !== undefined) {
      for (const model of models) {
        if (model === 'openai') continue;
        calls.push({
          kind: 'quality',
          model,
          stream: false,
          maxTokens: item.max_tokens,
          task: 'general_qa',
          content: item.task,
          itemId: item.id,
          concurrency: 1,
        });
      }
      if (models.includes('anthropic') && models.includes('xai')) {
        calls.push({
          kind: 'judge',
          model: 'openai',
          stream: false,
          maxTokens: JUDGE_MAX_TOKENS,
          task: 'general_qa',
          content: '',
          itemId: item.id,
          concurrency: 1,
          judgeMeta: { order: 'forward', itemId: item.id },
        });
        calls.push({
          kind: 'judge',
          model: 'openai',
          stream: false,
          maxTokens: JUDGE_MAX_TOKENS,
          task: 'general_qa',
          content: '',
          itemId: item.id,
          concurrency: 1,
          judgeMeta: { order: 'reverse', itemId: item.id },
        });
      }
    }
    return calls;
  }

  const steps = [1, 4, 8];
  for (const model of models) {
    if (model === 'xai') {
      for (let i = 0; i < 4; i++) {
        calls.push({
          kind: 'load',
          model,
          stream: false,
          maxTokens: LOAD_MAX_TOKENS,
          task: 'general_qa',
          content: LOAD_TEXT,
          itemId: null,
          concurrency: 1,
        });
      }
      calls.push({
        kind: 'load',
        model,
        stream: true,
        maxTokens: LOAD_MAX_TOKENS,
        task: 'general_qa',
        content: LOAD_TEXT,
        itemId: null,
        concurrency: 1,
      });
      continue;
    }
    for (const step of steps) {
      for (let i = 0; i < 8; i++) {
        calls.push({
          kind: 'load',
          model,
          stream: i < 2,
          maxTokens: LOAD_MAX_TOKENS,
          task: 'general_qa',
          content: LOAD_TEXT,
          itemId: null,
          concurrency: step,
        });
      }
    }
  }
  for (const step of steps) {
    calls.push({
      kind: 'load',
      model: 'auto',
      stream: false,
      maxTokens: LOAD_MAX_TOKENS,
      task: 'general_qa',
      content: LOAD_TEXT,
      itemId: null,
      concurrency: step,
    });
  }
  for (const item of QUALITY_ITEMS) {
    for (const model of models) {
      if (model === 'openai') continue;
      calls.push({
        kind: 'quality',
        model,
        stream: false,
        maxTokens: item.max_tokens,
        task: 'general_qa',
        content: item.task,
        itemId: item.id,
        concurrency: 1,
      });
    }
  }
  for (const item of QUALITY_ITEMS) {
    if (!models.includes('anthropic') || !models.includes('xai')) continue;
    calls.push({
      kind: 'judge',
      model: 'openai',
      stream: false,
      maxTokens: JUDGE_MAX_TOKENS,
      task: 'general_qa',
      content: '',
      itemId: item.id,
      concurrency: 1,
      judgeMeta: { order: 'forward', itemId: item.id },
    });
    calls.push({
      kind: 'judge',
      model: 'openai',
      stream: false,
      maxTokens: JUDGE_MAX_TOKENS,
      task: 'general_qa',
      content: '',
      itemId: item.id,
      concurrency: 1,
      judgeMeta: { order: 'reverse', itemId: item.id },
    });
  }
  return calls;
}

export type CapturePolicy = {
  streamingCapture: boolean;
};

// Always stream when streaming capture is off. A unary chat stores a sample, and a full cap evicts one.
export function applySampleGuard(
  plan: PlannedCall[],
  policy: CapturePolicy,
): { calls: PlannedCall[]; safe: boolean; reason: 'streaming_capture' | null } {
  if (policy.streamingCapture) {
    return { calls: plan, safe: false, reason: 'streaming_capture' };
  }
  return {
    calls: plan.map((call) => (call.stream ? call : { ...call, stream: true })),
    safe: true,
    reason: null,
  };
}

async function loadTenant(path: string): Promise<TenantAuth> {
  const raw = await readFile(path, 'utf8');
  let parsed: { tenantId?: unknown; secret?: unknown };
  try {
    parsed = JSON.parse(raw) as { tenantId?: unknown; secret?: unknown };
  } catch {
    throw new Error('tenant file is not valid JSON');
  }
  if (typeof parsed.tenantId !== 'string' || typeof parsed.secret !== 'string') {
    throw new Error('tenant file must include tenantId and secret');
  }
  return { tenantId: parsed.tenantId, secret: parsed.secret };
}

function authHeaders(tenant: TenantAuth): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
  };
}

async function listModels(baseUrl: string, tenant: TenantAuth): Promise<Set<string>> {
  const response = await fetch(new URL('/v1/models', baseUrl), {
    method: 'GET',
    headers: authHeaders(tenant),
    signal: AbortSignal.timeout(UNARY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models list HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = new Set<string>();
  for (const entry of body.data ?? []) {
    if (typeof entry.id === 'string') ids.add(entry.id);
  }
  return ids;
}

function extractContent(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const message = (first as { message?: unknown }).message;
  if (typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function readUsage(body: unknown): { prompt: number | null; completion: number | null; total: number | null } {
  if (typeof body !== 'object' || body === null) {
    return { prompt: null, completion: null, total: null };
  }
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return { prompt: null, completion: null, total: null };
  }
  const record = usage as Record<string, unknown>;
  const prompt = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : null;
  const completion = typeof record.completion_tokens === 'number' ? record.completion_tokens : null;
  const total = typeof record.total_tokens === 'number' ? record.total_tokens : null;
  return { prompt, completion, total };
}

type CallResult = {
  attempt: AttemptRecord;
  completion: string | null;
  judgeWinner: string | null;
};

async function callUnary(
  baseUrl: string,
  tenant: TenantAuth,
  planned: PlannedCall,
  messages: Array<{ role: string; content: string }>,
): Promise<CallResult> {
  const started = performance.now();
  const body: Record<string, unknown> = {
    model: planned.model,
    messages,
    max_tokens: planned.maxTokens,
    task: planned.task,
  };
  try {
    const response = await fetch(new URL('/v1/chat/completions', baseUrl), {
      method: 'POST',
      headers: authHeaders(tenant),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UNARY_TIMEOUT_MS),
    });
    const wallMs = performance.now() - started;
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const usage = readUsage(parsed);
    const completion = response.ok ? extractContent(parsed) : null;
    const deployment = response.headers.get('x-deployment');
    const thoughts = deriveThoughts(usage.prompt, usage.completion, usage.total, null);
    const amount = response.ok
      ? priceCall(
          planned.kind === 'judge' ? 'judge' : planned.model,
          deployment,
          usage.prompt,
          usage.completion,
          usage.total,
          thoughts,
        )
      : null;
    const costStatus = amount === null ? 'unknown' : 'estimated';
    return {
      completion,
      judgeWinner: null,
      attempt: {
        kind: planned.kind,
        model: planned.model,
        stream: false,
        http: response.status,
        requestId: response.headers.get('x-request-id'),
        deployment,
        attemptCount: Number(response.headers.get('x-attempt-count') ?? '') || null,
        fallback: response.headers.get('x-fallback') === 'true',
        wallMs,
        ttftMs: null,
        events: null,
        done: null,
        bytes: Buffer.byteLength(text),
        contentLen: completion === null ? null : [...completion].length,
        error: response.ok ? null : `http_${response.status}`,
        usage,
        thoughts,
        costStatus: response.ok ? costStatus : null,
        amount: response.ok ? amount : null,
        storedAmount: null,
        itemId: planned.itemId,
        objectivePass: null,
        concurrency: planned.concurrency,
        stopReason: null,
      },
    };
  } catch (error) {
    const wallMs = performance.now() - started;
    return {
      completion: null,
      judgeWinner: null,
      attempt: {
        kind: planned.kind,
        model: planned.model,
        stream: false,
        http: null,
        requestId: null,
        deployment: null,
        attemptCount: null,
        fallback: null,
        wallMs,
        ttftMs: null,
        events: null,
        done: null,
        bytes: null,
        contentLen: null,
        error: error instanceof Error ? error.message : 'request_failed',
        usage: { prompt: null, completion: null, total: null },
        thoughts: null,
        costStatus: null,
        amount: null,
        storedAmount: null,
        itemId: planned.itemId,
        objectivePass: null,
        concurrency: planned.concurrency,
        stopReason: null,
      },
    };
  }
}

async function callStream(
  baseUrl: string,
  tenant: TenantAuth,
  planned: PlannedCall,
  messages: Array<{ role: string; content: string }>,
): Promise<CallResult> {
  const started = performance.now();
  const body = {
    model: planned.model,
    messages,
    max_tokens: planned.maxTokens,
    task: planned.task,
    stream: true,
    stream_options: { include_usage: true },
  };
  try {
    const response = await fetch(new URL('/v1/chat/completions', baseUrl), {
      method: 'POST',
      headers: authHeaders(tenant),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) {
      const wallMs = performance.now() - started;
      const errText = await response.text().catch(() => '');
      return {
        completion: null,
        judgeWinner: null,
        attempt: {
          kind: planned.kind,
          model: planned.model,
          stream: true,
          http: response.status,
          requestId: response.headers.get('x-request-id'),
          deployment: response.headers.get('x-deployment'),
          attemptCount: Number(response.headers.get('x-attempt-count') ?? '') || null,
          fallback: response.headers.get('x-fallback') === 'true',
          wallMs,
          ttftMs: null,
          events: 0,
          done: false,
          bytes: Buffer.byteLength(errText),
          contentLen: null,
          error: `http_${response.status}`,
          usage: { prompt: null, completion: null, total: null },
          thoughts: null,
          costStatus: null,
          amount: null,
          storedAmount: null,
          itemId: planned.itemId,
          objectivePass: null,
          concurrency: planned.concurrency,
          stopReason: null,
        },
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let events = 0;
    let done = false;
    let bytes = 0;
    let ttftMs: number | null = null;
    let usage = { prompt: null as number | null, completion: null as number | null, total: null as number | null };
    let content = '';

    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trimStart();
        if (payload === '[DONE]') {
          done = true;
          continue;
        }
        events += 1;
        if (ttftMs === null) ttftMs = performance.now() - started;
        try {
          const chunk = JSON.parse(payload) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            choices?: Array<{ delta?: { content?: string } }>;
          };
          if (chunk.usage) {
            usage = {
              prompt: typeof chunk.usage.prompt_tokens === 'number' ? chunk.usage.prompt_tokens : usage.prompt,
              completion:
                typeof chunk.usage.completion_tokens === 'number' ? chunk.usage.completion_tokens : usage.completion,
              total: typeof chunk.usage.total_tokens === 'number' ? chunk.usage.total_tokens : usage.total,
            };
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') content += delta;
        } catch {
          // ignore malformed SSE payloads
        }
      }
    }

    const wallMs = performance.now() - started;
    const error = response.status === 200 && !done ? 'missing_done' : null;
    const deployment = response.headers.get('x-deployment');
    const thoughts = deriveThoughts(usage.prompt, usage.completion, usage.total, null);
    const amount =
      error === null
        ? priceCall(
            planned.kind === 'judge' ? 'judge' : planned.model,
            deployment,
            usage.prompt,
            usage.completion,
            usage.total,
            thoughts,
          )
        : null;
    const costStatus = amount === null ? 'unknown' : 'estimated';
    return {
      completion: content,
      judgeWinner: null,
      attempt: {
        kind: planned.kind,
        model: planned.model,
        stream: true,
        http: response.status,
        requestId: response.headers.get('x-request-id'),
        deployment,
        attemptCount: Number(response.headers.get('x-attempt-count') ?? '') || null,
        fallback: response.headers.get('x-fallback') === 'true',
        wallMs,
        ttftMs,
        events,
        done,
        bytes,
        contentLen: [...content].length,
        error,
        usage,
        thoughts,
        costStatus: error === null ? costStatus : null,
        amount,
        storedAmount: null,
        itemId: planned.itemId,
        objectivePass: null,
        concurrency: planned.concurrency,
        stopReason: null,
      },
    };
  } catch (error) {
    return {
      completion: null,
      judgeWinner: null,
      attempt: {
        kind: planned.kind,
        model: planned.model,
        stream: true,
        http: null,
        requestId: null,
        deployment: null,
        attemptCount: null,
        fallback: null,
        wallMs: performance.now() - started,
        ttftMs: null,
        events: null,
        done: false,
        bytes: null,
        contentLen: null,
        error: error instanceof Error ? error.message : 'stream_failed',
        usage: { prompt: null, completion: null, total: null },
        thoughts: null,
        costStatus: null,
        amount: null,
        storedAmount: null,
        itemId: planned.itemId,
        objectivePass: null,
        concurrency: planned.concurrency,
        stopReason: null,
      },
    };
  }
}

function runDockerSql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = join(homedir(), '.colima', 'default', 'docker.sock');
    const child = spawn(
      'docker',
      ['compose', '--env-file', 'config/docker.env', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'llm_proxy', '-A', '-t', '-c', sql],
      {
        env: { ...process.env, DOCKER_HOST: `unix://${sock}` },
        cwd: process.cwd(),
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `psql exit ${code}`));
    });
  });
}

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readOpenSamples(
  baseUrl: string,
  tenant: TenantAuth,
): Promise<{ retained: number; cap: number } | null> {
  try {
    const response = await fetch(new URL('/internal/v1/samples/stats', baseUrl), {
      method: 'GET',
      headers: authHeaders(tenant),
      signal: AbortSignal.timeout(UNARY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { retained?: unknown; cap?: unknown };
    if (!Number.isInteger(body.retained) || !Number.isInteger(body.cap)) return null;
    return { retained: body.retained as number, cap: body.cap as number };
  } catch {
    return null;
  }
}

async function readStreamingCapture(tenantId: string): Promise<boolean | null> {
  if (!TENANT_UUID.test(tenantId)) return null;
  const sql = `SELECT streaming_capture::text FROM sample_policies WHERE tenant_id = '${tenantId}'::uuid ORDER BY policy_version DESC LIMIT 1`;
  try {
    const raw = (await runDockerSql(sql)).trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function applyPatch(attempt: AttemptRecord, patch: ServerPatch): void {
  if (patch.storedAmount !== null) attempt.storedAmount = patch.storedAmount;
  if (patch.prompt !== null) attempt.usage.prompt = patch.prompt;
  if (patch.completion !== null) attempt.usage.completion = patch.completion;
  if (patch.total !== null) attempt.usage.total = patch.total;
  if (patch.thoughts !== null) attempt.thoughts = patch.thoughts;
  if (patch.attemptOrdinal !== null) attempt.attemptCount = patch.attemptOrdinal;
  attempt.fallback = patch.fallback;
  attempt.serverDurationMs = patch.serverDurationMs;
  attempt.serverTtftMs = patch.serverTtftMs;
  attempt.streamStatus = patch.streamStatus;
  attempt.serverChunks = patch.serverChunks;
  attempt.serverBytes = patch.serverBytes;
  attempt.cacheRead = patch.cacheRead;
  attempt.cacheWrite = patch.cacheWrite;
  attempt.uncachedInput = patch.uncachedInput;
  attempt.upstreamModel = patch.upstreamModel;
  attempt.servingModel = patch.servingModel;
  attempt.failureClass = patch.failureClass;
  attempt.providerStop = patch.providerStop;
  attempt.triggerReason = patch.triggerReason;
  attempt.expenseCertainty = patch.expenseCertainty;
  attempt.storedCostStatus = patch.storedCostStatus;
  attempt.featureLatencyMs = patch.featureLatencyMs;
  attempt.inputTokenEstimate = patch.inputTokenEstimate;
  attempt.inputSize = patch.inputSize;
  attempt.complexity = patch.complexity;
  attempt.messageCount = patch.messageCount;
  attempt.taskCategory = patch.taskCategory;
  attempt.selectedDeployment = patch.selectedDeployment;
}

async function enrichAttempts(attempts: AttemptRecord[], tenantId: string): Promise<'ok' | 'skipped'> {
  const ids = attempts
    .map((row) => row.requestId)
    .filter((id): id is string => typeof id === 'string');
  const sql = enrichSql(tenantId, ids);
  if (sql === null) return 'skipped';
  try {
    const parsed = parseEnrich(await runDockerSql(sql));
    for (const attempt of attempts) {
      if (attempt.requestId === null) continue;
      const patch = parsed.get(attempt.requestId);
      if (patch === undefined) continue;
      applyPatch(attempt, patch);
    }
    return 'ok';
  } catch {
    return 'skipped';
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function usd(value: number): string {
  return value.toFixed(8);
}

function ms(value: number | null): string {
  return value === null ? 'not available' : value.toFixed(3);
}

function stopSentence(model: string, reason: RunStop): string {
  if (reason === 'cap') return `Stopped ${model}: the spend cap was reached.`;
  if (reason === 'ceiling') return `Stopped ${model}: the call limit was reached.`;
  if (reason === 'failures') return `Stopped ${model}: five calls in a row failed.`;
  if (reason === 'alias_unstable') return `Stopped ${model}: the alias did not stay on one deployment.`;
  return `Stopped ${model}: the named model ran on a different deployment.`;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return nearestRank(sorted, p);
}

function writeReport(input: {
  profile: Profile;
  cap: number;
  attempts: AttemptRecord[];
  stopReasons: Partial<Record<string, RunStop>>;
  skippedModels: string[];
  learning: ReturnType<typeof learningCurve>;
  spend: number;
  estimatedSpend: number;
  dbEnrichment: 'ok' | 'skipped';
  samplesBefore: number;
  samplesAfter: number | null;
}): string {
  const lines: string[] = [];
  lines.push('# Performance rig report');
  lines.push('');
  lines.push(`Profile: ${input.profile}.`);
  lines.push(`Cap: ${input.cap} USD.`);
  lines.push(`Tool estimate: ${usd(input.estimatedSpend)} USD.`);
  lines.push(`Proxy cost, or that estimate when the proxy stored no cost: ${usd(input.spend)} USD.`);
  lines.push(
    input.dbEnrichment === 'ok'
      ? 'The report uses cost and token counts stored by the proxy.'
      : 'The report does not use cost and token counts stored by the proxy.',
  );
  lines.push('Each live call is a stream, so a full sample store is not replaced. Streaming capture is off.');
  lines.push(`Stored samples before the run: ${input.samplesBefore}.`);
  lines.push(
    `Stored samples after the run: ${input.samplesAfter === null ? 'not available' : input.samplesAfter}.`,
  );
  if (input.skippedModels.length > 0) {
    lines.push(`Skipped models: ${input.skippedModels.join(', ')}. The proxy did not offer these models.`);
  }
  const stops = Object.entries(input.stopReasons);
  if (stops.length > 0) {
    for (const [model, reason] of stops) {
      if (reason === undefined) continue;
      lines.push(stopSentence(model, reason));
    }
  } else {
    lines.push('The run did not stop a model early.');
  }
  lines.push(`Attempt count: ${input.attempts.length}.`);
  const walls = input.attempts.map((row) => row.wallMs).filter((value): value is number => value !== null);
  const ttfts = input.attempts.map((row) => row.ttftMs).filter((value): value is number => value !== null);
  lines.push(`Median time to finish (ms): ${ms(percentile(walls, 50))}.`);
  lines.push(`95th percentile time to finish (ms): ${ms(percentile(walls, 95))}.`);
  lines.push(`Median time to first text (ms): ${ms(percentile(ttfts, 50))}.`);
  lines.push(`95th percentile time to first text (ms): ${ms(percentile(ttfts, 95))}.`);
  const errors = input.attempts.filter((row) => row.error !== null).length;
  const errorRate = input.attempts.length === 0 ? 0 : errors / input.attempts.length;
  lines.push(`Share of calls that failed: ${errorRate}. A value of 1 means every call failed.`);
  lines.push('');
  lines.push('## Answer checks');
  lines.push('');
  lines.push('| Checks included | Share of checks passed | Share of pairs with the same winner both times |');
  lines.push('| --- | --- | --- |');
  for (const point of input.learning) {
    lines.push(`| ${point.index} | ${point.passRate} | ${point.winRate} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeSvgIfPoints(path: string, title: string, xLabel: string, yLabel: string, series: Parameters<typeof lineChart>[0]['series']): Promise<void> {
  if (!series.some((entry) => entry.points.length > 0)) return;
  await writeFile(path, lineChart({ title, xLabel, yLabel, series }), 'utf8');
}

const MODEL_COLORS: Record<string, string> = {
  openai: '#1f77b4',
  anthropic: '#ff7f0e',
  xai: '#2ca02c',
  auto: '#9467bd',
};

type HistoryEntry = {
  at: string;
  dir: string;
  profile: string;
  phase: 'live' | 'analysis';
  attempts: number;
  failures: number;
  errorRate: number;
  spend: number;
  wallP50: number | null;
  ttftP50: number | null;
  samplesBefore: number | null;
  samplesAfter: number | null;
};

async function catalogRun(entry: HistoryEntry): Promise<string[]> {
  const indexPath = join('perf', 'runs', 'index.jsonl');
  await mkdir(join('perf', 'runs'), { recursive: true });
  let prior = '';
  try {
    prior = await readFile(indexPath, 'utf8');
  } catch {
    prior = '';
  }
  const rows: HistoryEntry[] = [];
  for (const line of prior.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as HistoryEntry);
    } catch {
      continue;
    }
  }
  const stored: HistoryEntry = { ...entry, dir: resolve(entry.dir) };
  const previous = [...rows].reverse().find((row) => row.profile === stored.profile && resolve(row.dir) !== stored.dir) ?? null;
  await appendFile(indexPath, `${JSON.stringify(stored)}\n`, 'utf8');
  const history = ['# Performance rig catalog', ''];
  for (const row of [...rows, stored]) {
    const median = row.wallP50 === null ? 'not available' : row.wallP50.toFixed(3);
    history.push(`Profile ${row.profile}. Directory ${row.dir}.`);
    history.push(`Calls ${row.attempts}. The share of failed calls was ${row.errorRate.toFixed(4)}. Cost was ${row.spend.toFixed(8)} USD. Median time to finish was ${median} ms.`);
    history.push('');
  }
  await writeAtomic(join('perf', 'runs', 'history.md'), `${history.join('\n')}\n`);
  return compareHistory(previous, { wallP50: entry.wallP50, spend: entry.spend, errorRate: entry.errorRate });
}

async function writeInsightPlots(outDir: string, analysis: Analysis): Promise<void> {
  const costBars = analysis.models
    .filter((model) => model.cost > 0)
    .map((model) => ({ name: model.model, value: model.cost, color: MODEL_COLORS[model.model] ?? '#333' }));
  if (costBars.length > 0) {
    await writeFile(
      join(outDir, 'cost-by-model.svg'),
      barChart({ title: 'Cost by model', yLabel: 'USD', bars: costBars }),
      'utf8',
    );
  }
  const speedBars = analysis.models
    .filter((model) => model.outputPerSecond.p50 !== null)
    .map((model) => ({
      name: model.model,
      value: model.outputPerSecond.p50 ?? 0,
      color: MODEL_COLORS[model.model] ?? '#333',
    }));
  if (speedBars.length > 0) {
    await writeFile(
      join(outDir, 'tokens-per-second.svg'),
      barChart({ title: 'Median output tokens per second', yLabel: 'tokens per second', bars: speedBars }),
      'utf8',
    );
  }
  const passBars = analysis.models
    .filter((model) => model.objectiveChecks > 0)
    .map((model) => ({
      name: model.model,
      value: model.objectivePasses / model.objectiveChecks,
      color: MODEL_COLORS[model.model] ?? '#333',
    }));
  if (passBars.length > 0) {
    await writeFile(
      join(outDir, 'objective-pass.svg'),
      barChart({ title: 'Share of answer checks passed', yLabel: 'share', bars: passBars }),
      'utf8',
    );
  }
}

async function publishInsights(input: {
  outDir: string;
  profile: string;
  phase: 'live' | 'analysis';
  attempts: AttemptRecord[];
  waves: { model: string; concurrency: number; count: number; ms: number }[];
  samplesBefore: number | null;
  samplesAfter: number | null;
}): Promise<void> {
  const analysis = analyzeAttempts(input.attempts, input.waves);
  const walls = input.attempts.map((row) => row.wallMs).filter((value): value is number => typeof value === 'number');
  const ttfts = input.attempts.map((row) => row.ttftMs).filter((value): value is number => typeof value === 'number');
  const comparison = await catalogRun({
    at: new Date().toISOString(),
    dir: input.outDir,
    profile: input.profile,
    phase: input.phase,
    attempts: input.attempts.length,
    failures: analysis.failures,
    errorRate: input.attempts.length === 0 ? 0 : analysis.failures / input.attempts.length,
    spend: analysis.totalCost,
    wallP50: percentile(walls, 50),
    ttftP50: percentile(ttfts, 50),
    samplesBefore: input.samplesBefore,
    samplesAfter: input.samplesAfter,
  });
  await writeFile(join(input.outDir, 'stats.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  await writeFile(join(input.outDir, 'analysis.md'), renderAnalysis(analysis, comparison), 'utf8');
  await writeInsightPlots(input.outDir, analysis);
}

async function analyzeSaved(options: CliOptions): Promise<number> {
  let raw = '';
  try {
    raw = await readFile(join(options.outDir, 'attempts.jsonl'), 'utf8');
  } catch {
    process.stderr.write('attempts file was not read\n');
    return 1;
  }
  const attempts: AttemptRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      attempts.push(JSON.parse(line) as AttemptRecord);
    } catch {
      process.stderr.write('attempts file has a bad row\n');
      return 1;
    }
  }
  let tenant: TenantAuth;
  try {
    tenant = await loadTenant(options.tenantFile);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'tenant load failed'}\n`);
    return 1;
  }
  const before = attempts.map((row) => JSON.stringify(row)).join('\n');
  const enrichment = await enrichAttempts(attempts, tenant.tenantId);
  const after = attempts.map((row) => JSON.stringify(row)).join('\n');
  if (enrichment === 'ok' && after !== before) {
    await writeAtomic(
      join(options.outDir, 'attempts.jsonl'),
      `${after}${attempts.length > 0 ? '\n' : ''}`,
    );
  }
  const waves: { model: string; concurrency: number; count: number; ms: number }[] = [];
  try {
    const waveRaw = await readFile(join(options.outDir, 'waves.jsonl'), 'utf8');
    for (const line of waveRaw.split('\n')) {
      if (line.trim().length === 0) continue;
      waves.push(JSON.parse(line) as { model: string; concurrency: number; count: number; ms: number });
    }
  } catch {
    // Older runs have no wave file. The analysis says calls per second are not available.
  }
  let profile = options.profile;
  let samplesBefore: number | null = null;
  let samplesAfter: number | null = null;
  try {
    const summary = JSON.parse(await readFile(join(options.outDir, 'summary.json'), 'utf8')) as {
      profile?: string;
      samplesBefore?: number;
      samplesAfter?: number;
    };
    if (typeof summary.profile === 'string') profile = summary.profile as Profile;
    if (typeof summary.samplesBefore === 'number') samplesBefore = summary.samplesBefore;
    if (typeof summary.samplesAfter === 'number') samplesAfter = summary.samplesAfter;
  } catch {
    profile = options.profile;
  }
  await publishInsights({
    outDir: options.outDir,
    profile,
    phase: 'analysis',
    attempts,
    waves,
    samplesBefore,
    samplesAfter,
  });
  if (enrichment !== 'ok') {
    process.stderr.write('The time the provider recorded, the token estimates, and the cost could not be read.\n');
    return 1;
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseOptions(argv);
  if ('exitCode' in parsed) {
    process.stderr.write(`${parsed.message}\n`);
    return parsed.exitCode;
  }
  const options = parsed;
  if (options.analyzeOnly) return analyzeSaved(options);
  try {
    await readFile(join(options.outDir, 'attempts.jsonl'));
    process.stderr.write('This directory already has saved calls. Choose a new directory.\n');
    return 2;
  } catch (error) {
    const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
    if (!missing) {
      process.stderr.write('The saved calls could not be checked.\n');
      return 1;
    }
  }
  const ceilings = ceilingsFor(options.profile);
  const plan = buildPlan(options.profile, options.models);
  await mkdir(options.outDir, { recursive: true });
  const planCalls = (calls: PlannedCall[]) =>
    calls.map((call) => ({
      kind: call.kind,
      model: call.model,
      stream: call.stream,
      maxTokens: call.maxTokens,
      task: call.task,
      itemId: call.itemId,
      concurrency: call.concurrency,
      judgeMeta: call.judgeMeta ?? null,
    }));
  const planDoc = {
    profile: options.profile,
    maxUsd: options.maxUsd,
    models: options.models,
    ceilings,
    sampleGuard: 'When streaming capture is off, every live call is a stream.',
    calls: planCalls(plan),
  };
  await writeFile(join(options.outDir, 'plan.json'), `${JSON.stringify(planDoc, null, 2)}\n`, 'utf8');
  if (options.skipLive) return 0;

  let tenant: TenantAuth;
  try {
    tenant = await loadTenant(options.tenantFile);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'tenant load failed'}\n`);
    return 1;
  }

  let available: Set<string>;
  try {
    available = await listModels(options.baseUrl, tenant);
  } catch {
    process.stderr.write('base URL is unreachable\n');
    return 1;
  }

  const skippedModels: string[] = [];
  for (const model of options.models) {
    if (!available.has(model)) skippedModels.push(model);
  }

  const sampleBefore = await readOpenSamples(options.baseUrl, tenant);
  const streamingCapture = await readStreamingCapture(tenant.tenantId);
  if (sampleBefore === null || streamingCapture === null) {
    process.stderr.write('sample policy was not read\n');
    return 1;
  }
  const guarded = applySampleGuard(plan, { streamingCapture });
  if (!guarded.safe) {
    process.stderr.write('streaming capture is on\n');
    return 1;
  }
  const livePlan = guarded.calls;
  await writeFile(
    join(options.outDir, 'plan.json'),
    `${JSON.stringify({ ...planDoc, calls: planCalls(livePlan), samplesBefore: sampleBefore.retained }, null, 2)}\n`,
    'utf8',
  );

  const ledger = new SpendLedger(options.maxUsd, ceilings);
  const attempts: AttemptRecord[] = [];
  const waves: { model: string; concurrency: number; count: number; ms: number }[] = [];
  const stopReasons: Partial<Record<string, RunStop>> = {};
  const stopped = new Set<string>();
  const failureStreak = new Map<string, number>();
  let autoDeployment: string | null = null;
  const qualityCompletions = new Map<string, string>();
  const qualityPasses = new Map<string, boolean>();
  const judgeWinners: { itemId: string; order: 'forward' | 'reverse'; winner: string | null }[] = [];
  const attemptsPath = join(options.outDir, 'attempts.jsonl');
  let persistQueue: Promise<void> = Promise.resolve();
  const persistAttempt = (attempt: AttemptRecord): Promise<void> => {
    const line = `${JSON.stringify(attempt)}\n`;
    const run = persistQueue.then(() => appendFile(attemptsPath, line, 'utf8'));
    persistQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const runnable = livePlan.filter((call) => {
    if (call.kind === 'judge' && !available.has('openai')) {
      if (!skippedModels.includes('openai')) skippedModels.push('openai');
      return false;
    }
    if (call.model === 'auto') return available.has('auto');
    if (skippedModels.includes(call.model)) return false;
    return true;
  });

  async function executeOne(planned: PlannedCall): Promise<void> {
    const stopKey = planned.kind === 'judge' ? 'judge' : planned.model;
    if (stopped.has(stopKey) || stopped.has(planned.model)) {
      return;
    }
    if (planned.kind === 'judge' && planned.judgeMeta) {
      const itemId = planned.judgeMeta.itemId;
      if (!qualityCompletions.has(`anthropic:${itemId}`) || !qualityCompletions.has(`xai:${itemId}`)) {
        judgeWinners.push({ itemId, order: planned.judgeMeta.order, winner: null });
        return;
      }
    }
    const reserve = planned.kind === 'judge' ? RESERVE.judge : reserveFor(planned.model);
    const asJudge = planned.kind === 'judge';
    const reason = ledger.inspectReserve(planned.model, reserve, asJudge);
    if (reason !== 'ok') {
      stopReasons[stopKey] = reason;
      stopped.add(stopKey);
      if (planned.model !== stopKey) stopped.add(planned.model);
      return;
    }
    if (!ledger.tryReserve(planned.model, reserve, asJudge)) {
      stopReasons[stopKey] = 'cap';
      stopped.add(stopKey);
      return;
    }

    let result: CallResult;
    if (planned.kind === 'judge' && planned.judgeMeta) {
      const item = QUALITY_ITEMS.find((entry) => entry.id === planned.judgeMeta!.itemId);
      const anthropicText = qualityCompletions.get(`anthropic:${planned.judgeMeta.itemId}`) ?? '';
      const xaiText = qualityCompletions.get(`xai:${planned.judgeMeta.itemId}`) ?? '';
      const task = item?.task ?? '';
      const reference = item?.reference ?? '';
      const candidateX = planned.judgeMeta.order === 'forward' ? anthropicText : xaiText;
      const candidateY = planned.judgeMeta.order === 'forward' ? xaiText : anthropicText;
      const messages = buildJudgeMessages(task, reference, candidateX, candidateY);
      result = planned.stream
        ? await callStream(options.baseUrl, tenant, planned, messages)
        : await callUnary(options.baseUrl, tenant, planned, messages);
      if (result.completion !== null) {
        const parsed = parseJudgeResponse(result.completion, JUDGE_CRITERIA);
        result.judgeWinner = parsed.ok ? parsed.judgment.winner : null;
      }
      judgeWinners.push({
        itemId: planned.judgeMeta.itemId,
        order: planned.judgeMeta.order,
        winner: result.judgeWinner,
      });
    } else if (planned.stream) {
      result = await callStream(options.baseUrl, tenant, planned, [{ role: 'user', content: planned.content }]);
    } else {
      result = await callUnary(options.baseUrl, tenant, planned, [{ role: 'user', content: planned.content }]);
    }

    if (result.attempt.error !== null) {
      const streak = (failureStreak.get(planned.model) ?? 0) + 1;
      failureStreak.set(planned.model, streak);
      if (streak >= 5) {
        stopReasons[planned.model] = 'failures';
        stopped.add(planned.model);
      }
    } else {
      failureStreak.set(planned.model, 0);
      const deployment = result.attempt.deployment;
      if (planned.model === 'auto') {
        if (deployment !== null && autoDeployment !== null && deployment !== autoDeployment) {
          stopReasons.auto = 'alias_unstable';
          stopped.add('auto');
        } else if (deployment !== null && autoDeployment === null) {
          autoDeployment = deployment;
        }
      } else if (deployment !== null && deployment !== planned.model) {
        stopReasons[planned.model] = 'named_drift';
        stopped.add(planned.model);
      }
    }

    if (planned.kind === 'quality' && planned.itemId !== null) {
      const item = QUALITY_ITEMS.find((entry) => entry.id === planned.itemId);
      if (item !== undefined) {
        const pass = objectivePass(item, result.completion);
        result.attempt.objectivePass = pass;
        qualityPasses.set(`${planned.model}:${planned.itemId}`, pass);
        if (result.completion !== null) {
          qualityCompletions.set(`${planned.model}:${planned.itemId}`, result.completion);
        }
      }
    }

    ledger.settle(reserve, result.attempt.amount);
    result.attempt.finishedAt = new Date().toISOString();
    if (planned.kind === 'judge' && planned.judgeMeta) {
      result.attempt.judgeOrder = planned.judgeMeta.order;
      result.attempt.judgeVote = result.judgeWinner;
    }
    attempts.push(result.attempt);
    await persistAttempt(result.attempt);
  }

  let index = 0;
  while (index < runnable.length) {
    const current = runnable[index]!;
    if (current.kind === 'load') {
      const concurrency = current.concurrency;
      const model = current.model;
      const step: PlannedCall[] = [];
      while (
        index < runnable.length
        && runnable[index]!.kind === 'load'
        && runnable[index]!.concurrency === concurrency
        && runnable[index]!.model === model
      ) {
        step.push(runnable[index]!);
        index += 1;
      }
      for (let offset = 0; offset < step.length; offset += concurrency) {
        const wave = step.slice(offset, offset + concurrency);
        // One clock for the wave. Summing each request wall would count overlapping time more than once.
        const waveStarted = performance.now();
        const before = attempts.length;
        await Promise.all(wave.map((call) => executeOne(call)));
        const made = attempts.length - before;
        if (made > 0) {
          waves.push({ model, concurrency, count: made, ms: performance.now() - waveStarted });
        }
      }
      continue;
    }
    await executeOne(current);
    index += 1;
  }

  // Answer text is only needed while building judge prompts.
  qualityCompletions.clear();

  const dbEnrichment = await enrichAttempts(attempts, tenant.tenantId);
  const sampleAfter = await readOpenSamples(options.baseUrl, tenant);

  const passSeries: boolean[] = [];
  const winSeries: boolean[] = [];
  for (const item of QUALITY_ITEMS) {
    for (const model of ['anthropic', 'xai'] as const) {
      if (!options.models.includes(model)) continue;
      if (options.profile === 'smoke' && item.id !== 'json-ok') continue;
      passSeries.push(qualityPasses.get(`${model}:${item.id}`) === true);
    }
  }
  for (const item of QUALITY_ITEMS) {
    if (options.profile === 'smoke' && item.id !== 'json-ok') continue;
    const forward = judgeWinners.find((row) => row.itemId === item.id && row.order === 'forward');
    const reverse = judgeWinners.find((row) => row.itemId === item.id && row.order === 'reverse');
    if (forward === undefined && reverse === undefined) continue;
    const agreed = agreePair(
      (forward?.winner as 'X' | 'Y' | 'tie' | 'inconclusive' | null | undefined) ?? null,
      (reverse?.winner as 'X' | 'Y' | 'tie' | 'inconclusive' | null | undefined) ?? null,
    );
    winSeries.push(agreed === 'anthropic' || agreed === 'xai');
  }
  const learning = learningCurve(passSeries, winSeries);

  let estimatedSpend = 0;
  let spend = 0;
  for (const attempt of attempts) {
    if (typeof attempt.amount === 'number') estimatedSpend += attempt.amount;
    const used = attempt.storedAmount ?? attempt.amount;
    if (typeof used === 'number') spend += used;
  }

  const summary = {
    profile: options.profile,
    cap: options.maxUsd,
    spent: ledger.spent,
    reserved: ledger.reserved,
    counts: ledger.counts,
    judgeCalls: ledger.judgeCalls,
    stopReasons,
    skippedModels,
    attemptCount: attempts.length,
    errorRate:
      attempts.length === 0 ? 0 : attempts.filter((row) => row.error !== null).length / attempts.length,
    wallP50: percentile(
      attempts.map((row) => row.wallMs).filter((value): value is number => value !== null),
      50,
    ),
    wallP95: percentile(
      attempts.map((row) => row.wallMs).filter((value): value is number => value !== null),
      95,
    ),
    ttftP50: percentile(
      attempts.map((row) => row.ttftMs).filter((value): value is number => value !== null),
      50,
    ),
    ttftP95: percentile(
      attempts.map((row) => row.ttftMs).filter((value): value is number => value !== null),
      95,
    ),
    spend,
    estimatedSpend,
    dbEnrichment,
    samplesBefore: sampleBefore.retained,
    samplesAfter: sampleAfter?.retained ?? null,
  };

  await writeAtomic(
    attemptsPath,
    `${attempts.map((row) => JSON.stringify(row)).join('\n')}${attempts.length > 0 ? '\n' : ''}`,
  );
  await writeFile(join(options.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(options.outDir, 'learning.json'), `${JSON.stringify(learning, null, 2)}\n`, 'utf8');
  await writeFile(
    join(options.outDir, 'report.md'),
    writeReport({
      profile: options.profile,
      cap: options.maxUsd,
      attempts,
      stopReasons,
      skippedModels,
      learning,
      spend,
      estimatedSpend,
      dbEnrichment,
      samplesBefore: sampleBefore.retained,
      samplesAfter: sampleAfter?.retained ?? null,
    }),
    'utf8',
  );

  const colors: Record<string, string> = {
    openai: '#1f77b4',
    anthropic: '#ff7f0e',
    xai: '#2ca02c',
    auto: '#9467bd',
  };

  const latencySeries = options.models.map((model) => {
    const byConcurrency = new Map<number, number[]>();
    for (const attempt of attempts) {
      if (attempt.model !== model || attempt.kind !== 'load' || attempt.wallMs === null) continue;
      const list = byConcurrency.get(attempt.concurrency) ?? [];
      list.push(attempt.wallMs);
      byConcurrency.set(attempt.concurrency, list);
    }
    const points = [...byConcurrency.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, values]) => ({ x, y: percentile(values, 50) ?? 0 }));
    return { name: model, color: colors[model] ?? '#333', points };
  });
  await writeSvgIfPoints(
    join(options.outDir, 'latency-concurrency.svg'),
    'Median time to finish by calls at once',
    'calls at once',
    'milliseconds',
    latencySeries,
  );

  const throughputSeries = options.models.map((model) => {
    const byConcurrency = new Map<number, { count: number; ms: number }>();
    for (const wave of waves) {
      if (wave.model !== model) continue;
      const current = byConcurrency.get(wave.concurrency) ?? { count: 0, ms: 0 };
      current.count += wave.count;
      current.ms += wave.ms;
      byConcurrency.set(wave.concurrency, current);
    }
    const points = [...byConcurrency.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, row]) => ({ x, y: row.ms > 0 ? (row.count / row.ms) * 1000 : 0 }));
    return { name: model, color: colors[model] ?? '#333', points };
  });
  await writeSvgIfPoints(join(options.outDir, 'throughput.svg'), 'Calls per second', 'calls at once', 'calls per second', throughputSeries);

  const errorSeries = options.models.map((model) => {
    const byConcurrency = new Map<number, AttemptRecord[]>();
    for (const attempt of attempts) {
      if (attempt.model !== model || attempt.kind !== 'load') continue;
      const list = byConcurrency.get(attempt.concurrency) ?? [];
      list.push(attempt);
      byConcurrency.set(attempt.concurrency, list);
    }
    const points = [...byConcurrency.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, rows]) => ({
        x,
        y: rows.length === 0 ? 0 : rows.filter((row) => row.error !== null).length / rows.length,
      }));
    return { name: model, color: colors[model] ?? '#333', points };
  });
  await writeSvgIfPoints(join(options.outDir, 'error-rate.svg'), 'Share of calls that failed', 'calls at once', 'share of failed calls', errorSeries);

  let running = 0;
  const costPoints = attempts.map((attempt, idx) => {
    const used = attempt.storedAmount ?? attempt.amount ?? 0;
    running += used;
    return { x: idx + 1, y: running };
  });
  await writeSvgIfPoints(
    join(options.outDir, 'cost-cumulative.svg'),
    'Cumulative cost',
    'attempt',
    'USD',
    [{ name: 'spend', color: '#d62728', points: costPoints }],
  );

  const thoughtPoints = attempts
    .filter((row) => row.model === 'xai' && row.thoughts !== null)
    .map((row, idx) => ({ x: idx + 1, y: row.thoughts as number }));
  await writeSvgIfPoints(
    join(options.outDir, 'thoughts.svg'),
    'xAI thinking tokens',
    'attempt',
    'tokens',
    [{ name: 'xai', color: colors.xai!, points: thoughtPoints }],
  );

  const learningSeries = [
    {
      name: 'Checks passed',
      color: '#1f77b4',
      points: learning.map((point) => ({ x: point.index, y: point.passRate })),
    },
    {
      name: 'Same winner both times',
      color: '#ff7f0e',
      points: learning.map((point) => ({ x: point.index, y: point.winRate })),
    },
  ];
  await writeSvgIfPoints(
    join(options.outDir, 'learning-curve.svg'),
    'Answer checks so far',
    'checks included',
    'share',
    learningSeries,
  );

  await writeFile(
    join(options.outDir, 'waves.jsonl'),
    `${waves.map((row) => JSON.stringify(row)).join('\n')}${waves.length > 0 ? '\n' : ''}`,
    'utf8',
  );
  await publishInsights({
    outDir: options.outDir,
    profile: options.profile,
    phase: 'live',
    attempts,
    waves,
    samplesBefore: sampleBefore.retained,
    samplesAfter: sampleAfter?.retained ?? null,
  });

  if (sampleAfter === null) {
    process.stderr.write('sample count was not read after the run\n');
    return 1;
  }
  if (sampleAfter.retained !== sampleBefore.retained) {
    process.stderr.write('open sample count changed\n');
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && /perf\/cli\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'fatal'}\n`);
      process.exitCode = 1;
    });
}

export { main, parseOptions };
