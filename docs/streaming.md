# Streaming

Back to [README](../README.md)

## Where it fits

This page covers step 6 for streams. Streams also pass steps 4 and 5 before the first byte is sent. See the [request path](architecture.md#request-path).

[llm-proxy](../README.md) can stream a text chat for OpenAI, Anthropic, Vertex, xAI, OpenRouter, and an approved DGX deployment. Streaming stays off until you enable it for the tenant and for that deployment. The caller changes only `model`.

```bash
docker compose run --rm app node dist/cli.js set-tenant-streaming \
  --tenant-id <tenant-id> --enabled true
docker compose run --rm app node dist/cli.js set-deployment-streaming \
  --tenant-id <tenant-id> --deployment primary --enabled true
```

`set-deployment-streaming` also takes `--connect-timeout-ms`, `--idle-timeout-ms`, `--total-timeout-ms`, and `--backpressure-timeout-ms`. Each is an integer from 100 through 600000. If you omit a flag, the deployment timeout covers that stage: the connection, a provider that sends no text, the full stream, and a caller that does not read. Each run of the command replaces all four stored values. Each text chunk resets the idle timer. The total timer can still end the stream while text is arriving.

`stream_options` may only be `{"include_usage":true}` or `{"include_usage":false}`. The request shape is in [Chat](chat.md).

## Events

A stream uses `text/event-stream`. Each event is a `chat.completion.chunk`. The completion id and the upstream model stay the same for that response. The first chunk has the assistant role. Later chunks have the text in order, then a chunk with the finish reason.

A usage chunk is sent only when `include_usage` is true and the provider sent at least one integer count. A later Anthropic usage count replaces the earlier count. The proxy does not add the counts together.

A finished stream ends with one `data: [DONE]`, and only after the provider finish and the provider terminal event.

- OpenAI, xAI, and OpenRouter end with `[DONE]`.
- Anthropic ends with `message_stop`.
- Vertex ends with a finish reason.

A timeout does not write `[DONE]`. A failure after headers does not write `[DONE]` and does not change the HTTP status. The proxy does not store the generated text or the raw event stream.

An Anthropic stream sends each `text_delta` in content-block order. An empty text block adds no text. A `ping` adds no text. The proxy does not send `thinking_delta` or `signature_delta`. It rejects a serving model that is not the deployment model, a content block with type `fallback`, and a `tool_use` block. The stream is one HTTP request and does not use the Anthropic SDK stream helper. The proxy reads the event bytes and does not treat a missing terminal event as success.

## Stream status

`stream_status` is one of:

- `connecting`
- `streaming`
- `completed`
- `client_aborted`
- `provider_failed`
- `timed_out`
- `stream_truncated`
- `slow_consumer`
- `interrupted`

`completed` is the only stream status whose attempt status is `succeeded`. An OpenAI stream is `completed` only after the provider `[DONE]`. An Anthropic stream is `completed` only after `message_stop`.

## Capacity

`MAX_ACTIVE_STREAMS` limits open streams in this process. The default is 32. Use an integer from 1 through 10000.

`MAX_STREAMS_PER_TENANT` limits open streams for one tenant in this process. The default is 32, with the same range. These two counts live in process memory. Another process has its own counts.

A configured stream limit is separate and is shared by every process that uses the database. The stricter of the process limit and the configured limit rejects the request. One more stream gets HTTP 503 `stream_capacity` before any event, and the provider is not called. A stream that is already open is left running. Another tenant under its own limit can still stream.

A caller that does not read ends as `slow_consumer`. That end releases the slot, so a later stream can start.

## Shutdown

`SIGTERM` and `SIGINT` stop new streams. A new stream gets HTTP 503 `shutting_down`. The proxy waits for `STREAM_SHUTDOWN_DRAIN_MS`, which defaults to 5000 and may be an integer from 0 through 600000. A stream that finishes in that time can complete. The proxy then aborts each stream that is still open and records `interrupted` when that row write succeeds. It closes the server, then the database pools, and the process ends. A second signal does not start a second shutdown. The process exits with code 1 if shutdown takes more than 15 seconds beyond the drain time.

Send `SIGTERM` before the platform stops the process. Set the platform stop grace longer than `STREAM_SHUTDOWN_DRAIN_MS`.

## Reverse proxy

On a stream the proxy sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`. It does not compress a stream.

Configure the reverse proxy so it does not buffer or gzip `text/event-stream`. Set its read timeout longer than the stream idle timeout and the stream total timeout. Set its connect timeout longer than the stream connect timeout.

## Smoke check

`scripts/openai-stream-smoke.mjs` sends nothing unless `OPENAI_STREAM_SMOKE` is `1`. `npm test` does not run it. When the flag is set, the script sends one stream with `curl -N` and then reads it with the OpenAI SDK.

```bash
OPENAI_STREAM_SMOKE=1 PROXY_BASE_URL=http://127.0.0.1:8080 \
  TENANT_ID=<tenant-id> TENANT_SECRET=<tenant-secret> MODEL=auto \
  node scripts/openai-stream-smoke.mjs
```

## Related

- [Chat](chat.md)
- [Providers](providers.md)
- [Retry](retry.md)
- [Metrics](metrics.md)
