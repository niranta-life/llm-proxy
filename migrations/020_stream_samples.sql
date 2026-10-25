-- Additive streaming capture and replay eligibility metadata.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 019.
-- Sample rows still store ciphertext only.
-- Rollback keeps this file applied.
-- Readiness for 019_sample_retention.sql still finds that version row.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE sample_policies
  ADD COLUMN streaming_capture boolean NOT NULL DEFAULT false;

ALTER TABLE request_samples
  ADD COLUMN exchange_complete boolean,
  ADD COLUMN text_only boolean,
  ADD COLUMN required_capabilities text[],
  ADD COLUMN source_location text;

ALTER TABLE request_samples
  ADD COLUMN content_bytes integer GENERATED ALWAYS AS (octet_length(content_ciphertext)) STORED;

ALTER TABLE request_samples
  ADD CONSTRAINT request_samples_required_capabilities_check
  CHECK (
    required_capabilities IS NULL
    OR (
      cardinality(required_capabilities) <= 12
      AND required_capabilities <@ ARRAY[
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
    )
  );

ALTER TABLE request_samples
  ADD CONSTRAINT request_samples_source_location_check
  CHECK (source_location IS NULL OR char_length(source_location) BETWEEN 1 AND 64);

GRANT SELECT (exchange_complete, text_only, required_capabilities, source_location, content_bytes)
  ON request_samples TO llm_runtime;

CREATE OR REPLACE FUNCTION show_sample_policy(p_tenant_id uuid)
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
    'streamingCapture', v_policy.streaming_capture,
    'replay', v_policy.replay_permitted,
    'judgeDisclosure', v_policy.judge_disclosure_permitted,
    'sampleRate', v_policy.sample_rate,
    'maxSampleBytes', v_policy.max_sample_bytes,
    'maxSampleCount', v_policy.max_sample_count,
    'retentionSeconds', v_policy.retention_seconds,
    'recentShare', v_policy.recent_share,
    'classifications', to_jsonb(v_policy.approved_classifications),
    'providers', to_jsonb(v_policy.allowed_providers),
    'deployments', to_jsonb(v_policy.allowed_deployments)
  );
END;
$$;

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
  p_deployments text[],
  p_recent_share numeric,
  p_streaming boolean
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
  IF p_content_capture IS NULL OR p_replay IS NULL OR p_judge IS NULL OR p_streaming IS NULL THEN
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
  IF p_recent_share IS NULL OR p_recent_share < 0 OR p_recent_share > 1 THEN
    RAISE EXCEPTION 'recent share is invalid';
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
    allowed_deployments,
    recent_share,
    streaming_capture
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
    p_deployments,
    p_recent_share,
    p_streaming
  )
  RETURNING id INTO v_id;
  policy_id := v_id;
  policy_version := v_version;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION set_sample_policy(uuid, text, boolean, boolean, boolean, numeric, integer, integer, integer, text[], text[], text[], numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_sample_policy(uuid, text, boolean, boolean, boolean, numeric, integer, integer, integer, text[], text[], text[], numeric, boolean) TO llm_migrator;

RESET ROLE;
