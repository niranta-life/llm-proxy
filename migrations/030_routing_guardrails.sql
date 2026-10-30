-- Additive canary guardrail records.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 029.
-- A guardrail stays off until an operator attaches one set to one rollout.
-- The closed stop_reason check stays in place.
-- A guardrail stop and an operator rollback store stop_reason critical_errors.
-- The violation row records the trigger.
-- An emergency stop still stores manual and writes no violation row.
-- Feedback stores no prompt and no model output.
-- Rollback keeps this file applied.
-- Readiness for 029_routing_rollouts.sql still finds that row.

SET LOCAL ROLE llm_owner;

CREATE FUNCTION guardrail_sources_named(sources text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT cardinality(sources) BETWEEN 1 AND 8
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(sources) AS source
      WHERE source !~ '^[a-z][a-z0-9_-]{0,63}$'
    )
$$;

CREATE TABLE routing_guardrail_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  rollout_id uuid NOT NULL,
  approved_sources text[] NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, rollout_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  CONSTRAINT routing_guardrail_sets_sources_check CHECK (guardrail_sources_named(approved_sources)),
  CONSTRAINT routing_guardrail_sets_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_guardrail_sets_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE TABLE routing_guardrail_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  signal text NOT NULL,
  threshold numeric(20, 8) NOT NULL,
  margin numeric(8, 6) NOT NULL,
  min_samples integer NOT NULL,
  window_seconds integer NOT NULL,
  maturity_seconds integer NOT NULL,
  max_missing_fraction numeric(8, 6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, set_id, ordinal),
  FOREIGN KEY (tenant_id, set_id) REFERENCES routing_guardrail_sets (tenant_id, id),
  CONSTRAINT routing_guardrail_rules_ordinal_check CHECK (ordinal BETWEEN 1 AND 8),
  CONSTRAINT routing_guardrail_rules_threshold_check CHECK (threshold >= 0 AND threshold <= 1000000),
  CONSTRAINT routing_guardrail_rules_margin_check CHECK (margin >= 0 AND margin <= 1),
  CONSTRAINT routing_guardrail_rules_samples_check CHECK (min_samples BETWEEN 1 AND 100000),
  CONSTRAINT routing_guardrail_rules_window_check CHECK (
    window_seconds BETWEEN 1 AND 2592000
    AND maturity_seconds BETWEEN 0 AND 2592000
  ),
  CONSTRAINT routing_guardrail_rules_missing_check CHECK (max_missing_fraction >= 0 AND max_missing_fraction <= 1),
  CONSTRAINT routing_guardrail_rules_kind_check CHECK (
    (
      kind IN ('absolute_failure', 'relative_failure')
      AND signal IN (
        'error_rate',
        'timeout_rate',
        'incomplete_stream_rate',
        'retry_rate',
        'fallback_rate'
      )
    )
    OR (kind = 'latency' AND signal = 'latency_p95')
    OR (kind = 'spending' AND signal = 'cost_sum')
    OR (kind = 'capability' AND signal = 'capability_violation')
    OR (
      kind = 'deterministic_quality'
      AND signal IN ('schema_valid', 'correctness', 'task_success')
    )
    OR (
      kind = 'quality_regression'
      AND signal IN ('task_success', 'correctness', 'evaluation_quality')
    )
  )
);

CREATE TABLE routing_task_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  request_id uuid NOT NULL,
  feedback_id text NOT NULL,
  source text NOT NULL,
  metric text NOT NULL,
  result text NOT NULL,
  validator_version text NOT NULL,
  observed_at timestamptz NOT NULL,
  superseded_feedback_id text,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, feedback_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  CONSTRAINT routing_task_feedback_metric_check CHECK (metric IN ('task_success', 'schema_valid', 'correctness')),
  CONSTRAINT routing_task_feedback_result_check CHECK (result IN ('pass', 'fail', 'unknown')),
  CONSTRAINT routing_task_feedback_id_check CHECK (feedback_id ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT routing_task_feedback_source_check CHECK (source ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT routing_task_feedback_version_check CHECK (validator_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT routing_task_feedback_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_task_feedback_superseded_check CHECK (
    superseded_feedback_id IS NULL OR superseded_feedback_id ~ '^[A-Za-z0-9:_-]{1,200}$'
  )
);

CREATE TABLE routing_guardrail_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rollout_id uuid NOT NULL,
  rule_id uuid,
  trigger text NOT NULL,
  kind text NOT NULL,
  signal text NOT NULL,
  reason text NOT NULL,
  epoch integer NOT NULL,
  evidence jsonb NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, rollout_id, epoch),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES routing_guardrail_rules (tenant_id, id),
  CONSTRAINT routing_guardrail_violations_trigger_check CHECK (trigger IN ('operator', 'guardrail')),
  CONSTRAINT routing_guardrail_violations_epoch_check CHECK (epoch >= 1),
  CONSTRAINT routing_guardrail_violations_reason_check CHECK (reason ~ '^[a-z_]{1,64}$'),
  CONSTRAINT routing_guardrail_violations_kind_check CHECK (kind ~ '^[a-z_]{1,64}$'),
  CONSTRAINT routing_guardrail_violations_signal_check CHECK (signal ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT routing_guardrail_violations_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT routing_guardrail_violations_evidence_check CHECK (
    jsonb_typeof(evidence) = 'object'
    AND octet_length(evidence::text) <= 2048
    AND NOT (evidence ? 'prompt')
    AND NOT (evidence ? 'messages')
    AND NOT (evidence ? 'content')
    AND NOT (evidence ? 'output')
    AND NOT (evidence ? 'completion')
    AND NOT (evidence ? 'ciphertext')
  )
);

CREATE TABLE routing_capability_denials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  rollout_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  parameter text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_capability_denials_parameter_check CHECK (parameter ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE INDEX routing_task_feedback_request_idx ON routing_task_feedback (tenant_id, request_id);
CREATE INDEX routing_guardrail_violations_rollout_idx ON routing_guardrail_violations (tenant_id, rollout_id);
CREATE INDEX routing_capability_denials_rollout_idx ON routing_capability_denials (tenant_id, rollout_id, created_at);

ALTER TABLE routing_guardrail_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_guardrail_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_guardrail_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_guardrail_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_task_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_task_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_guardrail_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_guardrail_violations FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_capability_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_capability_denials FORCE ROW LEVEL SECURITY;

CREATE POLICY routing_guardrail_sets_isolation ON routing_guardrail_sets
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_guardrail_rules_isolation ON routing_guardrail_rules
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_task_feedback_isolation ON routing_task_feedback
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_guardrail_violations_isolation ON routing_guardrail_violations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_capability_denials_isolation ON routing_capability_denials
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON routing_guardrail_sets FROM PUBLIC;
REVOKE ALL ON routing_guardrail_rules FROM PUBLIC;
REVOKE ALL ON routing_task_feedback FROM PUBLIC;
REVOKE ALL ON routing_guardrail_violations FROM PUBLIC;
REVOKE ALL ON routing_capability_denials FROM PUBLIC;

CREATE FUNCTION reject_guardrail_set_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'guardrail set is immutable';
END;
$$;

CREATE TRIGGER routing_guardrail_sets_immutable
  BEFORE UPDATE OR DELETE ON routing_guardrail_sets
  FOR EACH ROW
  EXECUTE FUNCTION reject_guardrail_set_change();

CREATE FUNCTION reject_guardrail_rule_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'guardrail rule is immutable';
END;
$$;

CREATE TRIGGER routing_guardrail_rules_immutable
  BEFORE UPDATE OR DELETE ON routing_guardrail_rules
  FOR EACH ROW
  EXECUTE FUNCTION reject_guardrail_rule_change();

CREATE FUNCTION reject_task_feedback_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task feedback is immutable';
END;
$$;

CREATE TRIGGER routing_task_feedback_immutable
  BEFORE UPDATE OR DELETE ON routing_task_feedback
  FOR EACH ROW
  EXECUTE FUNCTION reject_task_feedback_change();

CREATE FUNCTION reject_guardrail_violation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'guardrail violation is immutable';
END;
$$;

CREATE TRIGGER routing_guardrail_violations_immutable
  BEFORE UPDATE OR DELETE ON routing_guardrail_violations
  FOR EACH ROW
  EXECUTE FUNCTION reject_guardrail_violation_change();

CREATE FUNCTION reject_capability_denial_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'capability denial is immutable';
END;
$$;

CREATE TRIGGER routing_capability_denials_immutable
  BEFORE UPDATE OR DELETE ON routing_capability_denials
  FOR EACH ROW
  EXECUTE FUNCTION reject_capability_denial_change();

REVOKE ALL ON FUNCTION reject_guardrail_set_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_guardrail_rule_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_task_feedback_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_guardrail_violation_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_capability_denial_change() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION guardrail_sources_named(text[]) TO llm_runtime;
GRANT SELECT, INSERT ON routing_guardrail_sets TO llm_runtime;
GRANT SELECT, INSERT ON routing_guardrail_rules TO llm_runtime;
GRANT SELECT, INSERT ON routing_task_feedback TO llm_runtime;
GRANT SELECT, INSERT ON routing_guardrail_violations TO llm_runtime;
GRANT SELECT, INSERT ON routing_capability_denials TO llm_runtime;

RESET ROLE;
