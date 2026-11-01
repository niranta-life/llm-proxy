-- Allow OpenAI deployments to record function-tool capabilities.
-- This file replaces the deployment capability check and two functions.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 033.
-- Rollback keeps this file applied. Removing a capability name needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

DO $$
DECLARE
  v_name text;
BEGIN
  SELECT con.conname INTO v_name
  FROM pg_constraint AS con
  JOIN pg_class AS rel ON rel.oid = con.conrelid
  JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'model_deployments'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%capabilities <@%';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'capabilities check is missing';
  END IF;
  EXECUTE format('ALTER TABLE model_deployments DROP CONSTRAINT %I', v_name);
END $$;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_capabilities_check
  CHECK (
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
      'response_format_text',
      'tools',
      'tool_choice',
      'parallel_tool_calls'
    ]::text[]
  );

CREATE OR REPLACE FUNCTION register_model_deployment(
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

ALTER FUNCTION register_model_deployment(uuid, text, text, integer, text[], boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION register_model_deployment(uuid, text, text, integer, text[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_model_deployment(uuid, text, text, integer, text[], boolean) TO llm_migrator;

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
    IF v_provider <> 'openai' THEN
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
