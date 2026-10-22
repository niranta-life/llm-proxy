-- Additive tenant limits, concurrency leases, monthly budgets, and a cost ledger.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 014.
-- Rollback keeps this file applied.
-- Image 8335555 stays ready while 014_provider_breaker.sql remains applied.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE tenant_limit_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  mode text NOT NULL,
  requests_per_minute integer,
  concurrent_requests integer,
  concurrent_streams integer,
  token_rate_per_minute bigint,
  lease_ms integer NOT NULL DEFAULT 120000,
  CONSTRAINT tenant_limit_policies_mode_check CHECK (mode IN ('observe', 'hard')),
  CONSTRAINT tenant_limit_policies_rpm_check CHECK (
    requests_per_minute IS NULL OR requests_per_minute BETWEEN 1 AND 1000000
  ),
  CONSTRAINT tenant_limit_policies_requests_check CHECK (
    concurrent_requests IS NULL OR concurrent_requests BETWEEN 1 AND 100000
  ),
  CONSTRAINT tenant_limit_policies_streams_check CHECK (
    concurrent_streams IS NULL OR concurrent_streams BETWEEN 1 AND 100000
  ),
  CONSTRAINT tenant_limit_policies_tokens_check CHECK (
    token_rate_per_minute IS NULL OR token_rate_per_minute BETWEEN 1 AND 1000000000
  ),
  CONSTRAINT tenant_limit_policies_lease_check CHECK (lease_ms BETWEEN 100 AND 600000)
);

CREATE TABLE api_key_limit_policies (
  tenant_id uuid NOT NULL,
  api_key_id uuid NOT NULL PRIMARY KEY,
  mode text,
  requests_per_minute integer,
  concurrent_requests integer,
  concurrent_streams integer,
  token_rate_per_minute bigint,
  CONSTRAINT api_key_limit_policies_key_fk FOREIGN KEY (api_key_id) REFERENCES tenant_api_keys (id),
  CONSTRAINT api_key_limit_policies_mode_check CHECK (mode IS NULL OR mode IN ('observe', 'hard')),
  CONSTRAINT api_key_limit_policies_rpm_check CHECK (
    requests_per_minute IS NULL OR requests_per_minute BETWEEN 1 AND 1000000
  ),
  CONSTRAINT api_key_limit_policies_requests_check CHECK (
    concurrent_requests IS NULL OR concurrent_requests BETWEEN 1 AND 100000
  ),
  CONSTRAINT api_key_limit_policies_streams_check CHECK (
    concurrent_streams IS NULL OR concurrent_streams BETWEEN 1 AND 100000
  ),
  CONSTRAINT api_key_limit_policies_tokens_check CHECK (
    token_rate_per_minute IS NULL OR token_rate_per_minute BETWEEN 1 AND 1000000000
  )
);

CREATE TABLE connection_limit_policies (
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  mode text NOT NULL,
  max_concurrency integer NOT NULL,
  share_group text,
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES provider_connections (tenant_id, id),
  CONSTRAINT connection_limit_policies_mode_check CHECK (mode IN ('observe', 'hard')),
  CONSTRAINT connection_limit_policies_max_check CHECK (max_concurrency BETWEEN 1 AND 100000),
  CONSTRAINT connection_limit_policies_group_check CHECK (
    share_group IS NULL OR share_group ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  )
);

CREATE TABLE deployment_limit_policies (
  tenant_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  mode text NOT NULL,
  max_concurrency integer NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES model_deployments (tenant_id, id),
  CONSTRAINT deployment_limit_policies_mode_check CHECK (mode IN ('observe', 'hard')),
  CONSTRAINT deployment_limit_policies_max_check CHECK (max_concurrency BETWEEN 1 AND 100000)
);

CREATE TABLE connection_share_groups (
  name text PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  CONSTRAINT connection_share_groups_name_check CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE TABLE limit_counters (
  tenant_id uuid NOT NULL,
  scope text NOT NULL,
  scope_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  amount bigint NOT NULL,
  PRIMARY KEY (tenant_id, scope, scope_id, window_start),
  CONSTRAINT limit_counters_scope_check CHECK (
    scope IN ('tenant_requests', 'api_key_requests', 'tenant_tokens', 'api_key_tokens')
  ),
  CONSTRAINT limit_counters_amount_check CHECK (amount >= 0)
);

CREATE TABLE concurrency_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scope text NOT NULL,
  scope_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT concurrency_leases_scope_check CHECK (
    scope IN (
      'tenant_request',
      'tenant_stream',
      'api_key_request',
      'api_key_stream',
      'connection',
      'connection_group',
      'deployment'
    )
  ),
  CONSTRAINT concurrency_leases_attempt_scope_unique UNIQUE (attempt_id, scope)
);

CREATE INDEX concurrency_leases_active_idx
  ON concurrency_leases (scope, scope_id)
  WHERE released_at IS NULL;

CREATE TABLE attempt_admissions (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  token_bound bigint,
  tokens_noted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES model_attempts (tenant_id, id),
  CONSTRAINT attempt_admissions_bound_check CHECK (token_bound IS NULL OR token_bound >= 0)
);

CREATE TABLE tenant_budgets (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  mode text NOT NULL,
  currency text NOT NULL,
  monthly_amount numeric(38, 12) NOT NULL,
  CONSTRAINT tenant_budgets_mode_check CHECK (mode IN ('observe', 'hard', 'disabled')),
  CONSTRAINT tenant_budgets_currency_check CHECK (currency = 'USD'),
  CONSTRAINT tenant_budgets_amount_check CHECK (monthly_amount >= 0)
);

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  period_start date NOT NULL,
  price_version_id uuid,
  reserved_amount numeric(38, 12),
  status text NOT NULL,
  cost_status text NOT NULL,
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES model_attempts (tenant_id, id),
  FOREIGN KEY (price_version_id) REFERENCES price_versions (id),
  CONSTRAINT budget_reservations_status_check CHECK (status IN ('active', 'settled', 'provisional', 'released')),
  CONSTRAINT budget_reservations_cost_check CHECK (cost_status IN ('estimated', 'provisional', 'unknown', 'none')),
  CONSTRAINT budget_reservations_amount_check CHECK (
    (cost_status = 'unknown' AND reserved_amount IS NULL)
    OR (cost_status <> 'unknown' AND reserved_amount IS NOT NULL AND reserved_amount >= 0)
  )
);

CREATE INDEX budget_reservations_period_idx
  ON budget_reservations (tenant_id, period_start, status);

CREATE TABLE cost_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  reservation_id uuid NOT NULL REFERENCES budget_reservations (id),
  period_start date NOT NULL,
  entry_type text NOT NULL,
  amount numeric(38, 12),
  created_at timestamptz NOT NULL,
  UNIQUE (reservation_id, entry_type),
  CONSTRAINT cost_ledger_entry_check CHECK (entry_type IN ('reserve', 'settle', 'release', 'provisional')),
  CONSTRAINT cost_ledger_amount_check CHECK (
    (entry_type = 'provisional' AND (amount IS NULL OR amount >= 0))
    OR (entry_type <> 'provisional' AND amount IS NOT NULL AND amount >= 0)
  )
);

CREATE INDEX cost_ledger_period_idx
  ON cost_ledger (tenant_id, period_start, entry_type);

ALTER TABLE tenant_limit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_limit_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE api_key_limit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_limit_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE connection_limit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_limit_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE deployment_limit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_limit_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE limit_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE concurrency_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE concurrency_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE attempt_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_admissions FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_limit_policies_isolation ON tenant_limit_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY api_key_limit_policies_isolation ON api_key_limit_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY connection_limit_policies_isolation ON connection_limit_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY deployment_limit_policies_isolation ON deployment_limit_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY limit_counters_isolation ON limit_counters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY concurrency_leases_isolation ON concurrency_leases
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY attempt_admissions_isolation ON attempt_admissions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_budgets_isolation ON tenant_budgets
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY budget_reservations_isolation ON budget_reservations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cost_ledger_isolation ON cost_ledger
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON tenant_limit_policies FROM PUBLIC;
REVOKE ALL ON api_key_limit_policies FROM PUBLIC;
REVOKE ALL ON connection_limit_policies FROM PUBLIC;
REVOKE ALL ON deployment_limit_policies FROM PUBLIC;
REVOKE ALL ON connection_share_groups FROM PUBLIC;
REVOKE ALL ON limit_counters FROM PUBLIC;
REVOKE ALL ON concurrency_leases FROM PUBLIC;
REVOKE ALL ON attempt_admissions FROM PUBLIC;
REVOKE ALL ON tenant_budgets FROM PUBLIC;
REVOKE ALL ON budget_reservations FROM PUBLIC;
REVOKE ALL ON cost_ledger FROM PUBLIC;

GRANT SELECT ON tenant_limit_policies TO llm_runtime;
GRANT SELECT ON api_key_limit_policies TO llm_runtime;
GRANT SELECT ON connection_limit_policies TO llm_runtime;
GRANT SELECT ON deployment_limit_policies TO llm_runtime;
GRANT SELECT ON connection_share_groups TO llm_runtime;
GRANT SELECT ON limit_counters TO llm_runtime;
GRANT SELECT ON concurrency_leases TO llm_runtime;
GRANT SELECT ON attempt_admissions TO llm_runtime;
GRANT SELECT ON tenant_budgets TO llm_runtime;
GRANT SELECT ON budget_reservations TO llm_runtime;
GRANT SELECT ON cost_ledger TO llm_runtime;

CREATE FUNCTION assert_caller_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;
END;
$$;

CREATE FUNCTION active_lease_count(p_scope text, p_scope_id uuid, p_now timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)
  FROM concurrency_leases
  WHERE scope = p_scope
    AND scope_id = p_scope_id
    AND released_at IS NULL
    AND expires_at > p_now;
$$;

CREATE FUNCTION counter_amount(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_window timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT amount
      FROM limit_counters
      WHERE tenant_id = p_tenant_id
        AND scope = p_scope
        AND scope_id = p_scope_id
        AND window_start = p_window
    ),
    0
  );
$$;

CREATE FUNCTION add_counter(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_window timestamptz,
  p_delta bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_delta = 0 THEN
    RETURN;
  END IF;
  IF p_delta < 0 THEN
    UPDATE limit_counters
    SET amount = GREATEST(0, amount + p_delta)
    WHERE tenant_id = p_tenant_id
      AND scope = p_scope
      AND scope_id = p_scope_id
      AND window_start = p_window;
    RETURN;
  END IF;
  INSERT INTO limit_counters (tenant_id, scope, scope_id, window_start, amount)
  VALUES (p_tenant_id, p_scope, p_scope_id, p_window, p_delta)
  ON CONFLICT (tenant_id, scope, scope_id, window_start)
  DO UPDATE SET amount = limit_counters.amount + p_delta;
END;
$$;

CREATE FUNCTION admit_attempt(
  p_tenant_id uuid,
  p_api_key_id uuid,
  p_connection_id uuid,
  p_deployment_id uuid,
  p_attempt_id uuid,
  p_stream boolean,
  p_now timestamptz,
  p_window timestamptz,
  p_period_start date,
  p_token_bound bigint,
  p_estimate numeric,
  p_estimate_kind text,
  p_price_version_id uuid
)
RETURNS TABLE (
  decision text,
  reason text,
  reservation_id uuid,
  reserved_amount numeric,
  cost_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant tenant_limit_policies%ROWTYPE;
  v_key api_key_limit_policies%ROWTYPE;
  v_conn connection_limit_policies%ROWTYPE;
  v_dep deployment_limit_policies%ROWTYPE;
  v_budget tenant_budgets%ROWTYPE;
  v_key_mode text;
  v_group uuid;
  v_group_limit integer;
  v_held bigint;
  v_expires timestamptz;
  v_recognized numeric(38, 12);
  v_active numeric(38, 12);
  v_raw numeric(38, 12);
  v_reservation uuid;
  v_amount numeric(38, 12);
  v_has_tenant boolean := false;
  v_has_key boolean := false;
  v_has_conn boolean := false;
  v_has_dep boolean := false;
  v_has_budget boolean := false;
  v_tenant_mode text;
  v_lease integer := 120000;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  IF p_estimate_kind NOT IN ('bounded', 'unbounded', 'unknown') THEN
    RAISE EXCEPTION 'estimate kind is invalid';
  END IF;
  IF p_estimate_kind = 'bounded' AND p_estimate IS NULL THEN
    RAISE EXCEPTION 'estimate is missing';
  END IF;
  IF p_estimate_kind <> 'bounded' AND p_estimate IS NOT NULL THEN
    RAISE EXCEPTION 'estimate is not bounded';
  END IF;
  IF p_token_bound IS NOT NULL AND p_token_bound < 0 THEN
    RAISE EXCEPTION 'token bound is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_attempts WHERE tenant_id = p_tenant_id AND id = p_attempt_id
  ) THEN
    RAISE EXCEPTION 'attempt is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_api_keys WHERE tenant_id = p_tenant_id AND id = p_api_key_id
  ) THEN
    RAISE EXCEPTION 'api key is missing';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('admit:' || p_tenant_id::text, 0));

  SELECT * INTO v_tenant FROM tenant_limit_policies WHERE tenant_id = p_tenant_id;
  v_has_tenant := FOUND;
  SELECT * INTO v_key FROM api_key_limit_policies WHERE tenant_id = p_tenant_id AND api_key_id = p_api_key_id;
  v_has_key := FOUND;
  SELECT * INTO v_conn FROM connection_limit_policies WHERE tenant_id = p_tenant_id AND connection_id = p_connection_id;
  v_has_conn := FOUND;
  SELECT * INTO v_dep FROM deployment_limit_policies WHERE tenant_id = p_tenant_id AND deployment_id = p_deployment_id;
  v_has_dep := FOUND;
  SELECT * INTO v_budget FROM tenant_budgets WHERE tenant_id = p_tenant_id FOR UPDATE;
  v_has_budget := FOUND;
  v_tenant_mode := CASE WHEN v_has_tenant THEN v_tenant.mode ELSE NULL END;
  v_key_mode := CASE
    WHEN v_has_key AND v_key.mode IS NOT NULL THEN v_key.mode
    ELSE v_tenant_mode
  END;
  IF v_has_tenant THEN
    v_lease := v_tenant.lease_ms;
  END IF;
  v_expires := p_now + (v_lease * interval '1 millisecond');

  IF v_has_conn AND v_conn.share_group IS NOT NULL THEN
    INSERT INTO connection_share_groups (name) VALUES (v_conn.share_group)
    ON CONFLICT (name) DO NOTHING;
    SELECT id INTO v_group FROM connection_share_groups WHERE name = v_conn.share_group;
    PERFORM pg_advisory_xact_lock(hashtextextended('group:' || v_group::text, 0));
    SELECT MIN(max_concurrency) INTO v_group_limit
    FROM connection_limit_policies
    WHERE share_group = v_conn.share_group AND mode = 'hard';
  END IF;

  UPDATE concurrency_leases
  SET released_at = p_now
  WHERE released_at IS NULL
    AND expires_at <= p_now
    AND (
      (scope = 'tenant_request' AND scope_id = p_tenant_id)
      OR (scope = 'tenant_stream' AND scope_id = p_tenant_id)
      OR (scope = 'api_key_request' AND scope_id = p_api_key_id)
      OR (scope = 'api_key_stream' AND scope_id = p_api_key_id)
      OR (scope = 'connection' AND scope_id = p_connection_id)
      OR (scope = 'deployment' AND scope_id = p_deployment_id)
      OR (v_group IS NOT NULL AND scope = 'connection_group' AND scope_id = v_group)
    );

  IF v_has_key AND v_key.requests_per_minute IS NOT NULL AND v_key_mode = 'hard'
    AND counter_amount(p_tenant_id, 'api_key_requests', p_api_key_id, p_window) + 1 > v_key.requests_per_minute THEN
    RETURN QUERY SELECT 'reject'::text, 'api_key_rate_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_has_tenant AND v_tenant.requests_per_minute IS NOT NULL AND v_tenant_mode = 'hard'
    AND counter_amount(p_tenant_id, 'tenant_requests', p_tenant_id, p_window) + 1 > v_tenant.requests_per_minute THEN
    RETURN QUERY SELECT 'reject'::text, 'tenant_rate_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_has_key AND v_key.concurrent_requests IS NOT NULL AND v_key_mode = 'hard'
    AND active_lease_count('api_key_request', p_api_key_id, p_now) >= v_key.concurrent_requests THEN
    RETURN QUERY SELECT 'reject'::text, 'api_key_concurrency_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_has_tenant AND v_tenant.concurrent_requests IS NOT NULL AND v_tenant_mode = 'hard'
    AND active_lease_count('tenant_request', p_tenant_id, p_now) >= v_tenant.concurrent_requests THEN
    RETURN QUERY SELECT 'reject'::text, 'concurrency_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF p_stream AND v_has_key AND v_key.concurrent_streams IS NOT NULL AND v_key_mode = 'hard'
    AND active_lease_count('api_key_stream', p_api_key_id, p_now) >= v_key.concurrent_streams THEN
    RETURN QUERY SELECT 'reject'::text, 'api_key_stream_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF p_stream AND v_has_tenant AND v_tenant.concurrent_streams IS NOT NULL AND v_tenant_mode = 'hard'
    AND active_lease_count('tenant_stream', p_tenant_id, p_now) >= v_tenant.concurrent_streams THEN
    RETURN QUERY SELECT 'reject'::text, 'stream_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_group IS NOT NULL AND v_has_conn AND v_conn.mode = 'hard' AND v_group_limit IS NOT NULL
    AND active_lease_count('connection_group', v_group, p_now) >= v_group_limit THEN
    RETURN QUERY SELECT 'reject'::text, 'connection_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_group IS NULL AND v_has_conn AND v_conn.mode = 'hard'
    AND active_lease_count('connection', p_connection_id, p_now) >= v_conn.max_concurrency THEN
    RETURN QUERY SELECT 'reject'::text, 'connection_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_has_dep AND v_dep.mode = 'hard'
    AND active_lease_count('deployment', p_deployment_id, p_now) >= v_dep.max_concurrency THEN
    RETURN QUERY SELECT 'reject'::text, 'deployment_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF p_token_bound IS NOT NULL AND v_has_key AND v_key.token_rate_per_minute IS NOT NULL AND v_key_mode = 'hard'
    AND counter_amount(p_tenant_id, 'api_key_tokens', p_api_key_id, p_window) + p_token_bound > v_key.token_rate_per_minute THEN
    RETURN QUERY SELECT 'reject'::text, 'api_key_token_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF p_token_bound IS NOT NULL AND v_has_tenant AND v_tenant.token_rate_per_minute IS NOT NULL AND v_tenant_mode = 'hard'
    AND counter_amount(p_tenant_id, 'tenant_tokens', p_tenant_id, p_window) + p_token_bound > v_tenant.token_rate_per_minute THEN
    RETURN QUERY SELECT 'reject'::text, 'token_rate_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;

  IF v_has_budget AND v_budget.mode = 'hard' AND p_estimate_kind = 'unknown' THEN
    RETURN QUERY SELECT 'reject'::text, 'budget_unknown'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_has_budget AND v_budget.mode = 'hard' AND p_estimate_kind = 'unbounded' THEN
    RETURN QUERY SELECT 'reject'::text, 'budget_unbounded'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF v_has_budget AND v_budget.mode IN ('hard', 'observe') AND p_estimate_kind = 'bounded' THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_recognized
    FROM cost_ledger
    WHERE tenant_id = p_tenant_id AND period_start = p_period_start AND entry_type = 'settle';
    SELECT COALESCE(SUM(budget_reservations.reserved_amount), 0) INTO v_active
    FROM budget_reservations
    WHERE budget_reservations.tenant_id = p_tenant_id
      AND budget_reservations.period_start = p_period_start
      AND budget_reservations.status IN ('active', 'provisional')
      AND budget_reservations.reserved_amount IS NOT NULL;
    v_raw := v_budget.monthly_amount - v_recognized - v_active;
    IF v_budget.mode = 'hard' AND v_raw < p_estimate THEN
      RETURN QUERY SELECT 'reject'::text, 'budget_exceeded'::text, NULL::uuid, NULL::numeric, NULL::text;
      RETURN;
    END IF;
  END IF;

  IF v_has_key AND v_key.requests_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'api_key_requests', p_api_key_id, p_window, 1);
  END IF;
  IF v_has_tenant AND v_tenant.requests_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'tenant_requests', p_tenant_id, p_window, 1);
  END IF;
  IF p_token_bound IS NOT NULL AND v_has_key AND v_key.token_rate_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'api_key_tokens', p_api_key_id, p_window, p_token_bound);
  END IF;
  IF p_token_bound IS NOT NULL AND v_has_tenant AND v_tenant.token_rate_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'tenant_tokens', p_tenant_id, p_window, p_token_bound);
  END IF;

  IF v_has_key AND v_key.concurrent_requests IS NOT NULL THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'api_key_request', p_api_key_id, p_attempt_id, v_expires);
  END IF;
  IF v_has_tenant AND v_tenant.concurrent_requests IS NOT NULL THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'tenant_request', p_tenant_id, p_attempt_id, v_expires);
  END IF;
  IF p_stream AND v_has_key AND v_key.concurrent_streams IS NOT NULL THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'api_key_stream', p_api_key_id, p_attempt_id, v_expires);
  END IF;
  IF p_stream AND v_has_tenant AND v_tenant.concurrent_streams IS NOT NULL THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'tenant_stream', p_tenant_id, p_attempt_id, v_expires);
  END IF;
  IF v_group IS NOT NULL THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'connection_group', v_group, p_attempt_id, v_expires);
  ELSIF v_has_conn THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'connection', p_connection_id, p_attempt_id, v_expires);
  END IF;
  IF v_has_dep THEN
    INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
    VALUES (p_tenant_id, 'deployment', p_deployment_id, p_attempt_id, v_expires);
  END IF;

  INSERT INTO attempt_admissions (tenant_id, attempt_id, api_key_id, window_start, token_bound)
  VALUES (
    p_tenant_id,
    p_attempt_id,
    p_api_key_id,
    p_window,
    CASE
      WHEN p_token_bound IS NOT NULL AND (
        (v_has_tenant AND v_tenant.token_rate_per_minute IS NOT NULL)
        OR (v_has_key AND v_key.token_rate_per_minute IS NOT NULL)
      )
      THEN p_token_bound
      ELSE NULL
    END
  );

  IF v_has_budget AND v_budget.mode IN ('observe', 'hard') AND p_estimate_kind = 'bounded' THEN
    -- Observe keeps the full estimate. Hard mode already returned when it does not fit.
    -- A later close recognizes only the part that fits and leaves the known excess provisional.
    -- That room is other settled amounts only. A sibling reservation does not reduce it.
    v_amount := round(p_estimate, 12);
    INSERT INTO budget_reservations (
      tenant_id, attempt_id, period_start, price_version_id, reserved_amount, status, cost_status, created_at
    ) VALUES (
      p_tenant_id, p_attempt_id, p_period_start, p_price_version_id, v_amount, 'active', 'estimated', p_now
    )
    RETURNING id INTO v_reservation;
    INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
    VALUES (p_tenant_id, p_attempt_id, v_reservation, p_period_start, 'reserve', v_amount, p_now);
    RETURN QUERY SELECT 'allow'::text, 'allowed'::text, v_reservation, v_amount, 'estimated'::text;
    RETURN;
  END IF;

  IF v_has_budget AND v_budget.mode = 'observe' AND p_estimate_kind <> 'bounded' THEN
    INSERT INTO budget_reservations (
      tenant_id, attempt_id, period_start, price_version_id, reserved_amount, status, cost_status, created_at
    ) VALUES (
      p_tenant_id, p_attempt_id, p_period_start, NULL, NULL, 'provisional', 'unknown', p_now
    )
    RETURNING id INTO v_reservation;
    INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
    VALUES (p_tenant_id, p_attempt_id, v_reservation, p_period_start, 'provisional', NULL, p_now);
    RETURN QUERY SELECT 'allow'::text, 'allowed'::text, v_reservation, NULL::numeric, 'unknown'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'allow'::text, 'allowed'::text, NULL::uuid, NULL::numeric, NULL::text;
END;
$$;

CREATE FUNCTION split_known_charge(
  p_mode text,
  p_allocation numeric,
  p_recognized_already numeric,
  p_reserved numeric,
  p_known numeric
) RETURNS TABLE (recognized numeric, provisional numeric, released numeric)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_capped numeric;
  v_room numeric;
  v_fit numeric;
BEGIN
  IF p_known IS NULL THEN
    RAISE EXCEPTION 'known charge is missing';
  END IF;
  IF p_mode IS DISTINCT FROM 'hard' AND p_mode IS DISTINCT FROM 'observe' THEN
    RAISE EXCEPTION 'budget mode is missing';
  END IF;
  IF p_mode = 'hard' THEN
    IF p_reserved IS NULL THEN
      RAISE EXCEPTION 'reserved charge is missing';
    END IF;
    v_capped := least(round(p_known, 12), round(p_reserved, 12));
    recognized := v_capped;
    provisional := 0;
    released := round(p_reserved, 12) - v_capped;
    RETURN NEXT;
    RETURN;
  END IF;
  -- Room is the allocation minus settled expense already recognized.
  -- A sibling reservation is not an input.
  v_room := greatest(0, round(COALESCE(p_allocation, 0), 12) - round(COALESCE(p_recognized_already, 0), 12));
  IF p_reserved IS NULL THEN
    v_capped := round(p_known, 12);
    released := 0;
  ELSE
    v_capped := least(round(p_known, 12), round(p_reserved, 12));
    released := round(p_reserved, 12) - v_capped;
  END IF;
  v_fit := least(v_capped, v_room);
  recognized := v_fit;
  provisional := v_capped - v_fit;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION close_attempt_admission(p_tenant_id uuid, p_attempt_id uuid, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt model_attempts%ROWTYPE;
  v_cost attempt_costs%ROWTYPE;
  v_reservation budget_reservations%ROWTYPE;
  v_admission attempt_admissions%ROWTYPE;
  v_actual bigint;
  v_delta bigint;
  v_release numeric(38, 12);
  v_mode text;
  v_monthly numeric(38, 12);
  v_fit numeric(38, 12);
  v_over numeric(38, 12);
  v_held numeric(38, 12);
  v_has_cost boolean := false;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  SELECT * INTO v_attempt FROM model_attempts WHERE tenant_id = p_tenant_id AND id = p_attempt_id;
  IF NOT FOUND OR v_attempt.status = 'pending' THEN
    RETURN 'pending';
  END IF;

  SELECT * INTO v_admission
  FROM attempt_admissions
  WHERE tenant_id = p_tenant_id AND attempt_id = p_attempt_id
  FOR UPDATE;
  IF FOUND AND v_admission.tokens_noted = false THEN
    v_actual := NULL;
    IF v_attempt.total_tokens IS NOT NULL THEN
      v_actual := v_attempt.total_tokens;
    ELSIF v_attempt.prompt_tokens IS NOT NULL AND v_attempt.completion_tokens IS NOT NULL THEN
      v_actual := v_attempt.prompt_tokens + v_attempt.completion_tokens;
    END IF;
    IF v_admission.token_bound IS NOT NULL AND v_actual IS NOT NULL THEN
      v_delta := v_actual - v_admission.token_bound;
      PERFORM add_counter(p_tenant_id, 'tenant_tokens', p_tenant_id, v_admission.window_start, v_delta);
      PERFORM add_counter(p_tenant_id, 'api_key_tokens', v_admission.api_key_id, v_admission.window_start, v_delta);
    ELSIF v_admission.token_bound IS NULL AND v_actual IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM tenant_limit_policies
        WHERE tenant_id = p_tenant_id AND token_rate_per_minute IS NOT NULL
      ) THEN
        PERFORM add_counter(p_tenant_id, 'tenant_tokens', p_tenant_id, v_admission.window_start, v_actual);
      END IF;
      IF EXISTS (
        SELECT 1 FROM api_key_limit_policies
        WHERE tenant_id = p_tenant_id AND api_key_id = v_admission.api_key_id AND token_rate_per_minute IS NOT NULL
      ) THEN
        PERFORM add_counter(p_tenant_id, 'api_key_tokens', v_admission.api_key_id, v_admission.window_start, v_actual);
      END IF;
    END IF;
    UPDATE attempt_admissions
    SET tokens_noted = true
    WHERE tenant_id = p_tenant_id AND attempt_id = p_attempt_id;
  END IF;

  UPDATE concurrency_leases
  SET released_at = p_now
  WHERE tenant_id = p_tenant_id AND attempt_id = p_attempt_id AND released_at IS NULL;

  SELECT * INTO v_reservation
  FROM budget_reservations
  WHERE tenant_id = p_tenant_id AND attempt_id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'closed';
  END IF;
  IF v_reservation.status IN ('settled', 'released') THEN
    RETURN v_reservation.status;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('admit:' || p_tenant_id::text, 0));
  SELECT mode, monthly_amount INTO v_mode, v_monthly
  FROM tenant_budgets
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM cost_ledger WHERE reservation_id = v_reservation.id AND entry_type = 'settle'
  ) THEN
    RETURN v_reservation.status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM cost_ledger
    WHERE reservation_id = v_reservation.id
      AND entry_type = 'provisional'
      AND amount IS NOT NULL
  ) THEN
    RETURN v_reservation.status;
  END IF;

  SELECT * INTO v_cost FROM attempt_costs WHERE tenant_id = p_tenant_id AND attempt_id = p_attempt_id;
  v_has_cost := FOUND;

  IF v_attempt.expense_certainty = 'none'
    OR (v_attempt.dispatched = false AND v_attempt.expense_certainty IS DISTINCT FROM 'uncertain') THEN
    IF v_reservation.reserved_amount IS NOT NULL THEN
      INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
      VALUES (
        p_tenant_id, p_attempt_id, v_reservation.id, v_reservation.period_start, 'release', v_reservation.reserved_amount, p_now
      )
      ON CONFLICT (reservation_id, entry_type) DO NOTHING;
    END IF;
    UPDATE budget_reservations
    SET status = 'released',
        cost_status = CASE WHEN budget_reservations.reserved_amount IS NULL THEN 'unknown' ELSE 'none' END,
        settled_at = p_now
    WHERE id = v_reservation.id AND status IN ('active', 'provisional');
    RETURN 'released';
  END IF;

  IF v_has_cost
    AND v_attempt.expense_certainty = 'known'
    AND v_cost.cost_status = 'estimated'
    AND v_cost.amount IS NOT NULL
    AND v_mode IS DISTINCT FROM 'observe'
    AND v_reservation.reserved_amount IS NOT NULL THEN
    SELECT charge.recognized, charge.released
    INTO v_fit, v_release
    FROM split_known_charge('hard', v_monthly, 0, v_reservation.reserved_amount, v_cost.amount) AS charge;
    INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
    VALUES (p_tenant_id, p_attempt_id, v_reservation.id, v_reservation.period_start, 'settle', v_fit, p_now)
    ON CONFLICT (reservation_id, entry_type) DO NOTHING;
    INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
    VALUES (p_tenant_id, p_attempt_id, v_reservation.id, v_reservation.period_start, 'release', v_release, p_now)
    ON CONFLICT (reservation_id, entry_type) DO NOTHING;
    UPDATE budget_reservations
    SET status = 'settled', cost_status = 'estimated', settled_at = p_now
    WHERE id = v_reservation.id AND status IN ('active', 'provisional');
    RETURN 'settled';
  END IF;

  IF v_has_cost
    AND v_attempt.expense_certainty = 'known'
    AND v_cost.cost_status = 'estimated'
    AND v_cost.amount IS NOT NULL
    AND v_mode = 'observe' THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_held
    FROM cost_ledger
    WHERE tenant_id = p_tenant_id
      AND period_start = v_reservation.period_start
      AND entry_type = 'settle'
      AND reservation_id <> v_reservation.id;
    SELECT charge.recognized, charge.provisional, charge.released
    INTO v_fit, v_over, v_release
    FROM split_known_charge(
      'observe',
      v_monthly,
      v_held,
      v_reservation.reserved_amount,
      v_cost.amount
    ) AS charge;
    IF v_fit > 0 THEN
      INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
      VALUES (p_tenant_id, p_attempt_id, v_reservation.id, v_reservation.period_start, 'settle', v_fit, p_now)
      ON CONFLICT (reservation_id, entry_type) DO NOTHING;
    END IF;
    IF v_over > 0 THEN
      INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
      VALUES (p_tenant_id, p_attempt_id, v_reservation.id, v_reservation.period_start, 'provisional', v_over, p_now)
      ON CONFLICT (reservation_id, entry_type) DO UPDATE SET amount = EXCLUDED.amount;
    ELSIF EXISTS (
      SELECT 1 FROM cost_ledger
      WHERE reservation_id = v_reservation.id AND entry_type = 'provisional' AND amount IS NULL
    ) THEN
      UPDATE cost_ledger
      SET amount = 0
      WHERE reservation_id = v_reservation.id AND entry_type = 'provisional' AND amount IS NULL;
    END IF;
    IF v_reservation.reserved_amount IS NOT NULL THEN
      INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
      VALUES (p_tenant_id, p_attempt_id, v_reservation.id, v_reservation.period_start, 'release', v_release, p_now)
      ON CONFLICT (reservation_id, entry_type) DO NOTHING;
    END IF;
    IF v_over > 0 THEN
      UPDATE budget_reservations
      SET status = 'provisional',
          cost_status = 'provisional',
          reserved_amount = v_over,
          settled_at = p_now
      WHERE id = v_reservation.id AND status IN ('active', 'provisional');
      RETURN 'provisional';
    END IF;
    UPDATE budget_reservations
    SET status = 'settled',
        cost_status = 'estimated',
        reserved_amount = COALESCE(v_reservation.reserved_amount, v_fit),
        settled_at = p_now
    WHERE id = v_reservation.id AND status IN ('active', 'provisional');
    RETURN 'settled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM cost_ledger WHERE reservation_id = v_reservation.id AND entry_type = 'provisional'
  ) THEN
    RETURN 'provisional';
  END IF;

  INSERT INTO cost_ledger (tenant_id, attempt_id, reservation_id, period_start, entry_type, amount, created_at)
  VALUES (
    p_tenant_id,
    p_attempt_id,
    v_reservation.id,
    v_reservation.period_start,
    'provisional',
    v_reservation.reserved_amount,
    p_now
  )
  ON CONFLICT (reservation_id, entry_type) DO NOTHING;
  UPDATE budget_reservations
  SET status = 'provisional',
      cost_status = CASE
        WHEN v_reservation.reserved_amount IS NULL THEN 'unknown'
        ELSE 'provisional'
      END,
      settled_at = p_now
  WHERE id = v_reservation.id AND status = 'active';
  RETURN 'provisional';
END;
$$;

CREATE FUNCTION recover_tenant_budget(p_tenant_id uuid, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt uuid;
  v_count integer := 0;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  FOR v_attempt IN
    SELECT r.attempt_id
    FROM budget_reservations r
    JOIN model_attempts a ON a.tenant_id = r.tenant_id AND a.id = r.attempt_id
    WHERE r.tenant_id = p_tenant_id
      AND r.status = 'active'
      AND a.status <> 'pending'
  LOOP
    PERFORM close_attempt_admission(p_tenant_id, v_attempt, p_now);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE FUNCTION read_tenant_capacity(p_tenant_id uuid, p_now timestamptz, p_window timestamptz, p_period_start date)
RETURNS TABLE (
  requests_in_window bigint,
  tokens_in_window bigint,
  concurrent_requests bigint,
  concurrent_streams bigint,
  reserved_concurrency bigint,
  allocated numeric,
  recognized numeric,
  active_reservations numeric,
  provisional numeric,
  available numeric,
  unknown_charges bigint,
  budget_mode text,
  limit_mode text,
  currency text,
  cost_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_budget tenant_budgets%ROWTYPE;
  v_limit tenant_limit_policies%ROWTYPE;
  v_recognized numeric(38, 12);
  v_active numeric(38, 12);
  v_provisional numeric(38, 12);
  v_unknown bigint;
  v_available numeric(38, 12);
  v_cost text;
  v_has_budget boolean := false;
  v_has_limit boolean := false;
  v_allocated numeric(38, 12);
  v_budget_mode text;
  v_limit_mode text;
  v_currency text;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  SELECT * INTO v_budget FROM tenant_budgets WHERE tenant_id = p_tenant_id;
  v_has_budget := FOUND;
  SELECT * INTO v_limit FROM tenant_limit_policies WHERE tenant_id = p_tenant_id;
  v_has_limit := FOUND;
  SELECT COALESCE(SUM(amount), 0) INTO v_recognized
  FROM cost_ledger
  WHERE tenant_id = p_tenant_id AND period_start = p_period_start AND entry_type = 'settle';
  SELECT COALESCE(SUM(reserved_amount), 0) INTO v_active
  FROM budget_reservations
  WHERE tenant_id = p_tenant_id
    AND period_start = p_period_start
    AND status = 'active'
    AND reserved_amount IS NOT NULL;
  SELECT COALESCE(SUM(reserved_amount), 0) INTO v_provisional
  FROM budget_reservations
  WHERE tenant_id = p_tenant_id
    AND period_start = p_period_start
    AND status = 'provisional'
    AND reserved_amount IS NOT NULL;
  SELECT count(*) INTO v_unknown
  FROM budget_reservations
  WHERE tenant_id = p_tenant_id
    AND period_start = p_period_start
    AND status = 'provisional'
    AND reserved_amount IS NULL;
  IF NOT v_has_budget OR v_budget.mode = 'disabled' THEN
    v_available := NULL;
    v_allocated := CASE WHEN v_has_budget THEN v_budget.monthly_amount ELSE NULL END;
    v_budget_mode := CASE WHEN v_has_budget THEN v_budget.mode ELSE NULL END;
    v_currency := CASE WHEN v_has_budget THEN v_budget.currency ELSE NULL END;
  ELSE
    v_allocated := v_budget.monthly_amount;
    v_budget_mode := v_budget.mode;
    v_currency := v_budget.currency;
    v_available := v_budget.monthly_amount - v_recognized - v_active - v_provisional;
    -- Observation may record more than the allocation. The excess stays in provisional.
    -- A recognized amount above the allocation is left negative so it is not hidden.
    IF v_budget.mode = 'observe' AND v_available < 0 AND v_recognized <= v_budget.monthly_amount THEN
      v_available := 0;
    END IF;
  END IF;
  v_limit_mode := CASE WHEN v_has_limit THEN v_limit.mode ELSE NULL END;
  IF v_unknown > 0 THEN
    v_cost := 'unknown';
  ELSIF v_provisional > 0 THEN
    v_cost := 'provisional';
  ELSIF v_recognized > 0 THEN
    v_cost := 'estimated';
  ELSE
    v_cost := 'none';
  END IF;
  RETURN QUERY SELECT
    counter_amount(p_tenant_id, 'tenant_requests', p_tenant_id, p_window),
    counter_amount(p_tenant_id, 'tenant_tokens', p_tenant_id, p_window),
    active_lease_count('tenant_request', p_tenant_id, p_now),
    active_lease_count('tenant_stream', p_tenant_id, p_now),
    (
      SELECT count(*)
      FROM concurrency_leases
      WHERE tenant_id = p_tenant_id AND released_at IS NULL AND expires_at > p_now
    ),
    v_allocated,
    v_recognized,
    v_active,
    v_provisional,
    v_available,
    v_unknown,
    v_budget_mode,
    v_limit_mode,
    v_currency,
    v_cost;
END;
$$;

CREATE FUNCTION set_tenant_limits(
  p_tenant_id uuid,
  p_mode text,
  p_requests_per_minute integer,
  p_concurrent_requests integer,
  p_concurrent_streams integer,
  p_token_rate_per_minute bigint,
  p_lease_ms integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  IF p_mode NOT IN ('observe', 'hard') THEN
    RAISE EXCEPTION 'limit mode is invalid';
  END IF;
  IF p_requests_per_minute IS NOT NULL AND p_requests_per_minute NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'request rate is invalid';
  END IF;
  IF p_concurrent_requests IS NOT NULL AND p_concurrent_requests NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'request concurrency is invalid';
  END IF;
  IF p_concurrent_streams IS NOT NULL AND p_concurrent_streams NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'stream concurrency is invalid';
  END IF;
  IF p_token_rate_per_minute IS NOT NULL AND p_token_rate_per_minute NOT BETWEEN 1 AND 1000000000 THEN
    RAISE EXCEPTION 'token rate is invalid';
  END IF;
  v_lease := COALESCE(p_lease_ms, 120000);
  IF v_lease NOT BETWEEN 100 AND 600000 THEN
    RAISE EXCEPTION 'lease is invalid';
  END IF;
  INSERT INTO tenant_limit_policies (
    tenant_id, mode, requests_per_minute, concurrent_requests, concurrent_streams, token_rate_per_minute, lease_ms
  ) VALUES (
    p_tenant_id, p_mode, p_requests_per_minute, p_concurrent_requests, p_concurrent_streams, p_token_rate_per_minute, v_lease
  )
  ON CONFLICT (tenant_id) DO UPDATE
  SET mode = EXCLUDED.mode,
      requests_per_minute = EXCLUDED.requests_per_minute,
      concurrent_requests = EXCLUDED.concurrent_requests,
      concurrent_streams = EXCLUDED.concurrent_streams,
      token_rate_per_minute = EXCLUDED.token_rate_per_minute,
      lease_ms = EXCLUDED.lease_ms;
  RETURN p_tenant_id;
END;
$$;

CREATE FUNCTION set_api_key_limits(
  p_tenant_id uuid,
  p_api_key_id uuid,
  p_mode text,
  p_requests_per_minute integer,
  p_concurrent_requests integer,
  p_concurrent_streams integer,
  p_token_rate_per_minute bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_mode IS NOT NULL AND p_mode NOT IN ('observe', 'hard') THEN
    RAISE EXCEPTION 'limit mode is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_api_keys WHERE tenant_id = p_tenant_id AND id = p_api_key_id) THEN
    RAISE EXCEPTION 'api key is missing';
  END IF;
  IF p_requests_per_minute IS NOT NULL AND p_requests_per_minute NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'request rate is invalid';
  END IF;
  IF p_concurrent_requests IS NOT NULL AND p_concurrent_requests NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'request concurrency is invalid';
  END IF;
  IF p_concurrent_streams IS NOT NULL AND p_concurrent_streams NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'stream concurrency is invalid';
  END IF;
  IF p_token_rate_per_minute IS NOT NULL AND p_token_rate_per_minute NOT BETWEEN 1 AND 1000000000 THEN
    RAISE EXCEPTION 'token rate is invalid';
  END IF;
  INSERT INTO api_key_limit_policies (
    tenant_id, api_key_id, mode, requests_per_minute, concurrent_requests, concurrent_streams, token_rate_per_minute
  ) VALUES (
    p_tenant_id, p_api_key_id, p_mode, p_requests_per_minute, p_concurrent_requests, p_concurrent_streams, p_token_rate_per_minute
  )
  ON CONFLICT (api_key_id) DO UPDATE
  SET mode = EXCLUDED.mode,
      requests_per_minute = EXCLUDED.requests_per_minute,
      concurrent_requests = EXCLUDED.concurrent_requests,
      concurrent_streams = EXCLUDED.concurrent_streams,
      token_rate_per_minute = EXCLUDED.token_rate_per_minute,
      tenant_id = EXCLUDED.tenant_id;
  RETURN p_api_key_id;
END;
$$;

CREATE FUNCTION set_connection_limit(
  p_tenant_id uuid,
  p_provider text,
  p_mode text,
  p_max_concurrency integer,
  p_share_group text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection uuid;
BEGIN
  IF p_provider NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx') THEN
    RAISE EXCEPTION 'provider is invalid';
  END IF;
  SELECT id INTO v_connection
  FROM provider_connections
  WHERE tenant_id = p_tenant_id AND provider = p_provider;
  IF v_connection IS NULL THEN
    RAISE EXCEPTION 'connection is missing';
  END IF;
  IF p_max_concurrency IS NULL THEN
    DELETE FROM connection_limit_policies WHERE tenant_id = p_tenant_id AND connection_id = v_connection;
    RETURN v_connection;
  END IF;
  IF p_mode NOT IN ('observe', 'hard') THEN
    RAISE EXCEPTION 'limit mode is invalid';
  END IF;
  IF p_max_concurrency NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'connection concurrency is invalid';
  END IF;
  IF p_share_group IS NOT NULL AND p_share_group !~ '^[a-z0-9][a-z0-9-]{0,63}$' THEN
    RAISE EXCEPTION 'share group is invalid';
  END IF;
  INSERT INTO connection_limit_policies (tenant_id, connection_id, mode, max_concurrency, share_group)
  VALUES (p_tenant_id, v_connection, p_mode, p_max_concurrency, p_share_group)
  ON CONFLICT (tenant_id, connection_id) DO UPDATE
  SET mode = EXCLUDED.mode,
      max_concurrency = EXCLUDED.max_concurrency,
      share_group = EXCLUDED.share_group;
  RETURN v_connection;
END;
$$;

CREATE FUNCTION set_deployment_limit(
  p_tenant_id uuid,
  p_name text,
  p_mode text,
  p_max_concurrency integer
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
  SELECT id INTO v_deployment FROM model_deployments WHERE tenant_id = p_tenant_id AND name = p_name;
  IF v_deployment IS NULL THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  IF p_max_concurrency IS NULL THEN
    DELETE FROM deployment_limit_policies WHERE tenant_id = p_tenant_id AND deployment_id = v_deployment;
    RETURN v_deployment;
  END IF;
  IF p_mode NOT IN ('observe', 'hard') THEN
    RAISE EXCEPTION 'limit mode is invalid';
  END IF;
  IF p_max_concurrency NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'deployment concurrency is invalid';
  END IF;
  INSERT INTO deployment_limit_policies (tenant_id, deployment_id, mode, max_concurrency)
  VALUES (p_tenant_id, v_deployment, p_mode, p_max_concurrency)
  ON CONFLICT (tenant_id, deployment_id) DO UPDATE
  SET mode = EXCLUDED.mode,
      max_concurrency = EXCLUDED.max_concurrency;
  RETURN v_deployment;
END;
$$;

CREATE FUNCTION set_tenant_budget(p_tenant_id uuid, p_mode text, p_monthly_amount text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount numeric(38, 12);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  IF p_mode NOT IN ('observe', 'hard', 'disabled') THEN
    RAISE EXCEPTION 'budget mode is invalid';
  END IF;
  IF p_monthly_amount IS NULL OR p_monthly_amount !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$' THEN
    RAISE EXCEPTION 'budget amount is invalid';
  END IF;
  v_amount := round(p_monthly_amount::numeric, 12);
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'budget amount is invalid';
  END IF;
  INSERT INTO tenant_budgets (tenant_id, mode, currency, monthly_amount)
  VALUES (p_tenant_id, p_mode, 'USD', v_amount)
  ON CONFLICT (tenant_id) DO UPDATE
  SET mode = EXCLUDED.mode,
      monthly_amount = EXCLUDED.monthly_amount,
      currency = EXCLUDED.currency;
  RETURN p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION split_known_charge(text, numeric, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_caller_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION active_lease_count(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION counter_amount(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION add_counter(uuid, text, uuid, timestamptz, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_attempt_admission(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION recover_tenant_budget(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_tenant_capacity(uuid, timestamptz, timestamptz, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_tenant_limits(uuid, text, integer, integer, integer, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_api_key_limits(uuid, uuid, text, integer, integer, integer, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_connection_limit(uuid, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_limit(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_tenant_budget(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid) TO llm_runtime;
GRANT EXECUTE ON FUNCTION close_attempt_admission(uuid, uuid, timestamptz) TO llm_runtime;
GRANT EXECUTE ON FUNCTION recover_tenant_budget(uuid, timestamptz) TO llm_runtime;
GRANT EXECUTE ON FUNCTION read_tenant_capacity(uuid, timestamptz, timestamptz, date) TO llm_runtime;
GRANT EXECUTE ON FUNCTION set_tenant_limits(uuid, text, integer, integer, integer, bigint, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_api_key_limits(uuid, uuid, text, integer, integer, integer, bigint) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_connection_limit(uuid, text, text, integer, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_limit(uuid, text, text, integer) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_tenant_budget(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION recover_tenant_budget(uuid, timestamptz) TO llm_migrator;

RESET ROLE;
