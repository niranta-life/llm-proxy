# Limits and budgets

Back to [README](../README.md)

[llm-proxy](../README.md) can cap how much a tenant sends, and how much it spends in a UTC month. Start in observation mode. Observation records usage and does not reject a request only because usage crossed the threshold.

Compare the inspection routes with the thresholds. Then enable hard limits for one test tenant. Confirm that an excess request is rejected before you widen the change. Hard limits are never silently bypassed.

A hard rejection is HTTP 429. The code names the limit or the budget reason. The proxy does not call the upstream model. If a hard check cannot reach the database, the response is HTTP 503 `admission_unavailable`, and the provider is not called.

You change a limit or a budget only with the CLI. There is no HTTP route for that.

## Where it fits

This page covers step 5. Admission runs after the breaker check, so a request rejected by an open breaker never reaches a limit or a reservation. See the [request path](architecture.md#request-path).

## What a limit can cover

A limit can cover requests per minute, concurrent requests, concurrent streams, a provider connection, a deployment, and a token rate when the bound is known. An API key can have its own limit. The most restrictive hard limit applies.

Limits stored with `set-tenant-limits`, `set-api-key-limits`, `set-connection-limit`, and `set-deployment-limit` are shared by every proxy process that uses the database. `set-deployment-concurrency` is a count in this process only. The process stream caps in [Streaming](streaming.md) are also per process. The stricter of the process cap and the shared cap rejects the request.

A concurrency lease expires. A later request can take the permit after that. The proxy does not keep a database transaction open during the upstream call.

The failed attempt of a fallback still holds its lease until settlement. The fallback check for that same request does not count the lease. A different request that holds the only permit still blocks the candidate. See [Fallback](fallback.md).

## Budgets

A budget mode is `observe`, `hard`, or `disabled`. The period is one UTC month. Amounts use a fixed decimal.

`GET /internal/v1/budgets/usage` shows the allocated budget, the recognized expense, the active reservations, the remaining budget, and the cost status. `GET /internal/v1/limits` shows the limits. Both use the same tenant headers as chat.

A hard budget rejects an unknown or unbounded cost before the upstream call. The estimate uses the highest of the input rate and the cache rates. A cache rate is a split of the prompt, not an extra prompt. A price with no external rate and no request fee is unknown.

The reservation is the full estimate. A settled amount cannot exceed that reservation. An observation budget still allows the request when the estimate exceeds the remaining amount.

A known charge above the allocation stays provisional. The part that fits is recognized. A known charge is still recorded when no allocation remains. Overlapping observation closes recognize against settled expense only. A sibling reservation does not reduce that room.

Remaining budget is the allocation minus recognized expense, active reservations, and provisional charges. An observation excess does not push that remainder below zero. The excess stays visible as a provisional charge. A recognized amount above the allocation is not hidden.

A timeout does not become a zero-cost call. An uncertain charge stays provisional until a verified accounting decision. A retry reserves its own amount. The same attempt is not settled twice. How prices become estimated, provisional, or unknown is in [Cost](cost.md).

A schedule reserves evaluation spend in `evaluation_budget_reservations`. It does not settle this monthly budget. When the tenant budget mode is hard, a run whose estimate is above that monthly amount is refused before a provider call. A hard concurrency limit that is already full can also stop a scheduled run. See [Evaluation schedule](cost.md#evaluation-schedule).

## Commands

```bash
docker compose run --rm app node dist/cli.js set-tenant-limits \
  --tenant-id <tenant-id> \
  --mode observe \
  --requests-per-minute 60 \
  --concurrent-requests 8 \
  --concurrent-streams 4
docker compose run --rm app node dist/cli.js set-tenant-budget \
  --tenant-id <tenant-id> \
  --mode observe \
  --monthly-amount 100
docker compose run --rm app node dist/cli.js set-tenant-limits \
  --tenant-id <tenant-id> \
  --mode hard \
  --requests-per-minute 60
docker compose run --rm app node dist/cli.js set-api-key-limits \
  --tenant-id <tenant-id> \
  --key-id <key-id> \
  --mode hard \
  --requests-per-minute 30
docker compose run --rm app node dist/cli.js set-connection-limit \
  --tenant-id <tenant-id> \
  --provider openai \
  --mode observe \
  --max-concurrency 4
docker compose run --rm app node dist/cli.js set-deployment-limit \
  --tenant-id <tenant-id> \
  --deployment <name> \
  --mode observe \
  --max-concurrency 2
docker compose run --rm app node dist/cli.js recover-budget \
  --tenant-id <tenant-id>
```

`recover-budget` closes a finished attempt that still holds a reservation. It does not free an uncertain charge. A second run does not settle that attempt again.

## Related

- [Cost](cost.md)
- [Evaluation schedule](cost.md#evaluation-schedule)
- [Fallback](fallback.md)
- [Metrics](metrics.md)
- [Chat](chat.md)
