import OpenAI from 'openai';
import {
  OPENROUTER_METADATA_HEADER,
  OPENROUTER_METADATA_VALUE,
  assertServingIdentity,
  compatibleRequestFields,
  readReportedProvider,
  routePolicy,
} from './compatible.js';
import type { ProviderAdapter, ProviderCall } from './contract.js';
import { ProxyError, normalizeUpstreamError, proxyError, safeNativeReason, safeProviderRequestId } from './errors.js';
import { streamOpenAiChat, type UpstreamStreamItem } from './openai-stream.js';
import type { StreamTimeouts } from './stream.js';
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
    provider?: string;
  };
  usage: TokenUsage;
  providerRequestId: string | null;
  stopReason: string | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  thoughtsTokens?: number | null;
  servingModel?: string | null;
  servingProvider?: string | null;
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
    providerRequestId: safeProviderRequestId(value.id),
    stopReason: safeNativeReason(choices[0]?.finish_reason),
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

function invalidUpstream(): never {
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

export function toOpenAiChatBody(input: {
  upstreamModel: string;
  messages: ChatMessage[];
  optional: Record<string, unknown>;
}): {
  model: string;
  messages: ChatMessage[];
  stream: false;
} & Record<string, unknown> {
  return {
    model: input.upstreamModel,
    messages: input.messages,
    stream: false,
    ...input.optional,
  };
}

export async function completeChat(input: {
  apiKey: string;
  baseURL: string;
  upstreamModel: string;
  messages: ChatMessage[];
  timeoutMs: number;
  signal: AbortSignal;
  optional: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  parseRouterMetadata?: boolean;
}): Promise<UpstreamCompletion> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    maxRetries: 0,
    timeout: input.timeoutMs,
    // The SDK fetch type is node-fetch. Runtime global fetch is undici.
    ...(input.fetchImpl ? { fetch: input.fetchImpl as never } : {}),
    ...(input.defaultHeaders ? { defaultHeaders: input.defaultHeaders } : {}),
  });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input.signal.aborted) controller.abort();
  else input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await client.chat.completions.create(
      toOpenAiChatBody({
        upstreamModel: input.upstreamModel,
        messages: input.messages,
        optional: input.optional,
      }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      { maxRetries: 0, timeout: input.timeoutMs, signal: controller.signal },
    );
    const completion = validateCompletion(response);
    return {
      ...completion,
      servingModel: completion.response.model,
      servingProvider: readReportedProvider(response, input.parseRouterMetadata === true),
    };
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

export const openAiAdapter: ProviderAdapter & {
  stream(call: ProviderCall & { timeouts: StreamTimeouts; deadline: AbortController }): AsyncGenerator<UpstreamStreamItem>;
} = {
  provider: 'openai',
  prepare(): void {},
  async execute(call) {
    const policy = routePolicy(call.route);
    const compatible = call.route.provider === 'xai' || call.route.provider === 'openrouter';
    const completion = await completeChat({
      apiKey: call.apiKey,
      baseURL: call.baseURL,
      upstreamModel: call.route.upstreamModel,
      messages: call.request.messages,
      timeoutMs: call.route.timeoutMs,
      signal: call.signal,
      optional: compatibleRequestFields(call.route.provider, policy, call.request.optional),
      fetchImpl: compatible ? call.fetchImpl : undefined,
      ...(call.route.provider === 'openrouter'
        ? {
            defaultHeaders: { [OPENROUTER_METADATA_HEADER]: OPENROUTER_METADATA_VALUE },
            parseRouterMetadata: true,
          }
        : {}),
    });
    if (call.route.provider === 'openrouter') {
      assertServingIdentity(policy, completion.servingProvider ?? null);
    }
    if (typeof completion.servingProvider === 'string') {
      return {
        ...completion,
        response: { ...completion.response, provider: completion.servingProvider },
      };
    }
    return completion;
  },
  stream(call) {
    const policy = routePolicy(call.route);
    const compatible = call.route.provider === 'xai' || call.route.provider === 'openrouter';
    return streamOpenAiChat({
      apiKey: call.apiKey,
      baseURL: call.baseURL,
      upstreamModel: call.route.upstreamModel,
      messages: call.request.messages,
      signal: call.signal,
      optional: compatibleRequestFields(call.route.provider, policy, call.request.optional),
      includeUsage: call.request.includeUsage,
      connectTimeoutMs: call.timeouts.connect,
      idleTimeoutMs: call.timeouts.idle,
      totalTimeoutMs: call.timeouts.total,
      deadline: call.deadline,
      fetchImpl: compatible ? call.fetchImpl : undefined,
      identity: call.route.provider === 'openrouter' ? policy : undefined,
    });
  },
};
