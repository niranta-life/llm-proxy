# Known limitations

- OpenAI text chat streams only when that tenant and that deployment both have streaming enabled. Both flags default to false. Anthropic streaming is not implemented.
- Tools, images, audio, and any other unsupported parameter are rejected before SSE and before an upstream call.
- A stream makes one upstream attempt. Provider SDK retries stay off. There is no fallback and no model switch.
- `stream_status` holds `connecting`, `streaming`, `completed`, `client_aborted`, `provider_failed`, `timed_out`, `stream_truncated`, or `slow_consumer`. Attempt status stays `pending`, `succeeded`, or `failed`. Only `completed` is `succeeded`.
- `completed` requires the provider finish event and the provider `[DONE]` event. The official OpenAI SDK treats socket end as success, so the proxy decodes the event bytes itself. Non-streaming chat still uses the SDK.
- After SSE starts, the HTTP status stays 200. A later failure writes no invented success chunk and no `[DONE]`.
- A usage chunk is written only when `stream_options.include_usage` is true and at least one reported count is an integer. Missing usage stays null.
- `MAX_ACTIVE_STREAMS` is an in-process bound. The default is 32. It is not shared across processes. One more stream is HTTP 503 `stream_capacity` and does not stop a stream that is already running.
- Rows and logs do not store the prompt, the generated text, or the raw SSE. A telemetry failure after bytes were sent does not retry. The row can stay `pending`.
- The four stream timeouts are null on existing deployments and then use that deployment's `timeout_ms`. Each explicit value is an integer from 100 through 600000. Omitting a timeout flag on `set-deployment-streaming` stores null and clears a previous explicit value.
- `npm test` does not call a live provider. `scripts/openai-stream-smoke.mjs` exits 0 without a network call unless `OPENAI_STREAM_SMOKE=1`. See smoke-off.txt. The flagged run in this directory used the local proof mock, not the public OpenAI API.
- Migration `005_openai_streaming.sql` is forward only. Roll back by running the Slice 02 image. Do not remove the database volume. See rollback.txt.
- There is no lint script. This slice does not add one.
