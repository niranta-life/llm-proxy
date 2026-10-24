import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';

export const SAMPLE_SCHEMA_VERSION = 1;
export const CAPTURE_BUDGET_MS = 250;
export const CAPTURE_BYTE_CEILING = 1_000_000;

export type WrappingKeyVersion = {
  version: number;
  key: Buffer;
};

export type SampleKeyManager = {
  current(): WrappingKeyVersion;
  previous(): readonly WrappingKeyVersion[];
};

export type EncryptedEnvelope = {
  schemaVersion: number;
  wrappingKeyVersion: number;
  wrappedKeyIv: Buffer;
  wrappedKeyTag: Buffer;
  wrappedKeyCiphertext: Buffer;
  contentIv: Buffer;
  contentTag: Buffer;
  contentCiphertext: Buffer;
};

export type SamplePlaintext = {
  tenantId: string;
  sampleId: string;
  schemaVersion: number;
  payload: unknown;
};

type Seal = {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
};

export function createSampleKeyManager(current: Buffer, previous: readonly Buffer[] = []): SampleKeyManager {
  const retained = previous.map((key, index) => ({ version: index + 1, key }));
  const active = { version: retained.length + 1, key: current };
  return {
    current(): WrappingKeyVersion {
      assertKey(active.key);
      for (const item of retained) assertKey(item.key);
      return active;
    },
    previous(): readonly WrappingKeyVersion[] {
      return retained;
    },
  };
}

export function randomDraw(): number {
  return randomInt(0, 1_000_000) / 1_000_000;
}

export function associatedData(tenantId: string, sampleId: string, schemaVersion: number): Buffer {
  return Buffer.from(`tenant=${tenantId}\nsample=${sampleId}\nschema=${schemaVersion}`, 'utf8');
}

export function encryptSample(
  manager: SampleKeyManager | null,
  input: { tenantId: string; sampleId: string; schemaVersion: number; payload: unknown },
): EncryptedEnvelope | null {
  if (manager === null) return null;
  let dataKey: Buffer | null = null;
  try {
    const wrapping = manager.current();
    const plain = Buffer.from(JSON.stringify(input.payload), 'utf8');
    if (plain.length < 1 || plain.length > CAPTURE_BYTE_CEILING) return null;
    dataKey = randomBytes(32);
    const aad = associatedData(input.tenantId, input.sampleId, input.schemaVersion);
    const content = seal(dataKey, plain, aad);
    const wrapped = seal(wrapping.key, dataKey, aad);
    plain.fill(0);
    return {
      schemaVersion: input.schemaVersion,
      wrappingKeyVersion: wrapping.version,
      wrappedKeyIv: wrapped.iv,
      wrappedKeyTag: wrapped.tag,
      wrappedKeyCiphertext: wrapped.ciphertext,
      contentIv: content.iv,
      contentTag: content.tag,
      contentCiphertext: content.ciphertext,
    };
  } catch {
    return null;
  } finally {
    dataKey?.fill(0);
  }
}

export function decryptSample(
  manager: SampleKeyManager | null,
  input: { tenantId: string; sampleId: string; schemaVersion: number },
  envelope: EncryptedEnvelope,
): unknown | null {
  if (manager === null) return null;
  let dataKey: Buffer | null = null;
  let plain: Buffer | null = null;
  try {
    const wrapping = findKey(manager, envelope.wrappingKeyVersion);
    if (wrapping === null) return null;
    const aad = associatedData(input.tenantId, input.sampleId, input.schemaVersion);
    dataKey = open(
      wrapping,
      { iv: envelope.wrappedKeyIv, tag: envelope.wrappedKeyTag, ciphertext: envelope.wrappedKeyCiphertext },
      aad,
    );
    if (dataKey.length !== 32) return null;
    plain = open(
      dataKey,
      { iv: envelope.contentIv, tag: envelope.contentTag, ciphertext: envelope.contentCiphertext },
      aad,
    );
    return JSON.parse(plain.toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    dataKey?.fill(0);
    plain?.fill(0);
  }
}

function findKey(manager: SampleKeyManager, version: number): Buffer | null {
  let current: WrappingKeyVersion;
  try {
    current = manager.current();
  } catch {
    return null;
  }
  if (current.version === version) return current.key;
  const retained = manager.previous().find((item) => item.version === version);
  return retained?.key ?? null;
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('wrapping key is unavailable');
}

function seal(key: Buffer, plain: Buffer, aad: Buffer): Seal {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(key: Buffer, sealed: Seal, aad: Buffer): Buffer {
  if (sealed.iv.length !== 12 || sealed.tag.length !== 16 || sealed.ciphertext.length < 1) {
    throw new Error('ciphertext is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
