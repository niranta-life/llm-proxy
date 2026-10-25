-- Additive durable evaluation orchestration.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 020.
-- Evaluation rows store metadata only.
-- The worker job kind is dry_run only.
-- Rollback keeps this file applied.
-- Readiness for 020_stream_samples.sql still finds that version row.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE evaluation_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CONSTRAINT evaluation_definitions_name_check CHECK (
    name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  )
);

CREATE TABLE evaluation_definition_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  version integer NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, definition_id, version),
  FOREIGN KEY (tenant_id, definition_id)
    REFERENCES evaluation_definitions (tenant_id, id),
  CONSTRAINT evaluation_definition_versions_version_check CHECK (version >= 1),
  CONSTRAINT evaluation_definition_versions_config_check CHECK (
    jsonb_typeof(config) = 'object'
    AND NOT (config ? 'prompt')
    AND NOT (config ? 'messages')
    AND NOT (config ? 'content')
    AND NOT (config ? 'ciphertext')
    AND config->>'mode' = 'dry_run'
  )
);

CREATE TABLE evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_version_id uuid NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  config_snapshot jsonb NOT NULL,
  sample_category text NOT NULL,
  challenger_deployment text NOT NULL,
  judge_deployment text,
  budget_estimate numeric(38, 12) NOT NULL,
  item_count integer NOT NULL,
  pending_count integer NOT NULL DEFAULT 0,
  queued_count integer NOT NULL DEFAULT 0,
  running_count integer NOT NULL DEFAULT 0,
  completed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  cancelled_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, definition_version_id)
    REFERENCES evaluation_definition_versions (tenant_id, id),
  CONSTRAINT evaluation_runs_status_check CHECK (
    status IN (
      'created',
      'preflight',
      'queued',
      'running',
      'completed',
      'completed_partial',
      'cancel_requested',
      'cancelled',
      'failed'
    )
  ),
  CONSTRAINT evaluation_runs_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT evaluation_runs_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT evaluation_runs_category_check CHECK (
    sample_category IN (
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
  CONSTRAINT evaluation_runs_deployment_check CHECK (
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
  CONSTRAINT evaluation_runs_budget_check CHECK (budget_estimate >= 0),
  CONSTRAINT evaluation_runs_items_check CHECK (item_count BETWEEN 1 AND 100),
  CONSTRAINT evaluation_runs_snapshot_check CHECK (
    jsonb_typeof(config_snapshot) = 'object'
    AND NOT (config_snapshot ? 'prompt')
    AND NOT (config_snapshot ? 'messages')
    AND NOT (config_snapshot ? 'content')
    AND NOT (config_snapshot ? 'ciphertext')
    AND config_snapshot->>'mode' = 'dry_run'
    AND config_snapshot->>'modelExecution' = 'off'
  ),
  CONSTRAINT evaluation_runs_counts_check CHECK (
    pending_count >= 0
    AND queued_count >= 0
    AND running_count >= 0
    AND completed_count >= 0
    AND failed_count >= 0
    AND cancelled_count >= 0
  )
);

CREATE FUNCTION reject_evaluation_run_progress()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pending integer;
  v_queued integer;
  v_running integer;
  v_completed integer;
  v_failed integer;
  v_cancelled integer;
  v_items integer;
BEGIN
  SELECT pending_count, queued_count, running_count, completed_count, failed_count, cancelled_count, item_count
    INTO v_pending, v_queued, v_running, v_completed, v_failed, v_cancelled, v_items
  FROM evaluation_runs
  WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_pending + v_queued + v_running + v_completed + v_failed + v_cancelled <> v_items THEN
    RAISE EXCEPTION 'evaluation run progress does not match the item count';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER evaluation_runs_progress
  AFTER INSERT OR UPDATE ON evaluation_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION reject_evaluation_run_progress();

CREATE INDEX evaluation_runs_tenant_status_idx
  ON evaluation_runs (tenant_id, status, created_at DESC, id DESC);

CREATE INDEX evaluation_runs_tenant_created_idx
  ON evaluation_runs (tenant_id, created_at DESC, id DESC);

CREATE TABLE evaluation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  sample_id uuid NOT NULL,
  ordinal integer NOT NULL,
  status text NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, sample_id),
  UNIQUE (tenant_id, run_id, ordinal),
  FOREIGN KEY (tenant_id, run_id) REFERENCES evaluation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, sample_id) REFERENCES request_samples (tenant_id, id),
  CONSTRAINT evaluation_items_ordinal_check CHECK (ordinal BETWEEN 0 AND 99),
  CONSTRAINT evaluation_items_status_check CHECK (
    status IN ('pending', 'queued', 'running', 'completed', 'cancelled', 'failed')
  ),
  CONSTRAINT evaluation_items_reason_check CHECK (
    reason_code IS NULL
    OR reason_code IN (
      'dry_run',
      'cancelled',
      'sample_not_owned',
      'sample_expired',
      'sample_incomplete',
      'replay_denied',
      'judge_disclosure_denied',
      'deployment_unauthorized',
      'capability_mismatch',
      'residency_denied',
      'provider_denied',
      'budget_exceeded',
      'item_limit_exceeded',
      'run_limit_exceeded',
      'sample_category_mismatch'
    )
  )
);

CREATE INDEX evaluation_items_run_status_idx
  ON evaluation_items (tenant_id, run_id, status, ordinal);

CREATE TABLE evaluation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT jsonb_build_object('kind', 'dry_run'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES evaluation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES evaluation_items (tenant_id, id),
  CONSTRAINT evaluation_jobs_kind_check CHECK (kind = 'dry_run'),
  CONSTRAINT evaluation_jobs_status_check CHECK (
    status IN ('pending', 'running', 'succeeded', 'cancelled')
  ),
  CONSTRAINT evaluation_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT evaluation_jobs_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT evaluation_jobs_worker_check CHECK (
    locked_by IS NULL OR locked_by ~ '^[A-Za-z0-9:_-]{1,64}$'
  ),
  CONSTRAINT evaluation_jobs_error_check CHECK (
    last_error IS NULL OR last_error IN ('lease expired', 'cancelled')
  ),
  CONSTRAINT evaluation_jobs_payload_check CHECK (
    payload = jsonb_build_object('kind', 'dry_run')
  )
);

CREATE INDEX evaluation_jobs_claim_idx
  ON evaluation_jobs (status, available_at, created_at, id)
  WHERE status IN ('pending', 'running');

ALTER TABLE evaluation_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_definition_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_definition_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_items FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY evaluation_definitions_isolation ON evaluation_definitions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_definition_versions_isolation ON evaluation_definition_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_runs_isolation ON evaluation_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_items_isolation ON evaluation_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_jobs_isolation ON evaluation_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON evaluation_definitions FROM PUBLIC;
REVOKE ALL ON evaluation_definition_versions FROM PUBLIC;
REVOKE ALL ON evaluation_runs FROM PUBLIC;
REVOKE ALL ON evaluation_items FROM PUBLIC;
REVOKE ALL ON evaluation_jobs FROM PUBLIC;

GRANT SELECT, INSERT ON evaluation_definitions TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_definition_versions TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_runs TO llm_runtime;
GRANT UPDATE (
  status,
  pending_count,
  queued_count,
  running_count,
  completed_count,
  failed_count,
  cancelled_count,
  updated_at
) ON evaluation_runs TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_items TO llm_runtime;
GRANT UPDATE (status, reason_code, updated_at) ON evaluation_items TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_jobs TO llm_runtime;

CREATE FUNCTION reject_evaluation_version_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evaluation definition version is immutable';
END;
$$;

CREATE TRIGGER evaluation_definition_versions_immutable
  BEFORE UPDATE OR DELETE ON evaluation_definition_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_evaluation_version_change();

CREATE FUNCTION reject_evaluation_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id
    OR NEW.item_count IS DISTINCT FROM OLD.item_count
    OR NEW.sample_category IS DISTINCT FROM OLD.sample_category
    OR NEW.challenger_deployment IS DISTINCT FROM OLD.challenger_deployment
    OR NEW.judge_deployment IS DISTINCT FROM OLD.judge_deployment
    OR NEW.budget_estimate IS DISTINCT FROM OLD.budget_estimate THEN
    RAISE EXCEPTION 'evaluation snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_runs_snapshot_immutable
  BEFORE UPDATE ON evaluation_runs
  FOR EACH ROW
  EXECUTE FUNCTION reject_evaluation_snapshot_change();

CREATE FUNCTION claim_evaluation_job(p_worker_id text)
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
  SELECT candidate.id INTO v_id
  FROM evaluation_jobs AS candidate
  WHERE candidate.kind = 'dry_run'
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
  UPDATE evaluation_jobs
  SET status = 'running',
      attempts = evaluation_jobs.attempts + 1,
      locked_until = now() + interval '30 seconds',
      locked_by = p_worker_id,
      heartbeat_at = now(),
      updated_at = now(),
      last_error = NULL
  WHERE evaluation_jobs.id = v_id
  RETURNING evaluation_jobs.id, evaluation_jobs.tenant_id, evaluation_jobs.run_id, evaluation_jobs.item_id;
END;
$$;

CREATE FUNCTION heartbeat_evaluation_job(p_job_id uuid, p_worker_id text)
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
  RETURN v_until;
END;
$$;

CREATE FUNCTION finish_evaluation_job(p_job_id uuid, p_worker_id text, p_status text)
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
  RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION cancel_pending_evaluation_jobs(p_tenant_id uuid, p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_updated integer;
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
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_evaluation_job(text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION heartbeat_evaluation_job(uuid, text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION finish_evaluation_job(uuid, text, text) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION cancel_pending_evaluation_jobs(uuid, uuid) TO llm_runtime, llm_migrator;

RESET ROLE;
