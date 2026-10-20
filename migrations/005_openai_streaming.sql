-- OpenAI streaming flags and attempt metadata.
-- Existing rows stay non-streaming. New columns have safe defaults.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE tenants
  ADD COLUMN streaming_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE model_deployments
  ADD COLUMN streaming_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN stream_connect_timeout_ms integer,
  ADD COLUMN stream_idle_timeout_ms integer,
  ADD COLUMN stream_total_timeout_ms integer,
  ADD COLUMN stream_backpressure_timeout_ms integer;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_stream_connect_timeout_ms_check CHECK (
    stream_connect_timeout_ms IS NULL OR stream_connect_timeout_ms BETWEEN 100 AND 600000
  );

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_stream_idle_timeout_ms_check CHECK (
    stream_idle_timeout_ms IS NULL OR stream_idle_timeout_ms BETWEEN 100 AND 600000
  );

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_stream_total_timeout_ms_check CHECK (
    stream_total_timeout_ms IS NULL OR stream_total_timeout_ms BETWEEN 100 AND 600000
  );

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_stream_backpressure_timeout_ms_check CHECK (
    stream_backpressure_timeout_ms IS NULL OR stream_backpressure_timeout_ms BETWEEN 100 AND 600000
  );

ALTER TABLE model_attempts
  ADD COLUMN stream_status text,
  ADD COLUMN first_text_delta_ms integer,
  ADD COLUMN chunk_count integer,
  ADD COLUMN bytes_written integer;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_stream_status_check CHECK (
    stream_status IS NULL
    OR stream_status IN (
      'connecting',
      'streaming',
      'completed',
      'client_aborted',
      'provider_failed',
      'timed_out',
      'stream_truncated',
      'slow_consumer'
    )
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_first_text_delta_ms_check CHECK (
    first_text_delta_ms IS NULL OR first_text_delta_ms >= 0
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_chunk_count_check CHECK (
    chunk_count IS NULL OR chunk_count >= 0
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_bytes_written_check CHECK (
    bytes_written IS NULL OR bytes_written >= 0
  );

GRANT SELECT (streaming_enabled) ON tenants TO llm_runtime;
GRANT UPDATE (
  stream_status,
  first_text_delta_ms,
  chunk_count,
  bytes_written
) ON model_attempts TO llm_runtime;

CREATE FUNCTION set_tenant_streaming_enabled(p_tenant_id uuid, p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'streaming flag is invalid';
  END IF;
  UPDATE tenants
  SET streaming_enabled = p_enabled
  WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  RETURN p_enabled;
END;
$$;

CREATE FUNCTION set_deployment_streaming(
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
  IF v_provider <> 'openai' THEN
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
        'streamingEnabled', streaming_enabled,
        'streamConnectTimeoutMs', stream_connect_timeout_ms,
        'streamIdleTimeoutMs', stream_idle_timeout_ms,
        'streamTotalTimeoutMs', stream_total_timeout_ms,
        'streamBackpressureTimeoutMs', stream_backpressure_timeout_ms,
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

ALTER FUNCTION set_tenant_streaming_enabled(uuid, boolean) OWNER TO llm_owner;
ALTER FUNCTION set_deployment_streaming(uuid, text, boolean, integer, integer, integer, integer) OWNER TO llm_owner;

REVOKE ALL ON FUNCTION set_tenant_streaming_enabled(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_streaming(uuid, text, boolean, integer, integer, integer, integer) FROM PUBLIC;

SET LOCAL ROLE llm_owner;
GRANT SELECT (streaming_enabled) ON tenants TO llm_runtime;
GRANT UPDATE (
  stream_status,
  first_text_delta_ms,
  chunk_count,
  bytes_written
) ON model_attempts TO llm_runtime;
GRANT EXECUTE ON FUNCTION set_tenant_streaming_enabled(uuid, boolean) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_streaming(uuid, text, boolean, integer, integer, integer, integer) TO llm_migrator;
RESET ROLE;
