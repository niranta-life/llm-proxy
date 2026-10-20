# Partial failures

Each case used one upstream call.

| Case | HTTP | `stream_status` | `error_code` | `[DONE]` |
| --- | --- | --- | --- | --- |
| tool use after text | 200 | `provider_failed` | `invalid_upstream_response` | absent |
| fallback content block | 200 | `provider_failed` | `invalid_upstream_response` | absent |
| serving model mismatch | 502 | `provider_failed` | `invalid_upstream_response` | absent |
| malformed event | 200 | `provider_failed` | `invalid_upstream_response` | absent |
| missing `message_stop` | 200 | `stream_truncated` | `stream_truncated` | absent |
| in-stream overloaded error | 200 | `provider_failed` | `overloaded` | absent |
| HTTP 500 before any event | 502 | failed before SSE | `upstream_error` | absent |
| client cancel | closed | `client_aborted` | `request_cancelled` | absent |
| slow consumer | 200 | `slow_consumer` | `slow_consumer` | absent |

The slow-consumer row has `bytes_written` greater than 0 and less than the upstream bytes.
The upstream socket was closed.
Tool-call SSE was absent.
The fallback model id was absent from the SSE body.
Stored rows and logs did not contain the prompt, the generated text, or a raw SSE frame.
