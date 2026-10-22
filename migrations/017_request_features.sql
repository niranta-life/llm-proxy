-- Additive request characteristics. One row per completed chat.
-- This file does not drop a column or a table.
-- This file does not edit migrations 001 through 016.
-- The table stores no message text, no completion text, and no credentials.
-- Rollback keeps this file applied.
-- Readiness for 016_fallback_policy.sql still finds that version row.

SET LOCAL ROLE llm_owner;

CREATE TABLE request_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  extractor_version integer NOT NULL CHECK (extractor_version > 0),
  task_category text NOT NULL CHECK (task_category IN (
    'classification',
    'extraction',
    'summarization',
    'reasoning',
    'coding',
    'translation',
    'writing',
    'general_qa',
    'unknown'
  )),
  classification_source text NOT NULL CHECK (classification_source IN ('caller_hint', 'rules', 'unknown')),
  input_token_estimate integer NOT NULL CHECK (input_token_estimate >= 0),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
  message_count integer NOT NULL CHECK (message_count BETWEEN 0 AND 100),
  instruction_present boolean NOT NULL,
  stream_requested boolean NOT NULL,
  structured_output boolean NOT NULL,
  tool_required boolean NOT NULL,
  conversation_depth integer NOT NULL CHECK (conversation_depth >= 0 AND conversation_depth <= message_count),
  input_size integer NOT NULL CHECK (input_size BETWEEN 0 AND 10000000),
  complexity_estimate text NOT NULL CHECK (complexity_estimate IN ('low', 'medium', 'high')),
  requested_model text NOT NULL CHECK (
    char_length(requested_model) BETWEEN 1 AND 128
    AND requested_model !~ '[[:space:]]'
  ),
  selected_deployment text NOT NULL CHECK (
    selected_deployment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND selected_deployment <> 'auto'
  ),
  execution_status text NOT NULL CHECK (execution_status IN ('succeeded', 'failed')),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  cost_attempt_id uuid,
  cost_status text CHECK (
    cost_status IS NULL
    OR cost_status IN ('estimated', 'provisional', 'reconciled', 'unknown')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  CONSTRAINT request_features_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES proxy_requests (tenant_id, id),
  CONSTRAINT request_features_attempt_fk
    FOREIGN KEY (tenant_id, cost_attempt_id) REFERENCES model_attempts (tenant_id, id),
  CONSTRAINT request_features_source_check CHECK (
    (classification_source = 'caller_hint')
    OR (classification_source = 'rules' AND task_category <> 'unknown')
    OR (classification_source = 'unknown' AND task_category = 'unknown')
  ),
  CONSTRAINT request_features_cost_check CHECK (
    (cost_attempt_id IS NULL AND cost_status IS NULL)
    OR (cost_attempt_id IS NOT NULL AND (cost_status IS NULL OR cost_status IN ('estimated', 'provisional', 'reconciled', 'unknown')))
  )
);

CREATE INDEX request_features_tenant_created_idx
  ON request_features (tenant_id, created_at DESC, id DESC);

ALTER TABLE request_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_features FORCE ROW LEVEL SECURITY;

CREATE POLICY request_features_isolation ON request_features
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON request_features FROM PUBLIC;
GRANT SELECT, INSERT ON request_features TO llm_runtime;

RESET ROLE;
