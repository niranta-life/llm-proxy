# End-to-end test 6

Back to [README](../../README.md). The first full run is [test 1](test-1.md). The failed and blocked results from that run are [test 2](test-2.md). The OpenAI, Anthropic, and xAI run is [test 3](test-3.md). The three-model run is [test 4](test-4-full.md). The one-pair refresh at a 0.05 margin is [test 5](test-5-learn.md).

This run qualified OpenAI, Anthropic, and xAI on the same 73 samples. One proof chat served OpenAI for lowest qualified cost. The rollout is stopped. No serving promotion remains. The date is 2026-11-01. The proxy was already up on `http://127.0.0.1:8080`. `GET /health/ready` returned HTTP 200 with `status: ready` and `database: ready` after the restore. The tenant is `49ed4164-c4f7-4731-a219-9cbb7a29f466`. The prompt text and the completion text stay out of this record.

## Scope

The run captured 73 chats on the named model `openai`. It replayed those samples on OpenAI, then Anthropic, then xAI. Each replay used the approved length check. The run stored one qualification profile per deployment and refreshed one snapshot per profile. The refresh does not call a model. A simulate call ranked the three qualified snapshots. The run then moved alias `auto` to Anthropic, sent a canary pair, promoted the policy with selection on, and sent one proof chat. It then stopped the rollout and returned alias `auto` to OpenAI.

The run used direct replay. It did not open an evaluation schedule. It did not store a rubric. It did not call the judge. It did not send feedback.

## Budgets

Migration `033_evaluation_budget_ceilings.sql` is applied. The schedule checks in force are:

| Check | Bound |
| --- | --- |
| Daily limit | greater than 0 and at most 2.92 USD |
| Monthly limit | at least the daily limit and at most 20 USD |
| `max_samples` | 1 through 73 |
| `max_challenger_calls` | 1 through 292 |
| `max_judge_calls` | 0 through 40 |

The stored global daily limit is 2.92 USD. The stored global monthly limit is 2.92 USD. The monthly check still allows 20 USD. Prices stayed as stored. OpenAI input is 0.00000015 USD per token and output is 0.0000006. Anthropic input is 0.000003 and output is 0.000015. xAI input is 0.000002 and output is 0.000006. The test driver refused the next reserve if the tracked total would exceed 1.423792 USD. That stop is not a product ceiling. The tracked total finished at 0.3862138 USD.

| Step | Cost |
| --- | --- |
| Tracked total before this cohort | 0.1802446 USD |
| Capture, 73 OpenAI chats | 0.0002502 USD |
| OpenAI replay | 0.0002592 USD |
| Anthropic replay | 0.021924 USD |
| xAI replay | 0.183234 USD |
| Canary pair and proof chat | 0.0003018 USD |
| Tracked total | 0.3862138 USD |

This cohort spent 0.2059692 USD.

## Samples

The capture used `max_tokens` 128, one user message, no temperature, and `stream` false. The task was `general_qa`. Each user message was shorter than 32 characters, so the size band is `xs` and the complexity is `low`. The required capability is `max_tokens`. The run raised the sample maximum to 300 for the capture and set it back to 100 after the proof.

The evaluation profile name is `cost-learn-010-length`. The version id is `ed9cfd4c-fea1-45fb-bc87-7ca7dc1d92e2`. The version is 1. The only validator is `format_length` version 1, with `minChars` 1 and `maxChars` 2000. Limits are `maxInputChars` 4000, `timeBudgetMs` 1000, `maxSchemaDepth` 1, and `maxSchemaNodes` 1.

## Earlier Anthropic replays

Four earlier replays used `max_tokens` 16. The Anthropic challenger failed `length_short` on those attempts. Those runs were not refreshed into the snapshots below.

| Run | Challenger fails | Challenger passes |
| --- | --- | --- |
| `8b309674-dfc3-4114-a153-409cbafd92a1` | 73 | 0 |
| `d13881a4-e7a6-40b0-8d98-90470df5b9a3` | 5 | 68 |
| `6a215ad1-2851-407e-b1ec-2189f2a588f6` | 1 | 72 |
| `eb3534b1-d9cb-4e6d-bf9c-df07585692cf` | 3 | 70 |

[Test 5](test-5-learn.md) is a separate one-pair refresh. Its snapshot `8cc0d415-60e7-4bcd-b848-c197bb67b997` stays `unqualified`. It is no longer the newest Anthropic row for `general_qa`.

## Replay

Each replay sent `POST /internal/v1/evaluations` with mode `replay`, the same 73 sample ids, task `general_qa`, and profile version `ed9cfd4c-fea1-45fb-bc87-7ca7dc1d92e2`. One worker finished one replay run before the next run started. Evaluation execution is unset on the serving container.

| Deployment | Run | Completed | Validator fails | Model | Config | Adapter | Median cost | Latency P50 | Cost sum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `22d5998a-3557-4989-ae02-906851a3a6f5` | 73 | 0 | `gpt-4o-mini` | 11 | 1 | 0.00000285 USD | 502 ms | 0.0002592 USD |
| Anthropic | `88bad355-8da9-43f8-ac63-1018fff6c14c` | 73 | 0 | `claude-sonnet-5-5` | 8 | 1 | 0.000144 USD | 1316 ms | 0.021924 USD |
| xAI | `d747b530-baea-4e57-a9b2-37943c0be5d5` | 73 | 0 | `grok-4.7` | 6 | 1 | 0.002504 USD | 1644 ms | 0.183234 USD |

Original and challenger validators are `pass` with evidence `length_within` on every pair. Cost status is known on every completed attempt. Latency is present on every completed attempt.

Anthropic finished `end_turn` on all 73 attempts. Completion tokens were 4 through 79. Prompt tokens were 14 through 20. The attempt cost was 0.000105 through 0.001233 USD.

OpenAI finished `stop` on all 73 attempts. Completion tokens were 2 through 12. Prompt tokens were 10 through 12. The attempt cost was 0.0000027 through 0.00000885 USD. Provider time was 321 through 1195 ms.

xAI finished `stop` on all 73 attempts. Completion tokens were 1 through 21. Prompt tokens were 1245 through 1247. The attempt cost was 0.002496 through 0.002618 USD. Provider time was 1006 through 13489 ms. The largest xAI attempt was 0.002618 USD.

## Qualification

Each profile uses `min_samples` 1, objective floor 0, maximum interval width 1, noninferiority margin 0.05, minimum coverage 1, and freshness 2592000 seconds. The segment is `general_qa`, complexity `low`, size `xs`, capability `max_tokens`.

| Profile | Version | Snapshot | Status | Pairs | Passes | Difference lower | Wilson lower |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cost-learn-010-openai` | `dd8f9025-2547-47a8-996e-e2f03e4968c8` | `9b90b5e7-cbef-4af3-86e6-cd478dbd652d` | `qualified` | 73 | 73/73 and 73/73 | -0.049994 | 0.950006 |
| `cost-learn-010-anthropic` | `4bfb7372-2852-4f94-8ac6-98ab06820061` | `aea5df6d-f7ac-4428-a07a-b4ac465e55c7` | `qualified` | 73 | 73/73 and 73/73 | -0.049994 | 0.950006 |
| `cost-learn-010-xai` | `1c9dd8b3-6fe6-40a3-a800-1f611e2de5b8` | `4539137c-a83a-4515-817a-80f9d7b7a1f7` | `qualified` | 73 | 73/73 and 73/73 | -0.049994 | 0.950006 |

Each snapshot has an empty reason list, coverage 1, and Wilson upper 1. These three rows are the newest `general_qa` snapshots for OpenAI, Anthropic, and xAI. The margin stays 0.05. A difference lower of -0.049994 passes that margin.

## Rank

`POST /internal/v1/routing/simulate` returned HTTP 200. It recommended `openai`. The reason list includes `lowest_qualified_cost`. The call does not reach a provider. The median replay costs are 0.00000285 USD for OpenAI, 0.000144 USD for Anthropic, and 0.002504 USD for xAI.

## Canary

The run set alias `auto` to Anthropic. It created rollout `e7c609ea-a2a7-4b13-b83b-4705a490daf0` on policy `1c1cbe13-7590-4668-adba-cdfe76f926c5` and OpenAI snapshot `9b90b5e7-cbef-4af3-86e6-cd478dbd652d`. The share is 5000 basis points. The caps are 2 requests, 0.05 USD, 3600 seconds, and 2 critical errors. Both chats were streams with `model=auto`, `max_tokens` 16, task `general_qa`, and no temperature.

| Cohort | Request | Assignment | Executed | Cost |
| --- | --- | --- | --- | --- |
| Canary | `3dd7ba24-517b-4eb3-bd8c-0a409886b475` | `assigned` on `openai` | `openai` | 0.0000114 USD |
| Baseline | `c7f35132-ab00-4153-bc59-d2cd6f01e532` | `share_baseline` on `anthropic` | `anthropic` | 0.000279 USD |

The OpenAI canary cost is lower than the Anthropic baseline cost. Both calls returned HTTP 200 and completed the stream.

## Selection

`POST /internal/v1/routing/rollouts/e7c609ea-a2a7-4b13-b83b-4705a490daf0/promote` returned HTTP 201. The body set task `general_qa`, stages `[10000]`, and selection enabled. The promotion id is `9e01a460-3307-424d-90dc-05cd05351bb8`. The promotion stores Anthropic as the rollback deployment. The alias after this run is OpenAI. The rollback deployment and the final alias are separate fields. The stage is 10000 basis points.

The proof chat was one new stream. `model` was `auto`. `max_tokens` was 16. The task was `general_qa`. Alias `auto` was still Anthropic during this call.

| Field | Value |
| --- | --- |
| HTTP | 200 |
| `x-deployment` | `openai` |
| Request | `973a05dc-ce4d-4520-8188-92cee40717de` |
| Selection reason | `selected` |
| Selected deployment | `openai` |
| Promotion status at decision time | `serving` |
| Activation epoch at decision time | 2 |
| Stored expected cost | 0.00000300 USD |
| Realized cost | 0.0000114 USD |

The alias stayed Anthropic. The header named OpenAI. The decision row selected OpenAI.

## End state

The stack is up. Ready is HTTP 200. The stop of rollout `e7c609ea-a2a7-4b13-b83b-4705a490daf0` stored `stop_reason` `manual` and stopped the serving promotion. The stop sets that promotion status to `rolled_back`. The stop raises the activation epoch to 3. The same row still stores `selection_enabled` true. Selection runs only for a promotion whose status is `serving`. No serving promotion remains.

| Item | Value |
| --- | --- |
| Alias `auto` | `openai` |
| Attached fallback | `832729eb-452e-4384-961a-ccec3a4d410e`, enabled false, version 3 |
| Sample policy | `e41fb093-d0c8-41b2-89f3-77f3af616cd9`, maximum 100 |
| Open samples | 253 |
| Active rollouts | 0 |
| Serving promotions | 0 |
| Shadow policy | `107c5029-7216-48a3-963e-b7191adefa7c`, name `cost-learn-010-restore`, status `shadow`, epoch 3 |
| Disabled policies | `1c1cbe13-7590-4668-adba-cdfe76f926c5` and `4b71fe03-076d-4489-9417-2897748b9e0c` |
| Evaluation execution on the serving container | unset |

The shadow policy uses baseline OpenAI and candidates OpenAI and Anthropic. Shadow status records a rank. It does not change the route. This run did not delete the 253 open samples.

## Result

Seventy-three paired samples cleared the 0.05 margin for OpenAI, Anthropic, and xAI. The ranker chose OpenAI for lowest qualified cost. With alias `auto` on Anthropic, the proof chat executed OpenAI and stored selection reason `selected`. The rollout is stopped. Alias `auto` is OpenAI again. Selection has no serving promotion.

The qualified snapshots remain the newest `general_qa` rows for the three deployments. This run left promotion `9e01a460-3307-424d-90dc-05cd05351bb8` stopped.
