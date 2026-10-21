# OpenAI-compatible private chat contract

This contract is the shape the proxy accepts from a private endpoint.
vLLM and NIM publish this shape for text chat.
These fixtures are not a capture from a live vLLM, NIM, or DGX host.
Live DGX is not verified.

The stored base URL uses `https` and ends in `/v1`.
The caller does not choose that URL.
Authentication is `Authorization: Bearer` and the stored API key.
The proxy does not retry a failed call.

`GET /v1/models` returns JSON.
`data` is an array.
Each item has a string `id`.

`POST /v1/chat/completions` accepts `model` and text `messages`.
A non-stream response uses `object` `chat.completion`.
`choices[0].message.role` is `assistant`.
`choices[0].message.content` is a string.
`usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens` are integers when the response includes them.
A missing `usage` object does not become invented counts.

A stream uses `Content-Type: text/event-stream`.
Each event is `data: ` plus a JSON object.
A content chunk uses `object` `chat.completion.chunk`.
`choices[0].delta.content` is a string when text is present.
A finished choice sets `finish_reason` to `stop`.
A complete stream ends with one `data: [DONE]`.

The proxy contacts only `/v1/models` and `/v1/chat/completions` for serving.
A health URL is a separate stored target.
The proxy does not follow a redirect.
