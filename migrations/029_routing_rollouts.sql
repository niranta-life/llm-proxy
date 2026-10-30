-- Additive canary rollout records.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 028.
-- A rollout is not a routing-policy status.
-- canary and active remain outside the policy status set.
-- The canary stays off until one rollout is active.
-- Rollback keeps this file applied. Stop every rollout.
-- Readiness for 028_shadow_ranking.sql still finds that row.

SET LOCAL ROLE llm_owner;

CREATE TABLE routing_rollouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  policy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  alias text NOT NULL,
  basis_points integer NOT NULL,
  max_request_count integer NOT NULL,
  max_expense numeric(20, 8) NOT NULL,
  max_duration_seconds integer NOT NULL,
  evidence_snapshot_id uuid NOT NULL,
  baseline_deployment_id uuid NOT NULL,
  challenger_deployment_id uuid NOT NULL,
  critical_error_threshold integer NOT NULL,
  epoch integer NOT NULL,
  status text NOT NULL,
  stop_reason text,
  activated_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  canary_request_count integer NOT NULL DEFAULT 0,
  canary_expense numeric(20, 8) NOT NULL DEFAULT 0,
  critical_error_count integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES routing_policies (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_snapshot_id) REFERENCES evidence_snapshots (tenant_id, id),
  FOREIGN KEY (tenant_id, baseline_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, challenger_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_rollouts_alias_check CHECK (alias = 'auto'),
  CONSTRAINT routing_rollouts_share_check CHECK (basis_points BETWEEN 0 AND 10000),
  CONSTRAINT routing_rollouts_caps_check CHECK (
    max_request_count BETWEEN 1 AND 1000000
    AND max_expense > 0
    AND max_expense <= 1000000
    AND max_duration_seconds BETWEEN 1 AND 31536000
    AND critical_error_threshold BETWEEN 1 AND 10000
    AND epoch >= 1
    AND canary_request_count >= 0
    AND canary_request_count <= max_request_count
    AND canary_expense >= 0
    AND critical_error_count >= 0
  ),
  CONSTRAINT routing_rollouts_status_check CHECK (status IN ('active', 'stopped')),
  CONSTRAINT routing_rollouts_stop_check CHECK (
    (status = 'active' AND stop_reason IS NULL AND stopped_at IS NULL)
    OR (
      status = 'stopped'
      AND stopped_at IS NOT NULL
      AND stop_reason IN (
        'manual',
        'policy_disabled',
        'evidence_invalid',
        'evidence_stale',
        'request_cap',
        'expense_cap',
        'duration_limit',
        'critical_errors'
      )
    )
  ),
  CONSTRAINT routing_rollouts_targets_check CHECK (baseline_deployment_id <> challenger_deployment_id),
  CONSTRAINT routing_rollouts_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_rollouts_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE UNIQUE INDEX routing_rollouts_one_active
  ON routing_rollouts (tenant_id, alias)
  WHERE status = 'active';

CREATE TABLE routing_rollout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rollout_id uuid NOT NULL,
  action text NOT NULL,
  epoch integer NOT NULL,
  stop_reason text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  CONSTRAINT routing_rollout_events_action_check CHECK (action IN ('activate', 'stop')),
  CONSTRAINT routing_rollout_events_epoch_check CHECK (epoch >= 1),
  CONSTRAINT routing_rollout_events_stop_check CHECK (
    stop_reason IS NULL
    OR stop_reason IN (
      'manual',
      'policy_disabled',
      'evidence_invalid',
      'evidence_stale',
      'request_cap',
      'expense_cap',
      'duration_limit',
      'critical_errors'
    )
  ),
  CONSTRAINT routing_rollout_events_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_rollout_events_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE TABLE routing_canary_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  rollout_id uuid,
  policy_version_id uuid,
  cohort text NOT NULL,
  cohort_deployment_id uuid NOT NULL,
  executed_deployment_id uuid NOT NULL,
  routing_key_digest text,
  hold_reason text NOT NULL,
  reconciled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, rollout_id) REFERENCES routing_rollouts (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, cohort_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, executed_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_canary_assignments_cohort_check CHECK (cohort IN ('baseline', 'canary')),
  CONSTRAINT routing_canary_assignments_digest_check CHECK (
    routing_key_digest IS NULL OR routing_key_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT routing_canary_assignments_reason_check CHECK (
    hold_reason IN (
      'assigned',
      'share_baseline',
      'stopped',
      'policy_disabled',
      'evidence_invalid',
      'evidence_stale',
      'deployment_unvalidated',
      'provider_permission',
      'region_policy',
      'data_policy',
      'safety_unreadable',
      'request_cap',
      'expense_cap',
      'duration_limit',
      'critical_errors',
      'baseline_changed'
    )
  )
);

CREATE INDEX routing_rollouts_tenant_idx ON routing_rollouts (tenant_id, created_at);
CREATE INDEX routing_canary_assignments_rollout_idx ON routing_canary_assignments (tenant_id, rollout_id);

ALTER TABLE routing_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rollouts FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_rollout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rollout_events FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_canary_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_canary_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY routing_rollouts_isolation ON routing_rollouts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_rollout_events_isolation ON routing_rollout_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_canary_assignments_isolation ON routing_canary_assignments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON routing_rollouts FROM PUBLIC;
REVOKE ALL ON routing_rollout_events FROM PUBLIC;
REVOKE ALL ON routing_canary_assignments FROM PUBLIC;

CREATE FUNCTION reject_rollout_event_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'rollout event is immutable';
END;
$$;

CREATE TRIGGER routing_rollout_events_immutable
  BEFORE UPDATE OR DELETE ON routing_rollout_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_rollout_event_change();

CREATE FUNCTION reject_rollout_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.alias IS DISTINCT FROM OLD.alias
     OR NEW.basis_points IS DISTINCT FROM OLD.basis_points
     OR NEW.max_request_count IS DISTINCT FROM OLD.max_request_count
     OR NEW.max_expense IS DISTINCT FROM OLD.max_expense
     OR NEW.max_duration_seconds IS DISTINCT FROM OLD.max_duration_seconds
     OR NEW.evidence_snapshot_id IS DISTINCT FROM OLD.evidence_snapshot_id
     OR NEW.baseline_deployment_id IS DISTINCT FROM OLD.baseline_deployment_id
     OR NEW.challenger_deployment_id IS DISTINCT FROM OLD.challenger_deployment_id
     OR NEW.critical_error_threshold IS DISTINCT FROM OLD.critical_error_threshold
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'rollout identity is immutable';
  END IF;
  IF OLD.status = 'stopped' AND (NEW.status IS DISTINCT FROM 'stopped' OR NEW.epoch IS DISTINCT FROM OLD.epoch) THEN
    RAISE EXCEPTION 'stopped rollout cannot restart';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER routing_rollouts_immutable_identity
  BEFORE UPDATE OR DELETE ON routing_rollouts
  FOR EACH ROW
  EXECUTE FUNCTION reject_rollout_rewrite();

CREATE FUNCTION reject_canary_cohort_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'canary assignment is immutable';
  END IF;
  IF NEW.cohort IS DISTINCT FROM OLD.cohort
     OR NEW.cohort_deployment_id IS DISTINCT FROM OLD.cohort_deployment_id
     OR NEW.rollout_id IS DISTINCT FROM OLD.rollout_id
     OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.routing_key_digest IS DISTINCT FROM OLD.routing_key_digest
     OR NEW.hold_reason IS DISTINCT FROM OLD.hold_reason
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  THEN
    RAISE EXCEPTION 'canary cohort is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER routing_canary_assignments_cohort
  BEFORE UPDATE OR DELETE ON routing_canary_assignments
  FOR EACH ROW
  EXECUTE FUNCTION reject_canary_cohort_change();

REVOKE ALL ON FUNCTION reject_rollout_event_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_rollout_rewrite() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_canary_cohort_change() FROM PUBLIC;

GRANT SELECT, INSERT ON routing_rollouts TO llm_runtime;
GRANT UPDATE (
  status,
  epoch,
  stop_reason,
  stopped_at,
  canary_request_count,
  canary_expense,
  critical_error_count,
  updated_at
) ON routing_rollouts TO llm_runtime;
GRANT SELECT, INSERT ON routing_rollout_events TO llm_runtime;
GRANT SELECT, INSERT ON routing_canary_assignments TO llm_runtime;
GRANT UPDATE (executed_deployment_id, reconciled) ON routing_canary_assignments TO llm_runtime;

RESET ROLE;
