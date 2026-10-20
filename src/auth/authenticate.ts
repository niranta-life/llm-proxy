import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Pool } from 'pg';
import { hashSecret, verifySecret } from '../secrets.js';

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuthResult = {
  tenantId: string;
  keyId: string;
};

let dummyVerifier: Promise<string> | undefined;

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function fallbackVerifier(): Promise<string> {
  dummyVerifier ??= hashSecret(randomBytes(32).toString('base64url'));
  return dummyVerifier;
}

export async function authenticate(
  authPool: Pool,
  headers: IncomingHttpHeaders,
): Promise<AuthResult | null> {
  const tenantId = headerValue(headers['x-tenant-id']);
  const authorization = headerValue(headers.authorization);
  if (tenantId === undefined || authorization === undefined) return null;
  if (!TENANT_ID.test(tenantId)) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  const secret = match?.[1];
  if (secret === undefined || !secret.startsWith('yck_') || secret.length < 40) return null;

  const result = await authPool.query<{ key_id: string; verifier: string }>(
    'SELECT key_id, verifier FROM list_active_key_verifiers($1::uuid)',
    [tenantId],
  );
  const rows =
    result.rows.length > 0
      ? result.rows
      : [{ key_id: '', verifier: await fallbackVerifier() }];

  let matched: string | null = null;
  for (const row of rows) {
    const ok = await verifySecret(secret, row.verifier);
    if (ok && row.key_id !== '' && matched === null) matched = row.key_id;
  }
  if (matched === null) return null;
  return { tenantId, keyId: matched };
}
