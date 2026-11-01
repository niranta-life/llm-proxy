# End-to-end test 4

Back to [README](../../README.md). The first full run is [test 1](test-1.md). The failed and blocked results from that run are [test 2](test-2.md). The OpenAI, Anthropic, and xAI run is [test 3](test-3.md).

This run called the live providers on 2026-10-31 after the deployment fixes were in the running image. The proxy listens on `http://127.0.0.1:8080`. Colima profile `default` is up. The Compose project is `llm-proxy`. Postgres 16 and the app are healthy. `GET /health/ready` returned HTTP 200 with `status: ready` and `database: ready` at 20:03:03Z and again at 20:11:49Z.

The tenant is `49ed4164-c4f7-4731-a219-9cbb7a29f466`. Inference is on. Selection stays off. Automatic promotion has no policy row. The routing activation stays `shadow` at epoch 3. The spend cap for this run was 0.18 USD. The known cost stayed under that cap.

The run used short JSON, a temperature value, a longer sentence, a Unicode line break, a stream, and an alias change. Each shape is identified below by its text length. The prompt text and the completion text stay out of this record.

## Scope

The run covered health, the model list, OpenAI, Anthropic, and xAI chats, streams, sample capture, alias switching, and one fallback. It recorded `validated_live` with `confirm-live-deployment` after a succeeded call.

The run did not refresh a qualification profile. Qualification thresholds stay unchanged. The run did not create a rollout, a promotion, or a guardrail. It did not send feedback. It did not add xAI to the shadow candidate list. It did not turn selection on.

## Deploy

`./llm-proxy-docker.sh keys` exited 0. The command rebuilt the app image and recreated the app. The image command is `node dist/index.js`. Migration `032_deployment_ops.sql` is applied. The ready check passed. The command printed no key value.

`keys` reported these changes:

- `openai: key replaced`
- `openai: upstream model updated`
- `anthropic: key replaced`
- `anthropic: capabilities updated`
- `xai: key replaced`
- `xai: data class set to internal`
- `xai: data collection set to allow`
- `xai: sample policy allow-list updated`

`keys` left selection off and left automatic promotion off. It did not mark a deployment validated.

| Deployment | Before keys | After keys |
| --- | --- | --- |
| openai | `gpt-4o-mini`, config 6, capabilities `temperature` and `max_tokens`, `unvalidated` | `gpt-6-luna`, config 7, same capabilities, `unvalidated` |
| anthropic | `claude-sonnet-5-5`, config 6, capabilities `temperature` and `max_tokens` | `claude-sonnet-5-5`, config 7, capability `max_tokens` |
| xai | `grok-4.7`, config 2, empty data class, empty data collection | `grok-4.7`, config 4, data class `internal`, data collection `allow` |

The operator file still sets `OPENAI_MODEL` to `gpt-6-luna`, `ANTHROPIC_MODEL` to `claude-sonnet-5-5`, `XAI_MODEL` to `grok-4.7`, and `ANTHROPIC_MAX_OUTPUT_TOKENS` to `1024`. A later `keys` run will store `gpt-6-luna` again.

Sample policy version 3 is `encrypted_sample`. Content capture is on. Streaming capture is off. Replay is on. The sample rate is 1. The maximum sample count is 20. Classifications are `internal`. Providers and deployments are `openai`, `anthropic`, and `xai`. Versions 1 and 2 remain stored.

The xAI context limit is empty. OpenAI and Anthropic keep context limit 128000.

## Model name on OpenAI

The first OpenAI chat used the model `keys` had just stored.

| Field | Value |
| --- | --- |
| HTTP | 502 |
| Request id | `d7cb6f66-845e-4ff2-9667-af9da6155992` |
| Deployment | `openai` |
| Attempt count | 1 |
| Fallback header | `false` |
| Upstream model | `gpt-6-luna` |
| Status | `failed` |
| Error code | `upstream_error` |
| Failure class | `client_error` |
| Duration | 1232 ms |
| Tokens | none |
| Cost status | `unknown` |

`set-deployment-model` then stored `gpt-4o-mini` and moved the OpenAI config version from 7 to 8. Later chats in this run used serving model `gpt-4o-mini-2024-07-18`.

## Spend

Known attempt costs created after 20:03:00Z sum to 0.03601165 USD. That sum covers 24 of the 28 attempts. Four attempts have cost status `unknown` and a null amount.

| Provider | Attempts | Priced | Unknown | USD |
| --- | --- | --- | --- | --- |
| OpenAI | 14 | 10 | 4 | 0.00005565 |
| Anthropic | 7 | 7 | 0 | 0.001416 |
| xAI | 7 | 7 | 0 | 0.034540 |

The four unknown OpenAI attempts are the `gpt-6-luna` probe, the stream with `include_usage` false, the failed primary attempt in the fallback, and the named OpenAI call during that fallback.

Stored rates per token are OpenAI input 0.00000015 and output 0.0000006, Anthropic input 0.000003 and output 0.000015, and xAI input 0.000002 and output 0.000006. The xAI price has no thinking rate, so thought tokens use the output rate. Cached tokens stay inside the prompt count. A null cache count does not block the thought gap.

Checks against the stored amounts:

- OpenAI `27508c78-a438-40c4-9dcf-515194a40077`: 16 input and 5 output. `16 * 0.00000015 + 5 * 0.0000006 = 0.0000054`.
- Anthropic `48334255-4161-4516-a14a-3c70db12dac9`: 21 input and 9 output. `21 * 0.000003 + 9 * 0.000015 = 0.000198`. Cache read and cache write are 0.
- xAI `8784f44f-4ff6-4a78-956c-39129d5fef74`: prompt 1251, completion 13, total 1847. The gap is 583. The row stores thoughts 583. Cache read and cache write are null. `1251 * 0.000002 + (13 + 583) * 0.000006 = 0.006078`.

## Result index

| Capability | Result | Record |
| --- | --- | --- |
| Health | pass | HTTP 200 before the calls and after the restore. |
| Model list | pass | `anthropic`, `auto`, `openai`, `xai`. |
| Keys apply | pass | Model, capabilities, data class, data collection, and the xAI sample allow-list changed. |
| OpenAI model sync | pass | The file model `gpt-6-luna` was stored. The provider rejected it. |
| OpenAI chat | pass | HTTP 200 after the deployment model was `gpt-4o-mini`. |
| Anthropic chat | pass | HTTP 200. JSON object returned. |
| Anthropic temperature | pass | HTTP 400. The capability list rejects `temperature`. No provider call. |
| xAI chat | pass | HTTP 200. Model `grok-4.7`. Thought tokens are stored. |
| OpenAI stream | pass | Completed. Body ends with `data: [DONE]`. Usage is stored. |
| Anthropic stream | pass | Completed. Body ends with `data: [DONE]`. Usage is stored. |
| xAI stream | pass | Completed. Body ends with `data: [DONE]`. Usage and thoughts are stored. |
| Usage flag | pass | `include_usage: false` leaves tokens null and cost `unknown`. |
| Alias switch | pass | `auto` followed OpenAI, then Anthropic, then xAI, then OpenAI. |
| Named model | pass | A named call stayed on the named deployment during each switch. |
| Fallback | pass | `auto` used Anthropic on attempt 2. Header `x-fallback: true`. |
| Samples | pass | xAI is on the allow-list. Identical OpenAI text was skipped as `duplicate`. Streams were skipped as `streaming_capture`. |
| Live confirmation | pass | All three deployments are `validated_live`. |
| Shadow ranking | pass | Eligible count 0. The route stayed on the alias baseline. |
| Rollout and promotion | pass | Counts stay 0. No create call was sent. |

## Live calls

`GET /v1/models` returned HTTP 200. The ids are `anthropic`, `auto`, `openai`, and `xai`.

Every chat used task `general_qa`. The short JSON text length is 28 characters and `max_tokens` is 16. The temperature text length is 39 and `temperature` is 0. The longer text length is 70 and `max_tokens` is 32. The Unicode text length is 53, the text contains a line break, and `max_tokens` is 24. The stream text length is 26 and `max_tokens` is 16. The alias text length is 26. The restore text length is 25. The fallback text length is 27.

| Call | HTTP | Request id | Deployment | Fallback | Attempts |
| --- | --- | --- | --- | --- | --- |
| OpenAI short | 200 | `27508c78-a438-40c4-9dcf-515194a40077` | openai | false | 1 |
| Anthropic short | 200 | `48334255-4161-4516-a14a-3c70db12dac9` | anthropic | false | 1 |
| xAI short | 200 | `8784f44f-4ff6-4a78-956c-39129d5fef74` | xai | false | 1 |
| OpenAI repeat | 200 | `928e5f20-2179-4c43-9492-b9c052c18348` | openai | false | 1 |
| xAI repeat | 200 | `f7375dc3-24f4-4c1c-9bb3-cf468a2e1b65` | xai | false | 1 |
| OpenAI temperature 0 | 200 | `a14d93e3-8f53-45d4-bfc3-ba478df23622` | openai | false | 1 |
| Anthropic temperature 0 | 400 | none | none | none | none |
| xAI temperature 0 | 200 | `c49bdbce-b78d-4931-930b-d6f2ef472a97` | xai | false | 1 |
| OpenAI longer | 200 | `e67cd941-4b48-4a95-b6e0-193b4b0c1f30` | openai | false | 1 |
| Anthropic longer | 200 | `09a3c796-43f3-45e6-9563-469dd947cf17` | anthropic | false | 1 |
| xAI longer | 200 | `b20fc127-2ce7-4812-bb92-7f050ac7d87c` | xai | false | 1 |
| OpenAI Unicode | 200 | `1dc38823-981b-4cc2-adfc-0705111c364b` | openai | false | 1 |
| Anthropic Unicode | 200 | `b943614b-c48b-441d-9279-faa46b88251c` | anthropic | false | 1 |
| xAI Unicode | 200 | `205e270b-05c7-407d-8dd1-8a375dc88578` | xai | false | 1 |
| Alias `auto` on OpenAI | 200 | `537ee5dd-d697-4929-a6b8-0fecaf178d58` | openai | false | 1 |
| Alias `auto` on Anthropic | 200 | `34ee2bc6-6a43-4a22-aa7d-fe23d4f6f39f` | anthropic | false | 1 |
| Named OpenAI during Anthropic alias | 200 | `1ba741d3-0518-46f5-89a2-89db12e6023e` | openai | false | 1 |
| Alias `auto` on xAI | 200 | `cb7bf825-0550-459f-a584-4863235bd17f` | xai | false | 1 |
| Named Anthropic during xAI alias | 200 | `fe9380ac-3ba6-435e-8734-d5ef2054626f` | anthropic | false | 1 |
| Alias `auto` restored | 200 | `31dd6524-a5a4-49dc-bd81-53f60be0c838` | openai | false | 1 |
| Fallback `auto` | 200 | `ea77681c-24b8-4564-9d33-7a7c3948c0d1` | anthropic | true | 2 |
| Named OpenAI during fallback | 502 | `4a3c7d5d-c64f-43ad-9bbe-6301083261a5` | openai | false | 1 |
| Alias `auto` after fallback off | 200 | `dcfc60b4-c458-4c82-802f-0f2d3fc01d20` | openai | false | 1 |

The Anthropic temperature call returned in 32 ms. The body code is `unsupported_parameter`. The message is `temperature is not supported by this model.` The call has no request id and no attempt row. The Anthropic capability list is `max_tokens`, so the proxy rejects the field before a provider call.

OpenAI and xAI accept `temperature` because their capability lists include it. Both temperature calls returned HTTP 200.

The short OpenAI and short Anthropic completions are the requested JSON object. The length is 11 characters. The short xAI completion length is 54. The xAI repeat completion length is 66. The xAI temperature call returned the requested JSON object. The length is 11. The longer calls finished with length 44 on every provider. The Unicode calls returned HTTP 200. The OpenAI and Anthropic responses contain a non-ASCII character. The xAI response length is 54 and contains no non-ASCII character.

## Tokens and cost

Serving model `gpt-4o-mini-2024-07-18` is the OpenAI response model. Anthropic rows use upstream model `claude-sonnet-5-5`. xAI rows use serving model `grok-4.7`. Durations are the stored `duration_ms` values.

| Request id | Provider | In / out / total | Thoughts | Duration ms | Cost status | USD |
| --- | --- | --- | --- | --- | --- | --- |
| `27508c78-a438-40c4-9dcf-515194a40077` | openai | 16 / 5 / 21 | none | 1301 | estimated | 0.0000054 |
| `48334255-4161-4516-a14a-3c70db12dac9` | anthropic | 21 / 9 / 30 | none | 1333 | provisional | 0.000198 |
| `8784f44f-4ff6-4a78-956c-39129d5fef74` | xai | 1251 / 13 / 1847 | 583 | 7597 | estimated | 0.006078 |
| `928e5f20-2179-4c43-9492-b9c052c18348` | openai | 16 / 5 / 21 | none | 1237 | estimated | 0.0000054 |
| `f7375dc3-24f4-4c1c-9bb3-cf468a2e1b65` | xai | 1251 / 14 / 1793 | 528 | 4816 | estimated | 0.005754 |
| `a14d93e3-8f53-45d4-bfc3-ba478df23622` | openai | 18 / 5 / 23 | none | 926 | estimated | 0.0000057 |
| `c49bdbce-b78d-4931-930b-d6f2ef472a97` | xai | 1253 / 5 / 1341 | 83 | 1719 | estimated | 0.003034 |
| `e67cd941-4b48-4a95-b6e0-193b4b0c1f30` | openai | 22 / 13 / 35 | none | 1177 | estimated | 0.0000111 |
| `09a3c796-43f3-45e6-9563-469dd947cf17` | anthropic | 31 / 21 / 52 | none | 1354 | provisional | 0.000408 |
| `b20fc127-2ce7-4812-bb92-7f050ac7d87c` | xai | 1257 / 13 / 1348 | 78 | 1383 | estimated | 0.00306 |
| `1dc38823-981b-4cc2-adfc-0705111c364b` | openai | 19 / 12 / 31 | none | 766 | estimated | 0.00001005 |
| `b943614b-c48b-441d-9279-faa46b88251c` | anthropic | 24 / 15 / 39 | none | 1358 | provisional | 0.000297 |
| `205e270b-05c7-407d-8dd1-8a375dc88578` | xai | 1254 / 11 / 2424 | 1159 | 13553 | estimated | 0.009528 |
| `537ee5dd-d697-4929-a6b8-0fecaf178d58` | openai | 13 / 2 / 15 | none | 660 | estimated | 0.00000315 |
| `34ee2bc6-6a43-4a22-aa7d-fe23d4f6f39f` | anthropic | 16 / 3 / 19 | none | 1303 | provisional | 0.000093 |
| `1ba741d3-0518-46f5-89a2-89db12e6023e` | openai | 16 / 5 / 21 | none | 424 | estimated | 0.0000054 |
| `cb7bf825-0550-459f-a584-4863235bd17f` | xai | 1248 / 12 / 1533 | 273 | 3272 | estimated | 0.004206 |
| `fe9380ac-3ba6-435e-8734-d5ef2054626f` | anthropic | 21 / 9 / 30 | none | 1115 | provisional | 0.000198 |
| `31dd6524-a5a4-49dc-bd81-53f60be0c838` | openai | 13 / 2 / 15 | none | 495 | estimated | 0.00000315 |
| `ea77681c-24b8-4564-9d33-7a7c3948c0d1` attempt 2 | anthropic | 17 / 4 / 21 | none | 1152 | provisional | 0.000111 |

Anthropic cache read and cache write are 0 on every Anthropic attempt in this run. xAI thought counts match `total - prompt - completion` on every xAI attempt above. The largest xAI amount is the Unicode call, 0.009528 USD, with 1159 thought tokens.

## Streams

The default stream omits `stream_options`. The proxy requests usage. One OpenAI stream sends `stream_options.include_usage` false.

| Call | Request id | Client events | `[DONE]` | DB chunks | Bytes | Stream status | In / out / total | Thoughts | USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `a3c1349e-b2ef-4bef-985c-fce76ae661d6` | 5 | yes | 6 | 1080 | completed | 13 / 2 / 15 | none | 0.00000315 |
| Anthropic | `a43c0a2a-6034-43d4-8415-1deeff7821ad` | 5 | yes | 6 | 1018 | completed | 17 / 4 / 21 | none | 0.000111 |
| xAI | `d1bc875d-1a79-4661-8aa7-dc7f1163a7a5` | 4 | yes | 5 | 809 | completed | 1248 / 1 / 1312 | 63 | 0.00288 |
| OpenAI, usage off | `c5597bf9-0add-4ee9-8e47-0db8848df653` | 18 | yes | 19 | 3878 | completed | none | none | none |

Each stream returned HTTP 200, deployment header equal to the named model, attempt count 1, and fallback `false`. The Anthropic stream status is `completed` and the body ends with `data: [DONE]`. The xAI stream stores thoughts 63, and `1312 - 1248 - 1 = 63`. The usage-off stream stores a null token count and cost status `unknown`. Its visible text length is 86 characters. The serving model on that row is still `gpt-4o-mini-2024-07-18`.

## Alias switching

`auto` started on `openai`. `set-alias` pointed it at `anthropic`, then `xai`, then `openai` again. Each command exited 0. The alias id stayed `3d80ecae-6e9d-42f2-8378-f3555cfb7e25`.

| Alias target | `auto` request | Header deployment | Named call during that setting | Named header |
| --- | --- | --- | --- | --- |
| openai | `537ee5dd-d697-4929-a6b8-0fecaf178d58` | openai |  |  |
| anthropic | `34ee2bc6-6a43-4a22-aa7d-fe23d4f6f39f` | anthropic | `1ba741d3-0518-46f5-89a2-89db12e6023e` | openai |
| xai | `cb7bf825-0550-459f-a584-4863235bd17f` | xai | `fe9380ac-3ba6-435e-8734-d5ef2054626f` | anthropic |
| openai | `31dd6524-a5a4-49dc-bd81-53f60be0c838` | openai |  |  |

Every alias call in this section has `x-fallback: false` and `x-attempt-count: 1`. The same alias text was used for the first three `auto` calls. Each deployment stored its own sample. A named call kept its own deployment while `auto` pointed somewhere else.

At the end of the run the alias `auto` points at `openai`.

## Fallback

Before this run, fallback policy version 1 was enabled. Its failure list is `unavailable`. Its required capabilities are `temperature` and `max_tokens`. Its provider is `anthropic`. Its id is `c98e09ab-a933-4a79-b304-002ccc972ce5`. Alias calls before the fallback section store fallback policy version 1 and trigger reason `primary`. They returned the alias target. Header `x-fallback` is `false`.

Anthropic no longer lists `temperature`, so version 1 cannot select that deployment. The run stored a new version for the switch test.

`confirm-live-deployment` ran after a succeeded call on each deployment:

| Deployment | Config version | Validation |
| --- | --- | --- |
| openai | 9 | `validated_live` |
| anthropic | 8 | `validated_live` |
| xai | 5 | `validated_live` |

`set-fallback-policy` then stored version 2, id `8ee9bdcf-01e2-48c7-b5a0-afa0f273fee6`. It is enabled. The deployment is `anthropic`. The failure is `client_error`. Max attempts are 2. The required capability is `max_tokens`. The provider is `anthropic`. Data collection is `allow`. The region list is empty. The minimum remaining deadline is 0.

`set-deployment-model` then stored upstream model `gpt-not-a-model` on OpenAI. The OpenAI config version became 10.

The `auto` request `ea77681c-24b8-4564-9d33-7a7c3948c0d1` returned HTTP 200. Headers are `x-deployment: anthropic`, `x-attempt-count: 2`, and `x-fallback: true`.

| Attempt | Deployment | Status | Failure class | Trigger | Upstream model | Duration | Policy version | USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | openai | failed | `client_error` | primary | `gpt-not-a-model` | 188 ms | 2 | none |
| 2 | anthropic | succeeded |  | `client_error` | `claude-sonnet-5-5` | 1152 ms | 2 | 0.000111 |

The failed primary has error code `upstream_error`, no tokens, and cost status `unknown`. The response body is the Anthropic completion. The switch happened before the response headers.

The named OpenAI request `4a3c7d5d-c64f-43ad-9bbe-6301083261a5` returned HTTP 502. Headers are `x-deployment: openai`, `x-attempt-count: 1`, and `x-fallback: false`. The attempt is `failed`, failure class `client_error`, upstream model `gpt-not-a-model`, duration 121 ms, cost status `unknown`. A named model stayed on OpenAI.

`set-deployment-model` restored `gpt-4o-mini`. The OpenAI config version is 11. `set-fallback-policy` stored version 3, id `832729eb-452e-4384-961a-ccec3a4d410e`, with enabled false. The following `auto` request `dcfc60b4-c458-4c82-802f-0f2d3fc01d20` returned HTTP 200 on `openai` with fallback `false`, attempt count 1, and fallback policy version 3.

Version 1 remains stored. The alias points at version 3. Fallback is off.

## Samples

Policy version 3 captured the calls below. Each row is `general_qa`, data class `internal`, and an input size equal to the user-text length. Streaming capture is off, so a completed stream writes `sample capture skipped` with reason `streaming_capture`.

| Sample id | Request id | Deployment | Input size | Bytes |
| --- | --- | --- | --- | --- |
| `e51783ff-f39a-42aa-8d39-057b03f8b2a4` | `27508c78-a438-40c4-9dcf-515194a40077` | openai | 28 | 495 |
| `2f833256-294e-46e5-bb90-e7110f2fd5d2` | `48334255-4161-4516-a14a-3c70db12dac9` | anthropic | 28 | 516 |
| `834096e9-2a40-4573-ace9-e0e27618f174` | `8784f44f-4ff6-4a78-956c-39129d5fef74` | xai | 28 | 518 |
| `be0edfb3-da8b-42ad-823f-e572c7202f7f` | `f7375dc3-24f4-4c1c-9bb3-cf468a2e1b65` | xai | 28 | 532 |
| `eae0c67e-851d-4de6-80be-d44f033b652f` | `a14d93e3-8f53-45d4-bfc3-ba478df23622` | openai | 39 | 522 |
| `e07f8177-3f3b-4a2d-8c07-340bd532df2a` | `c49bdbce-b78d-4931-930b-d6f2ef472a97` | xai | 39 | 504 |
| `a12b231d-0ac6-4403-8849-d59fe954b7f0` | `e67cd941-4b48-4a95-b6e0-193b4b0c1f30` | openai | 70 | 566 |
| `a2dbf0c9-83e8-431a-92e9-c3afeeaa702d` | `09a3c796-43f3-45e6-9563-469dd947cf17` | anthropic | 70 | 587 |
| `f6778325-2801-4f66-a0ae-db1bacb748db` | `b20fc127-2ce7-4812-bb92-7f050ac7d87c` | xai | 70 | 548 |
| `d3179e95-a6bd-4664-bdd4-4ee3190d2a97` | `1dc38823-981b-4cc2-adfc-0705111c364b` | openai | 53 | 557 |
| `ccec961b-d4f0-471d-b12c-207dcdf9e333` | `b943614b-c48b-441d-9279-faa46b88251c` | anthropic | 53 | 572 |
| `e2dd5d0b-3d4f-458f-9bcc-f6a19ce3cb90` | `205e270b-05c7-407d-8dd1-8a375dc88578` | xai | 53 | 543 |
| `83c50642-1c32-4c39-b085-772d957b6671` | `537ee5dd-d697-4929-a6b8-0fecaf178d58` | openai | 26 | 480 |
| `1d803860-5b4c-42ea-97f4-2953be3a1062` | `34ee2bc6-6a43-4a22-aa7d-fe23d4f6f39f` | anthropic | 26 | 494 |
| `3fbfb7f6-19d3-4cf8-994e-81419a0a2606` | `cb7bf825-0550-459f-a584-4863235bd17f` | xai | 26 | 512 |
| `ae146468-2116-4de7-a424-870d2aac8f8c` | `31dd6524-a5a4-49dc-bd81-53f60be0c838` | openai | 25 | 478 |
| `51d2d8f6-8661-4797-846b-1ff46dc02e70` | `ea77681c-24b8-4564-9d33-7a7c3948c0d1` | anthropic | 27 | 496 |

The same short text stored one OpenAI sample and one Anthropic sample. Both completions are the JSON object of length 11. The second OpenAI call with that text logged `sample capture skipped`, reason `duplicate`, request `928e5f20-2179-4c43-9492-b9c052c18348`.

The xAI repeat used the same short text and stored sample `be0edfb3-da8b-42ad-823f-e572c7202f7f`. The completion length changed from 54 to 66, so the fingerprint changed.

Skipped samples, from the app log line `sample capture skipped`:

| Request id | Deployment | Reason |
| --- | --- | --- |
| `928e5f20-2179-4c43-9492-b9c052c18348` | openai | `duplicate` |
| `a3c1349e-b2ef-4bef-985c-fce76ae661d6` | openai | `streaming_capture` |
| `a43c0a2a-6034-43d4-8415-1deeff7821ad` | anthropic | `streaming_capture` |
| `d1bc875d-1a79-4661-8aa7-dc7f1163a7a5` | xai | `streaming_capture` |
| `c5597bf9-0add-4ee9-8e47-0db8848df653` | openai | `streaming_capture` |
| `1ba741d3-0518-46f5-89a2-89db12e6023e` | openai | `duplicate` |
| `fe9380ac-3ba6-435e-8734-d5ef2054626f` | anthropic | `duplicate` |
| `dcfc60b4-c458-4c82-802f-0f2d3fc01d20` | openai | `duplicate` |

The log line carries the request id, the deployment, and the reason. It carries no prompt.

Open samples are 20. The policy maximum is 20. This run stored 17 new samples. Three open samples were already present. The run sent no further distinct chat after the count reached 20.

## Shadow ranking and evidence

`POST /internal/v1/routing/simulate` for `model: auto` returned HTTP 200. `routingMode` is `shadow`. `baselineDeployment` is `openai`. `recommendedDeployment` is null. `eligibleCount` is 0. `candidateCount` is 2. `reasonCodes` is `baseline_fallback`. `estimatedSavings` is null. `computationMs` is 1. `savingsKind` is `estimate`. The exclusions are `openai` reason `task_unmatched` and `anthropic` reason `quality_failed`. The route does not call a provider.

The activation is still `shadow`, epoch 3, baseline `openai`, candidates `anthropic` and `openai`, task segment `general_qa`. xAI is outside that candidate list. Rollout count is 0. Promotion count is 0. Automatic promotion policy count is 0.

The qualified assessment row is unchanged. Snapshot `2f9c9777-0927-4af2-bdab-f6d6f378c177` stays `qualified`. `difference_lower` stays `-0.793457`. Profile version `087eec57-8301-40b8-9642-fea795140d3a` stores deployment config 6 for `claude-sonnet-5-5`. The live Anthropic config version is 8. This run did not refresh the snapshot. Selection is off, so that config gap did not choose a route.

The older snapshot `3ffc1803-6e10-4c1d-a08b-b820a60c5177` stays `invalidated` with reason `capability_mismatch`. Snapshot `f0d35569-c19e-4e5e-9d2c-7b12cea2ab15` stays `inconclusive` with reason `insufficient_samples`.

## Config versions

| Step | OpenAI | Anthropic | xAI |
| --- | --- | --- | --- |
| Before keys | 6, `gpt-4o-mini` | 6, capabilities include `temperature` | 2, empty data class |
| After keys | 7, `gpt-6-luna` | 7, capability `max_tokens` | 4, `internal` / `allow` |
| `set-deployment-model` to `gpt-4o-mini` | 8 | 7 | 4 |
| `confirm-live-deployment` | 9, `validated_live` | 8, `validated_live` | 5, `validated_live` |
| Upstream `gpt-not-a-model` | 10 | 8 | 5 |
| Upstream restored to `gpt-4o-mini` | 11 | 8 | 5 |

## End state

The stack is up. Ready is HTTP 200.

| Item | Value |
| --- | --- |
| Alias `auto` | `openai` |
| OpenAI upstream | `gpt-4o-mini` |
| OpenAI validation | `validated_live`, config 11, capabilities `temperature` and `max_tokens` |
| Anthropic upstream | `claude-sonnet-5-5` |
| Anthropic validation | `validated_live`, config 8, capability `max_tokens` |
| xAI upstream | `grok-4.7` |
| xAI validation | `validated_live`, config 5, data class `internal`, data collection `allow` |
| xAI context limit | empty |
| Fallback on `auto` | version 3, enabled false, failure `client_error`, provider `anthropic` |
| Sample policy | version 3, `encrypted_sample`, streaming capture off, xAI allowed |
| Selection | off |
| Rollouts | 0 |
| Promotions | 0 |

## Findings

`keys` writes the operator file model onto an existing deployment. `gpt-6-luna` is stored and the provider returns `client_error`. Keep live OpenAI calls on `gpt-4o-mini` by changing `OPENAI_MODEL` before the next `keys` run, or run `set-deployment-model` after `keys`.

`claude-sonnet-5-5` stores no `temperature` capability. A request that sends `temperature` receives HTTP 400 from the proxy. A request that omits `temperature` returns HTTP 200. The Anthropic stream completes and ends with `data: [DONE]`.

xAI thought tokens are the positive gap `total - prompt - completion`. They are billed at the output rate. The same rule stores thoughts on a completed xAI stream. A stream with `include_usage` false stores no token count and cost status `unknown`.

A short xAI completion is not limited to the requested JSON object. With `temperature` 0, that call did return the JSON object. The xAI prompt count stays near 1250 tokens on these short texts, so xAI is the spend driver. The Unicode xAI call cost 0.009528 USD.

The alias `auto` follows `set-alias` across OpenAI, Anthropic, and xAI. A named model stays on the named deployment. Fallback runs for `auto` before the response headers when the candidate is `validated_live` and the failure is in the stored list. The named model sent during that window stayed on OpenAI and failed there.

`confirm-live-deployment` is the writer of `validated_live`. It bumps `config_version`. The qualified snapshot row stays `qualified` and still records Anthropic config 6 while the live config is 8.

The open sample count equals the policy maximum of 20. xAI capture works on policy version 3. Streaming capture remains off.
