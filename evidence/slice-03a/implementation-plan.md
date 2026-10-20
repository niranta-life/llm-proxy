# Slice 03A implementation plan

Add `stream=true` on `POST /v1/chat/completions` for an OpenAI deployment whose tenant and deployment both allow streaming. Leave every other provider non-streaming.

## Contract

Map each upstream chunk to `start`, `text_delta`, `usage`, and `finish`. Write those events as OpenAI `chat.completion.chunk` frames. Keep one completion id and the upstream model from the first chunk. Put the assistant role on the start chunk. Write text deltas in order. Write the provider finish reason. Write a usage chunk only when `stream_options.include_usage` is true and the provider reported an integer count. Write one `data: [DONE]` only after a real finish event and a real `[DONE]` event.

## Execution

Authenticate before deployment resolution. Reject tools, multimodal content, Anthropic streaming, and streaming that is not enabled, before SSE headers and before an upstream call. Make one OpenAI `fetch`. Keep SDK retries off. Do not fall back or switch models. Apply the connection, idle, total, and backpressure timeouts. Abort the upstream fetch on client disconnect, `AbortSignal`, and generator close. Wait for downstream drain. Abort a stalled consumer. Do not buffer the whole response.

## Persistence

Keep `proxy_requests` and `model_attempts`. Store provider, deployment, first text-delta latency, stream duration, chunk count, bytes written, terminal `stream_status`, and reported token counts. Do not store the prompt, the generated text, or the raw SSE. `completed` is the only stream status stored with attempt status `succeeded`. A persistence failure before the upstream call makes no call. A telemetry failure after bytes were sent does not start a second attempt.

## Release

`005_openai_streaming.sql` follows `004_anthropic.sql`. New flags default to false. `MAX_ACTIVE_STREAMS` defaults to 32. The Slice 02 image stays ready after `005` because `004_anthropic.sql` remains applied. Do not remove the database volume.

## Deviation

OpenAI `stream()` uses one `fetch` and a local SSE decoder so a missing `[DONE]` stays visible. The official OpenAI SDK treats socket end as success. Non-streaming chat still uses the SDK.
