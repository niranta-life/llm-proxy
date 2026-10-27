-- Additive deterministic validator results.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 022.
-- A profile version is immutable after approval.
-- Validator results store no prompt and no completion text.
-- Rollback keeps this file applied.
-- Readiness for 022_evaluation_replay.sql and 021_evaluation_orchestration.sql still finds those rows.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE evaluation_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_profiles_name_check CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  UNIQUE (tenant_id, name)
);

CREATE TABLE evaluation_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  profile_id uuid NOT NULL REFERENCES evaluation_profiles (id),
  version integer NOT NULL,
  status text NOT NULL,
  task_category text NOT NULL,
  config jsonb NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, profile_id, version),
  CONSTRAINT evaluation_profile_versions_version_check CHECK (version >= 1),
  CONSTRAINT evaluation_profile_versions_status_check CHECK (status IN ('draft', 'approved')),
  CONSTRAINT evaluation_profile_versions_activation_check CHECK (
    (status = 'draft' AND activated_at IS NULL)
    OR (status = 'approved' AND activated_at IS NOT NULL)
  ),
  CONSTRAINT evaluation_profile_versions_task_check CHECK (
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
  CONSTRAINT evaluation_profile_versions_config_check CHECK (
    jsonb_typeof(config) = 'object'
    AND jsonb_typeof(config -> 'limits') = 'object'
    AND jsonb_typeof(config -> 'validators') = 'array'
    AND jsonb_array_length(config -> 'validators') BETWEEN 1 AND 16
    AND octet_length(config::text) <= 16384
    AND NOT (config ? 'prompt')
    AND NOT (config ? 'messages')
    AND NOT (config ? 'content')
    AND NOT (config ? 'ciphertext')
    AND position('$ref' in config::text) = 0
    AND config::text !~* 'https?://'
  )
);

CREATE TABLE evaluation_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  profile_version_id uuid NOT NULL REFERENCES evaluation_profile_versions (id),
  sample_id uuid NOT NULL,
  reference jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, profile_version_id, sample_id),
  CONSTRAINT evaluation_references_shape_check CHECK (
    jsonb_typeof(reference) = 'object'
    AND octet_length(reference::text) <= 4096
    AND NOT (reference ? 'prompt')
    AND NOT (reference ? 'messages')
    AND NOT (reference ? 'ciphertext')
  )
);

ALTER TABLE evaluation_runs
  ADD COLUMN profile_version_id uuid NULL REFERENCES evaluation_profile_versions (id);

CREATE TABLE evaluation_validator_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES evaluation_runs (id),
  item_id uuid NOT NULL REFERENCES evaluation_items (id),
  profile_version_id uuid NOT NULL REFERENCES evaluation_profile_versions (id),
  candidate text NOT NULL,
  validator_id text NOT NULL,
  validator_version integer NOT NULL,
  result text NOT NULL,
  measured jsonb NOT NULL,
  evidence_code text NOT NULL,
  error_classification text,
  reference_present boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, item_id, candidate, validator_id, validator_version),
  CONSTRAINT evaluation_validator_results_candidate_check CHECK (candidate IN ('original', 'challenger')),
  CONSTRAINT evaluation_validator_results_validator_check CHECK (validator_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT evaluation_validator_results_version_check CHECK (validator_version > 0),
  CONSTRAINT evaluation_validator_results_result_check CHECK (
    result IN ('pass', 'fail', 'not_applicable', 'unknown')
  ),
  CONSTRAINT evaluation_validator_results_evidence_check CHECK (evidence_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT evaluation_validator_results_error_check CHECK (
    error_classification IS NULL OR error_classification ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT evaluation_validator_results_measured_check CHECK (
    jsonb_typeof(measured) = 'object'
    AND octet_length(measured::text) <= 512
    AND NOT (measured ? 'prompt')
    AND NOT (measured ? 'messages')
    AND NOT (measured ? 'content')
    AND NOT (measured ? 'ciphertext')
  )
);

CREATE INDEX evaluation_profile_versions_profile_idx
  ON evaluation_profile_versions (tenant_id, profile_id, version);

CREATE INDEX evaluation_validator_results_item_idx
  ON evaluation_validator_results (tenant_id, run_id, item_id);

CREATE FUNCTION reject_profile_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'evaluation profile version is immutable';
  END IF;
  IF NEW.config IS DISTINCT FROM OLD.config
    OR NEW.task_category IS DISTINCT FROM OLD.task_category
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'evaluation profile version configuration is immutable';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved' AND NEW.activated_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'evaluation profile version status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_profile_versions_frozen
  BEFORE UPDATE ON evaluation_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_profile_version_mutation();

CREATE FUNCTION reject_profile_version_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evaluation profile version cannot be deleted';
END;
$$;

CREATE TRIGGER evaluation_profile_versions_no_delete
  BEFORE DELETE ON evaluation_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_profile_version_delete();

CREATE FUNCTION reject_frozen_reference_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_version uuid;
  v_status text;
BEGIN
  v_version := CASE WHEN TG_OP = 'DELETE' THEN OLD.profile_version_id ELSE NEW.profile_version_id END;
  SELECT status INTO v_status
  FROM evaluation_profile_versions
  WHERE id = v_version;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'evaluation reference is frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_references_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON evaluation_references
  FOR EACH ROW
  EXECUTE FUNCTION reject_frozen_reference_change();

CREATE FUNCTION reject_evaluation_profile_pin_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.profile_version_id IS DISTINCT FROM OLD.profile_version_id THEN
    RAISE EXCEPTION 'evaluation profile pin is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_runs_profile_pin_immutable
  BEFORE UPDATE ON evaluation_runs
  FOR EACH ROW
  EXECUTE FUNCTION reject_evaluation_profile_pin_change();

CREATE FUNCTION reject_unapproved_validator_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.result IN ('pass', 'fail') THEN
    SELECT status INTO v_status
    FROM evaluation_profile_versions
    WHERE id = NEW.profile_version_id
      AND tenant_id = NEW.tenant_id;
    IF v_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'validator result requires an approved profile';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluation_validator_results_approved
  BEFORE INSERT ON evaluation_validator_results
  FOR EACH ROW
  EXECUTE FUNCTION reject_unapproved_validator_result();

CREATE FUNCTION reject_validator_result_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'validator result is immutable';
END;
$$;

CREATE TRIGGER evaluation_validator_results_immutable
  BEFORE UPDATE OR DELETE ON evaluation_validator_results
  FOR EACH ROW
  EXECUTE FUNCTION reject_validator_result_change();

ALTER TABLE evaluation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_references FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_validator_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_validator_results FORCE ROW LEVEL SECURITY;

CREATE POLICY evaluation_profiles_isolation ON evaluation_profiles
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_profile_versions_isolation ON evaluation_profile_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_references_isolation ON evaluation_references
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY evaluation_validator_results_isolation ON evaluation_validator_results
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON evaluation_profiles FROM PUBLIC;
REVOKE ALL ON evaluation_profile_versions FROM PUBLIC;
REVOKE ALL ON evaluation_references FROM PUBLIC;
REVOKE ALL ON evaluation_validator_results FROM PUBLIC;

GRANT SELECT, INSERT ON evaluation_profiles TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_profile_versions TO llm_runtime;
GRANT UPDATE (status, activated_at) ON evaluation_profile_versions TO llm_runtime;
GRANT SELECT, INSERT, DELETE ON evaluation_references TO llm_runtime;
GRANT SELECT, INSERT ON evaluation_validator_results TO llm_runtime;

CREATE FUNCTION load_evaluation_attempt_envelope(p_attempt_id uuid)
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
    evaluation_attempts.output_schema_version,
    evaluation_attempts.wrapping_key_version,
    evaluation_attempts.wrapped_key_iv,
    evaluation_attempts.wrapped_key_tag,
    evaluation_attempts.wrapped_key_ciphertext,
    evaluation_attempts.content_iv,
    evaluation_attempts.content_tag,
    evaluation_attempts.content_ciphertext
  FROM evaluation_attempts
  WHERE evaluation_attempts.id = p_attempt_id
    AND evaluation_attempts.tenant_id = v_tenant
    AND evaluation_attempts.content_ciphertext IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION load_evaluation_attempt_envelope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_evaluation_attempt_envelope(uuid) TO llm_runtime, llm_migrator;

RESET ROLE;
