import { ApiError, FunctionCallingConfigMode } from '@google/genai';
import type { UpstreamCompletion } from './adapter.js';
import {
  emptyAttemptFacts,
  invalidRequest,
  proxyError,
  safeProviderRequestId,
  transportFor,
  type FailedAttemptFacts,
} from './errors.js';
import { appendToolFragment, assertFinishedToolCalls, copyToolCalls, type CanonicalEvent, type StreamToolCall } from './stream.js';
import {
  messageText,
  requestUsesTools,
  type ChatMessage,
  type ChatRequest,
  type FunctionTool,
  type FunctionToolCall,
  type ToolChoice,
} from './validate.js';

const VERTEX_FIELDS = new Set(['temperature', 'stop', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice']);
const SAFETY_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION']);
const PART_FIELDS = [
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'toolCall',
  'toolResponse',
  'audioTranscription',
  'videoMetadata',
] as const;

export type VertexPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id: string };
};

export type VertexContent = {
  role: 'user' | 'model';
  parts: VertexPart[];
};

export type VertexFunctionCallingConfig = {
  mode: FunctionCallingConfigMode;
  allowedFunctionNames?: string[];
};

export type VertexUsageParts = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: null;
  cacheReadInputTokens: number | null;
  thoughtsTokens: number | null;
};

export type VertexRequestBody = {
  model: string;
  contents: VertexContent[];
  config: {
    systemInstruction?: string;
    maxOutputTokens?: number;
    temperature?: number;
    stopSequences?: string[];
    automaticContinuation: false;
    tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    toolConfig?: { functionCallingConfig: VertexFunctionCallingConfig };
  };
};

export type VertexStreamCursor = {
  started: boolean;
  finished: boolean;
  tools?: StreamToolCall[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function readVertexUsage(value: unknown): VertexUsageParts {
  const empty: VertexUsageParts = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
  };
  if (!isRecord(value)) return empty;
  const prompt = readCount(value.promptTokenCount);
  const completion = readCount(value.candidatesTokenCount);
  const cachedPresent = hasOwn(value, 'cachedContentTokenCount');
  const cached = cachedPresent ? readCount(value.cachedContentTokenCount) : null;
  const thoughtsPresent = hasOwn(value, 'thoughtsTokenCount');
  const thoughts = thoughtsPresent ? readCount(value.thoughtsTokenCount) : null;
  const totalPresent = hasOwn(value, 'totalTokenCount');
  const totalGiven = totalPresent ? readCount(value.totalTokenCount) : null;
  let uncached: number | null = null;
  if (cachedPresent && cached !== null && prompt !== null && prompt >= cached) {
    uncached = prompt - cached;
  } else if (!cachedPresent && prompt !== null) {
    uncached = prompt;
  }
  let total = totalGiven;
  const thinking = thoughts !== null && thoughts > 0;
  if (total === null && !thinking && prompt !== null && completion !== null) {
    total = prompt + completion;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    uncachedInputTokens: uncached,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: cached,
    thoughtsTokens: thoughts,
  };
}

function usageFacts(value: unknown): FailedAttemptFacts {
  const facts = emptyAttemptFacts();
  if (!isRecord(value)) return facts;
  const usage = readVertexUsage(value.usageMetadata);
  facts.providerRequestId = safeProviderRequestId(value.responseId);
  facts.promptTokens = usage.promptTokens;
  facts.completionTokens = usage.completionTokens;
  facts.totalTokens = usage.totalTokens;
  facts.uncachedInputTokens = usage.uncachedInputTokens;
  facts.cacheReadInputTokens = usage.cacheReadInputTokens;
  facts.thoughtsTokens = usage.thoughtsTokens;
  return facts;
}

function invalidVertex(value: unknown): never {
  throw proxyError(
    502,
    'server_error',
    'invalid_upstream_response',
    null,
    'The upstream model response was invalid.',
    null,
    usageFacts(value),
  );
}

const VERTEX_SCHEMA_TYPE: Record<string, string> = {
  object: 'OBJECT',
  array: 'ARRAY',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
};
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_CALLS = 16;

function vertexSchema(schema: Record<string, unknown>, param: string): Record<string, unknown> {
  if (schema.type === 'null' || typeof schema.type !== 'string' || VERTEX_SCHEMA_TYPE[schema.type] === undefined) {
    throw invalidRequest(param, 'unsupported_parameter', 'The schema type is not supported.');
  }
  if ('additionalProperties' in schema) {
    throw invalidRequest(`${param}.additionalProperties`, 'unsupported_parameter', 'additionalProperties is not supported.');
  }
  if (Array.isArray(schema.enum) && schema.enum.some((item) => typeof item !== 'string')) {
    throw invalidRequest(`${param}.enum`, 'unsupported_parameter', 'enum is not supported.');
  }
  const converted: Record<string, unknown> = { type: VERTEX_SCHEMA_TYPE[schema.type] };
  if (typeof schema.description === 'string') converted.description = schema.description;
  if (Array.isArray(schema.enum)) converted.enum = [...schema.enum];
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (key in schema) converted[key] = schema[key];
  }
  if (isRecord(schema.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isRecord(child)) throw invalidRequest(param, 'unsupported_parameter', 'The schema type is not supported.');
      properties[name] = vertexSchema(child, `${param}.${name}`);
    }
    converted.properties = properties;
  }
  if (Array.isArray(schema.required)) converted.required = [...schema.required];
  if (isRecord(schema.items)) converted.items = vertexSchema(schema.items, `${param}.items`);
  return converted;
}

function argumentsObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidRequest('messages', 'invalid_parameter', 'Tool call arguments must be a JSON object.');
  }
  if (!isRecord(parsed)) {
    throw invalidRequest('messages', 'invalid_parameter', 'Tool call arguments must be a JSON object.');
  }
  return parsed;
}

function functionNameFor(dialog: ChatMessage[], index: number, id: string): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = dialog[cursor];
    if (message?.role !== 'assistant' || message.tool_calls === undefined) continue;
    const call = message.tool_calls.find((item) => item.id === id);
    if (call !== undefined) return call.function.name;
  }
  throw invalidRequest('messages', 'invalid_parameter', 'The tool result id does not match a tool call.');
}

function vertexDialog(dialog: ChatMessage[]): VertexContent[] {
  const contents: VertexContent[] = [];
  let pending: VertexPart[] = [];
  const flushPending = (): void => {
    if (pending.length === 0) return;
    contents.push({ role: 'user', parts: pending });
    pending = [];
  };
  dialog.forEach((message, index) => {
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      pending.push({
        functionResponse: {
          name: functionNameFor(dialog, index, id),
          id,
          response: { content: messageText(message) },
        },
      });
      return;
    }
    if (message.role === 'user' && pending.length > 0) {
      const text = messageText(message);
      if (text.length > 0) pending.push({ text });
      flushPending();
      return;
    }
    flushPending();
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: messageText(message) }] });
      return;
    }
    const parts: VertexPart[] = [];
    const text = messageText(message);
    if (text.length > 0 || message.tool_calls === undefined || message.tool_calls.length === 0) {
      parts.push({ text });
    }
    for (const call of message.tool_calls ?? []) {
      parts.push({
        functionCall: {
          name: call.function.name,
          id: call.id,
          args: argumentsObject(call.function.arguments),
        },
      });
    }
    contents.push({ role: 'model', parts });
  });
  flushPending();
  return contents;
}

function vertexToolConfig(choice: ToolChoice | undefined): VertexFunctionCallingConfig {
  if (choice === 'none') return { mode: FunctionCallingConfigMode.NONE };
  if (choice === 'required') return { mode: FunctionCallingConfigMode.ANY };
  if (choice !== undefined && typeof choice === 'object') {
    return { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [choice.function.name] };
  }
  return { mode: FunctionCallingConfigMode.AUTO };
}

function applyVertexTools(body: VertexRequestBody, request: ChatRequest): void {
  const tools = request.optional.tools;
  if (!Array.isArray(tools)) return;
  const declarations = (tools as FunctionTool[]).map((tool, index) => {
    const declaration: Record<string, unknown> = { name: tool.function.name };
    if (tool.function.description !== undefined) declaration.description = tool.function.description;
    if (tool.function.parameters !== undefined) {
      declaration.parameters = vertexSchema(tool.function.parameters, `tools[${index}].function.parameters`);
    }
    return declaration;
  });
  body.config.tools = [{ functionDeclarations: declarations }];
  body.config.toolConfig = {
    functionCallingConfig: vertexToolConfig(request.optional.tool_choice as ToolChoice | undefined),
  };
}

export function toVertexRequest(request: ChatRequest, upstreamModel: string): VertexRequestBody {
  for (const key of Object.keys(request.optional)) {
    if (!VERTEX_FIELDS.has(key)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported by this model.`);
    }
  }
  const temperature = request.optional.temperature;
  if (typeof temperature === 'number' && (temperature < 0 || temperature > 2)) {
    throw invalidRequest('temperature', 'invalid_parameter', 'temperature is outside the supported range.');
  }
  let system: string | undefined;
  const dialog = [...request.messages];
  const systemCount = dialog.filter((message) => message.role === 'system').length;
  if (systemCount > 1) {
    throw invalidRequest('messages', 'unsupported_message', 'Only one leading system message is supported.');
  }
  if (systemCount === 1 && dialog[0]?.role !== 'system') {
    throw invalidRequest('messages', 'unsupported_message', 'A system message is only supported as the first message.');
  }
  if (dialog[0]?.role === 'system') {
    system = messageText(dialog[0]);
    dialog.shift();
  }
  if (dialog.length === 0) {
    throw invalidRequest('messages', 'unsupported_message', 'A user or assistant message is required.');
  }
  const maxCompletion = request.optional.max_completion_tokens;
  const maxTokens = request.optional.max_tokens;
  if (typeof maxCompletion === 'number' && typeof maxTokens === 'number' && maxCompletion !== maxTokens) {
    throw invalidRequest('max_completion_tokens', 'invalid_parameter', 'max_completion_tokens and max_tokens disagree.');
  }
  const limit = typeof maxCompletion === 'number' ? maxCompletion : typeof maxTokens === 'number' ? maxTokens : undefined;
  const stop = request.optional.stop;
  let stopSequences: string[] | undefined;
  if (typeof stop === 'string') stopSequences = [stop];
  else if (Array.isArray(stop)) stopSequences = stop;
  if (stopSequences !== undefined && stopSequences.length > 5) {
    throw invalidRequest('stop', 'invalid_parameter', 'stop must be a string or up to five strings.');
  }
  const usesTools = requestUsesTools(request);
  const body: VertexRequestBody = {
    model: upstreamModel,
    contents: usesTools
      ? vertexDialog(dialog)
      : dialog.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: messageText(message) }],
        })),
    config: { automaticContinuation: false },
  };
  if (system !== undefined) body.config.systemInstruction = system;
  if (limit !== undefined) body.config.maxOutputTokens = limit;
  if (typeof temperature === 'number') body.config.temperature = temperature;
  if (stopSequences !== undefined) body.config.stopSequences = stopSequences;
  if (usesTools) applyVertexTools(body, request);
  return body;
}

export function blockNative(reason: string): string {
  const native = reason.toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/.test(native)) invalidVertex(null);
  return native;
}

export function mapVertexFinish(reason: string): { finish: 'stop' | 'length' | 'content_filter'; native: string } {
  const native = reason.toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/.test(native)) invalidVertex(null);
  if (reason === 'STOP') return { finish: 'stop', native };
  if (reason === 'MAX_TOKENS') return { finish: 'length', native };
  if (SAFETY_REASONS.has(reason)) return { finish: 'content_filter', native };
  throw proxyError(
    502,
    'server_error',
    'invalid_upstream_response',
    null,
    'The upstream model response was invalid.',
    null,
  );
}

function visibleText(parts: unknown, source: unknown): string {
  if (!Array.isArray(parts)) invalidVertex(source);
  let text = '';
  for (const part of parts) {
    if (!isRecord(part)) invalidVertex(source);
    if (PART_FIELDS.some((field) => part[field] !== undefined)) invalidVertex(source);
    if (part.thought === true) continue;
    if (part.text === undefined) {
      const keys = Object.keys(part).filter((key) => key !== 'thoughtSignature' && key !== 'partMetadata');
      if (keys.length > 0) invalidVertex(source);
      continue;
    }
    if (typeof part.text !== 'string') invalidVertex(source);
    text += part.text;
  }
  return text;
}

function readVertexFunctionCall(value: unknown, source: unknown, seen: Set<string>): FunctionToolCall {
  if (!isRecord(value)) invalidVertex(source);
  const extra = Object.keys(value).filter((key) => key !== 'name' && key !== 'args' && key !== 'id');
  if (extra.length > 0) invalidVertex(source);
  const id = value.id;
  const name = value.name;
  const args = value.args;
  if (typeof id !== 'string' || !CALL_ID.test(id) || seen.has(id)) invalidVertex(source);
  seen.add(id);
  if (typeof name !== 'string' || !FUNCTION_NAME.test(name)) invalidVertex(source);
  if (!isRecord(args)) invalidVertex(source);
  const encoded = JSON.stringify(args);
  if (encoded.length === 0 || encoded.length > 8192) invalidVertex(source);
  return { id, type: 'function', function: { name, arguments: encoded } };
}

function readVertexModelParts(parts: unknown, source: unknown): { content: string; toolCalls: FunctionToolCall[] } {
  if (!Array.isArray(parts)) invalidVertex(source);
  const toolCalls: FunctionToolCall[] = [];
  const seen = new Set<string>();
  let content = '';
  for (const part of parts) {
    if (!isRecord(part)) invalidVertex(source);
    if (part.functionCall !== undefined) {
      if (part.text !== undefined || part.thought === true) invalidVertex(source);
      if (PART_FIELDS.some((field) => field !== 'functionCall' && part[field] !== undefined)) invalidVertex(source);
      const keys = Object.keys(part).filter((key) => key !== 'functionCall' && key !== 'thoughtSignature' && key !== 'partMetadata');
      if (keys.length > 0) invalidVertex(source);
      if (toolCalls.length >= MAX_TOOL_CALLS) invalidVertex(source);
      toolCalls.push(readVertexFunctionCall(part.functionCall, source, seen));
      continue;
    }
    if (PART_FIELDS.some((field) => part[field] !== undefined)) invalidVertex(source);
    if (part.thought === true) continue;
    if (part.text === undefined) {
      const keys = Object.keys(part).filter((key) => key !== 'thoughtSignature' && key !== 'partMetadata');
      if (keys.length > 0) invalidVertex(source);
      continue;
    }
    if (typeof part.text !== 'string') invalidVertex(source);
    content += part.text;
  }
  return { content, toolCalls };
}

function publicUsage(usage: VertexUsageParts): Record<string, number> {
  const body: Record<string, number> = {};
  if (usage.promptTokens !== null) body.prompt_tokens = usage.promptTokens;
  if (usage.completionTokens !== null) body.completion_tokens = usage.completionTokens;
  if (usage.totalTokens !== null) body.total_tokens = usage.totalTokens;
  return body;
}

export function normalizeVertexResponse(
  value: unknown,
  createdSeconds: number,
  upstreamModel: string,
): UpstreamCompletion {
  if (!isRecord(value)) invalidVertex(value);
  const usage = readVertexUsage(value.usageMetadata);
  const providerRequestId = safeProviderRequestId(value.responseId);
  const model = typeof value.modelVersion === 'string' && value.modelVersion.length > 0 && value.modelVersion.length <= 256
    ? value.modelVersion
    : upstreamModel;
  const blocked = isRecord(value.promptFeedback) && typeof value.promptFeedback.blockReason === 'string';
  const candidates = value.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (!blocked) invalidVertex(value);
    const native = blockNative(String((value.promptFeedback as { blockReason: string }).blockReason));
    const shown = publicUsage(usage);
    return {
      response: {
        id: providerRequestId ?? 'chatcmpl-vertex',
        object: 'chat.completion',
        created: createdSeconds,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
        ...(Object.keys(shown).length > 0 ? { usage: shown } : {}),
      },
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      },
      providerRequestId,
      stopReason: native,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      thoughtsTokens: usage.thoughtsTokens,
    };
  }
  if (candidates.length !== 1 || !isRecord(candidates[0])) invalidVertex(value);
  const candidate = candidates[0];
  if (typeof candidate.finishReason !== 'string') invalidVertex(value);
  let mapped: { finish: 'stop' | 'length' | 'content_filter'; native: string };
  try {
    mapped = mapVertexFinish(candidate.finishReason);
  } catch (error) {
    if (error instanceof Error && error.name === 'ProxyError') {
      throw proxyError(
        502,
        'server_error',
        'invalid_upstream_response',
        null,
        'The upstream model response was invalid.',
        null,
        usageFacts(value),
      );
    }
    throw error;
  }
  const contentRecord = candidate.content;
  const parts = isRecord(contentRecord) ? contentRecord.parts : [];
  let read: { content: string; toolCalls: FunctionToolCall[] };
  try {
    read = readVertexModelParts(parts ?? [], value);
  } catch (error) {
    if (error instanceof Error && error.name === 'ProxyError') throw error;
    invalidVertex(value);
  }
  if (read.toolCalls.length > 0 && candidate.finishReason !== 'STOP') invalidVertex(value);
  const content = read.toolCalls.length > 0 && read.content.length === 0 ? null : read.content;
  const finishReason = read.toolCalls.length > 0 ? 'tool_calls' : mapped.finish;
  const shown = publicUsage(usage);
  return {
    response: {
      id: providerRequestId ?? 'chatcmpl-vertex',
      object: 'chat.completion',
      created: createdSeconds,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(read.toolCalls.length > 0 ? { tool_calls: read.toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      ...(Object.keys(shown).length > 0 ? { usage: shown } : {}),
    },
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    },
    providerRequestId,
    stopReason: mapped.native,
    uncachedInputTokens: usage.uncachedInputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    thoughtsTokens: usage.thoughtsTokens,
  };
}

function partsIncludeFunctionCall(parts: unknown): boolean {
  return Array.isArray(parts) && parts.some((part) => isRecord(part) && part.functionCall !== undefined);
}

export function eventsFromVertexChunk(
  chunk: unknown,
  cursor: VertexStreamCursor,
  upstreamModel: string,
  createdSeconds: number,
  options?: { allowTools?: boolean },
): { cursor: VertexStreamCursor; events: CanonicalEvent[] } {
  if (!isRecord(chunk)) invalidVertex(chunk);
  const events: CanonicalEvent[] = [];
  const next: VertexStreamCursor = { ...cursor, tools: copyToolCalls(cursor.tools) };
  const providerRequestId = safeProviderRequestId(chunk.responseId);
  const model = typeof chunk.modelVersion === 'string' && chunk.modelVersion.length > 0 && chunk.modelVersion.length <= 256
    ? chunk.modelVersion
    : upstreamModel;
  if (!next.started) {
    events.push({
      type: 'start',
      id: providerRequestId ?? 'chatcmpl-vertex',
      model,
      created: createdSeconds,
      providerRequestId,
    });
    next.started = true;
  }
  const blocked = isRecord(chunk.promptFeedback) && typeof chunk.promptFeedback.blockReason === 'string';
  const candidates = chunk.candidates;
  if (Array.isArray(candidates) && candidates.length > 1) invalidVertex(chunk);
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : null;
  if (candidate !== null) {
    const contentRecord = candidate.content;
    if (isRecord(contentRecord) && contentRecord.parts !== undefined) {
      if (options?.allowTools === true && partsIncludeFunctionCall(contentRecord.parts)) {
        const read = readVertexModelParts(contentRecord.parts, chunk);
        if (read.content.length > 0) events.push({ type: 'text_delta', text: read.content });
        const tools = next.tools ?? [];
        for (const call of read.toolCalls) {
          if (tools.some((existing) => existing.id === call.id)) invalidVertex(chunk);
          events.push(appendToolFragment(tools, {
            index: tools.length,
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          }));
        }
        next.tools = tools;
      } else {
        const text = visibleText(contentRecord.parts, chunk);
        if (text.length > 0) events.push({ type: 'text_delta', text });
      }
    }
    if (typeof candidate.finishReason === 'string' && !next.finished) {
      const tools = next.tools ?? [];
      if (tools.length > 0) {
        if (candidate.finishReason !== 'STOP') invalidVertex(chunk);
        assertFinishedToolCalls(tools);
        events.push({ type: 'finish', finishReason: 'tool_calls', nativeReason: 'stop' });
      } else {
        const mapped = mapVertexFinish(candidate.finishReason);
        events.push({ type: 'finish', finishReason: mapped.finish, nativeReason: mapped.native });
      }
      next.finished = true;
    }
  } else if (blocked && !next.finished) {
    const native = blockNative(String((chunk.promptFeedback as { blockReason: string }).blockReason));
    events.push({ type: 'finish', finishReason: 'content_filter', nativeReason: native });
    next.finished = true;
  }
  if (chunk.usageMetadata !== undefined) {
    const usage = readVertexUsage(chunk.usageMetadata);
    events.push({
      type: 'usage',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      thoughtsTokens: usage.thoughtsTokens,
    });
  }
  return { cursor: next, events };
}

function statusOf(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return null;
}

export function normalizeVertexError(error: unknown, callerAborted: boolean, retryAfter: string | null = null): Error {
  if (callerAborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
  }
  if (error instanceof Error && error.name === 'ProxyError') return error;
  const status = statusOf(error);
  const transport = transportFor(error, status, retryAfter);
  if (status === 401) {
    return proxyError(401, 'authentication_error', 'expired_credentials', null, 'The upstream provider rejected the credential.', 'expired_credentials', undefined, transport);
  }
  if (status === 403) {
    return proxyError(403, 'permission_error', 'permission_denied', null, 'The upstream provider denied the request.', 'permission_denied', undefined, transport);
  }
  if (status === 404) {
    return proxyError(404, 'invalid_request_error', 'model_not_available', 'model', 'The model is not available.', 'model_not_available', undefined, transport);
  }
  if (status === 400) {
    return proxyError(400, 'invalid_request_error', 'invalid_project', null, 'The Google Cloud project or location is not valid.', 'invalid_project', undefined, transport);
  }
  return proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.', null, undefined, transport);
}
