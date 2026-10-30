-- Additive promotion activations, proposals, and selection records.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 030.
-- A promotion is not a routing-policy status and not a routing mode.
-- The policy version row stays immutable.
-- Active selection stays off until an operator enables one tenant and one task segment.
-- Rollback keeps this file applied. Leave every promotion out of serving.
-- Readiness for 030_routing_guardrails.sql still finds that row.

SET LOCAL ROLE llm_owner;

CREATE FUNCTION promotion_stages_named(stages integer[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT cardinality(stages) BETWEEN 1 AND 8
    AND (
      SELECT bool_and(value BETWEEN 1 AND 10000)
        AND bool_and(ordinal = 1 OR value > prev)
      FROM (
        SELECT value, ordinal, lag(value) OVER (ORDER BY ordinal) AS prev
        FROM unnest(stages) WITH ORDINALITY AS item(value, ordinal)
      ) AS listed
    )
$$;

CREATE TABLE routing_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  rollout_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  previous_policy_version_id uuid,
  previous_promotion_id uuid,
  rollback_deployment_id uuid NOT NULL,
  alias text NOT NULL,
  activation_epoch integer NOT NULL,
  basis_points integer NOT NULL,
  stages integer[] NOT NULL,
  stage_index integer NOT NULL,
  task_segment text NOT NULL,
  selection_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, activation_epoch),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES routing_policies (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, rollback_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_promotions_alias_check CHECK (alias = 'auto'),
  CONSTRAINT routing_promotions_epoch_check CHECK (activation_epoch >= 1),
  CONSTRAINT routing_promotions_stage_check CHECK (
    stage_index >= 1
    AND stage_index <= cardinality(stages)
    AND basis_points = stages[stage_index]
    AND promotion_stages_named(stages)
  ),
  CONSTRAINT routing_promotions_segment_check CHECK (
    task_segment IN (
      'classification', 'extraction', 'summarization', 'reasoning', 'coding',
      'translation', 'writing', 'general_qa', 'unknown'
    )
  ),
  CONSTRAINT routing_promotions_status_check CHECK (status IN ('serving', 'rolled_back')),
  CONSTRAINT routing_promotions_actor_check CHECK (actor IN ('operator', 'automatic'))
);

CREATE UNIQUE INDEX routing_promotions_one_serving
  ON routing_promotions (tenant_id, alias)
  WHERE status = 'serving';

CREATE TABLE routing_promotion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  promotion_id uuid,
  proposal_id uuid,
  rollout_id uuid NOT NULL,
  action text NOT NULL,
  actor text NOT NULL,
  activation_epoch integer NOT NULL,
  basis_points integer NOT NULL,
  policy_version_id uuid NOT NULL,
  previous_policy_version_id uuid,
  rollback_deployment_id uuid NOT NULL,
  gate_result jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES routing_promotions (tenant_id, id),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, rollback_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_promotion_events_action_check CHECK (
    action IN ('promote', 'advance', 'rollback', 'reject')
  ),
  CONSTRAINT routing_promotion_events_actor_check CHECK (actor IN ('operator', 'automatic')),
  CONSTRAINT routing_promotion_events_epoch_check CHECK (activation_epoch >= 1 AND basis_points BETWEEN 0 AND 10000),
  CONSTRAINT routing_promotion_events_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_promotion_events_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT routing_promotion_events_gate_check CHECK (
    jsonb_typeof(gate_result) = 'object'
    AND octet_length(gate_result::text) <= 2048
    AND NOT (gate_result ? 'prompt')
    AND NOT (gate_result ? 'messages')
    AND NOT (gate_result ? 'content')
    AND NOT (gate_result ? 'output')
    AND NOT (gate_result ? 'completion')
    AND NOT (gate_result ? 'ciphertext')
  )
);

CREATE TABLE routing_policy_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  promotion_id uuid NOT NULL,
  evidence_snapshot_id uuid NOT NULL,
  task_segment text NOT NULL,
  candidate_deployment_id uuid NOT NULL,
  change_kind text NOT NULL,
  gate_name text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, evidence_snapshot_id),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES routing_promotions (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_snapshot_id) REFERENCES evidence_snapshots (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_policy_proposals_kind_check CHECK (
    change_kind IN ('quality', 'cost', 'latency', 'candidate', 'version')
  ),
  CONSTRAINT routing_policy_proposals_status_check CHECK (status IN ('open', 'rejected', 'accepted')),
  CONSTRAINT routing_policy_proposals_gate_check CHECK (gate_name ~ '^[a-z_]{1,64}$'),
  CONSTRAINT routing_policy_proposals_segment_check CHECK (
    task_segment IN (
      'classification', 'extraction', 'summarization', 'reasoning', 'coding',
      'translation', 'writing', 'general_qa', 'unknown'
    )
  )
);

CREATE TABLE routing_auto_promotion_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  enabled boolean NOT NULL DEFAULT false,
  approved_candidate_ids uuid[] NOT NULL,
  quality_min_pass_rate numeric(6, 5) NOT NULL,
  min_valid_pairs integer NOT NULL,
  noninferiority_margin numeric(6, 5) NOT NULL,
  max_basis_points integer NOT NULL,
  require_guardrails boolean NOT NULL DEFAULT true,
  rollback_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routing_auto_promotion_candidates_check CHECK (cardinality(approved_candidate_ids) <= 8),
  CONSTRAINT routing_auto_promotion_quality_check CHECK (
    quality_min_pass_rate >= 0
    AND quality_min_pass_rate <= 1
    AND min_valid_pairs BETWEEN 1 AND 10000
    AND noninferiority_margin > 0
    AND noninferiority_margin <= 1
    AND max_basis_points BETWEEN 1 AND 10000
  )
);

CREATE TABLE routing_selection_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  activation_epoch integer NOT NULL,
  task_segment text NOT NULL,
  baseline_deployment_id uuid NOT NULL,
  selected_deployment_id uuid NOT NULL,
  reason text NOT NULL,
  expected_cost numeric(20, 8),
  routing_key_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES routing_promotions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, baseline_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, selected_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_selection_decisions_epoch_check CHECK (activation_epoch >= 1),
  CONSTRAINT routing_selection_decisions_reason_check CHECK (
    reason IN (
      'selected',
      'baseline_fallback',
      'stage_held',
      'segment_mismatch',
      'selection_disabled',
      'rolled_back'
    )
  ),
  CONSTRAINT routing_selection_decisions_cost_check CHECK (expected_cost IS NULL OR expected_cost >= 0),
  CONSTRAINT routing_selection_decisions_digest_check CHECK (
    routing_key_digest IS NULL OR routing_key_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT routing_selection_decisions_segment_check CHECK (
    task_segment IN (
      'classification', 'extraction', 'summarization', 'reasoning', 'coding',
      'translation', 'writing', 'general_qa', 'unknown'
    )
  )
);

CREATE TABLE routing_selection_pins (
  tenant_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  routing_key_digest text NOT NULL,
  deployment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, promotion_id, routing_key_digest),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES routing_promotions (tenant_id, id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_selection_pins_digest_check CHECK (routing_key_digest ~ '^[a-f0-9]{64}$')
);

ALTER TABLE routing_promotions
  ADD CONSTRAINT routing_promotions_previous_fk
  FOREIGN KEY (tenant_id, previous_promotion_id) REFERENCES routing_promotions (tenant_id, id);

ALTER TABLE routing_promotion_events
  ADD CONSTRAINT routing_promotion_events_proposal_fk
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES routing_policy_proposals (tenant_id, id);

CREATE INDEX routing_promotions_tenant_idx ON routing_promotions (tenant_id, created_at);
CREATE INDEX routing_policy_proposals_promotion_idx ON routing_policy_proposals (tenant_id, promotion_id);
CREATE INDEX routing_selection_decisions_request_idx ON routing_selection_decisions (tenant_id, request_id);

ALTER TABLE routing_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_promotions FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_promotion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_promotion_events FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_auto_promotion_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_auto_promotion_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_selection_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_selection_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_selection_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_selection_pins FORCE ROW LEVEL SECURITY;

CREATE POLICY routing_promotions_isolation ON routing_promotions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_promotion_events_isolation ON routing_promotion_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_policy_proposals_isolation ON routing_policy_proposals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_auto_promotion_policies_isolation ON routing_auto_promotion_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_selection_decisions_isolation ON routing_selection_decisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_selection_pins_isolation ON routing_selection_pins
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON routing_promotions FROM PUBLIC;
REVOKE ALL ON routing_promotion_events FROM PUBLIC;
REVOKE ALL ON routing_policy_proposals FROM PUBLIC;
REVOKE ALL ON routing_auto_promotion_policies FROM PUBLIC;
REVOKE ALL ON routing_selection_decisions FROM PUBLIC;
REVOKE ALL ON routing_selection_pins FROM PUBLIC;

CREATE FUNCTION reject_promotion_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id
     OR NEW.previous_policy_version_id IS DISTINCT FROM OLD.previous_policy_version_id
     OR NEW.rollback_deployment_id IS DISTINCT FROM OLD.rollback_deployment_id
     OR NEW.stages IS DISTINCT FROM OLD.stages
     OR NEW.task_segment IS DISTINCT FROM OLD.task_segment
     OR NEW.rollout_id IS DISTINCT FROM OLD.rollout_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.selection_enabled IS DISTINCT FROM OLD.selection_enabled
     OR NEW.actor IS DISTINCT FROM OLD.actor
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
  THEN
    RAISE EXCEPTION 'promotion identity is immutable';
  END IF;
  IF OLD.status = 'rolled_back' AND NEW.status IS DISTINCT FROM 'rolled_back' THEN
    RAISE EXCEPTION 'rolled back promotion cannot restart';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER routing_promotions_identity
  BEFORE UPDATE OR DELETE ON routing_promotions
  FOR EACH ROW
  EXECUTE FUNCTION reject_promotion_identity_change();

CREATE FUNCTION reject_promotion_event_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'promotion event is immutable';
END;
$$;

CREATE TRIGGER routing_promotion_events_immutable
  BEFORE UPDATE OR DELETE ON routing_promotion_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_promotion_event_change();

CREATE FUNCTION reject_selection_decision_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'selection decision is immutable';
END;
$$;

CREATE TRIGGER routing_selection_decisions_immutable
  BEFORE UPDATE OR DELETE ON routing_selection_decisions
  FOR EACH ROW
  EXECUTE FUNCTION reject_selection_decision_change();

CREATE FUNCTION reject_selection_pin_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'selection pin is immutable';
END;
$$;

CREATE TRIGGER routing_selection_pins_immutable
  BEFORE UPDATE OR DELETE ON routing_selection_pins
  FOR EACH ROW
  EXECUTE FUNCTION reject_selection_pin_change();

REVOKE ALL ON FUNCTION promotion_stages_named(integer[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_promotion_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_promotion_event_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_selection_decision_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_selection_pin_change() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION promotion_stages_named(integer[]) TO llm_runtime;
GRANT SELECT, INSERT ON routing_promotions TO llm_runtime;
GRANT UPDATE (
  activation_epoch,
  basis_points,
  stage_index,
  status,
  updated_at
) ON routing_promotions TO llm_runtime;
GRANT SELECT, INSERT ON routing_promotion_events TO llm_runtime;
GRANT SELECT, INSERT ON routing_policy_proposals TO llm_runtime;
GRANT UPDATE (status, updated_at) ON routing_policy_proposals TO llm_runtime;
GRANT SELECT, INSERT, UPDATE ON routing_auto_promotion_policies TO llm_runtime;
GRANT SELECT, INSERT ON routing_selection_decisions TO llm_runtime;
GRANT SELECT, INSERT ON routing_selection_pins TO llm_runtime;

RESET ROLE;
