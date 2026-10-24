-- Additive encrypted sample capture.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 017.
-- The sample table stores ciphertext only.
-- Rollback keeps this file applied.
-- Readiness for 017_request_features.sql still finds that version row.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE sample_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  policy_version integer NOT NULL,
  mode text NOT NULL,
  content_capture boolean NOT NULL DEFAULT false,
  replay_permitted boolean NOT NULL DEFAULT false,
  judge_disclosure_permitted boolean NOT NULL DEFAULT false,
  sample_rate numeric(7, 6) NOT NULL,
  max_sample_bytes integer NOT NULL,
  max_sample_count integer NOT NULL,
  retention_seconds integer NOT NULL,
  approved_classifications text[] NOT NULL,
  allowed_providers text[] NOT NULL,
  allowed_deployments text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, policy_version),
  CONSTRAINT sample_policies_version_check CHECK (policy_version >= 1),
  CONSTRAINT sample_policies_mode_check CHECK (mode IN ('disabled', 'metadata_only', 'encrypted_sample')),
  CONSTRAINT sample_policies_rate_check CHECK (sample_rate >= 0 AND sample_rate <= 1),
  CONSTRAINT sample_policies_bytes_check CHECK (max_sample_bytes BETWEEN 0 AND 1000000),
  CONSTRAINT sample_policies_count_check CHECK (max_sample_count BETWEEN 0 AND 1000000),
  CONSTRAINT sample_policies_retention_check CHECK (retention_seconds BETWEEN 0 AND 315360000),
  CONSTRAINT sample_policies_list_check CHECK (
    cardinality(approved_classifications) <= 4
    AND cardinality(allowed_providers) <= 6
    AND cardinality(allowed_deployments) <= 8
  ),
  CONSTRAINT sample_policies_classes_check CHECK (
    approved_classifications <@ ARRAY['public', 'internal', 'confidential', 'restricted']::text[]
  ),
  CONSTRAINT sample_policies_providers_check CHECK (
    allowed_providers <@ ARRAY['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx']::text[]
  )
);

CREATE INDEX sample_policies_tenant_idx ON sample_policies (tenant_id, policy_version DESC);

ALTER TABLE sample_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY sample_policies_isolation ON sample_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON sample_policies FROM PUBLIC;
GRANT SELECT ON sample_policies TO llm_runtime;

CREATE FUNCTION reject_sample_policy_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sample policy is immutable';
END;
$$;

CREATE TRIGGER sample_policies_immutable
  BEFORE UPDATE OR DELETE ON sample_policies
  FOR EACH ROW
  EXECUTE FUNCTION reject_sample_policy_change();

ALTER TABLE model_deployments
  ADD COLUMN data_classification text;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_data_classification_check
  CHECK (
    data_classification IS NULL
    OR data_classification IN ('public', 'internal', 'confidential', 'restricted')
  );

CREATE TABLE request_samples (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  policy_version integer NOT NULL,
  provider text NOT NULL,
  deployment_name text NOT NULL,
  data_classification text NOT NULL,
  schema_version integer NOT NULL,
  size_bytes integer NOT NULL,
  wrapping_key_version integer NOT NULL,
  wrapped_key_iv bytea NOT NULL,
  wrapped_key_tag bytea NOT NULL,
  wrapped_key_ciphertext bytea NOT NULL,
  content_iv bytea NOT NULL,
  content_tag bytea NOT NULL,
  content_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  CONSTRAINT request_samples_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  CONSTRAINT request_samples_policy_fk
    FOREIGN KEY (tenant_id, policy_id) REFERENCES sample_policies (tenant_id, id),
  CONSTRAINT request_samples_provider_check CHECK (
    provider IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx')
  ),
  CONSTRAINT request_samples_deployment_check CHECK (
    deployment_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND deployment_name <> 'auto'
  ),
  CONSTRAINT request_samples_class_check CHECK (
    data_classification IN ('public', 'internal', 'confidential', 'restricted')
  ),
  CONSTRAINT request_samples_schema_check CHECK (schema_version > 0),
  CONSTRAINT request_samples_version_check CHECK (policy_version > 0 AND wrapping_key_version > 0),
  CONSTRAINT request_samples_size_check CHECK (
    size_bytes BETWEEN 1 AND 1000000
    AND size_bytes = octet_length(content_ciphertext)
  ),
  CONSTRAINT request_samples_envelope_check CHECK (
    octet_length(wrapped_key_iv) = 12
    AND octet_length(wrapped_key_tag) = 16
    AND octet_length(wrapped_key_ciphertext) = 32
    AND octet_length(content_iv) = 12
    AND octet_length(content_tag) = 16
  ),
  CONSTRAINT request_samples_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX request_samples_tenant_created_idx
  ON request_samples (tenant_id, created_at DESC, id DESC);

ALTER TABLE request_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_samples FORCE ROW LEVEL SECURITY;

CREATE POLICY request_samples_isolation ON request_samples
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON request_samples FROM PUBLIC;
GRANT SELECT (
  id,
  tenant_id,
  request_id,
  policy_version,
  provider,
  deployment_name,
  size_bytes,
  created_at,
  expires_at
) ON request_samples TO llm_runtime;
GRANT INSERT ON request_samples TO llm_runtime;

CREATE FUNCTION reject_request_sample_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sample row is immutable';
END;
$$;

CREATE TRIGGER request_samples_immutable
  BEFORE UPDATE OR DELETE ON request_samples
  FOR EACH ROW
  EXECUTE FUNCTION reject_request_sample_change();

CREATE FUNCTION set_sample_policy(
  p_tenant_id uuid,
  p_mode text,
  p_content_capture boolean,
  p_replay boolean,
  p_judge boolean,
  p_sample_rate numeric,
  p_max_bytes integer,
  p_max_count integer,
  p_retention integer,
  p_classes text[],
  p_providers text[],
  p_deployments text[]
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
  v_class text;
  v_provider text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant is missing';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('disabled', 'metadata_only', 'encrypted_sample') THEN
    RAISE EXCEPTION 'sample mode is invalid';
  END IF;
  IF p_content_capture IS NULL OR p_replay IS NULL OR p_judge IS NULL THEN
    RAISE EXCEPTION 'sample permission is invalid';
  END IF;
  IF p_sample_rate IS NULL OR p_sample_rate < 0 OR p_sample_rate > 1 THEN
    RAISE EXCEPTION 'sample rate is invalid';
  END IF;
  IF p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'sample size is invalid';
  END IF;
  IF p_max_count IS NULL OR p_max_count NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'sample count is invalid';
  END IF;
  IF p_retention IS NULL OR p_retention NOT BETWEEN 0 AND 315360000 THEN
    RAISE EXCEPTION 'retention is invalid';
  END IF;
  IF p_classes IS NULL OR p_providers IS NULL OR p_deployments IS NULL THEN
    RAISE EXCEPTION 'sample list is invalid';
  END IF;
  IF cardinality(p_classes) > 4 OR cardinality(p_providers) > 6 OR cardinality(p_deployments) > 8 THEN
    RAISE EXCEPTION 'sample list is invalid';
  END IF;
  IF (SELECT count(*) FROM unnest(p_classes) AS item) <> (SELECT count(DISTINCT item) FROM unnest(p_classes) AS item) THEN
    RAISE EXCEPTION 'classification list is invalid';
  END IF;
  IF (SELECT count(*) FROM unnest(p_providers) AS item) <> (SELECT count(DISTINCT item) FROM unnest(p_providers) AS item) THEN
    RAISE EXCEPTION 'provider list is invalid';
  END IF;
  IF (SELECT count(*) FROM unnest(p_deployments) AS item) <> (SELECT count(DISTINCT item) FROM unnest(p_deployments) AS item) THEN
    RAISE EXCEPTION 'deployment list is invalid';
  END IF;
  FOREACH v_class IN ARRAY p_classes LOOP
    IF v_class NOT IN ('public', 'internal', 'confidential', 'restricted') THEN
      RAISE EXCEPTION 'classification list is invalid';
    END IF;
  END LOOP;
  FOREACH v_provider IN ARRAY p_providers LOOP
    IF v_provider NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx') THEN
      RAISE EXCEPTION 'provider list is invalid';
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY p_deployments LOOP
    IF v_name IS NULL OR v_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR v_name = 'auto' THEN
      RAISE EXCEPTION 'deployment name is invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM model_deployments
      WHERE tenant_id = p_tenant_id AND name = v_name
    ) THEN
      RAISE EXCEPTION 'deployment is missing';
    END IF;
  END LOOP;
  SELECT COALESCE(MAX(sample_policies.policy_version), 0) + 1 INTO v_version
  FROM sample_policies
  WHERE tenant_id = p_tenant_id;
  INSERT INTO sample_policies (
    tenant_id,
    policy_version,
    mode,
    content_capture,
    replay_permitted,
    judge_disclosure_permitted,
    sample_rate,
    max_sample_bytes,
    max_sample_count,
    retention_seconds,
    approved_classifications,
    allowed_providers,
    allowed_deployments
  ) VALUES (
    p_tenant_id,
    v_version,
    p_mode,
    p_content_capture,
    p_replay,
    p_judge,
    p_sample_rate,
    p_max_bytes,
    p_max_count,
    p_retention,
    p_classes,
    p_providers,
    p_deployments
  )
  RETURNING id INTO v_id;
  policy_id := v_id;
  policy_version := v_version;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION show_sample_policy(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy sample_policies%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant is missing';
  END IF;
  SELECT * INTO v_policy
  FROM sample_policies
  WHERE tenant_id = p_tenant_id
  ORDER BY policy_version DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'policyVersion', v_policy.policy_version,
    'mode', v_policy.mode,
    'contentCapture', v_policy.content_capture,
    'replay', v_policy.replay_permitted,
    'judgeDisclosure', v_policy.judge_disclosure_permitted,
    'sampleRate', v_policy.sample_rate,
    'maxSampleBytes', v_policy.max_sample_bytes,
    'maxSampleCount', v_policy.max_sample_count,
    'retentionSeconds', v_policy.retention_seconds,
    'classifications', to_jsonb(v_policy.approved_classifications),
    'providers', to_jsonb(v_policy.allowed_providers),
    'deployments', to_jsonb(v_policy.allowed_deployments)
  );
END;
$$;

CREATE FUNCTION set_deployment_data_class(p_tenant_id uuid, p_name text, p_class text)
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
  IF p_class IS NOT NULL AND p_class NOT IN ('public', 'internal', 'confidential', 'restricted') THEN
    RAISE EXCEPTION 'data class is invalid';
  END IF;
  UPDATE model_deployments
  SET data_classification = p_class,
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

REVOKE ALL ON FUNCTION reject_sample_policy_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_request_sample_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_sample_policy(uuid, text, boolean, boolean, boolean, numeric, integer, integer, integer, text[], text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION show_sample_policy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_data_class(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_sample_policy(uuid, text, boolean, boolean, boolean, numeric, integer, integer, integer, text[], text[], text[]) TO llm_migrator;
GRANT EXECUTE ON FUNCTION show_sample_policy(uuid) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_data_class(uuid, text, text) TO llm_migrator;

RESET ROLE;
