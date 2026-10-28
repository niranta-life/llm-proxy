-- Additive evidence qualification profiles and immutable snapshots.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 026.
-- A snapshot does not choose a deployment.
-- Chat does not read these rows when it resolves a model.
-- Rollback keeps this file applied. Do not run a new refresh.
-- Readiness for 026_routing_policies.sql still finds that row.

SET LOCAL ROLE llm_owner;

ALTER TABLE evaluation_profile_versions
  ADD CONSTRAINT evaluation_profile_versions_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE qualification_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (
    name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND name <> 'auto'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE qualification_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  task_category text NOT NULL,
  complexity text NOT NULL,
  input_size_category text NOT NULL,
  output_requirement_id uuid NOT NULL,
  required_capabilities text[] NOT NULL,
  candidate_deployment_id uuid NOT NULL,
  model_version text NOT NULL,
  deployment_config_version integer NOT NULL,
  adapter_version integer NOT NULL,
  min_samples integer NOT NULL,
  objective_floor numeric(6, 5) NOT NULL,
  max_interval_width numeric(6, 5) NOT NULL,
  noninferiority_margin numeric(6, 5) NOT NULL,
  freshness_seconds integer NOT NULL,
  min_coverage numeric(6, 5) NOT NULL,
  config_digest text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, profile_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES qualification_profiles (tenant_id, id),
  FOREIGN KEY (tenant_id, output_requirement_id) REFERENCES evaluation_profile_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT qualification_profile_versions_task_check CHECK (
    task_category IN (
      'classification', 'extraction', 'summarization', 'reasoning', 'coding',
      'translation', 'writing', 'general_qa', 'unknown'
    )
  ),
  CONSTRAINT qualification_profile_versions_complexity_check CHECK (
    complexity IN ('low', 'medium', 'high')
  ),
  CONSTRAINT qualification_profile_versions_size_check CHECK (
    input_size_category IN ('xs', 's', 'm', 'l', 'xl', 'xxl', 'unknown')
  ),
  CONSTRAINT qualification_profile_versions_capabilities_check CHECK (
    cardinality(required_capabilities) <= 12
    AND required_capabilities <@ ARRAY[
      'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop',
      'presence_penalty', 'frequency_penalty', 'seed', 'n', 'user', 'response_format_text'
    ]::text[]
  ),
  CONSTRAINT qualification_profile_versions_model_check CHECK (
    model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND model_version <> 'auto'
    AND deployment_config_version > 0
    AND adapter_version > 0
  ),
  CONSTRAINT qualification_profile_versions_gate_check CHECK (
    min_samples BETWEEN 1 AND 10000
    AND objective_floor >= 0
    AND objective_floor <= 1
    AND max_interval_width > 0
    AND max_interval_width <= 1
    AND noninferiority_margin > 0
    AND noninferiority_margin <= 1
    AND freshness_seconds BETWEEN 1 AND 31536000
    AND min_coverage >= 0
    AND min_coverage <= 1
  ),
  CONSTRAINT qualification_profile_versions_digest_check CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT qualification_profile_versions_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT qualification_profile_versions_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE TABLE evidence_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  profile_version_id uuid NOT NULL,
  source_run_ids uuid[] NOT NULL,
  coverage_rate numeric(10, 6) NOT NULL,
  matched_pairs integer NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, profile_version_id) REFERENCES qualification_profile_versions (tenant_id, id),
  CONSTRAINT evidence_snapshots_coverage_check CHECK (
    coverage_rate >= 0
    AND coverage_rate <= 1
    AND matched_pairs >= 0
    AND cardinality(source_run_ids) <= 1000
  ),
  CONSTRAINT evidence_snapshots_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT evidence_snapshots_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE TABLE evidence_candidate_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  status text NOT NULL,
  reason_codes text[] NOT NULL,
  wilson_lower numeric(10, 6),
  wilson_upper numeric(10, 6),
  difference_lower numeric(10, 6),
  challenger_passes integer NOT NULL,
  challenger_trials integer NOT NULL,
  original_passes integer NOT NULL,
  original_trials integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, snapshot_id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES evidence_snapshots (tenant_id, id),
  CONSTRAINT evidence_assessments_status_check CHECK (
    status IN ('qualified', 'unqualified', 'inconclusive', 'invalidated')
  ),
  CONSTRAINT evidence_assessments_counts_check CHECK (
    challenger_passes >= 0
    AND challenger_trials >= challenger_passes
    AND original_passes >= 0
    AND original_trials >= original_passes
  ),
  CONSTRAINT evidence_assessments_bounds_check CHECK (
    (wilson_lower IS NULL OR (wilson_lower >= 0 AND wilson_lower <= 1))
    AND (wilson_upper IS NULL OR (wilson_upper >= 0 AND wilson_upper <= 1))
    AND (difference_lower IS NULL OR (difference_lower >= -1 AND difference_lower <= 1))
  ),
  CONSTRAINT evidence_assessments_reasons_check CHECK (
    reason_codes <@ ARRAY[
      'contradictory_findings',
      'judge_order_bias',
      'expired_evidence',
      'wrong_task',
      'input_size_mismatch',
      'complexity_mismatch',
      'model_version_mismatch',
      'adapter_version_mismatch',
      'capability_mismatch',
      'output_requirement_mismatch',
      'insufficient_samples',
      'request_distribution_gap',
      'missing_latency',
      'unknown_cost',
      'judge_is_not_objective',
      'invalid_objective_result',
      'objective_threshold_failed',
      'uncertainty_too_wide',
      'noninferiority_failed',
      'judge_inconclusive'
    ]::text[]
    AND (
      (status = 'qualified' AND cardinality(reason_codes) = 0 AND wilson_lower IS NOT NULL AND wilson_upper IS NOT NULL AND difference_lower IS NOT NULL)
      OR (status <> 'qualified' AND cardinality(reason_codes) BETWEEN 1 AND 4)
    )
  )
);

CREATE INDEX qualification_profiles_tenant_idx ON qualification_profiles (tenant_id, created_at);
CREATE INDEX evidence_snapshots_tenant_idx ON evidence_snapshots (tenant_id, created_at, id);

ALTER TABLE qualification_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE qualification_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_candidate_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_candidate_assessments FORCE ROW LEVEL SECURITY;

CREATE POLICY qualification_profiles_isolation ON qualification_profiles
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY qualification_profile_versions_isolation ON qualification_profile_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evidence_snapshots_isolation ON evidence_snapshots
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evidence_candidate_assessments_isolation ON evidence_candidate_assessments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON qualification_profiles FROM PUBLIC;
REVOKE ALL ON qualification_profile_versions FROM PUBLIC;
REVOKE ALL ON evidence_snapshots FROM PUBLIC;
REVOKE ALL ON evidence_candidate_assessments FROM PUBLIC;

CREATE FUNCTION reject_evidence_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evidence record is immutable';
END;
$$;

CREATE TRIGGER qualification_profiles_immutable
  BEFORE UPDATE OR DELETE ON qualification_profiles
  FOR EACH ROW
  EXECUTE FUNCTION reject_evidence_record_change();

CREATE TRIGGER qualification_profile_versions_immutable
  BEFORE UPDATE OR DELETE ON qualification_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_evidence_record_change();

CREATE TRIGGER evidence_snapshots_immutable
  BEFORE UPDATE OR DELETE ON evidence_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION reject_evidence_record_change();

CREATE TRIGGER evidence_candidate_assessments_immutable
  BEFORE UPDATE OR DELETE ON evidence_candidate_assessments
  FOR EACH ROW
  EXECUTE FUNCTION reject_evidence_record_change();

REVOKE ALL ON FUNCTION reject_evidence_record_change() FROM PUBLIC;

GRANT SELECT, INSERT ON qualification_profiles TO llm_runtime;
GRANT SELECT, INSERT ON qualification_profile_versions TO llm_runtime;
GRANT SELECT, INSERT ON evidence_snapshots TO llm_runtime;
GRANT SELECT, INSERT ON evidence_candidate_assessments TO llm_runtime;

RESET ROLE;
