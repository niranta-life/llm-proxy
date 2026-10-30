# Fallback

Back to [README](../README.md)

[llm-proxy](../README.md) can try one more deployment when the alias `auto` fails before any output. The behavior stays off until you store an enabled policy for that alias. A missing policy does not choose another deployment. A disabled policy does not either. An existing alias stays on its current deployment until you store a policy.

A request that names a deployment never switches. Retry and fallback do not run on the same request. See [Retry](retry.md).

The proxy uses at most two attempts, even when the stored maximum is higher. It does not ask a model to choose. Fallback does not select a deployment by a quality score. OpenRouter `allow_fallbacks` is a separate stored flag. See [Providers](providers.md).

A routing policy is a separate record. Shadow mode stores the decision for `auto`. An evidence snapshot is also a separate record. It does not by itself choose a deployment. A shadow ranking stores a recommendation beside that decision. The recommendation is not one of the attempts. A canary rollout can pin a qualified challenger for a bounded share of `auto` before fallback runs. An operator can promote that rollout and enable selection for one task segment. Selection stays off until that enablement. Fallback does not make that choice. Fallback still uses the stored fallback policy on the deployment that runs. It runs only before the first output byte. A rollback does not start a fallback after output has begun. An in-flight fallback stays on the stored policy. See [Routing policy](operations.md#routing-policy), [Evidence qualification](operations.md#evidence-qualification), [Shadow ranking](operations.md#shadow-ranking), [Canary routing](operations.md#canary-routing), and [Governed promotion](operations.md#governed-promotion).

There is no HTTP route that writes the policy.

## Where it fits

This page covers the fallback choice in step 6. See the [request path](architecture.md#request-path).

## When it runs

Fallback runs only before the proxy sends a response header or a response byte. After output starts, the model stays put and the body is not restarted. A failure after output starts does not end with a successful `[DONE]`. The proxy records that partial failure. A caller cancellation does not start a fallback.

The failed attempt still holds its concurrency lease until settlement. The fallback check does not count that lease, so a hard cap of one still allows the next deployment for this request. A different request that holds the only permit still blocks the candidate. The primary budget reservation stays active during the check. A hard budget must fit the secondary while that reservation is active.

## Which deployment can be chosen

The proxy walks the stored order and uses the first candidate that passes every check.

- It belongs to the same tenant.
- It is enabled.
- Its validation status is `validated_live`.
- Its provider is in the approved list.
- Its data handling value matches the policy.
- If the policy lists regions, the connection location is one of those regions. A missing location does not match. An empty region list adds no region limit.
- It supports each required capability and each capability the request uses.
- Its stored context limit covers the requested output bound. That bound is `max_tokens`, `max_completion_tokens`, or 1. It is not the character length.
- The circuit breaker permits the call. An open breaker on a candidate skips that candidate.
- The rate and concurrency limits permit the call.
- The budget reservation succeeds.
- The remaining deadline meets the stored minimum.

`validate-deployment` can record `unvalidated`, `valid`, `invalid`, or `validated_mock`. It refuses `validated_live`. A new deployment starts as `unvalidated`. Until a deployment is `validated_live`, fallback will not select it. A DGX deployment is never `validated_live`.

## What the caller sees

A successful fallback returns the secondary completion. The response headers name the request, the deployment that answered, the attempt count, and whether fallback occurred:

- `x-request-id`
- `x-deployment`
- `x-attempt-count`
- `x-fallback`, set to `true` or `false`

The headers do not include a credential or the approved list.

`GET /internal/v1/metrics/attempts` shows both attempts. Each row has the trigger reason, the duration, the reservation, and the fallback policy version. Each attempt keeps its own reservation.

## Commands

`show-fallback-policy` prints the stored policy. `set-fallback-policy` stores a new version and points the alias at that version. It also takes `--capabilities`, `--regions`, and `--min-remaining-deadline-ms`. A stored policy is not edited. You replace it by storing another version. To turn the behavior off, store a version with `--enabled false`. Do not delete the policy row. The migration stays applied.

```bash
docker compose run --rm app node dist/cli.js show-fallback-policy \
  --tenant-id <tenant-id> --alias auto
docker compose run --rm app node dist/cli.js set-fallback-policy \
  --tenant-id <tenant-id> \
  --alias auto \
  --enabled false \
  --deployments <name> \
  --failures unavailable \
  --max-attempts 2 \
  --capabilities temperature \
  --providers openai \
  --data-collection allow \
  --min-remaining-deadline-ms 0
docker compose run --rm app node dist/cli.js set-deployment-context-limit \
  --tenant-id <tenant-id> --deployment <name> --context-limit 128
```

## Related

- [Retry](retry.md)
- [Limits and budgets](limits.md)
- [Circuit breaker](breaker.md)
- [Chat](chat.md)
