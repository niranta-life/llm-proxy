-- Additive execution policies and attempt history.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 012.
-- Rollback keeps this file applied.
-- Image 2b644cc stays ready while 012_cost_accounting.sql remains applied.
-- Turning retries off stops the next request from making another attempt.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE execution_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  retries_enabled boolean NOT NULL,
  max_attempts integer NOT NULL,
  connection_deadline_ms integer NOT NULL,
  attempt_deadline_ms integer NOT NULL,
  total_deadline_ms integer NOT NULL,
  initial_backoff_ms integer NOT NULL,
  max_backoff_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT execution_policies_max_attempts_check CHECK (
    (retries_enabled = false AND max_attempts = 1)
    OR (retries_enabled = true AND max_attempts BETWEEN 1 AND 2)
  ),
  CONSTRAINT execution_policies_connection_deadline_check CHECK (connection_deadline_ms BETWEEN 100 AND 600000),
  CONSTRAINT execution_policies_attempt_deadline_check CHECK (attempt_deadline_ms BETWEEN 100 AND 600000),
  CONSTRAINT execution_policies_total_deadline_check CHECK (total_deadline_ms BETWEEN 100 AND 600000),
  CONSTRAINT execution_policies_initial_backoff_check CHECK (initial_backoff_ms BETWEEN 0 AND 600000),
  CONSTRAINT execution_policies_max_backoff_check CHECK (max_backoff_ms BETWEEN 0 AND 600000),
  CONSTRAINT execution_policies_backoff_order_check CHECK (initial_backoff_ms <= max_backoff_ms)
);

CREATE INDEX execution_policies_tenant_idx ON execution_policies (tenant_id, created_at);

ALTER TABLE execution_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY execution_policies_isolation ON execution_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON execution_policies FROM PUBLIC;
GRANT SELECT ON execution_policies TO llm_runtime;

ALTER TABLE model_deployments
  ADD COLUMN execution_policy_id uuid;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_execution_policy_fk
  FOREIGN KEY (tenant_id, execution_policy_id) REFERENCES execution_policies (tenant_id, id);

ALTER TABLE model_attempts
  ADD COLUMN attempt_ordinal integer NOT NULL DEFAULT 1;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_attempt_ordinal_check CHECK (attempt_ordinal BETWEEN 1 AND 2);

ALTER TABLE model_attempts
  ADD COLUMN failure_class text;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_failure_class_check CHECK (
    failure_class IS NULL OR failure_class IN (
      'cancelled',
      'stream_started',
      'total_deadline',
      'timeout_before_dispatch',
      'timeout_after_dispatch',
      'ambiguous_network',
      'client_error',
      'unauthorized',
      'connection_failure',
      'rate_limit',
      'unavailable',
      'upstream_error'
    )
  );

ALTER TABLE model_attempts
  ADD COLUMN dispatched boolean NOT NULL DEFAULT false;

ALTER TABLE model_attempts
  ADD COLUMN expense_certainty text;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_expense_certainty_check CHECK (
    expense_certainty IS NULL OR expense_certainty IN ('none', 'uncertain', 'known')
  );

ALTER TABLE model_attempts
  ADD COLUMN policy_id uuid;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_policy_fk
  FOREIGN KEY (tenant_id, policy_id) REFERENCES execution_policies (tenant_id, id);

ALTER TABLE model_attempts
  ADD COLUMN policy_version integer NOT NULL DEFAULT 1;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_policy_version_check CHECK (policy_version >= 1);

CREATE UNIQUE INDEX model_attempts_ordinal_idx
  ON model_attempts (tenant_id, request_id, attempt_ordinal);

GRANT UPDATE (failure_class, dispatched, expense_certainty) ON model_attempts TO llm_runtime;

ALTER TABLE attempt_costs
  ADD COLUMN expense_certainty text;

ALTER TABLE attempt_costs
  ADD CONSTRAINT attempt_costs_expense_certainty_check CHECK (
    expense_certainty IS NULL
    OR (
      expense_certainty IN ('none', 'uncertain', 'known')
      AND (expense_certainty <> 'uncertain' OR amount IS NULL)
      AND (expense_certainty <> 'none' OR amount IS NULL)
    )
  );

CREATE FUNCTION reject_execution_policy_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution policy is immutable';
END;
$$;

CREATE TRIGGER execution_policies_immutable
  BEFORE UPDATE OR DELETE ON execution_policies
  FOR EACH ROW
  EXECUTE FUNCTION reject_execution_policy_change();

CREATE FUNCTION set_deployment_execution_policy(
  p_tenant_id uuid,
  p_name text,
  p_retries_enabled boolean,
  p_connection_deadline_ms integer,
  p_attempt_deadline_ms integer,
  p_total_deadline_ms integer,
  p_initial_backoff_ms integer,
  p_max_backoff_ms integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_max integer;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_name = 'auto' THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
  END IF;
  IF p_retries_enabled IS NULL THEN
    RAISE EXCEPTION 'retries flag is invalid';
  END IF;
  IF p_connection_deadline_ms IS NULL OR p_connection_deadline_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'connection deadline is invalid';
  END IF;
  IF p_attempt_deadline_ms IS NULL OR p_attempt_deadline_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'attempt deadline is invalid';
  END IF;
  IF p_total_deadline_ms IS NULL OR p_total_deadline_ms NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'total deadline is invalid';
  END IF;
  IF p_initial_backoff_ms IS NULL OR p_initial_backoff_ms NOT BETWEEN 0 AND 600000 THEN
    RAISE EXCEPTION 'backoff is invalid';
  END IF;
  IF p_max_backoff_ms IS NULL OR p_max_backoff_ms NOT BETWEEN 0 AND 600000 THEN
    RAISE EXCEPTION 'backoff is invalid';
  END IF;
  IF p_initial_backoff_ms > p_max_backoff_ms THEN
    RAISE EXCEPTION 'backoff is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  v_max := CASE WHEN p_retries_enabled THEN 2 ELSE 1 END;
  INSERT INTO execution_policies (
    tenant_id,
    policy_version,
    retries_enabled,
    max_attempts,
    connection_deadline_ms,
    attempt_deadline_ms,
    total_deadline_ms,
    initial_backoff_ms,
    max_backoff_ms
  ) VALUES (
    p_tenant_id,
    1,
    p_retries_enabled,
    v_max,
    p_connection_deadline_ms,
    p_attempt_deadline_ms,
    p_total_deadline_ms,
    p_initial_backoff_ms,
    p_max_backoff_ms
  )
  RETURNING id INTO v_id;
  UPDATE model_deployments
  SET execution_policy_id = v_id
  WHERE tenant_id = p_tenant_id
    AND name = p_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION reject_execution_policy_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_execution_policy(uuid, text, boolean, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_deployment_execution_policy(uuid, text, boolean, integer, integer, integer, integer, integer) TO llm_migrator;

RESET ROLE;
