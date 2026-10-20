import type { Pool } from 'pg';
import { generateTenantSecret, hashSecret } from '../secrets.js';

export type ProvisionedKey = {
  tenantId: string;
  keyId: string;
  secret: string;
};

export async function provisionTenant(
  pool: Pool,
  input: { name: string; label?: string },
): Promise<ProvisionedKey & { name: string }> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('name is required');
  const secret = generateTenantSecret();
  const verifier = await hashSecret(secret);
  const result = await pool.query<{ tenant_id: string; key_id: string }>(
    'SELECT tenant_id, key_id FROM provision_tenant($1, $2, $3)',
    [name, verifier, input.label ?? ''],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('tenant was not created');
  return { tenantId: row.tenant_id, keyId: row.key_id, secret, name };
}

export async function addTenantKey(
  pool: Pool,
  input: { tenantId: string; label?: string },
): Promise<ProvisionedKey> {
  const secret = generateTenantSecret();
  const verifier = await hashSecret(secret);
  const result = await pool.query<{ key_id: string }>(
    'SELECT add_tenant_key($1::uuid, $2, $3) AS key_id',
    [input.tenantId, verifier, input.label ?? ''],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('key was not created');
  return { tenantId: input.tenantId, keyId: row.key_id, secret };
}

export async function revokeTenantKey(
  pool: Pool,
  input: { tenantId: string; keyId: string },
): Promise<boolean> {
  const result = await pool.query<{ revoked: boolean }>(
    'SELECT revoke_tenant_key($1::uuid, $2::uuid) AS revoked',
    [input.tenantId, input.keyId],
  );
  return result.rows[0]?.revoked === true;
}
