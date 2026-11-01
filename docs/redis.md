# Optional Redis

Back to [README](../README.md)

PostgreSQL 16 is required. Redis 7 is optional. The default mode opens no Redis connection. PostgreSQL still admits every rate, reserves every cost, and keeps every concurrency lease.

Use this page to turn Redis on for rate counters. Budgets, evaluation queues, and concurrency leases stay in PostgreSQL. Redis stores rate counters only. It stores no secret, no prompt, and no response.

## Where it fits

The proxy reaches Redis from step 2 of the [request path](architecture.md#request-path). The diagram is in the [README architecture](../README.md#how-does-it-work). Limit commands stay in [Limits and budgets](limits.md). Health fields are in [Operations](operations.md#health).

## Modes

`RATE_LIMIT_STORE` accepts `postgres`, `redis_shadow`, or `redis_active`.

| Mode | What Redis does | What admits the request |
| --- | --- | --- |
| `postgres` | No connection. This is the default. | PostgreSQL |
| `redis_shadow` | Opens one connection. A token-bucket check runs only when `REDIS_SHADOW_CHECKS=true`. | PostgreSQL |
| `redis_active` | Admits one approved hard request rate or hard token rate. | Redis for that approved policy. PostgreSQL for every other policy. |

`redis_active` is off by default. An approval has no effect in `postgres` or `redis_shadow`.

A hard request rate and a hard token rate are strict. An observe-mode request rate and an observe-mode token rate are advisory. Observe mode stays on PostgreSQL even when you approve it.

Enable the modes in this order. Start with shadow. Then approve one test tenant. Then approve a limited set.

Rollback is immediate. Set `RATE_LIMIT_STORE=postgres` and restart the app. Stored approvals stay in PostgreSQL and do nothing in that mode.

## Start Redis

The local control script starts PostgreSQL, the app, and Nginx. It does not start Redis. Start Redis with the Compose profile. The service joins the private network. Compose does not publish port 6379.

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
docker compose --profile redis up -d redis
```

Set these values in `config/docker.env`. That file is gitignored. Copy the names from `config/docker.env.example`.

```bash
RATE_LIMIT_STORE=redis_shadow
REDIS_SHADOW_CHECKS=false
REDIS_URL=redis://redis:6379
REDIS_USERNAME=proxy
REDIS_PASSWORD=<proxy password from docker/redis/users.acl>
REDIS_TLS=false
```

The URL uses `redis:` or `rediss:`. Put no password in the URL. The user is `proxy`. The user `default` is disabled. The local proxy user can write only a key that starts with `rl:`.

Restart the app so Compose reads the file.

```bash
./llm-proxy-docker.sh start
```

Confirm the link before you compare counters.

```bash
curl -s --cacert config/ingress/live/ca.crt https://127.0.0.1/health/redis
```

The mode is `redis_shadow`. The state is `connected`. `GET /health/ready` stays a database check. A Redis failure does not change it.

## Compare in shadow

Set `REDIS_SHADOW_CHECKS=true`. Restart the app.

The check covers the tenant request rate, the API-key request rate, the tenant token rate, and the API-key token rate. The bucket uses Redis server time. The same attempt id does not spend the bucket twice. The HTTP decision stays the PostgreSQL decision. A Redis timeout or a bad reply leaves that decision unchanged.

`GET /health/redis` shows the PostgreSQL decision beside the Redis decision.

## Admit one hard rate

Set the policy to hard and set its limit first. An observe-mode approval does not move that rate to Redis.

```bash
docker compose run --rm app node dist/cli.js set-tenant-limits \
  --tenant-id <tenant-id> \
  --mode hard \
  --requests-per-minute 60
docker compose run --rm app node dist/cli.js activate-redis-rate \
  --tenant-id <tenant-id> \
  --scope tenant_requests
```

The scopes are `tenant_requests`, `tenant_tokens`, `api_key_requests`, and `api_key_tokens`. An API-key scope also needs `--key-id`. The command prints JSON with `tenantId`, `scope`, `scopeId`, and `generation`.

A policy with no approval stays on PostgreSQL. Repeat the command for each policy you want Redis to admit. Approve one test tenant before you approve more.

Then set `RATE_LIMIT_STORE=redis_active` and restart the app. `REDIS_SHADOW_CHECKS` does not admit in this mode.

Remove one approval with the same scope:

```bash
docker compose run --rm app node dist/cli.js deactivate-redis-rate \
  --tenant-id <tenant-id> \
  --scope tenant_requests
```

## How the active counter works

PostgreSQL remains the authority for the minute limit. Before Redis spends anything, PostgreSQL charges a slice of that limit and stores a versioned allocation. Redis receives only the remaining count of that slice.

The Redis key starts with `rl:{tenant}`. The hash tag is the tenant id, so the counters for one tenant share one cluster slot. Several proxy replicas read the same key.

A missing key is not a fresh full grant. A Redis restart, a lost key, or a failed command denies that hard admission. PostgreSQL does not grant the charged slice again.

One Redis failure opens a circuit on that proxy process. Each replica has its own circuit. While the circuit is open, an approved hard admission is denied. After the cooldown, one probe checks Redis. A successful probe closes the open allocations and closes the circuit. Recovery does not return the unused part of a slice. A later request can use only capacity that PostgreSQL has not charged. A failed probe keeps the circuit open.

A second activation closes the open allocation and raises `generation`. It does not return the unused part.

Every admitted request still takes its PostgreSQL cost reservation. A budget outage does not admit the request. A stream that already started keeps its PostgreSQL lease and its cost reservation. A Redis loss does not open a second rate grant for that stream.

Connection limits and deployment limits stay in PostgreSQL. Those limits are concurrency leases. Evaluation queues stay in PostgreSQL. The evaluation worker does not use Redis.

`GET /health/redis` reports `circuit`, `activeAllows`, `activeDenies`, `fallbackDenies`, `epochCloses`, and `lastRecoveryMs` in `redis_active`.

The connect timeout, the reconnect timeout, and `REDIS_BREAKER_COOLDOWN_MS` are integers from 100 to 10000. Each default is 1000 milliseconds.
