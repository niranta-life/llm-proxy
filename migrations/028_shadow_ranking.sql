-- Additive shadow ranking records.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 027.
-- A ranking row does not choose the deployment that executes.
-- Predicted savings are estimates. They are not ledger amounts.
-- Rollback keeps this file applied. Leave every policy out of shadow.
-- Readiness for 027_evidence_qualification.sql still finds that row.

SET LOCAL ROLE llm_owner;

CREATE TABLE routing_shadow_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  request_id uuid,
  policy_version_id uuid,
  evidence_snapshot_ids uuid[] NOT NULL DEFAULT '{}',
  baseline_deployment_id uuid,
  recommended_deployment_id uuid,
  actual_deployment_id uuid,
  routing_mode text NOT NULL,
  reason_codes text[] NOT NULL,
  exclusions jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason text,
  savings_kind text NOT NULL,
  estimated_savings numeric(20, 8),
  candidate_count integer NOT NULL,
  eligible_count integer NOT NULL,
  cache_hit boolean NOT NULL,
  computation_ms integer NOT NULL,
  feature_extractor_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, baseline_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, recommended_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, actual_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_shadow_rankings_mode_check CHECK (routing_mode IN ('shadow', 'bypass', 'failed')),
  CONSTRAINT routing_shadow_rankings_savings_kind_check CHECK (savings_kind = 'estimate'),
  CONSTRAINT routing_shadow_rankings_savings_amount_check CHECK (
    estimated_savings IS NULL OR (estimated_savings >= -1000 AND estimated_savings <= 1000)
  ),
  CONSTRAINT routing_shadow_rankings_counts_check CHECK (
    candidate_count BETWEEN 0 AND 8
    AND eligible_count BETWEEN 0 AND 8
    AND eligible_count <= candidate_count
    AND computation_ms BETWEEN 0 AND 600000
    AND feature_extractor_version >= 1
    AND cardinality(evidence_snapshot_ids) <= 8
  ),
  CONSTRAINT routing_shadow_rankings_failure_check CHECK (
    failure_reason IS NULL OR failure_reason IN ('ranking_timeout', 'ranking_failed')
  ),
  CONSTRAINT routing_shadow_rankings_reasons_check CHECK (
    cardinality(reason_codes) BETWEEN 1 AND 8
    AND reason_codes <@ ARRAY[
      'lowest_qualified_cost',
      'latency_tie_break',
      'quality_failed',
      'unauthorized',
      'capability_absent',
      'context_exceeded',
      'evidence_stale',
      'task_unmatched',
      'unknown_complexity',
      'cost_unknown',
      'latency_exceeded',
      'cost_exceeded',
      'baseline_fallback',
      'named_model',
      'ranking_timeout',
      'ranking_failed',
      'no_shadow_policy'
    ]::text[]
  ),
  CONSTRAINT routing_shadow_rankings_exclusions_check CHECK (
    jsonb_typeof(exclusions) = 'array'
    AND jsonb_array_length(exclusions) <= 8
  ),
  CONSTRAINT routing_shadow_rankings_shape_check CHECK (
    (
      routing_mode = 'bypass'
      AND request_id IS NOT NULL
      AND actual_deployment_id IS NOT NULL
      AND recommended_deployment_id IS NULL
      AND baseline_deployment_id IS NULL
      AND policy_version_id IS NULL
      AND failure_reason IS NULL
      AND estimated_savings IS NULL
    )
    OR (
      routing_mode = 'shadow'
      AND policy_version_id IS NOT NULL
      AND baseline_deployment_id IS NOT NULL
      AND failure_reason IS NULL
    )
    OR (
      routing_mode = 'failed'
      AND policy_version_id IS NOT NULL
      AND baseline_deployment_id IS NOT NULL
      AND recommended_deployment_id IS NULL
      AND failure_reason IS NOT NULL
      AND estimated_savings IS NULL
    )
  )
);

CREATE UNIQUE INDEX routing_shadow_rankings_request_idx
  ON routing_shadow_rankings (tenant_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX routing_shadow_rankings_tenant_idx
  ON routing_shadow_rankings (tenant_id, created_at);

ALTER TABLE routing_shadow_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_shadow_rankings FORCE ROW LEVEL SECURITY;

CREATE POLICY routing_shadow_rankings_isolation ON routing_shadow_rankings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON routing_shadow_rankings FROM PUBLIC;

CREATE FUNCTION reject_shadow_ranking_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shadow ranking is immutable';
END;
$$;

CREATE TRIGGER routing_shadow_rankings_immutable
  BEFORE UPDATE OR DELETE ON routing_shadow_rankings
  FOR EACH ROW
  EXECUTE FUNCTION reject_shadow_ranking_change();

REVOKE ALL ON FUNCTION reject_shadow_ranking_change() FROM PUBLIC;
GRANT SELECT, INSERT ON routing_shadow_rankings TO llm_runtime;

RESET ROLE;
