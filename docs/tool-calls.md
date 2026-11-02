# Tool call results

Back to [README](../README.md)

The proxy returns a tool call. It does not execute the call. Text in a tool result does not start another tool. It does not change the tenant. It does not change the deployment. The application executes the function and sends the result back. An approved MCP tool uses a separate route. The `/mcp` server does not execute a chat function. See [MCP catalog](mcp.md). The request shape is in [Function tools](function-tools.md). Provider mapping is in [Cross-provider tool calls](cross-provider-tools.md).

## Unary result

The proxy returns `choices[0].message.tool_calls`. Each call keeps the provider id.

`finish_reason` is `tool_calls`.

More than one call in a round is returned when the provider response contains more than one call.

The application sends one `tool` message per call. The `tool_call_id` must match that call. Every call in the round needs a result before the next user message.

## Streamed result

A stream accepts function tools on OpenAI, Anthropic, Vertex, xAI, and OpenRouter. A loopback DGX mock can stream a tool call. A live DGX host does not receive function tools.

Streaming must be on for the tenant and for the deployment. See [Streaming](streaming.md).

Each streamed tool delta keeps its index, its id, and its function name. Argument fragments stay in provider order. Text deltas and tool deltas can interleave.

More than one indexed call can arrive in one stream. At most 16 tool calls are accepted in one stream.

The proxy checks the joined arguments only when the call is complete. The joined arguments must be one JSON object. The joined arguments follow the same 8192-byte limit.

The proxy does not execute a partial argument fragment. The proxy does not execute the completed arguments.

A finished tool stream has `finish_reason` `tool_calls`, then `data: [DONE]`.

## Stream failures

A text-only stream still rejects a tool delta.

A missing call id fails the stream. A fragment that arrives before its call starts fails the stream. Arguments that are not one JSON object fail the stream. Arguments over 8192 bytes fail the stream.

That failure does not write `data: [DONE]`. It does not change the HTTP status after headers are sent.

Anthropic `input_json_delta` events become the public deltas. A Vertex function-call event in the accepted shape becomes the public deltas. The proxy does not invent a Vertex call id.

## What is stored

Logs do not store raw tool arguments. A tool round is not stored in a sample. A tool stream stores no sample. Provider usage stays on the attempt.

## Related

- [Function tools](function-tools.md)
- [Cross-provider tool calls](cross-provider-tools.md)
- [Streaming](streaming.md)
- [Chat](chat.md)
