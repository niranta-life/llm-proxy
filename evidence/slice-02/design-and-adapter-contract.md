# Slice 02 design and adapter contract

Slice 02 adds Anthropic behind the existing `POST /v1/chat/completions` route. The caller still sends `X-Tenant-ID` and `Authorization: Bearer <tenant-secret>` and still uses the OpenAI chat JSON. There is no OAuth and no plugin registry.

## Contract

`ProviderAdapter` has two operations:

- `prepare(request, route)` checks provider-specific semantics and throws before any row is inserted and before any upstream call.
- `execute(call)` performs one upstream call. `call` carries the decrypted API key, the base URL, the canonical request, the resolved route, and the caller abort signal.

`CanonicalTextRequest` is the validated chat request. It keeps `model`, the text messages, and every optional caller field that passed shared validation. `CanonicalTextCompletion` is one OpenAI chat completion object.

The OpenAI adapter's `prepare` does nothing. Its `execute` calls the existing OpenAI completion function. The OpenAI HTTP statuses and error codes are unchanged.

## Route

The handler authenticates the tenant first. It then loads that tenant's catalog under forced row-level security. `auto` selects the alias target. Any other name selects that deployment. A disabled deployment or connection resolves to nothing. The adapter is chosen from `provider_type` (`openai` or `anthropic`). An unknown provider returns `service_unavailable` and does not call OpenAI. There is no fallback and no second attempt.

OpenAI uses the process `OPENAI_BASE_URL`. Anthropic uses the endpoint stored on that tenant's connection. A stored `/v1` suffix is removed so the SDK path `/v1/messages` is not doubled.

## Anthropic call

The official `@anthropic-ai/sdk` Messages client is constructed with the decrypted key, the connection origin, `maxRetries: 0`, the deployment timeout, logging off, and `anthropic-workspace-id` only when a workspace id is stored. The caller abort and the timeout share one `AbortController`. A caller abort is recorded as `request_cancelled`. A timeout is recorded as `timeout`.

Supported conversion:

- deployment upstream model id
- text messages
- one leading system message
- `max_completion_tokens` or `max_tokens` to `max_tokens`
- temperature when it is from 0 through 1 and the deployment allows it
- stop sequences when the deployment allows stop
- the deployment `default_max_output_tokens` when the caller sends no output limit

Rejected before the upstream call, without deleting the caller field from the validated request:

- streaming, tools, tool results, and multimodal content
- a response format other than text
- a system message that is not the first message, and more than one system message
- developer messages
- assistant prefill and non-alternating turns
- `top_p`, penalties, seed, `n`, `user`, and `response_format` on Anthropic
- temperature above 1
- disagreeing `max_tokens` and `max_completion_tokens`

## Response

Anthropic `end_turn` and `stop_sequence` become `stop`. `max_tokens` and `model_context_window_exceeded` become `length`. `refusal` becomes `content_filter`, the refusal text is returned, and the native reason `refusal` is stored. Thinking and redacted thinking blocks are omitted. Tool-use, an unknown block, and any other stop reason become `invalid_upstream_response` and are not reshaped. The attempt still stores the message id, the native stop reason, and the reported token counts when the provider sent them. The public error body does not include the block, the id, or the token counts. Missing id, stop reason, and token counts stay null.

Public usage has `prompt_tokens`, `completion_tokens`, and `total_tokens` only when the provider reported integer counts. `prompt_tokens` adds cache creation and cache read only when at least one of those fields is a valid integer. The attempt stores `uncached_input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` separately. Missing values stay null.

The Messages API does not return `created`. The proxy sets it from its own clock.

## Errors and telemetry

Anthropic HTTP 401 and 403 become `upstream_auth_error`. HTTP 429 becomes `rate_limit`. HTTP 529 becomes `overloaded`. Other upstream failures become `upstream_error`. The stored native reason is the provider error type when that type is a safe token. The stored provider request id is the `request-id` header when that header is present. Neither value is replaced with `api_error` or another id when the provider omits it. OpenAI HTTP 401 and 500 stay `upstream_error`. Error bodies use the OpenAI error object and do not copy the provider body, the credential, or the prompt.

`proxy_requests` and `model_attempts` record the tenant, connection, deployment, upstream model, provider response id, duration, status, native stop or error reason, token counts, and cache categories. They do not store prompt or completion text. A failed status write returns the completion that was already received and does not call the provider again.

## Registry

`004_anthropic.sql` widens `provider` to `openai` or `anthropic` and adds nullable `endpoint`, `workspace_id`, `default_max_output_tokens`, `provider_request_id`, `stop_reason`, and the three cache-token columns. It does not update existing data rows. Credentials remain `aes-256-gcm$` ciphertext. The runtime role cannot select `protected_credential`.
