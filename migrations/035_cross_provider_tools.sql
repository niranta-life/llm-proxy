-- Record the capability set and adapter version for a tool attempt.
-- Allow function-tool capabilities on the verified providers.
-- Vertex does not accept parallel_tool_calls.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 034.
-- Rollback keeps this file applied. Removing a column needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE model_attempts
  ADD COLUMN enforced_capabilities text[],
  ADD COLUMN adapter_version integer;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_enforced_capabilities_check
  CHECK (
    enforced_capabilities IS NULL
    OR (
      cardinality(enforced_capabilities) BETWEEN 0 AND 16
      AND enforced_capabilities <@ ARRAY[
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
        'response_format_text',
        'tools',
        'tool_choice',
        'parallel_tool_calls'
      ]::text[]
      AND cardinality(enforced_capabilities) = (
        (CASE WHEN 'temperature' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'top_p' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'max_tokens' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'max_completion_tokens' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'stop' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'presence_penalty' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'frequency_penalty' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'seed' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'n' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'user' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'response_format_text' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'tools' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'tool_choice' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
        + (CASE WHEN 'parallel_tool_calls' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
      )
    )
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_adapter_version_check
  CHECK (adapter_version IS NULL OR (adapter_version > 0 AND adapter_version <= 1000));

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_tool_audit_pair_check
  CHECK ((enforced_capabilities IS NULL) = (adapter_version IS NULL));

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
        'response_format_text',
        'tools',
        'tool_choice',
        'parallel_tool_calls'
      )
    )
    OR (SELECT count(*) FROM unnest(p_capabilities))
      <> (SELECT count(DISTINCT cap) FROM unnest(p_capabilities) AS cap) THEN
    RAISE EXCEPTION 'capabilities are invalid';
  END IF;
  IF p_provider = 'vertex' AND 'parallel_tool_calls' = ANY (p_capabilities) THEN
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

ALTER FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_provider_deployment(uuid, text, text, text, integer, text[], boolean, integer) TO llm_migrator;

CREATE OR REPLACE FUNCTION register_openrouter_deployment(
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
        'response_format_text',
        'tools',
        'tool_choice',
        'parallel_tool_calls'
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

ALTER FUNCTION register_openrouter_deployment(uuid, text, text, integer, text[], boolean, text[], text, boolean, boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION register_openrouter_deployment(uuid, text, text, integer, text[], boolean, text[], text, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_openrouter_deployment(uuid, text, text, integer, text[], boolean, text[], text, boolean, boolean) TO llm_migrator;

CREATE OR REPLACE FUNCTION set_deployment_capabilities(p_tenant_id uuid, p_name text, p_capabilities text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
  v_provider text;
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
        'response_format_text',
        'tools',
        'tool_choice',
        'parallel_tool_calls'
      )
    )
    OR (SELECT count(*) FROM unnest(p_capabilities))
      <> (SELECT count(DISTINCT cap) FROM unnest(p_capabilities) AS cap) THEN
    RAISE EXCEPTION 'capabilities are invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_capabilities) AS cap
    WHERE cap IN ('tools', 'tool_choice', 'parallel_tool_calls')
  ) THEN
    SELECT connection.provider INTO v_provider
    FROM model_deployments AS deployment
    JOIN provider_connections AS connection
      ON connection.id = deployment.connection_id
     AND connection.tenant_id = deployment.tenant_id
    WHERE deployment.tenant_id = p_tenant_id
      AND deployment.name = p_name;
    IF v_provider IS NULL THEN
      RAISE EXCEPTION 'deployment is missing';
    END IF;
    IF v_provider NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx') THEN
      RAISE EXCEPTION 'capabilities are invalid';
    END IF;
    IF v_provider = 'vertex' AND 'parallel_tool_calls' = ANY (p_capabilities) THEN
      RAISE EXCEPTION 'capabilities are invalid';
    END IF;
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

ALTER FUNCTION set_deployment_capabilities(uuid, text, text[]) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION set_deployment_capabilities(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_deployment_capabilities(uuid, text, text[]) TO llm_migrator;

RESET ROLE;
