-- Allow streaming on an approved Anthropic deployment.
-- Existing rows stay non-streaming. This file does not drop a column.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

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
  IF v_provider <> 'openai' AND v_provider <> 'anthropic' THEN
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

ALTER FUNCTION set_deployment_streaming(uuid, text, boolean, integer, integer, integer, integer) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION set_deployment_streaming(uuid, text, boolean, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_deployment_streaming(uuid, text, boolean, integer, integer, integer, integer) TO llm_migrator;
RESET ROLE;
