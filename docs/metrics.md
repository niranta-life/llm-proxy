# Metrics

Back to [README](../README.md)

[llm-proxy](../README.md) exposes tenant metrics on internal routes. Each route uses the same `X-Tenant-ID` and `Authorization` headers as chat. Another tenant does not appear in the body.

`from` and `to` are absolute timestamps with `Z` or an offset, such as `2026-01-01T00:00:00Z`. `to` must be later than `from`. The window includes `from` and excludes `to`. The longest window is 32 days.

The summary has no price and no quality score. Empty latency and empty token sums are null. The proxy does not invent a zero.

## Where it fits

These routes read the rows written in step 3 and step 7. This page covers step 7. See the [request path](architecture.md#request-path).

## Summary

`GET /internal/v1/metrics/summary` returns request counts and the sums of provider token counts. A sum is null when the provider sent no usage. It also returns the latency sample count, the latency sum, and the latency maximum.

Stream fields:

- Stream request count.
- Completed, cancelled, failed, and truncated counts.
- Stream token sums.
- P50 and P95 of the time to the first text.
- P50 and P95 of the stream duration.

The route does not store a P99. A window with no samples has a null P50 and a null P95.

A cancellation is `client_aborted`. A stream error is `provider_failed`, `timed_out`, `slow_consumer`, or `interrupted`. The stream section counts only streams.

A provider row counts each stream attempt and each non-stream attempt for that provider. A deployment row does the same for that deployment. A succeeded non-stream attempt counts as completed. A failed one counts as an error. A cancelled one counts as cancelled. A provider token sum includes a non-stream response when the provider sent integer counts.

## Costs

`GET /internal/v1/metrics/costs` uses the same window. You can filter with `provider`, `deployment`, and `model`. An empty filter is rejected.

Estimated, provisional, reconciled, and unknown amounts stay apart. An unknown amount is null. A cache rate and a thinking rate are billed only when that count is stored. A DGX allocated cost stays apart from an external provider charge. A stored amount keeps the price version that was in force for that attempt. See [Cost](cost.md).

## Attempts

`GET /internal/v1/metrics/attempts` uses the same window and the same optional filters. Each attempt is one row. The row has the attempt, the request, the ordinal, the failure class, the duration, the expense certainty, and `dispatched`. A cost amount is text. A missing amount is null.

A fallback shows both attempts, with the trigger reason, the duration, the reservation, and the policy version.

## Breakers

`GET /internal/v1/metrics/breakers` can filter with `deployment`. Each item has the state, the reason, the time, the health sample count, the failure count, the rate-limit count, and the probe count. The rate-limit count is separate from the failure count. A deployment with no breaker is closed and disabled. See [Circuit breaker](breaker.md).

## Request features

`GET /internal/v1/request-features` lists characteristics of completed chats for the caller. `GET /internal/v1/request-features/{requestId}` returns one row. Both use the same tenant headers as chat. Another tenant's row is not returned.

The list accepts `limit` from 1 to 50, `category`, and `cursor`. A bad value is rejected. The next page does not repeat ids from the page before it.

Each row has the task category, how that category was chosen, a local input-token estimate, and provider usage when the provider sent it. A missing usage count stays null. The row also has message count, whether a system instruction was present, whether streaming was requested, conversation depth, input size, a complexity estimate, the requested model, the selected deployment, the execution status, the latency, a cost reference, and the extractor version.

The cost reference is the attempt id and the stored cost status. It is not a new charge. A missing cost row leaves those fields empty.

## Encrypted samples

`GET /internal/v1/samples` lists sample metadata for the caller. `GET /internal/v1/samples/{sampleId}` returns one row. `GET /internal/v1/samples/stats` returns counts and task coverage. `DELETE /internal/v1/samples/{sampleId}` deletes one sample for the caller. These routes use the same tenant headers as chat. Another tenant's row is not returned.

The list accepts `limit` from 1 to 50, `provider`, and `cursor`. A bad value is rejected. The next page does not repeat ids from the page before it.

Each row has the sample id, the request id, the policy version, the provider, the deployment, the ciphertext size, and the times. It does not include the prompt, the completion, or the ciphertext. A row is returned only while capture is still enabled and the sample has not expired. After capture is turned off, or after the expiry time, the list and the single-sample route stop returning that sample. Stats then report zero retained samples.

The stats body has the retained count, the cap, the recent share, the recent count, the diverse count, and counts by task category, input-size band, complexity, and deployment. It does not include the prompt, the completion, or the ciphertext.

A sample is stored only after the operator sets the mode to `encrypted_sample` and turns on content capture. The default is metadata only, which stores no content. When capture is enabled and the operator omits the maximum, the tenant keeps at most 100 samples. When capture is enabled and the operator omits retention, each sample expires seven days after it is stored. The default split keeps 60% of the cap for recent samples and the rest for task coverage. Coverage uses the task category, the input size, the complexity, and the deployment. The same approved content is stored once for that tenant. Replay and judge disclosure are separate and default to denied. No route returns plaintext for replay or a judge.

The stored bytes are an AES-256-GCM envelope. Each sample has its own data key. That key is wrapped by `PROVIDER_CREDENTIAL_KEY`. A retained previous wrapping key can open an older sample after rotation. The tenant id, the sample id, and the schema version are bound to the ciphertext.

Capture runs after a completed non-streaming text chat. A streaming chat is not captured. The insert stores a row only when the latest policy still allows encrypted capture. A capture failure does not change the chat response and does not retry the provider. Hidden thinking, credentials, tool secrets, and caller metadata are not stored.

Set the policy with `set-sample-policy`. Set the deployment data class with `set-deployment-data-class`. Show the current policy with `show-sample-policy`. Show coverage with `show-sample-stats`. Delete one sample with `delete-sample`. Delete expired and revoked samples with `cleanup-expired-samples`. Turn capture off with `--mode disabled` or `--mode metadata_only`. A cleanup failure does not change the chat response and does not add a provider attempt.

Categories are `classification`, `extraction`, `summarization`, `reasoning`, `coding`, `translation`, `writing`, `general_qa`, and `unknown`. A caller may send `task` with one of those values. Any other `task` value is rejected and is not stored. When `task` is absent, local rules choose the category, or the category stays `unknown`. The proxy does not call a model to classify the request.

A successful chat records structured output and tool use as false. `tools` and a non-text `response_format` are still rejected before a provider call. The feature row does not contain the prompt, the completion, or a credential.

## Limits and budgets

`GET /internal/v1/limits` and `GET /internal/v1/budgets/usage` use the same tenant headers. Use them before you turn observation mode into a hard limit. See [Limits and budgets](limits.md).

## Related

- [Cost](cost.md)
- [Limits and budgets](limits.md)
- [Streaming](streaming.md)
- [Chat](chat.md)
