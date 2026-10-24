import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSamplePayload } from '../src/inference/samples.js';
import {
  decideSampleCapture,
  defaultSamplePolicy,
  type CaptureFacts,
  type SamplePolicy,
} from '../src/inference/sample-policy.js';

const evidenceDir = process.env.SLICE_06B_EVIDENCE;
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
    maxSampleBytes: 1000,
    maxSampleCount: 10,
    retentionSeconds: 3600,
    approvedClassifications: ['internal'],
    allowedProviders: ['openai'],
    allowedDeployments: ['chat'],
    ...over,
  };
}

function reason(value: SamplePolicy | null, measured: CaptureFacts = facts()): string {
  const decision = decideSampleCapture(value, measured);
  notes.push(`${decision.reason} capture ${decision.capture} replay ${decision.replay} judge ${decision.judgeDisclosure}`);
  return decision.reason;
}

describe('sample capture policy', () => {
  it('defaults to metadata only and keeps replay and judge disclosure denied', () => {
    expect(defaultSamplePolicy().mode).toBe('metadata_only');
    expect(defaultSamplePolicy().contentCapture).toBe(false);
    expect(defaultSamplePolicy().replay).toBe(false);
    expect(defaultSamplePolicy().judgeDisclosure).toBe(false);
    const missing = decideSampleCapture(null, facts());
    expect(missing.capture).toBe(false);
    expect(missing.reason).toBe('metadata_only');
    expect(missing.replay).toBe(false);
    expect(missing.judgeDisclosure).toBe(false);
    expect(reason(policy({ mode: 'disabled' }))).toBe('disabled');
    expect(reason(policy({ mode: 'metadata_only' }))).toBe('metadata_only');
  });

  it('requires content capture and reports denied replay and judge flags', () => {
    const denied = decideSampleCapture(policy({ contentCapture: false, replay: true, judgeDisclosure: true }), facts());
    expect(denied.capture).toBe(false);
    expect(denied.reason).toBe('missing_permission');
    expect(denied.replay).toBe(true);
    expect(denied.judgeDisclosure).toBe(true);
    notes.push('missing content capture does not store content');
  });

  it('accepts an approved class and rejects a missing or unapproved class', () => {
    expect(reason(policy(), facts({ dataClass: null }))).toBe('data_class');
    expect(reason(policy(), facts({ dataClass: 'restricted' }))).toBe('data_class');
    expect(reason(policy(), facts({ dataClass: 'internal' }))).toBe('selected');
  });

  it('rejects a provider or deployment outside the allowlist', () => {
    expect(reason(policy(), facts({ provider: 'anthropic' }))).toBe('provider');
    expect(reason(policy(), facts({ deployment: 'other' }))).toBe('deployment');
    expect(reason(policy({ allowedProviders: [], allowedDeployments: [] }))).toBe('provider');
  });

  it('enforces size, count, and retention boundaries', () => {
    expect(reason(policy({ maxSampleBytes: 100 }), facts({ sampleBytes: 101 }))).toBe('size');
    expect(reason(policy({ maxSampleBytes: 100 }), facts({ sampleBytes: 100 }))).toBe('selected');
    expect(reason(policy({ maxSampleCount: 2 }), facts({ storedCount: 2 }))).toBe('count');
    expect(reason(policy({ maxSampleCount: 2 }), facts({ storedCount: 1 }))).toBe('selected');
    expect(reason(policy({ retentionSeconds: 0 }))).toBe('retention_elapsed');
    expect(reason(policy({ retentionSeconds: 10 }), facts({ ageMs: 10_000 }))).toBe('retention_elapsed');
    expect(reason(policy({ retentionSeconds: 10 }), facts({ ageMs: 9_999 }))).toBe('selected');
  });

  it('uses the supplied draw at the never and always boundaries', () => {
    expect(reason(policy({ sampleRate: 0 }), facts({ draw: 0 }))).toBe('rate');
    expect(reason(policy({ sampleRate: 1 }), facts({ draw: 1 }))).toBe('selected');
    expect(reason(policy({ sampleRate: 0.25 }), facts({ draw: 0.25 }))).toBe('rate');
    expect(reason(policy({ sampleRate: 0.25 }), facts({ draw: 0 }))).toBe('selected');
    expect(reason(policy(), facts({ draw: Number.NaN }))).toBe('rate');
    expect(reason(policy(), facts({ draw: 1.1 }))).toBe('rate');
  });

  it('selects content only when every gate passes', () => {
    const selected = decideSampleCapture(policy({ replay: false, judgeDisclosure: false }), facts({ draw: 0.2 }));
    expect(selected).toEqual({ capture: true, reason: 'selected', replay: false, judgeDisclosure: false });
    notes.push('every gate passed and replay and judge disclosure stayed denied');
  });

  it('keeps the stored payload to visible text and effective configuration', () => {
    const payload = buildSamplePayload({
      request: {
        model: 'chat',
        messages: [{ role: 'user', content: 'visible-request' }],
        stream: false,
        includeUsage: false,
        taskHint: 'coding',
        optional: { temperature: 0 },
      },
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'visible-output' }, finish_reason: 'stop' }],
      },
      route: {
        requestedModel: 'chat',
        deploymentName: 'chat',
        provider: 'openai',
        upstreamModel: 'gpt-test',
        timeoutMs: 5000,
      },
      dataClass: 'internal',
    });
    expect(payload.request).toEqual({
      model: 'chat',
      messages: [{ role: 'user', content: 'visible-request' }],
      task: 'coding',
      parameters: { temperature: 0 },
    });
    expect(payload.output.choices).toEqual([{ index: 0, content: 'visible-output', finishReason: 'stop' }]);
    expect(payload.configuration).toEqual({
      requestedModel: 'chat',
      deployment: 'chat',
      provider: 'openai',
      upstreamModel: 'gpt-test',
      timeoutMs: 5000,
      dataClassification: 'internal',
      stream: false,
    });
    expect(payload.providerMetadata).toEqual({ provider: 'openai', adapterVersion: 1 });
    expect(JSON.stringify(payload)).not.toContain('thinking');
    expect(payload.request).not.toHaveProperty('metadata');
    notes.push('payload keeps visible text and effective configuration');
  });

  afterAll(() => {
    if (evidenceDir === undefined || evidenceDir.length === 0) return;
    const body = `${notes.join('\n')}\n`;
    if (body.includes('visible-request') || body.includes('visible-output')) {
      throw new Error('policy evidence contains sample text');
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'policy.txt'), body);
  });
});
