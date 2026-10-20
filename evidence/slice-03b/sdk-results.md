# SDK results

The official OpenAI SDK used `maxRetries: 0`.
The API key was the tenant secret.
`baseURL` ended in `/v1`.
The caller sent `X-Tenant-ID`.
The same caller changed only the model.

Two process launches both passed.
Each launch read one OpenAI stream and two Anthropic streams.
The second Anthropic read in each process matched the first.

Launch 1 and launch 2 reported the same observations:

```json
{"openaiContentPresent":true,"openaiOrderHeld":true,"openaiFinish":"stop","anthropicContentPresent":true,"anthropicFinish":"stop","secondMatchesFirst":true,"anthropicModel":"claude-permitted","openaiModel":"gpt-stream-actual"}
```

Both logs end with `NPM_TEST_EXIT:0`.
The logs do not contain the generated text.
Missing `message_stop` and failures after the first SSE byte are asserted on the raw HTTP body and on `stream_status`.
The SDK success flag is not the proof for those cases.
