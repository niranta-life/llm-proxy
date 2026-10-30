import { createHash } from 'node:crypto';
import { invalidRequest } from './errors.js';
import { isTaskCategory } from './task-categories.js';

export const ROUTING_STATUSES = ['draft', 'validated', 'shadow', 'disabled'] as const;
export type RoutingStatus = (typeof ROUTING_STATUSES)[number];

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RATE = /^(?:0|1)(?:\.0+)?$|^(?:0\.\d{1,5})$/;
const COST = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,8})?$/;

export type RoutingWrite = {
  name: string;
  alias: 'auto';
  baselineDeployment: string;
  candidateDeployments: readonly string[];
  qualityMinPassRate: string;
  qualityMinValidPairs: number;
  maxCostPerRequest: string;
  maxLatencyMs: number;
  taskSegments: readonly string[];
};

export function routingRequestHash(write: RoutingWrite): string {
  return createHash('sha256').update(canonicalWrite(write)).digest('hex');
}

export function routingConfigDigest(input: {
  alias: 'auto';
  baselineDeploymentId: string;
  candidateDeploymentIds: readonly string[];
  qualityMinPassRate: string;
  qualityMinValidPairs: number;
  maxCostPerRequest: string;
  maxLatencyMs: number;
  taskSegments: readonly string[];
}): string {
  const body = JSON.stringify({
    alias: input.alias,
    baselineDeploymentId: input.baselineDeploymentId,
    candidateDeploymentIds: [...input.candidateDeploymentIds].sort(),
    qualityMinPassRate: input.qualityMinPassRate,
    qualityMinValidPairs: input.qualityMinValidPairs,
    maxCostPerRequest: input.maxCostPerRequest,
    maxLatencyMs: input.maxLatencyMs,
    taskSegments: [...input.taskSegments].sort(),
  });
  return createHash('sha256').update(body).digest('hex');
}

export function parseRoutingWrite(body: unknown): RoutingWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The policy body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set([
    'name',
    'alias',
    'baselineDeployment',
    'candidateDeployments',
    'qualityMinPassRate',
    'qualityMinValidPairs',
    'maxCostPerRequest',
    'maxLatencyMs',
    'taskSegments',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The policy body is invalid.');
  }
  if (typeof record.name !== 'string' || !NAME.test(record.name)) {
    throw invalidRequest('name', 'invalid_parameter', 'name is invalid.');
  }
  if (record.alias !== 'auto') throw invalidRequest('alias', 'unknown_alias', 'alias is invalid.');
  const baselineDeployment = deploymentName(record.baselineDeployment, 'baselineDeployment');
  const candidateDeployments = deploymentList(record.candidateDeployments);
  const qualityMinPassRate = rate(record.qualityMinPassRate);
  const qualityMinValidPairs = integerField(record.qualityMinValidPairs, 'qualityMinValidPairs', 1, 10000);
  const maxCostPerRequest = cost(record.maxCostPerRequest);
  const maxLatencyMs = integerField(record.maxLatencyMs, 'maxLatencyMs', 1, 600000);
  const taskSegments = segments(record.taskSegments);
  return {
    name: record.name,
    alias: 'auto',
    baselineDeployment,
    candidateDeployments,
    qualityMinPassRate,
    qualityMinValidPairs,
    maxCostPerRequest,
    maxLatencyMs,
    taskSegments,
  };
}

export function parseExpectedEpoch(body: unknown): number {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The policy body is invalid.');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1) throw invalidRequest('body', 'invalid_parameter', 'The policy body is invalid.');
  return integerField(record.expectedEpoch, 'expectedEpoch', 1, 1_000_000);
}

export function parseStatusChange(body: unknown): { status: 'shadow' | 'disabled'; expectedEpoch: number } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The policy body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['status', 'expectedEpoch']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The policy body is invalid.');
  }
  if (record.status !== 'shadow' && record.status !== 'disabled') {
    throw invalidRequest('status', 'invalid_transition', 'The status change is not allowed.');
  }
  return {
    status: record.status,
    expectedEpoch: integerField(record.expectedEpoch, 'expectedEpoch', 1, 1_000_000),
  };
}

export function nextRoutingStatus(current: RoutingStatus, requested: RoutingStatus): RoutingStatus {
  if (current === 'draft' && requested === 'validated') return 'validated';
  if (current === 'validated' && requested === 'shadow') return 'shadow';
  if ((current === 'validated' || current === 'shadow') && requested === 'disabled') return 'disabled';
  throw invalidRequest('status', 'invalid_transition', 'The status change is not allowed.');
}

export function parsePolicyId(policyId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policyId)) {
    throw invalidRequest('policy_id', 'invalid_parameter', 'policy id is invalid.');
  }
  return policyId.toLowerCase();
}

export function parseDecisionRequestId(requestId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw invalidRequest('request_id', 'invalid_parameter', 'request id is invalid.');
  }
  return requestId.toLowerCase();
}

function canonicalWrite(write: RoutingWrite): string {
  return JSON.stringify({
    name: write.name,
    alias: write.alias,
    baselineDeployment: write.baselineDeployment,
    candidateDeployments: [...write.candidateDeployments].sort(),
    qualityMinPassRate: write.qualityMinPassRate,
    qualityMinValidPairs: write.qualityMinValidPairs,
    maxCostPerRequest: write.maxCostPerRequest,
    maxLatencyMs: write.maxLatencyMs,
    taskSegments: [...write.taskSegments].sort(),
  });
}

function deploymentName(value: unknown, param: string): string {
  if (typeof value !== 'string' || !DEPLOYMENT.test(value) || value === 'auto') {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value;
}

function deploymentList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw invalidRequest('candidateDeployments', 'invalid_parameter', 'candidateDeployments is invalid.');
  }
  const names = value.map((item) => deploymentName(item, 'candidateDeployments'));
  if (new Set(names).size !== names.length) {
    throw invalidRequest('candidateDeployments', 'invalid_parameter', 'candidateDeployments is invalid.');
  }
  return names;
}

function rate(value: unknown): string {
  if (typeof value !== 'string' || !RATE.test(value) || Number(value) > 1) {
    throw invalidRequest('qualityMinPassRate', 'invalid_parameter', 'qualityMinPassRate is invalid.');
  }
  return Number(value).toFixed(5);
}

function cost(value: unknown): string {
  if (typeof value !== 'string' || !COST.test(value)) {
    throw invalidRequest('maxCostPerRequest', 'invalid_parameter', 'maxCostPerRequest is invalid.');
  }
  const amount = Number(value);
  if (!(amount > 0) || amount > 1000) {
    throw invalidRequest('maxCostPerRequest', 'invalid_parameter', 'maxCostPerRequest is invalid.');
  }
  return amount.toFixed(8);
}

function integerField(value: unknown, param: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value;
}

function segments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9) {
    throw invalidRequest('taskSegments', 'invalid_parameter', 'taskSegments is invalid.');
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isTaskCategory(item)) {
      throw invalidRequest('taskSegments', 'invalid_parameter', 'taskSegments is invalid.');
    }
    names.push(item);
  }
  if (new Set(names).size !== names.length) {
    throw invalidRequest('taskSegments', 'invalid_parameter', 'taskSegments is invalid.');
  }
  return names;
}
