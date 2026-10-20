# Slice 01 architecture

Slice 01 adds a tenant-scoped OpenAI chat path on the Slice 00 service. Slice 00 authentication, health routes, key commands, pools, and migrations `001_schema.sql` and `002_security.sql` are unchanged.

## Request path

1. `POST /v1/chat/completions` reads `X-Tenant-ID` and `Authorization: Bearer`. A bad credential returns an OpenAI authentication error. Health and `GET /v1/tenant` keep their Slice 00 JSON errors.
2. The body must include `model` and text `messages`. `stream` may be omitted or false. Unknown fields, tools, images, audio, and unsupported response formats are rejected and are not forwarded.
3. If `INFERENCE_ENABLED` is not `true`, the handler returns `inference_disabled` and does not read the catalog or call upstream.
4. The static resolver loads that tenant's deployments and aliases inside one row-level-security transaction. `auto` selects the alias target. Any other name must be an enabled deployment whose connection is enabled. There is no score, fallback, or cross-tenant lookup.
5. Optional fields are checked against that deployment's capability list.
6. The same tenant transaction inserts one `proxy_requests` row and one `model_attempts` row, both `pending`, then loads the protected credential. The transaction commits before the model call. A failure here returns `service_unavailable` and does not call upstream.
7. The OpenAI SDK calls `OPENAI_BASE_URL` once with `maxRetries` 0, the deployment's upstream model id, and the deployment timeout. The caller abort and that timeout share one abort signal. Caller abort wins.
8. A second transaction stores status, monotonic duration, and reported token counts. If that update fails, the completion or the original error is still returned, the model is not called again, and a critical log names the request id and the attempt id.

The response `model` is the upstream id. Usage is copied only for integer counts. Missing usage stays missing.

## Data

`003_inference.sql` adds `provider_connections`, `model_deployments`, `model_aliases`, `proxy_requests`, and `model_attempts`. Each tenant-owned row has `tenant_id`, a UUID primary key, and a tenant-scoped composite foreign key. Request ids and attempt ids are independent. Rows store the deployment id, configuration version, connection id, and connection version. They do not store prompt or response text.

The migrator does not inherit `llm_owner`, and `llm_owner` already owns `tenants`, so this migration runs as `llm_owner` and resets the role before the version row is inserted. Row level security is forced on all five tables. The runtime role cannot select `protected_credential`. `load_provider_credential` returns ciphertext only when `app.tenant_id` matches and the connection is enabled.

Provider keys are AES-256-GCM ciphertext. The key is `PROVIDER_CREDENTIAL_KEY` in the process environment. It is not a tenant-secret scrypt verifier and it is not stored in PostgreSQL.

## Operator commands

The existing CLI registers one OpenAI connection per tenant, replaces the protected credential, enables or disables the connection, registers a deployment, enables or disables that deployment, sets the `auto` alias, and lists the configuration. The list has no credential material. The caller cannot set the upstream URL.

## Other routes

`GET /v1/models` lists that tenant's enabled deployment names and the `auto` alias. `GET /internal/v1/metrics/summary` requires both timestamps, caps the window at 32 days, and returns counts, reported token sums, and latency. It does not invent cost or quality.

## Rollback

The previous image looks for `002_security.sql` in its own migration directory. `003_inference.sql` does not remove that row or change Slice 00 tables, so the previous image can become ready and serve `GET /v1/tenant` on a database that also contains `003_inference.sql`.
