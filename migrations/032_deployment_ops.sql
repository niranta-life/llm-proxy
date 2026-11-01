-- Additive deployment operators: upstream model, capabilities, live confirm, and registry key replace.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 031.
-- set_deployment_validation from migration 011 stays the only rejector of validated_live on that path.
-- confirm_deployment_live is the only writer of validated_live.

SET LOCAL ROLE llm_owner;

CREATE FUNCTION set_deployment_upstream_model(p_tenant_id uuid, p_name text, p_upstream_model text)
RETURNS TABLE (config_version integer, upstream_model text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config integer;
  v_model text;
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'deployment name is invalid';
  END IF;
  IF p_upstream_model IS NULL
    OR char_length(p_upstream_model) < 1
    OR char_length(p_upstream_model) > 128
    OR p_upstream_model ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'upstream model is invalid';
  END IF;
  UPDATE model_deployments AS d
  SET upstream_model = p_upstream_model,
      config_version = d.config_version + 1,
      updated_at = now()
  WHERE d.tenant_id = p_tenant_id
    AND d.name = p_name
  RETURNING d.config_version, d.upstream_model
  INTO v_config, v_model;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  config_version := v_config;
  upstream_model := v_model;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION set_deployment_capabilities(p_tenant_id uuid, p_name text, p_capabilities text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_name = 'auto' THEN
    RAISE EXCEPTION 'deployment name is invalid';
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
  UPDATE model_deployments
  SET capabilities = p_capabilities,
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

CREATE FUNCTION confirm_deployment_live(p_tenant_id uuid, p_name text)
RETURNS TABLE (config_version integer, validation_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config integer;
  v_status text;
  v_enabled boolean;
  v_connection boolean;
  v_ok boolean;
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'deployment name is invalid';
  END IF;
  SELECT d.enabled, c.enabled
  INTO v_enabled, v_connection
  FROM model_deployments AS d
  JOIN provider_connections AS c
    ON c.tenant_id = d.tenant_id
   AND c.id = d.connection_id
  WHERE d.tenant_id = p_tenant_id
    AND d.name = p_name
  FOR UPDATE OF d, c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  IF v_enabled IS NOT TRUE OR v_connection IS NOT TRUE THEN
    RAISE EXCEPTION 'live confirmation is not available';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM model_deployments AS d
    JOIN model_attempts AS a
      ON a.tenant_id = d.tenant_id
     AND a.deployment_id = d.id
    WHERE d.tenant_id = p_tenant_id
      AND d.name = p_name
      AND a.status = 'succeeded'
      AND a.duration_ms IS NOT NULL
      AND a.created_at >= now() - interval '24 hours'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'live confirmation is not available';
  END IF;
  UPDATE model_deployments AS d
  SET validation_status = 'validated_live',
      config_version = d.config_version + 1,
      updated_at = now()
  WHERE d.tenant_id = p_tenant_id
    AND d.name = p_name
  RETURNING d.config_version, d.validation_status
  INTO v_config, v_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  config_version := v_config;
  validation_status := v_status;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION replace_registry_credential(p_tenant_id uuid, p_provider text, p_protected text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('xai', 'openrouter', 'vertex', 'dgx') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  IF p_protected IS NULL OR p_protected NOT LIKE 'aes-256-gcm$%' OR p_protected ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'protected credential is invalid';
  END IF;
  UPDATE provider_connections
  SET protected_credential = p_protected,
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
        'dataClassification', data_classification,
        'allowFallbacks', allow_fallbacks,
        'requireServingProvider', require_serving_provider,
        'maxConcurrency', max_concurrency,
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
    ), '[]'::jsonb),
    'privateEndpoints',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'host', host,
        'port', port,
        'addresses', to_jsonb(addresses),
        'tlsVerify', tls_verify,
        'healthEndpoint', health_endpoint
      ) ORDER BY host, port)
      FROM private_endpoint_allowlist
      WHERE tenant_id = p_tenant_id
    ), '[]'::jsonb)
  );
END;
$$;

ALTER FUNCTION set_deployment_upstream_model(uuid, text, text) OWNER TO llm_owner;
ALTER FUNCTION set_deployment_capabilities(uuid, text, text[]) OWNER TO llm_owner;
ALTER FUNCTION confirm_deployment_live(uuid, text) OWNER TO llm_owner;
ALTER FUNCTION replace_registry_credential(uuid, text, text) OWNER TO llm_owner;
ALTER FUNCTION list_tenant_inference(uuid) OWNER TO llm_owner;

REVOKE ALL ON FUNCTION set_deployment_upstream_model(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_capabilities(uuid, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_deployment_live(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION replace_registry_credential(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION set_deployment_upstream_model(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_capabilities(uuid, text, text[]) TO llm_migrator;
GRANT EXECUTE ON FUNCTION confirm_deployment_live(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION replace_registry_credential(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION list_tenant_inference(uuid) TO llm_migrator;

RESET ROLE;
