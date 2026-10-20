# llm-proxy

The service is a multi-tenant Node.js proxy for internal backends. Slice 00 checks tenant credentials, isolates tenant rows, and reports health. Slice 01 adds a non-streaming text chat completion through the tenant's configured OpenAI model. Slice 02 adds Anthropic on the same OpenAI chat API. The caller selects a deployment with `model`. The caller does not change SDK or request shape.

Every tenant request needs both headers:

```http
X-Tenant-ID: <tenant-uuid>
Authorization: Bearer <tenant-secret>
```

There is no login, session, OAuth, or user account. The caller does not supply a provider URL or a provider credential.

## Requirements

**To start the service**

- Colima.
- The Docker CLI, including Compose.
- curl, so the start script can wait for readiness.

`scripts/colima.sh` uses the default Colima profile and the socket `~/.colima/default/docker.sock`. Set `COLIMA_PROFILE` or `COLIMA_SOCKET` to use another profile or socket. The script exports `DOCKER_HOST` for its own commands and leaves the Docker context unchanged.

`stop` stops the Compose project and keeps the database volume. Colima stays up unless you pass `--vm`.

Later `docker compose` commands in this file need the same socket:

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
```

**To run checks**

- Node.js 24. The app image is `node:24-bookworm-slim`. If the host default is newer, run `nvm use 24` before `npm test`.
- `npm install`, so the deployed check can load the OpenAI client.
- A running Docker daemon for `npm test`. When `DOCKER_HOST` is unset, that suite uses the active Docker context.

## Run locally

```bash
scripts/colima.sh start
scripts/colima.sh start --build
scripts/colima.sh restart
scripts/colima.sh stop
scripts/colima.sh status
```

`npm run stack -- start` is the same script. `start` brings Colima up when it is down, then starts PostgreSQL 16 and the service on port 8080. `restart --build` rebuilds the image and recreates the containers.

- Liveness: `GET http://127.0.0.1:8080/health/live` returns `{"status":"live"}`.
- Readiness: `GET http://127.0.0.1:8080/health/ready` returns HTTP 200 `{"status":"ready","database":"ready"}` only after PostgreSQL is reachable and this image's migrations are applied. If PostgreSQL is down, readiness is HTTP 503 and liveness stays HTTP 200.

Inference is off unless `INFERENCE_ENABLED=true`. A tenant with no enabled deployment cannot call a model. One tenant can be configured before any other tenant. The Compose database role passwords are local development values.

## Check a deployed instance

`scripts/check-deployed.mjs` sends the request and response cases to a running proxy. It does not call the live OpenAI API.

```bash
node scripts/check-deployed.mjs --prepare-local
```

`npm run check:deployed -- --prepare-local` is the same command. `--prepare-local` needs Colima, Docker, and Node.js. It starts the local stack when Colima is down, points the app at a mock for that run, and covers the HTTP, database, and process cases. It then restores the previous app environment and removes the mock. It keeps the database volume. `--leave-prepared` skips the restore.

For a proxy that is already running, pass `--base-url` or set `PROXY_BASE_URL`. `--help` lists the tenant ids, secrets, and mock URL that instance must already have. `--http-only` runs the HTTP cases and exits. Database and process cases run with `--prepare-local`, or with `CHECK_ADMIN=local`. The same-connection pool check stays in `npm test`: a deployed process does not expose the backend pid of a returned pool connection. The script checks that a runtime session with no tenant setting sees no rows.

## Provision a tenant

The CLI prints a tenant secret once on standard output. Logs go to standard error. The database stores only a scrypt verifier.

```bash
docker compose run --rm app node dist/cli.js provision-tenant --name Acme
docker compose run --rm app node dist/cli.js add-key --tenant-id <tenant-id> --label backup
docker compose run --rm app node dist/cli.js revoke-key --tenant-id <tenant-id> --key-id <key-id>
```

A tenant can have more than one active key. Revoking one key leaves the other active keys working.

`GET /v1/tenant` returns that tenant's id, name, and key ids. It does not return secrets or verifiers. Missing, malformed, unknown, mismatched, and revoked credentials get HTTP 401 `{"error":"unauthorized"}`.

## Configure OpenAI for one tenant

Set these on the proxy process before a model call. Callers cannot change them.

| Variable | Required | Purpose |
| --- | --- | --- |
| `INFERENCE_ENABLED` | no | `true` or `false`. Unset means `false`. |
| `PROVIDER_CREDENTIAL_KEY` | when inference is on | 32-byte key, base64-encoded. It stays in the process environment. |
| `OPENAI_BASE_URL` | no | Upstream base URL. The default is `https://api.openai.com/v1`. Use this only so an operator can point the process at a mock. |

Generate a process key and recreate the app with inference on:

```bash
export INFERENCE_ENABLED=true
export PROVIDER_CREDENTIAL_KEY="$(openssl rand -base64 32)"
export OPENAI_BASE_URL="https://api.openai.com/v1"
docker compose up -d --force-recreate --build app
```

Register the tenant's OpenAI connection, one deployment, and the `auto` alias. The API key is encrypted before it is stored. `list-inference` does not print it.

```bash
docker compose run --rm app node dist/cli.js register-openai-connection \
  --tenant-id <tenant-id> --api-key "$OPENAI_API_KEY"
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --name primary \
  --upstream-model gpt-4o-mini \
  --timeout-ms 30000 \
  --capabilities temperature \
  --enabled true
docker compose run --rm app node dist/cli.js set-alias \
  --tenant-id <tenant-id> --alias auto --deployment primary
docker compose run --rm app node dist/cli.js list-inference --tenant-id <tenant-id>
```

Other operator commands:

```bash
docker compose run --rm app node dist/cli.js set-openai-credential --tenant-id <tenant-id> --api-key "$OPENAI_API_KEY"
docker compose run --rm app node dist/cli.js set-connection-enabled --tenant-id <tenant-id> --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled --tenant-id <tenant-id> --name primary --enabled false
```

A deployment is selectable only when that deployment and its connection are enabled. The only alias in this slice is `auto`. A deployment cannot be named `auto`.

An optional live check, not part of the default tests, is a `POST /v1/chat/completions` with `model` set to `auto` after the commands above and a real `OPENAI_API_KEY`. The default suite uses a mock server instead.

## Configure Anthropic for one tenant

Anthropic uses the same tenant registry. There is no second configuration table and no new process variable. `OPENAI_BASE_URL` is not the Anthropic endpoint. The operator stores the approved endpoint on that tenant's Anthropic connection. The API key is encrypted with `PROVIDER_CREDENTIAL_KEY` before it is stored.

Registering the connection enables that connection. A new deployment stays disabled until you pass `--enabled true` or run `set-deployment-enabled`. Anthropic is not called until both the connection and the deployment are enabled. One tenant has one connection for each provider.

```bash
docker compose run --rm app node dist/cli.js register-anthropic-connection \
  --tenant-id <tenant-id> \
  --api-key "$ANTHROPIC_API_KEY" \
  --endpoint https://api.anthropic.com
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --provider anthropic \
  --name claude \
  --upstream-model claude-sonnet-4-5 \
  --timeout-ms 30000 \
  --capabilities temperature,stop,max_completion_tokens \
  --default-max-output-tokens 1024 \
  --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled \
  --tenant-id <tenant-id> --name claude --enabled true
```

`--workspace-id` is optional on `register-anthropic-connection`. An Anthropic deployment requires `--default-max-output-tokens`. An OpenAI deployment rejects that flag.

```bash
docker compose run --rm app node dist/cli.js set-anthropic-credential \
  --tenant-id <tenant-id> --api-key "$ANTHROPIC_API_KEY"
docker compose run --rm app node dist/cli.js set-connection-enabled \
  --tenant-id <tenant-id> --provider anthropic --enabled false
```

`set-connection-enabled` without `--provider` still changes the OpenAI connection.

The same caller code reaches either provider by changing only `model`. `auto` stays on the deployment selected by `set-alias`. An explicit deployment name is not replaced.

An optional staging check is `scripts/anthropic-smoke.mjs`. It does nothing unless `ANTHROPIC_SMOKE=1`, and `npm test` does not run it. With the flag, it sends one chat completion to an already configured proxy. It does not read a provider key.

```bash
ANTHROPIC_SMOKE=1 PROXY_BASE_URL=http://127.0.0.1:8080 \
  TENANT_ID=<tenant-id> TENANT_SECRET=<tenant-secret> MODEL=claude \
  node scripts/anthropic-smoke.mjs
```

## Chat API

`POST /v1/chat/completions` accepts JSON with `model` and text `messages`. `model` is `auto` or an enabled deployment name. `stream` may be omitted or `false`. Optional fields are accepted only when that deployment lists the matching capability: `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `seed`, `n` (only `1`), `user`, and `response_format` of `{"type":"text"}`.

An Anthropic deployment accepts `temperature` from 0 through 1, `stop`, `max_tokens`, and `max_completion_tokens`. When both limits are present they must be equal. When neither is present, the deployment's default max output tokens is sent as `max_tokens`. One leading system message becomes the Anthropic system string. A later system message, a developer message, assistant prefill, tools, images, and any other optional field are rejected before the upstream call. OpenAI deployments keep the fields they already accepted. The proxy does not drop an unsupported field and continue.

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "X-Tenant-ID: <tenant-id>" \
  -H "Authorization: Bearer <tenant-secret>" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

A success body is an OpenAI chat completion. `object` is `chat.completion`. `model` is the upstream model id. Assistant text is in `choices`. `usage` is present only when the upstream reported integer token counts. Missing usage is omitted, not filled in.

The proxy calls the selected provider once, with `maxRetries` set to 0 and the deployment timeout. OpenAI uses `OPENAI_BASE_URL`. Anthropic uses the connection endpoint and the official Messages API. It commits a request row and an attempt row before that call. The two ids are different. The rows store the deployment id, configuration version, connection id, connection version, status, duration, reported token counts, the provider response id, the native stop or error reason, and cache-token categories when Anthropic reports them. They do not store the prompt or the completion text. Public `usage.prompt_tokens` is the uncached input count plus reported cache creation and cache read counts. A missing count stays null.

Errors use an OpenAI error object:

```json
{"error":{"message":"...","type":"invalid_request_error","param":"stream","code":"unsupported_parameter"}}
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `unsupported_parameter` or `unknown_parameter` | `stream=true`, tools, images, audio, an unsupported response format, or any other field the deployment does not allow. The field is not forwarded. |
| 401 | `invalid_api_key` | The tenant credential was rejected. |
| 401 | `upstream_auth_error` | Anthropic rejected the stored provider credential. The message is fixed and is not `invalid_api_key`. |
| 404 | `model_not_found` | The alias or deployment is unknown or disabled. |
| 408 | `request_cancelled` | The caller closed the request. |
| 429 | `rate_limit` | The upstream reported HTTP 429. |
| 502 | `upstream_error` or `invalid_upstream_response` | The upstream failed, or its body could not be represented as a chat completion. Anthropic tool-use and unknown content blocks use `invalid_upstream_response`. |
| 503 | `inference_disabled` or `service_unavailable` | Inference is off, or the request row could not be committed. No upstream call is made in those cases. |
| 504 | `timeout` | The deployment timeout elapsed. |
| 529 | `overloaded` | Anthropic reported HTTP 529. |

If the model call succeeds and the later status update fails, the proxy returns the completion, does not call the model again, and logs a critical event with the request id and the attempt id. The row can remain `pending`.

`GET /v1/models` returns `{"object":"list","data":[...]}` for that tenant's enabled deployment names and the `auto` alias.

`GET /internal/v1/metrics/summary?from=<timestamp>&to=<timestamp>` needs the same tenant headers. `from` and `to` are absolute timestamps, `to` is exclusive, and the window is at most 32 days. The body has request counts, reported token sums, and latency sample count, sum, and max. Sums are null when no usage was reported. The body has no price and no quality score.

Health routes keep the Slice 00 JSON shapes. `GET /v1/tenant` keeps `{"error":"unauthorized"}` for a bad credential.

## Configuration

The process exits before it listens when any required setting is missing or invalid.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_HOST` | yes | PostgreSQL host |
| `DATABASE_PORT` | yes | PostgreSQL port |
| `DATABASE_NAME` | yes | Database name |
| `MIGRATOR_USER` | yes | Must be `llm_migrator` |
| `MIGRATOR_PASSWORD` | yes | Migration role password |
| `AUTH_USER` | yes | Must be `llm_auth` |
| `AUTH_PASSWORD` | yes | Authentication role password |
| `RUNTIME_USER` | yes | Must be `llm_runtime` |
| `RUNTIME_PASSWORD` | yes | Runtime role password |
| `HOST` | no | Listen address, default `0.0.0.0` |
| `PORT` | no | Listen port, default `8080` |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error` |
| `INFERENCE_ENABLED` | no | Default `false` |
| `PROVIDER_CREDENTIAL_KEY` | when inference is on | Base64 32-byte key |
| `OPENAI_BASE_URL` | no | Default official OpenAI API |

`SIGTERM` stops new work, closes the database pools, and exits.

## Deployment and rollback

Migrations are forward-only. `003_inference.sql` adds inference tables and does not change Slice 00 tables. A second boot applies nothing.

To run the previous image after `003_inference.sql` is applied, build it from the Slice 00 commit if the local tag is absent, stop the current app, and start that image on the same database network:

```bash
git archive --format=tar 8794d06 | docker build -t llm-proxy:slice-00 -
docker compose stop app
docker run -d --name llm-proxy-slice00-run --network llm-proxy_default \
  -p 8080:8080 \
  -e HOST=0.0.0.0 -e PORT=8080 \
  -e DATABASE_HOST=postgres -e DATABASE_PORT=5432 -e DATABASE_NAME=llm_proxy \
  -e MIGRATOR_USER=llm_migrator -e MIGRATOR_PASSWORD=migrator_local_dev \
  -e AUTH_USER=llm_auth -e AUTH_PASSWORD=auth_local_dev \
  -e RUNTIME_USER=llm_runtime -e RUNTIME_PASSWORD=runtime_local_dev \
  -e LOG_LEVEL=info \
  llm-proxy:slice-00
```

The previous image becomes ready because `002_security.sql` is still applied. `GET /v1/tenant` still works. It has no chat route. Return to the current image with:

```bash
docker rm -f llm-proxy-slice00-run
docker compose start app
```

`scripts/verify-slice-01.mjs` provisions tenants, uses a mock provider, checks the rows, and checks this rollback. Give it an empty scratch directory.

`004_anthropic.sql` adds nullable columns and Anthropic functions. It does not update existing OpenAI rows. After it is applied, the Slice 01 image still becomes ready because its latest migration file, `003_inference.sql`, remains applied. Build that image from `0b18e92` when the tag is absent, stop the current app, and start it on the same database network:

```bash
git archive --format=tar 0b18e92 | docker build -t llm-proxy:slice-01 -
docker compose stop app
docker run -d --name llm-proxy-slice01-run --network llm-proxy_default \
  -p 8080:8080 \
  -e HOST=0.0.0.0 -e PORT=8080 \
  -e DATABASE_HOST=postgres -e DATABASE_PORT=5432 -e DATABASE_NAME=llm_proxy \
  -e MIGRATOR_USER=llm_migrator -e MIGRATOR_PASSWORD=migrator_local_dev \
  -e AUTH_USER=llm_auth -e AUTH_PASSWORD=auth_local_dev \
  -e RUNTIME_USER=llm_runtime -e RUNTIME_PASSWORD=runtime_local_dev \
  -e LOG_LEVEL=info \
  -e INFERENCE_ENABLED=true \
  -e OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}" \
  -e PROVIDER_CREDENTIAL_KEY="$PROVIDER_CREDENTIAL_KEY" \
  llm-proxy:slice-01
```

That image serves the existing OpenAI deployment. It does not call Anthropic. Return to the current image with:

```bash
docker rm -f llm-proxy-slice01-run
docker compose start app
```

Do not remove the database volume. Compose init scripts run only on an empty volume.

## Tests

`npm test` needs Node.js 24 and a running Docker daemon. See [Requirements](#requirements). The suite starts real PostgreSQL with Testcontainers, a local mock OpenAI server, and a local mock Anthropic Messages API. It does not call a live provider.

```bash
nvm use 24
npm test
```

The deployed request and response check is [Check a deployed instance](#check-a-deployed-instance).

## Assumptions

- This directory is the git repository.
- Verifiers are Node.js `crypto.scrypt` with `N=16384`, `r=8`, and `p=1`. A native hashing package is not used, so the Node.js 24 image does not need a compiler.
- Tenant secrets are 32 random bytes, prefixed with `yck_`, and shown once. The database check constraint rejects a raw secret as a verifier.
- Provider credentials are AES-256-GCM ciphertext (`aes-256-gcm$...`). The encryption key is `PROVIDER_CREDENTIAL_KEY` and is not stored in PostgreSQL. The runtime role cannot select the ciphertext column. A security-definer function returns it only when the transaction tenant matches and the connection is enabled.
- `llm_owner` is a `NOLOGIN` role with `BYPASSRLS` and `CREATE` on schema `public`. It owns the tables and the security-definer functions. Application connections use only `llm_migrator`, `llm_auth`, and `llm_runtime`. Those three roles are not superusers and cannot bypass row level security.
- `llm_migrator` is a member of `llm_owner` so it can assign ownership during migrations, and it is `NOINHERIT`. A holder of the migration password can `SET ROLE llm_owner`. The request path never uses that role. `003_inference.sql` creates its foreign keys as `llm_owner` because that role owns `tenants`.
- The authentication role may execute only `list_active_key_verifiers`. The runtime role may read tenant rows under row level security and may not read the verifier column or the provider ciphertext.
- Tenant context is `set_config('app.tenant_id', ..., true)` inside a transaction. The setting ends when the transaction ends, before the connection returns to the pool. The upstream call runs after that transaction commits.
- Row level security is forced. With no tenant setting, policies match no rows.
- Migrations are forward-only SQL files in `migrations/`, applied in lexical order and recorded in `schema_migrations`. A second run skips applied files and does not delete rows. Do not edit a file after it has been applied.
- Role creation is separate from migrations. Compose runs `docker/postgres/init.sh` as the database superuser. Tests apply the same attributes through `bootstrapRoles`.
- The service migrates on startup, then listens. A later database outage does not exit the process. Readiness fails and liveness stays up.
- Logs are one JSON object per line. Redaction strips bearer tokens, `yck_` secrets, scrypt verifiers, `sk-` provider keys, AES-GCM ciphertext, and fields whose names look like secrets, prompts, or messages.
- Local Compose passwords are development-only.
- PostgreSQL 16 is the local database image. The major version is not a product requirement beyond row level security support.
- The OpenAI Node SDK is the OpenAI upstream client and the contract-test client. The Anthropic Node SDK is the Anthropic upstream client. Both set `maxRetries` to 0. Each adapter sets its base URL explicitly. Anthropic stores that URL on the tenant connection. OpenAI uses `OPENAI_BASE_URL`.
- The ASD-STE100 dictionary is not in this environment. The commit subject follows the public style rules for this slice: one active imperative sentence, at most 20 words, American spelling, no semicolon, and no noun cluster longer than three words.

## Limitations

- The providers are OpenAI and Anthropic. The only method is non-streaming text chat. There is no tool calling, image input, audio, fallback, retry, or quality-based routing.
- Anthropic accepts one leading system message, text user and assistant turns that alternate and end on a user turn, temperature from 0 through 1, stop sequences, and an output token limit. The Messages API has no `created` time. The proxy fills `created` from its own clock. Thinking blocks are omitted. A response that is only thinking has empty assistant text. Tool-use and any other content block or stop reason reject the response.
- Anthropic cache categories are stored on the attempt when the provider reports them. They are not invented. Public usage still has the three OpenAI token fields.
- Each accepted request makes one attempt. The schema allows a later attempt row for the same request.
- There is no rate limit, billing, price, quality score, Kubernetes manifest, CI pipeline, or hosted deployment.
- Provisioning is a command line tool for the migration role. There is no HTTP admin API.
- Database role passwords and `PROVIDER_CREDENTIAL_KEY` come from the environment. There is no external secret manager and no TLS termination in this slice.
- `OPENAI_BASE_URL` is process configuration so a test can use a mock. A caller field that selects a URL is rejected.
- Authentication spends scrypt time on each presented secret. Unknown tenants pay one dummy scrypt so an empty key list is harder to time. This is not a formal constant-time proof across every failure branch.
- The authentication function returns verifiers to the authentication role so the application can compare them. Verifiers are not reversible and are not logged.
- A person who holds the migration password can assume `llm_owner` and bypass row level security. Protect that password as an administrative credential.
- Compose init scripts run only when the database volume is empty.
- If status persistence fails after a successful model call, the caller still receives the completion and the stored row can stay `pending`.
- The default tests do not call a live provider. `scripts/anthropic-smoke.mjs` is an optional operator check and is off unless `ANTHROPIC_SMOKE=1`.

## Unfinished items

- Streaming, multimodal input, tools, fallback, retries, and intelligent routing.
- OAuth, login, sessions, and user accounts.
- Key revocation and provider administration through HTTP.
- Production management of database role passwords and the provider key.
- Billing, rate limits, and cost metering.

## License

Released under the MIT license. See [LICENSE](LICENSE).
