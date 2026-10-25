-- Additive challenger replay.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 021.
-- Dry-run rows stay valid.
-- Replay output is ciphertext. Operator reads do not select it.
-- Rollback keeps this file applied.
-- Readiness for 020_stream_samples.sql and 021_evaluation_orchestration.sql still finds those rows.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE evaluation_definition_versions
  DROP CONSTRAINT evaluation_definition_versions_config_check;

ALTER TABLE evaluation_definition_versions
  ADD CONSTRAINT evaluation_definition_versions_config_check CHECK (
    jsonb_typeof(config) = 'object'
    AND NOT (config ? 'prompt')
    AND NOT (config ? 'messages')
    AND NOT (config ? 'content')
    AND NOT (config ? 'ciphertext')
    AND (
      (config->>'mode' = 'dry_run' AND config->>'modelExecution' = 'off')
      OR (config->>'mode' = 'replay' AND config->>'modelExecution' = 'pinned')
    )
  );

ALTER TABLE evaluation_runs
  DROP CONSTRAINT evaluation_runs_snapshot_check;

ALTER TABLE evaluation_runs
  ADD CONSTRAINT evaluation_runs_snapshot_check CHECK (
    jsonb_typeof(config_snapshot) = 'object'
    AND NOT (config_snapshot ? 'prompt')
    AND NOT (config_snapshot ? 'messages')
    AND NOT (config_snapshot ? 'content')
    AND NOT (config_snapshot ? 'ciphertext')
    AND (
      (config_snapshot->>'mode' = 'dry_run' AND config_snapshot->>'modelExecution' = 'off')
      OR (config_snapshot->>'mode' = 'replay' AND config_snapshot->>'modelExecution' = 'pinned')
    )
  );

ALTER TABLE evaluation_items
  DROP CONSTRAINT evaluation_items_reason_check;

ALTER TABLE evaluation_items
  ADD CONSTRAINT evaluation_items_reason_check CHECK (
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
      'sample_category_mismatch',
      'replay_completed',
      'provider_timeout',
      'provider_rate_limited',
      'provider_error',
      'malformed_output',
      'usage_missing',
      'cost_missing',
      'invalid_canonical',
      'semantic_rejected',
      'deployment_unhealthy',
      'rate_limited',
      'concurrency_limited',
      'not_dispatched',
      'uncertain',
      'kill_switch',
      'admission_unavailable',
      'output_not_sealed'
    )
  );

ALTER TABLE evaluation_jobs
  DROP CONSTRAINT evaluation_jobs_kind_check;

ALTER TABLE evaluation_jobs
  ADD CONSTRAINT evaluation_jobs_kind_check CHECK (kind IN ('dry_run', 'replay'));

ALTER TABLE evaluation_jobs
  DROP CONSTRAINT evaluation_jobs_payload_check;

ALTER TABLE evaluation_jobs
  ADD CONSTRAINT evaluation_jobs_payload_check CHECK (
    (kind = 'dry_run' AND payload = jsonb_build_object('kind', 'dry_run'))
    OR (kind = 'replay' AND payload = jsonb_build_object('kind', 'replay'))
  );

ALTER TABLE proxy_requests
  ADD COLUMN traffic_class text NOT NULL DEFAULT 'production';

ALTER TABLE proxy_requests
  ADD CONSTRAINT proxy_requests_traffic_class_check
  CHECK (traffic_class IN ('production', 'evaluation'));

CREATE TABLE evaluation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  sample_id uuid NOT NULL,
  request_id uuid NOT NULL,
  model_attempt_id uuid NOT NULL,
  status text NOT NULL,
  reason_code text,
  original_deployment text NOT NULL,
  challenger_deployment text NOT NULL,
  config_version integer NOT NULL,
  adapter_version integer NOT NULL,
  execution_parameters jsonb NOT NULL,
  provider_response_id text,
  latency_ms integer,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_amount numeric(38, 12),
  cost_status text,
  error_code text,
  output_schema_version integer,
  wrapping_key_version integer,
  wrapped_key_iv bytea,
  wrapped_key_tag bytea,
  wrapped_key_ciphertext bytea,
  content_iv bytea,
  content_tag bytea,
  content_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id),
  UNIQUE (tenant_id, model_attempt_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES evaluation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES evaluation_items (tenant_id, id),
  FOREIGN KEY (tenant_id, sample_id) REFERENCES request_samples (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, model_attempt_id) REFERENCES model_attempts (tenant_id, id),
  CONSTRAINT evaluation_attempts_status_check CHECK (
    status IN ('reserved', 'dispatched', 'completed', 'failed', 'uncertain')
  ),
  CONSTRAINT evaluation_attempts_reason_check CHECK (
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
      'sample_category_mismatch',
      'replay_completed',
      'provider_timeout',
      'provider_rate_limited',
      'provider_error',
      'malformed_output',
      'usage_missing',
      'cost_missing',
      'invalid_canonical',
      'semantic_rejected',
      'deployment_unhealthy',
      'rate_limited',
      'concurrency_limited',
      'not_dispatched',
      'uncertain',
      'kill_switch',
      'admission_unavailable',
      'output_not_sealed'
    )
  ),
  CONSTRAINT evaluation_attempts_deployment_check CHECK (
    original_deployment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND original_deployment <> 'auto'
    AND challenger_deployment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND challenger_deployment <> 'auto'
  ),
  CONSTRAINT evaluation_attempts_version_check CHECK (config_version > 0 AND adapter_version > 0),
  CONSTRAINT evaluation_attempts_parameters_check CHECK (
    jsonb_typeof(execution_parameters) = 'object'
    AND NOT (execution_parameters ? 'prompt')
    AND NOT (execution_parameters ? 'messages')
    AND NOT (execution_parameters ? 'content')
    AND NOT (execution_parameters ? 'ciphertext')
  ),
  CONSTRAINT evaluation_attempts_latency_check CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT evaluation_attempts_tokens_check CHECK (
    (prompt_tokens IS NULL OR prompt_tokens >= 0)
    AND (completion_tokens IS NULL OR completion_tokens >= 0)
    AND (total_tokens IS NULL OR total_tokens >= 0)
  ),
  CONSTRAINT evaluation_attempts_cost_check CHECK (
    (cost_amount IS NULL OR cost_amount >= 0)
    AND (
      cost_status IS NULL
      OR cost_status IN ('estimated', 'provisional', 'reconciled', 'unknown')
    )
  ),
  CONSTRAINT evaluation_attempts_response_check CHECK (
    provider_response_id IS NULL
    OR (char_length(provider_response_id) BETWEEN 1 AND 256 AND provider_response_id !~ '[[:space:]]')
  ),
  CONSTRAINT evaluation_attempts_error_check CHECK (
    error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  CONSTRAINT evaluation_attempts_output_check CHECK (
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

CREATE INDEX evaluation_attempts_run_idx
  ON evaluation_attempts (tenant_id, run_id, created_at);

ALTER TABLE evaluation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY evaluation_attempts_isolation ON evaluation_attempts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON evaluation_attempts FROM PUBLIC;
GRANT SELECT (
  id,
  tenant_id,
  run_id,
  item_id,
  sample_id,
  request_id,
  model_attempt_id,
  status,
  reason_code,
  original_deployment,
  challenger_deployment,
  config_version,
  adapter_version,
  execution_parameters,
  provider_response_id,
  latency_ms,
  prompt_tokens,
  completion_tokens,
  total_tokens,
  cost_amount,
  cost_status,
  error_code,
  created_at,
  updated_at
) ON evaluation_attempts TO llm_runtime;
GRANT INSERT ON evaluation_attempts TO llm_runtime;
GRANT UPDATE (
  status,
  reason_code,
  provider_response_id,
  latency_ms,
  prompt_tokens,
  completion_tokens,
  total_tokens,
  cost_amount,
  cost_status,
  error_code,
  output_schema_version,
  wrapping_key_version,
  wrapped_key_iv,
  wrapped_key_tag,
  wrapped_key_ciphertext,
  content_iv,
  content_tag,
  content_ciphertext,
  updated_at
) ON evaluation_attempts TO llm_runtime;

CREATE FUNCTION load_replay_sample_envelope(p_sample_id uuid)
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
    AND request_samples.tenant_id = v_tenant;
END;
$$;

CREATE FUNCTION claim_replay_evaluation_job(p_worker_id text, p_tenant_ids uuid[])
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
  FROM evaluation_jobs AS candidate
  WHERE candidate.kind = 'replay'
    AND candidate.tenant_id = ANY (p_tenant_ids)
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

REVOKE ALL ON FUNCTION load_replay_sample_envelope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_replay_evaluation_job(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_replay_sample_envelope(uuid) TO llm_runtime, llm_migrator;
GRANT EXECUTE ON FUNCTION claim_replay_evaluation_job(text, uuid[]) TO llm_runtime, llm_migrator;

RESET ROLE;
