-- Additive registry fields for Vertex, xAI, OpenRouter, and private DGX.
-- Existing OpenAI and Anthropic rows stay valid.
-- This file does not drop a column.
-- This file does not edit migrations 001 through 007.
-- Rollback keeps this file applied.
-- Image llm-proxy:67979e9 stays ready while 007_stream_interrupted.sql remains applied.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE provider_connections
  ADD COLUMN auth_mode text NOT NULL DEFAULT 'api_key',
  ADD COLUMN config_version integer NOT NULL DEFAULT 1,
  ADD COLUMN project_id text,
  ADD COLUMN location text;

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_auth_mode_check
  CHECK (auth_mode IN ('api_key', 'service_account'));

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_config_version_check
  CHECK (config_version > 0);

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_provider_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx'));

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_registry_shape_check CHECK (
    (
      provider = 'openai'
      AND auth_mode = 'api_key'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
    )
    OR (
      provider = 'anthropic'
      AND auth_mode = 'api_key'
      AND endpoint IS NOT NULL
      AND project_id IS NULL
      AND location IS NULL
    )
    OR (
      provider = 'vertex'
      AND auth_mode = 'service_account'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NOT NULL
      AND location IS NOT NULL
      AND project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
      AND (location = 'global' OR location ~ '^[a-z]+(-[a-z0-9]+){1,3}$')
    )
    OR (
      provider = 'xai'
      AND auth_mode = 'api_key'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
    )
    OR (
      provider = 'openrouter'
      AND auth_mode = 'api_key'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
    )
    OR (
      provider = 'dgx'
      AND auth_mode = 'api_key'
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
      AND endpoint IS NOT NULL
      AND endpoint ~ '^https://[^[:space:]]+$'
      AND endpoint !~ '://[^/]*@'
      AND substring(endpoint FROM '^https://([^/:]+)') IS NOT NULL
      AND substring(endpoint FROM '^https://([^/:]+)') !~* '(^|\.)(openai\.com|anthropic\.com|x\.ai|openrouter\.ai|googleapis\.com)$'
    )
  );

ALTER TABLE model_deployments
  ADD COLUMN validation_status text NOT NULL DEFAULT 'unvalidated',
  ADD COLUMN health_status text NOT NULL DEFAULT 'unknown';

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_validation_status_check
  CHECK (validation_status IN ('unvalidated', 'valid', 'invalid'));

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_health_status_check
  CHECK (health_status IN ('unknown', 'healthy', 'unhealthy'));

CREATE INDEX model_deployments_tenant_validation_idx
  ON model_deployments (tenant_id, validation_status);

GRANT SELECT (auth_mode, config_version, project_id, location) ON provider_connections TO llm_runtime;

CREATE OR REPLACE FUNCTION set_openai_connection_enabled(p_tenant_id uuid, p_enabled boolean)
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
      config_version = config_version + 1,
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

CREATE OR REPLACE FUNCTION replace_openai_credential(p_tenant_id uuid, p_protected text)
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
      config_version = config_version + 1,
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

CREATE OR REPLACE FUNCTION replace_anthropic_credential(p_tenant_id uuid, p_protected text)
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
      config_version = config_version + 1,
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

CREATE OR REPLACE FUNCTION set_provider_connection_enabled(p_tenant_id uuid, p_provider text, p_enabled boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  UPDATE provider_connections
  SET enabled = p_enabled,
      credential_version = credential_version + 1,
      config_version = config_version + 1,
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

CREATE FUNCTION register_registry_connection(
  p_tenant_id uuid,
  p_provider text,
  p_protected text,
  p_auth_mode text,
  p_endpoint text,
  p_project_id text,
  p_location text
)
RETURNS TABLE (connection_id uuid, credential_version integer, config_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_endpoint text;
  v_project text;
  v_location text;
  v_host text;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('vertex', 'xai', 'openrouter', 'dgx') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'protected credential is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  IF p_provider = 'vertex' THEN
    IF p_auth_mode IS DISTINCT FROM 'service_account' THEN
      RAISE EXCEPTION 'auth mode is not supported';
    END IF;
  ELSIF p_auth_mode IS DISTINCT FROM 'api_key' THEN
    RAISE EXCEPTION 'auth mode is not supported';
  END IF;
  v_endpoint := nullif(regexp_replace(btrim(coalesce(p_endpoint, '')), '/+$', ''), '');
  v_project := nullif(btrim(coalesce(p_project_id, '')), '');
  v_location := nullif(btrim(coalesce(p_location, '')), '');
  IF p_provider = 'vertex' THEN
    IF v_endpoint IS NOT NULL THEN
      RAISE EXCEPTION 'endpoint is not allowed';
    END IF;
    IF v_project IS NULL OR v_project !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' THEN
      RAISE EXCEPTION 'project is invalid';
    END IF;
    IF v_location IS NULL OR NOT (v_location = 'global' OR v_location ~ '^[a-z]+(-[a-z0-9]+){1,3}$') THEN
      RAISE EXCEPTION 'location is invalid';
    END IF;
  ELSE
    IF v_project IS NOT NULL THEN
      RAISE EXCEPTION 'project is not allowed';
    END IF;
    IF v_location IS NOT NULL THEN
      RAISE EXCEPTION 'location is not allowed';
    END IF;
    IF p_provider = 'dgx' THEN
      IF v_endpoint IS NULL
        OR v_endpoint !~ '^https://[^[:space:]]+$'
        OR v_endpoint ~ '://[^/]*@'
        OR char_length(v_endpoint) < 8
        OR char_length(v_endpoint) > 512 THEN
        RAISE EXCEPTION 'endpoint is invalid';
      END IF;
      v_host := substring(v_endpoint FROM '^https://([^/:]+)');
      IF v_host IS NULL
        OR v_host ~* '(^|\.)(openai\.com|anthropic\.com|x\.ai|openrouter\.ai|googleapis\.com)$' THEN
        RAISE EXCEPTION 'endpoint is invalid';
      END IF;
    ELSIF v_endpoint IS NOT NULL THEN
      RAISE EXCEPTION 'endpoint is not allowed';
    END IF;
  END IF;
  INSERT INTO provider_connections (
    tenant_id,
    provider,
    protected_credential,
    auth_mode,
    endpoint,
    project_id,
    location
  )
  VALUES (
    p_tenant_id,
    p_provider,
    p_protected,
    p_auth_mode,
    v_endpoint,
    v_project,
    v_location
  )
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'provider connection already exists';
END;
$$;

CREATE OR REPLACE FUNCTION register_provider_deployment(
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
  IF p_provider IS NULL OR p_provider NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx') THEN
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

CREATE FUNCTION set_deployment_validation(p_tenant_id uuid, p_name text, p_status text)
RETURNS TABLE (config_version integer, validation_status text, health_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config integer;
  v_validation text;
  v_health text;
BEGIN
  IF p_name IS NULL OR p_name = '' OR p_status IS NULL OR p_status NOT IN ('unvalidated', 'valid', 'invalid') THEN
    RAISE EXCEPTION 'validation status is invalid';
  END IF;
  UPDATE model_deployments AS d
  SET validation_status = p_status,
      config_version = d.config_version + 1,
      updated_at = now()
  WHERE d.tenant_id = p_tenant_id
    AND d.name = p_name
  RETURNING d.config_version, d.validation_status, d.health_status
  INTO v_config, v_validation, v_health;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  config_version := v_config;
  validation_status := v_validation;
  health_status := v_health;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION set_deployment_health(p_tenant_id uuid, p_name text, p_status text)
RETURNS TABLE (config_version integer, validation_status text, health_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config integer;
  v_validation text;
  v_health text;
BEGIN
  IF p_name IS NULL OR p_name = '' OR p_status IS NULL OR p_status NOT IN ('unknown', 'healthy', 'unhealthy') THEN
    RAISE EXCEPTION 'health status is invalid';
  END IF;
  UPDATE model_deployments AS d
  SET health_status = p_status,
      updated_at = now()
  WHERE d.tenant_id = p_tenant_id
    AND d.name = p_name
  RETURNING d.config_version, d.validation_status, d.health_status
  INTO v_config, v_validation, v_health;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  config_version := v_config;
  validation_status := v_validation;
  health_status := v_health;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION list_tenant_inference(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_streaming boolean;
BEGIN
  SELECT streaming_enabled INTO v_streaming
  FROM tenants
  WHERE id = p_tenant_id;
  IF v_streaming IS NULL THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  RETURN jsonb_build_object(
    'streamingEnabled', v_streaming,
    'connections',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'provider', provider,
        'enabled', enabled,
        'credentialVersion', credential_version,
        'configVersion', config_version,
        'authMode', auth_mode,
        'endpoint', endpoint,
        'workspaceId', workspace_id,
        'projectId', project_id,
        'location', location,
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
        'streamingEnabled', streaming_enabled,
        'streamConnectTimeoutMs', stream_connect_timeout_ms,
        'streamIdleTimeoutMs', stream_idle_timeout_ms,
        'streamTotalTimeoutMs', stream_total_timeout_ms,
        'streamBackpressureTimeoutMs', stream_backpressure_timeout_ms,
        'validationStatus', validation_status,
        'healthStatus', health_status,
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

REVOKE ALL ON FUNCTION register_registry_connection(uuid, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_validation(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_health(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION register_registry_connection(uuid, text, text, text, text, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_validation(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_health(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_openai_connection_enabled(uuid, boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION replace_openai_credential(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION replace_anthropic_credential(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_provider_connection_enabled(uuid, text, boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION list_tenant_inference(uuid) TO llm_migrator;

RESET ROLE;
