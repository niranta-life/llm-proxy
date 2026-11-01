# End-to-end test 3

Back to [README](../../README.md). The first full run is [test 1](test-1.md). The failed and blocked results from that run are [test 2](test-2.md).

## Code fixes in the tree

The product fixes for the issues below are now in the tree. The tables below remain the record of the 2026-10-31 run. Qualification thresholds stay unchanged. No guardrail or rollout was created in this fix set.

This run applied the updated operator keys and called the live providers on 2026-10-31. The proxy listens on `http://127.0.0.1:8080`. Colima profile `default` is up. The Compose project is `llm-proxy`. Postgres 16 and the app are healthy. `GET /health/ready` returned HTTP 200 with `status: ready` and `database: ready`.

The tenant is `49ed4164-c4f7-4731-a219-9cbb7a29f466`. Inference is on. Selection stays off. Automatic promotion has no policy row. The alias `auto` points at `openai`. The routing activation stays `shadow` at epoch 3. The spend cap for this run was 0.20 USD.

The run sent 12 provider attempts. It did not repeat retry, limits, the circuit breaker, metrics, or a schedule tick. Those results stay in test 1.

## Spend

Known attempt costs sum to 0.00422050 USD. That sum covers 10 of the 12 attempts. The OpenAI stream and the xAI stream have cost status `unknown` and a null amount, so they sit outside the sum.

| Attempt | Tokens in / out / total | Cost status | USD |
| --- | --- | --- | --- |
| OpenAI chat | 15 / 5 / 20 | estimated | 0.00000525 |
| Anthropic chat | 22 / 9 / 31 | provisional | 0.000201 |
| xAI chat | 1250 / 12 / 1516 | estimated | 0.002572 |
| OpenAI stream | none | unknown | none |
| Anthropic stream | 22 / 8 / 30 | provisional | 0.000186 |
| xAI stream | none | unknown | none |
| Alias `auto` | 15 / 5 / 20 | estimated | 0.00000525 |
| Three more Anthropic chats | 22 / 9 / 31 each | provisional | 0.000201 each |
| Longer Anthropic chat | 29 / 24 / 53 | provisional | 0.000447 |
| Replay | 22 / 9 / 31 | provisional | 0.000201 |

Stored rates per token are OpenAI input 0.00000015 and output 0.0000006, Anthropic input 0.000003 and output 0.000015, and xAI input 0.000002 and output 0.000006. The xAI price id is `b055a9f6-943a-45df-9e60-327574ac5075`. The status is `verified`. The effective time is 2026-01-01T00:00:00Z. The source is `operator`.

The client estimate before the longer chat and the replay was 0.00338125 USD. That estimate omitted both streams.

## Result index

| Capability | Result | Record |
| --- | --- | --- |
| Health | pass | HTTP 200, database ready. |
| Model list | pass | `anthropic`, `auto`, `openai`, `xai`. |
| OpenAI chat | pass | HTTP 200. Served model `gpt-4o-mini-2024-07-18`. |
| Anthropic chat | pass | HTTP 200. Model `claude-sonnet-5-5`. JSON object returned. |
| xAI chat | pass | HTTP 200. Model `grok-4.7`. The body is not the requested JSON object. |
| OpenAI stream | pass | 8 events. Body ends with `data: [DONE]`. |
| Anthropic stream | fail | 2 events. Body has no `data: [DONE]`. Attempt status `failed`. |
| xAI stream | pass | 12 events. Body ends with `data: [DONE]`. |
| Alias `auto` | pass | Header `x-deployment: openai`. |
| Encrypted samples | fail | One new OpenAI sample stored. Identical Anthropic replies were skipped. xAI was excluded. |
| Evaluation replay | pass | One model call. Both `json_parse` checks passed. The report state is `inconclusive`. |
| Evidence qualification | pass | The old profile is `invalidated`. A matched profile reached `qualified`. |
| Shadow ranking | pass | Eligible count 0. The route stayed on `openai`. |
| Canary routing | blocked | HTTP 409, code `deployment_unvalidated`. |
| Governed promotion | blocked | No rollout exists. Promote was not sent. |

## Keys

`./llm-proxy-docker.sh keys` exited 0. The command replaced the stored OpenAI key and the stored Anthropic key. It registered the xAI connection and the xAI deployment. It printed no key value. It left every deployment `unvalidated`.

The operator file sets `OPENAI_MODEL` to `gpt-6-luna`. The stored OpenAI deployment model stayed `gpt-4o-mini`. Live OpenAI responses used `gpt-4o-mini-2024-07-18`. `ensure_deployment` enables an existing deployment and returns. It passes `--upstream-model` only when the deployment is new. No shipped command changes `upstream_model` after registration.

`ANTHROPIC_MAX_OUTPUT_TOKENS` was empty in the operator file. `validate_key_relations` stops the whole `keys` command when that field is empty and `ANTHROPIC_API_KEY` is set. The stop happens before the OpenAI replacement and before the xAI registration. This run wrote `1024` back into that field. `1024` is the previous live value. The command then applied the keys.

xAI streaming was off at config version 1. `set-deployment-streaming` turned it on. The xAI config version is now 2. The xAI data classification is empty. The xAI data collection value is empty. The xAI context limit is empty. OpenAI and Anthropic stay `internal`, data collection `allow`, context limit 128000, config version 6. All three capability lists are `temperature` and `max_tokens`.

A later `keys` run replaces the OpenAI key and the Anthropic key again. `apply_registry_key` keeps the first stored xAI key. The same rule covers OpenRouter, Vertex, and DGX.

`keys` recreates the app. A scratch schedule override on the app process does not survive that recreate. This run left the schedule tenant list empty. The worker run did not tick the schedule.

## Live calls

Each chat asked for the JSON object `{"ok":true}`. The input length is 30 characters, so the input-size band is `xs`. `max_tokens` was 16. The body omitted `temperature`. The task was `general_qa`.

| Call | HTTP | Request id | Deployment | Finish | JSON |
| --- | --- | --- | --- | --- | --- |
| OpenAI chat | 200 | `f3fe2601-7ed0-4e8e-ad7b-8d14957de925` | openai | stop | yes |
| Anthropic chat | 200 | `1ff1f8cd-5298-449a-b621-8bab5a8a691d` | anthropic | stop | yes |
| xAI chat | 200 | `e3f6b29f-55aa-47c2-acea-542b2a8a7c33` | xai | stop | no |
| OpenAI stream | 200 | `cdf74bbe-08d5-4165-88d0-e37c925fc44e` | openai | completed | stream |
| Anthropic stream | 200 | `4b42bf7b-18be-4e92-b542-38b70d9396e5` | anthropic | failed | stream |
| xAI stream | 200 | `4b2c9788-91dd-43b6-8e46-e24dcd73e647` | xai | completed | stream |
| Alias `auto` | 200 | `c2cdb3c0-05dc-46ba-a168-c11d711f6020` | openai | stop | yes |

The xAI chat content length is 55. Attempt count was 1 and fallback was false on every call.

The OpenAI stream wrote 1493 bytes and 8 events. The xAI stream wrote 2180 bytes and 12 events. Both ended with `data: [DONE]`. The attempt rows store `stream_status: completed`, empty token columns, and cost status `unknown`.

The Anthropic stream wrote 409 bytes and 2 events. The body has no `data: [DONE]`. The attempt stores `status: failed`, `error_code: invalid_upstream_response`, `failure_class: stream_started`, `stream_status: provider_failed`, `chunk_count: 2`, and `bytes_written: 409`. Prompt tokens are 22. Completion tokens are 8. The provisional cost is 0.000186 USD.

`src/inference/anthropic-stream.ts` allows `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`, `service_tier`, `server_tool_use`, `inference_geo`, and `speed`. `output_tokens_details` is absent. `applyUsage` rejects a usage object that contains any other key. The text chunk is already written. The writer emits `data: [DONE]` only when the stream status is `completed`.

Three more Anthropic chats used the same short prompt. Each returned HTTP 200, 22 / 9 / 31 tokens, finish `stop`, and the JSON object. Request ids are `10855704-865b-446e-897a-d5d1fcc6f40a`, `62da6b7b-8484-4087-b1ff-96a1e62146ef`, and `d2186be0-e0e6-41e0-9895-62031ca96101`.

One longer Anthropic chat used 50 input characters and `max_tokens` 24. The response id is `msg_011Cganbt2VBmuyv5nmgWWbP`. Finish reason is `length`. The message content length is 0. Usage is 29 / 24 / 53. The provisional cost is 0.000447 USD. Duration is 1560 ms.

## Continuous learning

### Samples

Sample policy version 2 is `encrypted_sample`. Content capture is on. Replay is on. Streaming capture is off. The approved classification is `internal`. The provider list is `openai` and `anthropic`. The deployment list is the same pair. The sample rate is 1. The cap is 20.

`visibleSampleText` fingerprints the prompt and the output. The deployment is absent. `selectSample` returns keep false when that fingerprint is already held. `captureChatSample` writes `sample stored` only after an insert. A skipped duplicate writes no log. A stream writes `stream sample capture finished` with `stored: false` when capture stops.

The rows after this run:

| Sample | Provider | Input size | Created | Bytes |
| --- | --- | --- | --- | --- |
| `35bcbccb-d605-40a5-9a1d-727fa4d36a6d` | anthropic | 32 | 2026-10-31T07:51:06Z | 509 |
| `7be9a1cb-189b-49e6-be26-921d7c319fab` | openai | 30 | 2026-10-31T18:22:55.098Z | 497 |
| `a5497a02-7a73-4d59-ae34-87b209b90ade` | anthropic | 50 | 2026-10-31T18:27:30.809Z | 527 |

Each row is `general_qa`, complexity `low`, capabilities `{max_tokens}`, `text_only` true, and `exchange_complete` true. The OpenAI sample is the first short chat, request `f3fe2601-7ed0-4e8e-ad7b-8d14957de925`, duration 1546 ms, cost 0.00000525 USD estimated. The new Anthropic sample is the empty `length` completion. The four Anthropic replies that matched the short JSON were not stored.

xAI capture stops before the provider list. The xAI data classification is empty. `loadDataClass` returns null when the value is not an approved class. `decideSampleCapture` then denies the call with reason `data_class`. Policy version 2 would also deny provider `xai` after a class was set, because `xai` is absent from `allowed_providers`.

Streaming capture is false, so the completed OpenAI and xAI streams were not stored.

### Replay

The evaluation used the OpenAI sample only. The empty Anthropic sample was left out.

`POST /internal/v1/evaluations/preflight` returned HTTP 200, `accepted: true`, `itemCount: 1`, `mode: replay`, and `modelExecution: off`. The budget estimate was `0.01`. `src/http/app.ts` writes `modelExecution: off` on that route for every plan.

`POST /internal/v1/evaluations` returned HTTP 201. The run id is `904eaae0-8011-4d27-84b9-0ad6608a3326`. The definition id is `c5070e7f-b04e-40ab-ab1a-b2ca947ac358`. The name is `e2e3-replay`. The stored `modelExecution` is `pinned`. The profile is output requirement `178e66b9-30ce-45b3-9e63-53e90664de0c`, name `e2e-profile`, version 1. The judge is empty.

A one-shot worker ran `node dist/evaluation-worker.js` with execution enabled for this tenant and with dry run false. The app process stayed with execution off. The worker log shows `applied: []`, then replay finished, attempt `86635709-89bb-4086-9163-074d831bba57`, item `d48a2847-4f17-4f12-814c-fd4cd2286557`, status `completed`, reason `replay_completed`, `modelCalls: 1`. The process exited 0.

The completed run has `completedCount: 1` and `failedCount: 0`. The challenger is `anthropic`. The original deployment is `openai`. Config version is 6. Adapter version is 1. Challenger latency is 1331 ms. Challenger cost is 0.000201 USD provisional. Original cost is 0.00000525 USD estimated. Original latency on the production series is 1546 ms. The report marks that series as separate from the evaluation series.

Both objective validators passed. Validator result ids are `763a81cf-2665-4400-accc-9a5d5ddcb542` and `857964a6-8822-47d8-9c0c-388080c14dac`. The original attempt id is `e1f950c8-51d4-4970-a043-c3bb750e36ff`.

The report is read-only. `routingChange` is false. The recommendation state is `inconclusive`. Reason codes are `difference_not_significant` and `not_equivalent_quality`. `sampleCount` is 1. `validPairs` is 1. Each objective rate is 1. The Wilson 95 lower bound is 0.206543 and the upper bound is 1. The report quality bar asks for 20 valid pairs and an objective pass-rate floor of 0.8. One pair cannot clear that bar. The replay itself completed.

### Qualification

Refresh of profile version `88c1883c-b7fb-412a-8e51-fb5728c4050f` stored snapshot `3ffc1803-6e10-4c1d-a08b-b820a60c5177`. Status is `invalidated`. The reason code is `capability_mismatch`. `sampleCount` is 0. That profile still requires `temperature` and `max_tokens`, and its deployment config version is 1. The replay sample lists only `max_tokens`. The replay attempt config version is 6.

Profile `e2e3-live` was created to match the live row. The profile id is `e50adc46-5dce-4f04-b77f-ff6bd8d8879e`. The version id is `087eec57-8301-40b8-9642-fea795140d3a`. The candidate is `anthropic`. The model is `claude-sonnet-5-5`. The required capability is `max_tokens`. The config version is 6. The adapter version is 1. `minSamples` is 1. The objective floor is 0. The max interval width is 1. The noninferiority margin is 1. Freshness is 86400 seconds. Minimum coverage is 0.

Refresh stored snapshot `2f9c9777-0927-4af2-bdab-f6d6f378c177`. Status is `qualified`. Reason codes are empty. The method is `wilson_95_newcombe`. The lower bound is 0.206543. The upper bound is 1. `differenceLower` is -0.793457. `sampleCount` is 1. `coverageRate` is 1. The source run is the replay above.

That snapshot is qualified because the margin is 1.00000. The same `differenceLower` fails a margin of 0.05. Use `e2e3-live` only as proof that a matched profile can qualify. Do not roll it out.

The qualification status and the evaluation report state are different gates. The snapshot can be `qualified` while the report stays `inconclusive`.

### Shadow, canary, and promotion

`POST /internal/v1/routing/simulate` returned HTTP 200. The policy version is `911684e7-9092-42e0-9b5d-289f2aa608c7`. The baseline is `openai`. `routingMode` is `shadow`. `candidateCount` is 2. `eligibleCount` is 0. `recommendedDeployment` is null. `reasonCodes` is `baseline_fallback`. `evidenceSnapshotIds` is empty. `computationMs` is 1. The exclusions are `openai` and `anthropic`, both reason `unauthorized`.

Shadow checks `validation_status` before it reads a snapshot. Both deployments are `unvalidated`, so both are excluded. The live `auto` chat stayed on `openai`. The policy candidates are `openai` and `anthropic`. xAI is outside that set. The policy quality minimum pass rate is 0.50000. `quality_min_valid_pairs` is 1. The task segment is `general_qa`.

`POST /internal/v1/routing/rollouts` used snapshot `2f9c9777-0927-4af2-bdab-f6d6f378c177`. The share was 1000 basis points. The max request count was 5. The max expense was `0.05000000`. The max duration was 3600 seconds. The critical error threshold was 5.

The proxy returned HTTP 409. The code is `deployment_unvalidated`. The message is `The challenger deployment is not validated.` The parameter is `evidenceSnapshotId`.

Create returns that code when the challenger is missing, disabled, or disconnected. It also returns that code when `validation_status` is not `validated_live`, or when the model or config version differs. The checks before that code require a qualified fresh snapshot on a policy segment. This snapshot names model `claude-sonnet-5-5` and config version 6. The live Anthropic deployment has that model and that config version. Its status is `unvalidated`. No rollout id was created. `routing_rollouts` has 0 rows.

Promote was not sent. `routing_promotions` has 0 rows. `enableSelection` was not sent. Automatic promotion was not turned on.

Feedback was not sent again. Test 1 recorded HTTP 400, code `unapproved_source`, for source `e2e`. A guardrail set is attached to a rollout. No rollout exists, so no set exists.

## Issues to fix

1. Make `keys` apply a changed `OPENAI_MODEL` to an existing deployment. Ship a command that sets `upstream_model`. Until that command exists, the file can say `gpt-6-luna` while the proxy serves `gpt-4o-mini-2024-07-18`.
2. Let an empty `ANTHROPIC_MAX_OUTPUT_TOKENS` block only the Anthropic registration. An OpenAI key replacement and a new xAI key must still run. This run had to restore `1024` before any key was applied.
3. Accept `output_tokens_details` as an object in `src/inference/anthropic-stream.ts`. Keep the integer checks on the token totals. After a valid `message_stop`, keep the stream status `completed` so the writer emits `data: [DONE]` and the attempt is stored as completed. Add a unit case whose `message_delta.usage` contains that object.
4. Remove `temperature` from the capability list for `claude-sonnet-5-5`, or drop the field before the provider call. Store qualification capabilities that match the sample. This run's samples list only `max_tokens` because the body omitted `temperature`.
5. Ship a writer that stores `validated_live` after a verified live call. Leave migration `011_private_endpoint.sql` unchanged. Leave the column unchanged by hand. `set_deployment_validation` raises `validation status is not available` for that word. Shadow, canary, fallback, and promotion all require the word. A successful chat leaves the deployment `unvalidated`.
6. Publish a qualification profile whose config version, model, and capabilities match the live attempt. Keep a real margin at the policy value. A margin of 0.05 cannot pass this one-pair result, because `differenceLower` is -0.793457. Collect varied pairs until the Wilson bound fits the real margin. Leave profile `e2e3-live` unused for a rollout.
7. Put the deployment in the sample fingerprint, or log the reason when `selectSample` skips a row. Identical JSON across providers is one fingerprint today. The skip is silent.
8. Give the xAI deployment an approved data class before learning should see it. Add `xai` to the sample provider list and the deployment list. Add `xai` to the routing candidates only when shadow should rank it. Set the context limit and the data collection value at the same time.
9. Replace a stored xAI, OpenRouter, Vertex, or DGX key on a later `keys` run. This run stored the first xAI key. The next run will keep it.
10. Size `max_tokens` for the expected answer. The 50-character prompt at `max_tokens` 24 stored an empty completion with finish `length`. That row is a poor learning sample.
11. Store token counts on a completed stream, and price the xAI total. The xAI chat has `total_tokens` 1516, prompt 1250, and completion 12. `thoughts_tokens` is null. The cost 0.002572 USD uses prompt plus completion and omits 254 tokens. The successful streams have cost status `unknown`, so a cost gate cannot read them.
12. Return the real execution mode from preflight. A replay plan is `pinned`. The route currently reports `off` while the created run and the worker call the model.
13. After canary create returns HTTP 201, attach one guardrail set that lists source `e2e`, then send feedback. This run has no rollout, so that call stays blocked on the test 1 result.
14. Keep schedule tenants in the operator config that `keys` preserves. A scratch override on the recreated app process is lost. Leave execution off on the app process.

## What stays in place

The stack stays up. Inference stays on. The alias baseline stays `openai`. The shadow policy stays in `shadow` at epoch 3 and does not change that baseline. Selection stays off. Automatic promotion stays off. No rollout exists. The qualified snapshot `2f9c9777-0927-4af2-bdab-f6d6f378c177` stays. The invalidated snapshot `3ffc1803-6e10-4c1d-a08b-b820a60c5177` stays. xAI streaming stays on. The xAI price stays registered. `ANTHROPIC_MAX_OUTPUT_TOKENS` stays at 1024.

This page records the run. It does not change product code.
