import { invalidRequest, proxyError } from './errors.js';
import { loopbackHost, parseStoredPrivateEndpoint } from './private.js';

export const EMBEDDING_ADAPTER_VERSION = 1;
export const MAX_EMBEDDING_INPUTS = 32;
export const MAX_EMBEDDING_CHARS = 8192;
export const MAX_EMBEDDING_DIMENSION = 4096;
export const L2_TOLERANCE = 1e-3;

const REQUEST_KEYS = new Set(['model', 'input', 'encoding_format', 'dimensions']);

const OPENAI_MODELS: Record<string, { maxDimension: number; exactDimension?: number; sendDimensions: boolean }> = {
  'text-embedding-3-small': { maxDimension: 1536, sendDimensions: true },
  'text-embedding-3-large': { maxDimension: 3072, sendDimensions: true },
  'text-embedding-ada-002': { maxDimension: 1536, exactDimension: 1536, sendDimensions: false },
};

const VERTEX_MODELS: Record<string, { maxDimension: number }> = {
  'text-embedding-004': { maxDimension: 768 },
  'text-embedding-005': { maxDimension: 768 },
  'gemini-embedding-001': { maxDimension: 3072 },
};

export type EmbeddingEncoding = 'float' | 'base64';
export type EmbeddingNormalization = 'none' | 'l2';

export type EmbeddingRequest = {
  model: string;
  inputs: string[];
  encoding: EmbeddingEncoding;
  dimensions: number | null;
};

export type EmbeddingContractPin = {
  version: number;
  model: string;
  dimension: number;
  normalization: EmbeddingNormalization;
};

export type CheckedVector = {
  index: number;
  values: number[];
  encoded: number[] | string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidUpstream(message = 'The embedding response is invalid.'): never {
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, message);
}

export function parseEmbeddingRequest(body: unknown): EmbeddingRequest {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_request', 'The request is invalid.');
  for (const key of Object.keys(body)) {
    if (!REQUEST_KEYS.has(key)) throw invalidRequest(key, 'unsupported_parameter', 'The request is invalid.');
  }
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw invalidRequest('model', 'invalid_request', 'The request is invalid.');
  }
  return {
    model: body.model,
    inputs: parseInputs(body.input),
    encoding: parseEncoding(body.encoding_format),
    dimensions: parseDimensions(body.dimensions),
  };
}

function parseInputs(value: unknown): string[] {
  if (value === undefined) throw invalidRequest('input', 'invalid_request', 'The input is empty.');
  if (typeof value === 'string') return [requireText(value)];
  if (!Array.isArray(value)) throw invalidRequest('input', 'invalid_request', 'The request is invalid.');
  if (value.length === 0) throw invalidRequest('input', 'invalid_request', 'The input is empty.');
  if (value.length > MAX_EMBEDDING_INPUTS) {
    throw invalidRequest('input', 'invalid_request', 'The input batch is too long.');
  }
  return value.map((item) => {
    if (typeof item !== 'string') throw invalidRequest('input', 'invalid_request', 'The request is invalid.');
    return requireText(item);
  });
}

function requireText(value: string): string {
  if (value.length === 0) throw invalidRequest('input', 'invalid_request', 'The input is empty.');
  if (value.length > MAX_EMBEDDING_CHARS) throw invalidRequest('input', 'invalid_request', 'The input is too long.');
  return value;
}

function parseEncoding(value: unknown): EmbeddingEncoding {
  if (value === undefined) return 'float';
  if (value === 'float' || value === 'base64') return value;
  throw invalidRequest('encoding_format', 'unsupported_parameter', 'The encoding is not supported.');
}

function parseDimensions(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_EMBEDDING_DIMENSION) {
    throw invalidRequest('dimensions', 'invalid_request', 'The dimension is invalid.');
  }
  return value;
}

export function privateEmbeddingReady(endpoint: string | null | undefined, validationStatus: string | undefined): boolean {
  if (validationStatus !== 'validated_mock' || endpoint === null || endpoint === undefined) return false;
  const parsed = parseStoredPrivateEndpoint(endpoint);
  if (parsed === undefined) return false;
  return loopbackHost(parsed.hostname.toLowerCase());
}

export function assertEmbeddingProvider(provider: string, endpoint: string | null, validationStatus: string | undefined): void {
  if (provider !== 'openai' && provider !== 'vertex' && provider !== 'dgx') {
    throw invalidRequest('model', 'unsupported_parameter', 'embeddings is not supported.');
  }
  if (provider === 'dgx' && !privateEmbeddingReady(endpoint, validationStatus)) {
    throw invalidRequest('model', 'invalid_request', 'A live private host does not receive embeddings.');
  }
}

export function assertEncodingForProvider(encoding: EmbeddingEncoding, provider: string): void {
  if (encoding === 'base64' && provider !== 'openai') {
    throw invalidRequest('encoding_format', 'unsupported_parameter', 'The encoding is not supported.');
  }
}

export function assertApprovedSpace(provider: string, model: string, dimension: number): { sendDimensions: boolean } {
  if (provider === 'dgx') return { sendDimensions: true };
  if (provider === 'openai') {
    const spec = OPENAI_MODELS[model];
    if (spec === undefined) throw invalidRequest('model', 'invalid_request', 'The embedding model is not approved.');
    if (spec.exactDimension !== undefined && dimension !== spec.exactDimension) {
      throw invalidRequest('dimensions', 'invalid_request', 'The dimension is invalid.');
    }
    if (dimension < 1 || dimension > spec.maxDimension) {
      throw invalidRequest('dimensions', 'invalid_request', 'The dimension is invalid.');
    }
    return { sendDimensions: spec.sendDimensions };
  }
  if (provider === 'vertex') {
    const spec = VERTEX_MODELS[model];
    if (spec === undefined) throw invalidRequest('model', 'invalid_request', 'The embedding model is not approved.');
    if (dimension < 1 || dimension > spec.maxDimension) {
      throw invalidRequest('dimensions', 'invalid_request', 'The dimension is invalid.');
    }
    return { sendDimensions: true };
  }
  throw invalidRequest('model', 'invalid_request', 'The embedding model is not approved.');
}

export function assertRequestedDimension(requested: number | null, pinned: number): void {
  if (requested !== null && requested !== pinned) {
    throw invalidRequest('dimensions', 'invalid_request', 'The dimension does not match the contract.');
  }
}

export function vectorLength(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum);
}

export function matchesNormalization(values: readonly number[], policy: EmbeddingNormalization): boolean {
  if (policy === 'none') return true;
  return Math.abs(vectorLength(values) - 1) <= L2_TOLERANCE;
}

export function decodeBase64Float32(encoded: string, dimension: number): number[] {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) invalidUpstream();
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length !== dimension * 4) invalidUpstream('The vector space does not match the contract.');
  const values: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    const value = buffer.readFloatLE(index * 4);
    if (!Number.isFinite(value)) invalidUpstream();
    values.push(value);
  }
  return values;
}

export function checkVectors(input: {
  count: number;
  dimension: number;
  normalization: EmbeddingNormalization;
  items: CheckedVector[];
}): CheckedVector[] {
  if (input.items.length !== input.count) invalidUpstream();
  const byIndex = new Map<number, CheckedVector>();
  for (const item of input.items) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.count || byIndex.has(item.index)) {
      invalidUpstream();
    }
    if (item.values.length !== input.dimension) invalidUpstream('The vector space does not match the contract.');
    if (item.values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) invalidUpstream();
    if (!matchesNormalization(item.values, input.normalization)) {
      invalidUpstream('The vector space does not match the contract.');
    }
    byIndex.set(item.index, item);
  }
  return Array.from({ length: input.count }, (_, index) => {
    const item = byIndex.get(index);
    if (item === undefined) invalidUpstream();
    return item;
  });
}

function readUsage(value: unknown): { prompt: number; total: number } {
  if (!isRecord(value)) invalidUpstream();
  const prompt = value.prompt_tokens;
  const total = value.total_tokens;
  if (
    typeof prompt !== 'number' ||
    typeof total !== 'number' ||
    !Number.isInteger(prompt) ||
    !Number.isInteger(total) ||
    prompt < 0 ||
    total < 0 ||
    total !== prompt
  ) {
    invalidUpstream();
  }
  return { prompt, total };
}

function assertReportedModel(payload: Record<string, unknown>, expected: string): void {
  if (!('model' in payload) || payload.model === undefined || payload.model === null) return;
  if (payload.model !== expected) {
    throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The embedding model changed.');
  }
}

function readFloatList(value: unknown): number[] {
  if (!Array.isArray(value)) invalidUpstream();
  return value.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) invalidUpstream();
    return item;
  });
}

export function readOpenAiEmbeddings(
  payload: unknown,
  encoding: EmbeddingEncoding,
  dimension: number,
  expectedModel: string,
): { items: CheckedVector[]; usage: { prompt: number; total: number } } {
  if (!isRecord(payload) || !Array.isArray(payload.data)) invalidUpstream();
  assertReportedModel(payload, expectedModel);
  const items = payload.data.map((entry) => {
    if (!isRecord(entry) || typeof entry.index !== 'number' || !Number.isInteger(entry.index)) invalidUpstream();
    if (encoding === 'base64') {
      if (typeof entry.embedding !== 'string') invalidUpstream();
      return {
        index: entry.index,
        values: decodeBase64Float32(entry.embedding, dimension),
        encoded: entry.embedding,
      };
    }
    const values = readFloatList(entry.embedding);
    return { index: entry.index, values, encoded: values };
  });
  return { items, usage: readUsage(payload.usage) };
}

export function readVertexEmbeddings(payload: unknown): { items: CheckedVector[]; usage: { prompt: number; total: number } } {
  if (!isRecord(payload) || !Array.isArray(payload.embeddings)) invalidUpstream();
  let prompt = 0;
  const items = payload.embeddings.map((entry, index) => {
    if (!isRecord(entry)) invalidUpstream();
    const stats = entry.statistics;
    if (isRecord(stats) && stats.truncated === true) invalidUpstream('The vector space does not match the contract.');
    if (!isRecord(stats) || typeof stats.tokenCount !== 'number' || !Number.isInteger(stats.tokenCount) || stats.tokenCount < 0) {
      invalidUpstream();
    }
    prompt += stats.tokenCount;
    const values = readFloatList(entry.values);
    return { index, values, encoded: values };
  });
  if (!Number.isSafeInteger(prompt)) invalidUpstream();
  return { items, usage: { prompt, total: prompt } };
}

export function embeddingResponse(
  model: string,
  vectors: readonly CheckedVector[],
  usage: { prompt: number; total: number },
): {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] | string }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
} {
  return {
    object: 'list',
    data: vectors.map((vector) => ({
      object: 'embedding',
      index: vector.index,
      embedding: vector.encoded,
    })),
    model,
    usage: {
      prompt_tokens: usage.prompt,
      total_tokens: usage.total,
    },
  };
}
