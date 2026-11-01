-- Add governed execution for one approved MCP tool.
-- A write waits for approval. A non-idempotent call is dispatched once.
-- Retained arguments and results are ciphertext.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 037.
-- Rollback keeps this file applied. Removing execution needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE mcp_servers ADD COLUMN credential_state text NOT NULL DEFAULT 'active';
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_credential_state_check
  CHECK (credential_state IN ('active', 'revoked'));
GRANT SELECT (credential_state) ON mcp_servers TO llm_runtime;

ALTER TABLE mcp_tool_permissions ADD COLUMN effect text;
ALTER TABLE mcp_tool_permissions ADD CONSTRAINT mcp_tool_permissions_effect_check
  CHECK (effect IS NULL OR effect IN ('read', 'write'));

CREATE TABLE mcp_execution_policy (
  tenant_id uuid PRIMARY KEY,
  write_approval text NOT NULL DEFAULT 'required',
  max_concurrent integer NOT NULL DEFAULT 4,
  timeout_ms integer NOT NULL DEFAULT 3000,
  max_cost_units integer NOT NULL DEFAULT 32,
  max_loop_depth integer NOT NULL DEFAULT 2,
  identity_ttl_ms integer NOT NULL DEFAULT 120000,
  model_followup boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_execution_policy_write_check CHECK (write_approval = 'required'),
  CONSTRAINT mcp_execution_policy_concurrent_check CHECK (max_concurrent BETWEEN 1 AND 8),
  CONSTRAINT mcp_execution_policy_timeout_check CHECK (timeout_ms BETWEEN 100 AND 30000),
  CONSTRAINT mcp_execution_policy_cost_check CHECK (max_cost_units BETWEEN 1 AND 1000),
  CONSTRAINT mcp_execution_policy_loop_check CHECK (max_loop_depth BETWEEN 1 AND 4),
  CONSTRAINT mcp_execution_policy_ttl_check CHECK (identity_ttl_ms BETWEEN 1000 AND 300000)
);

ALTER TABLE mcp_execution_policy OWNER TO llm_owner;
ALTER TABLE mcp_execution_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_execution_policy FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_execution_policy_isolation ON mcp_execution_policy
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mcp_execution_policy FROM PUBLIC;
GRANT SELECT ON mcp_execution_policy TO llm_runtime;

CREATE TABLE mcp_tool_executions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  server_id uuid NOT NULL,
  remote_name text NOT NULL,
  namespaced_name text NOT NULL,
  schema_version integer NOT NULL,
  request_id text NOT NULL,
  tool_call_id text NOT NULL,
  effect text NOT NULL,
  idempotent boolean NOT NULL,
  argument_hash text NOT NULL,
  identity_hash text NOT NULL,
  identity_expires_at timestamptz NOT NULL,
  status text NOT NULL,
  approval text NOT NULL,
  loop_depth integer NOT NULL,
  parent_execution_id uuid,
  cost_units integer NOT NULL,
  timeout_ms integer NOT NULL,
  latency_ms integer,
  dispatch_count integer NOT NULL DEFAULT 0,
  model_requests integer NOT NULL DEFAULT 0,
  outcome text,
  error_code integer,
  error_message text,
  evidence bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT mcp_tool_executions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT mcp_tool_executions_request_call_key UNIQUE (tenant_id, request_id, tool_call_id),
  CONSTRAINT mcp_tool_executions_identity_key UNIQUE (tenant_id, identity_hash),
  CONSTRAINT mcp_tool_executions_remote_name_check CHECK (remote_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT mcp_tool_executions_namespaced_check CHECK (
    char_length(namespaced_name) BETWEEN 3 AND 97
    AND namespaced_name !~ '[[:space:]]'
  ),
  CONSTRAINT mcp_tool_executions_schema_check CHECK (schema_version >= 1),
  CONSTRAINT mcp_tool_executions_request_check CHECK (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  CONSTRAINT mcp_tool_executions_call_check CHECK (tool_call_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT mcp_tool_executions_effect_check CHECK (effect IN ('read', 'write')),
  CONSTRAINT mcp_tool_executions_hash_check CHECK (
    argument_hash ~ '^[0-9a-f]{64}$'
    AND identity_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT mcp_tool_executions_status_check CHECK (
    status IN (
      'awaiting_approval',
      'approved',
      'denied',
      'cancelled',
      'dispatching',
      'succeeded',
      'failed',
      'uncertain'
    )
  ),
  CONSTRAINT mcp_tool_executions_approval_check CHECK (
    approval IN ('pending', 'granted', 'denied', 'not_required')
  ),
  CONSTRAINT mcp_tool_executions_depth_check CHECK (loop_depth BETWEEN 1 AND 4),
  CONSTRAINT mcp_tool_executions_cost_check CHECK (cost_units BETWEEN 1 AND 1000),
  CONSTRAINT mcp_tool_executions_timeout_check CHECK (timeout_ms BETWEEN 100 AND 30000),
  CONSTRAINT mcp_tool_executions_latency_check CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT mcp_tool_executions_dispatch_check CHECK (dispatch_count IN (0, 1)),
  CONSTRAINT mcp_tool_executions_model_check CHECK (model_requests IN (0, 1)),
  CONSTRAINT mcp_tool_executions_outcome_check CHECK (
    outcome IS NULL OR outcome IN ('result', 'error', 'uncertain', 'denied', 'cancelled')
  ),
  CONSTRAINT mcp_tool_executions_error_check CHECK (
    error_message IS NULL
    OR (
      char_length(error_message) BETWEEN 1 AND 200
      AND error_message !~ '[[:cntrl:]]'
      AND error_message NOT LIKE '%aes-256-gcm$%'
    )
  ),
  CONSTRAINT mcp_tool_executions_server_fk
    FOREIGN KEY (tenant_id, server_id)
    REFERENCES mcp_servers (tenant_id, id)
);

CREATE INDEX mcp_tool_executions_tenant_status_idx ON mcp_tool_executions (tenant_id, status, created_at DESC);

ALTER TABLE mcp_tool_executions OWNER TO llm_owner;
ALTER TABLE mcp_tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_tool_executions_isolation ON mcp_tool_executions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mcp_tool_executions FROM PUBLIC;
GRANT SELECT (
  id,
  tenant_id,
  server_id,
  remote_name,
  namespaced_name,
  schema_version,
  request_id,
  tool_call_id,
  effect,
  idempotent,
  status,
  approval,
  loop_depth,
  parent_execution_id,
  cost_units,
  timeout_ms,
  latency_ms,
  dispatch_count,
  model_requests,
  outcome,
  error_code,
  error_message,
  created_at,
  dispatched_at,
  finished_at
) ON mcp_tool_executions TO llm_runtime;

CREATE FUNCTION classify_mcp_tool(
  p_tenant_id uuid,
  p_server_id uuid,
  p_remote_name text,
  p_allowed boolean,
  p_effect text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_remote_name IS NULL OR p_remote_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
    RAISE EXCEPTION 'tool name is invalid';
  END IF;
  IF p_allowed IS NULL OR p_effect IS NULL OR p_effect NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'permission is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mcp_servers
    WHERE tenant_id = p_tenant_id
      AND id = p_server_id
  ) THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
  INSERT INTO mcp_tool_permissions (tenant_id, server_id, remote_name, allowed, effect)
  VALUES (p_tenant_id, p_server_id, p_remote_name, p_allowed, p_effect)
  ON CONFLICT (tenant_id, server_id, remote_name)
  DO UPDATE SET allowed = EXCLUDED.allowed, effect = EXCLUDED.effect, updated_at = now();
  RETURN p_allowed;
END;
$$;

ALTER FUNCTION classify_mcp_tool(uuid, uuid, text, boolean, text) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION classify_mcp_tool(uuid, uuid, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION classify_mcp_tool(uuid, uuid, text, boolean, text) TO llm_runtime;

CREATE FUNCTION revoke_mcp_credential(p_tenant_id uuid, p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  UPDATE mcp_servers
  SET credential_state = 'revoked'
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
END;
$$;

ALTER FUNCTION revoke_mcp_credential(uuid, uuid) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION revoke_mcp_credential(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_mcp_credential(uuid, uuid) TO llm_runtime;

CREATE FUNCTION set_mcp_execution_policy(
  p_tenant_id uuid,
  p_max_concurrent integer,
  p_timeout_ms integer,
  p_max_cost_units integer,
  p_max_loop_depth integer,
  p_identity_ttl_ms integer,
  p_model_followup boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_max_concurrent IS NULL OR p_max_concurrent < 1 OR p_max_concurrent > 8
    OR p_timeout_ms IS NULL OR p_timeout_ms < 100 OR p_timeout_ms > 30000
    OR p_max_cost_units IS NULL OR p_max_cost_units < 1 OR p_max_cost_units > 1000
    OR p_max_loop_depth IS NULL OR p_max_loop_depth < 1 OR p_max_loop_depth > 4
    OR p_identity_ttl_ms IS NULL OR p_identity_ttl_ms < 1000 OR p_identity_ttl_ms > 300000
    OR p_model_followup IS NULL THEN
    RAISE EXCEPTION 'request is invalid';
  END IF;
  INSERT INTO mcp_execution_policy (
    tenant_id,
    write_approval,
    max_concurrent,
    timeout_ms,
    max_cost_units,
    max_loop_depth,
    identity_ttl_ms,
    model_followup
  ) VALUES (
    p_tenant_id,
    'required',
    p_max_concurrent,
    p_timeout_ms,
    p_max_cost_units,
    p_max_loop_depth,
    p_identity_ttl_ms,
    p_model_followup
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    write_approval = 'required',
    max_concurrent = EXCLUDED.max_concurrent,
    timeout_ms = EXCLUDED.timeout_ms,
    max_cost_units = EXCLUDED.max_cost_units,
    max_loop_depth = EXCLUDED.max_loop_depth,
    identity_ttl_ms = EXCLUDED.identity_ttl_ms,
    model_followup = EXCLUDED.model_followup,
    updated_at = now();
END;
$$;

ALTER FUNCTION set_mcp_execution_policy(uuid, integer, integer, integer, integer, integer, boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION set_mcp_execution_policy(uuid, integer, integer, integer, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_mcp_execution_policy(uuid, integer, integer, integer, integer, integer, boolean) TO llm_runtime;

CREATE FUNCTION reserve_mcp_execution(
  p_tenant_id uuid,
  p_id uuid,
  p_server_id uuid,
  p_remote_name text,
  p_schema_version integer,
  p_request_id text,
  p_tool_call_id text,
  p_argument_hash text,
  p_identity_hash text,
  p_identity_expires_at timestamptz,
  p_depth integer,
  p_parent_id uuid,
  p_cost_units integer,
  p_now timestamptz,
  p_evidence bytea
)
RETURNS TABLE (
  id uuid,
  status text,
  approval text,
  inserted boolean,
  effect text,
  namespaced_name text,
  schema_version integer,
  request_id text,
  tool_call_id text,
  identity_expires_at timestamptz,
  dispatch_count integer,
  model_requests integer,
  latency_ms integer,
  outcome text,
  error_code integer,
  error_message text,
  remote_name text,
  server_id uuid,
  timeout_ms integer,
  loop_depth integer,
  idempotent boolean,
  cost_units integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_state text;
  v_connection text;
  v_mode text;
  v_protocol text;
  v_catalog integer;
  v_namespaced text;
  v_allowed boolean;
  v_effect text;
  v_max_concurrent integer := 4;
  v_timeout integer := 3000;
  v_max_cost integer := 32;
  v_max_depth integer := 2;
  v_open integer;
  v_cost integer;
  v_parent_request text;
  v_parent_depth integer;
  v_parent_name text;
  v_cursor uuid;
  v_seen text;
  v_next uuid;
  v_guard integer := 0;
  v_status text;
  v_approval text;
  v_idempotent boolean;
  v_constraint text;
  v_existing mcp_tool_executions%ROWTYPE;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  PERFORM pg_advisory_xact_lock(1, hashtext(p_tenant_id::text));
  IF p_remote_name IS NULL OR p_request_id IS NULL OR p_tool_call_id IS NULL
    OR p_argument_hash IS NULL OR p_identity_hash IS NULL OR p_evidence IS NULL THEN
    RAISE EXCEPTION 'request is invalid';
  END IF;
  SELECT enabled, credential_state, connection_status, protocol_mode, protocol_version, catalog_version
    INTO v_enabled, v_state, v_connection, v_mode, v_protocol, v_catalog
  FROM mcp_servers
  WHERE tenant_id = p_tenant_id
    AND id = p_server_id;
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'server is missing';
  END IF;
  IF v_state = 'revoked' THEN
    RAISE EXCEPTION 'credential is revoked';
  END IF;
  IF v_enabled IS DISTINCT FROM true
    OR v_connection IS DISTINCT FROM 'ok'
    OR v_mode IS DISTINCT FROM 'modern'
    OR v_protocol IS DISTINCT FROM '2026-07-28' THEN
    RAISE EXCEPTION 'server is not approved';
  END IF;
  IF p_schema_version IS DISTINCT FROM v_catalog THEN
    RAISE EXCEPTION 'schema version does not match';
  END IF;
  SELECT namespaced_name INTO v_namespaced
  FROM mcp_tool_definitions
  WHERE tenant_id = p_tenant_id
    AND server_id = p_server_id
    AND catalog_version = p_schema_version
    AND remote_name = p_remote_name;
  IF v_namespaced IS NULL THEN
    RAISE EXCEPTION 'tool was not found';
  END IF;
  SELECT allowed, effect INTO v_allowed, v_effect
  FROM mcp_tool_permissions
  WHERE tenant_id = p_tenant_id
    AND server_id = p_server_id
    AND remote_name = p_remote_name;
  IF v_allowed IS DISTINCT FROM true OR v_effect IS NULL OR v_effect NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'tool is not approved';
  END IF;
  SELECT max_concurrent, timeout_ms, max_cost_units, max_loop_depth
    INTO v_max_concurrent, v_timeout, v_max_cost, v_max_depth
  FROM mcp_execution_policy
  WHERE tenant_id = p_tenant_id;
  IF v_max_concurrent IS NULL THEN
    v_max_concurrent := 4;
    v_timeout := 3000;
    v_max_cost := 32;
    v_max_depth := 2;
  END IF;
  IF p_depth IS NULL OR p_depth < 1 OR p_depth > v_max_depth THEN
    RAISE EXCEPTION 'tool loop is too deep';
  END IF;
  IF p_cost_units IS NULL OR p_cost_units < 1 OR p_cost_units > v_max_cost THEN
    RAISE EXCEPTION 'cost limit is reached';
  END IF;
  IF p_parent_id IS NOT NULL THEN
    SELECT request_id, loop_depth, remote_name
      INTO v_parent_request, v_parent_depth, v_parent_name
    FROM mcp_tool_executions
    WHERE tenant_id = p_tenant_id
      AND id = p_parent_id;
    IF v_parent_request IS NULL OR v_parent_request IS DISTINCT FROM p_request_id OR p_depth IS DISTINCT FROM v_parent_depth + 1 THEN
      RAISE EXCEPTION 'tool loop is too deep';
    END IF;
    IF v_parent_name = p_remote_name THEN
      RAISE EXCEPTION 'tool loop is too deep';
    END IF;
    v_cursor := p_parent_id;
    WHILE v_cursor IS NOT NULL AND v_guard < 8 LOOP
      SELECT parent_execution_id, remote_name INTO v_next, v_seen
      FROM mcp_tool_executions
      WHERE tenant_id = p_tenant_id
        AND id = v_cursor;
      IF v_seen IS NULL OR v_seen = p_remote_name THEN
        RAISE EXCEPTION 'tool loop is too deep';
      END IF;
      v_cursor := v_next;
      v_guard := v_guard + 1;
    END LOOP;
    IF v_guard >= 8 THEN
      RAISE EXCEPTION 'tool loop is too deep';
    END IF;
  ELSIF p_depth <> 1 THEN
    RAISE EXCEPTION 'tool loop is too deep';
  END IF;
  SELECT count(*)::integer, COALESCE(sum(cost_units), 0)::integer
    INTO v_open, v_cost
  FROM mcp_tool_executions
  WHERE tenant_id = p_tenant_id
    AND status IN ('awaiting_approval', 'approved', 'dispatching');
  IF v_open >= v_max_concurrent THEN
    RAISE EXCEPTION 'concurrency limit is reached';
  END IF;
  IF v_cost + p_cost_units > v_max_cost THEN
    RAISE EXCEPTION 'cost limit is reached';
  END IF;
  v_idempotent := v_effect = 'read';
  v_status := CASE WHEN v_effect = 'read' THEN 'approved' ELSE 'awaiting_approval' END;
  v_approval := CASE WHEN v_effect = 'read' THEN 'not_required' ELSE 'pending' END;
  BEGIN
    INSERT INTO mcp_tool_executions (
      id,
      tenant_id,
      server_id,
      remote_name,
      namespaced_name,
      schema_version,
      request_id,
      tool_call_id,
      effect,
      idempotent,
      argument_hash,
      identity_hash,
      identity_expires_at,
      status,
      approval,
      loop_depth,
      parent_execution_id,
      cost_units,
      timeout_ms,
      dispatch_count,
      model_requests,
      evidence,
      created_at
    ) VALUES (
      p_id,
      p_tenant_id,
      p_server_id,
      p_remote_name,
      v_namespaced,
      p_schema_version,
      p_request_id,
      p_tool_call_id,
      v_effect,
      v_idempotent,
      p_argument_hash,
      p_identity_hash,
      p_identity_expires_at,
      v_status,
      v_approval,
      p_depth,
      p_parent_id,
      p_cost_units,
      v_timeout,
      0,
      0,
      p_evidence,
      p_now
    );
    RETURN QUERY SELECT
      p_id,
      v_status,
      v_approval,
      true,
      v_effect,
      v_namespaced,
      p_schema_version,
      p_request_id,
      p_tool_call_id,
      p_identity_expires_at,
      0,
      0,
      NULL::integer,
      NULL::text,
      NULL::integer,
      NULL::text,
      p_remote_name,
      p_server_id,
      v_timeout,
      p_depth,
      v_idempotent,
      p_cost_units;
    RETURN;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'mcp_tool_executions_request_call_key' THEN
        RAISE EXCEPTION 'request is invalid';
      END IF;
  END;
  SELECT * INTO v_existing
  FROM mcp_tool_executions
  WHERE tenant_id = p_tenant_id
    AND request_id = p_request_id
    AND tool_call_id = p_tool_call_id;
  IF v_existing.id IS NULL
    OR v_existing.argument_hash IS DISTINCT FROM p_argument_hash
    OR v_existing.remote_name IS DISTINCT FROM p_remote_name
    OR v_existing.schema_version IS DISTINCT FROM p_schema_version
    OR v_existing.server_id IS DISTINCT FROM p_server_id THEN
    RAISE EXCEPTION 'tool call does not belong to the request';
  END IF;
  RETURN QUERY SELECT
    v_existing.id,
    v_existing.status,
    v_existing.approval,
    false,
    v_existing.effect,
    v_existing.namespaced_name,
    v_existing.schema_version,
    v_existing.request_id,
    v_existing.tool_call_id,
    v_existing.identity_expires_at,
    v_existing.dispatch_count,
    v_existing.model_requests,
    v_existing.latency_ms,
    v_existing.outcome,
    v_existing.error_code,
    v_existing.error_message,
    v_existing.remote_name,
    v_existing.server_id,
    v_existing.timeout_ms,
    v_existing.loop_depth,
    v_existing.idempotent,
    v_existing.cost_units;
END;
$$;

ALTER FUNCTION reserve_mcp_execution(uuid, uuid, uuid, text, integer, text, text, text, text, timestamptz, integer, uuid, integer, timestamptz, bytea) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION reserve_mcp_execution(uuid, uuid, uuid, text, integer, text, text, text, text, timestamptz, integer, uuid, integer, timestamptz, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_mcp_execution(uuid, uuid, uuid, text, integer, text, text, text, text, timestamptz, integer, uuid, integer, timestamptz, bytea) TO llm_runtime;

CREATE FUNCTION claim_mcp_dispatch(p_tenant_id uuid, p_id uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed uuid;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  UPDATE mcp_tool_executions AS execution
  SET status = 'dispatching',
      dispatch_count = 1,
      dispatched_at = p_now
  WHERE execution.tenant_id = p_tenant_id
    AND execution.id = p_id
    AND execution.dispatch_count = 0
    AND execution.status = 'approved'
    AND execution.identity_expires_at > p_now
    AND (
      execution.effect = 'read'
      OR (execution.effect = 'write' AND execution.approval = 'granted')
    )
    AND EXISTS (
      SELECT 1
      FROM mcp_servers AS server
      WHERE server.tenant_id = execution.tenant_id
        AND server.id = execution.server_id
        AND server.enabled = true
        AND server.credential_state = 'active'
        AND server.connection_status = 'ok'
        AND server.protocol_mode = 'modern'
        AND server.protocol_version = '2026-07-28'
    )
  RETURNING execution.id INTO v_claimed;
  RETURN v_claimed IS NOT NULL;
END;
$$;

ALTER FUNCTION claim_mcp_dispatch(uuid, uuid, timestamptz) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION claim_mcp_dispatch(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_mcp_dispatch(uuid, uuid, timestamptz) TO llm_runtime;

CREATE FUNCTION finish_mcp_execution(
  p_tenant_id uuid,
  p_id uuid,
  p_status text,
  p_outcome text,
  p_latency_ms integer,
  p_error_code integer,
  p_error_message text,
  p_evidence bytea,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_status NOT IN ('succeeded', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'request is invalid';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('result', 'error', 'uncertain') THEN
    RAISE EXCEPTION 'request is invalid';
  END IF;
  IF p_error_message IS NOT NULL AND (
    char_length(p_error_message) < 1
    OR char_length(p_error_message) > 200
    OR p_error_message ~ '[[:cntrl:]]'
    OR p_error_message LIKE '%aes-256-gcm$%'
  ) THEN
    RAISE EXCEPTION 'request is invalid';
  END IF;
  UPDATE mcp_tool_executions
  SET status = p_status,
      outcome = p_outcome,
      latency_ms = p_latency_ms,
      error_code = p_error_code,
      error_message = p_error_message,
      evidence = p_evidence,
      finished_at = p_now
  WHERE tenant_id = p_tenant_id
    AND id = p_id
    AND status = 'dispatching'
    AND dispatch_count = 1
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

ALTER FUNCTION finish_mcp_execution(uuid, uuid, text, text, integer, integer, text, bytea, timestamptz) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION finish_mcp_execution(uuid, uuid, text, text, integer, integer, text, bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_mcp_execution(uuid, uuid, text, text, integer, integer, text, bytea, timestamptz) TO llm_runtime;

CREATE FUNCTION stop_mcp_execution(
  p_tenant_id uuid,
  p_id uuid,
  p_message text,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  UPDATE mcp_tool_executions
  SET status = 'failed',
      outcome = 'error',
      error_message = p_message,
      finished_at = p_now
  WHERE tenant_id = p_tenant_id
    AND id = p_id
    AND dispatch_count = 0
    AND status IN ('approved', 'awaiting_approval')
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

ALTER FUNCTION stop_mcp_execution(uuid, uuid, text, timestamptz) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION stop_mcp_execution(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stop_mcp_execution(uuid, uuid, text, timestamptz) TO llm_runtime;

CREATE FUNCTION recover_mcp_executions(p_tenant_id uuid, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  UPDATE mcp_tool_executions
  SET status = 'uncertain',
      outcome = 'uncertain',
      error_message = 'The execution outcome is uncertain.',
      finished_at = p_now
  WHERE tenant_id = p_tenant_id
    AND status = 'dispatching'
    AND dispatch_count = 1
    AND dispatched_at IS NOT NULL
    AND dispatched_at <= p_now - (timeout_ms * INTERVAL '1 millisecond');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION recover_mcp_executions(uuid, timestamptz) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION recover_mcp_executions(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recover_mcp_executions(uuid, timestamptz) TO llm_runtime;

CREATE FUNCTION decide_mcp_execution(
  p_tenant_id uuid,
  p_id uuid,
  p_identity_hash text,
  p_decision text,
  p_now timestamptz
)
RETURNS TABLE (
  id uuid,
  status text,
  approval text,
  action text,
  effect text,
  namespaced_name text,
  schema_version integer,
  request_id text,
  tool_call_id text,
  dispatch_count integer,
  model_requests integer,
  latency_ms integer,
  outcome text,
  error_code integer,
  error_message text,
  remote_name text,
  server_id uuid,
  timeout_ms integer,
  loop_depth integer,
  identity_expires_at timestamptz,
  idempotent boolean,
  cost_units integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_row mcp_tool_executions%ROWTYPE;
  v_action text;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  SELECT * INTO v_row
  FROM mcp_tool_executions
  WHERE tenant_id = p_tenant_id
    AND id = p_id
  FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'execution was not found';
  END IF;
  IF v_row.identity_hash IS DISTINCT FROM p_identity_hash THEN
    RAISE EXCEPTION 'execution identity is invalid';
  END IF;
  IF p_decision = 'grant' THEN
    IF v_row.status = 'awaiting_approval' AND v_row.effect = 'write' AND v_row.approval = 'pending' AND v_row.dispatch_count = 0 THEN
      IF v_row.identity_expires_at <= p_now THEN
        RAISE EXCEPTION 'execution identity expired';
      END IF;
      UPDATE mcp_tool_executions
      SET status = 'approved',
          approval = 'granted'
      WHERE tenant_id = p_tenant_id
        AND id = p_id;
      v_row.status := 'approved';
      v_row.approval := 'granted';
      v_action := 'granted';
    ELSE
      v_action := 'replayed';
    END IF;
  ELSIF p_decision = 'deny' THEN
    IF v_row.status = 'awaiting_approval' AND v_row.dispatch_count = 0 THEN
      UPDATE mcp_tool_executions
      SET status = 'denied',
          approval = 'denied',
          outcome = 'denied',
          finished_at = p_now,
          error_message = 'The write was denied.'
      WHERE tenant_id = p_tenant_id
        AND id = p_id;
      v_row.status := 'denied';
      v_row.approval := 'denied';
      v_row.outcome := 'denied';
      v_row.error_message := 'The write was denied.';
      v_action := 'denied';
    ELSE
      v_action := 'replayed';
    END IF;
  ELSIF p_decision = 'cancel' THEN
    IF v_row.status IN ('awaiting_approval', 'approved') AND v_row.dispatch_count = 0 THEN
      UPDATE mcp_tool_executions
      SET status = 'cancelled',
          outcome = 'cancelled',
          finished_at = p_now,
          error_message = 'The execution was cancelled.'
      WHERE tenant_id = p_tenant_id
        AND id = p_id;
      v_row.status := 'cancelled';
      v_row.outcome := 'cancelled';
      v_row.error_message := 'The execution was cancelled.';
      v_action := 'cancelled';
    ELSE
      v_action := 'replayed';
    END IF;
  ELSE
    RAISE EXCEPTION 'request is invalid';
  END IF;
  RETURN QUERY SELECT
    v_row.id,
    v_row.status,
    v_row.approval,
    v_action,
    v_row.effect,
    v_row.namespaced_name,
    v_row.schema_version,
    v_row.request_id,
    v_row.tool_call_id,
    v_row.dispatch_count,
    v_row.model_requests,
    v_row.latency_ms,
    v_row.outcome,
    v_row.error_code,
    v_row.error_message,
    v_row.remote_name,
    v_row.server_id,
    v_row.timeout_ms,
    v_row.loop_depth,
    v_row.identity_expires_at,
    v_row.idempotent,
    v_row.cost_units;
END;
$$;

ALTER FUNCTION decide_mcp_execution(uuid, uuid, text, text, timestamptz) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION decide_mcp_execution(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decide_mcp_execution(uuid, uuid, text, text, timestamptz) TO llm_runtime;

CREATE FUNCTION record_mcp_model_request(p_tenant_id uuid, p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  UPDATE mcp_tool_executions AS execution
  SET model_requests = 1
  WHERE execution.tenant_id = p_tenant_id
    AND execution.id = p_id
    AND execution.status = 'succeeded'
    AND execution.model_requests = 0
    AND EXISTS (
      SELECT 1
      FROM mcp_execution_policy AS policy
      WHERE policy.tenant_id = execution.tenant_id
        AND policy.model_followup = true
    );
  IF NOT FOUND THEN
    SELECT model_requests INTO v_count
    FROM mcp_tool_executions
    WHERE tenant_id = p_tenant_id
      AND id = p_id;
    RETURN COALESCE(v_count, 0);
  END IF;
  RETURN 1;
END;
$$;

ALTER FUNCTION record_mcp_model_request(uuid, uuid) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION record_mcp_model_request(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_mcp_model_request(uuid, uuid) TO llm_runtime;

CREATE FUNCTION load_mcp_execution_evidence(p_tenant_id uuid, p_id uuid)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_evidence bytea;
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  SELECT evidence INTO v_evidence
  FROM mcp_tool_executions
  WHERE tenant_id = p_tenant_id
    AND id = p_id;
  RETURN v_evidence;
END;
$$;

ALTER FUNCTION load_mcp_execution_evidence(uuid, uuid) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION load_mcp_execution_evidence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION load_mcp_execution_evidence(uuid, uuid) TO llm_runtime;

RESET ROLE;
