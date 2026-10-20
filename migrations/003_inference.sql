-- Additive inference tables. Slice 00 tables and grants are unchanged.
-- tenants is already owned by llm_owner. The migrator does not inherit that
-- owner's privileges, so a foreign key to tenants must be created as llm_owner.
-- This file returns to the migrator before the version row is recorded.
-- ALTER FUNCTION OWNER replaces the function ACL, so those grants are repeated.

SET LOCAL ROLE llm_owner;

CREATE TABLE provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  provider text NOT NULL CHECK (provider = 'openai'),
  protected_credential text NOT NULL CHECK (
    protected_credential LIKE 'aes-256-gcm$%'
    AND protected_credential !~ '[[:space:]]'
    AND char_length(protected_credential) BETWEEN 40 AND 4096
  ),
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE model_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK (
    name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND name <> 'auto'
  ),
  upstream_model text NOT NULL CHECK (
    char_length(upstream_model) BETWEEN 1 AND 128
    AND upstream_model !~ '[[:space:]]'
  ),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 600000),
  capabilities text[] NOT NULL DEFAULT '{}' CHECK (
    capabilities <@ ARRAY[
      'temperature',
      'top_p',
      'max_tokens',
      'max_completion_tokens',
      'stop',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'n',
      'user',
      'response_format_text'
    ]::text[]
  ),
  enabled boolean NOT NULL DEFAULT false,
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES provider_connections (tenant_id, id)
);

CREATE TABLE model_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  alias text NOT NULL CHECK (alias = 'auto'),
  deployment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, alias),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id)
);

CREATE TABLE proxy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  deployment_config_version integer NOT NULL CHECK (deployment_config_version > 0),
  connection_id uuid NOT NULL,
  connection_version integer NOT NULL CHECK (connection_version > 0),
  requested_model text NOT NULL CHECK (
    char_length(requested_model) BETWEEN 1 AND 128
    AND requested_model !~ '[[:space:]]'
  ),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES provider_connections (tenant_id, id)
);

CREATE TABLE model_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  deployment_config_version integer NOT NULL CHECK (deployment_config_version > 0),
  upstream_model text NOT NULL CHECK (
    char_length(upstream_model) BETWEEN 1 AND 128
    AND upstream_model !~ '[[:space:]]'
  ),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id)
);

CREATE INDEX provider_connections_tenant_idx ON provider_connections (tenant_id);
CREATE INDEX model_deployments_tenant_enabled_idx ON model_deployments (tenant_id, enabled);
CREATE INDEX model_aliases_tenant_idx ON model_aliases (tenant_id);
CREATE INDEX proxy_requests_tenant_created_idx ON proxy_requests (tenant_id, created_at);
CREATE INDEX model_attempts_request_idx ON model_attempts (tenant_id, request_id);
CREATE INDEX model_attempts_tenant_created_idx ON model_attempts (tenant_id, created_at);

ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE model_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_deployments FORCE ROW LEVEL SECURITY;
ALTER TABLE model_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE proxy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE proxy_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE model_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_connections_isolation ON provider_connections
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY model_deployments_isolation ON model_deployments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY model_aliases_isolation ON model_aliases
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY proxy_requests_isolation ON proxy_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY model_attempts_isolation ON model_attempts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON provider_connections FROM PUBLIC;
REVOKE ALL ON model_deployments FROM PUBLIC;
REVOKE ALL ON model_aliases FROM PUBLIC;
REVOKE ALL ON proxy_requests FROM PUBLIC;
REVOKE ALL ON model_attempts FROM PUBLIC;

GRANT SELECT (
  id,
  tenant_id,
  provider,
  credential_version,
  enabled,
  created_at,
  updated_at
) ON provider_connections TO llm_runtime;

GRANT SELECT ON model_deployments TO llm_runtime;
GRANT SELECT ON model_aliases TO llm_runtime;
GRANT SELECT, INSERT ON proxy_requests TO llm_runtime;
GRANT UPDATE (status, completed_at) ON proxy_requests TO llm_runtime;
GRANT SELECT, INSERT ON model_attempts TO llm_runtime;
GRANT UPDATE (
  status,
  error_code,
  duration_ms,
  prompt_tokens,
  completion_tokens,
  total_tokens
) ON model_attempts TO llm_runtime;

CREATE FUNCTION register_openai_connection(p_tenant_id uuid, p_protected text)
RETURNS TABLE (connection_id uuid, credential_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'protected credential is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  INSERT INTO provider_connections (tenant_id, provider, protected_credential)
  VALUES (p_tenant_id, 'openai', p_protected)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'openai connection already exists';
END;
$$;

CREATE FUNCTION replace_openai_credential(p_tenant_id uuid, p_protected text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'protected credential is invalid';
  END IF;
  UPDATE provider_connections
  SET protected_credential = p_protected,
      credential_version = credential_version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND provider = 'openai'
  RETURNING credential_version INTO v_version;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'openai connection is missing';
  END IF;
  RETURN v_version;
END;
$$;

CREATE FUNCTION set_openai_connection_enabled(p_tenant_id uuid, p_enabled boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  UPDATE provider_connections
  SET enabled = p_enabled,
      credential_version = credential_version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND provider = 'openai'
  RETURNING credential_version INTO v_version;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'openai connection is missing';
  END IF;
  RETURN v_version;
END;
$$;

CREATE FUNCTION register_model_deployment(
  p_tenant_id uuid,
  p_name text,
  p_upstream_model text,
  p_timeout_ms integer,
  p_capabilities text[],
  p_enabled boolean
)
RETURNS TABLE (deployment_id uuid, config_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection uuid;
  v_id uuid;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_name = 'auto' THEN
    RAISE EXCEPTION 'deployment name is invalid';
  END IF;
  IF p_upstream_model IS NULL
    OR char_length(p_upstream_model) < 1
    OR char_length(p_upstream_model) > 128
    OR p_upstream_model ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'upstream model is invalid';
  END IF;
  IF p_timeout_ms IS NULL OR p_timeout_ms < 100 OR p_timeout_ms > 600000 THEN
    RAISE EXCEPTION 'timeout is invalid';
  END IF;
  IF p_capabilities IS NULL
    OR EXISTS (
      SELECT 1
      FROM unnest(p_capabilities) AS cap
      WHERE cap NOT IN (
        'temperature',
        'top_p',
        'max_tokens',
        'max_completion_tokens',
        'stop',
        'presence_penalty',
        'frequency_penalty',
        'seed',
        'n',
        'user',
        'response_format_text'
      )
    )
    OR (SELECT count(*) FROM unnest(p_capabilities))
      <> (SELECT count(DISTINCT cap) FROM unnest(p_capabilities) AS cap) THEN
    RAISE EXCEPTION 'capabilities are invalid';
  END IF;
  SELECT id INTO v_connection
  FROM provider_connections
  WHERE tenant_id = p_tenant_id
    AND provider = 'openai';
  IF v_connection IS NULL THEN
    RAISE EXCEPTION 'openai connection is missing';
  END IF;
  INSERT INTO model_deployments (
    tenant_id,
    connection_id,
    name,
    upstream_model,
    timeout_ms,
    capabilities,
    enabled
  )
  VALUES (
    p_tenant_id,
    v_connection,
    p_name,
    p_upstream_model,
    p_timeout_ms,
    p_capabilities,
    coalesce(p_enabled, false)
  )
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'deployment already exists';
END;
$$;

CREATE FUNCTION set_model_deployment_enabled(p_tenant_id uuid, p_name text, p_enabled boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  UPDATE model_deployments
  SET enabled = p_enabled,
      config_version = config_version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND name = p_name
  RETURNING config_version INTO v_version;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  RETURN v_version;
END;
$$;

CREATE FUNCTION set_model_alias(p_tenant_id uuid, p_alias text, p_deployment_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deployment uuid;
  v_alias uuid;
BEGIN
  IF p_alias IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'alias is invalid';
  END IF;
  SELECT id INTO v_deployment
  FROM model_deployments
  WHERE tenant_id = p_tenant_id
    AND name = p_deployment_name;
  IF v_deployment IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  INSERT INTO model_aliases (tenant_id, alias, deployment_id)
  VALUES (p_tenant_id, 'auto', v_deployment)
  ON CONFLICT (tenant_id, alias)
  DO UPDATE SET deployment_id = EXCLUDED.deployment_id
  RETURNING id INTO v_alias;
  RETURN v_alias;
END;
$$;

CREATE FUNCTION list_tenant_inference(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  RETURN jsonb_build_object(
    'connections',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'provider', provider,
        'enabled', enabled,
        'credentialVersion', credential_version,
        'createdAt', created_at
      ) ORDER BY created_at)
      FROM provider_connections
      WHERE tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'deployments',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'connectionId', connection_id,
        'name', name,
        'upstreamModel', upstream_model,
        'timeoutMs', timeout_ms,
        'capabilities', to_jsonb(capabilities),
        'enabled', enabled,
        'configVersion', config_version,
        'createdAt', created_at
      ) ORDER BY name)
      FROM model_deployments
      WHERE tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'aliases',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'alias', alias,
        'deploymentId', deployment_id,
        'createdAt', created_at
      ) ORDER BY alias)
      FROM model_aliases
      WHERE tenant_id = p_tenant_id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE FUNCTION load_provider_credential(p_tenant_id uuid, p_connection_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_protected text;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id THEN
    RETURN NULL;
  END IF;
  SELECT protected_credential INTO v_protected
  FROM provider_connections
  WHERE id = p_connection_id
    AND tenant_id = p_tenant_id
    AND enabled = true;
  RETURN v_protected;
END;
$$;

REVOKE ALL ON FUNCTION register_openai_connection(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION replace_openai_credential(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_openai_connection_enabled(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_model_deployment(uuid, text, text, integer, text[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_model_deployment_enabled(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_model_alias(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_tenant_inference(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION load_provider_credential(uuid, uuid) FROM PUBLIC;

ALTER TABLE provider_connections OWNER TO llm_owner;
ALTER TABLE model_deployments OWNER TO llm_owner;
ALTER TABLE model_aliases OWNER TO llm_owner;
ALTER TABLE proxy_requests OWNER TO llm_owner;
ALTER TABLE model_attempts OWNER TO llm_owner;
ALTER FUNCTION register_openai_connection(uuid, text) OWNER TO llm_owner;
ALTER FUNCTION replace_openai_credential(uuid, text) OWNER TO llm_owner;
ALTER FUNCTION set_openai_connection_enabled(uuid, boolean) OWNER TO llm_owner;
ALTER FUNCTION register_model_deployment(uuid, text, text, integer, text[], boolean) OWNER TO llm_owner;
ALTER FUNCTION set_model_deployment_enabled(uuid, text, boolean) OWNER TO llm_owner;
ALTER FUNCTION set_model_alias(uuid, text, text) OWNER TO llm_owner;
ALTER FUNCTION list_tenant_inference(uuid) OWNER TO llm_owner;
ALTER FUNCTION load_provider_credential(uuid, uuid) OWNER TO llm_owner;

SET LOCAL ROLE llm_owner;
GRANT SELECT (
  id,
  tenant_id,
  provider,
  credential_version,
  enabled,
  created_at,
  updated_at
) ON provider_connections TO llm_runtime;
GRANT SELECT ON model_deployments TO llm_runtime;
GRANT SELECT ON model_aliases TO llm_runtime;
GRANT SELECT, INSERT ON proxy_requests TO llm_runtime;
GRANT UPDATE (status, completed_at) ON proxy_requests TO llm_runtime;
GRANT SELECT, INSERT ON model_attempts TO llm_runtime;
GRANT UPDATE (
  status,
  error_code,
  duration_ms,
  prompt_tokens,
  completion_tokens,
  total_tokens
) ON model_attempts TO llm_runtime;
GRANT EXECUTE ON FUNCTION register_openai_connection(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION replace_openai_credential(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_openai_connection_enabled(uuid, boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION register_model_deployment(uuid, text, text, integer, text[], boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_model_deployment_enabled(uuid, text, boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_model_alias(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION list_tenant_inference(uuid) TO llm_migrator;
GRANT EXECUTE ON FUNCTION load_provider_credential(uuid, uuid) TO llm_runtime;
RESET ROLE;
