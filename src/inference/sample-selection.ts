import { createHash, createHmac } from 'node:crypto';
import {
  decideSampleCapture,
  type CaptureFacts,
  type CaptureReason,
  type SamplePolicy,
} from './sample-policy.js';

export const DEFAULT_SAMPLE_CAP = 100;
export const DEFAULT_RECENT_SHARE = 0.6;
export const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const DRAW_SCALE = 1_000_000;
const DRAW_DOMAIN = 'sample-draw-v1';
const FINGERPRINT_DOMAIN = 'sample-fingerprint-v1';

export type SampleSlot = 'recent' | 'diverse';

export type HeldSample = {
  id: string;
  createdAtMs: number;
  slot: SampleSlot;
  diversityKey: string;
  fingerprintHex: string;
};

export type SelectInput = {
  policy: SamplePolicy | null;
  facts: CaptureFacts;
  fingerprintHex: string;
  held: readonly HeldSample[];
  diversityKey: string;
  candidateId: string;
  createdAtMs: number;
  recentShare: number;
};

export type SelectResult =
  | { keep: false; reason: CaptureReason | 'duplicate' | 'coverage'; evictIds: [] }
  | { keep: true; slot: SampleSlot; evictIds: string[] };

export function resolveCaptureBounds(input: {
  mode: string;
  contentCapture: boolean;
  maxSampleCount: number | null;
  retentionSeconds: number | null;
}): { maxSampleCount: number; retentionSeconds: number } {
  const captureEnabled = input.mode === 'encrypted_sample' && input.contentCapture;
  return {
    maxSampleCount: input.maxSampleCount ?? (captureEnabled ? DEFAULT_SAMPLE_CAP : 0),
    retentionSeconds: input.retentionSeconds ?? (captureEnabled ? DEFAULT_RETENTION_SECONDS : 0),
  };
}

export function allocationBudgets(cap: number, recentShare: number): { recent: number; diverse: number } {
  if (!Number.isFinite(cap) || cap <= 0) return { recent: 0, diverse: 0 };
  const share = clampShare(recentShare);
  const recent = Math.floor(cap * share);
  return { recent, diverse: cap - recent };
}

export function deterministicDraw(tenantId: string, requestId: string): number {
  const mac = createHmac('sha256', DRAW_DOMAIN).update(tenantId).update('\n').update(requestId).digest();
  return (mac.readUIntBE(0, 6) % DRAW_SCALE) / DRAW_SCALE;
}

export function visibleSampleText(
  messages: readonly { role: string; content: string }[],
  output: string,
): string {
  const lines = [FINGERPRINT_DOMAIN];
  for (const message of messages) {
    lines.push(message.role, message.content);
  }
  lines.push('output', output);
  return lines.join('\n');
}

export function contentFingerprint(tenantId: string, text: string): Buffer {
  const key = Buffer.from(`${FINGERPRINT_DOMAIN}\n${tenantId}`, 'utf8');
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

export function unkeyedPromptHash(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export function inputSizeBand(inputSize: number): string {
  if (!Number.isFinite(inputSize) || inputSize < 0) return 'unknown';
  if (inputSize < 32) return 'xs';
  if (inputSize < 128) return 's';
  if (inputSize < 512) return 'm';
  if (inputSize < 2048) return 'l';
  if (inputSize < 8000) return 'xl';
  return 'xxl';
}

// Coverage uses task category, input size, complexity, and deployment.
// Chats have no application id. Caller metadata is not a coverage key.
export function diversityKey(input: {
  taskCategory: string;
  inputSize: number;
  complexity: string;
  deployment: string;
}): string {
  return [input.taskCategory, inputSizeBand(input.inputSize), input.complexity, input.deployment].join('\u001f');
}

export function selectSample(input: SelectInput): SelectResult {
  const active = input.policy;
  const decision = decideSampleCapture(active, factsForCap(active, input.facts));
  if (!decision.capture) return skip(decision.reason);
  const fingerprint = input.fingerprintHex.toLowerCase();
  if (input.held.some((row) => row.fingerprintHex.toLowerCase() === fingerprint)) return skip('duplicate');
  const cap = active?.maxSampleCount ?? 0;
  const placed = placeSample({
    cap,
    recentShare: input.recentShare,
    held: input.held,
    diversityKey: input.diversityKey,
  });
  if (placed === null) return skip('coverage');
  return { keep: true, slot: placed.slot, evictIds: placed.evictIds };
}

function factsForCap(policy: SamplePolicy | null, facts: CaptureFacts): CaptureFacts {
  const cap = policy?.maxSampleCount ?? 0;
  if (cap > 0 && facts.storedCount >= cap) return { ...facts, storedCount: cap - 1 };
  return facts;
}

function placeSample(input: {
  cap: number;
  recentShare: number;
  held: readonly HeldSample[];
  diversityKey: string;
}): { slot: SampleSlot; evictIds: string[] } | null {
  if (!Number.isFinite(input.cap) || input.cap <= 0 || input.held.length > input.cap) return null;
  const budgets = allocationBudgets(input.cap, input.recentShare);
  const diverseRows = input.held.filter((row) => row.slot === 'diverse');
  const recentRows = input.held.filter((row) => row.slot === 'recent');
  const counts = new Map<string, number>();
  for (const row of input.held) counts.set(row.diversityKey, (counts.get(row.diversityKey) ?? 0) + 1);
  const unseen = (counts.get(input.diversityKey) ?? 0) === 0;
  if (input.held.length < input.cap) {
    if (unseen && diverseRows.length < budgets.diverse) return { slot: 'diverse', evictIds: [] };
    if (recentRows.length < budgets.recent) return { slot: 'recent', evictIds: [] };
    if (diverseRows.length < budgets.diverse) return { slot: 'diverse', evictIds: [] };
    return { slot: 'recent', evictIds: [] };
  }
  if (unseen) {
    const recent = oldest(recentRows);
    if (recent !== undefined) return { slot: 'diverse', evictIds: [recent.id] };
    const redundant = oldest(diverseRows.filter((row) => (counts.get(row.diversityKey) ?? 0) > 1));
    if (redundant !== undefined) return { slot: 'diverse', evictIds: [redundant.id] };
    return null;
  }
  const recent = oldest(recentRows);
  if (recent !== undefined) return { slot: 'recent', evictIds: [recent.id] };
  return null;
}

function oldest(rows: readonly HeldSample[]): HeldSample | undefined {
  return rows.reduce<HeldSample | undefined>((best, row) => {
    if (best === undefined) return row;
    if (row.createdAtMs < best.createdAtMs) return row;
    if (row.createdAtMs === best.createdAtMs && row.id < best.id) return row;
    return best;
  }, undefined);
}

function clampShare(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECENT_SHARE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function skip(reason: CaptureReason | 'duplicate' | 'coverage'): SelectResult {
  return { keep: false, reason, evictIds: [] };
}
