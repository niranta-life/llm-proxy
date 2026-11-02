# Cross-provider tool calls

Back to [README](../README.md)

Anthropic, Vertex, xAI, and OpenRouter accept the same function-calling request. The caller sends one OpenAI JSON body. The proxy converts that body for the provider. Text in a tool result does not start another tool. It does not change the tenant. It does not change the deployment. The caller changes `model`. The caller does not change the tool JSON.

The request bounds are in [Function tools](function-tools.md). The public result is in [Tool call results](tool-calls.md).

## OpenAI, xAI, and OpenRouter

OpenAI, xAI, and OpenRouter keep the OpenAI tool body.

A stream on each of those providers returns the same public tool deltas.

## Anthropic

A function tool becomes `tool_use`. A tool result becomes `tool_result`.

Consecutive tool results become one user message. A user message after those results stays in that same user message.

A stream maps `tool_use` and `input_json_delta` onto the public tool deltas. The content-block index stays the public index.

The proxy does not call the function.

A schema type of `null` is rejected before the Anthropic call.

## Vertex

A function tool becomes a function declaration. A call becomes a function call. A result becomes a function response.

A user message after tool results stays in that same user turn.

Vertex does not accept `parallel_tool_calls`. Vertex does not accept `additionalProperties`. A schema type of `null` is rejected before the Vertex call.

A stream maps a function call onto the public tool deltas. The proxy does not invent a call id. A successful Vertex tool stream uses finish reason `STOP` upstream and `tool_calls` on the public stream.

The proxy does not call the function.

## Private DGX

Function tools are sent only when the stored endpoint host is a loopback address.

A loopback DGX mock can show the OpenAI tool body. A loopback DGX mock can stream a tool call.

A live DGX host does not receive function tools.

## One contract

A schema keyword or `tool_choice` the provider cannot represent is rejected before the provider call.

The proxy does not drop a schema keyword to force success.

A stored tool attempt records the deployment capability set and the adapter version. Each of these providers uses adapter version 1 for that record.

## Related

- [Function tools](function-tools.md)
- [Tool call results](tool-calls.md)
- [Providers](providers.md)
- [Chat](chat.md)
- [Streaming](streaming.md)
