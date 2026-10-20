import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type ProviderCredentialStore = {
  protect(secret: string): string;
  open(protectedCredential: string): string;
};

export function createCredentialStore(key: Buffer): ProviderCredentialStore {
  if (key.length !== 32) throw new Error('credential key must be 32 bytes');

  return {
    protect(secret: string): string {
      if (secret.length < 8 || secret.length > 256 || /\s/.test(secret)) {
        throw new Error('provider credential is invalid');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        'aes-256-gcm',
        '1',
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('$');
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
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}
