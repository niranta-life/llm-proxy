import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type ProviderCredentialStore = {
  protect(secret: string, mode?: 'api_key' | 'service_account'): string;
  open(protectedCredential: string): string;
};

export function createCredentialStore(key: Buffer, previous: readonly Buffer[] = []): ProviderCredentialStore {
  if (key.length !== 32) throw new Error('credential key must be 32 bytes');
  for (const older of previous) {
    if (older.length !== 32) throw new Error('credential key must be 32 bytes');
  }
  const keys = [key, ...previous];

  return {
    protect(secret: string, mode: 'api_key' | 'service_account' = 'api_key'): string {
      if (mode === 'service_account') {
        if (secret.length < 8 || secret.length > 3000) throw new Error('provider credential is invalid');
      } else if (secret.length < 8 || secret.length > 256 || /\s/.test(secret)) {
        throw new Error('provider credential is invalid');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const encoded = [
        'aes-256-gcm',
        '1',
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('$');
      if (encoded.length < 40 || encoded.length > 4096 || /\s/.test(encoded)) {
        throw new Error('provider credential is invalid');
      }
      return encoded;
    },

    open(protectedCredential: string): string {
      const parts = protectedCredential.split('$');
      if (parts.length !== 5 || parts[0] !== 'aes-256-gcm' || parts[1] !== '1') {
        throw new Error('protected credential is invalid');
      }
      const iv = Buffer.from(parts[2] ?? '', 'base64url');
      const tag = Buffer.from(parts[3] ?? '', 'base64url');
      const data = Buffer.from(parts[4] ?? '', 'base64url');
      if (iv.length !== 12 || tag.length !== 16 || data.length === 0) {
        throw new Error('protected credential is invalid');
      }
      let last: unknown;
      for (const candidate of keys) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', candidate, iv);
          decipher.setAuthTag(tag);
          return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        } catch (error) {
          last = error;
        }
      }
      if (last instanceof Error) throw last;
      throw new Error('protected credential is invalid');
    },
  };
}
