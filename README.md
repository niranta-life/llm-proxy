# llm-proxy

The llm-proxy is a multi-tenant proxy.
Your programs send requests to the proxy.
The proxy uses Node.js.
The proxy checks the tenant secret.
The proxy keeps the rows for each tenant separate.
The proxy can send a text chat completion to OpenAI.
The proxy can send the same chat completion to Anthropic.
You select the deployment with `model`.
You use the same request for OpenAI and for Anthropic.
You do not change the SDK.

Each tenant request must have these 2 headers:

```http
X-Tenant-ID: <tenant-uuid>
Authorization: Bearer <tenant-secret>
```

The proxy has no login.
The proxy does not keep caller state between requests.
The proxy does not use OAuth.
The proxy has no user account.
The caller does not send a provider URL.
The caller does not send a provider API key.

## Terms

Use these words for these things:

- A tenant secret is the secret in the `Authorization` header.
- A tenant key is 1 key record for 1 tenant.
- A key id identifies that tenant key.
- A verifier is the scrypt value for a tenant secret.
- A provider API key is the key for OpenAI or for Anthropic.
- A connection is the provider access record for 1 tenant.
- A deployment is a named model configuration for 1 tenant.
- The upstream model is the model name at the provider.
- The alias is the name `auto`.
- The alias selects 1 deployment.
- Inference is a chat request that the proxy sends to a provider.
- HTTP, JSON, API, URL, CLI, SQL, and TLS are technical names.

## Capabilities

The proxy checks the tenant secret on each tenant request.
The proxy records only a verifier for that secret.
PostgreSQL row-level security permits a tenant to read only its own rows.
The proxy reports liveness.
The proxy reports readiness.
You can add a tenant with the CLI.
You can add a tenant key.
You can revoke a tenant key.

The proxy accepts 1 text chat completion for 1 tenant.
The proxy returns that completion in 1 response.
The proxy sends the request 1 time to the OpenAI model for that tenant.
The proxy records the attempt, the duration, and the token counts from the provider.
The proxy returns an OpenAI chat completion.
The proxy returns the model list for that tenant.
The proxy returns metric totals for a time window.

The proxy can send the same request to Anthropic.
The proxy changes that request into a request for the Anthropic Messages API.
The proxy returns an OpenAI chat completion for the Anthropic result.
The proxy records the token counts from Anthropic.
The proxy records the errors from Anthropic.
An OpenAI deployment continues to operate after you add Anthropic.

The proxy can stream a text chat for an OpenAI deployment.
The proxy can stream a text chat for an Anthropic deployment.
The same caller can use both.
The caller changes only the model.
Streaming stays off until that tenant and that deployment both have streaming enabled.
One accepted stream makes one upstream attempt.

The metric totals for a time window include the stream request count.
Those totals include the completed, cancelled, failed, and truncated stream counts.
Those totals include the stream token counts.
Those totals include P50 and P95 for the time to the first text.
Those totals include P50 and P95 for the stream duration.
A window with no samples does not invent a latency or a token count.
A tenant reads only its own rows.

The proxy limits the open streams in one process.
The proxy limits the open streams for one tenant in that same process.
A second process has its own counts.
A slow caller ends that stream and releases the slot.

After `SIGTERM` or `SIGINT`, the proxy accepts no new stream.
The proxy waits for the configured drain time.
A stream that finishes in that time can complete.
The proxy then aborts each stream that is still open.
The proxy records `interrupted` when that row write succeeds.

An Anthropic stream accepts the configured model.
An Anthropic stream also accepts that model with an 8-digit snapshot suffix.
The caller still receives the configured model.
A different model fails the stream.
The proxy does not use the Anthropic fields `inference_geo` and `speed`.

You can start the local Compose project with Colima.
You can stop that project with Colima.
You can check a proxy that is in operation.
`scripts/check-deployed.mjs` does not send a request to OpenAI.

Git does not track the file `.env.live`.
A Docker build does not copy the file `.env.live`.
This project uses the MIT license.

## What you must have

You must have these programs before you start the proxy:

- Colima.
- The Docker CLI.
- Docker Compose, as part of that CLI.
- curl.

The start script uses curl.
The script waits until the readiness route returns HTTP 200.

`scripts/colima.sh` uses the Colima profile `default`.
The socket is `~/.colima/default/docker.sock`.
Set `COLIMA_PROFILE` when you use a different profile.
Set `COLIMA_SOCKET` when you use a different socket.
The script sets `DOCKER_HOST` for its own commands.
The script does not change the Docker context.

`stop` stops the Compose project.
`stop` keeps the database volume.
Colima continues to operate.
Colima stops only when you add `--vm`.

Set this socket before each `docker compose` command in this file:

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
```

You must have Node.js 24 before you test the proxy.
Run `npm install` before `scripts/check-deployed.mjs`.
`scripts/check-deployed.mjs` loads the OpenAI client.
The proxy image is `node:24-bookworm-slim`.
When your computer does not use Node.js 24, run `nvm use 24` before `npm test`.
`npm test` must have a Docker daemon in operation.
When `DOCKER_HOST` is absent, the tests use the selected Docker context.

## Start the local proxy

```bash
scripts/colima.sh start
scripts/colima.sh start --build
scripts/colima.sh restart
scripts/colima.sh stop
scripts/colima.sh status
```

`npm run stack -- start` runs the same script.
`start` starts Colima when Colima is not in operation.
`start` starts PostgreSQL 16.
`start` starts the proxy on port 8080.
`restart --build` builds the image again.
`restart --build` creates the containers again.

`GET http://127.0.0.1:8080/health/live` returns `{"status":"live"}`.

`GET http://127.0.0.1:8080/health/ready` returns HTTP 200 when the proxy is ready.
The body is `{"status":"ready","database":"ready"}`.
The proxy is ready only when the proxy can connect to PostgreSQL.
The proxy is ready only when `schema_migrations` contains the latest migration file for this image.
When the proxy is not ready, the proxy returns HTTP 503.
The body is `{"status":"not_ready","database":"unavailable"}`.
The liveness route continues to return HTTP 200.

Inference is off when `INFERENCE_ENABLED` is not `true`.
A tenant with no enabled deployment cannot send a chat completion.
You can set 1 tenant before you set the other tenants.
The database role passwords in Compose are for local development.

## Check a started proxy

`scripts/check-deployed.mjs` sends request cases and response cases to a proxy that is in operation.
The script does not send a request to OpenAI.

```bash
node scripts/check-deployed.mjs --prepare-local
```

`npm run check:deployed -- --prepare-local` runs the same command.
`--prepare-local` must have Colima, Docker, and Node.js.
When Colima is not in operation, the script starts the local Compose project.
The script uses a mock server for that run.
The script checks the HTTP cases.
The script checks the database cases.
The script checks the process cases.
The script restores the environment variables of the proxy.
The script removes the mock server.
The script keeps the database volume.
`--leave-prepared` does not restore the environment variables of the proxy.

For a proxy that is in operation, pass `--base-url` or set `PROXY_BASE_URL`.
`--help` shows the tenant ids, the secrets, and the mock URL.
That proxy must have those values.
`--http-only` runs the HTTP cases.
The script is complete after those cases.
Database cases and process cases run with `--prepare-local`.
Those cases also run when `CHECK_ADMIN` is `local`.

Only `npm test` can read the backend process id of a database session in the pool.
A proxy that is in operation does not give that process id.
The script opens 1 database session.
That database session does not set `app.tenant_id`.
That database session reads no rows.

## Add a tenant

The CLI shows a new tenant secret 1 time.
The secret is on standard output.
The CLI writes logs to standard error.
The database records only a verifier.

```bash
docker compose run --rm app node dist/cli.js provision-tenant --name Acme
docker compose run --rm app node dist/cli.js add-key --tenant-id <tenant-id> --label backup
docker compose run --rm app node dist/cli.js revoke-key --tenant-id <tenant-id> --key-id <key-id>
```

A tenant can have more than 1 tenant key that is not revoked.
When you revoke 1 tenant key, each other tenant key that is not revoked continues to operate.

`GET /v1/tenant` returns the tenant id, the name, and the key ids for that tenant.
The route does not return a tenant secret.
The route does not return a verifier.
The proxy returns HTTP 401 when the tenant secret is not valid.
The body is `{"error":"unauthorized"}`.
The proxy uses this result in these conditions:

- The tenant secret is absent.
- The tenant secret has the wrong form.
- The tenant secret is unknown.
- The tenant secret is for a different tenant.
- The tenant key is revoked.

## Set OpenAI for 1 tenant

Set these variables on the proxy before a chat completion.
A caller cannot change these variables.

| Variable | Necessary | Use |
| --- | --- | --- |
| `INFERENCE_ENABLED` | no | `true` or `false`. When the variable is absent, the proxy uses `false`. |
| `PROVIDER_CREDENTIAL_KEY` | When `INFERENCE_ENABLED` is `true` | A 32-byte key in base64. The process keeps this key in its environment. |
| `OPENAI_BASE_URL` | no | The OpenAI base URL. When the variable is absent, the proxy uses `https://api.openai.com/v1`. Set this variable for a mock server. |

Make the key for `PROVIDER_CREDENTIAL_KEY`.
Set `INFERENCE_ENABLED` to `true`.
Build the proxy container again:

```bash
export INFERENCE_ENABLED=true
export PROVIDER_CREDENTIAL_KEY="$(openssl rand -base64 32)"
export OPENAI_BASE_URL="https://api.openai.com/v1"
docker compose up -d --force-recreate --build app
```

Record the OpenAI connection for the tenant.
Record 1 deployment.
Set the alias `auto`.
The proxy encrypts the provider API key.
The proxy records the ciphertext.
`list-inference` does not show the provider API key.

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

You can also use these commands:

```bash
docker compose run --rm app node dist/cli.js set-openai-credential --tenant-id <tenant-id> --api-key "$OPENAI_API_KEY"
docker compose run --rm app node dist/cli.js set-connection-enabled --tenant-id <tenant-id> --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled --tenant-id <tenant-id> --name primary --enabled false
```

Streaming stays off until you enable it for that tenant.
Streaming stays off until you enable it for that deployment.
The deployment can be OpenAI or Anthropic.
When you omit a timeout flag, the proxy uses the deployment timeout.
That timeout applies to the connection.
That timeout applies when the provider sends no text.
That timeout applies to the full stream.
That timeout applies when the caller does not read.
A timeout that you set is an integer from 100 through 600000.
The unit is milliseconds.

```bash
docker compose run --rm app node dist/cli.js set-tenant-streaming --tenant-id <tenant-id> --enabled true
docker compose run --rm app node dist/cli.js set-deployment-streaming \
  --tenant-id <tenant-id> \
  --deployment primary \
  --enabled true
```

You can select a deployment only when that deployment is enabled.
You can select a deployment only when its connection is enabled.
The only alias is `auto`.
Do not give a deployment the name `auto`.

You can send 1 chat completion to OpenAI after you set the tenant.
Set `model` to `auto`.
Use an `OPENAI_API_KEY` from OpenAI.
The tests that `npm test` runs use a mock server.
Those tests do not send a request to OpenAI.

## Set Anthropic for 1 tenant

Anthropic uses the same tenant tables.
The proxy does not use a second configuration table.
The proxy does not add an environment variable for Anthropic.
`OPENAI_BASE_URL` is not the Anthropic endpoint.
Record the endpoint on the Anthropic connection for that tenant.
The proxy encrypts the provider API key with `PROVIDER_CREDENTIAL_KEY`.
The proxy records the ciphertext.

`register-anthropic-connection` sets the connection to enabled.
A new deployment is not enabled.
The deployment is not enabled until you pass `--enabled true`.
You can use `set-deployment-enabled`.
The proxy does not send a request to Anthropic until the connection is enabled.
The proxy does not send a request to Anthropic until the deployment is enabled.
Each tenant has 1 connection for each provider.

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

`--workspace-id` is not necessary on `register-anthropic-connection`.
An Anthropic deployment must have `--default-max-output-tokens`.
Do not use `--default-max-output-tokens` for an OpenAI deployment.
The command does not record the deployment.

```bash
docker compose run --rm app node dist/cli.js set-anthropic-credential \
  --tenant-id <tenant-id> --api-key "$ANTHROPIC_API_KEY"
docker compose run --rm app node dist/cli.js set-connection-enabled \
  --tenant-id <tenant-id> --provider anthropic --enabled false
```

`set-connection-enabled` changes the OpenAI connection when you omit `--provider`.

The same caller code can reach OpenAI or Anthropic.
Change only `model`.
`auto` selects the deployment from `set-alias`.
The proxy keeps the deployment name that you write in `model`.
The proxy does not replace that name.

Use `scripts/anthropic-smoke.mjs` on a proxy that you have set.
The script sends no request when `ANTHROPIC_SMOKE` is not `1`.
`npm test` does not run the script.
When `ANTHROPIC_SMOKE` is `1`, the script sends 1 chat completion.
Set the proxy before you run the script.
The script does not read a provider API key.

```bash
ANTHROPIC_SMOKE=1 PROXY_BASE_URL=http://127.0.0.1:8080 \
  TENANT_ID=<tenant-id> TENANT_SECRET=<tenant-secret> MODEL=claude \
  node scripts/anthropic-smoke.mjs
```

## Chat API

`POST /v1/chat/completions` accepts JSON.
The JSON must contain `model`.
The JSON must contain text `messages`.
`model` is `auto` or the name of an enabled deployment.
You can omit `stream`.
You can set `stream` to `false`.
The proxy accepts `stream` set to `true` for OpenAI.
The proxy accepts `stream` set to `true` for Anthropic.
The tenant must have streaming enabled.
The deployment must have streaming enabled.
When `stream` is `true`, you can set `stream_options` to `{"include_usage":true}`.
You can set `stream_options` to `{"include_usage":false}`.
The proxy does not accept another field in `stream_options`.

The proxy accepts a field other than `model` and `messages` only when that deployment lists the capability for that field.
The fields are:

- `temperature`
- `top_p`
- `max_tokens`
- `max_completion_tokens`
- `stop`
- `presence_penalty`
- `frequency_penalty`
- `seed`
- `n`, only with the value `1`
- `user`
- `response_format`, only with the value `{"type":"text"}`

An Anthropic deployment accepts these fields:

- `temperature` from 0 through 1
- `stop`
- `max_tokens`
- `max_completion_tokens`

When you send `max_tokens` and `max_completion_tokens`, the 2 values must be equal.
When you send no maximum, the proxy sends `--default-max-output-tokens` as `max_tokens`.

The proxy accepts 1 system message for Anthropic.
That message must be the first message.
The proxy uses that text as the Anthropic system text.
The proxy does not send the provider request for these values:

- A system message that is not first.
- A developer message.
- Assistant text as the last message.
- A tool.
- An image.
- A field that the deployment does not list.

An OpenAI deployment keeps each field that its capability list contains.
The proxy does not remove a field that it does not accept.
The proxy does not send the provider request for that field.

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "X-Tenant-ID: <tenant-id>" \
  -H "Authorization: Bearer <tenant-secret>" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

A success body is an OpenAI chat completion.
`object` is `chat.completion`.
`model` is the upstream model.
The assistant text is in `choices`.
The body contains `usage` only when the provider sent integer token counts.
When the provider does not send usage, the body has no `usage`.
The proxy does not invent a token count.

An enabled stream uses `text/event-stream`.
The deployment can be OpenAI or Anthropic.
The caller changes only the configured model.
Each event is a `chat.completion.chunk`.
The completion id does not change in that response.
The upstream model does not change in that response.
The first chunk has the assistant role.
The next chunks have the text in order.
A later chunk has the finish reason.
The proxy sends a usage chunk only when 2 conditions are true.
`stream_options.include_usage` must be `true`.
The provider must send at least 1 integer count.
A complete stream ends with 1 `data: [DONE]`.
The proxy sends that marker only after the provider finish event.
The proxy sends that marker only after the provider terminal event.
For OpenAI, that event is `[DONE]`.
For Anthropic, that event is `message_stop`.
The proxy does not record the generated text.
The proxy does not record the raw event stream.

An Anthropic stream sends each `text_delta` in content-block order.
An empty text block adds no text.
A `ping` event adds no text.
The proxy does not send `thinking_delta`.
The proxy does not send `signature_delta`.
A later usage count replaces the earlier count.
The proxy does not add that count to the earlier count.
The proxy stores a cache category when Anthropic reports that category.
`usage.prompt_tokens` is the sum of the reported input categories.
The attempt row stores the native stop reason.
The proxy rejects a serving model that is not the deployment model.
The proxy rejects a content block with type `fallback`.
The proxy rejects a `tool_use` block.
An Anthropic stream uses 1 HTTP request to the Messages API.
That request does not use the SDK stream helper.
A chat completion that is not a stream still uses the Anthropic SDK.

The Anthropic Messages API does not send `created`.
The proxy sets `created` from the proxy clock.
The proxy does not put a `thinking` block in the assistant text.
A response with only `thinking` blocks has empty assistant text.
The proxy maps each Anthropic stop reason to these values:

- `end_turn` and `stop_sequence` become `stop`.
- `max_tokens` and `model_context_window_exceeded` become `length`.
- `refusal` becomes `content_filter`.

The proxy sends 1 request to the selected provider.
`maxRetries` is `0`.
A stream uses 1 provider request.
The proxy does not send that stream request again.
The proxy uses the timeout on the deployment.
OpenAI uses `OPENAI_BASE_URL`.
Anthropic uses the endpoint on the connection.
Anthropic uses the Messages API.

The proxy records a request row before that provider request.
The proxy records an attempt row before that provider request.
The 2 ids are different.
The rows record these values:

- The deployment id.
- The configuration version.
- The connection id.
- The connection version.
- The status.
- The duration.
- The token counts from the provider.
- The provider response id.
- The native stop reason, or the native error reason.
- The cache counts, when Anthropic sends them.
- `stream_status`, for a stream.
- The time until the first text, for a stream.
- The chunk count, for a stream.
- The number of bytes written, for a stream.

`stream_status` is one of these values:

- `connecting`
- `streaming`
- `completed`
- `client_aborted`
- `provider_failed`
- `timed_out`
- `stream_truncated`
- `slow_consumer`
- `interrupted`

`completed` is the only stream status with attempt status `succeeded`.
`interrupted` is the status after a shutdown abort.
The rows do not record the prompt.
The rows do not record the completion text.

`usage.prompt_tokens` is the input count that was not in the cache.
When Anthropic sends a cache count, the proxy adds that count to `usage.prompt_tokens`.
The attempt row records null for a count that the provider does not send.
The public `usage` object has the 3 OpenAI token fields.
The proxy does not invent a cache count.

`MAX_ACTIVE_STREAMS` limits the streams in this process.
When the variable is absent, the limit is 32.
`MAX_STREAMS_PER_TENANT` limits the streams for one tenant in this process.
When the variable is absent, the limit is 32.
The two limits are in the memory of this process.
A count in one process does not change the count in another process.
One more stream receives HTTP 503.
The code is `stream_capacity`.
The proxy sends that response before an event.
The proxy does not send the provider request.
The proxy does not stop a stream that is already open.
Another tenant that is under its own limit can stream.
A slow caller ends with `slow_consumer`.
That end releases the stream slot.
A later stream can start.

An error body is an OpenAI error object:

```json
{"error":{"message":"...","type":"invalid_request_error","param":"stream","code":"unsupported_parameter"}}
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `unsupported_parameter` or `unknown_parameter` | The deployment does not accept the field, or streaming is not enabled. |
| 401 | `invalid_api_key` | The tenant secret is not valid. |
| 401 | `upstream_auth_error` | Anthropic did not accept the provider API key. |
| 404 | `model_not_found` | The name is unknown, or the deployment is not enabled. |
| 408 | `request_cancelled` | The caller closed the request. |
| 429 | `rate_limit` | The provider returned HTTP 429. |
| 502 | `upstream_error` or `invalid_upstream_response` | The provider sent an error, or the body is not a chat completion. |
| 503 | `inference_disabled`, `service_unavailable`, `stream_capacity`, `slow_consumer`, or `shutting_down` | Inference is off, the proxy cannot prepare the provider request, a stream limit is full, the caller does not read, or the process is shutting down. |
| 504 | `timeout` | The deployment timeout is complete, or a stream timeout is complete before the response headers. |
| 529 | `overloaded` | Anthropic returned HTTP 529. |

For HTTP 400, the proxy does not send the field to the provider.
The field can be one of these values:

- `stream` set to `true` when that tenant or that deployment has streaming off.
- A tool.
- An image.
- Audio.
- A response format that is not text.
- A field that the deployment does not accept.

For `upstream_auth_error`, the error text does not change.
That code is not `invalid_api_key`.
A tool-use block from Anthropic uses `invalid_upstream_response`.
A content block that the proxy cannot represent uses the same code.
An unknown stop reason uses the same code.
For HTTP 503, the proxy does not send the provider request when inference is off.
The proxy does not send the provider request when it cannot record the request row.
The proxy does not send the provider request when a stream limit is full.
The proxy does not send the provider request when the process is shutting down.

When the provider returns the chat completion and the proxy cannot record the status, the result is:

- The proxy returns the chat completion.
- The proxy does not send the provider request again.
- The proxy logs a critical event.
- The event contains the request id and the attempt id.
- The status of the row can be `pending`.

After a stream sends response headers, a later failure does not change the HTTP status.
The proxy does not invent a success chunk.
The proxy does not send `[DONE]`.

`scripts/openai-stream-smoke.mjs` is a procedure for an operator.
The script sends no request when `OPENAI_STREAM_SMOKE` is not `1`.
`npm test` does not run the script.
When `OPENAI_STREAM_SMOKE` is `1`, the script sends 1 stream with `curl -N`.
The script then reads that stream with the OpenAI SDK.

```bash
OPENAI_STREAM_SMOKE=1 PROXY_BASE_URL=http://127.0.0.1:8080 \
  TENANT_ID=<tenant-id> TENANT_SECRET=<tenant-secret> MODEL=auto \
  node scripts/openai-stream-smoke.mjs
```

`GET /v1/models` returns `{"object":"list","data":[...]}`.
The list contains each enabled deployment name for that tenant.
The list contains the alias `auto`.

`GET /internal/v1/metrics/summary` uses the same tenant headers.
The query must contain `from` and `to`.
`from` and `to` each contain a date and a time.
The window does not contain `to`.
The window has a maximum of 32 days.
The body contains the request counts.
The body contains the sums of the token counts from the provider.
The body contains the latency sample count, the latency sum, and the latency maximum.
A sum is null when the provider sent no usage.
The body also contains the stream request count.
The body contains the completed count, the cancelled count, the stream error count, and the truncated count.
A cancellation is `client_aborted`.
A stream error is `provider_failed`, `timed_out`, `slow_consumer`, or `interrupted`.
The body contains the P50 and the P95 of the time to the first text.
The body contains the P50 and the P95 of the stream duration.
The body contains those counts for each provider.
The body contains those counts for each deployment.
The body contains the reported stream token sums.
A window with no latency samples has a null P50 and a null P95.
A window with no reported tokens has null token sums.
The proxy does not invent a zero for an empty latency or an empty token sum.
The body contains no price.
The body contains no quality score.

`GET /health/live` returns `{"status":"live"}`.
`GET /health/ready` returns `{"status":"ready","database":"ready"}` when the proxy is ready.
The same route returns HTTP 503 `{"status":"not_ready","database":"unavailable"}` when the proxy is not ready.
`GET /v1/tenant` returns `{"error":"unauthorized"}` when the tenant secret is not valid.
When the tenant secret is not valid, a chat completion uses the OpenAI error object.
The code is `invalid_api_key`.

## Configuration

The process stops before it listens when a necessary value is absent.
The process stops before it listens when a necessary value is not valid.

| Variable | Necessary | Use |
| --- | --- | --- |
| `DATABASE_HOST` | yes | The PostgreSQL host. |
| `DATABASE_PORT` | yes | The PostgreSQL port. |
| `DATABASE_NAME` | yes | The database name. |
| `MIGRATOR_USER` | yes | The value must be `llm_migrator`. |
| `MIGRATOR_PASSWORD` | yes | The password for the migration role. |
| `AUTH_USER` | yes | The value must be `llm_auth`. |
| `AUTH_PASSWORD` | yes | The password for the authentication role. |
| `RUNTIME_USER` | yes | The value must be `llm_runtime`. |
| `RUNTIME_PASSWORD` | yes | The password for the runtime role. |
| `HOST` | no | The listen address. When the variable is absent, the proxy uses `0.0.0.0`. |
| `PORT` | no | The listen port. When the variable is absent, the proxy uses `8080`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error`. |
| `INFERENCE_ENABLED` | no | `true` or `false`. When the variable is absent, the proxy uses `false`. |
| `PROVIDER_CREDENTIAL_KEY` | When `INFERENCE_ENABLED` is `true` | A 32-byte key in base64. |
| `OPENAI_BASE_URL` | no | The OpenAI base URL. When the variable is absent, the proxy uses `https://api.openai.com/v1`. |
| `MAX_ACTIVE_STREAMS` | no | The stream limit for this process. When the variable is absent, the proxy uses `32`. Use an integer from 1 through 10000. |
| `MAX_STREAMS_PER_TENANT` | no | The stream limit for one tenant in this process. When the variable is absent, the proxy uses `32`. Use an integer from 1 through 10000. The limit is not shared with another process. |
| `STREAM_SHUTDOWN_DRAIN_MS` | no | The drain time after `SIGTERM` or `SIGINT`. When the variable is absent, the proxy uses `5000`. Use an integer from 0 through 600000. |

`SIGTERM` and `SIGINT` stop new streams.
The proxy waits for `STREAM_SHUTDOWN_DRAIN_MS`.
A stream that ends in that time can complete.
The proxy then aborts each stream that is still open.
The proxy records `interrupted` when that row write succeeds.
The proxy then closes the server.
The proxy then closes the database pools.
The process ends.
A second signal does not start a second shutdown.

## A reverse proxy

The proxy sends `X-Accel-Buffering: no` on a stream.
The proxy sends `Cache-Control: no-cache, no-transform` on a stream.
The proxy does not compress a stream.
Configure the reverse proxy so it does not buffer `text/event-stream`.
Configure the reverse proxy so it does not gzip `text/event-stream`.
Set the proxy read timeout longer than the stream idle timeout.
Set the proxy read timeout longer than the stream total timeout.
Set the connect timeout longer than the stream connect timeout.
Send `SIGTERM` before the platform stops the process.
Set the platform stop grace longer than `STREAM_SHUTDOWN_DRAIN_MS`.
The stream limits are in the memory of one process.
Two processes do not share those counts.

## Migrations and an earlier image

The proxy applies migration files in one direction.
`003_inference.sql` adds the inference tables.
That file does not change the tables from `001_schema.sql`.
That file does not change the tables from `002_security.sql`.
When the process starts again, the proxy does not apply a file that `schema_migrations` contains.

The image `104831e` checks the tenant secret.
The image applies row-level security.
That image has no chat route.
Its latest migration file is `002_security.sql`.
Use these commands when `schema_migrations` contains `003_inference.sql`.
Build the image when your computer has no tag `llm-proxy:104831e`.
Stop the proxy that is in operation.
Start that image on the same database network.

```bash
git archive --format=tar 104831e | docker build -t llm-proxy:104831e -
docker compose stop app
docker run -d --name llm-proxy-104831e --network llm-proxy_default \
  -p 8080:8080 \
  -e HOST=0.0.0.0 -e PORT=8080 \
  -e DATABASE_HOST=postgres -e DATABASE_PORT=5432 -e DATABASE_NAME=llm_proxy \
  -e MIGRATOR_USER=llm_migrator -e MIGRATOR_PASSWORD=migrator_local_dev \
  -e AUTH_USER=llm_auth -e AUTH_PASSWORD=auth_local_dev \
  -e RUNTIME_USER=llm_runtime -e RUNTIME_PASSWORD=runtime_local_dev \
  -e LOG_LEVEL=info \
  llm-proxy:104831e
```

The readiness route returns HTTP 200 because `schema_migrations` contains `002_security.sql`.
`GET /v1/tenant` returns the tenant id, the name, and the key ids.
The image has no chat route.
Start the Compose proxy again with these commands:

```bash
docker rm -f llm-proxy-104831e
docker compose start app
```

`004_anthropic.sql` adds columns that can be null.
The file adds the Anthropic functions.
The file does not change an OpenAI row that is in the database.
The image `0b18e92` sends an OpenAI chat completion.
The image does not send a request to Anthropic.
Its latest migration file is `003_inference.sql`.
`schema_migrations` keeps `003_inference.sql`.
The readiness route can return HTTP 200.
Build the image when your computer has no tag `llm-proxy:0b18e92`.
Stop the proxy that is in operation.
Start that image on the same database network.

```bash
git archive --format=tar 0b18e92 | docker build -t llm-proxy:0b18e92 -
docker compose stop app
docker run -d --name llm-proxy-0b18e92 --network llm-proxy_default \
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
  llm-proxy:0b18e92
```

That image sends a chat completion for the OpenAI deployment in the database.
That image does not send a request to Anthropic.
Start the Compose proxy again with these commands:

```bash
docker rm -f llm-proxy-0b18e92
docker compose start app
```

Do not remove the database volume.
The init scripts for Compose run only when the database volume is empty.

`005_openai_streaming.sql` adds the streaming flags.
The file adds the stream metadata columns.
An existing row stays non-streaming.
Each new flag has the default `false`.
The current image still returns 1 JSON chat completion when streaming is off.

The image `ba43d61` sends an OpenAI chat completion.
The image sends an Anthropic chat completion.
The image does not stream.
Its latest migration file is `004_anthropic.sql`.
After `005_openai_streaming.sql` is applied, `schema_migrations` keeps `004_anthropic.sql`.
The readiness route can return HTTP 200.
Build the image when your computer has no tag `llm-proxy:ba43d61`.
Stop the proxy that is in operation.
Start that image on the same database network.

```bash
git archive --format=tar ba43d61 | docker build -t llm-proxy:ba43d61 -
docker compose stop app
docker rm -f llm-proxy-ba43d61
docker run -d --name llm-proxy-ba43d61 --network llm-proxy_default \
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
  llm-proxy:ba43d61
```

That image sends a chat completion for OpenAI.
That image sends a chat completion for Anthropic.
That image does not stream.
Start the Compose proxy again with these commands:

```bash
docker rm -f llm-proxy-ba43d61
docker compose start app
```

Do not remove the database volume.

`006_anthropic_streaming.sql` replaces `set_deployment_streaming`.
The new function allows OpenAI.
The new function allows Anthropic.
Another provider still raises `streaming is not supported`.
The file does not drop a column.
The file does not change an existing row.
Streaming stays off until you enable it for that tenant and that deployment.

The image `89f935a` streams an enabled OpenAI deployment.
That image does not stream Anthropic.
Its latest migration file is `005_openai_streaming.sql`.
After `006_anthropic_streaming.sql` is applied, `schema_migrations` keeps `005_openai_streaming.sql`.
The readiness route on image `89f935a` can return HTTP 200.
Build the image when your computer has no tag `llm-proxy:89f935a`.
Stop the proxy that is in operation.
Start that image on the same database network.

```bash
git archive --format=tar 89f935a | docker build -t llm-proxy:89f935a -
docker compose stop app
docker rm -f llm-proxy-89f935a
docker run -d --name llm-proxy-89f935a --network llm-proxy_default \
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
  llm-proxy:89f935a
```

That image sends a chat completion for OpenAI.
That image sends a chat completion for Anthropic.
That image streams OpenAI when both flags are on.
That image does not stream Anthropic.
Start the Compose proxy again with these commands:

```bash
docker rm -f llm-proxy-89f935a
docker compose start app
```

Do not remove the database volume.
Do not edit a migration that is already applied.

`007_stream_interrupted.sql` allows the stream status `interrupted`.
The file does not drop a column.
The file does not change an existing row.
The file does not edit migrations `001` through `006`.

The image `aa7d0b3` streams an enabled OpenAI deployment.
That image streams an enabled Anthropic deployment.
Streaming stays off until both flags are on.
Its latest migration file is `006_anthropic_streaming.sql`.
After `007_stream_interrupted.sql` is applied, `schema_migrations` keeps `006_anthropic_streaming.sql`.
The readiness route on image `aa7d0b3` can return HTTP 200.
That image does not record `interrupted`.
Build the image when your computer has no tag `llm-proxy:aa7d0b3`.
Stop the proxy that is in operation.
Start that image on the same database network.

```bash
git archive --format=tar aa7d0b3 | docker build -t llm-proxy:aa7d0b3 -
docker compose stop app
docker rm -f llm-proxy-aa7d0b3
docker run -d --name llm-proxy-aa7d0b3 --network llm-proxy_default \
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
  llm-proxy:aa7d0b3
```

That image sends a chat completion for OpenAI.
That image sends a chat completion for Anthropic.
That image streams OpenAI when both flags are on.
That image streams Anthropic when both flags are on.
Start the Compose proxy again with these commands:

```bash
docker rm -f llm-proxy-aa7d0b3
docker compose start app
```

Do not remove the database volume.
Do not edit a migration that is already applied.

## Tests

`npm test` must use Node.js 24.
`npm test` must have a Docker daemon in operation.
Refer to [What you must have](#what-you-must-have).
The tests start PostgreSQL with Testcontainers.
The tests start a local mock OpenAI server.
The tests start a local mock of the Anthropic Messages API.
The tests do not send a request to a provider on the internet.

```bash
nvm use 24
npm test
```

Refer to [Check a started proxy](#check-a-started-proxy).

## System rules

- This directory is the git repository.
- A verifier uses Node.js `crypto.scrypt`.
- The scrypt parameters are `N=16384`, `r=8`, and `p=1`.
- The proxy does not use a native code package for the verifier.
- A compiler is not necessary for the Node.js 24 image.
- A tenant secret is 32 random bytes.
- The tenant secret has the prefix `yck_`.
- The CLI shows the tenant secret 1 time.
- The verifier column cannot contain a raw tenant secret.
- A provider API key is AES-256-GCM ciphertext.
- The ciphertext has the prefix `aes-256-gcm$`.
- The encryption key is `PROVIDER_CREDENTIAL_KEY`.
- PostgreSQL does not record that key.
- The runtime role cannot read the ciphertext column.
- A `SECURITY DEFINER` function gives the ciphertext only when 2 conditions are true.
- The tenant in the transaction must match the row.
- The connection must be enabled.
- `llm_owner` is a `NOLOGIN` role.
- The role has `BYPASSRLS`.
- The role has `CREATE` on the schema `public`.
- The role owns the tables.
- The role owns the `SECURITY DEFINER` functions.
- The proxy connects to PostgreSQL only as `llm_migrator`, `llm_auth`, or `llm_runtime`.
- Those 3 roles are not superusers.
- Those 3 roles cannot bypass row-level security.
- `llm_migrator` is a member of `llm_owner`.
- The member can assign table ownership in a migration.
- The role is `NOINHERIT`.
- A person with the migration password can `SET ROLE llm_owner`.
- A tenant request does not use `llm_owner`.
- `003_inference.sql` creates its foreign keys as `llm_owner`.
- `llm_owner` owns the table `tenants`.
- The authentication role can run only `list_active_key_verifiers`.
- The runtime role can read tenant rows under row-level security.
- The runtime role cannot read the verifier column.
- The runtime role cannot read the provider ciphertext.
- The proxy sets the tenant with `set_config('app.tenant_id', ..., true)`.
- The proxy sets the tenant in a transaction.
- The proxy removes `app.tenant_id` when the transaction is complete.
- The pool receives the database session again.
- The provider request starts after that transaction is complete.
- Row-level security applies to the table owner and to each other role.
- When `app.tenant_id` is absent, a policy matches no rows.
- The migration files are SQL files in `migrations/`.
- The proxy applies the files in lexical order.
- The proxy records each file in `schema_migrations`.
- When the process starts again, the proxy does not apply a file that `schema_migrations` contains.
- When the process starts again, the proxy does not delete rows.
- After the proxy applies a file, do not change that file.
- A migration does not create the database roles.
- Compose runs `docker/postgres/init.sh` as the database superuser.
- The tests set the same role attributes with `bootstrapRoles`.
- The proxy applies the migration files before the proxy listens.
- When the proxy cannot connect to PostgreSQL after it listens, the process does not stop.
- The readiness route returns HTTP 503.
- The liveness route continues to return HTTP 200.
- Each log line is 1 JSON object.
- Redaction removes a bearer token.
- Redaction removes a `yck_` tenant secret.
- Redaction removes a scrypt verifier.
- Redaction removes a provider API key that has the prefix `sk-`.
- Redaction removes AES-GCM ciphertext.
- Redaction removes a field when the field name identifies a secret, a prompt, or a chat message.
- A password in local Compose is for development.
- The local database image is PostgreSQL 16.
- You can use a different major version when that version has row-level security.
- The OpenAI Node SDK is the OpenAI client in the proxy.
- The same SDK is the client in the contract tests.
- The Anthropic Node SDK is the Anthropic client for a chat completion that is not a stream.
- An Anthropic stream uses 1 HTTP request to the Messages API.
- That stream does not use the SDK stream helper.
- Each client sets `maxRetries` to `0`.
- Each adapter sets its base URL.
- Anthropic records that URL on the tenant connection.
- OpenAI uses `OPENAI_BASE_URL`.
- Git does not track `.env.live`.
- A Docker build does not copy `.env.live`.

## Limits

- The providers are OpenAI and Anthropic.
- OpenAI can stream a text chat when that tenant and that deployment both enable streaming.
- Anthropic can stream a text chat when that tenant and that deployment both enable streaming.
- The proxy accepts a text chat completion in 1 response when `stream` is not `true`.
- The proxy does not accept a tool.
- The proxy does not accept an image.
- The proxy does not accept audio.
- The proxy does not send the request to a second provider.
- The proxy does not send the request again after an error.
- The proxy does not select a deployment by a quality score.
- Anthropic accepts 1 system message, and that message must be first.
- Anthropic accepts a user message and an assistant message as text.
- The messages must alternate.
- The last message must be a user message.
- Anthropic accepts `temperature` from 0 through 1.
- Anthropic accepts a stop sequence.
- Anthropic accepts a maximum number of output tokens.
- The proxy does not put a `thinking` block in the assistant text.
- A response with only `thinking` blocks has empty assistant text.
- The proxy returns HTTP 502 for a tool-use block.
- The proxy returns HTTP 502 for a content block that it cannot represent.
- The proxy returns HTTP 502 for a stop reason that it cannot represent.
- The proxy records a cache count on the attempt only when Anthropic sends that count.
- The proxy does not invent a cache count.
- Public `usage` has the 3 OpenAI token fields.
- The proxy sends 1 attempt for each request that it accepts.
- The schema permits one more attempt row for the same request.
- The proxy does not set a maximum number of requests.
- The proxy does not calculate a charge.
- The proxy has no price.
- The proxy has no quality score.
- The repository has no Kubernetes manifest.
- The repository has no pipeline for continuous integration.
- The repository has no installation on a public server.
- You add a tenant with the CLI.
- The CLI uses the migration role.
- The proxy has no HTTP route for administration.
- A database role password comes from the environment.
- `PROVIDER_CREDENTIAL_KEY` comes from the environment.
- The proxy has no external secret manager.
- The proxy does not use TLS on its listen port.
- `OPENAI_BASE_URL` is an environment variable.
- A test can select a mock server with that value.
- The proxy does not accept a caller field that selects a URL.
- The proxy uses scrypt for each tenant secret that a caller sends.
- For an unknown tenant, the proxy uses 1 dummy scrypt.
- With the dummy scrypt, the time for an empty key list is closer to the time for a key list that has keys.
- This scrypt step is not a constant-time proof.
- The authentication function gives the verifiers to the authentication role.
- The proxy compares the verifiers.
- You cannot calculate the tenant secret from a verifier.
- The proxy does not log a verifier.
- A person with the migration password can become `llm_owner`.
- That person can bypass row-level security.
- Keep the migration password secret.
- The migration password is an administrative credential.
- The init scripts for Compose run only on an empty database volume.
- When the proxy cannot record the status after the provider returns the chat completion, the caller receives the chat completion.
- The status of the row can be `pending`.
- The tests that `npm test` runs do not send a request to a provider on the internet.
- `scripts/anthropic-smoke.mjs` is a procedure for an operator.
- The script sends no request when `ANTHROPIC_SMOKE` is not `1`.
- `scripts/openai-stream-smoke.mjs` is a procedure for an operator.
- The script sends no request when `OPENAI_STREAM_SMOKE` is not `1`.
- The stream limit is a count in this process.
- The tenant stream limit is a count in this process.
- Those counts are not shared with another process.
- A shutdown records `interrupted` when the row write succeeds.
- A stream is `completed` only after the provider finish event.
- An OpenAI stream is `completed` only after the provider `[DONE]` event.
- An Anthropic stream is `completed` only after `message_stop`.
- An Anthropic response model can add an 8-digit date to the configured model.
- The proxy ignores the Anthropic usage fields `inference_geo` and `speed`.
- The OpenAI SDK treats a closed socket as the end of a stream.
- The Anthropic SDK stream helper treats a closed socket as the end of a stream.
- An Anthropic stream does not use that helper.
- The proxy reads the event bytes.
- The proxy does not treat a missing terminal event as success.

## Work that is not complete

- Input that is not text.
- A tool call.
- A second provider after an error.
- A second send after an error.
- Selection of a deployment by a quality score.
- OAuth, a login, saved caller state, and a user account.
- An HTTP route that revokes a tenant key.
- An HTTP route that changes a provider record.
- Production control of a database role password.
- Production control of the provider key.
- A charge for use, a maximum number of requests, and the cost of each request.

## License

This project uses the MIT license.
Refer to [LICENSE](LICENSE).
