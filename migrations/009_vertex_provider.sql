-- Additive Vertex auth, API version, and thinking-token storage.
-- Existing OpenAI, Anthropic, and service-account Vertex rows stay valid.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 008.
-- Rollback keeps this file applied.
-- Image llm-proxy:8020fb2 stays ready while 008_provider_registry.sql remains applied.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_auth_mode_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_auth_mode_check
  CHECK (auth_mode IN ('api_key', 'service_account', 'adc', 'workload_identity', 'impersonation'));

ALTER TABLE provider_connections
  ADD COLUMN service_account_identity text,
  ADD COLUMN api_version text NOT NULL DEFAULT 'v1';

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_api_version_check
  CHECK (api_version IN ('v1', 'v1beta1'));

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_identity_check
  CHECK (
    service_account_identity IS NULL
    OR service_account_identity ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'
    OR service_account_identity ~ '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/serviceAccounts/[0-9]{6,30}$'
  );

ALTER TABLE provider_connections ALTER COLUMN protected_credential DROP NOT NULL;

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_registry_shape_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_registry_shape_check CHECK (
    (
      provider = 'openai'
      AND auth_mode = 'api_key'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
      AND service_account_identity IS NULL
      AND api_version = 'v1'
      AND protected_credential IS NOT NULL
    )
    OR (
      provider = 'anthropic'
      AND auth_mode = 'api_key'
      AND endpoint IS NOT NULL
      AND project_id IS NULL
      AND location IS NULL
      AND service_account_identity IS NULL
      AND api_version = 'v1'
      AND protected_credential IS NOT NULL
    )
    OR (
      provider = 'vertex'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NOT NULL
      AND location IS NOT NULL
      AND project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
      AND (location = 'global' OR location ~ '^[a-z]+(-[a-z0-9]+){1,3}$')
      AND api_version IN ('v1', 'v1beta1')
      AND (
        (
          auth_mode = 'service_account'
          AND protected_credential IS NOT NULL
        )
        OR (
          auth_mode IN ('adc', 'workload_identity')
          AND protected_credential IS NULL
        )
        OR (
          auth_mode = 'impersonation'
          AND protected_credential IS NULL
          AND service_account_identity IS NOT NULL
        )
      )
    )
    OR (
      provider = 'xai'
      AND auth_mode = 'api_key'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
      AND service_account_identity IS NULL
      AND api_version = 'v1'
      AND protected_credential IS NOT NULL
    )
    OR (
      provider = 'openrouter'
      AND auth_mode = 'api_key'
      AND endpoint IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
      AND service_account_identity IS NULL
      AND api_version = 'v1'
      AND protected_credential IS NOT NULL
    )
    OR (
      provider = 'dgx'
      AND auth_mode = 'api_key'
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND location IS NULL
      AND service_account_identity IS NULL
      AND api_version = 'v1'
      AND protected_credential IS NOT NULL
      AND endpoint IS NOT NULL
      AND endpoint ~ '^https://[^[:space:]]+$'
      AND endpoint !~ '://[^/]*@'
      AND substring(endpoint FROM '^https://([^/:]+)') IS NOT NULL
      AND substring(endpoint FROM '^https://([^/:]+)') !~* '(^|\.)(openai\.com|anthropic\.com|x\.ai|openrouter\.ai|googleapis\.com)$'
    )
  );

ALTER TABLE model_attempts
  ADD COLUMN thoughts_tokens integer;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_thoughts_tokens_check
  CHECK (thoughts_tokens IS NULL OR thoughts_tokens >= 0);

GRANT SELECT (service_account_identity, api_version) ON provider_connections TO llm_runtime;
GRANT UPDATE (thoughts_tokens) ON model_attempts TO llm_runtime;

DROP FUNCTION register_registry_connection(uuid, text, text, text, text, text, text);

CREATE FUNCTION register_registry_connection(
  p_tenant_id uuid,
  p_provider text,
  p_protected text,
  p_auth_mode text,
  p_endpoint text,
  p_project_id text,
  p_location text,
  p_identity text DEFAULT NULL,
  p_api_version text DEFAULT 'v1'
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
  v_identity text;
  v_api text;
  v_host text;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('vertex', 'xai', 'openrouter', 'dgx') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  v_identity := nullif(btrim(coalesce(p_identity, '')), '');
  v_api := coalesce(nullif(btrim(coalesce(p_api_version, '')), ''), 'v1');
  IF v_api NOT IN ('v1', 'v1beta1') THEN
    RAISE EXCEPTION 'api version is invalid';
  END IF;
  IF v_identity IS NOT NULL
    AND v_identity !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'
    AND v_identity !~ '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/serviceAccounts/[0-9]{6,30}$' THEN
    RAISE EXCEPTION 'service account identity is invalid';
  END IF;
  IF p_provider = 'vertex' THEN
    IF p_auth_mode IS NULL OR p_auth_mode NOT IN ('service_account', 'adc', 'workload_identity', 'impersonation') THEN
      RAISE EXCEPTION 'auth mode is not supported';
    END IF;
    IF p_auth_mode = 'impersonation' AND v_identity IS NULL THEN
      RAISE EXCEPTION 'service account identity is required';
    END IF;
    IF p_auth_mode = 'service_account' THEN
      IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
        RAISE EXCEPTION 'protected credential is invalid';
      END IF;
    ELSIF p_protected IS NOT NULL THEN
      RAISE EXCEPTION 'protected credential is invalid';
    END IF;
  ELSE
    IF p_auth_mode IS DISTINCT FROM 'api_key' THEN
      RAISE EXCEPTION 'auth mode is not supported';
    END IF;
    IF v_identity IS NOT NULL THEN
      RAISE EXCEPTION 'service account identity is not allowed';
    END IF;
    IF v_api IS DISTINCT FROM 'v1' THEN
      RAISE EXCEPTION 'api version is invalid';
    END IF;
    IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
      RAISE EXCEPTION 'protected credential is invalid';
    END IF;
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
    location,
    service_account_identity,
    api_version
  )
  VALUES (
    p_tenant_id,
    p_provider,
    p_protected,
    p_auth_mode,
    v_endpoint,
    v_project,
    v_location,
    v_identity,
    v_api
  )
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'provider connection already exists';
END;
$$;

REVOKE ALL ON FUNCTION register_registry_connection(uuid, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_registry_connection(uuid, text, text, text, text, text, text, text, text) TO llm_migrator;

CREATE OR REPLACE FUNCTION set_deployment_streaming(
  p_tenant_id uuid,
  p_name text,
  p_enabled boolean,
  p_connect_timeout_ms integer,
  p_idle_timeout_ms integer,
  p_total_timeout_ms integer,
  p_backpressure_timeout_ms integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider text;
  v_version integer;
BEGIN
  IF p_enabled IS NULL OR p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'streaming arguments are invalid';
  END IF;
  IF p_connect_timeout_ms IS NOT NULL AND p_connect_timeout_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'connect timeout is invalid';
  END IF;
  IF p_idle_timeout_ms IS NOT NULL AND p_idle_timeout_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'idle timeout is invalid';
  END IF;
  IF p_total_timeout_ms IS NOT NULL AND p_total_timeout_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'total timeout is invalid';
  END IF;
  IF p_backpressure_timeout_ms IS NOT NULL AND p_backpressure_timeout_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'backpressure timeout is invalid';
  END IF;
  SELECT c.provider INTO v_provider
  FROM model_deployments d
  JOIN provider_connections c
    ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
  WHERE d.tenant_id = p_tenant_id
    AND d.name = p_name;
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  IF v_provider <> 'openai' AND v_provider <> 'anthropic' AND v_provider <> 'vertex' THEN
    RAISE EXCEPTION 'streaming is not supported';
  END IF;
  UPDATE model_deployments
  SET streaming_enabled = p_enabled,
      stream_connect_timeout_ms = p_connect_timeout_ms,
      stream_idle_timeout_ms = p_idle_timeout_ms,
      stream_total_timeout_ms = p_total_timeout_ms,
      stream_backpressure_timeout_ms = p_backpressure_timeout_ms,
      config_version = config_version + 1
  WHERE tenant_id = p_tenant_id
    AND name = p_name
  RETURNING config_version INTO v_version;
  RETURN v_version;
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
        'serviceAccountIdentity', service_account_identity,
        'apiVersion', api_version,
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

CREATE FUNCTION load_vertex_operator_connection(p_tenant_id uuid)
RETURNS TABLE (
  connection_id uuid,
  project_id text,
  location text,
  auth_mode text,
  service_account_identity text,
  api_version text,
  config_version integer,
  credential_version integer,
  protected_credential text,
  enabled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.project_id,
    c.location,
    c.auth_mode,
    c.service_account_identity,
    c.api_version,
    c.config_version,
    c.credential_version,
    c.protected_credential,
    c.enabled
  FROM provider_connections c
  WHERE c.tenant_id = p_tenant_id
    AND c.provider = 'vertex';
END;
$$;

REVOKE ALL ON FUNCTION load_vertex_operator_connection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_vertex_operator_connection(uuid) TO llm_migrator;

RESET ROLE;
