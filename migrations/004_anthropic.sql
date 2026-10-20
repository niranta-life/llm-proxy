-- Additive Anthropic fields on the Slice 01 registry.
-- Existing OpenAI rows stay in place. New columns are nullable.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_provider_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_provider_check
  CHECK (provider IN ('openai', 'anthropic'));

ALTER TABLE provider_connections
  ADD COLUMN endpoint text,
  ADD COLUMN workspace_id text;

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_endpoint_check CHECK (
    endpoint IS NULL
    OR (
      char_length(endpoint) BETWEEN 8 AND 512
      AND endpoint ~ '^https?://[^[:space:]]+$'
      AND endpoint !~ '://[^/]*@'
    )
  );

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_workspace_id_check CHECK (
    workspace_id IS NULL
    OR (
      char_length(workspace_id) BETWEEN 1 AND 128
      AND workspace_id !~ '[[:space:]]'
    )
  );

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_anthropic_endpoint_check CHECK (
    provider <> 'anthropic' OR endpoint IS NOT NULL
  );

ALTER TABLE model_deployments
  ADD COLUMN default_max_output_tokens integer;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_default_max_output_tokens_check CHECK (
    default_max_output_tokens IS NULL
    OR default_max_output_tokens BETWEEN 1 AND 128000
  );

ALTER TABLE model_attempts
  ADD COLUMN provider_request_id text,
  ADD COLUMN stop_reason text,
  ADD COLUMN uncached_input_tokens integer,
  ADD COLUMN cache_creation_input_tokens integer,
  ADD COLUMN cache_read_input_tokens integer;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_provider_request_id_check CHECK (
    provider_request_id IS NULL
    OR (
      char_length(provider_request_id) BETWEEN 1 AND 256
      AND provider_request_id !~ '[[:space:]]'
    )
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_stop_reason_check CHECK (
    stop_reason IS NULL OR stop_reason ~ '^[a-z0-9_]{1,64}$'
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_uncached_input_tokens_check CHECK (
    uncached_input_tokens IS NULL OR uncached_input_tokens >= 0
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_cache_creation_input_tokens_check CHECK (
    cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_cache_read_input_tokens_check CHECK (
    cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0
  );

GRANT SELECT (endpoint, workspace_id) ON provider_connections TO llm_runtime;
GRANT UPDATE (
  provider_request_id,
  stop_reason,
  uncached_input_tokens,
  cache_creation_input_tokens,
  cache_read_input_tokens
) ON model_attempts TO llm_runtime;

CREATE FUNCTION register_anthropic_connection(
  p_tenant_id uuid,
  p_protected text,
  p_endpoint text,
  p_workspace_id text
)
RETURNS TABLE (connection_id uuid, credential_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_endpoint text;
  v_workspace text;
BEGIN
  IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'protected credential is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  v_endpoint := btrim(coalesce(p_endpoint, ''));
  v_endpoint := regexp_replace(v_endpoint, '/+$', '');
  IF v_endpoint !~ '^https?://[^[:space:]]+$'
    OR v_endpoint ~ '://[^/]*@'
    OR char_length(v_endpoint) < 8
    OR char_length(v_endpoint) > 512 THEN
    RAISE EXCEPTION 'endpoint is invalid';
  END IF;
  v_workspace := nullif(btrim(coalesce(p_workspace_id, '')), '');
  IF v_workspace IS NOT NULL AND (
    char_length(v_workspace) > 128 OR v_workspace ~ '[[:space:]]'
  ) THEN
    RAISE EXCEPTION 'workspace id is invalid';
  END IF;
  INSERT INTO provider_connections (tenant_id, provider, protected_credential, endpoint, workspace_id)
  VALUES (p_tenant_id, 'anthropic', p_protected, v_endpoint, v_workspace)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'anthropic connection already exists';
END;
$$;

CREATE FUNCTION replace_anthropic_credential(p_tenant_id uuid, p_protected text)
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
    AND provider = 'anthropic'
  RETURNING credential_version INTO v_version;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'anthropic connection is missing';
  END IF;
  RETURN v_version;
END;
$$;

CREATE FUNCTION set_provider_connection_enabled(p_tenant_id uuid, p_provider text, p_enabled boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('openai', 'anthropic') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  UPDATE provider_connections
  SET enabled = p_enabled,
      credential_version = credential_version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND provider = p_provider
  RETURNING credential_version INTO v_version;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'provider connection is missing';
  END IF;
  RETURN v_version;
END;
$$;

CREATE FUNCTION register_provider_deployment(
  p_tenant_id uuid,
  p_provider text,
  p_name text,
  p_upstream_model text,
  p_timeout_ms integer,
  p_capabilities text[],
  p_enabled boolean,
  p_default_max_output_tokens integer
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
  IF p_provider IS NULL OR p_provider NOT IN ('openai', 'anthropic') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
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
  IF p_provider = 'anthropic' THEN
    IF p_default_max_output_tokens IS NULL
      OR p_default_max_output_tokens < 1
      OR p_default_max_output_tokens > 128000 THEN
      RAISE EXCEPTION 'default max output tokens is invalid';
    END IF;
  ELSIF p_default_max_output_tokens IS NOT NULL THEN
    RAISE EXCEPTION 'default max output tokens is invalid';
  END IF;
  SELECT id INTO v_connection
  FROM provider_connections
  WHERE tenant_id = p_tenant_id
    AND provider = p_provider;
  IF v_connection IS NULL THEN
    RAISE EXCEPTION 'provider connection is missing';
  END IF;
  INSERT INTO model_deployments (
    tenant_id,
    connection_id,
    name,
    upstream_model,
    timeout_ms,
    capabilities,
    enabled,
    default_max_output_tokens
  )
  VALUES (
    p_tenant_id,
    v_connection,
    p_name,
    p_upstream_model,
    p_timeout_ms,
    p_capabilities,
    coalesce(p_enabled, false),
    p_default_max_output_tokens
  )
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'deployment already exists';
END;
$$;

CREATE OR REPLACE FUNCTION list_tenant_inference(p_tenant_id uuid)
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
        'endpoint', endpoint,
        'workspaceId', workspace_id,
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
        'defaultMaxOutputTokens', default_max_output_tokens,
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

ALTER FUNCTION register_anthropic_connection(uuid, text, text, text) OWNER TO llm_owner;
ALTER FUNCTION replace_anthropic_credential(uuid, text) OWNER TO llm_owner;
ALTER FUNCTION set_provider_connection_enabled(uuid, text, boolean) OWNER TO llm_owner;
ALTER FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) OWNER TO llm_owner;
ALTER FUNCTION list_tenant_inference(uuid) OWNER TO llm_owner;

REVOKE ALL ON FUNCTION register_anthropic_connection(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION replace_anthropic_credential(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_provider_connection_enabled(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) FROM PUBLIC;

SET LOCAL ROLE llm_owner;
GRANT SELECT (endpoint, workspace_id) ON provider_connections TO llm_runtime;
GRANT UPDATE (
  provider_request_id,
  stop_reason,
  uncached_input_tokens,
  cache_creation_input_tokens,
  cache_read_input_tokens
) ON model_attempts TO llm_runtime;
GRANT EXECUTE ON FUNCTION register_anthropic_connection(uuid, text, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION replace_anthropic_credential(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_provider_connection_enabled(uuid, text, boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION list_tenant_inference(uuid) TO llm_migrator;
RESET ROLE;
