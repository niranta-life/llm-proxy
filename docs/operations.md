# Operations

Back to [README](../README.md)

## Where it fits

This page covers the whole path. See the [request path](architecture.md#request-path).

Day-to-day start steps are on the [home page](../README.md). This page is the operator reference: configuration, health, migrations, incidents, and tests.

## What you need

- Colima, the Docker CLI, Docker Compose, and curl.
- Node.js 24 and `npm install` before tests or `scripts/check-deployed.mjs`.

`scripts/colima.sh` uses the Colima profile `default` and the socket `~/.colima/default/docker.sock`. Set `COLIMA_PROFILE` or `COLIMA_SOCKET` when yours differ. The script sets `DOCKER_HOST` for its own commands and does not change the Docker context.

Set the socket yourself before other `docker compose` commands:

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
```

```bash
scripts/colima.sh start
scripts/colima.sh start --build
scripts/colima.sh restart
scripts/colima.sh stop
scripts/colima.sh status
```

`npm run stack -- start` runs the same script. `restart --build` builds the image again and creates the containers again. `stop` keeps the database volume. Colima stops only with `--vm`. The image is `node:24-bookworm-slim`. If `DOCKER_HOST` is absent, tests use the selected Docker context.

## Check a running proxy

`scripts/check-deployed.mjs` sends request and response cases to a proxy that is already up. It does not call OpenAI.

```bash
node scripts/check-deployed.mjs --prepare-local
```

`npm run check:deployed -- --prepare-local` is the same command. It needs Colima, Docker, and Node.js. If Colima is down, the script starts the local Compose project, uses a mock server, checks HTTP, database, and process cases, restores the proxy environment, and removes the mock. The database volume stays. `--leave-prepared` does not restore the proxy environment.

For a proxy that is already in operation, pass `--base-url` or set `PROXY_BASE_URL`. `--help` shows the tenant ids, the secrets, and the mock URL that proxy must have. `--http-only` stops after the HTTP cases. Database and process cases run with `--prepare-local`, and also when `CHECK_ADMIN` is `local`.

Only `npm test` can read the backend process id of a pooled database session. The check script opens one session that does not set `app.tenant_id`, so that session reads no rows.

## Configuration

The process refuses to listen when a required value is missing or invalid.

| Variable | Required | Use |
| --- | --- | --- |
| `DATABASE_HOST` | yes | PostgreSQL host. |
| `DATABASE_PORT` | yes | PostgreSQL port. Integer from 1 through 65535. |
| `DATABASE_NAME` | yes | Database name. |
| `MIGRATOR_USER` | yes | Must be `llm_migrator`. |
| `MIGRATOR_PASSWORD` | yes | Password for the migration role. |
| `AUTH_USER` | yes | Must be `llm_auth`. |
| `AUTH_PASSWORD` | yes | Password for the authentication role. |
| `RUNTIME_USER` | yes | Must be `llm_runtime`. |
| `RUNTIME_PASSWORD` | yes | Password for the runtime role. |
| `HOST` | no | Listen address. Default `0.0.0.0`. |
| `PORT` | no | Listen port. Default `8080`. Integer from 1 through 65535. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error`. Default `info`. |
| `INFERENCE_ENABLED` | no | `true` or `false`. Default `false`. Any other value is invalid. |
| `PROVIDER_CREDENTIAL_KEY` | when inference is on | 32-byte key in base64. The CLI needs it too when it stores a provider key. |
| `OPENAI_BASE_URL` | no | OpenAI base URL. Default `https://api.openai.com/v1`. Must be an `http` or `https` URL with no user name or password. |
| `MAX_ACTIVE_STREAMS` | no | Open streams in this process. Default `32`. Integer from 1 through 10000. |
| `MAX_STREAMS_PER_TENANT` | no | Open streams for one tenant in this process. Default `32`. Same range. Not shared with another process. |
| `STREAM_SHUTDOWN_DRAIN_MS` | no | Drain time after `SIGTERM` or `SIGINT`. Default `5000`. Integer from 0 through 600000. |

The proxy does not listen with TLS. Compose passwords are for local development. There is no external secret manager. Git does not track `.env.live`, and a Docker build does not copy it.

## Health

`GET /health/live` returns `{"status":"live"}`.

`GET /health/ready` returns HTTP 200 `{"status":"ready","database":"ready"}` only when Postgres is reachable and `schema_migrations` contains the latest migration for this image. Otherwise it returns HTTP 503 `{"status":"not_ready","database":"unavailable"}`. Live stays 200.

If the database drops after the process is listening, the process keeps running. Ready goes to 503. Live stays 200.

Tenant routes are `GET /v1/tenant`, `GET /v1/models`, and `POST /v1/chat/completions`. The read routes under `/internal/v1/` use the same two tenant headers. Any other path returns HTTP 404 `{"error":"not_found"}`. An unhandled error returns HTTP 500 `{"error":"internal_error"}`.

## Database roles

The proxy connects only as `llm_migrator`, `llm_auth`, or `llm_runtime`. Those three roles are not superusers and cannot bypass row-level security.

`llm_owner` is `NOLOGIN`. It has `BYPASSRLS` and `CREATE` on `public`. It owns the tables and the `SECURITY DEFINER` functions. `llm_migrator` is a `NOINHERIT` member of `llm_owner`, so a person with the migration password can `SET ROLE llm_owner` and bypass row-level security. Keep that password secret. A tenant request does not use `llm_owner`.

The authentication role can run only `list_active_key_verifiers`. The runtime role can read tenant rows under row-level security and cannot read the verifier or the provider ciphertext. A `SECURITY DEFINER` function returns ciphertext only when the tenant in the transaction matches the row and the connection is enabled.

Migrations do not create the roles. Compose runs `docker/postgres/init.sh` as the database superuser. Tests set the same role attributes with `bootstrapRoles`. Those init scripts run only when the database volume is empty. Do not remove the volume to "reset" a running project.

You can use a PostgreSQL major version other than 16 when that version has row-level security. The local image is PostgreSQL 16.

## Logs

Each log line is one JSON object. Redaction removes a bearer token, a `yck_` tenant secret, a scrypt verifier, a provider key with the prefix `sk-`, AES-GCM ciphertext, and any field whose name identifies a secret, a prompt, or a chat message.

## Migrations

SQL files in `migrations/` apply in lexical order, once, before the proxy listens. Each file is recorded in `schema_migrations`. A later start does not apply a file that is already recorded, and it does not delete rows. Do not edit a file after it has been applied. This tree has migrations `001` through `020`. It drops nothing.

| File | What it adds |
| --- | --- |
| `001_schema.sql` | Base tables. |
| `002_security.sql` | Tenant secret check and row-level security. |
| `003_inference.sql` | Inference tables. It does not change `001` or `002`. |
| `004_anthropic.sql` | Nullable Anthropic columns and functions. Existing OpenAI rows stay as they are. |
| `005_openai_streaming.sql` | Streaming flags and stream metadata. Existing rows stay non-streaming. |
| `006_anthropic_streaming.sql` | Streaming for OpenAI and Anthropic. Later files allow Vertex, xAI, OpenRouter, and approved DGX. |
| `007_stream_interrupted.sql` | Stream status `interrupted`. |
| `008_provider_registry.sql` | Room for Vertex, xAI, OpenRouter, and private DGX configuration. |
| `009_vertex_provider.sql` | Vertex identity, API version, and Vertex streaming. |
| `010_compatible_providers.sql` | OpenRouter routing, xAI and OpenRouter streaming, and the reported model and provider on an attempt. |
| `011_private_endpoint.sql` | Private endpoint allowlist, deployment concurrency, DGX streaming, and `validated_mock`. It does not record `validated_live`. |
| `012_cost_accounting.sql` | Price versions, attempt cost, and a service tier on a deployment. |
| `013_execution_policy.sql` | Retry policy and attempt history columns. |
| `014_provider_breaker.sql` | A breaker for one deployment. |
| `015_tenant_limits.sql` | Tenant limits, concurrency leases, monthly budgets, and a cost ledger. |
| `016_fallback_policy.sql` | A versioned fallback policy for the alias `auto`. |
| `017_request_features.sql` | Characteristics of a completed chat. No prompt or completion text. |
| `018_sample_capture.sql` | A versioned sample policy and encrypted samples. The table stores ciphertext only. |
| `019_sample_retention.sql` | Sample expiry, a metadata deletion audit, and a durable cleanup job. |
| `020_stream_samples.sql` | Streaming capture flag and metadata columns for replay eligibility. Sample rows still store ciphertext only. |

Readiness for this tree checks for `020_stream_samples.sql`. An image that expects `019_sample_retention.sql` stays ready on this database because that row remains recorded. An image that expects `018_sample_capture.sql` stays ready because that row remains recorded. An image that expects `017_request_features.sql` stays ready because that row remains recorded. The image `fb62fa7` stays ready because `016_fallback_policy.sql` remains recorded. Its latest migration file is `016_fallback_policy.sql`.

An older image can start on this database when `schema_migrations` still contains the latest file that image knows. Later rows can stay. Do not delete migration rows. Do not delete provider, price, policy, or breaker rows to roll back a behavior. Turn the behavior off with the CLI.

To run an older image, build it from that commit, stop the current app, and start the old image on the same Docker network with the same database settings. Then remove that container and start the Compose app again. Leave the volume in place.

## Incidents

These changes affect one tenant, or one deployment, and do not call the provider for the thing you just disabled.

- Turn retry off with `set-execution-policy`, `--deployment`, and `--retries false`. The command also needs the three deadline flags and the two backoff flags. See [Retry](retry.md).
- Turn fallback off with `set-fallback-policy` and `--enabled false`. A named deployment still does not switch.
- Turn sample capture off with `set-sample-policy` and `--mode disabled` or `--mode metadata_only`. A new chat then stores no sample. A sample stored earlier is hidden on the next read. The ciphertext row stays until cleanup deletes it as revoked, or until it expires under a policy that still allows encrypted content. Replay and judge disclosure stay off unless you set them. Streaming capture stays off unless you set `--streaming-capture true`. A completed text stream then stores one encrypted sample. A stream that does not finish stores no replay-ready sample. Feature extraction and capture are optional. A failure in either one does not change the chat status and does not add a provider attempt.
- To rotate the wrapping key, set `PROVIDER_CREDENTIAL_KEY` to the new 32-byte key and set `PROVIDER_CREDENTIAL_KEY_PREVIOUS` to the old key. Restart the proxy. New samples and new provider credentials use the new key. The old key still opens samples and provider credentials that it sealed. The operator CLI uses those same keys when it opens a stored credential. A wrong key opens nothing. Check one old sample and one new sample before you drop the previous key.
- If cleanup stops after the delete is committed, the job stays `running` until its lock time. Set `locked_until` in the past for that idempotency key, then run `cleanup-expired-samples` again. The second run deletes nothing that was already audited. Two cleanup commands for the same tenant in the same minute share one job key. One of them claims the job. The expired rows are deleted once.
- A proxy process can stop after a sample is stored. Another process that uses the same database still serves chat and still sees that sample. `SIGKILL` does not roll the sample back.
- A hard check that cannot take the admission lock returns HTTP 503 `admission_unavailable` and does not call the provider. The database stays in place. A later chat uses it again. Do not drop the database to clear that error.
- Disable one deployment with `set-deployment-enabled`, `--name`, and `--enabled false`. The next request for that name returns `model_not_found`.
- Disable one breaker with `set-deployment-breaker`, `--deployment`, and `--enabled false`.
- Reset one breaker with `reset-deployment-breaker` and `--deployment`. The next chat can reach the upstream.
- Run `recover-budget` to close a finished attempt that still holds a reservation. A second run does not settle it again. An uncertain charge stays provisional.

A hard check that cannot reach the database returns HTTP 503 `admission_unavailable` and does not call the provider.

During a chat, the request stays `pending` until a terminal status is stored. A completed response stores `succeeded`. A rejected response stores `failed`. A stream stores one stream status. Shutdown stores `interrupted` when the row write succeeds. A priced success stores cost status `estimated`. Missing usage stays `unknown`, with a null amount. One request uses at most two upstream attempts, and that request does not both retry and fall back.

Read counts on `GET /internal/v1/metrics/summary`, attempt history on `GET /internal/v1/metrics/attempts`, the budget on `GET /internal/v1/budgets/usage`, the limits on `GET /internal/v1/limits`, breaker state on `GET /internal/v1/metrics/breakers`, request characteristics on `GET /internal/v1/request-features`, and sample metadata on `GET /internal/v1/samples`. See [Metrics](metrics.md). The sample routes return no prompt, no completion, and no ciphertext.

## Capture release

Use this order. Do not skip a step.

1. Turn metadata collection on with `--mode metadata_only` and `--content-capture false`. Confirm `GET /internal/v1/request-features` returns characteristics and no prompt or completion.
2. Leave content capture off. The default sample mode stores no content. Streaming capture defaults to false.
3. Turn `--mode encrypted_sample` and `--content-capture true` on for one test tenant. Leave every other tenant disabled or metadata-only.
4. Send synthetic requests only. Do not send approved business data yet.
5. Open one stored sample with the current key. Confirm a wrong key and a changed ciphertext open nothing. Run `cleanup-expired-samples` on an expired synthetic sample and confirm the row is gone and the deletion reason is `expired`.
6. Turn capture off with `--mode disabled` and confirm the sample route returns 404 at once. Readiness for `020_stream_samples.sql` stays 200. Historical ciphertext stays until the active policy or the expiry rule deletes it.
7. Only after those checks, capture approved business data for a tenant whose policy, classification, provider, and deployment list allow it.

`POST /internal/v1/samples/{sampleId}/eligibility-check` reports metadata only. It does not start a replay. This tree adds no automatic model evaluation.

## Docker deployment

Compose runs one `postgres:16` service and one `app` service. The image build context is this directory. The app listens on port 8080. Inference stays off until `INFERENCE_ENABLED` is true. `PROVIDER_CREDENTIAL_KEY` is required when inference is on. The cleanup worker starts inside the app process. It is not a second Compose service. `stop_grace_period` is 20 seconds. The ready check calls `http://127.0.0.1:8080/health/ready`.

Two or more app processes can share one database. Give each process the same `PROVIDER_CREDENTIAL_KEY` and the same previous keys. Each process keeps its own stream slots. Sample rows are shared through PostgreSQL.

To build a local image tag for this tree, use the Colima socket when that is the daemon that has the base image:

```bash
DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" docker build -t llm-proxy:slice-06e .
```

Leave a running Compose app and its volume in place. Do not remove `pgdata` to roll back capture.

## Tests

`npm test` needs Node.js 24 and a running Docker daemon. The tests start PostgreSQL with Testcontainers and local mocks for OpenAI, Anthropic, and a private endpoint. They do not call a provider on the internet. A Vertex, xAI, or OpenRouter live test runs only when `VERTEX_LIVE`, `XAI_LIVE`, or `OPENROUTER_LIVE` is `1`. `npm test` does not set those variables.

```bash
nvm use 24
npm test
```

## Clients in the proxy

- The OpenAI Node SDK is the OpenAI client, in the proxy and in the contract tests.
- The Vertex client is `@google/genai` version `2.30.0`.
- The Google credential client is `google-auth-library` version `10.9.1`. It uses Vertex mode plus the stored project and location.
- A non-stream Anthropic chat uses the Anthropic Node SDK. A stream does not.
- xAI uses `https://api.x.ai/v1`.
- OpenRouter uses `https://openrouter.ai/api/v1`.
- DGX uses the stored tenant endpoint.
- Every client sets `maxRetries` to `0`.

## Not done yet

- A live call to a DGX host.
- Input that is not text, and tool calls.
- A retry for every kind of error.
- Selection of a deployment by a quality score.
- OAuth, a login, saved caller state, and a user account.
- An HTTP route that revokes a key or changes a provider record.
- Production control of a database role password or a provider key.
- A payment for use.

There is no Kubernetes manifest, no continuous-integration pipeline, and no install on a public server in this repository.

## Related

- [Tenants](tenants.md)
- [Streaming](streaming.md)
- [Retry](retry.md)
- [Fallback](fallback.md)
- [Limits and budgets](limits.md)
