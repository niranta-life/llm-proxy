# Known limitations

- A tenant stream limit is the count in one process. A second process has its own count. A tenant can reach the limit on each process.
- The process stream limit is also a count in that process.
- A slow caller ends as `slow_consumer` and releases the slot. The bound is that timeout and the socket buffer. The proxy does not enforce a separate byte quota.
- The load sample RSS grew from 106708992 bytes at 1 open stream to 158990336 bytes at 4 open streams. At 8 open streams the RSS was 161464320 bytes. After those streams ended the RSS was 163135488 bytes.
- `interrupted` is stored when the attempt row write succeeds. A database failure can leave the attempt `pending`.
- A stream in `connecting` or `streaming` counts as a stream request. It does not count as completed, cancelled, an error, or truncated.
- P50 and P95 are nearest-rank percentiles of stored samples. An empty sample set returns null. A small sample set can make P95 equal P50.
- Token sums are null when no stored stream in the window has a token count.
- Shutdown drain is local to the process. Another replica does not drain when this process stops.
- Image `aa7d0b3` can serve streams after `007_stream_interrupted.sql` is applied. That image does not write `interrupted`.
- Rollback does not delete attempt rows. Do not edit migrations `001` through `006`. Do not remove the database volume.
- `npm test` does not call a live provider. `scripts/openai-stream-smoke.mjs` stays idle unless `OPENAI_STREAM_SMOKE=1`. `scripts/anthropic-smoke.mjs` stays idle unless `ANTHROPIC_SMOKE=1`.
- The proxy does not add dynamic routing, fallback, retry orchestration, replay, or evaluation.
- An Anthropic stream accepts the configured model or that model plus an 8-digit snapshot date. Any other model fails the stream.
- The proxy ignores Anthropic usage fields `inference_geo` and `speed`.
