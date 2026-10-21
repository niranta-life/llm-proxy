-- Additive price versions and attempt costs.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 011.
-- Rollback keeps this file applied.
-- Image 832d8ac782b1844afca422ed9bb2acaf4e6235cc stays ready while 011_private_endpoint.sql remains applied.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE model_deployments
  ADD COLUMN service_tier text;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_service_tier_check
  CHECK (service_tier IS NULL OR service_tier ~ '^[a-z0-9][a-z0-9-]{0,31}$');

CREATE TABLE price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx')),
  model text NOT NULL CHECK (
    char_length(model) BETWEEN 1 AND 128
    AND model !~ '[[:space:]]'
  ),
  region text CHECK (
    region IS NULL
    OR region = 'global'
    OR region ~ '^[a-z]+(-[a-z0-9]+){1,3}$'
  ),
  service_tier text CHECK (
    service_tier IS NULL
    OR service_tier ~ '^[a-z0-9][a-z0-9-]{0,31}$'
  ),
  serving_provider text CHECK (
    serving_provider IS NULL
    OR serving_provider ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  effective_at timestamptz NOT NULL,
  price_source text NOT NULL CHECK (
    char_length(price_source) BETWEEN 1 AND 128
    AND price_source !~ '[[:cntrl:]]'
  ),
  verification_status text NOT NULL CHECK (verification_status IN ('verified', 'unverified')),
  currency text NOT NULL CHECK (currency = 'USD'),
  input_rate numeric,
  output_rate numeric,
  cache_read_rate numeric,
  cache_write_rate numeric,
  thinking_rate numeric,
  request_fee numeric,
  allocated_rate numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_versions_input_rate_check CHECK (input_rate IS NULL OR input_rate >= 0),
  CONSTRAINT price_versions_output_rate_check CHECK (output_rate IS NULL OR output_rate >= 0),
  CONSTRAINT price_versions_cache_read_rate_check CHECK (cache_read_rate IS NULL OR cache_read_rate >= 0),
  CONSTRAINT price_versions_cache_write_rate_check CHECK (cache_write_rate IS NULL OR cache_write_rate >= 0),
  CONSTRAINT price_versions_thinking_rate_check CHECK (thinking_rate IS NULL OR thinking_rate >= 0),
  CONSTRAINT price_versions_request_fee_check CHECK (request_fee IS NULL OR request_fee >= 0),
  CONSTRAINT price_versions_allocated_rate_check CHECK (allocated_rate IS NULL OR allocated_rate >= 0)
);

CREATE INDEX price_versions_lookup_idx
  ON price_versions (provider, model, effective_at DESC);

CREATE TABLE attempt_costs (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  price_version_id uuid,
  cost_status text NOT NULL CHECK (cost_status IN ('estimated', 'provisional', 'reconciled', 'unknown')),
  amount numeric,
  allocated_status text CHECK (
    allocated_status IS NULL
    OR allocated_status IN ('estimated', 'provisional', 'reconciled', 'unknown')
  ),
  allocated_amount numeric,
  currency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, attempt_id),
  CONSTRAINT attempt_costs_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id) REFERENCES model_attempts (tenant_id, id),
  CONSTRAINT attempt_costs_price_fk
    FOREIGN KEY (price_version_id) REFERENCES price_versions (id),
  CONSTRAINT attempt_costs_amount_check CHECK (
    (cost_status = 'unknown' AND amount IS NULL)
    OR (cost_status IN ('estimated', 'provisional', 'reconciled') AND amount IS NOT NULL AND amount >= 0)
  ),
  CONSTRAINT attempt_costs_allocated_check CHECK (
    (allocated_status IS NULL AND allocated_amount IS NULL)
    OR (allocated_status = 'unknown' AND allocated_amount IS NULL)
    OR (
      allocated_status IN ('estimated', 'provisional', 'reconciled')
      AND allocated_amount IS NOT NULL
      AND allocated_amount >= 0
    )
  ),
  CONSTRAINT attempt_costs_currency_check CHECK (
    (price_version_id IS NULL AND currency IS NULL)
    OR (price_version_id IS NOT NULL AND currency = 'USD')
  )
);

CREATE INDEX attempt_costs_tenant_idx ON attempt_costs (tenant_id, attempt_id);

ALTER TABLE attempt_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_costs FORCE ROW LEVEL SECURITY;

CREATE POLICY attempt_costs_isolation ON attempt_costs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON price_versions FROM PUBLIC;
REVOKE ALL ON attempt_costs FROM PUBLIC;
GRANT SELECT ON price_versions TO llm_runtime;
GRANT SELECT, INSERT ON attempt_costs TO llm_runtime;

CREATE FUNCTION reject_price_version_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'price version is immutable';
END;
$$;

CREATE TRIGGER price_versions_immutable
  BEFORE UPDATE OR DELETE ON price_versions
  FOR EACH ROW
  EXECUTE FUNCTION reject_price_version_change();

CREATE FUNCTION reject_attempt_cost_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cost row is immutable';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.price_version_id IS DISTINCT FROM OLD.price_version_id
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cost row is immutable';
  END IF;
  IF NEW.cost_status IS DISTINCT FROM OLD.cost_status
    AND (
      OLD.cost_status NOT IN ('estimated', 'provisional')
      OR NEW.cost_status <> 'reconciled'
    ) THEN
    RAISE EXCEPTION 'cost status cannot change';
  END IF;
  IF NEW.allocated_status IS DISTINCT FROM OLD.allocated_status
    AND (
      OLD.allocated_status IS NULL
      OR NEW.allocated_status IS NULL
      OR OLD.allocated_status NOT IN ('estimated', 'provisional')
      OR NEW.allocated_status <> 'reconciled'
    ) THEN
    RAISE EXCEPTION 'allocated status cannot change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attempt_costs_immutable
  BEFORE UPDATE OR DELETE ON attempt_costs
  FOR EACH ROW
  EXECUTE FUNCTION reject_attempt_cost_change();

CREATE FUNCTION assert_rate(p_rate text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_rate numeric;
BEGIN
  IF p_rate IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_rate !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$' THEN
    RAISE EXCEPTION 'rate is invalid';
  END IF;
  v_rate := p_rate::numeric;
  IF v_rate < 0 OR scale(v_rate) > 12 THEN
    RAISE EXCEPTION 'rate is invalid';
  END IF;
  RETURN v_rate;
END;
$$;

CREATE FUNCTION insert_price_version(
  p_provider text,
  p_model text,
  p_region text,
  p_service_tier text,
  p_serving_provider text,
  p_effective_at timestamptz,
  p_price_source text,
  p_verification_status text,
  p_input_rate text,
  p_output_rate text,
  p_cache_read_rate text,
  p_cache_write_rate text,
  p_thinking_rate text,
  p_request_fee text,
  p_allocated_rate text
)
RETURNS TABLE (
  id uuid,
  verification_status text,
  effective_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx') THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_model IS NULL OR char_length(p_model) < 1 OR char_length(p_model) > 128 OR p_model ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_region IS NOT NULL AND NOT (p_region = 'global' OR p_region ~ '^[a-z]+(-[a-z0-9]+){1,3}$') THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_service_tier IS NOT NULL AND p_service_tier !~ '^[a-z0-9][a-z0-9-]{0,31}$' THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_serving_provider IS NOT NULL AND p_serving_provider !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_effective_at IS NULL THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_price_source IS NULL
    OR char_length(p_price_source) < 1
    OR char_length(p_price_source) > 128
    OR p_price_source ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  IF p_verification_status IS NULL OR p_verification_status NOT IN ('verified', 'unverified') THEN
    RAISE EXCEPTION 'price arguments are invalid';
  END IF;
  INSERT INTO price_versions (
    provider, model, region, service_tier, serving_provider, effective_at, price_source,
    verification_status, currency, input_rate, output_rate, cache_read_rate, cache_write_rate,
    thinking_rate, request_fee, allocated_rate
  ) VALUES (
    p_provider, p_model, p_region, p_service_tier, p_serving_provider, p_effective_at, p_price_source,
    p_verification_status, 'USD',
    assert_rate(p_input_rate),
    assert_rate(p_output_rate),
    assert_rate(p_cache_read_rate),
    assert_rate(p_cache_write_rate),
    assert_rate(p_thinking_rate),
    assert_rate(p_request_fee),
    assert_rate(p_allocated_rate)
  )
  RETURNING price_versions.id INTO v_id;
  RETURN QUERY
  SELECT v_id, p_verification_status, p_effective_at;
END;
$$;

CREATE FUNCTION set_deployment_service_tier(p_tenant_id uuid, p_name text, p_tier text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier text;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_name = 'auto' THEN
    RAISE EXCEPTION 'deployment arguments are invalid';
  END IF;
  IF p_tier IS NOT NULL AND p_tier !~ '^[a-z0-9][a-z0-9-]{0,31}$' THEN
    RAISE EXCEPTION 'service tier is invalid';
  END IF;
  UPDATE model_deployments
  SET service_tier = p_tier
  WHERE tenant_id = p_tenant_id
    AND name = p_name
  RETURNING service_tier INTO v_tier;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment is missing';
  END IF;
  RETURN v_tier;
END;
$$;

CREATE FUNCTION reconcile_attempt_cost(p_tenant_id uuid, p_attempt_id uuid)
RETURNS TABLE (
  cost_status text,
  amount numeric,
  allocated_status text,
  allocated_amount numeric,
  price_version_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost text;
  v_allocated text;
  v_amount numeric;
  v_allocated_amount numeric;
  v_price uuid;
  v_new_cost text;
  v_new_allocated text;
BEGIN
  SELECT ac.cost_status, ac.allocated_status, ac.amount, ac.allocated_amount, ac.price_version_id
    INTO v_cost, v_allocated, v_amount, v_allocated_amount, v_price
  FROM attempt_costs ac
  WHERE ac.tenant_id = p_tenant_id
    AND ac.attempt_id = p_attempt_id;
  IF v_cost IS NULL THEN
    RAISE EXCEPTION 'cost is missing';
  END IF;
  v_new_cost := v_cost;
  v_new_allocated := v_allocated;
  IF v_cost IN ('estimated', 'provisional') THEN
    v_new_cost := 'reconciled';
  END IF;
  IF v_allocated IN ('estimated', 'provisional') THEN
    v_new_allocated := 'reconciled';
  END IF;
  IF v_new_cost IS NOT DISTINCT FROM v_cost
    AND v_new_allocated IS NOT DISTINCT FROM v_allocated
    AND v_cost <> 'reconciled'
    AND (v_allocated IS NULL OR v_allocated <> 'reconciled') THEN
    RAISE EXCEPTION 'cost cannot be reconciled';
  END IF;
  UPDATE attempt_costs
  SET cost_status = v_new_cost,
      allocated_status = v_new_allocated
  WHERE tenant_id = p_tenant_id
    AND attempt_id = p_attempt_id;
  RETURN QUERY
  SELECT v_new_cost, v_amount, v_new_allocated, v_allocated_amount, v_price;
END;
$$;

REVOKE ALL ON FUNCTION assert_rate(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION insert_price_version(text, text, text, text, text, timestamptz, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_deployment_service_tier(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_attempt_cost(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_price_version_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_attempt_cost_change() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION insert_price_version(text, text, text, text, text, timestamptz, text, text, text, text, text, text, text, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION set_deployment_service_tier(uuid, text, text) TO llm_migrator;
GRANT EXECUTE ON FUNCTION reconcile_attempt_cost(uuid, uuid) TO llm_migrator;

RESET ROLE;
