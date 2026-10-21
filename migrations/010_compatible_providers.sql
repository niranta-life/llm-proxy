-- Additive xAI and OpenRouter chat routing.
-- Existing OpenAI, Anthropic, Vertex, and DGX rows stay valid.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 009.
-- Rollback keeps this file applied.
-- Image llm-proxy:a0d8156 stays ready while 009_vertex_provider.sql remains applied.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE FUNCTION openrouter_providers_valid(p_providers text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_providers IS NULL
    OR (
      cardinality(p_providers) BETWEEN 1 AND 8
      AND (
        SELECT count(*)
        FROM unnest(p_providers) AS item
        WHERE item ~ '^[a-z0-9][a-z0-9-]{0,63}$'
      ) = cardinality(p_providers)
      AND (
        SELECT count(DISTINCT item)
        FROM unnest(p_providers) AS item
      ) = cardinality(p_providers)
    );
$$;

REVOKE ALL ON FUNCTION openrouter_providers_valid(text[]) FROM PUBLIC;

ALTER TABLE model_deployments
  ADD COLUMN downstream_providers text[],
  ADD COLUMN data_collection text,
  ADD COLUMN allow_fallbacks boolean,
  ADD COLUMN require_serving_provider boolean NOT NULL DEFAULT false;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_downstream_providers_check
  CHECK (openrouter_providers_valid(downstream_providers));

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_data_collection_check
  CHECK (data_collection IS NULL OR data_collection IN ('allow', 'deny'));

ALTER TABLE model_attempts
  ADD COLUMN serving_model text,
  ADD COLUMN serving_provider text;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_serving_model_check
  CHECK (serving_model IS NULL OR char_length(serving_model) BETWEEN 1 AND 256);

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_serving_provider_check
  CHECK (
    serving_provider IS NULL
    OR serving_provider ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  );

GRANT UPDATE (serving_model, serving_provider) ON model_attempts TO llm_runtime;

CREATE FUNCTION register_openrouter_deployment(
  p_tenant_id uuid,
  p_name text,
  p_upstream_model text,
  p_timeout_ms integer,
  p_capabilities text[],
  p_enabled boolean,
  p_downstream_providers text[],
  p_data_collection text,
  p_allow_fallbacks boolean,
  p_require_serving_provider boolean
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
  IF NOT openrouter_providers_valid(p_downstream_providers) THEN
    RAISE EXCEPTION 'downstream providers are invalid';
  END IF;
  IF p_data_collection IS NOT NULL AND p_data_collection NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'data collection is invalid';
  END IF;
  IF p_require_serving_provider IS NULL THEN
    RAISE EXCEPTION 'serving provider requirement is invalid';
  END IF;
  SELECT id INTO v_connection
  FROM provider_connections
  WHERE tenant_id = p_tenant_id
    AND provider = 'openrouter';
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
    downstream_providers,
    data_collection,
    allow_fallbacks,
    require_serving_provider
  )
  VALUES (
    p_tenant_id,
    v_connection,
    p_name,
    p_upstream_model,
    p_timeout_ms,
    p_capabilities,
    coalesce(p_enabled, false),
    p_downstream_providers,
    p_data_collection,
    p_allow_fallbacks,
    p_require_serving_provider
  )
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 1;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'deployment already exists';
END;
$$;

REVOKE ALL ON FUNCTION register_openrouter_deployment(uuid, text, text, integer, text[], boolean, text[], text, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_openrouter_deployment(uuid, text, text, integer, text[], boolean, text[], text, boolean, boolean) TO llm_migrator;

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
  IF v_provider <> 'openai'
    AND v_provider <> 'anthropic'
    AND v_provider <> 'vertex'
    AND v_provider <> 'xai'
    AND v_provider <> 'openrouter' THEN
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
        'downstreamProviders', downstream_providers,
        'dataCollection', data_collection,
        'allowFallbacks', allow_fallbacks,
        'requireServingProvider', require_serving_provider,
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

RESET ROLE;
