-- Additive private endpoint allowlist and mock validation.
-- Existing OpenAI, Anthropic, Vertex, xAI, OpenRouter, and DGX rows stay valid.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 010.
-- Rollback keeps this file applied.
-- Image llm-proxy:9f21f94 stays ready while 010_compatible_providers.sql remains applied.
-- This file returns to the migrator before the version row is recorded.
-- validated_live is stored as a word and this file does not write that word.

SET LOCAL ROLE llm_owner;

ALTER TABLE model_deployments
  ADD COLUMN max_concurrency integer;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_max_concurrency_check
  CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 64);

ALTER TABLE model_deployments
  DROP CONSTRAINT model_deployments_validation_status_check;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_validation_status_check
  CHECK (validation_status IN ('unvalidated', 'valid', 'invalid', 'validated_mock', 'validated_live'));

CREATE TABLE private_endpoint_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  host text NOT NULL,
  port integer NOT NULL,
  addresses text[] NOT NULL,
  tls_verify boolean NOT NULL DEFAULT true,
  health_endpoint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT private_endpoint_allowlist_host_check CHECK (
    host ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
  ),
  CONSTRAINT private_endpoint_allowlist_port_check CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT private_endpoint_allowlist_addresses_check CHECK (
    cardinality(addresses) BETWEEN 1 AND 8
  ),
  CONSTRAINT private_endpoint_allowlist_health_check CHECK (
    health_endpoint IS NULL
    OR (
      char_length(health_endpoint) BETWEEN 8 AND 512
      AND health_endpoint !~ '[[:space:]@]'
    )
  ),
  CONSTRAINT private_endpoint_allowlist_unique UNIQUE (tenant_id, host, port)
);

ALTER TABLE private_endpoint_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_endpoint_allowlist FORCE ROW LEVEL SECURITY;

CREATE POLICY private_endpoint_allowlist_isolation ON private_endpoint_allowlist
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON private_endpoint_allowlist FROM PUBLIC;
GRANT SELECT ON private_endpoint_allowlist TO llm_runtime;

CREATE INDEX private_endpoint_allowlist_tenant_idx
  ON private_endpoint_allowlist (tenant_id, host, port);

CREATE FUNCTION approve_private_endpoint(
  p_tenant_id uuid,
  p_host text,
  p_port integer,
  p_addresses text[],
  p_tls_verify boolean,
  p_health_endpoint text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_host text;
BEGIN
  v_host := lower(btrim(coalesce(p_host, '')));
  IF v_host = '' OR v_host !~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'endpoint is invalid';
  END IF;
  IF v_host ~* '(^|\.)(openai\.com|anthropic\.com|x\.ai|openrouter\.ai|googleapis\.com)$' THEN
    RAISE EXCEPTION 'endpoint is not allowed';
  END IF;
  IF p_port IS NULL OR p_port < 1 OR p_port > 65535 THEN
    RAISE EXCEPTION 'endpoint is invalid';
  END IF;
  IF p_addresses IS NULL OR cardinality(p_addresses) < 1 OR cardinality(p_addresses) > 8 THEN
    RAISE EXCEPTION 'endpoint is invalid';
  END IF;
  IF (
    SELECT count(DISTINCT lower(addr))
    FROM unnest(p_addresses) AS addr
    WHERE addr ~ '^[0-9A-Fa-f:.]{2,45}$'
      AND lower(addr) NOT IN ('0.0.0.0', '169.254.169.254', '::', '::1')
      AND lower(addr) !~ '^169\.254\.'
  ) <> cardinality(p_addresses) THEN
    RAISE EXCEPTION 'endpoint is invalid';
  END IF;
  IF p_tls_verify IS DISTINCT FROM true AND v_host NOT IN ('localhost', '127.0.0.1') THEN
    RAISE EXCEPTION 'tls verification is required';
  END IF;
  IF p_health_endpoint IS NOT NULL AND (
    char_length(p_health_endpoint) < 8
    OR char_length(p_health_endpoint) > 512
    OR p_health_endpoint ~ '[[:space:]@]'
  ) THEN
    RAISE EXCEPTION 'endpoint is invalid';
  END IF;
  INSERT INTO private_endpoint_allowlist (tenant_id, host, port, addresses, tls_verify, health_endpoint)
  VALUES (p_tenant_id, v_host, p_port, p_addresses, coalesce(p_tls_verify, true), p_health_endpoint)
  ON CONFLICT (tenant_id, host, port) DO UPDATE
    SET addresses = EXCLUDED.addresses,
        tls_verify = EXCLUDED.tls_verify,
        health_endpoint = EXCLUDED.health_endpoint
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION approve_private_endpoint(uuid, text, integer, text[], boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_private_endpoint(uuid, text, integer, text[], boolean, text) TO llm_migrator;

CREATE FUNCTION set_deployment_concurrency(p_tenant_id uuid, p_name text, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider text;
  v_version integer;
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
  END IF;
  IF p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
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
  IF v_provider <> 'dgx' THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
  END IF;
  UPDATE model_deployments
  SET max_concurrency = p_limit,
      config_version = config_version + 1,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND name = p_name
  RETURNING config_version INTO v_version;
  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION set_deployment_concurrency(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_deployment_concurrency(uuid, text, integer) TO llm_migrator;

CREATE OR REPLACE FUNCTION set_deployment_validation(p_tenant_id uuid, p_name text, p_status text)
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
  IF p_status = 'validated_live' THEN
    RAISE EXCEPTION 'validation status is not available';
  END IF;
  IF p_name IS NULL OR p_name = '' OR p_status IS NULL
    OR p_status NOT IN ('unvalidated', 'valid', 'invalid', 'validated_mock') THEN
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
    AND v_provider <> 'openrouter'
    AND v_provider <> 'dgx' THEN
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

RESET ROLE;
