# Function tools

Back to [README](../README.md)

A chat can send function tools on `POST /v1/chat/completions`. The body is the OpenAI function-calling shape. The application executes the function. The proxy does not call the function. Text in a tool result does not start another tool. It does not change the tenant. It does not change the deployment. The proxy does not run tool code. An approved MCP tool uses a separate route. The `/mcp` server does not execute a chat function. See [MCP catalog](mcp.md).

This page is the caller contract. Provider differences are in [Cross-provider tool calls](cross-provider-tools.md). The returned call is in [Tool call results](tool-calls.md). The chat path is in [Chat](chat.md).

## Where it fits

The deployment must list `tools` before a request can send `tools`. It must list `tool_choice` before a request can send `tool_choice`. It must list `parallel_tool_calls` before a request can send that flag.

A function-tool request can retry on the same deployment. It does not move to another provider. See [Retry](retry.md) and [Fallback](fallback.md).

## Request

`tools` holds from 1 to 32 function tools. An empty array is rejected.

Each tool is a function. The name uses letters, digits, `_`, or `-`. The name has at most 64 characters.

When `parameters` is present, it is an object schema. The schema can use `type`, `properties`, `required`, `additionalProperties`, `items`, `description`, `enum`, and numeric or length bounds.

The proxy rejects `$ref`, combinators, `pattern`, `format`, and `strict: true`. `strict: false` is accepted.

One schema is at most 8192 bytes. Schema depth is at most 8. Schema node count is at most 64. One schema has at most 32 properties. The proxy rejects a schema past those limits before the provider call. The message is `The schema is too large.`, `The schema is too deep.`, `The schema has too many nodes.`, or `The schema has too many properties.`

A property name starts with a letter or `_`. It then uses letters, digits, `_`, or `-`, and it has at most 64 characters.

`tool_choice` can be `none`, `auto`, `required`, or one named function that is in `tools`.

`parallel_tool_calls` is a boolean.

`functions` and `function_call` stay refused.

A schema keyword or `tool_choice` the provider cannot represent is rejected before the provider call. The proxy does not drop a keyword to force success.

## What the application does

The model can return `assistant.tool_calls`. `finish_reason` is `tool_calls`.

The application executes the function. It sends the result as a `tool` message. The `tool_call_id` must match the tool call.

Every tool call in a round needs a result before the next user message. A later round can call a tool again.

## What is stored

A stored tool attempt records the deployment capability set and the adapter version.

Logs do not store raw tool arguments. A tool round is not stored in a sample. Provider usage stays on the attempt.

Tenant and model permissions stay in force.

## Related

- [Cross-provider tool calls](cross-provider-tools.md)
- [Tool call results](tool-calls.md)
- [Chat](chat.md)
- [Streaming](streaming.md)
- [Providers](providers.md)
