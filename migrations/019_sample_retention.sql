-- Additive sample retention.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 018.
-- Deletion audit rows store metadata only.
-- Job rows store metadata only.
-- Rollback keeps this file applied.
-- Readiness for 018_sample_capture.sql still finds that version row.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE sample_policies
  ADD COLUMN recent_share numeric(7, 6) NOT NULL DEFAULT 0.600000;

ALTER TABLE sample_policies
  ADD CONSTRAINT sample_policies_recent_share_check
  CHECK (recent_share >= 0 AND recent_share <= 1);

ALTER TABLE request_samples
  ADD COLUMN fingerprint bytea,
  ADD COLUMN slot text,
  ADD COLUMN task_category text,
  ADD COLUMN input_size integer,
  ADD COLUMN complexity text;

ALTER TABLE request_samples
  ADD CONSTRAINT request_samples_slot_check
  CHECK (slot IS NULL OR slot IN ('recent', 'diverse'));

ALTER TABLE request_samples
  ADD CONSTRAINT request_samples_task_category_check
  CHECK (
    task_category IS NULL
    OR task_category IN (
      'classification',
      'extraction',
      'summarization',
      'reasoning',
      'coding',
      'translation',
      'writing',
      'general_qa',
      'unknown'
    )
  );

ALTER TABLE request_samples
  ADD CONSTRAINT request_samples_input_size_check
  CHECK (input_size IS NULL OR input_size >= 0);

ALTER TABLE request_samples
  ADD CONSTRAINT request_samples_complexity_check
  CHECK (complexity IS NULL OR complexity IN ('low', 'medium', 'high'));

CREATE UNIQUE INDEX request_samples_fingerprint_idx
  ON request_samples (tenant_id, fingerprint)
  WHERE fingerprint IS NOT NULL;

CREATE INDEX request_samples_expires_idx
  ON request_samples (tenant_id, expires_at);

GRANT SELECT (fingerprint, slot, task_category, input_size, complexity)
  ON request_samples TO llm_runtime;

CREATE OR REPLACE FUNCTION reject_request_sample_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.sample_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'sample row is immutable';
END;
$$;

CREATE TABLE sample_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sample_id uuid NOT NULL,
  reason text NOT NULL,
  policy_version integer NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sample_id),
  CONSTRAINT sample_deletions_reason_check CHECK (reason IN ('expired', 'manual', 'revoked', 'cap')),
  CONSTRAINT sample_deletions_version_check CHECK (policy_version > 0)
);

ALTER TABLE sample_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_deletions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON sample_deletions FROM PUBLIC;

CREATE TABLE sample_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT jsonb_build_object('kind', 'expire_cleanup'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sample_jobs_kind_check CHECK (kind = 'expire_cleanup'),
  CONSTRAINT sample_jobs_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT sample_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT sample_jobs_error_check CHECK (last_error IS NULL OR last_error = 'cleanup failed'),
  CONSTRAINT sample_jobs_payload_check CHECK (payload = jsonb_build_object('kind', 'expire_cleanup'))
);

ALTER TABLE sample_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON sample_jobs FROM PUBLIC;

CREATE FUNCTION request_sample_visible(p_expires_at timestamptz, p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_expires_at > statement_timestamp()
    AND EXISTS (
      SELECT 1
      FROM sample_policies AS sample_policy
      WHERE sample_policy.tenant_id = p_tenant_id
        AND sample_policy.mode = 'encrypted_sample'
        AND sample_policy.content_capture = true
        AND sample_policy.policy_version = (
          SELECT max(latest_policy.policy_version)
          FROM sample_policies AS latest_policy
          WHERE latest_policy.tenant_id = p_tenant_id
        )
    );
$$;

CREATE FUNCTION delete_request_sample(p_tenant_id uuid, p_sample_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_version integer;
  v_deleted integer;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('expired', 'manual', 'revoked', 'cap') THEN
    RAISE EXCEPTION 'sample delete reason is invalid';
  END IF;
  v_actor := nullif(current_setting('app.tenant_id', true), '')::uuid;
  IF v_actor IS NOT NULL AND v_actor <> p_tenant_id THEN
    RAISE EXCEPTION 'sample tenant mismatch';
  END IF;
  SELECT policy_version INTO v_version
  FROM request_samples
  WHERE tenant_id = p_tenant_id
    AND id = p_sample_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO sample_deletions (tenant_id, sample_id, reason, policy_version)
  VALUES (p_tenant_id, p_sample_id, p_reason, v_version)
  ON CONFLICT (sample_id) DO NOTHING;
  PERFORM set_config('app.sample_delete', 'on', true);
  DELETE FROM request_samples
  WHERE tenant_id = p_tenant_id
    AND id = p_sample_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

CREATE FUNCTION cleanup_sample_rows(p_tenant_id uuid, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_row record;
  v_reason text;
  v_removed integer := 0;
  v_deleted boolean;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'sample cleanup time is invalid';
  END IF;
  v_actor := nullif(current_setting('app.tenant_id', true), '')::uuid;
  IF v_actor IS NOT NULL AND (p_tenant_id IS NULL OR p_tenant_id <> v_actor) THEN
    RAISE EXCEPTION 'sample tenant mismatch';
  END IF;
  FOR v_row IN
    SELECT sample_row.id, sample_row.tenant_id, sample_row.expires_at
    FROM request_samples AS sample_row
    WHERE (p_tenant_id IS NULL OR sample_row.tenant_id = p_tenant_id)
      AND (
        sample_row.expires_at <= p_now
        OR NOT EXISTS (
          SELECT 1
          FROM sample_policies AS sample_policy
          WHERE sample_policy.tenant_id = sample_row.tenant_id
            AND sample_policy.mode = 'encrypted_sample'
            AND sample_policy.content_capture = true
            AND sample_policy.policy_version = (
              SELECT max(latest_policy.policy_version)
              FROM sample_policies AS latest_policy
              WHERE latest_policy.tenant_id = sample_row.tenant_id
            )
        )
      )
  LOOP
    IF v_row.expires_at <= p_now THEN
      v_reason := 'expired';
    ELSE
      v_reason := 'revoked';
    END IF;
    v_deleted := delete_request_sample(v_row.tenant_id, v_row.id, v_reason);
    IF v_deleted THEN
      v_removed := v_removed + 1;
    END IF;
  END LOOP;
  RETURN v_removed;
END;
$$;

CREATE FUNCTION enqueue_sample_job(p_tenant_id uuid, p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9:_-]{1,200}$' THEN
    RAISE EXCEPTION 'sample job key is invalid';
  END IF;
  IF p_tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant is missing';
  END IF;
  INSERT INTO sample_jobs (tenant_id, kind, idempotency_key, status, payload)
  VALUES (p_tenant_id, 'expire_cleanup', p_key, 'pending', jsonb_build_object('kind', 'expire_cleanup'))
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM sample_jobs
    WHERE idempotency_key = p_key;
  END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION claim_sample_job(p_key text)
RETURNS TABLE (job_id uuid, tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9:_-]{1,200}$' THEN
    RAISE EXCEPTION 'sample job key is invalid';
  END IF;
  RETURN QUERY
  UPDATE sample_jobs
  SET status = 'running',
      attempts = sample_jobs.attempts + 1,
      locked_until = now() + interval '5 minutes',
      updated_at = now(),
      last_error = NULL
  WHERE sample_jobs.idempotency_key = p_key
    AND (
      sample_jobs.status = 'pending'
      OR sample_jobs.status = 'failed'
      OR (
        sample_jobs.status = 'running'
        AND (sample_jobs.locked_until IS NULL OR sample_jobs.locked_until < now())
      )
    )
  RETURNING sample_jobs.id, sample_jobs.tenant_id;
END;
$$;

CREATE FUNCTION finish_sample_job(p_job_id uuid, p_status text, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'sample job status is invalid';
  END IF;
  IF p_status = 'succeeded' AND p_error IS NOT NULL THEN
    RAISE EXCEPTION 'sample job error is invalid';
  END IF;
  IF p_status = 'failed' AND p_error IS DISTINCT FROM 'cleanup failed' THEN
    RAISE EXCEPTION 'sample job error is invalid';
  END IF;
  UPDATE sample_jobs
  SET status = p_status,
      last_error = p_error,
      locked_until = NULL,
      updated_at = now()
  WHERE id = p_job_id
    AND status = 'running';
END;
$$;

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
  p_recent_share numeric
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
    recent_share
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
    p_recent_share
  )
  RETURNING id INTO v_id;
  policy_id := v_id;
  policy_version := v_version;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION show_sample_stats(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_policy sample_policies%ROWTYPE;
  v_categories jsonb;
  v_bands jsonb;
  v_complexity jsonb;
  v_deployments jsonb;
  v_retained integer;
  v_recent integer;
  v_diverse integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant is missing';
  END IF;
  v_actor := nullif(current_setting('app.tenant_id', true), '')::uuid;
  IF v_actor IS NOT NULL AND v_actor <> p_tenant_id THEN
    RAISE EXCEPTION 'sample tenant mismatch';
  END IF;
  SELECT * INTO v_policy
  FROM sample_policies
  WHERE tenant_id = p_tenant_id
  ORDER BY policy_version DESC
  LIMIT 1;
  IF NOT FOUND OR v_policy.mode <> 'encrypted_sample' OR v_policy.content_capture IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'retained', 0,
      'cap', 0,
      'recentShare', 0,
      'recent', 0,
      'diverse', 0,
      'categories', '{}'::jsonb,
      'sizeBands', '{}'::jsonb,
      'complexity', '{}'::jsonb,
      'deployments', '{}'::jsonb
    );
  END IF;
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE slot = 'recent')::int,
    count(*) FILTER (WHERE slot = 'diverse')::int
  INTO v_retained, v_recent, v_diverse
  FROM request_samples
  WHERE tenant_id = p_tenant_id
    AND expires_at > statement_timestamp();
  SELECT coalesce(jsonb_object_agg(item.key, item.count), '{}'::jsonb)
  INTO v_categories
  FROM (
    SELECT coalesce(task_category, 'unknown') AS key, count(*)::int AS count
    FROM request_samples
    WHERE tenant_id = p_tenant_id
      AND expires_at > statement_timestamp()
    GROUP BY 1
  ) AS item;
  SELECT coalesce(jsonb_object_agg(item.key, item.count), '{}'::jsonb)
  INTO v_bands
  FROM (
    SELECT
      CASE
        WHEN input_size IS NULL OR input_size < 0 THEN 'unknown'
        WHEN input_size < 32 THEN 'xs'
        WHEN input_size < 128 THEN 's'
        WHEN input_size < 512 THEN 'm'
        WHEN input_size < 2048 THEN 'l'
        WHEN input_size < 8000 THEN 'xl'
        ELSE 'xxl'
      END AS key,
      count(*)::int AS count
    FROM request_samples
    WHERE tenant_id = p_tenant_id
      AND expires_at > statement_timestamp()
    GROUP BY 1
  ) AS item;
  SELECT coalesce(jsonb_object_agg(item.key, item.count), '{}'::jsonb)
  INTO v_complexity
  FROM (
    SELECT coalesce(complexity, 'unknown') AS key, count(*)::int AS count
    FROM request_samples
    WHERE tenant_id = p_tenant_id
      AND expires_at > statement_timestamp()
    GROUP BY 1
  ) AS item;
  SELECT coalesce(jsonb_object_agg(item.key, item.count), '{}'::jsonb)
  INTO v_deployments
  FROM (
    SELECT deployment_name AS key, count(*)::int AS count
    FROM request_samples
    WHERE tenant_id = p_tenant_id
      AND expires_at > statement_timestamp()
    GROUP BY 1
  ) AS item;
  RETURN jsonb_build_object(
    'retained', v_retained,
    'cap', v_policy.max_sample_count,
    'recentShare', v_policy.recent_share,
    'recent', v_recent,
    'diverse', v_diverse,
    'categories', v_categories,
    'sizeBands', v_bands,
    'complexity', v_complexity,
    'deployments', v_deployments
  );
END;
$$;

REVOKE ALL ON FUNCTION request_sample_visible(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_request_sample(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cleanup_sample_rows(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_sample_job(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_sample_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_sample_job(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_sample_policy(uuid, text, boolean, boolean, boolean, numeric, integer, integer, integer, text[], text[], text[], numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION show_sample_stats(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION request_sample_visible(timestamptz, uuid) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION delete_request_sample(uuid, uuid, text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION cleanup_sample_rows(uuid, timestamptz) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION enqueue_sample_job(uuid, text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION claim_sample_job(text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION finish_sample_job(uuid, text, text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION set_sample_policy(uuid, text, boolean, boolean, boolean, numeric, integer, integer, integer, text[], text[], text[], numeric) TO llm_migrator;
GRANT EXECUTE ON FUNCTION show_sample_stats(uuid) TO llm_runtime, llm_migrator;

RESET ROLE;
