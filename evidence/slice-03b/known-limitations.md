# Known limitations

- Anthropic text chat streams only when that tenant and that deployment both have streaming enabled. Both flags default to false.
- OpenAI text chat streaming is unchanged.
- Tools, images, audio, `tool_use`, and `input_json_delta` are rejected. This slice does not assemble tool arguments.
- Thinking text and signature text are not sent to the caller.
- A stream makes one upstream attempt. Provider SDK retries stay off. There is no fallback and no model switch.
- A different serving model fails the stream. A `fallback` content block fails the stream.
- An Anthropic stream reads the Messages API with one HTTP request. It does not use the SDK stream helper. A chat completion that is not a stream still uses the Anthropic SDK. `maxRetries` stays 0.
- `completed` requires the mapped finish reason and `message_stop`. The proxy does not treat a closed socket as success.
- After SSE starts, the HTTP status stays 200. A later failure writes no invented success chunk and no `[DONE]`.
- Usage counts replace earlier counts. Cache categories stay in the existing attempt columns when Anthropic reports them.
- Rows and logs do not store the prompt, the generated text, or the raw SSE.
- Migration `006_anthropic_streaming.sql` is forward only. Roll back by running image `llm-proxy:89f935a`. Do not remove the database volume. Do not edit a migration that is already applied. See rollback.txt.
- `npm test` does not call a live provider.
