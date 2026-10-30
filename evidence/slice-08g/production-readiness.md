# Production readiness

This report records the full Vitest run on this tree. That run passed 730 tests and skipped 5. It passed 70 files and skipped 3. The duration was 699.28 seconds. The exit was 0. The log is `regression-after.txt`. The measured table is the hardening cases inside that log.

## What the run proved

Three proxy processes served one PostgreSQL 16 database and controlled mock providers. The same routing key selected `h08g-quality` on two replicas, and the same pair selected `h08g-quality` again. A foreign tenant secret received HTTP 401 both times. After one process was killed and started again, the same key still selected `h08g-quality`. The completion model was `gpt-h08g-quality`. The stored decision did not contain the prompt.

Two tenants used different allowlists, credentials, policies, quality thresholds, budgets, and task segments. Tenant A selected `h08g-quality` for `general_qa`. A coding request on that policy stayed on the alias baseline with reason `segment_mismatch`. Tenant B selected `h08g-beta` for `coding`. A forced model stayed on `h08g-base` with routing mode `bypass`. A foreign decision read returned HTTP 404. A foreign policy read returned HTTP 404. A key without `routing:admin` received HTTP 403 on promote.

Concurrent promotion returned HTTP 201 and HTTP 409 and left one serving promotion. The stored activation epoch was 2. A repeated epoch returned `stale_activation`. An inconclusive judge snapshot returned `unstable_judge`.

The shadow rank selected `h08g-quality` with reasons `lowest_qualified_cost` and `latency_tie_break` from 8 candidates. A ninth candidate was rejected with HTTP 400. The recorded exclusions were `quality_failed` for a cheap unqualified model, a thin sample, a distribution gap, and a wide interval; `evidence_stale` for an old profile; and `latency_exceeded` for a slow model. The gap row stored `request_distribution_gap`. An unqualified snapshot moved the recommendation to `h08g-tie` and missed the cache. A new qualified snapshot restored `h08g-quality`.

A one-second freshness window made the newest quality snapshot stale. The rank excluded `h08g-quality` with `evidence_stale` and the chat used `h08g-tie`. A later qualified snapshot restored `h08g-quality`. A model-version change used the baseline with reason `baseline_fallback` and the promote gate returned `fresh_model_version`. A config-version change returned `fresh_config_version`. An unqualified newest snapshot left `h08g-quality`. An evidence refresh returned HTTP 201 and did not change the serving policy version.

Delayed feedback returned HTTP 201 and did not move the pin. A canary cover recorded 2 baseline assignments and 2 canary assignments. Concurrent rollback returned HTTP 400 for a body that asked the canary to promote itself, then HTTP 200 and HTTP 409. New `auto` traffic used `h08g-base`. A forced model stayed on `h08g-poor`. The guardrail pass stopped 1 rollout. Detection took 11.629 milliseconds. The stop took 3.706 milliseconds. The next `auto` chat used `h08g-base`. A second session saw the stopped rollout in 60.103 milliseconds.

A partial stream stored status `failed` and did not send `[DONE]`. A timeout returned HTTP 504 after one upstream call. A provider failure used one attempt. The next call returned HTTP 503 `circuit_open` and did not call the provider. A hard monthly amount of 0 returned HTTP 429 `budget_exceeded` and did not call the provider. The other tenant still received HTTP 200. Revoking `EXECUTE` on `admit_attempt` returned HTTP 503 `admission_unavailable` and made 0 upstream calls. After the grant, `auto` selected `h08g-quality`. Two overlapping chats returned HTTP 200 and HTTP 429 `concurrency_limited`. Authorized fallback used `h08g-base`. A forced failing model stayed on `h08g-poor` for one attempt. A cancelled stream did not send `[DONE]` and stored `client_aborted`. A second stream returned HTTP 503 `stream_capacity`. While that first stream was held, 1 attempt had `stream_status` `connecting` or `streaming`. After release the count was 0. An unqualified newest snapshot selected `h08g-tie`. A repeated stale epoch returned `stale_activation` and left the serving epoch unchanged. Killing the promotion worker left 1 serving promotion, and the next `auto` chat used `h08g-quality`. A concurrent disable of that model selected `h08g-tie`. Disabling the selected model and marking the tie unvalidated used `h08g-base`. The test then rejected new connections to the runtime database and terminated the existing sessions. Readiness returned HTTP 503 and `database` was `unavailable`. The next `model=auto` chat returned HTTP 500 `internal_error`, named no deployment, and made 0 upstream calls. The body did not contain the other tenant secret or deployment. The test then allowed connections again. The other tenant's next `model=auto` chat returned HTTP 200 on `h08g-beta` only. The first tenant's next `model=auto` chat selected `h08g-quality`.

OpenAI, Anthropic, Vertex AI, xAI, OpenRouter, and the DGX adapter each returned HTTP 200 for a completion, finished one stream, returned HTTP 504 on timeout, returned HTTP 502 on an upstream error, and recorded no `[DONE]` after cancel. Every DGX hit used `dgx.lab.internal`. None used a public provider host.

A runtime role saw 0 promotions for the other tenant. A pin that named the other tenant's deployment failed the composite foreign key. Promotion events, selection decisions, selection pins, and promotion identity rejected a rewrite. The applied migration is `031_routing_promotions.sql`. The image command in the Dockerfile is `node dist/index.js`. The image does not start the guardrail worker or the promotion worker.

Replica logs did not contain the tenant credential, the prompt, or the evaluation marker. The decision body did not contain the prompt or the marker. The mock provider received the evaluation marker 0 times.

## Measured performance

| Item | Value | Meaning |
| --- | --- | --- |
| Routing CPU | 0.62 seconds | Sum of `ps` CPU across three processes during 12 sequential chats. Not routing-only CPU. The stored figure is 0.6199999999999999. |
| Rank P50 / P95 / P99 | 2 / 6 / 8 milliseconds | Nearest-rank percentile of 34 stored `computation_ms` values. Wall clock, not CPU. |
| Client chat P50 | 74.196 milliseconds | 12 sequential chats, including the mock provider. The stored figure is 74.19583300000158. |
| Added inference latency P50 / P95 | 70.196 / 76.370 milliseconds | Client wall time minus stored `model_attempts.duration_ms` for the same 12 requests. The stored figures are 70.19583300000158 and 76.36962499999936. |
| Evidence-cache hit rate | 0.7352941176470589 | 25 `cache_hit` rows divided by 34 stored rankings for this tenant since the test clock mark. |
| Policy lookup | 68.559 milliseconds | Client-observed GET. The stored figure is 68.5590000000011. |
| Locks not granted | 0 | Maximum ungranted `pg_locks` across 47 samples while 4 delayed chats overlapped. The maximum lock count in those samples was 127. Deadlocks stayed 0. |
| Memory | 156448, 156032, 158640 KiB | Resident set of the three processes after the burst. |
| Throughput | 13.300 requests per second | 12 sequential chats divided by their wall time. The stored figure is 13.300310391671147. |
| Active streams | 1, then 0 | Attempts with `stream_status` `connecting` or `streaming` while one stream was held, then after release. |
| Canary split | 2 baseline, 2 canary | Cover before promotion. |
| Guardrail detection | 11.629 milliseconds | One pass. The stored figure is 11.629000000000815. |
| Guardrail stop | 3.706 milliseconds | Same pass. The stored figure is 3.705832999999984. |
| Rollback propagation | 60.103 milliseconds | Time until a second session read `stopped`. The stored figure is 60.103290999999444. |
| Success rate | 1 | The 12 sequential chats. |
| Stored cost | base 0.75 over 5; quality 1.56 over 26 | Unit amounts 0.15 and 0.06. |
| Realized savings | 0.09 per success | Difference of those stored unit amounts. |
| Predicted savings | not realized | The shadow estimate on this run was null. |

## Operator controls

Deployment, policy management, evidence qualification, shadow mode, canary rollout, guardrail tuning, emergency stop, rollback, model-version changes, incidents, Docker, and metrics are in `docs/operations.md`, `docs/architecture.md`, `docs/chat.md`, `docs/fallback.md`, `docs/comparison.md`, `docs/metrics.md`, and `README.md`.

Selection stays off until an operator enables it for one tenant and one task segment. Automatic promotion stays off. The proxy process does not start the guardrail worker or the promotion worker. Inference stays off until `INFERENCE_ENABLED` is true. Compose keeps one app service. The documented example image tag stays `llm-proxy:slice-06e`.

A candidate runs only when its newest snapshot for that task is qualified, fresh, and the profile model version and deployment config version match the deployment. A failed pin is not reused. The request uses the approved baseline when that baseline is permitted. Otherwise the chat returns HTTP 409 `baseline_unavailable`. A shadow rank can name an older model. That rank does not execute it.

## Image

`docker build -t llm-proxy:slice-08g .` exited 0. The image command is `["node","dist/index.js"]`. The entrypoint is `["docker-entrypoint.sh"]`, which belongs to the base image. The image does not start the guardrail worker or the promotion worker. Compose still has one app service. The documented example tag stays `llm-proxy:slice-06e`.

## Full suite

The same log includes the closed-database case. Readiness returned HTTP 503. The `model=auto` chat returned HTTP 500 `internal_error`, named no deployment, and made 0 upstream calls. After connections were allowed, the other tenant received `h08g-beta`. `routing-hardening-tests.txt` is the targeted hardening file from this tree. It passed 7 tests in 50.03 seconds. The table above uses the hardening cases in `regression-after.txt`.

## Unresolved limits

- Live OpenAI, Anthropic, Vertex AI, xAI, and OpenRouter calls did not run. The provider matrix used mock adapters.
- No live DGX call ran. This run used `dgx.lab.internal` only.
- Kubernetes manifests under `deploy/gcp/k8s` were not applied. The deployment file says the install is not verified on a live cluster. The three replicas were local processes.
- The control plane and the runtime share one database.
- Budgets are rows in `tenant_budgets`. There is no budget service. `admit_attempt` is `SECURITY DEFINER`, so revoking `SELECT` does not fail the budget read. The budget proof is a monthly amount of 0. The database proof rejects new connections and terminates existing sessions. It does not stop the PostgreSQL process.
- A policy accepts at most 8 candidates. The ninth model stays registered and is omitted.
- Shadow `estimatedSavings` is an estimate. This run stored null. Do not read 0.09 as a forecast.
- `GET /internal/v1/metrics/summary` does not store a routing P99.
- `computation_ms` is wall-clock rank time. The CPU figure is whole-process `ps` time.
- Added inference latency is client wall time minus stored attempt duration for the same request. It includes routing, admission, and the HTTP round trip. It is not a separate routing timer.
- The evidence-cache hit rate counts stored `routing_shadow_rankings.cache_hit` rows for this tenant. The cache is per process. It does not include the Wilson interval or the model version. The database check is the execution gate.
- The active-stream count is the number of attempts in `connecting` or `streaming`. It is not the in-process stream-gate gauge.
- The lock sample is the maximum ungranted `pg_locks` while 4 chats overlapped. A lock can start and end between samples. The sample does not prove the absence of contention.
- Policy lookup time includes the HTTP round trip.
- The 12-chat throughput is sequential. It is not a saturation result.
- `simulate` does not overlay live medians. Selection does.
- A Wilson change that does not insert a new snapshot was not used as the cache-miss proof. This run inserted a new snapshot.
- There is no continuous-integration pipeline and no public install in this repository.
- The node-pg client logged one deprecation when an audit check overlapped a query. The checks still rolled back.
