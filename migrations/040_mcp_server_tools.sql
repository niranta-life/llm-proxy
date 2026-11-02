-- Record which MCP server tools a tenant has approved.
-- Read tools start allowed. Inference and embedding start unapproved.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 039.
-- Rollback keeps this file applied. Removing a grant needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

CREATE TABLE mcp_server_tool_grants (
  tenant_id uuid NOT NULL,
  tool_name text NOT NULL,
  approved boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tool_name),
  CONSTRAINT mcp_server_tool_grants_name_check CHECK (
    tool_name IN (
      'list_models',
      'get_model_capabilities',
      'create_chat_completion',
      'create_embedding'
    )
  )
);

ALTER TABLE mcp_server_tool_grants OWNER TO llm_owner;
ALTER TABLE mcp_server_tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_server_tool_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_server_tool_grants_isolation ON mcp_server_tool_grants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mcp_server_tool_grants FROM PUBLIC;
GRANT SELECT ON mcp_server_tool_grants TO llm_runtime;

CREATE FUNCTION set_mcp_server_tool_grant(
  p_tenant_id uuid,
  p_tool_name text,
  p_approved boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM mcp_tenant_matches(p_tenant_id);
  IF p_tool_name IS NULL
    OR p_tool_name NOT IN (
      'list_models',
      'get_model_capabilities',
      'create_chat_completion',
      'create_embedding'
    )
    OR p_approved IS NULL THEN
    RAISE EXCEPTION 'request is invalid';
  END IF;
  INSERT INTO mcp_server_tool_grants (tenant_id, tool_name, approved)
  VALUES (p_tenant_id, p_tool_name, p_approved)
  ON CONFLICT (tenant_id, tool_name)
  DO UPDATE SET approved = EXCLUDED.approved, updated_at = now();
END;
$$;

ALTER FUNCTION set_mcp_server_tool_grant(uuid, text, boolean) OWNER TO llm_owner;
REVOKE ALL ON FUNCTION set_mcp_server_tool_grant(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_mcp_server_tool_grant(uuid, text, boolean) TO llm_runtime;

RESET ROLE;
