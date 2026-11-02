# Capabilities

## Ingress

The local Compose stack runs Nginx in front of the Node.js process.

Nginx terminates TLS on published port 443.

The Node.js process serves HTTP on port 8080.

Compose does not publish port 8080.

Nginx accepts TLS 1.2.

Nginx accepts TLS 1.3.

Nginx rejects TLS 1.0.

Nginx rejects TLS 1.1.

The operator stores the server certificate in `config/ingress/live`.

The server private key stays in that directory on the host.

The CA private key stays outside the mounted directory.

Git does not track `config/ingress`.

The app image does not contain the private key.

The ingress image does not contain the private key.

A reload copies the mounted certificate into the runtime directory.

Nginx then loads the new certificate.

The same file paths accept a private CA or a public CA.

Nginx sends the client value of `X-Tenant-Id` to the application.

Nginx sends the client value of `Authorization` to the application.

Nginx overwrites `X-Forwarded-For` with the TCP client address.

Nginx overwrites `X-Real-IP` with the TCP client address.

Nginx overwrites `X-Forwarded-Proto`.

Nginx overwrites `X-Forwarded-Host`.

Nginx overwrites `Forwarded`.

A forwarding header does not select the tenant.

Nginx does not buffer a `text/event-stream` response.

Nginx does not compress a `text/event-stream` response.

The proxy read timeout is longer than 600000 milliseconds.

The proxy send timeout is longer than 600000 milliseconds.

The keep-alive timeout is at least 620000 milliseconds.

Nginx does not retry a failed proxy request.

Nginx rejects a request body larger than 1048576 bytes.

Nginx proxies `/internal/` only for an approved client network.

Nginx denies every other client for `/internal/`.

A spoofed forwarding header does not change that decision.

Nginx rejects `/mcp` when `X-Tenant-Id` is missing.

Nginx rejects `/mcp` when `Authorization` is missing.

Nginx forwards `/mcp` when both headers are present.

`POST /mcp` serves MCP revision 2026-07-28 for an authenticated tenant.

The transport is stateless Streamable HTTP.

The response does not use a protocol session.

A GET does not open a session stream.

## MCP discovery

A tenant registers an approved MCP server from the catalog page.

The page is `GET /internal/v1/mcp`.

The credential is stored as a protected reference.

The runtime role does not read that reference.

The modern path uses the official TypeScript MCP client over Streamable HTTP.

That path speaks protocol version 2026-07-28.

Discovery calls `server/discover` and `tools/list`.

The client reads one page and the following page.

The stored catalog keeps the protocol version, `ttlMs`, `cacheScope`, a fingerprint, and a cache age.

A later refresh reports whether the catalog changed.

That refresh still calls the server.

Tool names are prefixed with the server key.

A disabled server is omitted from the exposed catalog.

A tool is omitted until the tenant allows it.

The schema depth bound is 8.

The schema size bound is 16384 bytes.

The schema complexity bound is 64 nodes.

The catalog bound is 32 tools.

The client reads at most 8 pages. A cursor after that page is rejected.

A malformed schema, a schema past a bound, or an external schema reference is rejected.

The proxy does not fetch an external schema.

An explicitly marked legacy server uses the compatibility adapter.

A protocol mismatch does not switch to SSE, stdio, or an older handshake.

Discovery does not call a tool.

## MCP execution

A separate route executes one approved tool on a registered server.

The caller is an authenticated tenant.

The tool and the schema version must be approved.

The arguments must be a complete JSON object.

A read tool runs after those checks.

A disabled server is refused before a call.

The response is HTTP 400.

The message is `The server is not approved.`

A tool that is not allowed is refused before a call.

The response is HTTP 400.

The message is `The tool is not approved.`

A write tool waits for explicit approval.

Denial and cancellation do not call the tool.

A non-idempotent call is dispatched once.

A timeout or a worker stop after dispatch records an uncertain outcome.

The proxy does not retry that call.

The result returns to the caller.

Text in a tool result does not start another tool.

It does not change the tenant.

It does not change the route.

The caller can submit that result when the run mode is continue and the policy allows one follow-up.

That submit records one model request.

It does not call a provider.

The proxy does not send another model request unless that run mode is on.

Retained arguments and results are encrypted.

The runtime role does not read that ciphertext.

The proxy does not execute an arbitrary function.

The proxy does not execute a chat function tool.

Discovery still does not call a tool.

## MCP server

`POST /mcp` lists `list_models` and `get_model_capabilities` for the authenticated tenant.

`create_chat_completion` and `create_embedding` stay off until that tenant approves them.

An approved call uses the existing model registry, budget, and cost record.

A tool call cannot start another MCP call.

The server does not expose administration or a secret.

The server does not enable prompts, resources, sampling, tasks, elicitation, or subscriptions.

The server does not execute an unapproved tool.

The server does not execute a chat function.

A present invalid Origin is rejected.

Request size, output size, and concurrency are bounded.

Cancellation stops the in-flight call.

Nginx still terminates TLS and still rejects `/mcp` without the tenant headers.

The catalog page shows these tools and their permissions.

`GET /internal/v1/mcp/exposed` reads the tools and the permission.

`POST /internal/v1/mcp/exposed` sets one approval.

The catalog page shows the call, the permission, the approval, the failure, the latency, and the history.

The catalog page shows the tool schema.

The proxy does not launch a local executable.

A redirect is refused.

`http` is accepted only for the loopback mock. Every other endpoint must be `https`.

`GET /health/ingress` reports Nginx readiness and application readiness.

The certificate check reports `certificate valid` or `certificate expired`.

The certificate check does not print the private key.

The app command stays `node dist/index.js`.

## Function calling

Anthropic, Vertex, xAI, and OpenRouter accept the same OpenAI function-calling request.

Anthropic receives `tool_use` and `tool_result`.

Vertex receives function declarations, a function call, and a function response.

A user message after tool results stays in that same user turn.

xAI and OpenRouter keep the OpenAI tool body.

The application sends `get_order_status` or another function definition.

The model can return `assistant.tool_calls`.

Each tool call keeps the provider id.

`finish_reason` is `tool_calls`.

More than one call in a round is returned when the provider response contains more than one call.

The application executes the function.

The proxy does not call the function.

The proxy does not run tool code.

The application sends the result as a `tool` message.

The `tool_call_id` must match the tool call.

A later round can call a tool again.

A deployment lists `tools` before a request can send tools.

A deployment lists `tool_choice` before a request can send `tool_choice`.

`tool_choice` can be `none`, `auto`, `required`, or one named function.

A deployment lists `parallel_tool_calls` before a request can send that flag.

The flag is a boolean.

A live DGX host does not receive function tools.

A loopback DGX mock can show the OpenAI tool body.

A loopback DGX mock can stream a tool call.

A stream accepts function tools on OpenAI, Anthropic, Vertex, xAI, and OpenRouter.

Each streamed tool delta keeps its index, its id, and its function name.

Argument fragments stay in provider order.

Text deltas and tool deltas can interleave.

More than one indexed call can arrive in one stream.

A finished tool stream has `finish_reason` `tool_calls`.

The proxy checks the joined arguments only when the call is complete.

The joined arguments must be one JSON object.

The joined arguments follow the same 8192-byte limit.

The proxy does not execute a partial argument fragment.

The proxy does not execute the completed arguments.

Anthropic `input_json_delta` events become those public deltas.

A Vertex function-call event in the accepted shape becomes those public deltas.

A text-only stream still rejects a tool delta.

A missing call id fails the stream.

A fragment that arrives before its call starts fails the stream.

Arguments that are not one JSON object fail the stream.

That failure does not write `data: [DONE]`.

At most 16 tool calls are accepted in one stream.

A schema keyword or `tool_choice` the provider cannot represent is rejected before the provider call.

The proxy does not drop a schema keyword to force success.

Vertex does not accept `parallel_tool_calls`.

Vertex does not accept `additionalProperties`.

A schema type of `null` is rejected.

A stored tool attempt records the deployment capability set and the adapter version.

`functions` and `function_call` stay refused.

A request can send from 1 to 32 function tools.

A function name has at most 64 characters.

`parameters` must be an object schema.

One schema is at most 8192 bytes.

Schema depth is at most 8.

Schema node count is at most 64.

A schema has at most 32 properties.

The proxy rejects a schema past those limits before the provider call.

Logs do not store raw tool arguments.

A tool round is not stored in a sample.

Provider usage stays on the attempt.

Tenant and model permissions stay in force.

## Embeddings

`POST /v1/embeddings` accepts one text string or a batch of text strings.

The route serves the named embedding deployment for that tenant.

A versioned contract pins the model, the dimension, and the normalization policy.

The proxy serves the highest contract version.

That version must name the current upstream model.

The proxy does not serve an older vector space.

The proxy does not renormalize a vector into another policy.

Float encoding returns one finite number array per input.

Base64 encoding is accepted on OpenAI.

The decoded values must match the pinned dimension and the pinned normalization.

Vertex and a private deployment reject base64.

Approved OpenAI models are `text-embedding-3-small`, `text-embedding-3-large`, and `text-embedding-ada-002`.

Approved Vertex models are `text-embedding-004`, `text-embedding-005`, and `gemini-embedding-001`.

A private embedding call requires validation status `validated_mock` and a loopback endpoint.

A live private host does not receive embeddings.

Anthropic, xAI, and OpenRouter do not accept embeddings.

An empty input, an over-long input, a bad dimension, a bad vector count, a non-finite value, and an unsupported encoding are rejected.

A successful attempt stores token counts, latency, and cost.

A failed attempt stores the failure.

A hard budget rejects the embedding before the upstream call.

Logs do not contain the raw input or the vectors.

`GET /internal/v1/metrics/summary` is a separate read.

It does not return the input or the vectors.

An embedding call does not store a chat sample.

An embedding call does not write chat quality evidence or routing evidence.

## Redis

Hot rate counters can be checked in Redis shadow while PostgreSQL still admits the request.

`RATE_LIMIT_STORE` accepts `postgres`, `redis_shadow`, or `redis_active`.

The default is `postgres`.

`redis_active` is off by default.

`postgres` does not open a Redis connection.

`redis_shadow` opens one Redis connection.

`REDIS_SHADOW_CHECKS` accepts `true` or `false`.

The default is `false`.

`true` checks a Redis token bucket for the tenant request rate, the API-key request rate, the tenant token rate, and the API-key token rate.

The bucket uses Redis server time.

Each counter key has a TTL.

The key version is a hash of the tenant rate policy.

API-key counters for that tenant stay in the same key.

The key is scoped to the authenticated tenant id.

The key uses a hash tag, so the counters for one tenant share one Redis Cluster slot.

The same attempt id does not consume the bucket twice.

Connection limits stay in PostgreSQL.

Deployment limits stay in PostgreSQL.

Those limits are concurrency leases.

A budget stays in PostgreSQL.

A concurrency lease stays in PostgreSQL.

Evaluation state stays in PostgreSQL.

An evaluation queue is not stored in Redis.

The shadow check does not admit a request.

`redis_active` admits a hard request rate or a hard token rate only when an operator has approved that policy.

`activate-redis-rate` records the approval.

A policy with no approval stays on PostgreSQL.

`deactivate-redis-rate` removes the approval.

Observe mode stays advisory when Redis is healthy.

A hard request rate is a strict limit.

A hard token rate is a strict limit.

An observe-mode request rate is advisory.

An observe-mode token rate is advisory.

Redis spends only a quota slice that PostgreSQL already charged.

The slice is versioned and bound to a rate-backend epoch.

A Redis failure, a restart, or a lost key does not grant that slice again.

An uncertain result denies that admission.

The fast path opens a circuit breaker and stops using Redis until recovery.

Recovery closes the open epochs and does not refund them.

`RATE_LIMIT_STORE=postgres` is the immediate rollback.

An approval has no effect in `postgres` or `redis_shadow`.

Use shadow mode first, then one test tenant, then a limited active set.

A Redis timeout, a missing script that cannot reload, or an invalid Redis reply does not change a PostgreSQL decision in `postgres` or `redis_shadow`.

Redis does not store a secret, a prompt, or a response.

`GET /health/redis` reports the mode, the link state, connect failures, reconnects, pings, the last error class, and the PostgreSQL decision beside the Redis decision.

In `redis_active` it also reports the circuit, active allows, active denies, fallback denies, epoch closes, and the last recovery time.

A Redis failure does not change `GET /health/ready`.

The connect timeout is an integer from 100 to 10000 milliseconds.

The reconnect timeout is an integer from 100 to 10000 milliseconds.

The default for each timeout is 1000 milliseconds.

The breaker cooldown is an integer from 100 to 10000 milliseconds.

The default cooldown is 1000 milliseconds.

The URL uses `redis:` or `rediss:`.

The URL does not contain a password.

The ACL user is not `default`.

The local Compose profile `redis` starts Redis 7.

That profile is off by default.

The local ACL disables the default user.

The local proxy user can ping, authenticate, quit, and run the rate script.

The local proxy user can write only a key that starts with `rl:`.
