-- Additive blind judge judgments.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 023.
-- A rubric version is immutable after approval.
-- Judge evidence is ciphertext. Operator reads do not select it.
-- Rollback keeps this file applied.
-- Readiness for 023_evaluation_validators.sql still finds that row.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE evaluation_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_rubrics_name_check CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  UNIQUE (tenant_id, name)
);

CREATE TABLE evaluation_rubric_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rubric_id uuid NOT NULL REFERENCES evaluation_rubrics (id),
  version integer NOT NULL,
  status text NOT NULL,
  task_category text NOT NULL,
  config jsonb NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rubric_id, version),
  CONSTRAINT evaluation_rubric_versions_version_check CHECK (version >= 1),
  CONSTRAINT evaluation_rubric_versions_status_check CHECK (status IN ('draft', 'approved')),
  CONSTRAINT evaluation_rubric_versions_activation_check CHECK (
    (status = 'draft' AND activated_at IS NULL)
    OR (status = 'approved' AND activated_at IS NOT NULL)
  ),
  CONSTRAINT evaluation_rubric_versions_task_check CHECK (
    task_category IN (
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
  ),
  CONSTRAINT evaluation_rubric_versions_config_check CHECK (
    jsonb_typeof(config) = 'object'
    AND jsonb_typeof(config -> 'criteria') = 'array'
    AND jsonb_array_length(config -> 'criteria') BETWEEN 5 AND 6
    AND octet_length(config::text) <= 4096
    AND NOT (config ? 'prompt')
    AND NOT (config ? 'messages')
    AND NOT (config ? 'content')
    AND NOT (config ? 'ciphertext')
  )
);

ALTER TABLE evaluation_runs
  ADD COLUMN rubric_version_id uuid NULL REFERENCES evaluation_rubric_versions (id);

-- A judge job is a separate row. evaluation_jobs keeps one row per item.
CREATE TABLE evaluation_judge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT jsonb_build_object('kind', 'judge'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES evaluation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES evaluation_items (tenant_id, id),
  CONSTRAINT evaluation_judge_jobs_status_check CHECK (
    status IN ('pending', 'running', 'succeeded', 'cancelled')
  ),
  CONSTRAINT evaluation_judge_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT evaluation_judge_jobs_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT evaluation_judge_jobs_worker_check CHECK (
    locked_by IS NULL OR locked_by ~ '^[A-Za-z0-9:_-]{1,64}$'
  ),
  CONSTRAINT evaluation_judge_jobs_error_check CHECK (
    last_error IS NULL OR last_error IN ('lease expired', 'cancelled')
  ),
  CONSTRAINT evaluation_judge_jobs_payload_check CHECK (
    payload = jsonb_build_object('kind', 'judge')
  )
);

CREATE INDEX evaluation_judge_jobs_claim_idx
  ON evaluation_judge_jobs (status, available_at, created_at, id)
  WHERE status IN ('pending', 'running');

CREATE TABLE evaluation_judge_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  comparison_order text NOT NULL,
  rubric_version_id uuid NOT NULL REFERENCES evaluation_rubric_versions (id),
  judge_deployment text NOT NULL,
  judge_model text NOT NULL,
  rubric_version integer NOT NULL,
  status text NOT NULL,
  blind_winner text,
  mapped_candidate text,
  confidence numeric(8, 6),
  rejection_code text,
  latency_ms integer NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_amount numeric(38, 12),
  cost_status text,
  request_id uuid NOT NULL,
  model_attempt_id uuid NOT NULL,
  output_schema_version integer,
  wrapping_key_version integer,
  wrapped_key_iv bytea,
  wrapped_key_tag bytea,
  wrapped_key_ciphertext bytea,
  content_iv bytea,
  content_tag bytea,
  content_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, item_id, comparison_order),
  UNIQUE (tenant_id, model_attempt_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES evaluation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES evaluation_items (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, model_attempt_id) REFERENCES model_attempts (tenant_id, id),
  CONSTRAINT evaluation_judge_calls_order_check CHECK (comparison_order IN ('forward', 'reverse')),
  CONSTRAINT evaluation_judge_calls_status_check CHECK (status IN ('accepted', 'rejected')),
  CONSTRAINT evaluation_judge_calls_winner_check CHECK (
    (
      status = 'accepted'
      AND blind_winner IN ('X', 'Y', 'tie', 'inconclusive')
      AND mapped_candidate IN ('original', 'challenger', 'tie', 'inconclusive')
      AND rejection_code IS NULL
    )
    OR (
      status = 'rejected'
      AND blind_winner IS NULL
      AND mapped_candidate IS NULL
      AND rejection_code IN (
        'malformed_json',
        'missing_rubric_field',
        'invalid_confidence',
        'tool_invocation',
        'provider_timeout',
        'provider_error'
      )
    )
  ),
  CONSTRAINT evaluation_judge_calls_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT evaluation_judge_calls_names_check CHECK (
    judge_deployment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND judge_deployment <> 'auto'
    AND judge_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND judge_model <> 'auto'
    AND rubric_version > 0
  ),
  CONSTRAINT evaluation_judge_calls_latency_check CHECK (latency_ms >= 0),
  CONSTRAINT evaluation_judge_calls_tokens_check CHECK (
    (prompt_tokens IS NULL OR prompt_tokens >= 0)
    AND (completion_tokens IS NULL OR completion_tokens >= 0)
    AND (total_tokens IS NULL OR total_tokens >= 0)
  ),
  CONSTRAINT evaluation_judge_calls_cost_check CHECK (
    (cost_amount IS NULL OR cost_amount >= 0)
    AND (
      cost_status IS NULL
      OR cost_status IN ('estimated', 'provisional', 'reconciled', 'unknown')
    )
  ),
  CONSTRAINT evaluation_judge_calls_output_check CHECK (
    (
      content_ciphertext IS NULL
      AND wrapped_key_ciphertext IS NULL
      AND content_iv IS NULL
      AND content_tag IS NULL
      AND wrapped_key_iv IS NULL
      AND wrapped_key_tag IS NULL
      AND output_schema_version IS NULL
      AND wrapping_key_version IS NULL
    )
    OR (
      octet_length(wrapped_key_iv) = 12
      AND octet_length(wrapped_key_tag) = 16
      AND octet_length(wrapped_key_ciphertext) = 32
      AND octet_length(content_iv) = 12
      AND octet_length(content_tag) = 16
      AND octet_length(content_ciphertext) BETWEEN 1 AND 1000000
      AND output_schema_version > 0
      AND wrapping_key_version > 0
    )
  )
);

CREATE TABLE evaluation_judge_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  rubric_version_id uuid NOT NULL REFERENCES evaluation_rubric_versions (id),
  judge_model text NOT NULL,
  rubric_version integer NOT NULL,
  outcome text NOT NULL,
  forward_mapped text,
  reverse_mapped text,
  stop_reason text,
  latency_ms integer NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_amount numeric(38, 12),
  cost_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, item_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES evaluation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES evaluation_items (tenant_id, id),
  CONSTRAINT evaluation_judge_findings_outcome_check CHECK (
    outcome IN ('model_a', 'model_b', 'tie', 'inconclusive', 'unstable')
  ),
  CONSTRAINT evaluation_judge_findings_mapped_check CHECK (
    (forward_mapped IS NULL OR forward_mapped IN ('original', 'challenger', 'tie', 'inconclusive'))
    AND (reverse_mapped IS NULL OR reverse_mapped IN ('original', 'challenger', 'tie', 'inconclusive'))
  ),
  CONSTRAINT evaluation_judge_findings_stop_check CHECK (
    stop_reason IS NULL
    OR stop_reason IN (
      'disclosure_revoked',
      'deployment_unauthorized',
      'budget_exceeded',
      'provider_unavailable',
      'provider_timeout',
      'cancelled',
      'parse_rejected',
      'provider_denied',
      'sample_expired',
      'provider_error',
      'output_unreadable'
    )
  ),
  CONSTRAINT evaluation_judge_findings_model_check CHECK (
    judge_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND judge_model <> 'auto'
    AND rubric_version > 0
  ),
  CONSTRAINT evaluation_judge_findings_latency_check CHECK (latency_ms >= 0),
  CONSTRAINT evaluation_judge_findings_tokens_check CHECK (
    (prompt_tokens IS NULL OR prompt_tokens >= 0)
    AND (completion_tokens IS NULL OR completion_tokens >= 0)
    AND (total_tokens IS NULL OR total_tokens >= 0)
  ),
  CONSTRAINT evaluation_judge_findings_cost_check CHECK (
    (cost_amount IS NULL OR cost_amount >= 0)
    AND (
      cost_status IS NULL
      OR cost_status IN ('estimated', 'provisional', 'reconciled', 'unknown')
    )
  ),
  CONSTRAINT evaluation_judge_findings_win_check CHECK (
    outcome IN ('inconclusive', 'unstable')
    OR (
      stop_reason IS NULL
      AND forward_mapped IS NOT NULL
      AND reverse_mapped IS NOT NULL
      AND forward_mapped = reverse_mapped
    )
  )
);

CREATE INDEX evaluation_rubric_versions_rubric_idx
  ON evaluation_rubric_versions (tenant_id, rubric_id, version);

CREATE INDEX evaluation_judge_calls_item_idx
  ON evaluation_judge_calls (tenant_id, run_id, item_id);

CREATE INDEX evaluation_judge_findings_run_idx
  ON evaluation_judge_findings (tenant_id, run_id, item_id);

CREATE FUNCTION reject_rubric_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'evaluation rubric version is immutable';
  END IF;
  IF NEW.config IS DISTINCT FROM OLD.config
    OR NEW.task_category IS DISTINCT FROM OLD.task_category
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.rubric_id IS DISTINCT FROM OLD.rubric_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'evaluation rubric version configuration is immutable';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved' AND NEW.activated_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'evaluation rubric version status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_rubric_versions_frozen
  BEFORE UPDATE ON evaluation_rubric_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_rubric_version_mutation();

CREATE FUNCTION reject_rubric_version_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evaluation rubric version cannot be deleted';
END;
$$;

CREATE TRIGGER evaluation_rubric_versions_no_delete
  BEFORE DELETE ON evaluation_rubric_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_rubric_version_delete();

CREATE FUNCTION reject_evaluation_rubric_pin_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rubric_version_id IS DISTINCT FROM OLD.rubric_version_id THEN
    RAISE EXCEPTION 'evaluation rubric pin is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_runs_rubric_pin_immutable
  BEFORE UPDATE ON evaluation_runs
  FOR EACH ROW
  EXECUTE FUNCTION reject_evaluation_rubric_pin_change();

CREATE FUNCTION reject_judge_call_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'judge call is immutable';
END;
$$;

CREATE TRIGGER evaluation_judge_calls_immutable
  BEFORE UPDATE OR DELETE ON evaluation_judge_calls
  FOR EACH ROW
  EXECUTE FUNCTION reject_judge_call_change();

CREATE FUNCTION reject_judge_finding_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'judge finding is immutable';
END;
$$;

CREATE TRIGGER evaluation_judge_findings_immutable
  BEFORE UPDATE OR DELETE ON evaluation_judge_findings
  FOR EACH ROW
  EXECUTE FUNCTION reject_judge_finding_change();

CREATE FUNCTION reject_unapproved_judge_call()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.status = 'accepted' THEN
    SELECT status INTO v_status
    FROM evaluation_rubric_versions
    WHERE id = NEW.rubric_version_id
      AND tenant_id = NEW.tenant_id;
    IF v_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'judge call requires an approved rubric';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_judge_calls_approved
  BEFORE INSERT ON evaluation_judge_calls
  FOR EACH ROW
  EXECUTE FUNCTION reject_unapproved_judge_call();

ALTER TABLE evaluation_rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_rubrics FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_rubric_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_rubric_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_judge_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_judge_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_judge_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_judge_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_judge_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_judge_findings FORCE ROW LEVEL SECURITY;

CREATE POLICY evaluation_rubrics_isolation ON evaluation_rubrics
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_rubric_versions_isolation ON evaluation_rubric_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_judge_jobs_isolation ON evaluation_judge_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_judge_calls_isolation ON evaluation_judge_calls
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_judge_findings_isolation ON evaluation_judge_findings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON evaluation_rubrics FROM PUBLIC;
REVOKE ALL ON evaluation_rubric_versions FROM PUBLIC;
REVOKE ALL ON evaluation_judge_jobs FROM PUBLIC;
REVOKE ALL ON evaluation_judge_calls FROM PUBLIC;
REVOKE ALL ON evaluation_judge_findings FROM PUBLIC;

GRANT SELECT, INSERT ON evaluation_rubrics TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_rubric_versions TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_judge_jobs TO llm_runtime;
GRANT UPDATE (status, activated_at) ON evaluation_rubric_versions TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_judge_findings TO llm_runtime;
GRANT INSERT ON evaluation_judge_calls TO llm_runtime;
GRANT SELECT (
  id,
  tenant_id,
  run_id,
  item_id,
  comparison_order,
  rubric_version_id,
  judge_deployment,
  judge_model,
  rubric_version,
  status,
  blind_winner,
  mapped_candidate,
  confidence,
  rejection_code,
  latency_ms,
  prompt_tokens,
  completion_tokens,
  total_tokens,
  cost_amount,
  cost_status,
  request_id,
  model_attempt_id,
  created_at
) ON evaluation_judge_calls TO llm_runtime;

CREATE FUNCTION load_judge_evidence_envelope(p_call_id uuid)
RETURNS TABLE (
  schema_version integer,
  wrapping_key_version integer,
  wrapped_key_iv bytea,
  wrapped_key_tag bytea,
  wrapped_key_ciphertext bytea,
  content_iv bytea,
  content_tag bytea,
  content_ciphertext bytea
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
    evaluation_judge_calls.output_schema_version,
    evaluation_judge_calls.wrapping_key_version,
    evaluation_judge_calls.wrapped_key_iv,
    evaluation_judge_calls.wrapped_key_tag,
    evaluation_judge_calls.wrapped_key_ciphertext,
    evaluation_judge_calls.content_iv,
    evaluation_judge_calls.content_tag,
    evaluation_judge_calls.content_ciphertext
  FROM evaluation_judge_calls
  WHERE evaluation_judge_calls.id = p_call_id
    AND evaluation_judge_calls.tenant_id = v_tenant
    AND evaluation_judge_calls.content_ciphertext IS NOT NULL;
END;
$$;

CREATE FUNCTION claim_judge_evaluation_job(p_worker_id text, p_tenant_ids uuid[])
RETURNS TABLE (job_id uuid, tenant_id uuid, run_id uuid, item_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9:_-]{1,64}$' THEN
    RAISE EXCEPTION 'evaluation worker id is invalid';
  END IF;
  IF p_tenant_ids IS NULL OR cardinality(p_tenant_ids) = 0 THEN
    RETURN;
  END IF;
  SELECT candidate.id INTO v_id
  FROM evaluation_judge_jobs AS candidate
  WHERE candidate.tenant_id = ANY (p_tenant_ids)
    AND candidate.available_at <= now()
    AND (
      candidate.status = 'pending'
      OR (
        candidate.status = 'running'
        AND (candidate.locked_until IS NULL OR candidate.locked_until < now())
      )
    )
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE evaluation_judge_jobs
  SET status = 'running',
      attempts = evaluation_judge_jobs.attempts + 1,
      locked_until = now() + interval '30 seconds',
      locked_by = p_worker_id,
      heartbeat_at = now(),
      updated_at = now(),
      last_error = NULL
  WHERE evaluation_judge_jobs.id = v_id
  RETURNING evaluation_judge_jobs.id, evaluation_judge_jobs.tenant_id, evaluation_judge_jobs.run_id, evaluation_judge_jobs.item_id;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_evaluation_job(p_job_id uuid, p_worker_id text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9:_-]{1,64}$' THEN
    RAISE EXCEPTION 'evaluation worker id is invalid';
  END IF;
  UPDATE evaluation_jobs
  SET locked_until = now() + interval '30 seconds',
      heartbeat_at = now(),
      updated_at = now()
  WHERE id = p_job_id
    AND status = 'running'
    AND locked_by = p_worker_id
  RETURNING locked_until INTO v_until;
  IF v_until IS NULL THEN
    UPDATE evaluation_judge_jobs
    SET locked_until = now() + interval '30 seconds',
        heartbeat_at = now(),
        updated_at = now()
    WHERE id = p_job_id
      AND status = 'running'
      AND locked_by = p_worker_id
    RETURNING locked_until INTO v_until;
  END IF;
  RETURN v_until;
END;
$$;

CREATE OR REPLACE FUNCTION finish_evaluation_job(p_job_id uuid, p_worker_id text, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9:_-]{1,64}$' THEN
    RAISE EXCEPTION 'evaluation worker id is invalid';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'evaluation job status is invalid';
  END IF;
  UPDATE evaluation_jobs
  SET status = p_status,
      locked_until = NULL,
      updated_at = now(),
      last_error = CASE WHEN p_status = 'cancelled' THEN 'cancelled' ELSE NULL END
  WHERE id = p_job_id
    AND status = 'running'
    AND locked_by = p_worker_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    UPDATE evaluation_judge_jobs
    SET status = p_status,
        locked_until = NULL,
        updated_at = now(),
        last_error = CASE WHEN p_status = 'cancelled' THEN 'cancelled' ELSE NULL END
    WHERE id = p_job_id
      AND status = 'running'
      AND locked_by = p_worker_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION cancel_pending_evaluation_jobs(p_tenant_id uuid, p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_jobs integer;
  v_judge integer;
BEGIN
  v_actor := nullif(current_setting('app.tenant_id', true), '')::uuid;
  IF v_actor IS NOT NULL AND v_actor <> p_tenant_id THEN
    RAISE EXCEPTION 'evaluation tenant mismatch';
  END IF;
  UPDATE evaluation_jobs
  SET status = 'cancelled',
      locked_until = NULL,
      updated_at = now(),
      last_error = 'cancelled'
  WHERE tenant_id = p_tenant_id
    AND run_id = p_run_id
    AND status = 'pending';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  UPDATE evaluation_judge_jobs
  SET status = 'cancelled',
      locked_until = NULL,
      updated_at = now(),
      last_error = 'cancelled'
  WHERE tenant_id = p_tenant_id
    AND run_id = p_run_id
    AND status = 'pending';
  GET DIAGNOSTICS v_judge = ROW_COUNT;
  RETURN v_jobs + v_judge;
END;
$$;

REVOKE ALL ON FUNCTION load_judge_evidence_envelope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_judge_evaluation_job(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_judge_evidence_envelope(uuid) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION claim_judge_evaluation_job(text, uuid[]) TO llm_runtime, llm_migrator;

RESET ROLE;
