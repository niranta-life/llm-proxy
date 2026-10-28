# Chat

Back to [README](../README.md)

[llm-proxy](../README.md) accepts one text chat and returns an OpenAI chat completion. The caller uses the same JSON for every provider. Setup for each provider is in [Providers](providers.md).

## Where it fits

This page covers the whole path. See the [request path](architecture.md#request-path).

## Request

`POST /v1/chat/completions` needs `model` and text `messages`.

`model` is `auto` or the name of an enabled deployment. The deployment and its connection must both be enabled. The only alias is `auto`. Do not name a deployment `auto`.

You can omit `stream`, or set it to `false`. `stream: true` works only when streaming is on for that tenant and that deployment. See [Streaming](streaming.md).

`stream_options` may be `{"include_usage":true}` or `{"include_usage":false}`. No other field is accepted there.

`task` may be `classification`, `extraction`, `summarization`, `reasoning`, `coding`, `translation`, `writing`, `general_qa`, or `unknown`. It labels the request for later comparison. The proxy does not send it to the provider, and it does not call a model to classify the text. Any other value is rejected. See [Metrics](metrics.md).

Any other field is sent only when the deployment lists that capability:

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
- `response_format`, only `{"type":"text"}`. The deployment capability name is `response_format_text`.

The proxy does not accept tools, images, or audio. It does not remove a field it cannot accept. It refuses the request instead.

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "X-Tenant-ID: <tenant-id>" \
  -H "Authorization: Bearer <tenant-secret>" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

## Provider differences

Anthropic accepts `temperature` from 0 through 1, `stop`, `max_tokens`, and `max_completion_tokens`. If you send both token limits, the values must be equal. If you send neither, the proxy uses the deployment's default max output tokens. If the deployment has no default, the request is refused with 400 `invalid_parameter`.

Anthropic also needs a first system message if you send one, then user and assistant text that alternates, and a user message last. A developer message is refused. A tool, an image, or a capability the deployment does not list is refused.

Vertex accepts `temperature` from 0 through 2, `stop`, `max_tokens`, and `max_completion_tokens`. One system message is allowed, and it must be first. Assistant messages go upstream with role `model`. Messages do not have to alternate. Vertex does not use a default max output tokens, and it does not put hidden thinking text in the assistant message. Thinking tokens can be stored on the attempt. A cached count stays inside the prompt count. Public `usage` still has the three OpenAI fields.

## Response

A success body has `object` set to `chat.completion`. `model` is the upstream model, not the deployment name you sent. The assistant text is in `choices`. `created` comes from the proxy clock.

`usage` is present only when the provider sent integer token counts. The proxy does not invent a count. Public `usage` has the three OpenAI fields. For Anthropic, `prompt_tokens` is the input that was not cached, plus any cache count Anthropic reported. The attempt row stores a missing count as null.

The body includes `provider` when the upstream response names one. Stream frames do not include `provider`.

The chat response does not write the prompt or the completion as plaintext. Request characteristics omit both. Encrypted capture is off by default. When it is on, an approved chat is stored as ciphertext. A sample route returns metadata only. A schedule and a replay do not run on this path. See [Encrypted samples](metrics.md#encrypted-samples).

Before the provider call, the proxy writes a request row and an attempt row. The two ids are different. The rows keep the deployment, the configuration version, the connection, the connection version, the status, the duration, the provider token counts, the provider response id, and the native stop or error reason. A stream also stores `stream_status`, the time to the first text, the chunk count, and the bytes written.

A chat stays `pending` until a terminal status is stored. A finished response stores `succeeded`. A rejected response stores `failed`. If the provider returns a completion and the status write then fails, the caller still gets the completion. The proxy does not call the provider again. It logs a critical event with the request id and the attempt id. The row can stay `pending`.

## Models

`GET /v1/models` returns `{"object":"list","data":[...]}`. The list has each enabled deployment name for that tenant, plus the alias `auto`.

## Errors

An error body is an OpenAI error object:

```json
{"error":{"message":"...","type":"invalid_request_error","param":"stream","code":"unsupported_parameter"}}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `unsupported_parameter`, `unknown_parameter`, `invalid_parameter`, `unsupported_message`, or `unsupported_response_format` | A field or value is invalid, the deployment does not accept the field, a message role or content is not supported, or streaming is off. |
| 401 | `invalid_api_key` | The tenant secret is not valid. |
| 401 | `upstream_auth_error` | Anthropic rejected the provider API key. The message is unchanged, and the code is not `invalid_api_key`. |
| 404 | `model_not_found` | The name is unknown, or the deployment is disabled. |
| 408 | `request_cancelled` | The caller closed the request. |
| 429 | `rate_limit` | The provider returned HTTP 429. |
| 429 | `tenant_rate_limited`, `api_key_rate_limited`, `concurrency_limited`, `api_key_concurrency_limited`, `stream_limited`, `api_key_stream_limited`, `connection_limited`, `deployment_limited`, `token_rate_limited`, `api_key_token_limited`, `budget_exceeded`, `budget_unbounded`, or `budget_unknown` | A hard limit or a hard budget rejected the request before the upstream call. |
| 502 | `upstream_error` or `invalid_upstream_response` | The provider returned an error, or the body is not a chat completion. |
| 503 | `inference_disabled`, `service_unavailable`, `stream_capacity`, `slow_consumer`, `shutting_down`, `circuit_open`, or `admission_unavailable` | Inference is off, the proxy cannot prepare the request, a stream slot is full, the caller does not read, the process is shutting down, the breaker is open, or a hard admission check cannot reach the database. |
| 504 | `timeout` | The deployment timeout finished, or a stream timeout finished before the response headers. |
| 529 | `overloaded` | Anthropic returned HTTP 529. |

HTTP 400 covers `stream: true` when streaming is off, a tool, an image, audio, a response format other than text, and any field the deployment does not list. The proxy does not send that field upstream.

These cases never call the provider:

- Inference is off.
- The request row cannot be recorded.
- A stream limit is full.
- The process is shutting down.
- A hard limit or a hard budget rejects the request.
- A hard admission check cannot reach the database.
- The breaker for that deployment is open.

A tool-use block, a content block the proxy cannot represent, and an unknown stop reason use `invalid_upstream_response`.

After a stream has sent response headers, a later failure does not change the HTTP status. The proxy does not invent a success chunk and does not send `[DONE]`.

Anthropic stop reasons map like this:

- `end_turn` and `stop_sequence` become `stop`.
- `max_tokens` and `model_context_window_exceeded` become `length`.
- `refusal` becomes `content_filter`.

The proxy returns HTTP 502 for a `tool_use` block, a content block it cannot represent, and a stop reason it cannot represent. It does not put a `thinking` block in the assistant text. A response that has only thinking blocks has empty assistant text.

## What one request will do

With retry off and no fallback, the proxy sends the request once. Provider clients set `maxRetries` to `0`.

An enabled retry can make one more attempt on the same deployment. An enabled fallback on `auto` can try one other approved deployment, and only before any output. The same request does not retry and fall back. The cap is two upstream attempts. See [Retry](retry.md) and [Fallback](fallback.md).

## Related

- [Tenants](tenants.md)
- [Providers](providers.md)
- [Streaming](streaming.md)
- [Metrics](metrics.md)
