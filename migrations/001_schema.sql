CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  verifier text NOT NULL CHECK (
    verifier LIKE 'scrypt$%'
    AND verifier !~ '[[:space:]]'
    AND char_length(verifier) BETWEEN 40 AND 512
  ),
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX tenant_api_keys_tenant_id_idx ON tenant_api_keys (tenant_id);

CREATE INDEX tenant_api_keys_active_idx
  ON tenant_api_keys (tenant_id)
  WHERE revoked_at IS NULL;
