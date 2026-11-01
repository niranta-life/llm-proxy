-- Add the embeddings capability and a versioned embedding-space contract.
-- OpenAI, Vertex, and DGX can list the capability.
-- OpenRouter, Anthropic, and xAI cannot list it.
-- A contract pins the model, the dimension, and the normalization policy.
-- A contract version cannot change.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 035.
-- Rollback keeps this file applied. Removing the capability needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE model_deployments DROP CONSTRAINT model_deployments_capabilities_check;

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
      'parallel_tool_calls',
      'embeddings'
    ]::text[]
  );

ALTER TABLE model_attempts DROP CONSTRAINT model_attempts_enforced_capabilities_check;

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
        'parallel_tool_calls',
        'embeddings'
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
        + (CASE WHEN 'embeddings' = ANY (enforced_capabilities) THEN 1 ELSE 0 END)
      )
    )
  );

CREATE TABLE embedding_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  version integer NOT NULL,
  model text NOT NULL,
  dimension integer NOT NULL,
  normalization text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embedding_contracts_version_check CHECK (version >= 1),
  CONSTRAINT embedding_contracts_dimension_check CHECK (dimension BETWEEN 1 AND 4096),
  CONSTRAINT embedding_contracts_normalization_check CHECK (normalization IN ('none', 'l2')),
  CONSTRAINT embedding_contracts_model_check CHECK (
    char_length(model) BETWEEN 1 AND 128
    AND model !~ '[[:space:]]'
  ),
  CONSTRAINT embedding_contracts_deployment_version_key UNIQUE (tenant_id, deployment_id, version),
  CONSTRAINT embedding_contracts_deployment_fk
    FOREIGN KEY (tenant_id, deployment_id)
    REFERENCES model_deployments (tenant_id, id)
);

CREATE INDEX embedding_contracts_tenant_deployment_idx
  ON embedding_contracts (tenant_id, deployment_id, version DESC);

ALTER TABLE embedding_contracts OWNER TO llm_owner;
ALTER TABLE embedding_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_contracts FORCE ROW LEVEL SECURITY;

CREATE POLICY embedding_contracts_isolation ON embedding_contracts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON embedding_contracts FROM PUBLIC;
GRANT SELECT ON embedding_contracts TO llm_runtime;

CREATE FUNCTION reject_embedding_contract_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'embedding contract is immutable';
END;
$$;

ALTER FUNCTION reject_embedding_contract_change() OWNER TO llm_owner;

CREATE TRIGGER embedding_contracts_immutable
  BEFORE UPDATE OR DELETE ON embedding_contracts
  FOR EACH ROW
  EXECUTE FUNCTION reject_embedding_contract_change();

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
        'parallel_tool_calls',
        'embeddings'
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
        'parallel_tool_calls',
        'embeddings'
      )
    )
    OR (SELECT count(*) FROM unnest(p_capabilities))
      <> (SELECT count(DISTINCT cap) FROM unnest(p_capabilities) AS cap) THEN
    RAISE EXCEPTION 'capabilities are invalid';
  END IF;
  IF p_provider = 'vertex' AND 'parallel_tool_calls' = ANY (p_capabilities) THEN
    RAISE EXCEPTION 'capabilities are invalid';
  END IF;
  IF 'embeddings' = ANY (p_capabilities) AND p_provider NOT IN ('openai', 'vertex', 'dgx') THEN
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
        'parallel_tool_calls',
        'embeddings'
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
  IF 'embeddings' = ANY (p_capabilities) THEN
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
    IF v_provider NOT IN ('openai', 'vertex', 'dgx') THEN
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

CREATE FUNCTION register_embedding_contract(
  p_tenant_id uuid,
  p_deployment text,
  p_dimension integer,
  p_normalization text
)
RETURNS TABLE (contract_id uuid, version integer, model text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_model text;
  v_provider text;
  v_status text;
  v_capabilities text[];
  v_version integer;
  v_contract uuid;
BEGIN
  IF p_deployment IS NULL OR p_deployment !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_deployment = 'auto' THEN
    RAISE EXCEPTION 'deployment name is invalid';
  END IF;
  IF p_dimension IS NULL OR p_dimension < 1 OR p_dimension > 4096 THEN
    RAISE EXCEPTION 'dimension is invalid';
  END IF;
  IF p_normalization IS NULL OR p_normalization NOT IN ('none', 'l2') THEN
    RAISE EXCEPTION 'normalization is invalid';
  END IF;
  SELECT deployment.id, deployment.upstream_model, deployment.capabilities, deployment.validation_status, connection.provider
    INTO v_id, v_model, v_capabilities, v_status, v_provider
  FROM model_deployments AS deployment
  JOIN provider_connections AS connection
    ON connection.id = deployment.connection_id
   AND connection.tenant_id = deployment.tenant_id
  WHERE deployment.tenant_id = p_tenant_id
    AND deployment.name = p_deployment;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  IF v_capabilities IS NULL OR NOT ('embeddings' = ANY (v_capabilities)) THEN
    RAISE EXCEPTION 'embeddings is not supported';
  END IF;
  IF v_provider NOT IN ('openai', 'vertex', 'dgx') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  IF v_provider = 'dgx' AND v_status IS DISTINCT FROM 'validated_mock' THEN
    RAISE EXCEPTION 'deployment is not a mock';
  END IF;
  SELECT coalesce(max(embedding_contracts.version), 0) + 1
    INTO v_version
  FROM embedding_contracts
  WHERE embedding_contracts.tenant_id = p_tenant_id
    AND embedding_contracts.deployment_id = v_id;
  INSERT INTO embedding_contracts (tenant_id, deployment_id, version, model, dimension, normalization)
  VALUES (p_tenant_id, v_id, v_version, v_model, p_dimension, p_normalization)
  RETURNING id INTO v_contract;
  RETURN QUERY SELECT v_contract, v_version, v_model;
END;
$$;

ALTER FUNCTION register_embedding_contract(uuid, text, integer, text) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION register_embedding_contract(uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_embedding_contract(uuid, text, integer, text) TO llm_migrator;

RESET ROLE;
