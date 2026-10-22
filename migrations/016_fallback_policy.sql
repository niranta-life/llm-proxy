-- Additive fallback policies for one routing alias.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 015.
-- Rollback keeps this file applied.
-- Image 1bbe7a1 stays ready while 015_tenant_limits.sql remains applied.
-- A missing policy does not choose another deployment.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE fallback_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  policy_version integer NOT NULL,
  enabled boolean NOT NULL,
  max_attempts integer NOT NULL,
  allowed_failures text[] NOT NULL,
  required_capabilities text[] NOT NULL,
  allowed_providers text[] NOT NULL,
  allowed_regions text[] NOT NULL,
  data_collection text NOT NULL,
  min_remaining_deadline_ms integer NOT NULL,
  deployment_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, policy_version),
  CONSTRAINT fallback_policies_version_check CHECK (policy_version >= 1),
  CONSTRAINT fallback_policies_attempts_check CHECK (max_attempts BETWEEN 1 AND 8),
  CONSTRAINT fallback_policies_deadline_check CHECK (min_remaining_deadline_ms BETWEEN 0 AND 600000),
  CONSTRAINT fallback_policies_data_collection_check CHECK (data_collection IN ('allow', 'deny')),
  CONSTRAINT fallback_policies_list_check CHECK (
    cardinality(deployment_ids) BETWEEN 0 AND 8
    AND (enabled = false OR cardinality(deployment_ids) >= 1)
    AND cardinality(allowed_failures) <= 12
    AND cardinality(required_capabilities) <= 12
    AND cardinality(allowed_providers) <= 6
    AND cardinality(allowed_regions) <= 8
  ),
  CONSTRAINT fallback_policies_failures_check CHECK (
    allowed_failures <@ ARRAY[
      'cancelled',
      'stream_started',
      'total_deadline',
      'timeout_before_dispatch',
      'timeout_after_dispatch',
      'ambiguous_network',
      'client_error',
      'unauthorized',
      'connection_failure',
      'rate_limit',
      'unavailable',
      'upstream_error'
    ]::text[]
  ),
  CONSTRAINT fallback_policies_capabilities_check CHECK (
    required_capabilities <@ ARRAY[
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
    ]::text[]
  ),
  CONSTRAINT fallback_policies_providers_check CHECK (
    allowed_providers <@ ARRAY['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx']::text[]
  )
);

CREATE INDEX fallback_policies_tenant_idx ON fallback_policies (tenant_id, policy_version);

ALTER TABLE fallback_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE fallback_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY fallback_policies_isolation ON fallback_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON fallback_policies FROM PUBLIC;
GRANT SELECT ON fallback_policies TO llm_runtime;

CREATE FUNCTION reject_fallback_policy_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fallback policy is immutable';
END;
$$;

CREATE TRIGGER fallback_policies_immutable
  BEFORE UPDATE OR DELETE ON fallback_policies
  FOR EACH ROW
  EXECUTE FUNCTION reject_fallback_policy_change();

ALTER TABLE model_aliases
  ADD COLUMN fallback_policy_id uuid;

ALTER TABLE model_aliases
  ADD CONSTRAINT model_aliases_fallback_policy_fk
  FOREIGN KEY (tenant_id, fallback_policy_id) REFERENCES fallback_policies (tenant_id, id);

ALTER TABLE model_deployments
  ADD COLUMN context_limit integer;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_context_limit_check
  CHECK (context_limit IS NULL OR context_limit BETWEEN 1 AND 10000000);

ALTER TABLE model_attempts
  ADD COLUMN trigger_reason text,
  ADD COLUMN fallback_policy_id uuid,
  ADD COLUMN fallback_policy_version integer;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_trigger_reason_check CHECK (
    trigger_reason IS NULL OR trigger_reason IN (
      'primary',
      'retry',
      'cancelled',
      'stream_started',
      'total_deadline',
      'timeout_before_dispatch',
      'timeout_after_dispatch',
      'ambiguous_network',
      'client_error',
      'unauthorized',
      'connection_failure',
      'rate_limit',
      'unavailable',
      'upstream_error'
    )
  );

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_fallback_version_check
  CHECK (fallback_policy_version IS NULL OR fallback_policy_version >= 1);

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_fallback_policy_fk
  FOREIGN KEY (tenant_id, fallback_policy_id) REFERENCES fallback_policies (tenant_id, id);

CREATE FUNCTION set_fallback_policy(
  p_tenant_id uuid,
  p_alias text,
  p_enabled boolean,
  p_deployments text[],
  p_failures text[],
  p_max_attempts integer,
  p_capabilities text[],
  p_providers text[],
  p_regions text[],
  p_data_collection text,
  p_min_remaining_deadline_ms integer
)
RETURNS TABLE (policy_id uuid, policy_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
  v_id uuid;
  v_name text;
  v_deployment uuid;
  v_ids uuid[] := '{}';
BEGIN
  IF p_alias IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'alias is invalid';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled flag is invalid';
  END IF;
  IF p_deployments IS NULL OR p_failures IS NULL OR p_capabilities IS NULL
    OR p_providers IS NULL OR p_regions IS NULL THEN
    RAISE EXCEPTION 'policy list is invalid';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'attempt limit is invalid';
  END IF;
  IF p_min_remaining_deadline_ms IS NULL OR p_min_remaining_deadline_ms NOT BETWEEN 0 AND 600000 THEN
    RAISE EXCEPTION 'deadline is invalid';
  END IF;
  IF p_data_collection IS NULL OR p_data_collection NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'data handling is invalid';
  END IF;
  IF p_enabled AND cardinality(p_deployments) < 1 THEN
    RAISE EXCEPTION 'deployment list is empty';
  END IF;
  IF cardinality(p_deployments) > 8 OR cardinality(p_failures) > 12
    OR cardinality(p_capabilities) > 12 OR cardinality(p_providers) > 6
    OR cardinality(p_regions) > 8 THEN
    RAISE EXCEPTION 'policy list is invalid';
  END IF;
  IF p_enabled AND cardinality(p_providers) < 1 THEN
    RAISE EXCEPTION 'provider list is empty';
  END IF;
  IF (
    SELECT count(*) FROM unnest(p_deployments)
  ) <> (
    SELECT count(DISTINCT item) FROM unnest(p_deployments) AS item
  ) OR (
    SELECT count(*) FROM unnest(p_failures)
  ) <> (
    SELECT count(DISTINCT item) FROM unnest(p_failures) AS item
  ) OR (
    SELECT count(*) FROM unnest(p_capabilities)
  ) <> (
    SELECT count(DISTINCT item) FROM unnest(p_capabilities) AS item
  ) OR (
    SELECT count(*) FROM unnest(p_providers)
  ) <> (
    SELECT count(DISTINCT item) FROM unnest(p_providers) AS item
  ) OR (
    SELECT count(*) FROM unnest(p_regions)
  ) <> (
    SELECT count(DISTINCT item) FROM unnest(p_regions) AS item
  ) THEN
    RAISE EXCEPTION 'policy list is duplicated';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_failures) AS item
    WHERE item NOT IN (
      'cancelled',
      'stream_started',
      'total_deadline',
      'timeout_before_dispatch',
      'timeout_after_dispatch',
      'ambiguous_network',
      'client_error',
      'unauthorized',
      'connection_failure',
      'rate_limit',
      'unavailable',
      'upstream_error'
    )
  ) THEN
    RAISE EXCEPTION 'failure category is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_capabilities) AS item
    WHERE item NOT IN (
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
  ) THEN
    RAISE EXCEPTION 'capability is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_providers) AS item
    WHERE item NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx')
  ) THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_regions) AS item
    WHERE item <> 'global' AND item !~ '^[a-z]+(-[a-z0-9]+){1,3}$'
  ) THEN
    RAISE EXCEPTION 'region is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_deployments) AS item
    WHERE item IS NULL OR item !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR item = 'auto'
  ) THEN
    RAISE EXCEPTION 'deployment name is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  FOREACH v_name IN ARRAY p_deployments
  LOOP
    SELECT id INTO v_deployment
    FROM model_deployments
    WHERE tenant_id = p_tenant_id
      AND name = v_name;
    IF v_deployment IS NULL THEN
      RAISE EXCEPTION 'deployment is missing';
    END IF;
    v_ids := v_ids || v_deployment;
  END LOOP;
  SELECT COALESCE(MAX(fallback_policies.policy_version), 0) + 1 INTO v_version
  FROM fallback_policies
  WHERE tenant_id = p_tenant_id;
  INSERT INTO fallback_policies (
    tenant_id,
    policy_version,
    enabled,
    max_attempts,
    allowed_failures,
    required_capabilities,
    allowed_providers,
    allowed_regions,
    data_collection,
    min_remaining_deadline_ms,
    deployment_ids
  ) VALUES (
    p_tenant_id,
    v_version,
    p_enabled,
    p_max_attempts,
    p_failures,
    p_capabilities,
    p_providers,
    p_regions,
    p_data_collection,
    p_min_remaining_deadline_ms,
    v_ids
  )
  RETURNING id INTO v_id;
  UPDATE model_aliases
  SET fallback_policy_id = v_id
  WHERE tenant_id = p_tenant_id
    AND alias = p_alias;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alias is missing';
  END IF;
  policy_id := v_id;
  policy_version := v_version;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION show_fallback_policy(p_tenant_id uuid, p_alias text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy fallback_policies%ROWTYPE;
  v_names text[];
BEGIN
  IF p_alias IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'alias is invalid';
  END IF;
  SELECT f.* INTO v_policy
  FROM model_aliases a
  JOIN fallback_policies f
    ON f.tenant_id = a.tenant_id
   AND f.id = a.fallback_policy_id
  WHERE a.tenant_id = p_tenant_id
    AND a.alias = p_alias;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(array_agg(d.name ORDER BY listed.position), '{}')
  INTO v_names
  FROM unnest(v_policy.deployment_ids) WITH ORDINALITY AS listed(deployment_id, position)
  LEFT JOIN model_deployments d
    ON d.tenant_id = v_policy.tenant_id
   AND d.id = listed.deployment_id;
  RETURN jsonb_build_object(
    'policyId', v_policy.id,
    'policyVersion', v_policy.policy_version,
    'enabled', v_policy.enabled,
    'maxAttempts', v_policy.max_attempts,
    'allowedFailures', to_jsonb(v_policy.allowed_failures),
    'requiredCapabilities', to_jsonb(v_policy.required_capabilities),
    'allowedProviders', to_jsonb(v_policy.allowed_providers),
    'allowedRegions', to_jsonb(v_policy.allowed_regions),
    'dataCollection', v_policy.data_collection,
    'minRemainingDeadlineMs', v_policy.min_remaining_deadline_ms,
    'deployments', to_jsonb(v_names)
  );
END;
$$;

CREATE FUNCTION set_deployment_context_limit(p_tenant_id uuid, p_name text, p_limit integer)
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
  IF p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000000 THEN
    RAISE EXCEPTION 'context limit is invalid';
  END IF;
  UPDATE model_deployments
  SET context_limit = p_limit,
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

CREATE FUNCTION set_deployment_data_collection(p_tenant_id uuid, p_name text, p_value text)
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
  IF p_value IS NULL OR p_value NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'data handling is invalid';
  END IF;
  UPDATE model_deployments
  SET data_collection = p_value,
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

REVOKE ALL ON FUNCTION reject_fallback_policy_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_fallback_policy(uuid, text, boolean, text[], text[], integer, text[], text[], text[], text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION show_fallback_policy(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_context_limit(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_data_collection(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_fallback_policy(uuid, text, boolean, text[], text[], integer, text[], text[], text[], text, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION show_fallback_policy(uuid, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_context_limit(uuid, text, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_data_collection(uuid, text, text) TO llm_migrator;

RESET ROLE;
