# Multi-tenant isolation

Two tenants were registered in one listen-path test.
Tenant B's catalog contains `claude-b` only.
Tenant B receives HTTP 404 for tenant A's deployment name.
Tenant B's secret with tenant A's id receives HTTP 401.
Those two calls add no upstream hit.
Tenant B's own deployment returns HTTP 200.
That call uses tenant B's credential.
The list for tenant B does not contain tenant A's deployment name, tenant A's provider key, or tenant A's secret.

Either streaming flag off returns HTTP 400.
The code is `unsupported_parameter`.
The parameter is `stream`.
The upstream call count does not change.

OpenAI streaming tests and non-streaming OpenAI and Anthropic tests passed in the full suite.
`git diff` for `migrations/001_schema.sql` through `migrations/005_openai_streaming.sql` is empty.
`006_anthropic_streaming.sql` is a later file.
It replaces `set_deployment_streaming` in one transaction.
It does not drop a column.
