import OpenAI from 'openai';
import { ProxyError, normalizeUpstreamError, proxyError } from './errors.js';
import type { ChatMessage } from './validate.js';

export type TokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type UpstreamCompletion = {
  response: {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: Array<{
      index: number;
      message: { role: 'assistant'; content: string };
      finish_reason: string | null;
    }>;
    usage?: Record<string, number>;
  };
  usage: TokenUsage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function readTokenUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  return {
    promptTokens: readCount(value.prompt_tokens),
    completionTokens: readCount(value.completion_tokens),
    totalTokens: readCount(value.total_tokens),
  };
}

export function validateCompletion(value: unknown): UpstreamCompletion {
  if (!isRecord(value)) throw invalidUpstream();
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256) throw invalidUpstream();
  if (value.object !== 'chat.completion') throw invalidUpstream();
  if (typeof value.created !== 'number' || !Number.isFinite(value.created)) throw invalidUpstream();
  if (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 256) throw invalidUpstream();
  if (!Array.isArray(value.choices) || value.choices.length === 0) throw invalidUpstream();

  const choices = value.choices.map((choice) => {
    if (!isRecord(choice) || typeof choice.index !== 'number' || !Number.isInteger(choice.index)) throw invalidUpstream();
    if (!isRecord(choice.message) || choice.message.role !== 'assistant' || typeof choice.message.content !== 'string') {
      throw invalidUpstream();
    }
    if (choice.finish_reason !== null && typeof choice.finish_reason !== 'string') throw invalidUpstream();
    return {
      index: choice.index,
      message: { role: 'assistant' as const, content: choice.message.content },
      finish_reason: (choice.finish_reason as string | null) ?? null,
    };
  });

  const usage = readTokenUsage(value.usage);
  const publicUsage: Record<string, number> = {};
  if (isRecord(value.usage)) {
    if (usage.promptTokens !== null) publicUsage.prompt_tokens = usage.promptTokens;
    if (usage.completionTokens !== null) publicUsage.completion_tokens = usage.completionTokens;
    if (usage.totalTokens !== null) publicUsage.total_tokens = usage.totalTokens;
  }

  return {
    response: {
      id: value.id,
      object: 'chat.completion',
      created: value.created,
      model: value.model,
      choices,
      ...(Object.keys(publicUsage).length > 0 ? { usage: publicUsage } : {}),
    },
    usage,
  };
}

function invalidUpstream(): never {
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

export async function completeChat(input: {
  apiKey: string;
  baseURL: string;
  upstreamModel: string;
  messages: ChatMessage[];
  timeoutMs: number;
  signal: AbortSignal;
  optional: Record<string, unknown>;
}): Promise<UpstreamCompletion> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    maxRetries: 0,
    timeout: input.timeoutMs,
  });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input.signal.aborted) controller.abort();
  else input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await client.chat.completions.create(
      {
        model: input.upstreamModel,
        messages: input.messages,
        stream: false,
        ...input.optional,
      },
      { maxRetries: 0, timeout: input.timeoutMs, signal: controller.signal },
    );
    return validateCompletion(response);
  } catch (error) {
    if (input.signal.aborted) throw normalizeUpstreamError(error, true);
    if (error instanceof ProxyError) throw error;
    if (controller.signal.aborted) {
      throw proxyError(504, 'server_error', 'timeout', null, 'The upstream model request timed out.');
    }
    throw normalizeUpstreamError(error, false);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
  }
}
