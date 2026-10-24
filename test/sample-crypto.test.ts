import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CAPTURE_BYTE_CEILING,
  createSampleKeyManager,
  decryptSample,
  encryptSample,
  type SampleKeyManager,
} from '../src/inference/sample-crypto.js';

const evidenceDir = process.env.SLICE_06B_EVIDENCE;
const notes: string[] = [];

function key(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

function ids(sampleId = 'sample-1'): { tenantId: string; sampleId: string; schemaVersion: number } {
  return { tenantId: 'tenant-a', sampleId, schemaVersion: 1 };
}

function seal(manager: SampleKeyManager, payload: unknown, sampleId = 'sample-1') {
  const bound = ids(sampleId);
  const envelope = encryptSample(manager, { ...bound, payload });
  expect(envelope).not.toBeNull();
  if (envelope === null) throw new Error('envelope missing');
  return { bound, envelope };
}

describe('sample envelope encryption', () => {
  it('round-trips a payload and keeps the plaintext out of the ciphertext', () => {
    const manager = createSampleKeyManager(key(1));
    const payload = { kind: 'visible', n: 1 };
    const { bound, envelope } = seal(manager, payload);
    expect(envelope.wrappingKeyVersion).toBe(1);
    expect(envelope.wrappedKeyCiphertext).toHaveLength(32);
    expect(envelope.contentCiphertext.includes(Buffer.from('visible'))).toBe(false);
    expect(decryptSample(manager, bound, envelope)).toEqual(payload);
    notes.push('round trip matched');
    notes.push('ciphertext did not contain the plaintext token');
  });

  it('returns null for a missing or throwing key manager', () => {
    const payload = { kind: 'hidden-from-error' };
    expect(encryptSample(null, { ...ids(), payload })).toBeNull();
    expect(decryptSample(null, ids(), seal(createSampleKeyManager(key(1)), payload).envelope)).toBeNull();
    const throwing: SampleKeyManager = {
      current(): never {
        throw new Error('key manager unavailable');
      },
      previous() {
        return [];
      },
    };
    expect(encryptSample(throwing, { ...ids(), payload })).toBeNull();
    notes.push('missing key manager stored nothing');
    notes.push('throwing key manager stored nothing');
  });

  it('returns null for a wrong wrapping key, tampered ciphertext, and changed associated data', () => {
    const manager = createSampleKeyManager(key(1));
    const payload = { kind: 'bound' };
    const { bound, envelope } = seal(manager, payload);
    const wrong = createSampleKeyManager(key(2));
    expect(decryptSample(wrong, bound, envelope)).toBeNull();

    const tampered = {
      ...envelope,
      contentCiphertext: Buffer.from(envelope.contentCiphertext),
    };
    tampered.contentCiphertext[0] = (tampered.contentCiphertext[0] ?? 0) ^ 0xff;
    expect(decryptSample(manager, bound, tampered)).toBeNull();

    const tagged = { ...envelope, contentTag: Buffer.from(envelope.contentTag) };
    tagged.contentTag[0] = (tagged.contentTag[0] ?? 0) ^ 0xff;
    expect(decryptSample(manager, bound, tagged)).toBeNull();

    expect(decryptSample(manager, { ...bound, tenantId: 'tenant-b' }, envelope)).toBeNull();
    expect(decryptSample(manager, { ...bound, sampleId: 'sample-2' }, envelope)).toBeNull();
    expect(decryptSample(manager, { ...bound, schemaVersion: 2 }, envelope)).toBeNull();
    expect(decryptSample(manager, bound, envelope)).toEqual(payload);
    notes.push('wrong wrapping key returned null');
    notes.push('tampered ciphertext returned null');
    notes.push('changed associated data returned null');
  });

  it('opens an old sample after rotation and stamps a new sample with the new key', () => {
    const first = createSampleKeyManager(key(3));
    const oldPayload = { kind: 'old' };
    const old = seal(first, oldPayload, 'old-sample');
    expect(old.envelope.wrappingKeyVersion).toBe(1);
    const rotated = createSampleKeyManager(key(4), [key(3)]);
    expect(rotated.current().version).toBe(2);
    expect(decryptSample(rotated, old.bound, old.envelope)).toEqual(oldPayload);
    const freshPayload = { kind: 'new' };
    const fresh = seal(rotated, freshPayload, 'new-sample');
    expect(fresh.envelope.wrappingKeyVersion).toBe(2);
    expect(decryptSample(first, fresh.bound, fresh.envelope)).toBeNull();
    expect(decryptSample(rotated, fresh.bound, fresh.envelope)).toEqual(freshPayload);
    notes.push('rotated manager opened the previous sample');
    notes.push('new sample uses wrapping key version 2');
    notes.push('previous manager cannot open the new sample');
  });

  it('rejects a payload above the byte ceiling', () => {
    const manager = createSampleKeyManager(key(5));
    const payload = 'x'.repeat(CAPTURE_BYTE_CEILING);
    expect(encryptSample(manager, { ...ids(), payload })).toBeNull();
    notes.push('oversized payload was not encrypted');
  });

  afterAll(() => {
    if (evidenceDir === undefined || evidenceDir.length === 0) return;
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'encryption.txt'), `${notes.join('\n')}\n`);
  });
});
