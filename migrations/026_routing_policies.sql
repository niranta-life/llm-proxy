-- Additive routing policy versions, activations, and decision traces.
-- This file does not drop a constraint, a column, or a table.
-- This file does not edit migrations 001 through 025.
-- A shadow row does not choose a deployment.
-- Rollback keeps this file applied. Leave every policy out of shadow.
-- Readiness for 025_evaluation_schedules.sql still finds that row.

SET LOCAL ROLE llm_owner;

ALTER TABLE tenant_api_keys
  ADD CONSTRAINT tenant_api_keys_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE tenant_key_grants (
  tenant_id uuid NOT NULL,
  key_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN ('routing:read', 'routing:admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_id, permission),
  FOREIGN KEY (tenant_id, key_id) REFERENCES tenant_api_keys (tenant_id, id)
);

CREATE TABLE routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (
    name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND name <> 'auto'
  ),
  alias text NOT NULL CHECK (alias = 'auto'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE routing_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  alias text NOT NULL CHECK (alias = 'auto'),
  baseline_deployment_id uuid NOT NULL,
  candidate_deployment_ids uuid[] NOT NULL,
  quality_min_pass_rate numeric(6, 5) NOT NULL,
  quality_min_valid_pairs integer NOT NULL,
  max_cost_per_request numeric(20, 8) NOT NULL,
  max_latency_ms integer NOT NULL,
  task_segments text[] NOT NULL,
  config_digest text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, policy_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES routing_policies (tenant_id, id),
  FOREIGN KEY (tenant_id, baseline_deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT routing_policy_versions_candidates_check CHECK (
    cardinality(candidate_deployment_ids) BETWEEN 1 AND 8
  ),
  CONSTRAINT routing_policy_versions_quality_check CHECK (
    quality_min_pass_rate >= 0
    AND quality_min_pass_rate <= 1
    AND quality_min_valid_pairs BETWEEN 1 AND 10000
  ),
  CONSTRAINT routing_policy_versions_cost_check CHECK (
    max_cost_per_request > 0
    AND max_cost_per_request <= 1000
    AND max_latency_ms BETWEEN 1 AND 600000
  ),
  CONSTRAINT routing_policy_versions_segments_check CHECK (
    cardinality(task_segments) BETWEEN 1 AND 9
    AND task_segments <@ ARRAY[
      'classification', 'extraction', 'summarization', 'reasoning', 'coding',
      'translation', 'writing', 'general_qa', 'unknown'
    ]::text[]
  ),
  CONSTRAINT routing_policy_versions_digest_check CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_policy_versions_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_policy_versions_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE TABLE routing_policy_activations (
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  alias text NOT NULL CHECK (alias = 'auto'),
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'shadow', 'disabled')),
  epoch integer NOT NULL CHECK (epoch >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES routing_policies (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES routing_policy_versions (tenant_id, id)
);

CREATE UNIQUE INDEX routing_policy_activations_one_shadow
  ON routing_policy_activations (tenant_id, alias)
  WHERE status = 'shadow';

CREATE TABLE routing_policy_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  alias text NOT NULL CHECK (alias = 'auto'),
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'shadow', 'disabled')),
  epoch integer NOT NULL CHECK (epoch >= 1),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, policy_id, epoch),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES routing_policies (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES routing_policy_versions (tenant_id, id),
  CONSTRAINT routing_policy_activation_events_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT routing_policy_activation_events_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{1,200}$')
);

CREATE TABLE routing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  alias text,
  baseline_deployment_id uuid,
  selected_deployment_id uuid NOT NULL,
  policy_version_id uuid,
  activation_epoch integer,
  feature_extractor_version integer NOT NULL,
  routing_mode text NOT NULL,
  reason_codes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, selected_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, baseline_deployment_id) REFERENCES model_deployments (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES routing_policy_versions (tenant_id, id),
  CONSTRAINT routing_decisions_alias_check CHECK (alias IS NULL OR alias = 'auto'),
  CONSTRAINT routing_decisions_mode_check CHECK (routing_mode IN ('static', 'shadow', 'bypass')),
  CONSTRAINT routing_decisions_version_check CHECK (feature_extractor_version >= 1),
  CONSTRAINT routing_decisions_epoch_check CHECK (activation_epoch IS NULL OR activation_epoch >= 1),
  CONSTRAINT routing_decisions_reasons_check CHECK (
    cardinality(reason_codes) BETWEEN 1 AND 8
    AND reason_codes <@ ARRAY[
      'static_alias',
      'shadow_observed',
      'named_model',
      'routing_disabled',
      'no_shadow_policy'
    ]::text[]
  ),
  CONSTRAINT routing_decisions_shape_check CHECK (
    (
      routing_mode = 'bypass'
      AND alias IS NULL
      AND baseline_deployment_id IS NULL
      AND policy_version_id IS NULL
      AND activation_epoch IS NULL
    )
    OR (
      routing_mode = 'static'
      AND alias = 'auto'
      AND baseline_deployment_id IS NOT NULL
      AND policy_version_id IS NULL
      AND activation_epoch IS NULL
    )
    OR (
      routing_mode = 'shadow'
      AND alias = 'auto'
      AND baseline_deployment_id IS NOT NULL
      AND policy_version_id IS NOT NULL
      AND activation_epoch IS NOT NULL
    )
  )
);

CREATE INDEX routing_policies_tenant_idx ON routing_policies (tenant_id, created_at);

ALTER TABLE tenant_key_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_key_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_activations FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_policy_activation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_key_grants_isolation ON tenant_key_grants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_policies_isolation ON routing_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_policy_versions_isolation ON routing_policy_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_policy_activations_isolation ON routing_policy_activations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_policy_activation_events_isolation ON routing_policy_activation_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY routing_decisions_isolation ON routing_decisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON tenant_key_grants FROM PUBLIC;
REVOKE ALL ON routing_policies FROM PUBLIC;
REVOKE ALL ON routing_policy_versions FROM PUBLIC;
REVOKE ALL ON routing_policy_activations FROM PUBLIC;
REVOKE ALL ON routing_policy_activation_events FROM PUBLIC;
REVOKE ALL ON routing_decisions FROM PUBLIC;

CREATE FUNCTION reject_routing_policy_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'routing policy is immutable';
END;
$$;

CREATE TRIGGER routing_policies_immutable
  BEFORE UPDATE OR DELETE ON routing_policies
  FOR EACH ROW
  EXECUTE FUNCTION reject_routing_policy_change();

CREATE FUNCTION reject_routing_policy_version_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'routing policy version is immutable';
END;
$$;

CREATE TRIGGER routing_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON routing_policy_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_routing_policy_version_change();

CREATE FUNCTION reject_invalid_routing_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate uuid;
  v_ready boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM model_aliases
    WHERE tenant_id = NEW.tenant_id
      AND alias = 'auto'
  ) THEN
    RAISE EXCEPTION 'unknown alias';
  END IF;
  SELECT deployment_row.enabled AND connection_row.enabled
    INTO v_ready
  FROM model_deployments AS deployment_row
  JOIN provider_connections AS connection_row
    ON connection_row.tenant_id = deployment_row.tenant_id
   AND connection_row.id = deployment_row.connection_id
  WHERE deployment_row.tenant_id = NEW.tenant_id
    AND deployment_row.id = NEW.baseline_deployment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing baseline';
  END IF;
  IF v_ready IS NOT TRUE THEN
    RAISE EXCEPTION 'deployment disabled';
  END IF;
  IF cardinality(NEW.candidate_deployment_ids) <> (
    SELECT count(DISTINCT item)
    FROM unnest(NEW.candidate_deployment_ids) AS item
  ) THEN
    RAISE EXCEPTION 'duplicate candidate';
  END IF;
  IF cardinality(NEW.task_segments) <> (
    SELECT count(DISTINCT item)
    FROM unnest(NEW.task_segments) AS item
  ) THEN
    RAISE EXCEPTION 'duplicate task segment';
  END IF;
  FOREACH v_candidate IN ARRAY NEW.candidate_deployment_ids LOOP
    SELECT deployment_row.enabled AND connection_row.enabled
      INTO v_ready
    FROM model_deployments AS deployment_row
    JOIN provider_connections AS connection_row
      ON connection_row.tenant_id = deployment_row.tenant_id
     AND connection_row.id = deployment_row.connection_id
    WHERE deployment_row.tenant_id = NEW.tenant_id
      AND deployment_row.id = v_candidate;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'candidate not in tenant';
    END IF;
    IF v_ready IS NOT TRUE THEN
      RAISE EXCEPTION 'deployment disabled';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER routing_policy_versions_targets
  BEFORE INSERT ON routing_policy_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_invalid_routing_policy_version();

CREATE FUNCTION reject_routing_activation_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'routing activation cannot be removed';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.alias IS DISTINCT FROM OLD.alias
     OR NEW.epoch IS DISTINCT FROM OLD.epoch + 1 THEN
    RAISE EXCEPTION 'routing activation identity is immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'validated')
    OR (OLD.status = 'validated' AND NEW.status = 'shadow')
    OR (OLD.status = 'validated' AND NEW.status = 'disabled')
    OR (OLD.status = 'shadow' AND NEW.status = 'disabled')
  ) THEN
    RAISE EXCEPTION 'routing activation transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER routing_policy_activations_identity
  BEFORE UPDATE OR DELETE ON routing_policy_activations
  FOR EACH ROW
  EXECUTE FUNCTION reject_routing_activation_identity_change();

CREATE FUNCTION reject_routing_activation_event_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'routing activation event is immutable';
END;
$$;

CREATE TRIGGER routing_policy_activation_events_immutable
  BEFORE UPDATE OR DELETE ON routing_policy_activation_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_routing_activation_event_change();

CREATE FUNCTION reject_routing_decision_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'routing decision is immutable';
END;
$$;

CREATE TRIGGER routing_decisions_immutable
  BEFORE UPDATE OR DELETE ON routing_decisions
  FOR EACH ROW
  EXECUTE FUNCTION reject_routing_decision_change();

CREATE FUNCTION key_routing_permissions(p_tenant_id uuid, p_key_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT array_agg(grant_row.permission ORDER BY grant_row.permission)
      FROM tenant_key_grants AS grant_row
      JOIN tenant_api_keys AS key_row
        ON key_row.tenant_id = grant_row.tenant_id
       AND key_row.id = grant_row.key_id
      WHERE grant_row.tenant_id = p_tenant_id
        AND grant_row.key_id = p_key_id
        AND key_row.revoked_at IS NULL
    ),
    ARRAY[]::text[]
  );
$$;

CREATE FUNCTION grant_routing_permission(p_tenant_id uuid, p_key_id uuid, p_permission text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_permission NOT IN ('routing:read', 'routing:admin') THEN
    RAISE EXCEPTION 'routing permission is invalid';
  END IF;
  INSERT INTO tenant_key_grants (tenant_id, key_id, permission)
  VALUES (p_tenant_id, p_key_id, p_permission)
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION reject_routing_policy_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_routing_policy_version_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_invalid_routing_policy_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_routing_activation_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_routing_activation_event_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_routing_decision_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION key_routing_permissions(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION grant_routing_permission(uuid, uuid, text) FROM PUBLIC;

GRANT SELECT, INSERT ON routing_policies TO llm_runtime;
GRANT SELECT, INSERT ON routing_policy_versions TO llm_runtime;
GRANT SELECT, INSERT ON routing_policy_activation_events TO llm_runtime;
GRANT SELECT, INSERT ON routing_decisions TO llm_runtime;
GRANT SELECT, INSERT ON routing_policy_activations TO llm_runtime;
GRANT UPDATE (status, epoch, version_id, updated_at) ON routing_policy_activations TO llm_runtime;
GRANT EXECUTE ON FUNCTION key_routing_permissions(uuid, uuid) TO llm_auth;
GRANT EXECUTE ON FUNCTION grant_routing_permission(uuid, uuid, text) TO llm_migrator;

RESET ROLE;
