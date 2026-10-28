# Operations

Back to [README](../README.md)

## Where it fits

This page covers the whole path. See the [request path](architecture.md#request-path).

Day-to-day start steps are on the [home page](../README.md). This page is the operator reference: configuration, health, migrations, incidents, and tests.

## What you need

- Colima, the Docker CLI, Docker Compose, and curl.
- Node.js 24 and `npm install` before tests or `scripts/check-deployed.mjs`.

`scripts/colima.sh` uses the Colima profile `default` and the socket `~/.colima/default/docker.sock`. Set `COLIMA_PROFILE` or `COLIMA_SOCKET` when yours differ. The script sets `DOCKER_HOST` for its own commands and does not change the Docker context.

Set the socket yourself before other `docker compose` commands:

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
```

```bash
scripts/colima.sh start
scripts/colima.sh start --build
scripts/colima.sh restart
scripts/colima.sh stop
scripts/colima.sh status
```

`npm run stack -- start` runs the same script. `restart --build` builds the image again and creates the containers again. `stop` keeps the database volume. Colima stops only with `--vm`. The image is `node:24-bookworm-slim`. If `DOCKER_HOST` is absent, tests use the selected Docker context.

## Check a running proxy

`scripts/check-deployed.mjs` sends request and response cases to a proxy that is already up. It does not call OpenAI.

```bash
node scripts/check-deployed.mjs --prepare-local
```

`npm run check:deployed -- --prepare-local` is the same command. It needs Colima, Docker, and Node.js. If Colima is down, the script starts the local Compose project, uses a mock server, checks HTTP, database, and process cases, restores the proxy environment, and removes the mock. The database volume stays. `--leave-prepared` does not restore the proxy environment.

For a proxy that is already in operation, pass `--base-url` or set `PROXY_BASE_URL`. `--help` shows the tenant ids, the secrets, and the mock URL that proxy must have. `--http-only` stops after the HTTP cases. Database and process cases run with `--prepare-local`, and also when `CHECK_ADMIN` is `local`.

Only `npm test` can read the backend process id of a pooled database session. The check script opens one session that does not set `app.tenant_id`, so that session reads no rows.

## Configuration

The process refuses to listen when a required value is missing or invalid.

| Variable | Required | Use |
| --- | --- | --- |
| `DATABASE_HOST` | yes | PostgreSQL host. |
| `DATABASE_PORT` | yes | PostgreSQL port. Integer from 1 through 65535. |
| `DATABASE_NAME` | yes | Database name. |
| `MIGRATOR_USER` | yes | Must be `llm_migrator`. |
| `MIGRATOR_PASSWORD` | yes | Password for the migration role. |
| `AUTH_USER` | yes | Must be `llm_auth`. |
| `AUTH_PASSWORD` | yes | Password for the authentication role. |
| `RUNTIME_USER` | yes | Must be `llm_runtime`. |
| `RUNTIME_PASSWORD` | yes | Password for the runtime role. |
| `HOST` | no | Listen address. Default `0.0.0.0`. |
| `PORT` | no | Listen port. Default `8080`. Integer from 1 through 65535. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error`. Default `info`. |
| `INFERENCE_ENABLED` | no | `true` or `false`. Default `false`. Any other value is invalid. |
| `PROVIDER_CREDENTIAL_KEY` | when inference is on | 32-byte key in base64. The CLI needs it too when it stores a provider key. |
| `OPENAI_BASE_URL` | no | OpenAI base URL. Default `https://api.openai.com/v1`. Must be an `http` or `https` URL with no user name or password. |
| `MAX_ACTIVE_STREAMS` | no | Open streams in this process. Default `32`. Integer from 1 through 10000. |
| `MAX_STREAMS_PER_TENANT` | no | Open streams for one tenant in this process. Default `32`. Same range. Not shared with another process. |
| `STREAM_SHUTDOWN_DRAIN_MS` | no | Drain time after `SIGTERM` or `SIGINT`. Default `5000`. Integer from 0 through 600000. |
| `EVALUATION_EXECUTION_ENABLED` | no | `true` or `false`. Default `false`. A `true` value does not call a model by itself. |
| `EVALUATION_REPLAY_TENANTS` | no | Comma-separated tenant ids. Default empty. Invalid text is a configuration error. Ids are stored in lowercase. Duplicate ids are kept once. |
| `EVALUATION_DRY_RUN` | worker only | `true` or `false`. Default `false`. `true` lets the evaluation worker advance dry-run items. It does not call a model. |
| `EVALUATION_WORKER_DRAIN` | worker only | `true` or `false`. Default `false`. `true` makes the worker exit after the queue is idle. An idle drain can tick once when one schedule tenant is named and execution is on. |
| `EVALUATION_SCHEDULE_TENANTS` | no | One tenant id. Default empty. Empty means the scheduler creates no run and makes no provider call. Two ids are a configuration error. The id is stored in lowercase. |
| `EVALUATION_GLOBAL_KILL` | no | `true` or `false`. Default `false`. `true` stops new evaluation work even when the database flag is false. Any other text is a configuration error. |

The proxy does not listen with TLS. Compose passwords are for local development. There is no external secret manager. Git does not track `.env.live`, and a Docker build does not copy it.

## Health

`GET /health/live` returns `{"status":"live"}`.

`GET /health/ready` returns HTTP 200 `{"status":"ready","database":"ready"}` only when Postgres is reachable and `schema_migrations` contains the latest migration for this image. Otherwise it returns HTTP 503 `{"status":"not_ready","database":"unavailable"}`. Live stays 200.

If the database drops after the process is listening, the process keeps running. Ready goes to 503. Live stays 200.

Tenant routes are `GET /v1/tenant`, `GET /v1/models`, and `POST /v1/chat/completions`. The read routes under `/internal/v1/` use the same two tenant headers. Any other path returns HTTP 404 `{"error":"not_found"}`. An unhandled error returns HTTP 500 `{"error":"internal_error"}`.

## Database roles

The proxy connects only as `llm_migrator`, `llm_auth`, or `llm_runtime`. Those three roles are not superusers and cannot bypass row-level security.

`llm_owner` is `NOLOGIN`. It has `BYPASSRLS` and `CREATE` on `public`. It owns the tables and the `SECURITY DEFINER` functions. `llm_migrator` is a `NOINHERIT` member of `llm_owner`, so a person with the migration password can `SET ROLE llm_owner` and bypass row-level security. Keep that password secret. A tenant request does not use `llm_owner`.

The authentication role can run only `list_active_key_verifiers`. The runtime role can read tenant rows under row-level security and cannot read the verifier or the provider ciphertext. A `SECURITY DEFINER` function returns ciphertext only when the tenant in the transaction matches the row and the connection is enabled.

Migrations do not create the roles. Compose runs `docker/postgres/init.sh` as the database superuser. Tests set the same role attributes with `bootstrapRoles`. Those init scripts run only when the database volume is empty. Do not remove the volume to "reset" a running project.

You can use a PostgreSQL major version other than 16 when that version has row-level security. The local image is PostgreSQL 16.

## Logs

Each log line is one JSON object. Redaction removes a bearer token, a `yck_` tenant secret, a scrypt verifier, a provider key with the prefix `sk-`, AES-GCM ciphertext, and any field whose name identifies a secret, a prompt, or a chat message.

## Migrations

SQL files in `migrations/` apply in lexical order, once, before the proxy listens. Each file is recorded in `schema_migrations`. A later start does not apply a file that is already recorded, and it does not delete rows. Do not edit a file after it has been applied. This tree has migrations `001` through `026`. It drops no table and no column.

| File | What it adds |
| --- | --- |
| `001_schema.sql` | Base tables. |
| `002_security.sql` | Tenant secret check and row-level security. |
| `003_inference.sql` | Inference tables. It does not change `001` or `002`. |
| `004_anthropic.sql` | Nullable Anthropic columns and functions. Existing OpenAI rows stay as they are. |
| `005_openai_streaming.sql` | Streaming flags and stream metadata. Existing rows stay non-streaming. |
| `006_anthropic_streaming.sql` | Streaming for OpenAI and Anthropic. Later files allow Vertex, xAI, OpenRouter, and approved DGX. |
| `007_stream_interrupted.sql` | Stream status `interrupted`. |
| `008_provider_registry.sql` | Room for Vertex, xAI, OpenRouter, and private DGX configuration. |
| `009_vertex_provider.sql` | Vertex identity, API version, and Vertex streaming. |
| `010_compatible_providers.sql` | OpenRouter routing, xAI and OpenRouter streaming, and the reported model and provider on an attempt. |
| `011_private_endpoint.sql` | Private endpoint allowlist, deployment concurrency, DGX streaming, and `validated_mock`. It does not record `validated_live`. |
| `012_cost_accounting.sql` | Price versions, attempt cost, and a service tier on a deployment. |
| `013_execution_policy.sql` | Retry policy and attempt history columns. |
| `014_provider_breaker.sql` | A breaker for one deployment. |
| `015_tenant_limits.sql` | Tenant limits, concurrency leases, monthly budgets, and a cost ledger. |
| `016_fallback_policy.sql` | A versioned fallback policy for the alias `auto`. |
| `017_request_features.sql` | Characteristics of a completed chat. No prompt or completion text. |
| `018_sample_capture.sql` | A versioned sample policy and encrypted samples. The table stores ciphertext only. |
| `019_sample_retention.sql` | Sample expiry, a metadata deletion audit, and a durable cleanup job. |
| `020_stream_samples.sql` | Streaming capture flag and metadata columns for replay eligibility. Sample rows still store ciphertext only. |
| `021_evaluation_orchestration.sql` | Evaluation definitions, runs, items, and dry-run worker jobs. The rows store metadata only. |
| `022_evaluation_replay.sql` | Replay jobs, replay attempts, and evaluation traffic on `proxy_requests`. Challenger output is ciphertext. Dry-run rows stay valid. |
| `023_evaluation_validators.sql` | Evaluation profiles, profile versions, trusted references, and validator results. An approved version is immutable. Output stays ciphertext. |
| `024_evaluation_judgments.sql` | Versioned judge rubrics, blind judge calls, and combined findings. Judge evidence is ciphertext. A judge job is a separate row. The file drops no constraint, table, or column. |
| `025_evaluation_schedules.sql` | Tenant schedules, schedule decisions, evaluation budget reservations, and one global kill switch. A referenced sample can be wiped in place. The file drops no constraint, table, or column. |
| `026_routing_policies.sql` | Immutable routing-policy versions, activation history, and one decision row per production chat. Shadow mode records the decision. It does not choose a deployment. The file drops no constraint, table, or column. |

Readiness for this tree checks for `026_routing_policies.sql`. An image that expects `025_evaluation_schedules.sql` stays ready on this database because that row remains recorded. An image that expects `024_evaluation_judgments.sql` stays ready on this database because that row remains recorded. An image that expects `023_evaluation_validators.sql` stays ready on this database because that row remains recorded. An image that expects `022_evaluation_replay.sql` stays ready on this database because that row remains recorded. An image that expects `021_evaluation_orchestration.sql` stays ready on this database because that row remains recorded. An image that expects `020_stream_samples.sql` stays ready on this database because that row remains recorded. An image that expects `019_sample_retention.sql` stays ready on this database because that row remains recorded. An image that expects `018_sample_capture.sql` stays ready because that row remains recorded. An image that expects `017_request_features.sql` stays ready because that row remains recorded. The image `fb62fa7` stays ready because `016_fallback_policy.sql` remains recorded. Its latest migration file is `016_fallback_policy.sql`.

An older image can start on this database when `schema_migrations` still contains the latest file that image knows. Later rows can stay. Do not delete migration rows. Do not delete provider, price, policy, or breaker rows to roll back a behavior. Turn the behavior off with the CLI.

To run an older image, build it from that commit, stop the current app, and start the old image on the same Docker network with the same database settings. Then remove that container and start the Compose app again. Leave the volume in place.

## Incidents

These changes affect one tenant, or one deployment, and do not call the provider for the thing you just disabled.

- Turn retry off with `set-execution-policy`, `--deployment`, and `--retries false`. The command also needs the three deadline flags and the two backoff flags. See [Retry](retry.md).
- Turn fallback off with `set-fallback-policy` and `--enabled false`. A named deployment still does not switch.
- Turn sample capture off with `set-sample-policy` and `--mode disabled` or `--mode metadata_only`. A new chat then stores no sample. A sample stored earlier is hidden on the next read. The ciphertext row stays until cleanup deletes it as revoked, or until it expires under a policy that still allows encrypted content. Replay and judge disclosure stay off unless you set them. Streaming capture stays off unless you set `--streaming-capture true`. A completed text stream then stores one encrypted sample. A stream that does not finish stores no replay-ready sample. Feature extraction and capture are optional. A failure in either one does not change the chat status and does not add a provider attempt.
- To rotate the wrapping key, set `PROVIDER_CREDENTIAL_KEY` to the new 32-byte key and set `PROVIDER_CREDENTIAL_KEY_PREVIOUS` to the old key. Restart the proxy. New samples and new provider credentials use the new key. The old key still opens samples and provider credentials that it sealed. The operator CLI uses those same keys when it opens a stored credential. A wrong key opens nothing. Check one old sample and one new sample before you drop the previous key.
- If cleanup stops after the delete is committed, the job stays `running` until its lock time. Set `locked_until` in the past for that idempotency key, then run `cleanup-expired-samples` again. The second run deletes nothing that was already audited. Two cleanup commands for the same tenant in the same minute share one job key. One of them claims the job. The expired rows are deleted once.
- A proxy process can stop after a sample is stored. Another process that uses the same database still serves chat and still sees that sample. `SIGKILL` does not roll the sample back.
- A hard check that cannot take the admission lock returns HTTP 503 `admission_unavailable` and does not call the provider. The database stays in place. A later chat uses it again. Do not drop the database to clear that error.
- Disable one deployment with `set-deployment-enabled`, `--name`, and `--enabled false`. The next request for that name returns `model_not_found`.
- Disable one breaker with `set-deployment-breaker`, `--deployment`, and `--enabled false`.
- Reset one breaker with `reset-deployment-breaker` and `--deployment`. The next chat can reach the upstream.
- Run `recover-budget` to close a finished attempt that still holds a reservation. A second run does not settle it again. An uncertain charge stays provisional.
- Stop new evaluation work with `EVALUATION_GLOBAL_KILL=true`, or with `POST /internal/v1/evaluation-controls` and `{"killSwitch": true}` from the named schedule tenant. Leave `EVALUATION_SCHEDULE_TENANTS` empty to keep the scheduler off. A cancelled schedule run keeps its reservation. The amount is not returned to the daily budget.
- If a sample delete returns while an evaluation still points at that sample, the ciphertext is wiped and the row stays so the foreign key remains. The sample route then returns 404. The worker records `sample_not_owned` and does not call the provider.

A hard check that cannot reach the database returns HTTP 503 `admission_unavailable` and does not call the provider.

During a chat, the request stays `pending` until a terminal status is stored. A completed response stores `succeeded`. A rejected response stores `failed`. A stream stores one stream status. Shutdown stores `interrupted` when the row write succeeds. A priced success stores cost status `estimated`. Missing usage stays `unknown`, with a null amount. One request uses at most two upstream attempts, and that request does not both retry and fall back.

Read counts on `GET /internal/v1/metrics/summary`, attempt history on `GET /internal/v1/metrics/attempts`, the budget on `GET /internal/v1/budgets/usage`, the limits on `GET /internal/v1/limits`, breaker state on `GET /internal/v1/metrics/breakers`, request characteristics on `GET /internal/v1/request-features`, and sample metadata on `GET /internal/v1/samples`. See [Metrics](metrics.md). The sample routes return no prompt, no completion, and no ciphertext.

## Capture release

Use this order. Do not skip a step.

1. Turn metadata collection on with `--mode metadata_only` and `--content-capture false`. Confirm `GET /internal/v1/request-features` returns characteristics and no prompt or completion.
2. Leave content capture off. The default sample mode stores no content. Streaming capture defaults to false.
3. Turn `--mode encrypted_sample` and `--content-capture true` on for one test tenant. Leave every other tenant disabled or metadata-only.
4. Send synthetic requests only. Do not send approved business data yet.
5. Open one stored sample with the current key. Confirm a wrong key and a changed ciphertext open nothing. Run `cleanup-expired-samples` on an expired synthetic sample and confirm the row is gone and the deletion reason is `expired`.
6. Turn capture off with `--mode disabled` and confirm the sample route returns 404 at once. Readiness for `020_stream_samples.sql` stays 200. Historical ciphertext stays until the active policy or the expiry rule deletes it.
7. Only after those checks, capture approved business data for a tenant whose policy, classification, provider, and deployment list allow it.

`POST /internal/v1/samples/{sampleId}/eligibility-check` reports metadata only. It does not start a replay.

## Evaluation

`POST /internal/v1/evaluations/preflight` checks a plan. `POST /internal/v1/evaluations` stores a queued run when the check passes. The routes do not decrypt a sample and do not call a model. `mode` is `dry_run` or `replay`. Cancel a queued run with `POST /internal/v1/evaluations/{id}/cancel`. The run stays `cancelled` and the worker does not complete its items.

A replay worker decrypts one approved sample in that tenant. It calls the pinned challenger through the provider adapter. It does not call `POST /v1/chat/completions`. It does not use `model=auto`. It does not run tools. It stores the challenger output as ciphertext. Operator JSON has cost, latency, usage, and status. It has no prompt and no completion text. The worker reads breaker state. It does not claim a production probe and it does not change the breaker row.

A replay call runs only when `EVALUATION_EXECUTION_ENABLED` is `true`, the tenant id is in `EVALUATION_REPLAY_TENANTS`, and the job kind is `replay`. Dry-run jobs stay on the dry-run path. That path does not call a model.

`POST /internal/v1/evaluation-profiles` stores a profile, a task category, and a validator configuration. `POST /internal/v1/evaluation-profiles/{id}/versions` stores a later version. `POST /internal/v1/evaluation-profiles/{id}/versions/{version}/approve` approves that version. Approval freezes the configuration. A later version does not change an approved version. `POST /internal/v1/evaluation-profiles/{id}/versions/{version}/references` stores a trusted reference while the version is a draft. The reference is not a model output.

A replay run can pin one approved profile version. The worker checks the original output and the challenger output with that same version. Each result is `pass`, `fail`, `not_applicable`, or `unknown`. A missing reference is `unknown`. A task category that does not match the sample is `not_applicable`. A draft profile does not produce `pass` or `fail`. The item JSON lists the validator id, the version, the candidate, the result, the measured value, the evidence code, the error classification, the reference flag, and the time. It has no prompt and no completion text. The checks do not call a judge. Output stays ciphertext.

`POST /internal/v1/evaluation-rubrics` stores a rubric and its criteria for one task category. Approval freezes that version. A replay run can pin one approved rubric and one judge deployment. The judge budget is at most 1 USD. Judging stays off until `EVALUATION_JUDGE_TENANTS` names one tenant. The worker then compares the original output and the challenger output, and repeats the comparison in reverse order. The operator item lists the finding, the judge model, the rubric version, the stop reason, and the expense fields. It has no prompt and no completion text. A judging failure does not change routing.

`GET /internal/v1/evaluations/{id}/report` reads one run. `GET /internal/v1/evaluations/recommendations` reads one page of completed runs for the caller. Both are read-only. `promising` and `eligible_for_canary` require a passed quality gate. Judge wins with no pass or fail result stay inconclusive. `eligible_for_canary` does not enable a route, an alias, or a fallback policy. The report uses matched samples only. It keeps historical latency separate from evaluation latency. A missing cost stays missing. The body has no prompt and no completion text.

`POST /internal/v1/evaluation-schedules` stores one schedule for the tenant named in `EVALUATION_SCHEDULE_TENANTS`. The header `Idempotency-Key` is required. The same key and the same body return HTTP 200. A different body for that key returns HTTP 409. A tenant that is not named receives HTTP 404. `POST /internal/v1/evaluation-schedules/disable` turns the schedule off. `POST /internal/v1/evaluation-schedules/tick` and `POST /internal/v1/evaluation-schedules/runs` take an empty body and an idempotency key. HTTP 201 means a new run. HTTP 200 means the stored decision. One tick can create one run per tenant per UTC day. A skip does not use that slot unless the same idempotency key is sent again. The decision lists `action`, `skipReason`, `reasonCodes`, `selectedSampleIds`, and `runId`. It has no prompt and no completion text.

Skip reasons are `scheduler_disabled`, `tenant_not_enabled`, `schedule_disabled`, `global_kill_switch`, `no_eligible_samples`, `budget_too_small`, `judge_budget_exhausted`, `production_capacity_constrained`, `challenger_call_limit`, and `concurrent_job_limit`. Run reasons are `bounded_sample`, `new_samples`, `stale_evidence`, `quality_regression`, `version_change`, `low_coverage`, `efficiency_improvement`, `high_uncertainty`, and `workload_volume`.

The daily limit and the global daily limit are at most 1 USD. The monthly limit and the global monthly limit are at most 20 USD. `maxSamples` is 1 through 20. `maxChallengerCalls` is 1 through 100. `maxJudgeCalls` is 0 through 40. The per-run judge ceiling on a replay stays 1 USD. A pinned rubric needs two judge calls in the schedule budget for each selected sample, or the tick skips `judge_budget_exhausted`. `maxConcurrentJobs` is 1 through 10. `maxDurationMs` is 1000 through 600000. The worker cancels a schedule run that is still open after that duration. The cancellation does not refund the reservation.

A hard concurrency limit that is already full makes the tick skip `production_capacity_constrained`. Observe mode does not block evaluation. The estimate is reserved before the worker calls the provider. The worker rechecks the sample and the deployment immediately before dispatch. A failed recheck does not call the provider. A call that already left the worker is not sent again after a crash.

`GET /internal/v1/evaluation-schedules/drift?asOf=` reads stored evidence at or before that time. A run counts only when `created_at` and `updated_at` are at or before `asOf`. A validator counts only when its `created_at` is at or before `asOf`. An attempt counts only when its `created_at` and `updated_at` are at or before `asOf`. The body has `statements`, `workloadMixChange`, `limits`, and `historical: true`. A statement can show quality drift, schema validity regression, latency regression, reliability regression, a model version change, a price version change, and a new deployment. `mixed_population`, `mixed_task_category`, `mixed_profile`, `mixed_rubric_version`, and `insufficient_history` name a limit. Those groups are not pooled into one rate.

The evaluation worker calls the tick when it is idle, execution is on, dry-run is off, and exactly one schedule tenant is named. The inference process does not start that loop. Compose does not set `EVALUATION_SCHEDULE_TENANTS` or `EVALUATION_GLOBAL_KILL`. Live DGX evaluation stays off.

## Routing policy

`POST /internal/v1/routing/policies` stores one immutable version for the alias `auto`. The header `Idempotency-Key` is required. The same key and the same body return HTTP 200. A different body for that key returns HTTP 409. A new key returns HTTP 201. The body names one baseline deployment, one to eight candidate deployments, a minimum pass rate, a minimum number of valid pairs, a maximum cost per request, a maximum latency, and one or more task segments. The response includes the configuration digest, the status, the activation epoch, and the activation history. It has no prompt and no completion text.

`POST /internal/v1/routing/policies/{id}/validate` moves `draft` to `validated`. `POST /internal/v1/routing/policies/{id}/status` moves `validated` to `shadow` or `disabled`, and `shadow` to `disabled`. Both calls send `expectedEpoch`. A stale epoch returns HTTP 409. A second `shadow` policy for the same alias returns HTTP 409. `canary` and `active` are not statuses.

`routing:admin` is required to create, validate, or change status. `routing:read` is required to list policies, read one policy, or read `GET /internal/v1/routing/decisions/{requestId}`. The permission is a static grant on the tenant secret. A chat secret without those grants can still call `POST /v1/chat/completions`.

A decision row records the tenant, the request id, the alias, the baseline, the selected deployment, the policy version, the activation epoch, the feature-extractor version, the routing mode, and the reason codes. It does not store a prompt or a response. `static` means no shadow policy is in force and the alias baseline ran. `shadow` means a shadow policy was recorded and the alias baseline still ran. `bypass` means the caller named a deployment. The selected deployment is the deployment the router resolved before any fallback. Shadow mode does not add a provider call and does not change the chat body.

No shadow row is the default. Existing alias and fallback routing stay in force.

## Routing policy rollback

Leave `026_routing_policies.sql` applied. Do not delete that version row. Leave every routing policy out of `shadow`, or move a shadow policy to `disabled`. A `model=auto` request still uses the alias baseline. A named deployment still uses that deployment. The chat body stays the same. Readiness for this tree checks for `026_routing_policies.sql`. Readiness for an image that expects `025_evaluation_schedules.sql` still finds that version row.

## Evaluation rollback

Stop the evaluation worker. Leave `EVALUATION_EXECUTION_ENABLED` unset or `false`. Leave `EVALUATION_REPLAY_TENANTS` empty. Leave `EVALUATION_JUDGE_TENANTS` empty. Leave `EVALUATION_SCHEDULE_TENANTS` empty. Leave `EVALUATION_GLOBAL_KILL` unset or `false`. Leave `025_evaluation_schedules.sql` applied. Do not delete that version row. Leave `024_evaluation_judgments.sql`, `023_evaluation_validators.sql`, `022_evaluation_replay.sql`, and `021_evaluation_orchestration.sql` applied. The inference process does not start the evaluation worker. An empty schedule list creates no new run. Existing evaluation rows stay. A stored reservation stays `reserved`. Readiness for this tree checks for `026_routing_policies.sql`. Readiness for an image that expects `025_evaluation_schedules.sql` still finds that version row. Readiness for an image that expects `024_evaluation_judgments.sql` still finds that version row. Readiness for an image that expects `023_evaluation_validators.sql` still finds that version row. Readiness for an image that expects `022_evaluation_replay.sql` still finds that version row. Readiness for an image that expects `021_evaluation_orchestration.sql` still finds that version row. Readiness for an image that expects `020_stream_samples.sql` still finds that version row.

To run the worker as a second process:

```bash
EVALUATION_DRY_RUN=true node dist/evaluation-worker.js
```

`SIGTERM` stops new claims. A leased item stays recoverable after the lease time. Dry-run does not call a model. Set `EVALUATION_EXECUTION_ENABLED=false` to stop new replay calls. A call that already left the worker is not sent again.

## Docker deployment

Compose runs one `postgres:16` service and one `app` service. The image build context is this directory. The app listens on port 8080. Inference stays off until `INFERENCE_ENABLED` is true. `PROVIDER_CREDENTIAL_KEY` is required when inference is on. The cleanup worker starts inside the app process. It is not a second Compose service. The evaluation worker is a separate process. The image command stays `node dist/index.js`. Run `node dist/evaluation-worker.js` only when you want evaluation jobs. Dry-run state changes run when `EVALUATION_DRY_RUN` is `true`. That path does not call a model. A replay call runs when `EVALUATION_EXECUTION_ENABLED` is `true`, the tenant is listed in `EVALUATION_REPLAY_TENANTS`, and the job kind is `replay`. A judge call also requires that same tenant in `EVALUATION_JUDGE_TENANTS`. An empty judge list leaves judging off. Compose does not set `EVALUATION_SCHEDULE_TENANTS`, `EVALUATION_GLOBAL_KILL`, `EVALUATION_REPLAY_TENANTS`, or `EVALUATION_JUDGE_TENANTS`. The scheduler stays off. The image does not start the evaluation worker. `stop_grace_period` is 20 seconds. The ready check calls `http://127.0.0.1:8080/health/ready`.

Two or more app processes can share one database. Give each process the same `PROVIDER_CREDENTIAL_KEY` and the same previous keys. Each process keeps its own stream slots. Sample rows are shared through PostgreSQL.

To build a local image tag for this tree, use the Colima socket when that is the daemon that has the base image:

```bash
DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" docker build -t llm-proxy:slice-06e .
```

Leave a running Compose app and its volume in place. Do not remove `pgdata` to roll back capture.

## Tests

`npm test` needs Node.js 24 and a running Docker daemon. The tests start PostgreSQL with Testcontainers and local mocks for OpenAI, Anthropic, and a private endpoint. They do not call a provider on the internet. A Vertex, xAI, or OpenRouter live test runs only when `VERTEX_LIVE`, `XAI_LIVE`, or `OPENROUTER_LIVE` is `1`. `npm test` does not set those variables.

```bash
nvm use 24
npm test
```

## Clients in the proxy

- The OpenAI Node SDK is the OpenAI client, in the proxy and in the contract tests.
- The Vertex client is `@google/genai` version `2.30.0`.
- The Google credential client is `google-auth-library` version `10.9.1`. It uses Vertex mode plus the stored project and location.
- A non-stream Anthropic chat uses the Anthropic Node SDK. A stream does not.
- xAI uses `https://api.x.ai/v1`.
- OpenRouter uses `https://openrouter.ai/api/v1`.
- DGX uses the stored tenant endpoint.
- Every client sets `maxRetries` to `0`.

## Not done yet

- A live call to a DGX host.
- Input that is not text, and tool calls.
- A retry for every kind of error.
- Selection of a deployment by a quality score.
- OAuth, a login, saved caller state, and a user account.
- An HTTP route that revokes a key or changes a provider record.
- Production control of a database role password or a provider key.
- A payment for use.

There is no Kubernetes manifest, no continuous-integration pipeline, and no install on a public server in this repository.

## Related

- [Tenants](tenants.md)
- [Streaming](streaming.md)
- [Retry](retry.md)
- [Fallback](fallback.md)
- [Limits and budgets](limits.md)
