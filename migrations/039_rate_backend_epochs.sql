-- Charge a versioned rate slice before Redis may spend it.
-- A closed epoch does not refund the slice.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 035.
-- Rollback keeps this file applied. Removing a column needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE attempt_admissions
  ADD COLUMN prepaid_tenant_tokens boolean NOT NULL DEFAULT false,
  ADD COLUMN prepaid_api_key_tokens boolean NOT NULL DEFAULT false;

CREATE TABLE rate_backend_activations (
  tenant_id uuid NOT NULL,
  scope text NOT NULL,
  scope_id uuid NOT NULL,
  generation integer NOT NULL,
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope, scope_id),
  CONSTRAINT rate_backend_activations_scope_check CHECK (
    scope IN ('tenant_requests', 'tenant_tokens', 'api_key_requests', 'api_key_tokens')
  ),
  CONSTRAINT rate_backend_activations_generation_check CHECK (generation BETWEEN 1 AND 1000000)
);

CREATE TABLE rate_quota_allocations (
  tenant_id uuid NOT NULL,
  scope text NOT NULL,
  scope_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  epoch integer NOT NULL,
  generation integer NOT NULL,
  policy_revision text NOT NULL,
  allocated bigint NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  redis_seeded boolean NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (tenant_id, scope, scope_id, window_start, epoch),
  CONSTRAINT rate_quota_allocations_scope_check CHECK (
    scope IN ('tenant_requests', 'tenant_tokens', 'api_key_requests', 'api_key_tokens')
  ),
  CONSTRAINT rate_quota_allocations_epoch_check CHECK (epoch BETWEEN 1 AND 8),
  CONSTRAINT rate_quota_allocations_generation_check CHECK (generation BETWEEN 1 AND 1000000),
  CONSTRAINT rate_quota_allocations_revision_check CHECK (policy_revision ~ '^[0-9a-f]{16}$'),
  CONSTRAINT rate_quota_allocations_amount_check CHECK (allocated > 0),
  CONSTRAINT rate_quota_allocations_version_check CHECK (version >= 1),
  CONSTRAINT rate_quota_allocations_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT rate_quota_allocations_closed_check CHECK (
    (status = 'open' AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

-- One open slice per scope and window. A second open row would grant the same capacity twice.
CREATE UNIQUE INDEX rate_quota_allocations_one_open
  ON rate_quota_allocations (tenant_id, scope, scope_id, window_start)
  WHERE status = 'open';

ALTER TABLE rate_backend_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_backend_activations FORCE ROW LEVEL SECURITY;
ALTER TABLE rate_quota_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_quota_allocations FORCE ROW LEVEL SECURITY;

CREATE POLICY rate_backend_activations_isolation ON rate_backend_activations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY rate_quota_allocations_isolation ON rate_quota_allocations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON rate_backend_activations FROM PUBLIC;
REVOKE ALL ON rate_quota_allocations FROM PUBLIC;
GRANT SELECT ON rate_backend_activations TO llm_runtime;
GRANT SELECT ON rate_quota_allocations TO llm_runtime;

DROP FUNCTION admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid);

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
  p_price_version_id uuid,
  p_skip_api_key_requests boolean DEFAULT false,
  p_skip_tenant_requests boolean DEFAULT false,
  p_skip_api_key_tokens boolean DEFAULT false,
  p_skip_tenant_tokens boolean DEFAULT false
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
  IF p_skip_api_key_requests IS NULL OR p_skip_tenant_requests IS NULL
    OR p_skip_api_key_tokens IS NULL OR p_skip_tenant_tokens IS NULL THEN
    RAISE EXCEPTION 'rate skip is invalid';
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

  -- A skipped scope was already charged as a Redis slice. Do not grant it again here.
  IF NOT p_skip_api_key_requests AND v_has_key AND v_key.requests_per_minute IS NOT NULL AND v_key_mode = 'hard'
    AND counter_amount(p_tenant_id, 'api_key_requests', p_api_key_id, p_window) + 1 > v_key.requests_per_minute THEN
    RETURN QUERY SELECT 'reject'::text, 'api_key_rate_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF NOT p_skip_tenant_requests AND v_has_tenant AND v_tenant.requests_per_minute IS NOT NULL AND v_tenant_mode = 'hard'
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
  IF NOT p_skip_api_key_tokens AND p_token_bound IS NOT NULL AND v_has_key AND v_key.token_rate_per_minute IS NOT NULL AND v_key_mode = 'hard'
    AND counter_amount(p_tenant_id, 'api_key_tokens', p_api_key_id, p_window) + p_token_bound > v_key.token_rate_per_minute THEN
    RETURN QUERY SELECT 'reject'::text, 'api_key_token_limited'::text, NULL::uuid, NULL::numeric, NULL::text;
    RETURN;
  END IF;
  IF NOT p_skip_tenant_tokens AND p_token_bound IS NOT NULL AND v_has_tenant AND v_tenant.token_rate_per_minute IS NOT NULL AND v_tenant_mode = 'hard'
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

  IF NOT p_skip_api_key_requests AND v_has_key AND v_key.requests_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'api_key_requests', p_api_key_id, p_window, 1);
  END IF;
  IF NOT p_skip_tenant_requests AND v_has_tenant AND v_tenant.requests_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'tenant_requests', p_tenant_id, p_window, 1);
  END IF;
  IF NOT p_skip_api_key_tokens AND p_token_bound IS NOT NULL AND v_has_key AND v_key.token_rate_per_minute IS NOT NULL THEN
    PERFORM add_counter(p_tenant_id, 'api_key_tokens', p_api_key_id, p_window, p_token_bound);
  END IF;
  IF NOT p_skip_tenant_tokens AND p_token_bound IS NOT NULL AND v_has_tenant AND v_tenant.token_rate_per_minute IS NOT NULL THEN
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

  INSERT INTO attempt_admissions (
    tenant_id, attempt_id, api_key_id, window_start, token_bound, prepaid_tenant_tokens, prepaid_api_key_tokens
  ) VALUES (
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
    END,
    p_skip_tenant_tokens,
    p_skip_api_key_tokens
  );

  IF v_has_budget AND v_budget.mode IN ('observe', 'hard') AND p_estimate_kind = 'bounded' THEN
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

CREATE OR REPLACE FUNCTION close_attempt_admission(p_tenant_id uuid, p_attempt_id uuid, p_now timestamptz)
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
    -- A prepaid token scope was charged with the slice. Do not refund it on close.
    IF v_admission.token_bound IS NOT NULL AND v_actual IS NOT NULL THEN
      v_delta := v_actual - v_admission.token_bound;
      IF NOT v_admission.prepaid_tenant_tokens THEN
        PERFORM add_counter(p_tenant_id, 'tenant_tokens', p_tenant_id, v_admission.window_start, v_delta);
      END IF;
      IF NOT v_admission.prepaid_api_key_tokens THEN
        PERFORM add_counter(p_tenant_id, 'api_key_tokens', v_admission.api_key_id, v_admission.window_start, v_delta);
      END IF;
    ELSIF v_admission.token_bound IS NULL AND v_actual IS NOT NULL THEN
      IF NOT v_admission.prepaid_tenant_tokens AND EXISTS (
        SELECT 1 FROM tenant_limit_policies
        WHERE tenant_id = p_tenant_id AND token_rate_per_minute IS NOT NULL
      ) THEN
        PERFORM add_counter(p_tenant_id, 'tenant_tokens', p_tenant_id, v_admission.window_start, v_actual);
      END IF;
      IF NOT v_admission.prepaid_api_key_tokens AND EXISTS (
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

CREATE FUNCTION close_matching_rate_epochs(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE rate_quota_allocations
  SET status = 'closed',
      closed_at = p_now,
      version = version + 1
  WHERE tenant_id = p_tenant_id
    AND scope = p_scope
    AND scope_id = p_scope_id
    AND status = 'open';
END;
$$;

CREATE FUNCTION activate_rate_backend(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_now timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation integer;
BEGIN
  IF p_scope NOT IN ('tenant_requests', 'tenant_tokens', 'api_key_requests', 'api_key_tokens') THEN
    RAISE EXCEPTION 'rate scope is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
  IF p_scope IN ('tenant_requests', 'tenant_tokens') AND p_scope_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'rate scope is invalid';
  END IF;
  IF p_scope IN ('api_key_requests', 'api_key_tokens') AND NOT EXISTS (
    SELECT 1 FROM tenant_api_keys WHERE tenant_id = p_tenant_id AND id = p_scope_id
  ) THEN
    RAISE EXCEPTION 'api key is missing';
  END IF;
  PERFORM close_matching_rate_epochs(p_tenant_id, p_scope, p_scope_id, p_now);
  INSERT INTO rate_backend_activations (tenant_id, scope, scope_id, generation, approved_at)
  VALUES (p_tenant_id, p_scope, p_scope_id, 1, p_now)
  ON CONFLICT (tenant_id, scope, scope_id) DO UPDATE
  SET generation = rate_backend_activations.generation + 1,
      approved_at = EXCLUDED.approved_at
  RETURNING generation INTO v_generation;
  RETURN v_generation;
END;
$$;

CREATE FUNCTION deactivate_rate_backend(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_now timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation integer;
BEGIN
  IF p_scope NOT IN ('tenant_requests', 'tenant_tokens', 'api_key_requests', 'api_key_tokens') THEN
    RAISE EXCEPTION 'rate scope is invalid';
  END IF;
  SELECT generation INTO v_generation
  FROM rate_backend_activations
  WHERE tenant_id = p_tenant_id AND scope = p_scope AND scope_id = p_scope_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  PERFORM close_matching_rate_epochs(p_tenant_id, p_scope, p_scope_id, p_now);
  DELETE FROM rate_backend_activations
  WHERE tenant_id = p_tenant_id AND scope = p_scope AND scope_id = p_scope_id;
  RETURN v_generation;
END;
$$;

CREATE FUNCTION allocate_rate_slice(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_window timestamptz,
  p_cost bigint,
  p_now timestamptz
)
RETURNS TABLE (
  outcome text,
  reason text,
  epoch integer,
  allocated bigint,
  seeded boolean,
  version integer,
  generation integer,
  policy_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_mode text;
  v_limit bigint;
  v_generation integer;
  v_revision text;
  v_open rate_quota_allocations%ROWTYPE;
  v_used bigint;
  v_half bigint;
  v_slice bigint;
  v_epoch integer;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  IF p_scope NOT IN ('tenant_requests', 'tenant_tokens', 'api_key_requests', 'api_key_tokens') THEN
    RETURN QUERY SELECT 'deny'::text, 'bad_request'::text, NULL::integer, NULL::bigint, false, NULL::integer, NULL::integer, NULL::text;
    RETURN;
  END IF;
  IF p_cost IS NULL OR p_cost < 1 OR p_cost > 1000000000 THEN
    RETURN QUERY SELECT 'deny'::text, 'bad_request'::text, NULL::integer, NULL::bigint, false, NULL::integer, NULL::integer, NULL::text;
    RETURN;
  END IF;

  SELECT activations.generation INTO v_generation
  FROM rate_backend_activations AS activations
  WHERE activations.tenant_id = p_tenant_id
    AND activations.scope = p_scope
    AND activations.scope_id = p_scope_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'inactive'::text, 'inactive'::text, NULL::integer, NULL::bigint, false, NULL::integer, NULL::integer, NULL::text;
    RETURN;
  END IF;

  IF p_scope = 'tenant_requests' THEN
    SELECT mode, requests_per_minute INTO v_mode, v_limit
    FROM tenant_limit_policies WHERE tenant_id = p_tenant_id;
  ELSIF p_scope = 'tenant_tokens' THEN
    SELECT mode, token_rate_per_minute INTO v_mode, v_limit
    FROM tenant_limit_policies WHERE tenant_id = p_tenant_id;
  ELSIF p_scope = 'api_key_requests' THEN
    SELECT COALESCE(key_policy.mode, tenant_policy.mode), key_policy.requests_per_minute
    INTO v_mode, v_limit
    FROM api_key_limit_policies AS key_policy
    LEFT JOIN tenant_limit_policies AS tenant_policy ON tenant_policy.tenant_id = key_policy.tenant_id
    WHERE key_policy.tenant_id = p_tenant_id AND key_policy.api_key_id = p_scope_id;
  ELSE
    SELECT COALESCE(key_policy.mode, tenant_policy.mode), key_policy.token_rate_per_minute
    INTO v_mode, v_limit
    FROM api_key_limit_policies AS key_policy
    LEFT JOIN tenant_limit_policies AS tenant_policy ON tenant_policy.tenant_id = key_policy.tenant_id
    WHERE key_policy.tenant_id = p_tenant_id AND key_policy.api_key_id = p_scope_id;
  END IF;

  IF v_mode IS DISTINCT FROM 'hard' OR v_limit IS NULL OR v_limit < 1 THEN
    RETURN QUERY SELECT 'inactive'::text, 'inactive'::text, NULL::integer, NULL::bigint, false, NULL::integer, NULL::integer, NULL::text;
    RETURN;
  END IF;

  v_revision := substring(md5(p_scope || '|' || v_mode || '|' || v_limit::text || '|' || v_generation::text) FROM 1 FOR 16);
  PERFORM pg_advisory_xact_lock(hashtextextended('admit:' || p_tenant_id::text, 0));

  -- A policy or generation change closes the open slice. The charged amount stays.
  -- Qualify the columns. The RETURNS TABLE names are PL/pgSQL variables.
  UPDATE rate_quota_allocations AS quota
  SET status = 'closed',
      closed_at = p_now,
      version = quota.version + 1
  WHERE quota.tenant_id = p_tenant_id
    AND quota.scope = p_scope
    AND quota.scope_id = p_scope_id
    AND quota.window_start = p_window
    AND quota.status = 'open'
    AND (quota.policy_revision IS DISTINCT FROM v_revision OR quota.generation IS DISTINCT FROM v_generation);

  SELECT * INTO v_open
  FROM rate_quota_allocations AS quota
  WHERE quota.tenant_id = p_tenant_id
    AND quota.scope = p_scope
    AND quota.scope_id = p_scope_id
    AND quota.window_start = p_window
    AND quota.status = 'open';
  IF FOUND THEN
    RETURN QUERY SELECT
      CASE WHEN v_open.redis_seeded THEN 'spend'::text ELSE 'seed'::text END,
      'ok'::text,
      v_open.epoch,
      v_open.allocated,
      v_open.redis_seeded,
      v_open.version,
      v_open.generation,
      v_open.policy_revision;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(quota.epoch), 0) INTO v_epoch
  FROM rate_quota_allocations AS quota
  WHERE quota.tenant_id = p_tenant_id
    AND quota.scope = p_scope
    AND quota.scope_id = p_scope_id
    AND quota.window_start = p_window;
  IF v_epoch >= 8 THEN
    RETURN QUERY SELECT 'deny'::text, 'epoch_bound'::text, NULL::integer, NULL::bigint, false, NULL::integer, v_generation, v_revision;
    RETURN;
  END IF;

  v_used := counter_amount(p_tenant_id, p_scope, p_scope_id, p_window);
  IF v_used + p_cost > v_limit THEN
    RETURN QUERY SELECT 'deny'::text, 'rate_limited'::text, NULL::integer, NULL::bigint, false, NULL::integer, v_generation, v_revision;
    RETURN;
  END IF;
  v_half := v_limit / 2;
  IF v_half < 1 THEN
    v_half := 1;
  END IF;
  v_slice := LEAST(v_limit - v_used, GREATEST(p_cost, v_half));
  IF v_slice < p_cost THEN
    RETURN QUERY SELECT 'deny'::text, 'rate_limited'::text, NULL::integer, NULL::bigint, false, NULL::integer, v_generation, v_revision;
    RETURN;
  END IF;

  v_epoch := v_epoch + 1;
  PERFORM add_counter(p_tenant_id, p_scope, p_scope_id, p_window, v_slice);
  INSERT INTO rate_quota_allocations (
    tenant_id, scope, scope_id, window_start, epoch, generation, policy_revision,
    allocated, version, status, redis_seeded, opened_at
  ) VALUES (
    p_tenant_id, p_scope, p_scope_id, p_window, v_epoch, v_generation, v_revision,
    v_slice, 1, 'open', false, p_now
  );
  RETURN QUERY SELECT 'seed'::text, 'ok'::text, v_epoch, v_slice, false, 1, v_generation, v_revision;
END;
$$;

CREATE FUNCTION mark_rate_slice_seeded(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_window timestamptz,
  p_epoch integer,
  p_version integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  UPDATE rate_quota_allocations
  SET redis_seeded = true,
      version = version + 1
  WHERE tenant_id = p_tenant_id
    AND scope = p_scope
    AND scope_id = p_scope_id
    AND window_start = p_window
    AND epoch = p_epoch
    AND version = p_version
    AND status = 'open'
    AND redis_seeded = false;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM rate_quota_allocations
    WHERE tenant_id = p_tenant_id
      AND scope = p_scope
      AND scope_id = p_scope_id
      AND window_start = p_window
      AND epoch = p_epoch
      AND status = 'open'
      AND redis_seeded = true
  );
END;
$$;

CREATE FUNCTION close_rate_slice(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_window timestamptz,
  p_epoch integer,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  PERFORM assert_caller_tenant(p_tenant_id);
  -- Close does not subtract the counter. The slice stays spent.
  UPDATE rate_quota_allocations
  SET status = 'closed',
      closed_at = p_now,
      version = version + 1
  WHERE tenant_id = p_tenant_id
    AND scope = p_scope
    AND scope_id = p_scope_id
    AND window_start = p_window
    AND epoch = p_epoch
    AND status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE FUNCTION close_open_rate_epochs(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  -- Recovery closes every open epoch. It does not refund charged capacity.
  UPDATE rate_quota_allocations
  SET status = 'closed',
      closed_at = p_now,
      version = version + 1
  WHERE status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid, boolean, boolean, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_matching_rate_epochs(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION activate_rate_backend(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION deactivate_rate_backend(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION allocate_rate_slice(uuid, text, uuid, timestamptz, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_rate_slice_seeded(uuid, text, uuid, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_rate_slice(uuid, text, uuid, timestamptz, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_open_rate_epochs(timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid, boolean, boolean, boolean, boolean) TO llm_runtime;
GRANT EXECUTE ON FUNCTION allocate_rate_slice(uuid, text, uuid, timestamptz, bigint, timestamptz) TO llm_runtime;
GRANT EXECUTE ON FUNCTION mark_rate_slice_seeded(uuid, text, uuid, timestamptz, integer, integer) TO llm_runtime;
GRANT EXECUTE ON FUNCTION close_rate_slice(uuid, text, uuid, timestamptz, integer, timestamptz) TO llm_runtime;
GRANT EXECUTE ON FUNCTION close_open_rate_epochs(timestamptz) TO llm_runtime;
GRANT EXECUTE ON FUNCTION activate_rate_backend(uuid, text, uuid, timestamptz) TO llm_migrator;
GRANT EXECUTE ON FUNCTION deactivate_rate_backend(uuid, text, uuid, timestamptz) TO llm_migrator;

RESET ROLE;
