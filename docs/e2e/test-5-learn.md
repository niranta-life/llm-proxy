# End-to-end test 5

Back to [README](../../README.md). The first full run is [test 1](test-1.md). The failed and blocked results from that run are [test 2](test-2.md). The OpenAI, Anthropic, and xAI run is [test 3](test-3.md). The three-model run is [test 4](test-4-full.md).

This run checked learning against cost on 2026-11-01. The proxy was already up on `http://127.0.0.1:8080`. `GET /health/ready` returned HTTP 200 with `status: ready` and `database: ready` before the calls and again after the chat. The tenant is `49ed4164-c4f7-4731-a219-9cbb7a29f466`. Selection stayed off. The prompt text and the completion text stay out of this record.

## Scope

The run stored one qualification profile. It refreshed one evidence snapshot from the completed evaluation pair. That refresh does not call a model. The run simulated `model=auto` before the refresh and after it. It then sent one streamed chat with `model=auto`.

The run left selection off. It left alias `auto` on OpenAI. It left the attached fallback policy disabled. It left rollouts at 0 and promotions at 0. It left the sample maximum at 20. It left evaluation execution off. It did not send feedback.

## Saved pair

One completed attempt matches the Anthropic candidate. The run id is `904eaae0-8011-4d27-84b9-0ad6608a3326`. The approved output requirement is `178e66b9-30ce-45b3-9e63-53e90664de0c`. The task is `general_qa`. The complexity is `low`. The input size is 30, so the size band is `xs`. The required capability is `max_tokens`. The model is `claude-sonnet-5-5`. The stored config version is 6. The adapter version is 1. The challenger objective result is pass. The original objective result is pass.

| Side | Cost | Cost status | Time |
| --- | --- | --- | --- |
| Anthropic challenger | 0.000201 USD | provisional | 1331 ms |
| OpenAI original | 0.00000525 USD | estimated | 1546 ms |

The earlier run `a9927778-4540-4df8-be04-6c9017da8d4b` completed as a dry run. It has no attempt row. The refresh does not use it.

## Profile

`POST /internal/v1/routing/qualification-profiles` returned HTTP 201. The profile name is `cost-learn-005`. The version id is `01bc7aee-3405-4828-942c-beb85e097e19`.

| Gate | Value |
| --- | --- |
| Candidate | `anthropic` |
| Model | `claude-sonnet-5-5` |
| Config version | 6 |
| Minimum samples | 1 |
| Objective floor | 0.00000 |
| Maximum interval width | 1.00000 |
| Noninferiority margin | 0.05000 |
| Minimum coverage | 1.00000 |
| Freshness | 2592000 seconds |

The profile uses config 6 because the stored attempt uses config 6. The live Anthropic config is 8.

## Snapshot

`POST /internal/v1/routing/evidence/refresh` returned HTTP 201 at 2026-11-01 01:29:18Z. The snapshot id is `8cc0d415-60e7-4bcd-b848-c197bb67b997`.

| Field | Value |
| --- | --- |
| Status | `unqualified` |
| Reason | `noninferiority_failed` |
| Matched pairs | 1 |
| Coverage | 1 |
| Wilson lower | 0.206543 |
| Wilson upper | 1 |
| Difference lower | -0.793457 |
| Source run | `904eaae0-8011-4d27-84b9-0ad6608a3326` |

The difference lower is the same value stored on snapshot `2f9c9777-0927-4af2-bdab-f6d6f378c177`. That older snapshot stays `qualified` because its margin is 1.00000. This profile uses 0.05000. A difference lower of -0.793457 fails that margin.

One perfect pair is not enough for a 0.05 margin. The Wilson and Newcombe bound on perfect pairs stays at or below -0.05 until the pair count reaches 73. Twenty perfect pairs still fail. The open sample maximum is 20. This run left that maximum in place.

## Rank

`POST /internal/v1/routing/simulate` does not call a provider. Both calls used `model=auto`, task `general_qa`, `max_tokens` 16, and a user text of length 26.

| | Before refresh | After refresh |
| --- | --- | --- |
| HTTP | 200 | 200 |
| Mode | `shadow` | `shadow` |
| Baseline | `openai` | `openai` |
| Recommended | null | null |
| Eligible | 0 | 0 |
| Candidates | 2 | 2 |
| Reason | `baseline_fallback` | `baseline_fallback` |
| OpenAI exclusion | `task_unmatched` | `task_unmatched` |
| Anthropic exclusion | `quality_failed` | `quality_failed` |
| Evidence snapshot | `2f9c9777-0927-4af2-bdab-f6d6f378c177` | `8cc0d415-60e7-4bcd-b848-c197bb67b997` |
| Computation | 3 ms | 2 ms |
| Estimated savings | null | null |

The ranker moved from the older qualified snapshot to the new unqualified snapshot. It still recommends no deployment.

OpenAI has no snapshot for `general_qa` at complexity `low` and size `xs`, so the ranker excludes it. Anthropic is the candidate with evidence. That evidence fails the margin. The stored Anthropic cost on the pair is 0.000201 USD. The stored OpenAI cost on the same pair is 0.00000525 USD. A recommendation of Anthropic would raise the cost of this pair. The margin keeps Anthropic out of the eligible set.

## Live chat

The chat was one stream. `model` was `auto`. `max_tokens` was 16. The body sent no `temperature`. The user text length was 26. The call returned HTTP 200 at 2026-11-01 01:29:20Z.

| Header or field | Value |
| --- | --- |
| `x-deployment` | `openai` |
| `x-request-id` | `edbf725f-4124-4eb7-abe4-c31bc93bca45` |
| `x-attempt-count` | 1 |
| `x-fallback` | false |
| Stream end | `data: [DONE]` |
| Upstream model | `gpt-4o-mini` |
| Trigger | `primary` |
| Tokens | 13 prompt, 2 completion, 15 total |
| Provider time | 1528 ms |
| Cost | 0.00000315 USD, status `estimated` |

The app log recorded `sample capture skipped` for that request id, deployment `openai`, reason `streaming_capture`. Open samples stayed 20.

## End state

The stack is up. Ready is HTTP 200.

| Item | Value |
| --- | --- |
| Alias `auto` | `openai` |
| Attached fallback | `832729eb-452e-4384-961a-ccec3a4d410e`, enabled false |
| Sample policy | version 3, streaming capture off, maximum 20, open samples 20 |
| Selection | off |
| Rollouts | 0 |
| Promotions | 0 |
| Newest Anthropic snapshot for `general_qa` | `8cc0d415-60e7-4bcd-b848-c197bb67b997`, `unqualified` |
| Older margin-1 snapshot | `2f9c9777-0927-4af2-bdab-f6d6f378c177`, still stored, no longer the newest row |

## Result

Learning stored a new snapshot from the completed pair. The 0.05 margin marked that snapshot `unqualified`. Shadow ranking read the new snapshot and recommended no deployment. The live `model=auto` call stayed on OpenAI and cost 0.00000315 USD.

A later selection read uses the newest snapshot for the candidate and the task. That snapshot is `unqualified`. The live Anthropic config is 8, and this profile records config 6, so a qualified row at config 6 would also fail the config check. This run did not enable selection.

A cost switch needs a qualified candidate whose expected cost is lower than the serving baseline, and an operator promotion with selection on. Alias `auto` already serves OpenAI. OpenAI has the lowest stored price of the three live deployments. This pair does not qualify Anthropic. The route stays on OpenAI.
