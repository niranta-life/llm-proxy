# Circuit breaker

[llm-proxy](../README.md) can stop calling one deployment after that deployment keeps failing. The breaker stays off until you enable it for that deployment. A deployment with no breaker row is closed and disabled.

The command does not move the alias `auto`. It does not change health status `unknown`, `healthy`, or `unhealthy`.

An open breaker rejects a new chat before the upstream request. The caller receives HTTP 503 with code `circuit_open`.

## What moves the breaker

A rate limit does not open the breaker. A caller validation error, an authentication failure, and a caller cancellation do not change it.

A connection failure counts when the provider does not accept the body. A timeout counts in that same case, including a stream. An ambiguous network failure does not open the breaker.

The breaker opens only when the sample count and the failure count both reach the configured limits. After the cooldown, only the configured number of probes reach the upstream. A successful probe closes the breaker. A failed probe opens it again.

A caller abort during a probe releases that probe. The probe count returns to zero. The abort does not open the breaker.

An open breaker on a fallback candidate skips that candidate. See [Fallback](fallback.md).

## Commands

Disable or reset the breaker instead of deleting the row. After a reset, the next chat can reach the upstream.

```bash
docker compose run --rm app node dist/cli.js set-deployment-breaker \
  --tenant-id <tenant-id> \
  --deployment <name> \
  --enabled true \
  --window-ms 60000 \
  --min-samples 4 \
  --failure-threshold 3 \
  --cooldown-ms 30000 \
  --max-probes 1
docker compose run --rm app node dist/cli.js set-deployment-breaker \
  --tenant-id <tenant-id> \
  --deployment <name> \
  --enabled false
docker compose run --rm app node dist/cli.js reset-deployment-breaker \
  --tenant-id <tenant-id> \
  --deployment <name>
```

Read the current state from `GET /internal/v1/metrics/breakers`. See [Metrics](metrics.md).

## Related

- [Retry](retry.md)
- [Fallback](fallback.md)
- [Metrics](metrics.md)
- [Operations](operations.md)
