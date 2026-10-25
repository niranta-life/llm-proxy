# Architecture

Back to [README](../README.md)

This page maps the [high-level architecture](../README.md#high-level-architecture) to the code. It also lists the data model and the trust boundaries.

## Components and code

| Component | What it does | Code |
| --- | --- | --- |
| API + Authentication | Fastify routes. Checks `X-Tenant-ID` and the tenant secret against a scrypt verifier. Opens a tenant-scoped database transaction. | `src/http/app.ts`, `src/auth/authenticate.ts`, `src/secrets.ts`, `src/db/tenant-context.ts` |
| Request Normalization | Parses the OpenAI body into one canonical text request. | `src/inference/contract.ts`, `src/inference/validate.ts` |
| Capability Validation | Refuses any field that the deployment does not list. | `src/inference/validate.ts`, `src/inference/registry.ts` |
| Model Router | Resolves `auto` or a deployment name to one enabled deployment. | `src/inference/resolve.ts` |
| Circuit breaker | Rejects an attempt on an open deployment before the provider call. | `src/inference/breaker.ts`, `src/db/breaker.ts` |
| Admission | Rate and concurrency limits, and budget reservation. | `src/inference/admission.ts`, `src/db/admission.ts` |
| Provider Adapters | Turn the canonical request into each provider API and back. | `src/inference/adapter.ts`, `openai-stream.ts`, `anthropic.ts`, `anthropic-stream.ts`, `vertex*.ts`, `compatible.ts` (xAI, OpenRouter), `private.ts`, `private-serve.ts` (DGX) |
| Retries + Failover | One deadline and retry policy per deployment. Policy-checked fallback for `auto`, before any output. | `src/inference/execution-policy.ts`, `src/inference/fallback.ts`, `src/db/execution-policy.ts`, `src/db/fallback-policy.ts` |
| Execution | Runs the attempt loop for JSON and SSE responses. | `src/inference/execute.ts`, `src/inference/execute-stream.ts`, `src/inference/stream.ts` |
| Usage + Cost Tracking | Prices each attempt from registered prices. Settles the budget reservation. | `src/inference/cost.ts`, `src/inference/cost-store.ts`, `src/db/prices.ts` |
| Request Telemetry | Stores each request and attempt. Serves per-tenant metrics. | `src/inference/store.ts`, `src/inference/window.ts` |
| Key custody | Encrypts provider keys with AES-256-GCM. The key comes from `PROVIDER_CREDENTIAL_KEY`. | `src/credentials.ts` |
| Sample capture | Stores an approved text chat as an encrypted envelope. A completed text stream is included only when streaming capture is on. A bounded recent and diverse set is kept. Expired and revoked samples are deleted by a PostgreSQL job. Metadata routes return no content. An eligibility check reads metadata and does not run a replay. | `src/inference/samples.ts`, `src/inference/sample-selection.ts`, `src/inference/sample-jobs.ts`, `src/inference/sample-crypto.ts`, `src/inference/sample-eligibility.ts`, `src/inference/stream-capture.ts` |
| Logging | Removes secrets, prompts, and chat messages from logs. | `src/logger.ts`, `src/redact.ts` |
| Admin | All config changes. There is no HTTP admin API. | `src/cli.ts`, `src/db/inference-admin.ts`, `src/db/provision.ts` |

## Request path

1. Auth: the tenant secret is checked.
2. Validate: the body is checked and normalized.
3. Resolve: `model` becomes one deployment. The request and attempt rows are written.
4. Breaker: an open breaker rejects the attempt before the provider call.
5. Admission: limits are checked and the budget is reserved.
6. Adapter: the provider is called. Retry and fallback decide after each failed attempt. A new attempt goes back to step 4.
7. Cost and metrics: the attempt is priced and stored. The budget reservation is settled.

Fallback is allowed only before the proxy sends a response header or a response byte. After that, a failure ends the stream with an error. The proxy never joins output from two models.

## HTTP routes

| Route | Purpose |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Process and database health. No auth. |
| `GET /v1/tenant` | The caller's own tenant. |
| `POST /v1/chat/completions` | Text chat, JSON or SSE. |
| `GET /v1/models` | Enabled deployments and aliases for the tenant. |
| `GET /internal/v1/metrics/summary`, `/attempts`, `/breakers`, `/costs` | Per-tenant metrics. See [Metrics](metrics.md). |
| `GET /internal/v1/limits`, `GET /internal/v1/budgets/usage` | Per-tenant limit and budget state. See [Limits](limits.md). |
| `GET /internal/v1/request-features`, `GET /internal/v1/request-features/{requestId}` | Characteristics of completed chats. No prompt or completion text. See [Metrics](metrics.md). |
| `GET /internal/v1/samples`, `GET /internal/v1/samples/{sampleId}`, `GET /internal/v1/samples/stats` | Metadata and coverage counts for encrypted samples. No prompt, completion, or ciphertext. See [Metrics](metrics.md). |
| `DELETE /internal/v1/samples/{sampleId}` | Deletes one sample for the calling tenant. |
| `POST /internal/v1/samples/{sampleId}/eligibility-check` | Metadata-only replay eligibility for one target deployment. It does not decrypt the sample or start a replay. |

## Data model

All state is in PostgreSQL 16. Migrations are in `migrations/`. Every tenant table has row-level security on.

| Area | Tables |
| --- | --- |
| Tenants | `tenants`, `tenant_api_keys` |
| Providers and routing | `provider_connections`, `model_deployments`, `model_aliases`, `private_endpoint_allowlist` |
| Requests | `proxy_requests`, `model_attempts`, `request_features`, `request_samples`, `sample_deletions` |
| Policies | `execution_policies`, `fallback_policies`, `deployment_breakers`, `breaker_observations`, `sample_policies`, `sample_jobs` |
| Limits and budgets | `tenant_limit_policies`, `api_key_limit_policies`, `connection_limit_policies`, `deployment_limit_policies`, `connection_share_groups`, `limit_counters`, `concurrency_leases`, `attempt_admissions`, `tenant_budgets`, `budget_reservations`, `cost_ledger` |
| Cost | `price_versions`, `attempt_costs` |

A policy change stores a new version. The proxy does not edit a stored policy in place.

## Trust boundaries

- **Caller → proxy.** The caller holds a tenant id and secret only. It cannot pass a provider key or a provider URL.
- **Proxy → database.** The proxy logs in as `llm_auth` (secret checks) and `llm_runtime` (tenant work). Both roles are `NOBYPASSRLS`. The runtime role cannot read provider key ciphertext or secret verifiers. `llm_migrator` runs migrations. `llm_owner` owns the tables and cannot log in.
- **Proxy → provider.** Base URLs for hosted providers are fixed in code. A private endpoint must be on the tenant's allowlist with pinned addresses. Redirects are refused.
- **Operator → proxy.** Config changes only through the CLI, with database access. Nothing on the network can change config.
- **TLS.** The proxy does not terminate TLS. Put it behind a load balancer or reverse proxy that does.

## Planned: Continuous Learning System

Not built. The design:

- **History.** Reuse `proxy_requests`, `model_attempts`, and `attempt_costs` as the outcome record. An operator can store an approved text chat as an encrypted sample, including a completed text stream when streaming capture is on, and delete it when it expires or capture is turned off. An eligibility check reports whether that sample may be replayed later. Replay, a judge, and rankings are not built.
- **Evaluator.** Workers take jobs from a durable queue, replay stored requests on other deployments, and score them with a judge model.
- **Optimizer.** Writes per-task rankings. The router may use them for `auto` only, and only among deployments that pass the same policy checks as fallback. A named model still never switches.
- **Infra.** Redis for hot counters and the job queue, and an external secret manager for provider keys.
