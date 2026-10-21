# Native usage mapping

Anthropic usage counts are cumulative.
A null count keeps the last reported value.
A present count replaces the last value.
The proxy does not add the new count to the old count.

The usage fixture reports output tokens 1, then 8, then 15.
The stored completion total is 15.
The input total 10 is reported again and stays 10.
Cache creation stays 2.
Cache read stays 3.
Prompt tokens are 15.
That is uncached input plus the two cache categories.
Total tokens are 30.
The nested `cache_creation` object is not added again.
`service_tier` is ignored.
`server_tool_use` null is ignored.
A positive server-tool count fails the stream.

The public SSE usage object has `prompt_tokens`, `completion_tokens`, and `total_tokens`.
It does not include the cache field names.
The attempt row stores the three categories in the existing columns.
The native stop reason on that row is `end_turn`.
The SSE finish reason is `stop`.

`max_tokens` is stored as `max_tokens` and sent as `length`.
`refusal` is stored as `refusal` and sent as `content_filter`.
