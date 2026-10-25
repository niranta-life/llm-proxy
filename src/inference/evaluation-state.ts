import { proxyError } from './errors.js';

export const RUN_STATUSES = [
  'created',
  'preflight',
  'queued',
  'running',
  'completed',
  'completed_partial',
  'cancel_requested',
  'cancelled',
  'failed',
] as const;

export const ITEM_STATUSES = ['pending', 'queued', 'running', 'completed', 'cancelled', 'failed'] as const;

export const ITEM_REASON_CODES = [
  'dry_run',
  'cancelled',
  'sample_not_owned',
  'sample_expired',
  'sample_incomplete',
  'replay_denied',
  'judge_disclosure_denied',
  'deployment_unauthorized',
  'capability_mismatch',
  'residency_denied',
  'provider_denied',
  'budget_exceeded',
  'item_limit_exceeded',
  'run_limit_exceeded',
  'sample_category_mismatch',
  'replay_completed',
  'provider_timeout',
  'provider_rate_limited',
  'provider_error',
  'malformed_output',
  'usage_missing',
  'cost_missing',
  'invalid_canonical',
  'semantic_rejected',
  'deployment_unhealthy',
  'rate_limited',
  'concurrency_limited',
  'not_dispatched',
  'uncertain',
  'kill_switch',
  'admission_unavailable',
  'output_not_sealed',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemReasonCode = (typeof ITEM_REASON_CODES)[number];

const RUN_EDGES: Record<RunStatus, readonly RunStatus[]> = {
  created: ['preflight', 'failed'],
  preflight: ['queued', 'failed'],
  queued: ['running', 'cancel_requested', 'cancelled'],
  running: ['completed', 'completed_partial', 'cancel_requested', 'failed'],
  completed: [],
  completed_partial: [],
  cancel_requested: ['cancelled', 'completed_partial'],
  cancelled: [],
  failed: [],
};

const ITEM_EDGES: Record<ItemStatus, readonly ItemStatus[]> = {
  pending: ['queued', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export function isItemStatus(value: string): value is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(value);
}

export function transitionRun(current: RunStatus, next: RunStatus): { status: RunStatus; applied: boolean } {
  return transition(RUN_EDGES, current, next);
}

export function transitionItem(current: ItemStatus, next: ItemStatus): { status: ItemStatus; applied: boolean } {
  return transition(ITEM_EDGES, current, next);
}

export type ItemCounts = Record<ItemStatus, number>;

export function countItems(items: readonly ItemStatus[]): ItemCounts {
  const counts: ItemCounts = {
    pending: 0,
    queued: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
  };
  for (const status of items) counts[status] += 1;
  return counts;
}

export function planRunSteps(current: RunStatus, items: readonly ItemStatus[]): RunStatus[] {
  if (items.length === 0) return [];
  const counts = countItems(items);
  const open = counts.pending + counts.queued + counts.running;
  const steps: RunStatus[] = [];
  let cursor = current;
  const push = (next: RunStatus): void => {
    if (next === cursor) return;
    transitionRun(cursor, next);
    steps.push(next);
    cursor = next;
  };
  if (open > 0) {
    if (cursor === 'queued' && (counts.running > 0 || counts.completed > 0 || counts.failed > 0)) {
      push('running');
    }
    return steps;
  }
  if (counts.cancelled === items.length) {
    if (cursor === 'running') push('cancel_requested');
    if (cursor === 'queued' || cursor === 'cancel_requested') push('cancelled');
    return steps;
  }
  if (counts.completed === items.length) {
    if (cursor === 'queued') push('running');
    if (cursor === 'running') push('completed');
    return steps;
  }
  if (counts.failed === items.length && (cursor === 'queued' || cursor === 'running' || cursor === 'preflight')) {
    push('failed');
    return steps;
  }
  if (cursor === 'queued') push('running');
  if (cursor === 'running' || cursor === 'cancel_requested') push('completed_partial');
  return steps;
}

function transition<T extends string>(
  edges: Record<T, readonly T[]>,
  current: T,
  next: T,
): { status: T; applied: boolean } {
  if (current === next) return { status: current, applied: false };
  if (!edges[current].includes(next)) {
    throw proxyError(
      409,
      'invalid_request_error',
      'illegal_transition',
      'status',
      'The status transition is not allowed.',
    );
  }
  return { status: next, applied: true };
}
