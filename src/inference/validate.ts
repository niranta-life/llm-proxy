import { ProxyError, invalidRequest } from './errors.js';
import { loopbackHost } from './private.js';
import { isTaskCategory } from './task-categories.js';

const UNSUPPORTED = new Set([
  'functions',
  'function_call',
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
]);

const OPTIONAL = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'user',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
]);

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'description',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const MAX_TOOLS = 32;
const MAX_TOOL_CALLS = 16;
const MAX_SCHEMA_BYTES = 8192;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 64;
const MAX_PROPERTIES = 32;
const MAX_DESCRIPTION = 1024;
const MAX_ENUM = 16;
const MAX_ARGUMENTS = 8192;

export type FunctionToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type FunctionTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: false;
  };
};

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: FunctionToolCall[];
  tool_call_id?: string;
};

export function messageText(message: { content: string | null }): string {
  return typeof message.content === 'string' ? message.content : '';
}

export function argumentChars(message: ChatMessage): number {
  if (message.tool_calls === undefined) return 0;
  let total = 0;
  for (const call of message.tool_calls) total += call.function.arguments.length;
  return total;
}

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  taskHint: string | null;
  optional: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}

export function validateChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) {
    throw invalidRequest('body', 'invalid_request', 'The request body must be a JSON object.');
  }

  let stream = false;
  if ('stream' in body) {
    if (body.stream === true) stream = true;
    else if (body.stream !== false) {
      throw invalidRequest('stream', 'invalid_parameter', 'stream must be false when it is set.');
    }
  }
  const includeUsage = parseStreamOptions(body, stream);

  let taskHint: string | null = null;
  if ('task' in body) {
    if (typeof body.task !== 'string' || !isTaskCategory(body.task)) {
      throw invalidRequest('task', 'invalid_parameter', 'task must be a supported category.');
    }
    taskHint = body.task;
  }

  for (const key of Object.keys(body)) {
    if (key === 'model' || key === 'messages' || key === 'stream' || key === 'stream_options' || key === 'task') continue;
    if (UNSUPPORTED.has(key)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported.`);
    }
    if (!OPTIONAL.has(key)) {
      throw invalidRequest(key, 'unknown_parameter', `${key} is not a supported parameter.`);
    }
  }

  if (typeof body.model !== 'string' || body.model.trim() === '' || body.model.length > 128 || /\s/.test(body.model)) {
    throw invalidRequest('model', 'invalid_parameter', 'model must be a non-empty string without spaces.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) {
    throw invalidRequest('messages', 'invalid_parameter', 'messages must contain from 1 to 100 items.');
  }

  const messages = body.messages.map((message, index) => parseMessage(message, index));
  const optional: Record<string, unknown> = {};
  const tools = 'tools' in body ? parseTools(body.tools) : undefined;
  const toolNames = tools === undefined ? null : new Set(tools.map((tool) => tool.function.name));
  if (tools !== undefined) optional.tools = tools;
  for (const key of Object.keys(body)) {
    if (!OPTIONAL.has(key) || key === 'tools') continue;
    optional[key] = key === 'tool_choice' ? parseToolChoice(body[key], toolNames) : parseOptional(key, body[key]);
  }
  if ('parallel_tool_calls' in optional && tools === undefined) {
    throw invalidRequest('parallel_tool_calls', 'invalid_parameter', 'parallel_tool_calls requires tools.');
  }
  correlateToolMessages(messages, toolNames);

  return { model: body.model, messages, stream, includeUsage, taskHint, optional };
}

export function requestUsesTools(request: ChatRequest): boolean {
  if ('tools' in request.optional || 'tool_choice' in request.optional || 'parallel_tool_calls' in request.optional) {
    return true;
  }
  return request.messages.some(
    (message) => message.role === 'tool' || (message.role === 'assistant' && message.tool_calls !== undefined),
  );
}

const VERIFIED_TOOL_PROVIDERS = new Set(['openai', 'anthropic', 'vertex', 'xai', 'openrouter']);

function dgxMockEndpoint(endpoint: string | null | undefined): boolean {
  if (endpoint === null || endpoint === undefined || endpoint.length === 0) return false;
  try {
    return loopbackHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

export function assertToolProvider(
  request: ChatRequest,
  provider: string,
  options?: { endpoint?: string | null; originProvider?: string },
): void {
  if (!requestUsesTools(request)) return;
  if (options?.originProvider !== undefined && options.originProvider !== provider) {
    throw invalidRequest('tools', 'unsupported_parameter', 'tools is not supported.');
  }
  const allowed = VERIFIED_TOOL_PROVIDERS.has(provider) || (provider === 'dgx' && dgxMockEndpoint(options?.endpoint));
  if (!allowed) {
    throw invalidRequest('tools', 'unsupported_parameter', 'tools is not supported.');
  }
}

function parseStreamOptions(body: Record<string, unknown>, stream: boolean): boolean {
  if (!('stream_options' in body)) return true;
  if (!stream) {
    throw invalidRequest('stream_options', 'unsupported_parameter', 'stream_options is not supported.');
  }
  const value = body.stream_options;
  if (!isRecord(value)) {
    throw invalidRequest('stream_options', 'invalid_parameter', 'stream_options must be an object.');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'include_usage')) {
    throw invalidRequest('stream_options', 'unsupported_parameter', 'stream_options is not supported.');
  }
  if (value.include_usage === undefined) return true;
  if (typeof value.include_usage !== 'boolean') {
    throw invalidRequest('stream_options.include_usage', 'invalid_parameter', 'include_usage must be a boolean.');
  }
  return value.include_usage;
}

export function assertStreamAllowed(
  request: ChatRequest,
  route: { provider: string; streamingEnabled: boolean },
  tenantStreamingEnabled: boolean,
): void {
  if (!request.stream) return;
  if (
    (route.provider === 'openai' ||
      route.provider === 'anthropic' ||
      route.provider === 'vertex' ||
      route.provider === 'xai' ||
      route.provider === 'openrouter' ||
      route.provider === 'dgx') &&
    tenantStreamingEnabled &&
    route.streamingEnabled
  ) {
    return;
  }
  throw invalidRequest('stream', 'unsupported_parameter', 'Streaming is not supported.');
}

function parseMessage(value: unknown, index: number): ChatMessage {
  const param = `messages[${index}]`;
  if (!isRecord(value)) {
    throw invalidRequest(param, 'invalid_parameter', 'Each message must be an object.');
  }
  if (typeof value.role !== 'string' || !ROLES.has(value.role)) {
    throw invalidRequest(`${param}.role`, 'unsupported_message', 'Only system, user, assistant, and tool messages are supported.');
  }
  if (value.role === 'tool') return parseToolMessage(value, param);
  if (value.role === 'assistant' && 'tool_calls' in value) return parseAssistantToolMessage(value, param);
  for (const key of Object.keys(value)) {
    if (key !== 'role' && key !== 'content') {
      throw invalidRequest(`${param}.${key}`, 'unknown_parameter', `${key} is not a supported message field.`);
    }
  }
  if (Array.isArray(value.content)) return rejectContentParts(value.content, param);
  if (typeof value.content !== 'string' || value.content.length === 0 || value.content.length > 100_000) {
    throw invalidRequest(`${param}.content`, 'invalid_parameter', 'Message content must be text.');
  }
  return { role: value.role as 'system' | 'user' | 'assistant', content: value.content };
}

function rejectContentParts(content: unknown[], param: string): never {
  const multimodal = content.some(
    (part) =>
      isRecord(part) &&
      (part.type === 'image_url' || part.type === 'image' || part.type === 'audio' || part.type === 'input_audio'),
  );
  throw invalidRequest(
    `${param}.content`,
    multimodal ? 'unsupported_modality' : 'unsupported_message',
    'Only text message content is supported.',
  );
}

function parseToolMessage(value: Record<string, unknown>, param: string): ChatMessage {
  for (const key of Object.keys(value)) {
    if (key !== 'role' && key !== 'content' && key !== 'tool_call_id') {
      throw invalidRequest(`${param}.${key}`, 'unknown_parameter', `${key} is not a supported message field.`);
    }
  }
  if (typeof value.content !== 'string' || value.content.length === 0 || value.content.length > 100_000) {
    throw invalidRequest(`${param}.content`, 'invalid_parameter', 'Message content must be text.');
  }
  if (typeof value.tool_call_id !== 'string' || !CALL_ID.test(value.tool_call_id)) {
    throw invalidRequest(`${param}.tool_call_id`, 'invalid_parameter', 'The tool result id is invalid.');
  }
  return { role: 'tool', content: value.content, tool_call_id: value.tool_call_id };
}

function parseAssistantToolMessage(value: Record<string, unknown>, param: string): ChatMessage {
  for (const key of Object.keys(value)) {
    if (key !== 'role' && key !== 'content' && key !== 'tool_calls') {
      throw invalidRequest(`${param}.${key}`, 'unknown_parameter', `${key} is not a supported message field.`);
    }
  }
  let content: string | null = null;
  if ('content' in value && value.content !== null) {
    if (typeof value.content !== 'string' || value.content.length > 100_000) {
      if (Array.isArray(value.content)) return rejectContentParts(value.content, param);
      throw invalidRequest(`${param}.content`, 'invalid_parameter', 'Message content must be text.');
    }
    content = value.content;
  }
  const toolCalls = parseToolCallList(value.tool_calls, `${param}.tool_calls`);
  return { role: 'assistant', content, tool_calls: toolCalls };
}

function parseToolCallList(value: unknown, param: string): FunctionToolCall[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOL_CALLS) {
    throw invalidRequest(param, 'invalid_parameter', 'tool_calls must contain from 1 to 16 calls.');
  }
  const seen = new Set<string>();
  return value.map((item, index) => parseToolCall(item, `${param}[${index}]`, seen));
}

function parseToolCall(value: unknown, param: string, seen: Set<string>): FunctionToolCall {
  if (!isRecord(value)) throw invalidRequest(param, 'invalid_parameter', 'A tool call must be an object.');
  for (const key of Object.keys(value)) {
    if (key !== 'id' && key !== 'type' && key !== 'function') {
      throw invalidRequest(`${param}.${key}`, 'unknown_parameter', `${key} is not a supported tool call field.`);
    }
  }
  if (value.type !== 'function') {
    throw invalidRequest(`${param}.type`, 'unsupported_parameter', 'Only function tool calls are supported.');
  }
  if (typeof value.id !== 'string' || !CALL_ID.test(value.id) || seen.has(value.id)) {
    throw invalidRequest(`${param}.id`, 'invalid_parameter', 'The tool call id is invalid.');
  }
  seen.add(value.id);
  if (!isRecord(value.function)) {
    throw invalidRequest(`${param}.function`, 'invalid_parameter', 'The function is missing.');
  }
  for (const key of Object.keys(value.function)) {
    if (key !== 'name' && key !== 'arguments') {
      throw invalidRequest(`${param}.function.${key}`, 'unknown_parameter', `${key} is not a supported function field.`);
    }
  }
  if (typeof value.function.name !== 'string' || !FUNCTION_NAME.test(value.function.name)) {
    throw invalidRequest(`${param}.function.name`, 'invalid_parameter', 'The function is missing.');
  }
  if (typeof value.function.arguments !== 'string' || !jsonObjectText(value.function.arguments)) {
    throw invalidRequest(`${param}.function.arguments`, 'invalid_parameter', 'Function arguments must be a JSON object.');
  }
  return {
    id: value.id,
    type: 'function',
    function: { name: value.function.name, arguments: value.function.arguments },
  };
}

function jsonObjectText(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ARGUMENTS) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function correlateToolMessages(messages: ChatMessage[], toolNames: Set<string> | null): void {
  const open = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if (open.size > 0) {
        throw invalidRequest(`messages[${index}]`, 'invalid_parameter', 'A tool call is still waiting for a result.');
      }
      if (toolNames === null) {
        throw invalidRequest('tools', 'invalid_parameter', 'tools is required when messages include a tool call.');
      }
      for (const call of message.tool_calls) {
        if (seen.has(call.id)) {
          throw invalidRequest(`messages[${index}].tool_calls`, 'invalid_parameter', 'The tool call id is invalid.');
        }
        seen.add(call.id);
        if (!toolNames.has(call.function.name)) {
          throw invalidRequest(`messages[${index}].tool_calls`, 'invalid_parameter', 'The function is missing.');
        }
        open.set(call.id, call.function.name);
      }
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      if (!open.has(id)) {
        throw invalidRequest(`messages[${index}].tool_call_id`, 'invalid_parameter', 'The tool result id does not match a tool call.');
      }
      open.delete(id);
      continue;
    }
    if (open.size > 0) {
      throw invalidRequest(`messages[${index}]`, 'invalid_parameter', 'A tool call is still waiting for a result.');
    }
  }
  if (open.size > 0) {
    throw invalidRequest('messages', 'invalid_parameter', 'A tool call is still waiting for a result.');
  }
}

function parseTools(value: unknown): FunctionTool[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS) {
    throw invalidRequest('tools', 'invalid_parameter', 'tools must contain from 1 to 32 function definitions.');
  }
  const names = new Set<string>();
  return value.map((item, index) => parseTool(item, index, names));
}

function parseTool(value: unknown, index: number, names: Set<string>): FunctionTool {
  const param = `tools[${index}]`;
  if (!isRecord(value)) throw invalidRequest(param, 'invalid_parameter', 'A tool must be an object.');
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'function') {
      throw invalidRequest(`${param}.${key}`, 'unknown_parameter', `${key} is not a supported tool field.`);
    }
  }
  if (value.type !== 'function' || !isRecord(value.function)) {
    throw invalidRequest(`${param}.function`, 'unsupported_parameter', 'Only function tools are supported.');
  }
  const fn = value.function;
  for (const key of Object.keys(fn)) {
    if (key !== 'name' && key !== 'description' && key !== 'parameters' && key !== 'strict') {
      throw invalidRequest(`${param}.function.${key}`, 'unknown_parameter', `${key} is not a supported function field.`);
    }
  }
  if (typeof fn.name !== 'string' || !FUNCTION_NAME.test(fn.name) || names.has(fn.name)) {
    throw invalidRequest(`${param}.function.name`, 'invalid_parameter', 'The function is missing.');
  }
  names.add(fn.name);
  const tool: FunctionTool = { type: 'function', function: { name: fn.name } };
  if ('description' in fn) {
    if (typeof fn.description !== 'string' || fn.description.length === 0 || fn.description.length > MAX_DESCRIPTION) {
      throw invalidRequest(`${param}.function.description`, 'invalid_parameter', 'The function description is invalid.');
    }
    tool.function.description = fn.description;
  }
  if ('strict' in fn) {
    if (fn.strict !== false) {
      throw invalidRequest(`${param}.function.strict`, 'unsupported_parameter', 'strict function tools are not supported.');
    }
    tool.function.strict = false;
  }
  if ('parameters' in fn) {
    const parameters = parseSchema(fn.parameters, `${param}.function.parameters`, 1, { nodes: 0 }, true);
    if (Buffer.byteLength(JSON.stringify(parameters), 'utf8') > MAX_SCHEMA_BYTES) {
      throw invalidRequest(`${param}.function.parameters`, 'invalid_parameter', 'The schema is too large.');
    }
    tool.function.parameters = parameters;
  }
  return tool;
}

function parseSchema(
  value: unknown,
  param: string,
  depth: number,
  state: { nodes: number },
  root: boolean,
): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) throw invalidRequest(param, 'invalid_parameter', 'The schema is too deep.');
  if (!isRecord(value)) throw invalidRequest(param, 'invalid_parameter', 'The schema must be an object.');
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) throw invalidRequest(param, 'invalid_parameter', 'The schema has too many nodes.');
  for (const key of Object.keys(value)) {
    if (!SCHEMA_KEYS.has(key)) {
      throw invalidRequest(param, 'unsupported_parameter', `${key} is not a supported schema keyword.`);
    }
  }
  if (typeof value.type !== 'string' || !SCHEMA_TYPES.has(value.type)) {
    throw invalidRequest(`${param}.type`, 'unsupported_parameter', 'The schema type is not supported.');
  }
  if (root && value.type !== 'object') {
    throw invalidRequest(`${param}.type`, 'unsupported_parameter', 'Function parameters must be an object schema.');
  }
  const schema: Record<string, unknown> = { type: value.type };
  if ('description' in value) {
    if (typeof value.description !== 'string' || value.description.length === 0 || value.description.length > 512) {
      throw invalidRequest(`${param}.description`, 'invalid_parameter', 'The schema description is invalid.');
    }
    schema.description = value.description;
  }
  if ('enum' in value) schema.enum = parseEnum(value.enum, param);
  if ('minimum' in value || 'maximum' in value) {
    if (value.type !== 'number' && value.type !== 'integer') {
      throw invalidRequest(param, 'unsupported_parameter', 'minimum and maximum require a numeric type.');
    }
    if ('minimum' in value) schema.minimum = schemaNumber(value.minimum, `${param}.minimum`);
    if ('maximum' in value) schema.maximum = schemaNumber(value.maximum, `${param}.maximum`);
  }
  if ('minLength' in value || 'maxLength' in value) {
    if (value.type !== 'string') throw invalidRequest(param, 'unsupported_parameter', 'Length limits require a string type.');
    if ('minLength' in value) schema.minLength = schemaBound(value.minLength, `${param}.minLength`);
    if ('maxLength' in value) schema.maxLength = schemaBound(value.maxLength, `${param}.maxLength`);
  }
  if ('minItems' in value || 'maxItems' in value) {
    if (value.type !== 'array') throw invalidRequest(param, 'unsupported_parameter', 'Item limits require an array type.');
    if ('minItems' in value) schema.minItems = schemaBound(value.minItems, `${param}.minItems`);
    if ('maxItems' in value) schema.maxItems = schemaBound(value.maxItems, `${param}.maxItems`);
  }
  if (value.type === 'array') {
    if (!('items' in value)) throw invalidRequest(`${param}.items`, 'invalid_parameter', 'An array schema needs items.');
    schema.items = parseSchema(value.items, `${param}.items`, depth + 1, state, false);
  } else if ('items' in value) {
    throw invalidRequest(`${param}.items`, 'unsupported_parameter', 'items requires an array type.');
  }
  if (value.type === 'object') {
    const properties = parseProperties(value.properties, `${param}.properties`, depth, state);
    if (properties !== undefined) schema.properties = properties;
    if ('required' in value) schema.required = parseRequired(value.required, properties, `${param}.required`);
    if ('additionalProperties' in value) {
      if (typeof value.additionalProperties !== 'boolean') {
        throw invalidRequest(`${param}.additionalProperties`, 'unsupported_parameter', 'additionalProperties must be a boolean.');
      }
      schema.additionalProperties = value.additionalProperties;
    }
  } else if ('properties' in value || 'required' in value || 'additionalProperties' in value) {
    throw invalidRequest(param, 'unsupported_parameter', 'Object keywords require an object type.');
  }
  return schema;
}

function parseProperties(
  value: unknown,
  param: string,
  depth: number,
  state: { nodes: number },
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidRequest(param, 'invalid_parameter', 'properties must be an object.');
  const names = Object.keys(value);
  if (names.length > MAX_PROPERTIES) throw invalidRequest(param, 'invalid_parameter', 'The schema has too many properties.');
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    if (!PROPERTY_NAME.test(name)) {
      throw invalidRequest(param, 'invalid_parameter', 'A property name is invalid.');
    }
    properties[name] = parseSchema(value[name], `${param}.${name}`, depth + 1, state, false);
  }
  return properties;
}

function parseRequired(value: unknown, properties: Record<string, unknown> | undefined, param: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROPERTIES) {
    throw invalidRequest(param, 'invalid_parameter', 'required must list property names.');
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !PROPERTY_NAME.test(item) || seen.has(item) || properties === undefined || !(item in properties)) {
      throw invalidRequest(param, 'invalid_parameter', 'required must list property names.');
    }
    seen.add(item);
  }
  return value as string[];
}

function parseEnum(value: unknown, param: string): Array<string | number | boolean | null> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENUM) {
    throw invalidRequest(`${param}.enum`, 'invalid_parameter', 'enum is invalid.');
  }
  const items: Array<string | number | boolean | null> = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.length === 0 || item.length > 128) throw invalidRequest(`${param}.enum`, 'invalid_parameter', 'enum is invalid.');
      items.push(item);
      continue;
    }
    if (typeof item === 'number') {
      items.push(schemaNumber(item, `${param}.enum`));
      continue;
    }
    if (typeof item === 'boolean' || item === null) {
      items.push(item);
      continue;
    }
    throw invalidRequest(`${param}.enum`, 'unsupported_parameter', 'enum values must be simple.');
  }
  return items;
}

function schemaNumber(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidRequest(param, 'invalid_parameter', 'The schema number is invalid.');
  }
  return value;
}

function schemaBound(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw invalidRequest(param, 'invalid_parameter', 'The schema limit is invalid.');
  }
  return value;
}

function parseToolChoice(value: unknown, toolNames: Set<string> | null): ToolChoice {
  if (toolNames === null) throw invalidRequest('tool_choice', 'invalid_parameter', 'tool_choice requires tools.');
  if (value === 'none' || value === 'auto' || value === 'required') return value;
  if (!isRecord(value)) throw invalidRequest('tool_choice', 'invalid_parameter', 'tool_choice is invalid.');
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'function') {
      throw invalidRequest(`tool_choice.${key}`, 'unknown_parameter', `${key} is not a supported tool_choice field.`);
    }
  }
  if (value.type !== 'function' || !isRecord(value.function)) {
    throw invalidRequest('tool_choice.function', 'unsupported_parameter', 'Only a function tool_choice is supported.');
  }
  for (const key of Object.keys(value.function)) {
    if (key !== 'name') {
      throw invalidRequest(`tool_choice.function.${key}`, 'unknown_parameter', `${key} is not a supported tool_choice field.`);
    }
  }
  if (typeof value.function.name !== 'string' || !toolNames.has(value.function.name)) {
    throw invalidRequest('tool_choice.function.name', 'invalid_parameter', 'The function is missing.');
  }
  return { type: 'function', function: { name: value.function.name } };
}

function parseOptional(key: string, value: unknown): unknown {
  if (key === 'temperature' || key === 'top_p' || key === 'presence_penalty' || key === 'frequency_penalty') {
    const max = key === 'top_p' ? 1 : key === 'temperature' ? 2 : 2;
    const min = key === 'temperature' || key === 'top_p' ? 0 : -2;
    const parsed = numberInRange(value, min, max);
    if (parsed === undefined) {
      throw invalidRequest(key, 'invalid_parameter', `${key} is outside the supported range.`);
    }
    return parsed;
  }
  if (key === 'max_tokens' || key === 'max_completion_tokens') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 128_000) {
      throw invalidRequest(key, 'invalid_parameter', `${key} must be an integer from 1 to 128000.`);
    }
    return value;
  }
  if (key === 'seed') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw invalidRequest(key, 'invalid_parameter', 'seed must be an integer.');
    }
    return value;
  }
  if (key === 'n') {
    if (value !== 1) throw invalidRequest('n', 'unsupported_parameter', 'Only one completion is supported.');
    return 1;
  }
  if (key === 'user') {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
      throw invalidRequest('user', 'invalid_parameter', 'user must be a short text string.');
    }
    return value;
  }
  if (key === 'stop') return parseStop(value);
  if (key === 'response_format') return parseResponseFormat(value);
  if (key === 'parallel_tool_calls') {
    if (typeof value !== 'boolean') {
      throw invalidRequest('parallel_tool_calls', 'invalid_parameter', 'parallel_tool_calls must be a boolean.');
    }
    return value;
  }
  throw invalidRequest(key, 'unknown_parameter', `${key} is not a supported parameter.`);
}

function parseStop(value: unknown): string | string[] {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)) {
    return value;
  }
  throw invalidRequest('stop', 'invalid_parameter', 'stop must be a string or up to four strings.');
}

function parseResponseFormat(value: unknown): { type: 'text' } {
  if (!isRecord(value)) {
    throw invalidRequest('response_format', 'unsupported_response_format', 'response_format is not supported.');
  }
  const extra = Object.keys(value).filter((key) => key !== 'type');
  if (extra.length > 0) {
    throw invalidRequest('response_format', 'unsupported_response_format', 'Only text response_format is supported.');
  }
  if (value.type !== 'text') {
    throw invalidRequest('response_format', 'unsupported_response_format', 'Only text response_format is supported.');
  }
  return { type: 'text' };
}

export function assertCapabilities(request: ChatRequest, capabilities: readonly string[]): void {
  for (const key of Object.keys(request.optional)) {
    const capability = key === 'response_format' ? 'response_format_text' : key;
    if (!capabilities.includes(capability)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported by this model.`);
    }
  }
}

export function isProxyError(error: unknown): error is ProxyError {
  return error instanceof ProxyError;
}
