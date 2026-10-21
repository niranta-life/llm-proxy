-- Additive provider breaker settings and shared replica state.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 013.
-- Rollback keeps this file applied.
-- Image fc4a63c stays ready while 013_execution_policy.sql remains applied.
-- A disabled breaker does not change the deployment or the alias.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE deployment_breakers (
  tenant_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  enabled boolean NOT NULL,
  window_ms integer NOT NULL,
  min_samples integer NOT NULL,
  failure_threshold integer NOT NULL,
  cooldown_ms integer NOT NULL,
  max_probes integer NOT NULL,
  state text NOT NULL,
  state_reason text NOT NULL,
  state_changed_at timestamptz NOT NULL,
  cooldown_until timestamptz,
  probes_inflight integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, deployment_id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT deployment_breakers_window_check CHECK (window_ms BETWEEN 100 AND 3600000),
  CONSTRAINT deployment_breakers_min_samples_check CHECK (min_samples BETWEEN 1 AND 10000),
  CONSTRAINT deployment_breakers_failure_threshold_check CHECK (failure_threshold BETWEEN 1 AND 10000),
  CONSTRAINT deployment_breakers_threshold_order_check CHECK (failure_threshold <= min_samples),
  CONSTRAINT deployment_breakers_cooldown_check CHECK (cooldown_ms BETWEEN 0 AND 3600000),
  CONSTRAINT deployment_breakers_max_probes_check CHECK (max_probes BETWEEN 1 AND 8),
  CONSTRAINT deployment_breakers_state_check CHECK (state IN ('closed', 'open', 'half_open')),
  CONSTRAINT deployment_breakers_reason_check CHECK (
    state_reason IN (
      'disabled',
      'enabled',
      'reset',
      'failure_threshold',
      'cooldown_elapsed',
      'probe_succeeded',
      'probe_failed'
    )
  ),
  CONSTRAINT deployment_breakers_probes_check CHECK (probes_inflight >= 0 AND probes_inflight <= max_probes)
);

CREATE TABLE breaker_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  kind text NOT NULL,
  observed_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES deployment_breakers (tenant_id, deployment_id),
  CONSTRAINT breaker_observations_kind_check CHECK (kind IN ('success', 'failure', 'rate_limit'))
);

CREATE INDEX breaker_observations_window_idx
  ON breaker_observations (tenant_id, deployment_id, observed_at);

ALTER TABLE deployment_breakers ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_breakers FORCE ROW LEVEL SECURITY;
ALTER TABLE breaker_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE breaker_observations FORCE ROW LEVEL SECURITY;

CREATE POLICY deployment_breakers_isolation ON deployment_breakers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY breaker_observations_isolation ON breaker_observations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON deployment_breakers FROM PUBLIC;
REVOKE ALL ON breaker_observations FROM PUBLIC;
GRANT SELECT ON deployment_breakers TO llm_runtime;
GRANT UPDATE (
  state,
  state_reason,
  state_changed_at,
  cooldown_until,
  probes_inflight
) ON deployment_breakers TO llm_runtime;
GRANT SELECT, INSERT, DELETE ON breaker_observations TO llm_runtime;

CREATE FUNCTION set_deployment_breaker(
  p_tenant_id uuid,
  p_name text,
  p_enabled boolean,
  p_window_ms integer,
  p_min_samples integer,
  p_failure_threshold integer,
  p_cooldown_ms integer,
  p_max_probes integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deployment uuid;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_name = 'auto' THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'breaker flag is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  SELECT id INTO v_deployment
  FROM model_deployments
  WHERE tenant_id = p_tenant_id AND name = p_name;
  IF v_deployment IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  IF p_enabled = false THEN
    INSERT INTO deployment_breakers (
      tenant_id,
      deployment_id,
      enabled,
      window_ms,
      min_samples,
      failure_threshold,
      cooldown_ms,
      max_probes,
      state,
      state_reason,
      state_changed_at,
      cooldown_until,
      probes_inflight
    ) VALUES (
      p_tenant_id,
      v_deployment,
      false,
      60000,
      2,
      2,
      30000,
      1,
      'closed',
      'disabled',
      now(),
      NULL,
      0
    )
    ON CONFLICT (tenant_id, deployment_id) DO UPDATE
    SET enabled = false,
        state = 'closed',
        state_reason = 'disabled',
        state_changed_at = now(),
        cooldown_until = NULL,
        probes_inflight = 0;
  ELSE
    IF p_window_ms IS NULL OR p_window_ms NOT BETWEEN 100 AND 3600000 THEN
      RAISE EXCEPTION 'window is invalid';
    END IF;
    IF p_min_samples IS NULL OR p_min_samples NOT BETWEEN 1 AND 10000 THEN
      RAISE EXCEPTION 'sample size is invalid';
    END IF;
    IF p_failure_threshold IS NULL OR p_failure_threshold NOT BETWEEN 1 AND 10000 THEN
      RAISE EXCEPTION 'failure threshold is invalid';
    END IF;
    IF p_failure_threshold > p_min_samples THEN
      RAISE EXCEPTION 'failure threshold is invalid';
    END IF;
    IF p_cooldown_ms IS NULL OR p_cooldown_ms NOT BETWEEN 0 AND 3600000 THEN
      RAISE EXCEPTION 'cooldown is invalid';
    END IF;
    IF p_max_probes IS NULL OR p_max_probes NOT BETWEEN 1 AND 8 THEN
      RAISE EXCEPTION 'probe limit is invalid';
    END IF;
    INSERT INTO deployment_breakers (
      tenant_id,
      deployment_id,
      enabled,
      window_ms,
      min_samples,
      failure_threshold,
      cooldown_ms,
      max_probes,
      state,
      state_reason,
      state_changed_at,
      cooldown_until,
      probes_inflight
    ) VALUES (
      p_tenant_id,
      v_deployment,
      true,
      p_window_ms,
      p_min_samples,
      p_failure_threshold,
      p_cooldown_ms,
      p_max_probes,
      'closed',
      'enabled',
      now(),
      NULL,
      0
    )
    ON CONFLICT (tenant_id, deployment_id) DO UPDATE
    SET enabled = true,
        window_ms = EXCLUDED.window_ms,
        min_samples = EXCLUDED.min_samples,
        failure_threshold = EXCLUDED.failure_threshold,
        cooldown_ms = EXCLUDED.cooldown_ms,
        max_probes = EXCLUDED.max_probes,
        state = 'closed',
        state_reason = 'enabled',
        state_changed_at = now(),
        cooldown_until = NULL,
        probes_inflight = 0;
  END IF;
  DELETE FROM breaker_observations
  WHERE tenant_id = p_tenant_id AND deployment_id = v_deployment;
  RETURN v_deployment;
END;
$$;

CREATE FUNCTION reset_deployment_breaker(p_tenant_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deployment uuid;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_name = 'auto' THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  SELECT id INTO v_deployment
  FROM model_deployments
  WHERE tenant_id = p_tenant_id AND name = p_name;
  IF v_deployment IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  UPDATE deployment_breakers
  SET state = 'closed',
      state_reason = 'reset',
      state_changed_at = now(),
      cooldown_until = NULL,
      probes_inflight = 0
  WHERE tenant_id = p_tenant_id AND deployment_id = v_deployment;
  DELETE FROM breaker_observations
  WHERE tenant_id = p_tenant_id AND deployment_id = v_deployment;
  RETURN v_deployment;
END;
$$;

REVOKE ALL ON FUNCTION set_deployment_breaker(uuid, text, boolean, integer, integer, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_deployment_breaker(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_deployment_breaker(uuid, text, boolean, integer, integer, integer, integer, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION reset_deployment_breaker(uuid, text) TO llm_migrator;

RESET ROLE;
