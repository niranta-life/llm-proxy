import { invalidRequest } from './errors.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';

export const VALIDATOR_IDS = [
  'json_parse',
  'json_schema',
  'required_fields',
  'exact_label',
  'accepted_labels',
  'reference_fields',
  'format_length',
] as const;

export type ValidatorId = (typeof VALIDATOR_IDS)[number];
export type ValidatorResultState = 'pass' | 'fail' | 'not_applicable' | 'unknown';

export type ValidatorOutcome = {
  validatorId: ValidatorId;
  version: number;
  result: ValidatorResultState;
  measured: Record<string, unknown>;
  evidenceCode: string;
  errorClassification: string | null;
  referencePresent: boolean;
};

type Limits = {
  maxInputChars: number;
  timeBudgetMs: number;
  maxSchemaDepth: number;
  maxSchemaNodes: number;
};

type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

type ValidatorSpec =
  | { id: 'json_parse'; version: 1 }
  | { id: 'json_schema'; version: 1; schema: JsonSchema }
  | { id: 'required_fields'; version: 1; fields: string[] }
  | { id: 'exact_label'; version: 1; field: string }
  | { id: 'accepted_labels'; version: 1; field: string; labels: string[] }
  | { id: 'reference_fields'; version: 1; fields: string[] }
  | { id: 'format_length'; version: 1; minChars: number; maxChars: number };

export type ProfileConfig = {
  limits: Limits;
  validators: ValidatorSpec[];
};

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LABEL = /^[A-Za-z0-9_ .:-]{1,64}$/;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const BANNED_KEYS = new Set(['prompt', 'messages', 'content', 'ciphertext', '__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectConfig(): never {
  throw invalidRequest('config', 'invalid_parameter', 'The validator configuration is invalid.');
}

function rejectReference(): never {
  throw invalidRequest('reference', 'invalid_parameter', 'The reference is invalid.');
}

function assertClosed(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (key.includes('$') || BANNED_KEYS.has(key) || !allowed.includes(key)) rejectConfig();
  }
}

function assertSafeString(value: string): void {
  if (value.includes('://') || value.includes('$ref') || value.includes('\u0000')) rejectConfig();
}

function walkRemote(value: unknown, depth: number): void {
  if (depth > 8) rejectConfig();
  if (typeof value === 'string') {
    assertSafeString(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 32) rejectConfig();
    for (const entry of value) walkRemote(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) rejectConfig();
  const keys = Object.keys(value);
  if (keys.length > 32) rejectConfig();
  for (const key of keys) {
    if (key.includes('$') || BANNED_KEYS.has(key)) rejectConfig();
    walkRemote(value[key], depth + 1);
  }
}

function readFieldName(value: unknown): string {
  if (typeof value !== 'string' || !FIELD.test(value)) rejectConfig();
  return value;
}

function readFieldList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) rejectConfig();
  const fields: string[] = [];
  for (const entry of value) {
    const field = readFieldName(entry);
    if (fields.includes(field)) rejectConfig();
    fields.push(field);
  }
  return fields;
}

function readInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) rejectConfig();
  return value;
}

function parseSchema(value: unknown, depth: number, nodes: { count: number }, limits: Limits): JsonSchema {
  nodes.count += 1;
  if (nodes.count > limits.maxSchemaNodes || depth > limits.maxSchemaDepth) rejectConfig();
  if (!isRecord(value)) rejectConfig();
  assertClosed(value, [
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
  ]);
  const schema: JsonSchema = {};
  if (typeof value.type !== 'string' || !SCHEMA_TYPES.has(value.type)) rejectConfig();
  schema.type = value.type as JsonSchema['type'];
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) rejectConfig();
    const properties: Record<string, JsonSchema> = {};
    const names = Object.keys(value.properties);
    if (names.length > 32) rejectConfig();
    for (const name of names) {
      if (!FIELD.test(name)) rejectConfig();
      const child = value.properties[name];
      properties[name] = parseSchema(child, depth + 1, nodes, limits);
    }
    schema.properties = properties;
  }
  if (value.required !== undefined) schema.required = readFieldList(value.required);
  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties !== 'boolean') rejectConfig();
    schema.additionalProperties = value.additionalProperties;
  }
  if (value.items !== undefined) schema.items = parseSchema(value.items, depth + 1, nodes, limits);
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 32) rejectConfig();
    const literals: unknown[] = [];
    for (const entry of value.enum) {
      if (typeof entry === 'string') {
        if (!LABEL.test(entry)) rejectConfig();
        assertSafeString(entry);
      } else if (typeof entry === 'number') {
        if (!Number.isFinite(entry)) rejectConfig();
      } else if (typeof entry !== 'boolean' && entry !== null) {
        rejectConfig();
      }
      literals.push(entry);
    }
    schema.enum = literals;
  }
  if (value.minLength !== undefined) schema.minLength = readInteger(value.minLength, 0, 65536);
  if (value.maxLength !== undefined) schema.maxLength = readInteger(value.maxLength, 0, 65536);
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) rejectConfig();
  if (value.minimum !== undefined) {
    if (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum)) rejectConfig();
    schema.minimum = value.minimum;
  }
  if (value.maximum !== undefined) {
    if (typeof value.maximum !== 'number' || !Number.isFinite(value.maximum)) rejectConfig();
    schema.maximum = value.maximum;
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) rejectConfig();
  if (value.minItems !== undefined) schema.minItems = readInteger(value.minItems, 0, 32);
  if (value.maxItems !== undefined) schema.maxItems = readInteger(value.maxItems, 0, 32);
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) rejectConfig();
  return schema;
}

function parseLimits(value: unknown): Limits {
  if (!isRecord(value)) rejectConfig();
  assertClosed(value, ['maxInputChars', 'timeBudgetMs', 'maxSchemaDepth', 'maxSchemaNodes']);
  return {
    maxInputChars: readInteger(value.maxInputChars, 1, 65536),
    timeBudgetMs: readInteger(value.timeBudgetMs, 0, 1000),
    maxSchemaDepth: readInteger(value.maxSchemaDepth, 1, 8),
    maxSchemaNodes: readInteger(value.maxSchemaNodes, 1, 200),
  };
}

function parseValidator(value: unknown, limits: Limits): ValidatorSpec {
  if (!isRecord(value) || typeof value.id !== 'string' || !VALIDATOR_IDS.includes(value.id as ValidatorId)) rejectConfig();
  if (value.version !== 1) rejectConfig();
  const id = value.id as ValidatorId;
  if (id === 'json_parse') {
    assertClosed(value, ['id', 'version']);
    return { id, version: 1 };
  }
  if (id === 'json_schema') {
    assertClosed(value, ['id', 'version', 'schema']);
    return { id, version: 1, schema: parseSchema(value.schema, 1, { count: 0 }, limits) };
  }
  if (id === 'required_fields') {
    assertClosed(value, ['id', 'version', 'fields']);
    return { id, version: 1, fields: readFieldList(value.fields) };
  }
  if (id === 'exact_label') {
    assertClosed(value, ['id', 'version', 'field']);
    return { id, version: 1, field: readFieldName(value.field) };
  }
  if (id === 'accepted_labels') {
    assertClosed(value, ['id', 'version', 'field', 'labels']);
    if (!Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 32) rejectConfig();
    const labels: string[] = [];
    for (const entry of value.labels) {
      if (typeof entry !== 'string' || !LABEL.test(entry)) rejectConfig();
      assertSafeString(entry);
      if (labels.includes(entry)) rejectConfig();
      labels.push(entry);
    }
    return { id, version: 1, field: readFieldName(value.field), labels };
  }
  if (id === 'reference_fields') {
    assertClosed(value, ['id', 'version', 'fields']);
    return { id, version: 1, fields: readFieldList(value.fields) };
  }
  assertClosed(value, ['id', 'version', 'minChars', 'maxChars']);
  const minChars = readInteger(value.minChars, 0, 65536);
  const maxChars = readInteger(value.maxChars, 0, 65536);
  if (minChars > maxChars || maxChars > limits.maxInputChars) rejectConfig();
  return { id: 'format_length', version: 1, minChars, maxChars };
}

export function parseProfileConfig(value: unknown): ProfileConfig {
  if (!isRecord(value)) rejectConfig();
  const encoded = JSON.stringify(value);
  if (encoded.length > 16384 || encoded.includes('://') || encoded.includes('$ref')) rejectConfig();
  assertClosed(value, ['limits', 'validators']);
  const limits = parseLimits(value.limits);
  if (!Array.isArray(value.validators) || value.validators.length < 1 || value.validators.length > 16) rejectConfig();
  const validators: ValidatorSpec[] = [];
  const seen = new Set<string>();
  for (const entry of value.validators) {
    const spec = parseValidator(entry, limits);
    if (seen.has(spec.id)) rejectConfig();
    seen.add(spec.id);
    validators.push(spec);
  }
  walkRemote(value, 0);
  return { limits, validators };
}

export function parseTrustedReference(value: unknown): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 4096 || encoded.includes('://') || encoded.includes('$ref')) rejectReference();
  if (!isRecord(value)) rejectReference();
  assertReference(value, 0);
  return value;
}

function assertReference(value: unknown, depth: number): void {
  if (depth > 8) rejectReference();
  if (typeof value === 'string') {
    if (value.length > 256 || value.includes('://') || value.includes('\u0000')) rejectReference();
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) rejectReference();
    return;
  }
  if (typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 32) rejectReference();
    for (const entry of value) assertReference(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) rejectReference();
  const keys = Object.keys(value);
  if (keys.length > 32) rejectReference();
  for (const key of keys) {
    if (!FIELD.test(key) || BANNED_KEYS.has(key)) rejectReference();
    assertReference(value[key], depth + 1);
  }
}

export function parseProfileTask(value: unknown): TaskCategory {
  if (typeof value !== 'string' || !isTaskCategory(value)) {
    throw invalidRequest('task_category', 'invalid_parameter', 'taskCategory is invalid.');
  }
  return value;
}

function outcome(
  spec: ValidatorSpec,
  result: ValidatorResultState,
  evidenceCode: string,
  referencePresent: boolean,
  measured: Record<string, unknown> = {},
  errorClassification: string | null = null,
): ValidatorOutcome {
  return {
    validatorId: spec.id,
    version: spec.version,
    result,
    measured,
    evidenceCode,
    errorClassification,
    referencePresent,
  };
}

function timedOut(limits: Limits, started: number): boolean {
  if (limits.timeBudgetMs === 0) return true;
  return Date.now() - started >= limits.timeBudgetMs;
}

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

const MAX_COMPARE_DEPTH = 8;

type OrderedJson = { limited: true } | { limited: false; value: unknown };

function compareLimit(limits: Limits): number {
  const configured = limits.maxSchemaDepth;
  if (!Number.isInteger(configured) || configured < 1) return 1;
  return configured > MAX_COMPARE_DEPTH ? MAX_COMPARE_DEPTH : configured;
}

function sameJson(left: unknown, right: unknown, maxDepth: number): boolean | 'limited' {
  const orderedLeft = orderJson(left, 0, maxDepth);
  if (orderedLeft.limited) return 'limited';
  const orderedRight = orderJson(right, 0, maxDepth);
  if (orderedRight.limited) return 'limited';
  return JSON.stringify(orderedLeft.value) === JSON.stringify(orderedRight.value);
}

function orderJson(value: unknown, depth: number, maxDepth: number): OrderedJson {
  if (depth > maxDepth) return { limited: true };
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const entry of value) {
      const child = orderJson(entry, depth + 1, maxDepth);
      if (child.limited) return child;
      items.push(child.value);
    }
    return { limited: false, value: items };
  }
  if (!isRecord(value)) return { limited: false, value };
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = orderJson(value[key], depth + 1, maxDepth);
    if (child.limited) return child;
    ordered[key] = child.value;
  }
  return { limited: false, value: ordered };
}

type WalkState = { count: number; limited: boolean; depthLimited: boolean; violations: number };

function schemaHolds(data: unknown, schema: JsonSchema, depth: number, limits: Limits, state: WalkState): void {
  state.count += 1;
  if (state.count > limits.maxSchemaNodes || depth > compareLimit(limits)) {
    state.limited = true;
    return;
  }
  if (state.violations >= 20) return;
  if (schema.enum !== undefined) {
    let matched = false;
    for (const entry of schema.enum) {
      const compared = sameJson(entry, data, compareLimit(limits));
      if (compared === 'limited') {
        state.limited = true;
        state.depthLimited = true;
        return;
      }
      if (compared) {
        matched = true;
        break;
      }
    }
    if (!matched) state.violations += 1;
  }
  if (schema.type === 'object') {
    if (!isRecord(data)) {
      state.violations += 1;
      return;
    }
    const keys = Object.keys(data);
    if (schema.required !== undefined) {
      for (const field of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(data, field)) state.violations += 1;
      }
    }
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      for (const key of keys) {
        if (schema.properties[key] === undefined) state.violations += 1;
      }
    }
    if (schema.properties !== undefined) {
      for (const key of keys) {
        const child = schema.properties[key];
        if (child !== undefined && Object.prototype.hasOwnProperty.call(data, key)) {
          schemaHolds(data[key], child, depth + 1, limits, state);
          if (state.limited) return;
        }
      }
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      state.violations += 1;
      return;
    }
    if (schema.minItems !== undefined && data.length < schema.minItems) state.violations += 1;
    if (schema.maxItems !== undefined && data.length > schema.maxItems) state.violations += 1;
    if (schema.items !== undefined) {
      for (const entry of data) {
        schemaHolds(entry, schema.items, depth + 1, limits, state);
        if (state.limited) return;
      }
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof data !== 'string') {
      state.violations += 1;
      return;
    }
    if (schema.minLength !== undefined && data.length < schema.minLength) state.violations += 1;
    if (schema.maxLength !== undefined && data.length > schema.maxLength) state.violations += 1;
    return;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof data !== 'number' || !Number.isFinite(data) || (schema.type === 'integer' && !Number.isInteger(data))) {
      state.violations += 1;
      return;
    }
    if (schema.minimum !== undefined && data < schema.minimum) state.violations += 1;
    if (schema.maximum !== undefined && data > schema.maximum) state.violations += 1;
    return;
  }
  if (schema.type === 'boolean' && typeof data !== 'boolean') state.violations += 1;
  if (schema.type === 'null' && data !== null) state.violations += 1;
}

function labelOf(parsed: unknown, field: string): { applicable: true; value: unknown } | { applicable: false } {
  if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, field)) return { applicable: false };
  return { applicable: true, value: parsed[field] };
}

function runOne(
  spec: ValidatorSpec,
  text: string,
  reference: Record<string, unknown> | null,
  referencePresent: boolean,
  limits: Limits,
  started: number,
): ValidatorOutcome {
  if (timedOut(limits, started)) {
    return outcome(spec, 'unknown', 'validator_timeout', referencePresent, { timeBudgetMs: limits.timeBudgetMs }, 'timeout');
  }
  if (text.length > limits.maxInputChars) {
    return outcome(spec, 'unknown', 'validator_size', referencePresent, { maxInputChars: limits.maxInputChars }, 'size_exceeded');
  }
  if (spec.id === 'format_length') {
    const chars = text.length;
    if (chars < spec.minChars) return outcome(spec, 'fail', 'length_short', referencePresent, { chars, minChars: spec.minChars });
    if (chars > spec.maxChars) return outcome(spec, 'fail', 'length_exceeded', referencePresent, { chars, maxChars: spec.maxChars });
    return outcome(spec, 'pass', 'length_within', referencePresent, { chars });
  }
  if (spec.id === 'json_parse') {
    const parsed = parseJson(text);
    if (timedOut(limits, started)) {
      return outcome(spec, 'unknown', 'validator_timeout', referencePresent, { timeBudgetMs: limits.timeBudgetMs }, 'timeout');
    }
    if (parsed === null) return outcome(spec, 'fail', 'json_invalid', referencePresent, { parsed: false }, 'parse_error');
    return outcome(spec, 'pass', 'json_parsed', referencePresent, { parsed: true });
  }
  const parsed = parseJson(text);
  if (timedOut(limits, started)) {
    return outcome(spec, 'unknown', 'validator_timeout', referencePresent, { timeBudgetMs: limits.timeBudgetMs }, 'timeout');
  }
  if (spec.id === 'exact_label' || spec.id === 'reference_fields') {
    if (!referencePresent || reference === null) return outcome(spec, 'unknown', 'reference_absent', false);
  }
  if (parsed === null) {
    if (spec.id === 'json_schema') return outcome(spec, 'not_applicable', 'not_json', referencePresent);
    if (spec.id === 'required_fields' || spec.id === 'reference_fields') {
      return outcome(spec, 'not_applicable', 'not_object', referencePresent);
    }
    return outcome(spec, 'not_applicable', 'label_shape', referencePresent);
  }
  if (spec.id === 'json_schema') {
    const state: WalkState = { count: 0, limited: false, depthLimited: false, violations: 0 };
    schemaHolds(parsed.value, spec.schema, 1, limits, state);
    if (state.limited) {
      const measured = state.depthLimited
        ? { maxSchemaDepth: compareLimit(limits) }
        : { maxSchemaNodes: limits.maxSchemaNodes };
      return outcome(spec, 'unknown', 'validator_size', referencePresent, measured, 'size_exceeded');
    }
    if (state.violations > 0) return outcome(spec, 'fail', 'schema_violation', referencePresent, { violations: state.violations });
    return outcome(spec, 'pass', 'schema_valid', referencePresent, { violations: 0 });
  }
  if (spec.id === 'required_fields') {
    if (!isRecord(parsed.value)) return outcome(spec, 'not_applicable', 'not_object', referencePresent);
    const missing = spec.fields.filter((field) => !Object.prototype.hasOwnProperty.call(parsed.value, field));
    if (missing.length > 0) return outcome(spec, 'fail', 'field_missing', referencePresent, { missing });
    return outcome(spec, 'pass', 'fields_present', referencePresent, { present: spec.fields.length });
  }
  if (spec.id === 'exact_label') {
    const label = labelOf(parsed.value, spec.field);
    if (!label.applicable) return outcome(spec, 'not_applicable', 'label_shape', referencePresent);
    if (reference === null || !Object.prototype.hasOwnProperty.call(reference, spec.field)) {
      return outcome(spec, 'unknown', 'reference_field_absent', referencePresent);
    }
    const compared = sameJson(label.value, reference[spec.field], compareLimit(limits));
    if (compared === 'limited') return depthLimited(spec, referencePresent, limits);
    if (compared) return outcome(spec, 'pass', 'label_match', referencePresent, { matched: true });
    return outcome(spec, 'fail', 'label_mismatch', referencePresent, { matched: false });
  }
  if (spec.id === 'accepted_labels') {
    const label = labelOf(parsed.value, spec.field);
    if (!label.applicable || typeof label.value !== 'string') return outcome(spec, 'not_applicable', 'label_shape', referencePresent);
    if (spec.labels.includes(label.value)) return outcome(spec, 'pass', 'label_accepted', referencePresent, { member: true });
    return outcome(spec, 'fail', 'label_rejected', referencePresent, { member: false });
  }
  if (!isRecord(parsed.value)) return outcome(spec, 'not_applicable', 'not_object', referencePresent);
  const document = parsed.value;
  if (reference === null) return outcome(spec, 'unknown', 'reference_absent', false);
  const comparable = spec.fields.filter((field) => Object.prototype.hasOwnProperty.call(reference, field));
  if (comparable.length === 0) return outcome(spec, 'unknown', 'reference_field_absent', referencePresent);
  const mismatched: string[] = [];
  for (const field of comparable) {
    if (!Object.prototype.hasOwnProperty.call(document, field)) {
      mismatched.push(field);
      continue;
    }
    const compared = sameJson(document[field], reference[field], compareLimit(limits));
    if (compared === 'limited') return depthLimited(spec, referencePresent, limits);
    if (!compared) mismatched.push(field);
  }
  if (mismatched.length > 0) return outcome(spec, 'fail', 'field_mismatch', referencePresent, { mismatched });
  return outcome(spec, 'pass', 'fields_match', referencePresent, { compared: comparable.length });
}

function depthLimited(spec: ValidatorSpec, referencePresent: boolean, limits: Limits): ValidatorOutcome {
  return outcome(spec, 'unknown', 'validator_size', referencePresent, { maxSchemaDepth: compareLimit(limits) }, 'size_exceeded');
}

export function runProfileValidators(input: {
  config: ProfileConfig;
  text: string | null;
  reference: Record<string, unknown> | null;
  referencePresent: boolean;
  incompatible: boolean;
}): ValidatorOutcome[] {
  if (input.incompatible) {
    return input.config.validators.map((spec) =>
      outcome(spec, 'not_applicable', 'profile_incompatible', input.referencePresent),
    );
  }
  return input.config.validators.map((spec) => {
    const started = Date.now();
    if (input.text === null) return outcome(spec, 'unknown', 'output_unreadable', input.referencePresent, {}, 'output_unreadable');
    return runOne(spec, input.text, input.reference, input.referencePresent, input.config.limits, started);
  });
}
