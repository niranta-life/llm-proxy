import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CaptureFacts, SamplePolicy } from '../src/inference/sample-policy.js';
import {
  DEFAULT_RECENT_SHARE,
  DEFAULT_RETENTION_SECONDS,
  DEFAULT_SAMPLE_CAP,
  allocationBudgets,
  contentFingerprint,
  deterministicDraw,
  diversityKey,
  resolveCaptureBounds,
  selectSample,
  unkeyedPromptHash,
  visibleSampleText,
  type HeldSample,
  type SelectResult,
} from '../src/inference/sample-selection.js';

const evidenceDir = process.env.SLICE_06C_EVIDENCE;
const notes: string[] = [];

function facts(over: Partial<CaptureFacts> = {}): CaptureFacts {
  return {
    dataClass: 'internal',
    provider: 'openai',
    deployment: 'chat',
    sampleBytes: 100,
    storedCount: 0,
    draw: 0,
    ageMs: 0,
    ...over,
  };
}

function policy(over: Partial<SamplePolicy> = {}): SamplePolicy {
  return {
    mode: 'encrypted_sample',
    contentCapture: true,
    replay: false,
    judgeDisclosure: false,
    sampleRate: 1,
    maxSampleBytes: 1_000_000,
    maxSampleCount: DEFAULT_SAMPLE_CAP,
    retentionSeconds: DEFAULT_RETENTION_SECONDS,
    approvedClassifications: ['internal'],
    allowedProviders: ['openai'],
    allowedDeployments: ['chat'],
    ...over,
  };
}

function heldRow(id: string, key: string, slot: HeldSample['slot'], createdAtMs: number, fingerprintHex: string): HeldSample {
  return { id, createdAtMs, slot, diversityKey: key, fingerprintHex };
}

function choose(input: {
  tenantId?: string;
  requestId?: string;
  rate?: number;
  held?: readonly HeldSample[];
  key?: string;
  fingerprintHex?: string;
  cap?: number;
  recentShare?: number;
  authorized?: boolean;
  createdAtMs?: number;
}): SelectResult {
  const active = policy({
    sampleRate: input.rate ?? 1,
    maxSampleCount: input.cap ?? 10,
  });
  const tenantId = input.tenantId ?? 'tenant-a';
  const requestId = input.requestId ?? 'request-1';
  const text = visibleSampleText([{ role: 'user', content: input.fingerprintHex ?? requestId }], 'out');
  const fingerprintHex = input.fingerprintHex ?? contentFingerprint(tenantId, text).toString('hex');
  const result = selectSample({
    policy: input.authorized === false ? policy({ approvedClassifications: [] }) : active,
    facts: facts({
      storedCount: input.held?.length ?? 0,
      draw: deterministicDraw(tenantId, requestId),
      dataClass: 'internal',
    }),
    fingerprintHex,
    held: input.held ?? [],
    diversityKey: input.key ?? 'general_qa',
    candidateId: requestId,
    createdAtMs: input.createdAtMs ?? 1,
    recentShare: input.recentShare ?? DEFAULT_RECENT_SHARE,
  });
  return result;
}

function apply(held: HeldSample[], result: SelectResult, key: string, fingerprintHex: string, createdAtMs: number, id: string): HeldSample[] {
  if (!result.keep) return held;
  const next = held.filter((row) => !result.evictIds.includes(row.id));
  next.push(heldRow(id, key, result.slot, createdAtMs, fingerprintHex));
  return next;
}

describe('sample selection', () => {
  it('keeps the same tenant and request on the same side of the rate', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const draw = deterministicDraw(tenantId, requestId);
    expect(deterministicDraw(tenantId, requestId)).toBe(draw);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThan(1);
    const first = selectSample({
      policy: policy({ sampleRate: 0.5, maxSampleCount: 10 }),
      facts: facts({ draw, storedCount: 0 }),
      fingerprintHex: 'aa',
      held: [],
      diversityKey: 'writing',
      candidateId: 's1',
      createdAtMs: 1,
      recentShare: DEFAULT_RECENT_SHARE,
    });
    const second = selectSample({
      policy: policy({ sampleRate: 0.5, maxSampleCount: 10 }),
      facts: facts({ draw, storedCount: 0 }),
      fingerprintHex: 'aa',
      held: [],
      diversityKey: 'writing',
      candidateId: 's1',
      createdAtMs: 1,
      recentShare: DEFAULT_RECENT_SHARE,
    });
    expect(second).toEqual(first);
    notes.push(`stable draw ${draw} keep ${first.keep}`);
  });

  it('keeps nothing at rate 0 and everything at rate 1', () => {
    let never = 0;
    let always = 0;
    for (let index = 0; index < 200; index += 1) {
      const requestId = `rate-${index}`;
      const draw = deterministicDraw('tenant-rate', requestId);
      const skipped = selectSample({
        policy: policy({ sampleRate: 0 }),
        facts: facts({ draw }),
        fingerprintHex: `f-${index}`,
        held: [],
        diversityKey: 'writing',
        candidateId: requestId,
        createdAtMs: index,
        recentShare: DEFAULT_RECENT_SHARE,
      });
      const kept = selectSample({
        policy: policy({ sampleRate: 1 }),
        facts: facts({ draw }),
        fingerprintHex: `g-${index}`,
        held: [],
        diversityKey: 'writing',
        candidateId: requestId,
        createdAtMs: index,
        recentShare: DEFAULT_RECENT_SHARE,
      });
      if (!skipped.keep) never += 1;
      if (kept.keep) always += 1;
    }
    expect(never).toBe(200);
    expect(always).toBe(200);
    notes.push('rate 0 kept 0 of 200');
    notes.push('rate 1 kept 200 of 200');
  });

  it('tracks a mid rate across distinct requests', () => {
    const total = 4000;
    let kept = 0;
    for (let index = 0; index < total; index += 1) {
      const requestId = `mid-${index}`;
      const draw = deterministicDraw('tenant-mid', requestId);
      const result = selectSample({
        policy: policy({ sampleRate: 0.25, maxSampleCount: total }),
        facts: facts({ draw }),
        fingerprintHex: `m-${index}`,
        held: [],
        diversityKey: 'writing',
        candidateId: requestId,
        createdAtMs: index,
        recentShare: DEFAULT_RECENT_SHARE,
      });
      if (result.keep) kept += 1;
    }
    const ratio = kept / total;
    expect(Math.abs(ratio - 0.25)).toBeLessThan(0.05);
    notes.push(`rate 0.25 kept ${kept} of ${total}`);
  });

  it('uses a cap of 100 and a 60/40 split when the operator omits both bounds', () => {
    expect(DEFAULT_SAMPLE_CAP).toBe(100);
    expect(DEFAULT_RECENT_SHARE).toBe(0.6);
    expect(DEFAULT_RETENTION_SECONDS).toBe(604800);
    expect(allocationBudgets(100, 0.6)).toEqual({ recent: 60, diverse: 40 });
    let filled: HeldSample[] = [];
    for (let index = 0; index < 30; index += 1) {
      const key = diversityKey({
        taskCategory: 'writing',
        inputSize: 10,
        complexity: 'low',
        deployment: 'chat',
      });
      const fingerprintHex = contentFingerprint('tenant-split', `split-${index}`).toString('hex');
      const result = choose({
        requestId: `split-${index}`,
        held: filled,
        key,
        fingerprintHex,
        cap: 10,
        createdAtMs: index + 1,
      });
      filled = apply(filled, result, key, fingerprintHex, index + 1, `split-${index}`);
    }
    expect(filled.filter((row) => row.slot === 'recent')).toHaveLength(6);
    expect(filled.filter((row) => row.slot === 'diverse')).toHaveLength(4);
    const omitted = resolveCaptureBounds({
      mode: 'encrypted_sample',
      contentCapture: true,
      maxSampleCount: null,
      retentionSeconds: null,
    });
    expect(omitted).toEqual({ maxSampleCount: 100, retentionSeconds: 604800 });
    const explicit = resolveCaptureBounds({
      mode: 'encrypted_sample',
      contentCapture: true,
      maxSampleCount: 0,
      retentionSeconds: 0,
    });
    expect(explicit).toEqual({ maxSampleCount: 0, retentionSeconds: 0 });
    const metadata = resolveCaptureBounds({
      mode: 'metadata_only',
      contentCapture: false,
      maxSampleCount: null,
      retentionSeconds: null,
    });
    expect(metadata).toEqual({ maxSampleCount: 0, retentionSeconds: 0 });
    notes.push('default cap 100 recent 60 diverse 40 retention 604800');
  });

  it('keeps a diverse category while newer requests are one category', () => {
    const categories = ['classification', 'extraction', 'summarization', 'reasoning'];
    let held: HeldSample[] = [];
    for (let index = 0; index < categories.length; index += 1) {
      const key = diversityKey({
        taskCategory: categories[index] ?? 'unknown',
        inputSize: 10 + index,
        complexity: 'low',
        deployment: 'chat',
      });
      const fingerprintHex = contentFingerprint('tenant-a', `body-${categories[index]}`).toString('hex');
      const result = choose({
        requestId: `seed-${index}`,
        held,
        key,
        fingerprintHex,
        cap: 10,
        createdAtMs: index + 1,
      });
      expect(result.keep).toBe(true);
      if (result.keep) expect(result.slot).toBe('diverse');
      held = apply(held, result, key, fingerprintHex, index + 1, `seed-${index}`);
    }
    const protectedIds = held.map((row) => row.id);
    const floodKey = diversityKey({
      taskCategory: 'classification',
      inputSize: 10,
      complexity: 'low',
      deployment: 'chat',
    });
    for (let index = 0; index < 30; index += 1) {
      const fingerprintHex = contentFingerprint('tenant-a', `flood-${index}`).toString('hex');
      const result = choose({
        requestId: `flood-${index}`,
        held,
        key: floodKey,
        fingerprintHex,
        cap: 10,
        createdAtMs: 100 + index,
      });
      held = apply(held, result, floodKey, fingerprintHex, 100 + index, `flood-${index}`);
      expect(held.length).toBeLessThanOrEqual(10);
    }
    for (const id of protectedIds) expect(held.map((row) => row.id)).toContain(id);
    const keys = new Set(held.filter((row) => row.slot === 'diverse').map((row) => row.diversityKey));
    expect(keys.size).toBe(4);
    notes.push(`diverse keys after flood ${keys.size} retained ${held.length}`);
  });

  it('never retains more than the cap', () => {
    let held: HeldSample[] = [];
    for (let index = 0; index < 40; index += 1) {
      const key = diversityKey({
        taskCategory: ['coding', 'translation', 'writing', 'general_qa'][index % 4] ?? 'unknown',
        inputSize: 20 + index,
        complexity: index > 20 ? 'medium' : 'low',
        deployment: index % 2 === 0 ? 'chat' : 'tools',
      });
      const fingerprintHex = contentFingerprint('tenant-cap', `row-${index}`).toString('hex');
      const result = choose({
        requestId: `cap-${index}`,
        held,
        key,
        fingerprintHex,
        cap: 10,
        createdAtMs: index + 1,
      });
      held = apply(held, result, key, fingerprintHex, index + 1, `cap-${index}`);
      expect(held.length).toBeLessThanOrEqual(10);
    }
    expect(held).toHaveLength(10);
    notes.push(`hard cap retained ${held.length}`);
  });

  it('stores one fingerprint per tenant and does not use the raw prompt hash', () => {
    const prompt = 'same visible prompt';
    const text = visibleSampleText([{ role: 'user', content: prompt }], 'same output');
    const tenantA = contentFingerprint('tenant-a', text);
    const tenantAAgain = contentFingerprint('tenant-a', text);
    const tenantB = contentFingerprint('tenant-b', text);
    expect(tenantA.equals(tenantAAgain)).toBe(true);
    expect(tenantA.equals(tenantB)).toBe(false);
    expect(tenantA.equals(unkeyedPromptHash(prompt))).toBe(false);
    expect(tenantA.equals(unkeyedPromptHash(text))).toBe(false);
    expect(tenantA.equals(createHash('sha256').update(`tenant-a\n${prompt}`).digest())).toBe(false);
    const first = choose({
      tenantId: 'tenant-a',
      requestId: 'dup-1',
      fingerprintHex: tenantA.toString('hex'),
      cap: 5,
    });
    expect(first.keep).toBe(true);
    const held = first.keep
      ? [heldRow('dup-1', 'writing', first.slot, 1, tenantA.toString('hex'))]
      : [];
    const duplicate = choose({
      tenantId: 'tenant-a',
      requestId: 'dup-2',
      fingerprintHex: tenantA.toString('hex'),
      held,
      cap: 5,
      createdAtMs: 2,
    });
    expect(duplicate.keep).toBe(false);
    if (!duplicate.keep) expect(duplicate.reason).toBe('duplicate');
    expect(duplicate.evictIds).toEqual([]);
    const otherTenant = choose({
      tenantId: 'tenant-b',
      requestId: 'dup-3',
      fingerprintHex: tenantB.toString('hex'),
      held,
      cap: 5,
    });
    expect(otherTenant.keep).toBe(true);
    notes.push('fingerprint differs by tenant and differs from the raw prompt hash');
  });

  it('does not select an unauthorized request', () => {
    const result = choose({ authorized: false, cap: 10 });
    expect(result.keep).toBe(false);
    if (!result.keep) expect(result.reason).toBe('data_class');
    const atCap = selectSample({
      policy: policy({ approvedClassifications: [], maxSampleCount: 1 }),
      facts: facts({ storedCount: 1, draw: 0 }),
      fingerprintHex: 'bb',
      held: [heldRow('old', 'writing', 'diverse', 1, 'cc')],
      diversityKey: 'coding',
      candidateId: 'new',
      createdAtMs: 2,
      recentShare: 0.6,
    });
    expect(atCap.keep).toBe(false);
    if (!atCap.keep) expect(atCap.reason).toBe('data_class');
    expect(atCap.evictIds).toEqual([]);
    notes.push('unauthorized request was not selected');
  });
});

afterAll(() => {
  if (evidenceDir === undefined || evidenceDir.length === 0) return;
  mkdirSync(evidenceDir, { recursive: true });
  const text = notes.join('\n');
  if (text.includes('same visible prompt')) throw new Error('evidence contains sample text');
  writeFileSync(join(evidenceDir, 'selection.txt'), `${text}\n`);
});
