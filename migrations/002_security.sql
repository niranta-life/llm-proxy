-- Policies and grants are applied while the migrator still owns the tables.
-- Ownership moves to llm_owner afterward so security-definer functions can bypass RLS.
-- The new owner needs CREATE on the schema before that ownership change.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_api_keys_isolation ON tenant_api_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON tenants FROM PUBLIC;
REVOKE ALL ON tenant_api_keys FROM PUBLIC;
REVOKE ALL ON schema_migrations FROM PUBLIC;

GRANT SELECT (id, name, created_at) ON tenants TO llm_runtime;
GRANT SELECT (id, tenant_id, label, created_at, revoked_at) ON tenant_api_keys TO llm_runtime;
GRANT SELECT ON schema_migrations TO llm_runtime;

CREATE FUNCTION provision_tenant(p_name text, p_verifier text, p_label text)
RETURNS TABLE (tenant_id uuid, key_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_key uuid;
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'name is required';
  END IF;
  IF p_verifier IS NULL OR p_verifier NOT LIKE 'scrypt$%' THEN
    RAISE EXCEPTION 'verifier is invalid';
  END IF;
  INSERT INTO tenants (name)
  VALUES (btrim(p_name))
  RETURNING id INTO v_tenant;
  INSERT INTO tenant_api_keys (tenant_id, verifier, label)
  VALUES (v_tenant, p_verifier, coalesce(p_label, ''))
  RETURNING id INTO v_key;
  RETURN QUERY SELECT v_tenant, v_key;
END;
$$;

CREATE FUNCTION add_tenant_key(p_tenant_id uuid, p_verifier text, p_label text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key uuid;
BEGIN
  IF p_verifier IS NULL OR p_verifier NOT LIKE 'scrypt$%' THEN
    RAISE EXCEPTION 'verifier is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  INSERT INTO tenant_api_keys (tenant_id, verifier, label)
  VALUES (p_tenant_id, p_verifier, coalesce(p_label, ''))
  RETURNING id INTO v_key;
  RETURN v_key;
END;
$$;

CREATE FUNCTION revoke_tenant_key(p_tenant_id uuid, p_key_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE tenant_api_keys
  SET revoked_at = now()
  WHERE id = p_key_id
    AND tenant_id = p_tenant_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE FUNCTION list_active_key_verifiers(p_tenant_id uuid)
RETURNS TABLE (key_id uuid, verifier text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT tenant_api_keys.id, tenant_api_keys.verifier
  FROM tenant_api_keys
  WHERE tenant_api_keys.tenant_id = p_tenant_id
    AND tenant_api_keys.revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION provision_tenant(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION add_tenant_key(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_tenant_key(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_active_key_verifiers(uuid) FROM PUBLIC;

ALTER TABLE tenants OWNER TO llm_owner;
ALTER TABLE tenant_api_keys OWNER TO llm_owner;
ALTER FUNCTION provision_tenant(text, text, text) OWNER TO llm_owner;
ALTER FUNCTION add_tenant_key(uuid, text, text) OWNER TO llm_owner;
ALTER FUNCTION revoke_tenant_key(uuid, uuid) OWNER TO llm_owner;
ALTER FUNCTION list_active_key_verifiers(uuid) OWNER TO llm_owner;

-- ALTER OWNER replaces the function ACL, so grants are applied again as the owner.
SET LOCAL ROLE llm_owner;
GRANT EXECUTE ON FUNCTION provision_tenant(text, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION add_tenant_key(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION revoke_tenant_key(uuid, uuid) TO llm_migrator;
GRANT EXECUTE ON FUNCTION list_active_key_verifiers(uuid) TO llm_auth;
RESET ROLE;
