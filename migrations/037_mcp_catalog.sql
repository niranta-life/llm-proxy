-- Add a tenant-scoped MCP server registry and a versioned tool catalog.
-- A credential is a protected reference. The runtime role cannot read that column.
-- A tool definition version cannot change.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 036.
-- Rollback keeps this file applied. Removing the catalog needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  server_key text NOT NULL,
  display_name text NOT NULL,
  endpoint text NOT NULL,
  credential_ref text NOT NULL,
  protocol_mode text NOT NULL,
  protocol_version text,
  connection_status text NOT NULL DEFAULT 'unknown',
  enabled boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  last_error text,
  catalog_fingerprint text,
  catalog_cached_at timestamptz,
  ttl_ms integer,
  cache_scope text,
  catalog_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_servers_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT mcp_servers_tenant_server_key UNIQUE (tenant_id, server_key),
  CONSTRAINT mcp_servers_server_key_check CHECK (server_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  CONSTRAINT mcp_servers_display_name_check CHECK (
    char_length(display_name) BETWEEN 1 AND 64
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT mcp_servers_endpoint_check CHECK (
    char_length(endpoint) BETWEEN 8 AND 512
    AND endpoint !~ '[[:space:]]'
    AND endpoint !~ '@'
    AND (
      endpoint LIKE 'https://%'
      OR endpoint LIKE 'http://127.0.0.1:%'
      OR endpoint LIKE 'http://localhost:%'
    )
  ),
  CONSTRAINT mcp_servers_credential_check CHECK (
    credential_ref LIKE 'aes-256-gcm$%'
    AND credential_ref !~ '[[:space:]]'
    AND char_length(credential_ref) BETWEEN 40 AND 4096
  ),
  CONSTRAINT mcp_servers_protocol_mode_check CHECK (protocol_mode IN ('modern', 'legacy')),
  CONSTRAINT mcp_servers_protocol_version_check CHECK (
    protocol_version IS NULL
    OR protocol_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ),
  CONSTRAINT mcp_servers_status_check CHECK (
    connection_status IN ('unknown', 'ok', 'failed', 'mismatch')
  ),
  CONSTRAINT mcp_servers_error_check CHECK (
    last_error IS NULL
    OR (
      char_length(last_error) BETWEEN 1 AND 200
      AND last_error !~ '[[:cntrl:]]'
      AND last_error NOT LIKE '%aes-256-gcm$%'
    )
  ),
  CONSTRAINT mcp_servers_fingerprint_check CHECK (
    catalog_fingerprint IS NULL
    OR catalog_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT mcp_servers_ttl_check CHECK (ttl_ms IS NULL OR ttl_ms BETWEEN 0 AND 2592000000),
  CONSTRAINT mcp_servers_cache_scope_check CHECK (cache_scope IS NULL OR cache_scope IN ('public', 'private')),
  CONSTRAINT mcp_servers_version_check CHECK (catalog_version >= 0)
);

CREATE INDEX mcp_servers_tenant_idx ON mcp_servers (tenant_id, server_key);

ALTER TABLE mcp_servers OWNER TO llm_owner;
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_servers_isolation ON mcp_servers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mcp_servers FROM PUBLIC;
GRANT SELECT (
  id,
  tenant_id,
  server_key,
  display_name,
  endpoint,
  protocol_mode,
  protocol_version,
  connection_status,
  enabled,
  last_checked_at,
  last_error,
  catalog_fingerprint,
  catalog_cached_at,
  ttl_ms,
  cache_scope,
  catalog_version,
  created_at
) ON mcp_servers TO llm_runtime;

CREATE TABLE mcp_tool_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  server_id uuid NOT NULL,
  catalog_version integer NOT NULL,
  remote_name text NOT NULL,
  namespaced_name text NOT NULL,
  description text NOT NULL,
  input_schema jsonb NOT NULL,
  output_schema jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_tool_definitions_version_check CHECK (catalog_version >= 1),
  CONSTRAINT mcp_tool_definitions_remote_name_check CHECK (remote_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT mcp_tool_definitions_namespaced_check CHECK (
    char_length(namespaced_name) BETWEEN 3 AND 97
    AND namespaced_name !~ '[[:space:]]'
  ),
  CONSTRAINT mcp_tool_definitions_description_check CHECK (
    char_length(description) <= 512
    AND description !~ '[[:cntrl:]]'
  ),
  CONSTRAINT mcp_tool_definitions_identity_key UNIQUE (tenant_id, server_id, catalog_version, remote_name),
  CONSTRAINT mcp_tool_definitions_namespace_key UNIQUE (tenant_id, namespaced_name, catalog_version),
  CONSTRAINT mcp_tool_definitions_server_fk
    FOREIGN KEY (tenant_id, server_id)
    REFERENCES mcp_servers (tenant_id, id)
);

CREATE INDEX mcp_tool_definitions_tenant_server_idx
  ON mcp_tool_definitions (tenant_id, server_id, catalog_version DESC);

ALTER TABLE mcp_tool_definitions OWNER TO llm_owner;
ALTER TABLE mcp_tool_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_definitions FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_tool_definitions_isolation ON mcp_tool_definitions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mcp_tool_definitions FROM PUBLIC;
GRANT SELECT ON mcp_tool_definitions TO llm_runtime;

CREATE FUNCTION reject_mcp_tool_definition_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'mcp tool definition is immutable';
END;
$$;

ALTER FUNCTION reject_mcp_tool_definition_change() OWNER TO llm_owner;

CREATE TRIGGER mcp_tool_definitions_immutable
  BEFORE UPDATE OR DELETE ON mcp_tool_definitions
  FOR EACH ROW
  EXECUTE FUNCTION reject_mcp_tool_definition_change();

CREATE TABLE mcp_tool_permissions (
  tenant_id uuid NOT NULL,
  server_id uuid NOT NULL,
  remote_name text NOT NULL,
  allowed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, server_id, remote_name),
  CONSTRAINT mcp_tool_permissions_remote_name_check CHECK (remote_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT mcp_tool_permissions_server_fk
    FOREIGN KEY (tenant_id, server_id)
    REFERENCES mcp_servers (tenant_id, id)
);

ALTER TABLE mcp_tool_permissions OWNER TO llm_owner;
ALTER TABLE mcp_tool_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_tool_permissions_isolation ON mcp_tool_permissions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mcp_tool_permissions FROM PUBLIC;
GRANT SELECT ON mcp_tool_permissions TO llm_runtime;

CREATE FUNCTION mcp_tenant_matches(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;
END;
$$;

ALTER FUNCTION mcp_tenant_matches(uuid) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION mcp_tenant_matches(uuid) FROM PUBLIC;

CREATE FUNCTION register_mcp_server(
  p_tenant_id uuid,
  p_server_key text,
  p_display_name text,
  p_endpoint text,
  p_credential text,
  p_protocol_mode text,
  p_enabled boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_server_key IS NULL OR p_server_key !~ '^[a-z0-9][a-z0-9-]{0,31}$' THEN
    RAISE EXCEPTION 'server name is invalid';
  END IF;
  IF p_display_name IS NULL
    OR char_length(p_display_name) < 1
    OR char_length(p_display_name) > 64
    OR p_display_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'display name is invalid';
  END IF;
  IF p_endpoint IS NULL
    OR char_length(p_endpoint) < 8
    OR char_length(p_endpoint) > 512
    OR p_endpoint ~ '[[:space:]]'
    OR position('@' IN p_endpoint) > 0
    OR (
      p_endpoint NOT LIKE 'https://%'
      AND p_endpoint NOT LIKE 'http://127.0.0.1:%'
      AND p_endpoint NOT LIKE 'http://localhost:%'
    ) THEN
    RAISE EXCEPTION 'endpoint is not allowed';
  END IF;
  IF p_credential IS NULL
    OR p_credential NOT LIKE 'aes-256-gcm$%'
    OR p_credential ~ '[[:space:]]'
    OR char_length(p_credential) < 40
    OR char_length(p_credential) > 4096 THEN
    RAISE EXCEPTION 'credential is invalid';
  END IF;
  IF p_protocol_mode IS NULL OR p_protocol_mode NOT IN ('modern', 'legacy') THEN
    RAISE EXCEPTION 'protocol mode is invalid';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled is invalid';
  END IF;
  INSERT INTO mcp_servers (
    tenant_id,
    server_key,
    display_name,
    endpoint,
    credential_ref,
    protocol_mode,
    enabled
  ) VALUES (
    p_tenant_id,
    p_server_key,
    p_display_name,
    p_endpoint,
    p_credential,
    p_protocol_mode,
    p_enabled
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

ALTER FUNCTION register_mcp_server(uuid, text, text, text, text, text, boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION register_mcp_server(uuid, text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_mcp_server(uuid, text, text, text, text, text, boolean) TO llm_runtime;

CREATE FUNCTION replace_mcp_credential(
  p_tenant_id uuid,
  p_server_id uuid,
  p_credential text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_credential IS NULL
    OR p_credential NOT LIKE 'aes-256-gcm$%'
    OR p_credential ~ '[[:space:]]'
    OR char_length(p_credential) < 40
    OR char_length(p_credential) > 4096 THEN
    RAISE EXCEPTION 'credential is invalid';
  END IF;
  UPDATE mcp_servers
  SET credential_ref = p_credential
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
END;
$$;

ALTER FUNCTION replace_mcp_credential(uuid, uuid, text) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION replace_mcp_credential(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_mcp_credential(uuid, uuid, text) TO llm_runtime;

CREATE FUNCTION set_mcp_server_enabled(
  p_tenant_id uuid,
  p_server_id uuid,
  p_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled is invalid';
  END IF;
  UPDATE mcp_servers
  SET enabled = p_enabled
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
  RETURN p_enabled;
END;
$$;

ALTER FUNCTION set_mcp_server_enabled(uuid, uuid, boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION set_mcp_server_enabled(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_mcp_server_enabled(uuid, uuid, boolean) TO llm_runtime;

CREATE FUNCTION record_mcp_connection(
  p_tenant_id uuid,
  p_server_id uuid,
  p_status text,
  p_protocol_version text,
  p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_status IS NULL OR p_status NOT IN ('unknown', 'ok', 'failed', 'mismatch') THEN
    RAISE EXCEPTION 'connection status is invalid';
  END IF;
  IF p_protocol_version IS NOT NULL AND p_protocol_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'protocol version is invalid';
  END IF;
  IF p_status = 'ok' AND p_error IS NOT NULL THEN
    RAISE EXCEPTION 'connection error is invalid';
  END IF;
  IF p_error IS NOT NULL AND (
    char_length(p_error) < 1
    OR char_length(p_error) > 200
    OR p_error ~ '[[:cntrl:]]'
    OR p_error LIKE '%aes-256-gcm$%'
  ) THEN
    RAISE EXCEPTION 'connection error is invalid';
  END IF;
  UPDATE mcp_servers
  SET connection_status = p_status,
      protocol_version = COALESCE(p_protocol_version, protocol_version),
      last_checked_at = now(),
      last_error = p_error
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
END;
$$;

ALTER FUNCTION record_mcp_connection(uuid, uuid, text, text, text) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION record_mcp_connection(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_mcp_connection(uuid, uuid, text, text, text) TO llm_runtime;

CREATE FUNCTION load_mcp_credential(p_tenant_id uuid, p_server_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_protected text;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  SELECT credential_ref INTO v_protected
  FROM mcp_servers
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  RETURN v_protected;
END;
$$;

ALTER FUNCTION load_mcp_credential(uuid, uuid) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION load_mcp_credential(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_mcp_credential(uuid, uuid) TO llm_runtime;

CREATE FUNCTION set_mcp_tool_permission(
  p_tenant_id uuid,
  p_server_id uuid,
  p_remote_name text,
  p_allowed boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_remote_name IS NULL OR p_remote_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
    RAISE EXCEPTION 'tool name is invalid';
  END IF;
  IF p_allowed IS NULL THEN
    RAISE EXCEPTION 'permission is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mcp_servers
    WHERE tenant_id = p_tenant_id
      AND id = p_server_id
  ) THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
  INSERT INTO mcp_tool_permissions (tenant_id, server_id, remote_name, allowed)
  VALUES (p_tenant_id, p_server_id, p_remote_name, p_allowed)
  ON CONFLICT (tenant_id, server_id, remote_name)
  DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now();
  RETURN p_allowed;
END;
$$;

ALTER FUNCTION set_mcp_tool_permission(uuid, uuid, text, boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION set_mcp_tool_permission(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_mcp_tool_permission(uuid, uuid, text, boolean) TO llm_runtime;

CREATE FUNCTION store_mcp_catalog(
  p_tenant_id uuid,
  p_server_id uuid,
  p_fingerprint text,
  p_ttl_ms integer,
  p_cache_scope text,
  p_protocol_version text,
  p_tools jsonb
)
RETURNS TABLE (catalog_version integer, changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_version integer;
  v_fingerprint text;
  v_tool jsonb;
  v_remote text;
  v_namespaced text;
  v_description text;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'fingerprint is invalid';
  END IF;
  IF p_ttl_ms IS NULL OR p_ttl_ms < 0 OR p_ttl_ms > 2592000000 THEN
    RAISE EXCEPTION 'catalog lifetime is invalid';
  END IF;
  IF p_cache_scope IS NULL OR p_cache_scope NOT IN ('public', 'private') THEN
    RAISE EXCEPTION 'cache scope is invalid';
  END IF;
  IF p_protocol_version IS NULL OR p_protocol_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'protocol version is invalid';
  END IF;
  IF p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' OR jsonb_array_length(p_tools) > 32 THEN
    RAISE EXCEPTION 'catalog is too large';
  END IF;
  SELECT server_key, mcp_servers.catalog_version, mcp_servers.catalog_fingerprint
    INTO v_key, v_version, v_fingerprint
  FROM mcp_servers
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
  IF v_fingerprint IS NOT DISTINCT FROM p_fingerprint AND v_version > 0 THEN
    UPDATE mcp_servers
    SET catalog_cached_at = now(),
        ttl_ms = p_ttl_ms,
        cache_scope = p_cache_scope,
        protocol_version = p_protocol_version,
        connection_status = 'ok',
        last_checked_at = now(),
        last_error = NULL
    WHERE tenant_id = p_tenant_id
      AND id = p_server_id;
    RETURN QUERY SELECT v_version, false;
    RETURN;
  END IF;
  v_version := v_version + 1;
  FOR v_tool IN SELECT value FROM jsonb_array_elements(p_tools) LOOP
    v_remote := v_tool->>'remoteName';
    v_namespaced := v_tool->>'namespacedName';
    v_description := COALESCE(v_tool->>'description', '');
    IF v_remote IS NULL OR v_remote !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
      RAISE EXCEPTION 'tool name is invalid';
    END IF;
    IF v_namespaced IS DISTINCT FROM v_key || '/' || v_remote THEN
      RAISE EXCEPTION 'tool name is invalid';
    END IF;
    IF char_length(v_description) > 512 OR v_description ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'tool description is invalid';
    END IF;
    IF v_tool->'inputSchema' IS NULL OR jsonb_typeof(v_tool->'inputSchema') <> 'object' THEN
      RAISE EXCEPTION 'tool schema is invalid';
    END IF;
    IF jsonb_typeof(v_tool->'outputSchema') IS NOT NULL
      AND jsonb_typeof(v_tool->'outputSchema') <> 'null'
      AND jsonb_typeof(v_tool->'outputSchema') <> 'object' THEN
      RAISE EXCEPTION 'tool schema is invalid';
    END IF;
    INSERT INTO mcp_tool_definitions (
      tenant_id,
      server_id,
      catalog_version,
      remote_name,
      namespaced_name,
      description,
      input_schema,
      output_schema
    ) VALUES (
      p_tenant_id,
      p_server_id,
      v_version,
      v_remote,
      v_namespaced,
      v_description,
      v_tool->'inputSchema',
      CASE WHEN v_tool->'outputSchema' IS NULL OR jsonb_typeof(v_tool->'outputSchema') = 'null' THEN NULL ELSE v_tool->'outputSchema' END
    );
    INSERT INTO mcp_tool_permissions (tenant_id, server_id, remote_name, allowed)
    VALUES (p_tenant_id, p_server_id, v_remote, false)
    ON CONFLICT (tenant_id, server_id, remote_name) DO NOTHING;
  END LOOP;
  UPDATE mcp_servers
  SET catalog_version = v_version,
      catalog_fingerprint = p_fingerprint,
      catalog_cached_at = now(),
      ttl_ms = p_ttl_ms,
      cache_scope = p_cache_scope,
      protocol_version = p_protocol_version,
      connection_status = 'ok',
      last_checked_at = now(),
      last_error = NULL
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  RETURN QUERY SELECT v_version, true;
END;
$$;

ALTER FUNCTION store_mcp_catalog(uuid, uuid, text, integer, text, text, jsonb) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION store_mcp_catalog(uuid, uuid, text, integer, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION store_mcp_catalog(uuid, uuid, text, integer, text, text, jsonb) TO llm_runtime;

RESET ROLE;
