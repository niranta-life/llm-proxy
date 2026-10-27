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
| Sample capture | Stores an approved text chat as an encrypted envelope. A completed text stream is included only when streaming capture is on. A bounded recent and diverse set is kept. The proxy process runs the cleanup job. Metadata routes return no content. An eligibility check reads metadata and does not start a replay. A capture failure does not change the chat result. | `src/inference/samples.ts`, `src/inference/sample-selection.ts`, `src/inference/sample-jobs.ts`, `src/inference/sample-crypto.ts`, `src/inference/sample-eligibility.ts`, `src/inference/stream-capture.ts` |
| Evaluation | Stores a bounded run of approved samples against one challenger. A dry run changes item state and does not call a model. A replay calls that pinned deployment through the adapter. An approved profile runs deterministic checks on the original output and the challenger output. The inference process does not start the worker. | `src/inference/evaluations.ts`, `src/inference/evaluation-profiles.ts`, `src/inference/validators.ts`, `src/inference/evaluation-worker.ts`, `src/inference/replay-request.ts`, `src/inference/replay-execution.ts`, `src/evaluation-worker.ts` |
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
8. Capture: a completed non-streaming chat may store one encrypted sample before the JSON response returns. A completed stream may store one sample after the caller has the last byte. The stream slot is released before that write. A capture or feature-extraction failure does not change the chat status and does not add a provider attempt.

Fallback is allowed only before the proxy sends a response header or a response byte. After that, a failure ends the stream with an error. The proxy never joins output from two models.

Replay is not a step on this path. The evaluation worker reads a queued job, decrypts one approved sample, and calls the pinned challenger through the adapter. See [Replay](#replay).

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
| `POST /internal/v1/evaluations/preflight`, `POST /internal/v1/evaluations` | Check a plan, then store a queued run. `mode` is `dry_run` or `replay`. These routes do not decrypt a sample and do not call a model. |
| `GET /internal/v1/evaluations`, `GET /internal/v1/evaluations/{id}`, `GET /internal/v1/evaluations/{id}/items` | Run and item status. The JSON has cost, latency, usage, status, and validator results. It has no prompt and no completion text. |
| `GET /internal/v1/evaluations/{id}/report` | Read-only comparison of one run. Matched samples only. It has counts, quality, cost, latency, reliability, model versions, and one recommendation. It has no prompt and no completion text. |
| `GET /internal/v1/evaluations/recommendations` | One recommendation per completed run for the caller. The page is bounded. A tenant filter that does not match the caller returns an empty page. |
| `POST /internal/v1/evaluations/{id}/cancel` | Cancel a queued run. The worker does not complete its items. |
| `POST /internal/v1/evaluation-profiles`, `POST /internal/v1/evaluation-profiles/{id}/versions`, `POST /internal/v1/evaluation-profiles/{id}/versions/{version}/approve` | Store a profile version and approve it. Approval freezes that version. |
| `POST /internal/v1/evaluation-profiles/{id}/versions/{version}/references`, `GET /internal/v1/evaluation-profiles/{id}/versions/{version}` | Store a trusted reference on a draft version, or read one profile version. The read has no model output. |

## Data model

All state is in PostgreSQL 16. Migrations are in `migrations/`. Every tenant table has row-level security on.

| Area | Tables |
| --- | --- |
| Tenants | `tenants`, `tenant_api_keys` |
| Providers and routing | `provider_connections`, `model_deployments`, `model_aliases`, `private_endpoint_allowlist` |
| Requests | `proxy_requests`, `model_attempts`, `request_features`, `request_samples`, `sample_deletions` |
| Evaluation | `evaluation_definitions`, `evaluation_definition_versions`, `evaluation_runs`, `evaluation_items`, `evaluation_jobs`, `evaluation_judge_jobs`, `evaluation_attempts`, `evaluation_profiles`, `evaluation_profile_versions`, `evaluation_references`, `evaluation_validator_results`, `evaluation_rubrics`, `evaluation_rubric_versions`, `evaluation_judge_calls`, `evaluation_judge_findings` |
| Policies | `execution_policies`, `fallback_policies`, `deployment_breakers`, `breaker_observations`, `sample_policies`, `sample_jobs` |
| Limits and budgets | `tenant_limit_policies`, `api_key_limit_policies`, `connection_limit_policies`, `deployment_limit_policies`, `connection_share_groups`, `limit_counters`, `concurrency_leases`, `attempt_admissions`, `tenant_budgets`, `budget_reservations`, `cost_ledger` |
| Cost | `price_versions`, `attempt_costs` |

A policy change stores a new version. The proxy does not edit a stored policy in place.

`request_samples` stores ciphertext and metadata. It does not store a second copy of the prompt as plaintext. `sample_deletions` records that a sample was removed and the reason. `sample_jobs` records one cleanup run. The cleanup worker is not a separate Compose service. `src/index.ts` starts it in the proxy process. The interval is 60 seconds. Each automatic run uses one idempotency key for the current hour and for every tenant. `cleanup-expired-samples` uses one key per tenant per minute.

`proxy_requests.traffic_class` is `production` or `evaluation`. A production chat stays `production`. A replay insert is `evaluation`.

`evaluation_attempts` stores the source sample, the original deployment, the challenger, the config and adapter versions, the execution parameters, the provider response id, the latency, the token counts, the cost, and the status. Challenger output is ciphertext. The attempt id is bound into that ciphertext. A log line names the attempt, the item, the status, and the reason. It does not name the prompt or the completion.

## Trust boundaries

- **Caller → proxy.** The caller holds a tenant id and secret only. It cannot pass a provider key or a provider URL.
- **Proxy → database.** The proxy logs in as `llm_auth` (secret checks) and `llm_runtime` (tenant work). Both roles are `NOBYPASSRLS`. The runtime role cannot read provider key ciphertext or secret verifiers. `llm_migrator` runs migrations. `llm_owner` owns the tables and cannot log in.
- **Proxy → provider.** Base URLs for hosted providers are fixed in code. A private endpoint must be on the tenant's allowlist with pinned addresses. Redirects are refused.
- **Operator → proxy.** Config changes only through the CLI, with database access. Nothing on the network can change config.
- **Key custody for samples.** `PROVIDER_CREDENTIAL_KEY` seals a new provider credential and wraps a new sample. `PROVIDER_CREDENTIAL_KEY_PREVIOUS` is an optional comma-separated list of retained 32-byte keys. Those keys open an older provider credential and an older sample. The HTTP server and the operator CLI both pass that list when they open a stored credential. A wrong key opens nothing. A changed ciphertext opens nothing. The current key still seals new values.
- **TLS.** The proxy does not terminate TLS. Put it behind a load balancer or reverse proxy that does. Each proxy process has its own stream slots. Two processes share one PostgreSQL database and the same sample rows.

## Replay

History, pinned replay, deterministic checks, an optional pinned judge, and a read-only evaluation report are in this release. The report recommends further testing or canary consideration. It does not change a route. Rankings that the router reads are not.

- **History.** `proxy_requests`, `model_attempts`, `attempt_costs`, and `request_features` store the outcome. An operator can also store an approved text chat as an encrypted sample, including a completed text stream when streaming capture is on. Capture is off by default. An eligibility check reports whether that sample may be replayed later. The check reads metadata only.
- **Run.** `POST /internal/v1/evaluations` stores one bounded run. `mode` is `dry_run` or `replay`. The challenger is one deployment name. `model=auto` is rejected for replay execution. The same idempotency key returns the stored run. A different body for that key returns HTTP 409.
- **Dry run.** The worker advances item state only when `EVALUATION_DRY_RUN` is true. That path does not call a model.
- **Replay.** A call runs only when `EVALUATION_EXECUTION_ENABLED` is true, the tenant id is in `EVALUATION_REPLAY_TENANTS`, and the job kind is `replay`. The worker uses that tenant's context. Before each provider call it rechecks expiry, ownership, replay permission, target approval, capability, residency, budget, rate, concurrency, and deployment health. A failed check does not call the provider. The worker reads breaker admission. It does not claim a production probe and it does not change the breaker row.
- **Call.** The worker rebuilds the canonical request from the sample and keeps the original parameters that the challenger supports. It calls the provider adapter. It does not call `POST /v1/chat/completions`. It does not resolve aliases. It does not run tools. It writes the attempt before the cost reservation, and the reservation before the provider call. A crash before dispatch does not call the provider. A crash after dispatch does not send the call again.
- **Record.** The challenger output uses the same tenant-scoped sample encryption. The operator JSON has cost, latency, usage, and status. It has no prompt and no completion text. `EVALUATION_EXECUTION_ENABLED=false` stops new replay calls. A call that already left the worker is not sent again.
- **Checks.** An approved profile version pins the validators for that run. The worker checks the original output and the challenger output. Each result is `pass`, `fail`, `not_applicable`, or `unknown`. A missing trusted reference is `unknown`. The checks do not call a judge. Output stays ciphertext.
- **Judge.** Judging is off by default. A judge job is its own row in `evaluation_judge_jobs`. One tenant id in `EVALUATION_JUDGE_TENANTS`, together with a budget of at most 1, turns it on for a replay run that pins an approved rubric and a judge deployment. The judge model is the pinned upstream model of that deployment. The worker sends the task, the rubric, Candidate X, Candidate Y, and a trusted reference when one exists. It does not send candidate model names, provider names, cost, latency, or routing recommendations. It compares the pair again in reverse order. A material disagreement is `unstable` or `inconclusive`. The judge cannot execute a tool. A judging failure does not change routing. Protected judge evidence stays ciphertext.
- **Routing.** Active aliases and fallback policy stay unchanged. A later production chat still follows the existing route.

The worker command is `node dist/evaluation-worker.js`. The image command stays `node dist/index.js`. The inference process does not start the worker. The queue is PostgreSQL. See [Operations](operations.md#evaluation-rollback).

## Planned

- **Optimizer.** Write per-task rankings. The router may use them for `auto` only, and only among deployments that pass the same policy checks as fallback. A named model still never switches. The router does not use a quality score today. A judge finding does not change that route.
- **Infra.** Redis for hot counters, and an external secret manager for provider keys. Evaluation jobs do not need Redis.
