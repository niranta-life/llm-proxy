# Metrics

[llm-proxy](../README.md) exposes tenant metrics on internal routes. Each route uses the same `X-Tenant-ID` and `Authorization` headers as chat. Another tenant does not appear in the body.

`from` and `to` are datetimes. The window includes `from` and excludes `to`. The longest window is 32 days.

The summary has no price and no quality score. Empty latency and empty token sums are null. The proxy does not invent a zero.

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

## Limits and budgets

`GET /internal/v1/limits` and `GET /internal/v1/budgets/usage` use the same tenant headers. Use them before you turn observation mode into a hard limit. See [Limits and budgets](limits.md).

## Related

- [Cost](cost.md)
- [Limits and budgets](limits.md)
- [Streaming](streaming.md)
- [Chat](chat.md)
