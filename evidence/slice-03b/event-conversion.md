# Event conversion

The unit tests replay each fixture through the shipped SSE decoder and `itemsFromAnthropicData`.
They start from `initialAnthropicStreamCursor`.
They do not reimplement the converter.

| Fixture | Result |
| --- | --- |
| normal.sse | One text block. Finish `stop`. Native reason `end_turn`. `message_stop` completes the cursor. |
| blocks.sse | Two text blocks stay in order. Finish `stop`. |
| empty.sse | No text event. Finish `stop`. The stream completes. |
| ping.sse | Ping adds no text. Finish `stop`. Native reason `stop_sequence`. |
| usage.sse | Completion counts are 1, then 8, then 15. Prompt stays 15. Cache creation stays 2. Cache read stays 3. The repeated input total is not doubled. |
| max-tokens.sse | Finish `length`. Native reason `max_tokens`. |
| refusal.sse | Finish `content_filter`. Native reason `refusal`. |
| thinking.sse | Thinking text, signature text, and redacted data are absent. The text block remains. |
| tool-use.sse | `invalid_upstream_response`. The cursor does not complete. Tool-call fields are absent. |
| error.sse | Code `overloaded`. The cursor does not complete. |
| missing-stop.sse | Finish `stop` is present. `message_stop` is absent. The cursor does not complete. |
| malformed.sse | `invalid_upstream_response`. |
| fallback.sse | `invalid_upstream_response`. The fallback block and the other model are absent from canonical events. |
| wrong-model.sse | No canonical event. `invalid_upstream_response`. |
| cancel-prefix.sse | Listen-path result `client_aborted`. Error `request_cancelled`. One upstream call. |
| slow-prefix.sse | Listen-path result `slow_consumer`. `bytes_written` is greater than 0 and less than the upstream bytes. One upstream call. |

`model_context_window_exceeded` maps to `length`.
`pause_turn`, `input_json_delta`, `citations_delta`, an unknown event type, and a positive `server_tool_use` count are rejected.
