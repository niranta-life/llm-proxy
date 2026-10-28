-- Additive evaluation schedules.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 024.
-- sample_jobs stays expire_cleanup only.
-- A schedule tick does not write an alias or a fallback policy.
-- Rollback keeps this file applied. It stops new work by leaving the scheduler off.
-- Readiness for 024_evaluation_judgments.sql still finds that row.

SET LOCAL ROLE llm_owner;

CREATE TABLE evaluation_controls (
  singleton boolean PRIMARY KEY DEFAULT true,
  kill_switch boolean NOT NULL DEFAULT false,
  global_daily_limit numeric(38, 12) NOT NULL,
  global_monthly_limit numeric(38, 12) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_controls_singleton_check CHECK (singleton),
  CONSTRAINT evaluation_controls_daily_check CHECK (global_daily_limit > 0 AND global_daily_limit <= 1),
  CONSTRAINT evaluation_controls_monthly_check CHECK (
    global_monthly_limit >= global_daily_limit AND global_monthly_limit <= 20
  )
);

INSERT INTO evaluation_controls (singleton, kill_switch, global_daily_limit, global_monthly_limit)
VALUES (true, false, 1, 20);

CREATE TABLE evaluation_schedules (
  tenant_id uuid PRIMARY KEY,
  enabled boolean NOT NULL,
  daily_limit numeric(38, 12) NOT NULL,
  monthly_limit numeric(38, 12) NOT NULL,
  per_run_max_expense numeric(38, 12) NOT NULL,
  max_challenger_calls integer NOT NULL,
  max_judge_calls integer NOT NULL,
  max_concurrent_jobs integer NOT NULL,
  max_duration_ms integer NOT NULL,
  max_samples integer NOT NULL,
  challenger_deployment text NOT NULL,
  judge_deployment text,
  profile_version_id uuid,
  rubric_version_id uuid,
  sample_category text NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_schedules_daily_check CHECK (daily_limit > 0 AND daily_limit <= 1),
  CONSTRAINT evaluation_schedules_monthly_check CHECK (monthly_limit >= daily_limit AND monthly_limit <= 20),
  CONSTRAINT evaluation_schedules_run_check CHECK (per_run_max_expense > 0 AND per_run_max_expense <= daily_limit),
  CONSTRAINT evaluation_schedules_calls_check CHECK (
    max_challenger_calls BETWEEN 1 AND 100 AND max_judge_calls BETWEEN 0 AND 40
  ),
  CONSTRAINT evaluation_schedules_jobs_check CHECK (max_concurrent_jobs BETWEEN 1 AND 10),
  CONSTRAINT evaluation_schedules_duration_check CHECK (max_duration_ms BETWEEN 1000 AND 600000),
  CONSTRAINT evaluation_schedules_samples_check CHECK (max_samples BETWEEN 1 AND 20),
  CONSTRAINT evaluation_schedules_deployment_check CHECK (
    challenger_deployment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND challenger_deployment <> 'auto'
    AND (
      judge_deployment IS NULL
      OR (
        judge_deployment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
        AND judge_deployment <> 'auto'
      )
    )
  ),
  CONSTRAINT evaluation_schedules_category_check CHECK (
    sample_category IN (
      'classification', 'extraction', 'summarization', 'reasoning', 'coding',
      'translation', 'writing', 'general_qa', 'unknown'
    )
  ),
  CONSTRAINT evaluation_schedules_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evaluation_schedules_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT evaluation_schedules_judge_check CHECK (
    (rubric_version_id IS NULL AND max_judge_calls >= 0)
    OR (rubric_version_id IS NOT NULL AND judge_deployment IS NOT NULL)
  )
);

CREATE TABLE evaluation_schedule_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  decision_key text NOT NULL,
  idempotency_key text,
  fingerprint text NOT NULL,
  as_of timestamptz NOT NULL,
  action text NOT NULL,
  skip_reason text,
  reason_codes text[] NOT NULL,
  selected_sample_ids uuid[] NOT NULL DEFAULT '{}',
  run_id uuid,
  facts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, decision_key),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT evaluation_schedule_decisions_kind_check CHECK (kind IN ('tick', 'manual')),
  CONSTRAINT evaluation_schedule_decisions_key_check CHECK (decision_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT evaluation_schedule_decisions_idempotency_check CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'
  ),
  CONSTRAINT evaluation_schedule_decisions_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evaluation_schedule_decisions_action_check CHECK (action IN ('run', 'skip')),
  CONSTRAINT evaluation_schedule_decisions_skip_check CHECK (
    (action = 'skip' AND skip_reason IS NOT NULL) OR (action = 'run' AND skip_reason IS NULL)
  ),
  CONSTRAINT evaluation_schedule_decisions_reason_check CHECK (
    skip_reason IS NULL OR skip_reason IN (
      'scheduler_disabled',
      'tenant_not_enabled',
      'schedule_disabled',
      'global_kill_switch',
      'no_eligible_samples',
      'budget_too_small',
      'judge_budget_exhausted',
      'production_capacity_constrained',
      'challenger_call_limit',
      'concurrent_job_limit'
    )
  ),
  CONSTRAINT evaluation_schedule_decisions_codes_check CHECK (
    cardinality(reason_codes) BETWEEN 1 AND 16
    AND reason_codes <@ ARRAY[
      'scheduler_disabled',
      'tenant_not_enabled',
      'schedule_disabled',
      'global_kill_switch',
      'no_eligible_samples',
      'budget_too_small',
      'judge_budget_exhausted',
      'production_capacity_constrained',
      'challenger_call_limit',
      'concurrent_job_limit',
      'stale_evidence',
      'quality_regression',
      'version_change',
      'low_coverage',
      'efficiency_improvement',
      'high_uncertainty',
      'workload_volume',
      'new_samples',
      'bounded_sample'
    ]::text[]
  ),
  CONSTRAINT evaluation_schedule_decisions_facts_check CHECK (
    jsonb_typeof(facts) = 'object'
    AND octet_length(facts::text) <= 8192
    AND NOT (facts ? 'prompt')
    AND NOT (facts ? 'messages')
    AND NOT (facts ? 'content')
    AND NOT (facts ? 'ciphertext')
    AND NOT (facts ? 'completion')
  )
);

CREATE INDEX evaluation_schedule_decisions_page_idx
  ON evaluation_schedule_decisions (tenant_id, created_at DESC, id DESC);

CREATE TABLE evaluation_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  decision_id uuid NOT NULL UNIQUE REFERENCES evaluation_schedule_decisions (id),
  amount numeric(38, 12) NOT NULL,
  status text NOT NULL,
  period_day date NOT NULL,
  period_month date NOT NULL,
  challenger_calls integer NOT NULL,
  judge_calls integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_budget_reservations_amount_check CHECK (amount > 0),
  CONSTRAINT evaluation_budget_reservations_status_check CHECK (status IN ('reserved', 'released')),
  CONSTRAINT evaluation_budget_reservations_calls_check CHECK (challenger_calls >= 0 AND judge_calls >= 0)
);

CREATE INDEX evaluation_budget_reservations_day_idx
  ON evaluation_budget_reservations (tenant_id, period_day)
  WHERE status = 'reserved';

ALTER TABLE evaluation_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_schedule_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_schedule_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_budget_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY evaluation_schedules_isolation ON evaluation_schedules
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_schedule_decisions_isolation ON evaluation_schedule_decisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_budget_reservations_isolation ON evaluation_budget_reservations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON evaluation_controls FROM PUBLIC;
REVOKE ALL ON evaluation_schedules FROM PUBLIC;
REVOKE ALL ON evaluation_schedule_decisions FROM PUBLIC;
REVOKE ALL ON evaluation_budget_reservations FROM PUBLIC;

GRANT SELECT, UPDATE (kill_switch, updated_at) ON evaluation_controls TO llm_runtime;
GRANT SELECT, INSERT, UPDATE ON evaluation_schedules TO llm_runtime;
GRANT SELECT, INSERT, UPDATE (run_id) ON evaluation_schedule_decisions TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_budget_reservations TO llm_runtime;

CREATE FUNCTION lock_evaluation_control()
RETURNS TABLE (kill_switch boolean, global_daily_limit numeric, global_monthly_limit numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.kill_switch, c.global_daily_limit, c.global_monthly_limit
  FROM evaluation_controls AS c
  WHERE c.singleton
  FOR UPDATE;
$$;

CREATE FUNCTION evaluation_global_reserved(p_day date, p_month date)
RETURNS TABLE (daily_amount numeric, monthly_amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE period_day = p_day), 0),
    COALESCE(SUM(amount) FILTER (WHERE period_month = p_month), 0)
  FROM evaluation_budget_reservations
  WHERE status = 'reserved';
$$;

REVOKE ALL ON FUNCTION lock_evaluation_control() FROM PUBLIC;
REVOKE ALL ON FUNCTION evaluation_global_reserved(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_evaluation_control() TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION evaluation_global_reserved(date, date) TO llm_runtime, llm_migrator;

-- A sample that an evaluation item or attempt still references cannot be removed.
-- The foreign key stays. The row stays as a wiped shell and is not a readable sample.
ALTER TABLE request_samples
  ADD COLUMN deletion_hold boolean NOT NULL DEFAULT false;

GRANT SELECT (deletion_hold) ON request_samples TO llm_runtime;

CREATE OR REPLACE FUNCTION delete_request_sample(p_tenant_id uuid, p_sample_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_version integer;
  v_held boolean;
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
    AND id = p_sample_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM request_samples
    WHERE tenant_id = p_tenant_id
      AND id = p_sample_id
      AND deletion_hold IS TRUE
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO sample_deletions (tenant_id, sample_id, reason, policy_version)
  VALUES (p_tenant_id, p_sample_id, p_reason, v_version)
  ON CONFLICT (sample_id) DO NOTHING;
  SELECT EXISTS (
    SELECT 1 FROM evaluation_items
    WHERE tenant_id = p_tenant_id AND sample_id = p_sample_id
  ) OR EXISTS (
    SELECT 1 FROM evaluation_attempts
    WHERE tenant_id = p_tenant_id AND sample_id = p_sample_id
  ) INTO v_held;
  IF v_held THEN
    -- The user trigger rejects every update. Disabling it for this statement
    -- avoids returning NEW through a generated column. The foreign key stays.
    ALTER TABLE request_samples DISABLE TRIGGER request_samples_immutable;
    UPDATE request_samples
    SET deletion_hold = true,
        wrapped_key_iv = decode(repeat('00', 12), 'hex'),
        wrapped_key_tag = decode(repeat('00', 16), 'hex'),
        wrapped_key_ciphertext = decode(repeat('00', 32), 'hex'),
        content_iv = decode(repeat('00', 12), 'hex'),
        content_tag = decode(repeat('00', 16), 'hex'),
        content_ciphertext = decode(repeat('00', size_bytes), 'hex')
    WHERE tenant_id = p_tenant_id
      AND id = p_sample_id;
    ALTER TABLE request_samples ENABLE TRIGGER request_samples_immutable;
    RETURN true;
  END IF;
  PERFORM set_config('app.sample_delete', 'on', true);
  DELETE FROM request_samples
  WHERE tenant_id = p_tenant_id
    AND id = p_sample_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_sample_rows(p_tenant_id uuid, p_now timestamptz)
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
    WHERE sample_row.deletion_hold IS FALSE
      AND (p_tenant_id IS NULL OR sample_row.tenant_id = p_tenant_id)
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

CREATE OR REPLACE FUNCTION load_replay_sample_envelope(p_sample_id uuid)
RETURNS TABLE (
  schema_version integer,
  wrapping_key_version integer,
  wrapped_key_iv bytea,
  wrapped_key_tag bytea,
  wrapped_key_ciphertext bytea,
  content_iv bytea,
  content_tag bytea,
  content_ciphertext bytea,
  deployment_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := nullif(current_setting('app.tenant_id', true), '')::uuid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'evaluation tenant is required';
  END IF;
  RETURN QUERY
  SELECT
    request_samples.schema_version,
    request_samples.wrapping_key_version,
    request_samples.wrapped_key_iv,
    request_samples.wrapped_key_tag,
    request_samples.wrapped_key_ciphertext,
    request_samples.content_iv,
    request_samples.content_tag,
    request_samples.content_ciphertext,
    request_samples.deployment_name
  FROM request_samples
  WHERE request_samples.id = p_sample_id
    AND request_samples.tenant_id = v_tenant
    AND request_samples.deletion_hold IS FALSE;
END;
$$;

RESET ROLE;
