# End-to-end test 2

Back to [README](../../README.md). The full run is [test 1](test-1.md).

This page lists the failed and blocked results from that run and the change that clears each one. The date is 2026-10-31. Passed capabilities stay in test 1. This page does not change the stack, the key file, or the product code.

## Result index

| Capability | Result | Clear when |
| --- | --- | --- |
| Providers | fail | The OpenAI chat returns `chat.completion`. |
| Streaming | fail | The OpenAI stream returns events, and the Anthropic stream ends with `data: [DONE]`. |
| Canary routing | blocked | Refresh stores a fresh `qualified` snapshot, and the challenger is `validated_live` with the same model and config version. |
| Governed promotion | blocked | An active rollout exists, and `POST .../promote` passes every promotion gate. |

## Providers

Result: fail.

`GET /v1/models` lists `openai` and `anthropic`. Both deployments are enabled. Both `validation_status` values are `unvalidated`. The OpenAI upstream model is `gpt-4o-mini`. The Anthropic upstream model is `claude-sonnet-5-5`.

The OpenAI chat returned HTTP 502, code `upstream_error`. The attempt stores `failure_class: unauthorized`. A direct call with the same operator key returned HTTP 401 and provider code `expired_secret_key`. The proxy does not copy the provider text into the client body.

The Anthropic follow-up omitted `temperature` and returned HTTP 200, `object: chat.completion`, model `claude-sonnet-5-5`. A provider result requires both live chats to complete.

Clear the failure with the operator key file.

1. Put a current OpenAI key in `config/provider-keys.env`.
2. Leave the Anthropic key in place when that key is still valid.
3. Run `./llm-proxy-docker.sh keys`.
4. Send `POST /v1/chat/completions` with `model: openai`. Omit the key from the command line and from the report.
5. Require HTTP 200 and `object: chat.completion`.

`./llm-proxy-docker.sh keys` replaces the stored OpenAI key. The same run replaces the stored Anthropic key from that file. The command does not print either key. The command does not set `validation_status` to `validated_live`.

Keep `temperature` out of the Anthropic body for `claude-sonnet-5-5`. A body with `temperature: 0` gets HTTP 400 from the provider. The proxy stores `client_error` and returns HTTP 502. The deployment capability list still contains `temperature`. The recorded Anthropic follow-up already omitted the field.

Vertex, xAI, OpenRouter, and DGX stay out of this fix. Those keys are empty.

## Streaming

Result: fail.

Tenant streaming is on. Both deployments have streaming on.

The OpenAI stream sent `temperature: 0` and returned HTTP 502 with `content-type: application/json`. The event count is 0. That is the expired-key failure from the providers section. Replace the OpenAI key, run `./llm-proxy-docker.sh keys`, and send the stream again. Require `content-type: text/event-stream` and a terminal `data: [DONE]` line.

The Anthropic stream omitted `temperature`. The proxy returned HTTP 200 and `content-type: text/event-stream`. The deployment header is `anthropic`. The body has two `data:` frames. The first frame is a `chat.completion.chunk` whose delta role is `assistant`. The second frame is a chunk whose delta content length is 4 characters. The body has no `data: [DONE]` line.

The attempt row stores `status: failed`, `error_code: invalid_upstream_response`, `failure_class: stream_started`, `stream_status: provider_failed`, `chunk_count: 2`, and `bytes_written: 400`.

A direct Anthropic stream for `claude-sonnet-5-5` emits `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop`. The `message_delta` usage object includes `output_tokens_details`.

`src/inference/anthropic-stream.ts` allows these usage keys: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`, `service_tier`, `server_tool_use`, `inference_geo`, and `speed`. `output_tokens_details` is absent. `applyUsage` rejects the object when any key is outside that set. The text chunk is already written. `message_stop` does not run. `renderDone()` writes `data: [DONE]` only when the stream status is `completed`.

Change the parser so a live Anthropic stream can finish.

1. Add `output_tokens_details` to the usage allow-list.
2. Accept the value only when it is an object.
3. Keep the integer checks on `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
4. Leave the token totals on those integer fields.
5. After a valid `message_stop`, keep the stream status `completed` so the writer emits `data: [DONE]`.
6. Store the attempt as completed.
7. Add a unit case whose `message_delta.usage` contains `output_tokens_details` and whose `message_stop` sets `done` true.

Rebuild the image and recreate the app after that code change. Send the Anthropic stream again with `temperature` omitted. Require HTTP 200, `text/event-stream`, the text chunk, and `data: [DONE]`.

## Canary routing

Result: blocked.

`POST /internal/v1/routing/rollouts` used policy `4b71fe03-076d-4489-9417-2897748b9e0c` and snapshot `f0d35569-c19e-4e5e-9d2c-7b12cea2ab15`. Basis points were 10000. The max request count was 5. The max expense was `1.00000000`. The max duration was 3600 seconds. The critical error threshold was 5.

The proxy returned HTTP 409, code `evidence_not_qualified`, message `The evidence snapshot is not qualified.` No rollout id was created.

The policy is already `shadow` at epoch 3. The alias `auto` points at `openai`. The policy baseline is `openai`. Create checks the next gates in this order.

1. The snapshot status is `qualified`.
2. The snapshot is inside its freshness window.
3. The snapshot candidate is a policy candidate and is not the baseline.
4. The snapshot task segment is in the policy. This policy segment is `general_qa`.
5. The challenger is enabled, the connection is enabled, `validation_status` is `validated_live`, the upstream model equals the snapshot model version, and the deployment config version equals the snapshot config version.

A later failure of gate 5 returns HTTP 409, code `deployment_unvalidated`.

### Qualified snapshot

Snapshot `f0d35569-c19e-4e5e-9d2c-7b12cea2ab15` is `inconclusive`. The reason code is `insufficient_samples`. `sampleCount` is 0. `sourceRunIds` is empty. The profile version id is `88c1883c-b7fb-412a-8e51-fb5728c4050f`. The candidate is `anthropic`. The model version is `claude-sonnet-5-5`. The minimum sample count is 1.

Evaluation run `a9927778-4540-4df8-be04-6c9017da8d4b` completed as a dry run. The worker logged `modelCalls: 0`. The report recommendation is `inconclusive`. `sampleCount` is 0. `totalSamples` is 1. `exclusionCount` is 1. `EVALUATION_EXECUTION_ENABLED` was false. That run does not supply a qualifying item.

Qualification counts an item when the approved profile matches, the run is `completed` or `completed_partial`, the evaluation attempt status is `completed`, and the original model attempt is present. The item must also match the profile task, complexity, input-size band, capabilities, model version, deployment config version, adapter version, and output requirement. The approved output requirement version is `178e66b9-30ce-45b3-9e63-53e90664de0c`. The validator is `json_parse` version 1.

A counted item still has to clear the numeric gates on profile version `88c1883c-b7fb-412a-8e51-fb5728c4050f`.

- Matched samples are at least 1.
- Coverage meets the stored minimum.
- Challenger latency and original duration are both present.
- Challenger cost and original cost are both known. A known status is `estimated`, `provisional`, or `reconciled`.
- The challenger and the original each have at least one objective validator result of `pass` or `fail`.
- The Wilson lower bound meets the stored objective floor.
- The Wilson interval width stays within the stored maximum.
- The noninferiority bound holds.
- A present judge result is stable. An inconclusive, unstable, contradictory, or order-biased judge blocks `qualified`. A judge preference is not an objective pass.

Produce that item with a replay run.

1. Set `EVALUATION_EXECUTION_ENABLED` to `true` on the worker process.
2. Put tenant `49ed4164-c4f7-4731-a219-9cbb7a29f466` in `EVALUATION_REPLAY_TENANTS` on that process.
3. Leave `EVALUATION_DRY_RUN` unset on that process.
4. Leave the app process execution flag false. The schedule tick stays a pass.
5. Create the evaluation with mode `replay`. Preflight then reports `modelExecution: pinned`.
6. Run `node dist/evaluation-worker.js` with that environment.
7. Require `modelCalls` greater than 0 and a completed attempt for challenger `anthropic`.
8. Refresh with `POST /internal/v1/routing/evidence/refresh`. Send `profileVersionId` `88c1883c-b7fb-412a-8e51-fb5728c4050f` and a new `Idempotency-Key`.
9. Require snapshot status `qualified` and a fresh window.

The stored sample policy already has replay on for this tenant. Sample `35bcbccb-d605-40a5-9a1d-727fa4d36a6d` passed the eligibility check for deployment `anthropic`.

The profile deployment config version must still equal the `anthropic` deployment config version at refresh. A later deployment edit raises that version. Store a new profile version when the versions differ, then refresh that version.

Leave the judge list empty for this `json_parse` profile. Add the tenant to `EVALUATION_JUDGE_TENANTS` only when the run needs a judge.

### Live validation status

Both deployments are `unvalidated`. A qualified snapshot still stops create at `deployment_unvalidated` until `anthropic` is `validated_live` and the model and config version match that snapshot.

`validate-deployment` accepts `unvalidated`, `valid`, `invalid`, and `validated_mock`. `set_deployment_validation` raises `validation status is not available` for `validated_live`. The column check allows the word. The shipped writer does not store it. A successful Anthropic chat leaves the status `unvalidated`.

Ship a writer that stores `validated_live` after a live verification of that deployment. Point the canary challenger at the deployment that writer marks. Leave migration `011_private_endpoint.sql` unchanged. Leave the `model_deployments` row unchanged by hand.

The same status check excludes `openai` and `anthropic` from shadow ranking with reason `unauthorized`. Shadow ranking stays a pass. The rank does not change the route. Fallback selection uses the same status. The stored fallback policy stays a pass. Fallback will not switch until the candidate is `validated_live`.

The feedback call in test 1 returned HTTP 400, code `unapproved_source`, for source `e2e`. No guardrail set exists, because no rollout exists. After create returns HTTP 201, attach one guardrail set and list source `e2e` before you send feedback. Chat stays a pass.

## Governed promotion

Result: blocked.

`POST /internal/v1/routing/rollouts/{id}/promote` was not sent. There is no rollout id and no activation epoch. `enableSelection` was not sent. Selection stays off. Automatic promotion stays off.

Clear the block only after canary create returns HTTP 201.

1. Read the rollout epoch. The first epoch is 1.
2. Send `POST /internal/v1/routing/rollouts/{id}/promote` with `routing:admin` and an `Idempotency-Key`.
3. Send `expectedEpoch` and `taskSegment: general_qa`.
4. Leave `enableSelection` false.
5. Leave `automaticPolicy` unset.

The policy must still be `shadow`. The task segment must be on the policy and on the evidence. The first failed gate returns HTTP 409, code `promotion_rejected`. The parameter is the gate name.

The gates are qualified fresh evidence, a matching model version, a matching config version, enough matched samples, the quality threshold, noninferiority when the margin is positive, reliability, latency, the cost objective, a completed canary window, a valid budget, a valid provider policy, and no unresolved critical incident. The matched-sample gate reads `qualityMinValidPairs` on the shadow policy. Read that stored value before you treat the profile minimum of 1 as enough.

This profile minimum sample count is 1. Promotion uses that count as the canary-window minimum. Send `model: auto` traffic through the active rollout until the completed canary count meets that minimum. Use a share below 10000 basis points. The rollout then records baseline assignments as well as canary assignments. With one or more canary samples, reliability must meet 0.99 and latency must meet the stored limit. The cost gate reads the median known cost of each cohort. The canary median must be below the baseline median and within the max cost per request. A null baseline cost fails that gate. The OpenAI key replacement is what lets the `openai` baseline cohort store a known cost.

The provider gate requires the challenger to be enabled, connected, and `validated_live`. The stored fallback policy is enabled, so the gate also requires provider `anthropic` and data collection `allow`. The empty region list adds no region limit. Selection executes a deployment only when that deployment is `validated_live`. Leave `enableSelection` false. Leave automatic promotion off.

A stopped rollout cannot be promoted. Create a new rollout from a fresh qualified snapshot when the first rollout stops.

## What stays in place

The stack stays up. Inference stays on. The alias baseline stays `openai`. The shadow policy stays in `shadow` and does not change that baseline. Selection stays off. Automatic promotion stays off. Limits stay `observe` at 600 requests per minute. The budget stays `observe` at 25 USD. Sample capture stays on for this local tenant. Vertex, xAI, OpenRouter, and DGX stay uncalled.

Apply the OpenAI key replacement, the stream parser change, the replay evaluation, and the live-validation writer before you rerun these four results.
