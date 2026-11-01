# End-to-end test 1

Back to [README](../../README.md)

This run started the local Compose stack with the operator OpenAI and Anthropic keys and called every shipped runtime capability. The date is 2026-10-31. The proxy listens on `http://127.0.0.1:8080`. Colima profile `default` is up. The Compose project is `llm-proxy`. Postgres 16 and the app are healthy.

`./llm-proxy-docker.sh keys` had already applied the operator file and exited 0. The command printed the tenant id `49ed4164-c4f7-4731-a219-9cbb7a29f466` and the path of the tenant file. It registered the deployments `openai` and `anthropic`. Inference is on. Selection stays off. Automatic promotion stays off. The script did not mark a deployment validated. Both deployments remain `unvalidated`.

Vertex, xAI, OpenRouter, and DGX were not called. Those keys are empty.

Two `GET /health/ready` calls returned HTTP 200. Both bodies are `{"status":"ready","database":"ready"}`. `./llm-proxy-docker.sh status` shows `inference: true` and provider keys `openai, anthropic`. The status text has no key value. `GET /v1/models` returns `object: list` with the models `openai` and `anthropic`.

## Result index

| Capability | Result |
| --- | --- |
| Tenants | pass |
| Chat | pass |
| Providers | fail |
| Streaming | fail |
| Retry | pass |
| Fallback | pass |
| Routing policy | pass |
| Evidence qualification | pass |
| Shadow ranking | pass |
| Canary routing | blocked |
| Governed promotion | blocked |
| Limits and budgets | pass |
| Cost | pass |
| Circuit breaker | pass |
| Metrics | pass |
| Request characteristics | pass |
| Encrypted samples | pass |
| Evaluation | pass |
| Cost of a schedule | pass |

Chat passes because the route returned a completion for Anthropic and the recorded proxy error for OpenAI. Providers fails because the OpenAI credential is expired. Streaming fails because the Anthropic stream stops after the text chunk. Canary routing and governed promotion are blocked on a qualified snapshot.

## What this run turned on

These changes apply to the local tenant only.

- Alias `auto` points at the deployment `openai`.
- Tenant streaming is on. Both deployments have streaming on.
- The OpenAI execution policy was set, then restored. Retries are false. The connection deadline is 30000 ms, the attempt deadline is 30000 ms, and the total deadline is 60000 ms.
- The Anthropic execution policy was set to retries true for one successful chat, then restored to retries false with the same deadlines.
- The fallback policy for alias `auto` is enabled. The only listed fallback deployment is `anthropic`. A live switch still cannot run, because no deployment is `validated_live`.
- Tenant limits are `observe`, 600 requests per minute, 8 concurrent requests, and 4 concurrent streams. A one-minute hard probe at 1 request per minute was restored to `observe`.
- The tenant budget is `observe` with a monthly amount of 25 USD.
- Verified prices are stored for `gpt-4o-mini` and `claude-sonnet-5-5`.
- The sample policy is version 2, mode `encrypted_sample`, with content capture and replay on for classification `internal`, providers `openai` and `anthropic`, and deployments `openai` and `anthropic`.
- The tenant key has `routing:admin` and `routing:read`.
- Routing policy `e2e-policy` is in `shadow` at epoch 3. Selection stays off.
- One qualification profile exists. Its snapshot status is `inconclusive`.
- One evaluation profile version is approved. One dry-run evaluation completed with zero model calls.
- One evaluation schedule is enabled. The app process was recreated from a scratch Compose override so this tenant is the only id in `EVALUATION_SCHEDULE_TENANTS`. `EVALUATION_EXECUTION_ENABLED` is false. `EVALUATION_GLOBAL_KILL` is false. The override is not in the repository.
- The OpenAI circuit breaker was opened by a 100 ms deadline, then disabled and reset.

## Tenants

Result: pass.

`GET /v1/tenant` returned HTTP 200. The body has `id`, `name`, and `keys`. The id is `49ed4164-c4f7-4731-a219-9cbb7a29f466`. The name is `local`. The key list has one key id, an empty label, `createdAt`, and `revokedAt: null`. The body has no secret.

`set-alias --alias auto --deployment openai` exited 0. The stdout object has `alias: auto`, `deployment: openai`, and an `aliasId`.

## Chat

Result: pass.

The request is `POST /v1/chat/completions`. The message asks for one word. `max_tokens` is 16. `task` is `general_qa`. The first calls also sent `temperature: 0`.

OpenAI, deployment header `openai`, attempt count 1, fallback `false`:

- HTTP 502.
- Error object: type `server_error`, code `upstream_error`, message `The upstream model request failed.`
- The attempt row stores `failure_class: unauthorized` and `error_code: upstream_error`.
- A direct call with the same operator key, outside the proxy, returned HTTP 401 and provider code `expired_secret_key`. The proxy does not copy that provider text into the client body.

Anthropic, with `temperature: 0`, deployment header `anthropic`:

- HTTP 502, code `upstream_error`.
- The attempt row stores `failure_class: client_error` and `stop_reason: invalid_request_error`.
- A direct call with `temperature: 0` returned HTTP 400. The provider message says temperature is deprecated for this model.

The follow-up omitted `temperature`.

Anthropic follow-up:

- HTTP 200.
- Body `object` is `chat.completion`. `model` is `claude-sonnet-5-5`.
- `finish_reason` is `stop`. The assistant content length is 4 characters.
- Usage is 18 prompt tokens, 4 completion tokens, and 22 total tokens.
- Headers: `x-deployment: anthropic`, `x-attempt-count: 1`, `x-fallback: false`.

The OpenAI follow-up stayed HTTP 502, code `upstream_error`, deployment `openai`, attempt count 1.

`POST /v1/feedback` on the first OpenAI request id used timestamp `2026-10-31T08:00:00Z`. That stamp was ahead of the server clock. The proxy returned HTTP 400, code `invalid_parameter`, param `timestamp`.

A second feedback call used the successful Anthropic request id, source `e2e`, metric `task_success`, result `pass`, and a timestamp 30 seconds behind the clock. The proxy returned HTTP 400, code `unapproved_source`, message `The feedback source is not approved.` Feedback needs a guardrail set that lists the source. Canary routing did not create a rollout, so no set was attached. The feedback call is blocked on that prerequisite.

## Providers

Result: fail.

`GET /v1/models` lists both enabled deployments. `list-inference` shows both enabled, capabilities `temperature,max_tokens`, and `validation_status: unvalidated`. The Anthropic upstream model is `claude-sonnet-5-5`. The OpenAI upstream model is `gpt-4o-mini`. The Anthropic endpoint is `https://api.anthropic.com`. The default max output tokens for Anthropic is 1024.

The OpenAI chat did not complete. The operator key is expired. The Anthropic chat completed when the request omitted `temperature`. A provider result requires both live chats to complete, so this capability fails.

Vertex, xAI, OpenRouter, and DGX were not called.

## Streaming

Result: fail.

`set-tenant-streaming --enabled true` exited 0. `set-deployment-streaming --enabled true` exited 0 for `openai` and for `anthropic`. Each deployment config version became 2 at that step.

The OpenAI stream, with `temperature: 0`, returned HTTP 502 and `content-type: application/json`. The event count is 0. That is the same expired-key failure as the unary chat.

The Anthropic stream omitted `temperature`. The proxy returned HTTP 200 and `content-type: text/event-stream`. The deployment header is `anthropic`. The body has two `data:` frames. The first frame is a `chat.completion.chunk` whose delta role is `assistant`. The second frame is a chunk whose delta content length is 4 characters. The body ends there. It has no `data: [DONE]` line.

The attempt row for that request stores `status: failed`, `error_code: invalid_upstream_response`, `failure_class: stream_started`, `stream_status: provider_failed`, `chunk_count: 2`, and `bytes_written: 400`.

A direct Anthropic stream for the same model emits `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop`. The `message_delta` usage object includes `output_tokens_details`. The proxy usage allow-list does not include that field, so the parser rejects the event after the text chunk is already written.

## Retry

Result: pass.

`set-execution-policy` for `openai` exited 0 with retries true, connection deadline 30000 ms, attempt deadline 30000 ms, total deadline 60000 ms, and backoff 0. The following OpenAI chat returned HTTP 502, deployment `openai`, attempt count 1. The failure class is `unauthorized`. The proxy retries HTTP 429, HTTP 503, or a connection failure before send. This failure is outside that set, so the proxy sent one attempt.

`set-execution-policy` for `anthropic` then exited 0 with retries true and the same deadlines. The Anthropic chat, without `temperature`, returned HTTP 200, `object: chat.completion`, deployment `anthropic`, attempt count 1. A success does not send a second attempt.

The Anthropic policy was then restored to retries false. The OpenAI policy was restored to retries false after the circuit-breaker probe, with the 30000 ms and 60000 ms deadlines.

## Fallback

Result: pass.

The run set a context limit of 128000, data collection `allow`, and data class `internal` on both deployments.

`set-fallback-policy` for alias `auto` exited 0. `show-fallback-policy` returned `enabled: true`, deployments `["anthropic"]`, failures `["unavailable"]`, max attempts 2, capabilities `temperature` and `max_tokens`, providers `["anthropic"]`, data collection `allow`, regions `[]`, and min remaining deadline 0.

A named chat with `model: openai` kept `x-deployment: openai` and `x-fallback: false`. The body was the OpenAI upstream error. A named model stays on the named deployment.

The stored policy can choose a second deployment only when that deployment is `validated_live`. `validate-deployment` refuses `validated_live`. Both deployments are `unvalidated`. The live switch is blocked on that prerequisite. The policy remains stored.

## Routing policy

Result: pass.

`grant_routing_permission` was called for `routing:admin` and for `routing:read`. Both statements returned one row.

`POST /internal/v1/routing/policies` with idempotency key `e2e-policy-1` returned HTTP 201. The policy id is `4b71fe03-076d-4489-9417-2897748b9e0c`. The alias is `auto`. The baseline is `openai`. The candidates are `openai` and `anthropic`. The task segment is `general_qa`. The first status is `draft` and the first epoch is 1.

The first validate call and the first status call omitted `Idempotency-Key`. Each returned HTTP 400, code `invalid_parameter`, message `Idempotency-Key is required.`

The follow-up sent the header. `POST /internal/v1/routing/policies/{id}/validate` with `expectedEpoch: 1` returned HTTP 200, status `validated`, epoch 2. `POST /internal/v1/routing/policies/{id}/status` with `status: shadow` and `expectedEpoch: 2` returned HTTP 200, status `shadow`, epoch 3.

`GET /internal/v1/routing/policies` returned HTTP 200.

`model: auto` then stayed on the alias baseline. The headers are `x-deployment: openai`, `x-attempt-count: 1`, and `x-fallback: false`. The body is the OpenAI upstream error.

`GET /internal/v1/routing/decisions/{requestId}` returned HTTP 200. `routingMode` is `shadow`. `baselineDeployment` and `selectedDeployment` are `openai`. `activationEpoch` is 3. `reasonCodes` is `["shadow_observed"]`. `promotion` is null. `selection` is null.

## Evidence qualification

Result: pass.

`POST /internal/v1/evaluation-profiles` created a profile named `e2e-profile` for `general_qa`. The config uses the `json_parse` validator at version 1. The create call returned HTTP 201 and status `draft`. Approve returned HTTP 200 and status `approved`. The approved `versionId` is the output requirement id `178e66b9-30ce-45b3-9e63-53e90664de0c`.

`POST /internal/v1/routing/qualification-profiles` returned HTTP 201. The candidate is `anthropic`. The model version is `claude-sonnet-5-5`. The minimum sample count is 1. The profile version id is `88c1883c-b7fb-412a-8e51-fb5728c4050f`.

The first refresh sent the profile id. The proxy returned HTTP 404, code `not_found`, message `The qualification profile was not found.`

The follow-up sent `profileVersionId` `88c1883c-b7fb-412a-8e51-fb5728c4050f`. Refresh returned HTTP 201. The snapshot id is `f0d35569-c19e-4e5e-9d2c-7b12cea2ab15`. The status is `inconclusive`. The reason code is `insufficient_samples`. `sampleCount` is 0. `sourceRunIds` is empty.

`GET /internal/v1/routing/evidence` returned HTTP 200 and that snapshot.

## Shadow ranking

Result: pass.

`POST /internal/v1/routing/simulate` returned HTTP 200. `routingMode` is `shadow`. `baselineDeployment` is `openai`. `recommendedDeployment` is null. `eligibleCount` is 0. `candidateCount` is 2. `reasonCodes` is `["baseline_fallback"]`. The exclusions are `openai` reason `unauthorized` and `anthropic` reason `unauthorized`. `estimatedSavings` is null. `computationMs` is 1. `savingsKind` is `estimate`.

`GET /internal/v1/routing/shadow-metrics` returned HTTP 200.

`GET /internal/v1/routing/shadow-rankings/{requestId}` for the shadow `auto` chat returned HTTP 200. `actualDeployment` is `openai`. `recommendedDeployment` is null. `routingMode` is `shadow`. `reasonCodes` is `["baseline_fallback"]`. `computationMs` is 2. The same two exclusions are present.

The rank records an estimate. The `auto` request still executed the alias baseline.

## Canary routing

Result: blocked.

`POST /internal/v1/routing/rollouts` used the shadow policy id and the inconclusive snapshot id. Basis points were 10000. The max request count was 5. The max expense was `1.00000000`. The max duration was 3600 seconds. The critical error threshold was 5.

The proxy returned HTTP 409, code `evidence_not_qualified`, message `The evidence snapshot is not qualified.`

No rollout id was created. No guardrail set was attached. The missing prerequisite is a qualified evidence snapshot. The candidate is also `unvalidated`, which the canary gate rejects when a snapshot is qualified.

## Governed promotion

Result: blocked.

`POST /internal/v1/routing/rollouts/{id}/promote` was not sent. There is no rollout id and no activation epoch. The missing prerequisite is an active qualified canary. `enableSelection` was not sent. Selection stays off. Automatic promotion stays off.

## Limits and budgets

Result: pass.

`set-tenant-limits --mode observe --requests-per-minute 600 --concurrent-requests 8 --concurrent-streams 4` exited 0. `set-tenant-budget --mode observe --monthly-amount 25` exited 0.

`GET /internal/v1/limits` returned HTTP 200. `configuredLimits.mode` is `observe`. `requestsPerMinute` is 600. `concurrentRequests` is 8. `concurrentStreams` is 4. `tokenRatePerMinute` is null. `leaseMs` is 120000. The budget object shows mode `observe`, currency `USD`, allocated `25`, recognized `0`, and available `25`.

`GET /internal/v1/budgets/usage` returned HTTP 200 with the same budget fields.

The hard probe set mode `hard` and 1 request per minute. Two following OpenAI chats both returned HTTP 429, code `tenant_rate_limited`, message `The request rate limit was reached.` The minute already contained earlier calls, so both probes were limited. The limits were then restored to `observe` and 600 requests per minute.

## Cost

Result: pass.

`register-price` exited 0 for both providers. The OpenAI price is `gpt-4o-mini`, input rate `0.00000015`, output rate `0.0000006`, status `verified`, effective `2026-01-01T00:00:00Z`, source `operator`. The Anthropic price uses upstream model `claude-sonnet-5-5`, input rate `0.000003`, output rate `0.000015`, and the same status and effective time.

`GET /internal/v1/metrics/costs` for provider `openai`, from `2026-10-01T00:00:00Z` to `2026-11-01T00:00:00Z`, returned HTTP 200. At the first read the OpenAI bucket had 5 attempts in `unknown` and a null amount.

A later read, after the successful Anthropic chats, still shows OpenAI amounts as null. The Anthropic filter shows provisional attempts 5 and provisional amount `0.00057` USD. Reconciled attempts are 0.

## Circuit breaker

Result: pass.

`set-deployment-breaker` for `openai` exited 0 with the breaker enabled, window 60000 ms, minimum samples 1, failure threshold 1, cooldown 60000 ms, and max probes 1.

The execution policy then used a 100 ms connection deadline, a 100 ms attempt deadline, and a 100 ms total deadline, with retries false. The OpenAI chat returned HTTP 504, code `timeout`, message `The upstream model request timed out.` The deployment header is `openai`. The attempt count is 1.

`GET /internal/v1/metrics/breakers?deployment=openai` returned HTTP 200. The breaker is enabled, state `open`, reason `failure_threshold`, samples 1, failures 1, and rate limits 0.

`set-deployment-breaker --enabled false` exited 0. `reset-deployment-breaker` exited 0 and reported state `closed`. The execution policy was restored to retries false and the 30000 ms and 60000 ms deadlines.

## Metrics

Result: pass.

`GET /internal/v1/metrics/summary` and `GET /internal/v1/metrics/attempts?deployment=openai` returned HTTP 200 for the window `2026-10-01T00:00:00Z` through `2026-11-01T00:00:00Z`.

The first summary, taken before the successful Anthropic chats, counted 6 requests, 0 succeeded, and 6 failed. Latency samples were 6 and the max was 615 ms.

A later summary counted 18 requests, 3 succeeded, and 15 failed. Anthropic has 6 requests, 3 completed, 3 errors, 90 prompt tokens, 20 completion tokens, and 110 total tokens. OpenAI has 12 requests, 0 completed, and 12 errors.

The OpenAI attempt list from the first read has 5 rows. The first row is deployment `openai`, model `gpt-4o-mini`, status `failed`, failure class `unauthorized`, error code `upstream_error`, duration 572 ms, and cost status `unknown`.

## Request characteristics

Result: pass.

`GET /internal/v1/request-features?limit=5` returned HTTP 200. The body has `features` and `nextCursor`. One feature has `taskCategory: general_qa`, `classificationSource: caller_hint`, `messageCount: 1`, `requestedModel: openai`, `selectedDeployment: openai`, `executionStatus: failed`, `inputSize: 32`, and `complexityEstimate: low`. The object has no prompt and no completion.

`GET /internal/v1/request-features/{requestId}` returned HTTP 200 with the same fields.

## Encrypted samples

Result: pass.

The first `set-sample-policy` used mode `metadata_only` and exited 0. The policy version was 1.

The next call used mode `encrypted_sample` and classification `general_qa`. It exited 1. The error text is `classification list is invalid`. The store accepts `public`, `internal`, `confidential`, and `restricted`.

The follow-up used classification `internal`, content capture true, streaming capture false, replay true, judge disclosure false, sample rate 1, max bytes 100000, max count 20, and retention 604800 seconds. Providers and deployments were `openai,anthropic`. The command exited 0. The policy version is 2.

An Anthropic chat without `temperature` then returned HTTP 200. `GET /internal/v1/samples?limit=5` returned HTTP 200. The list has one sample. The id is `35bcbccb-d605-40a5-9a1d-727fa4d36a6d`. The provider and deployment are `anthropic`. `sizeBytes` is 509. The expiry is seven days after `2026-10-31T07:51:06.057Z`. The sample view has no prompt, no completion, and no ciphertext.

`GET /internal/v1/samples/{id}` returned HTTP 200 with those metadata fields.

`GET /internal/v1/samples/stats` returned HTTP 200. `retained` is 1, `diverse` is 1, the size band `s` is 1, and the category `general_qa` is 1.

`POST /internal/v1/samples/{id}/eligibility-check` with `deployment: anthropic` returned HTTP 200. `eligible` is true. All nine checks passed, including content availability, replay authorization, and target deployment permission.

Content capture is on for this local tenant only.

## Evaluation

Result: pass.

The approved profile is the one in the evidence section. `POST /internal/v1/evaluations/preflight` used mode `dry_run`, sample category `general_qa`, the stored sample id, challenger `anthropic`, and budget `0.01`. It returned HTTP 200. `accepted` is true. `itemCount` is 1. `modelExecution` is `off`.

`POST /internal/v1/evaluations` with the same plan returned HTTP 201. The run id is `a9927778-4540-4df8-be04-6c9017da8d4b`. The first status is `queued`.

`node dist/evaluation-worker.js` ran with `EVALUATION_DRY_RUN=true`, `EVALUATION_WORKER_DRAIN=true`, and `EVALUATION_EXECUTION_ENABLED=false`. The process exited 0. The log says `evaluation worker drain complete` and `modelCalls: 0`.

`GET /internal/v1/evaluations/{id}` then returned HTTP 200 and status `completed`.

`GET /internal/v1/evaluations/{id}/report` returned HTTP 200. `readOnly` is true. `routingChange` is false. The recommendation state is `inconclusive`. `sampleCount` is 0. `totalSamples` is 1. `exclusionCount` is 1.

`GET /internal/v1/evaluations/recommendations?limit=5` returned HTTP 200.

The worker did not call a model.

## Cost of a schedule

Result: pass.

The image does not start the schedule from `docker-compose.yml`. This run recreated the app with a scratch override. The override sets `EVALUATION_SCHEDULE_TENANTS` to this tenant id, `EVALUATION_EXECUTION_ENABLED` to false, and `EVALUATION_GLOBAL_KILL` to false. The recreate command exited 0. The following ready check returned HTTP 200.

`POST /internal/v1/evaluation-schedules` returned HTTP 201. The schedule is enabled. The daily limit is `1`. The monthly limit is `20`. The per-run max expense is `1`. Max challenger calls is 1. Max judge calls is 0. Max samples is 1. The challenger is `anthropic`. The sample category is `general_qa`.

`POST /internal/v1/evaluation-schedules/tick` returned HTTP 200. `action` is `skip`. `skipReason` is `no_eligible_samples`. `selectedSampleIds` is empty. `runId` is null. This tick ran before the encrypted sample existed.

`GET /internal/v1/evaluation-schedules` returned HTTP 200. `GET /internal/v1/evaluation-schedules/decisions?limit=5` returned HTTP 200. `GET /internal/v1/evaluation-schedules/drift?asOf=2026-10-31T23:59:59Z` returned HTTP 200. The drift body has `asOf`, `statements`, `workloadMixChange`, `limits`, and `historical`.

## End state

The stack is still up. Ready is HTTP 200. Inference is on. The alias baseline is `openai`. The shadow policy is active for recording and does not change that baseline. Selection is off. Automatic promotion is off. The OpenAI breaker is disabled. Limits are `observe` at 600 requests per minute. The budget is `observe` at 25 USD. Sample capture remains on for this local tenant. The schedule environment remains on the recreated app process. Vertex, xAI, OpenRouter, and DGX were not called.
