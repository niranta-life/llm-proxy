import { ProxyError } from './errors.js';
import { preflightEvaluation, type PreflightFacts } from './evaluation-preflight.js';
import { ITEM_REASON_CODES, type ItemReasonCode } from './evaluation-state.js';
import { isTaskCategory } from './task-categories.js';
import type { ChatMessage, ChatRequest } from './validate.js';

const UNSUPPORTED = new Set([
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'modalities',
  'audio',
  'reasoning_effort',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'store',
  'metadata',
  'service_tier',
  'prediction',
  'web_search_options',
  'stream',
  'stream_options',
]);

const PARAMETER_CAPABILITY: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_completion_tokens',
  stop: 'stop',
  presence_penalty: 'presence_penalty',
  frequency_penalty: 'frequency_penalty',
  seed: 'seed',
  n: 'n',
  user: 'user',
  response_format: 'response_format_text',
};

const ROLES = new Set(['system', 'user', 'assistant']);

export type ReplayRequestBuild = {
  request: ChatRequest;
  executionParameters: Record<string, unknown>;
  originalDeployment: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReason(value: string | null): value is ItemReasonCode {
  return value !== null && (ITEM_REASON_CODES as readonly string[]).includes(value);
}

export function recheckReplayItem(
  facts: PreflightFacts,
  input: { healthStatus: string | null; breakerOpen: boolean; executionEnabled: boolean },
): ItemReasonCode | null {
  if (!input.executionEnabled) return 'kill_switch';
  try {
    // The run is already admitted. Create-time caps stay on the create path.
    preflightEvaluation({
      ...facts,
      openRuns: 0,
      maxOpenRuns: Math.max(facts.maxOpenRuns, 1),
      maxItems: Math.max(facts.maxItems, facts.sampleIds.length),
      tenantItemCap: null,
    });
  } catch (error) {
    if (error instanceof ProxyError && isReason(error.code)) return error.code;
    throw error;
  }
  if (input.healthStatus === 'unhealthy' || input.breakerOpen) return 'deployment_unhealthy';
  return null;
}

export function rebuildReplayRequest(
  payload: unknown,
  challengerName: string,
  capabilities: readonly string[],
): { ok: true; value: ReplayRequestBuild } | { ok: false; reason: ItemReasonCode } {
  if (challengerName === 'auto' || challengerName.trim() === '') return { ok: false, reason: 'semantic_rejected' };
  if (!isRecord(payload)) return { ok: false, reason: 'invalid_canonical' };
  const request = payload.request;
  const configuration = payload.configuration;
  if (!isRecord(request) || !isRecord(configuration)) return { ok: false, reason: 'invalid_canonical' };
  if (configuration.stream === true) return { ok: false, reason: 'semantic_rejected' };
  if (typeof configuration.deployment !== 'string' || configuration.deployment === 'auto' || configuration.deployment.trim() === '') {
    return { ok: false, reason: 'invalid_canonical' };
  }
  for (const key of Object.keys(request)) {
    if (UNSUPPORTED.has(key)) return { ok: false, reason: 'semantic_rejected' };
  }
  const parameters = request.parameters;
  if (parameters === undefined) return { ok: false, reason: 'invalid_canonical' };
  if (!isRecord(parameters)) return { ok: false, reason: 'invalid_canonical' };
  for (const key of Object.keys(parameters)) {
    if (UNSUPPORTED.has(key)) return { ok: false, reason: 'semantic_rejected' };
  }
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 100) {
    return { ok: false, reason: 'invalid_canonical' };
  }
  const messages: ChatMessage[] = [];
  for (const message of request.messages) {
    if (!isRecord(message)) return { ok: false, reason: 'invalid_canonical' };
    if ('tool_calls' in message || 'tool_call_id' in message || 'function_call' in message) {
      return { ok: false, reason: 'semantic_rejected' };
    }
    if (typeof message.role !== 'string' || !ROLES.has(message.role)) {
      return message.role === 'tool' || message.role === 'function'
        ? { ok: false, reason: 'semantic_rejected' }
        : { ok: false, reason: 'invalid_canonical' };
    }
    if (typeof message.content !== 'string' || message.content.length < 1) {
      return { ok: false, reason: 'semantic_rejected' };
    }
    messages.push({ role: message.role as ChatMessage['role'], content: message.content });
  }
  const optional: Record<string, unknown> = {};
  const executionParameters: Record<string, unknown> = {};
  for (const key of Object.keys(parameters).sort()) {
    const capability = PARAMETER_CAPABILITY[key];
    if (capability === undefined) return { ok: false, reason: 'semantic_rejected' };
    if (!capabilities.includes(capability)) return { ok: false, reason: 'capability_mismatch' };
    const value = parameters[key];
    if (!parameterValueOk(key, value)) return { ok: false, reason: 'invalid_canonical' };
    optional[key] = value;
    executionParameters[key] = value;
  }
  if (typeof request.task === 'string' && isTaskCategory(request.task)) executionParameters.task = request.task;
  return {
    ok: true,
    value: {
      request: {
        model: challengerName,
        messages,
        stream: false,
        includeUsage: false,
        taskHint: typeof request.task === 'string' ? request.task : null,
        optional,
      },
      executionParameters,
      originalDeployment: configuration.deployment,
    },
  };
}

function parameterValueOk(key: string, value: unknown): boolean {
  if (key === 'temperature' || key === 'top_p' || key === 'presence_penalty' || key === 'frequency_penalty') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (key === 'max_tokens' || key === 'max_completion_tokens' || key === 'seed' || key === 'n') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (key === 'user') return typeof value === 'string' && value.length > 0 && value.length <= 256;
  if (key === 'stop') {
    if (typeof value === 'string') return value.length > 0;
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
  }
  if (key === 'response_format') return isRecord(value) && !('content' in value) && !('messages' in value);
  return false;
}

export function admissionItemReason(code: string | null): ItemReasonCode {
  if (code === 'budget_exceeded' || code === 'budget_unbounded' || code === 'budget_unknown') return 'budget_exceeded';
  if (
    code === 'concurrency_limited' ||
    code === 'api_key_concurrency_limited' ||
    code === 'connection_limited' ||
    code === 'deployment_limited' ||
    code === 'stream_limited' ||
    code === 'api_key_stream_limited'
  ) {
    return 'concurrency_limited';
  }
  if (
    code === 'tenant_rate_limited' ||
    code === 'api_key_rate_limited' ||
    code === 'token_rate_limited' ||
    code === 'api_key_token_limited'
  ) {
    return 'rate_limited';
  }
  return 'admission_unavailable';
}

export function providerItemReason(error: unknown): ItemReasonCode {
  if (!(error instanceof ProxyError)) return 'provider_error';
  if (error.code === 'timeout' || error.transport.deadlineKind !== null) return 'provider_timeout';
  if (error.status === 429 || error.code === 'rate_limit') return 'provider_rate_limited';
  if (error.code === 'invalid_upstream_response') return 'malformed_output';
  return 'provider_error';
}
