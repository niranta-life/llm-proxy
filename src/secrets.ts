import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scryptAsync(
  secret: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

const SECRET_PREFIX = 'yck_';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 32 * 1024 * 1024;

export function generateTenantSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64url');
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export async function verifySecret(secret: string, verifier: string): Promise<boolean> {
  const parts = verifier.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltText = parts[4];
  const hashText = parts[5];
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return false;
  }
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;

  const actual = await scryptAsync(secret, salt, expected.length, {
    N,
    r,
    p,
    maxmem: MAX_MEMORY,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
