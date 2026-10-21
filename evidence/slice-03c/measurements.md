# Mock stream measurements

`load-measurements.json` is the report from the mock load test.
The same process served two runs.
Each run completed 12 streams and recorded 0 errors.
The completion rate is 1.
The error rate is 0.
`firstTextDeltaMs` is the time until the first text chunk.
`durationMs` is the time until the stream ends.
`forwardingOverheadMs` is the client first-chunk time minus the mock first-write time.
`memoryRssBytes` is the process RSS while 1, 4, and 8 streams were open, then after those streams ended.
The memory sample is the same object on both runs.
The RSS at 1 open stream was 106708992 bytes.
The RSS at 4 open streams was 158990336 bytes.
The RSS at 8 open streams was 161464320 bytes.
The RSS after the streams ended was 163135488 bytes.

`metrics-summary.json` is the tenant metrics body from the same suite.
That window has OpenAI and Anthropic stream rows.
P50 and P95 in that file are the nearest-rank values of the stored samples.
A second tenant with no rows is not in that file.
The same test asserts that an empty window returns null latency and null token sums.

`shutdown.txt` records two drain passes and one process restart.
Each drain left 0 active streams.
One open stream completed inside the drain.
One open stream was stored as `interrupted`.
The restarted process exited 0.
The next stream on that process completed.

`deploy-rollback.txt` records the image build and the rollback.
Flags off returned HTTP 400 `unsupported_parameter` and made no upstream call.
Flags on completed one OpenAI stream and one Anthropic stream.
Each response had finish reason `stop` and one `data: [DONE]`.
The stored rows were `completed` and `succeeded`.
Image `aa7d0b3` then completed one more stream for each provider.
Migrations `001` through `007` stayed applied.
The attempt count went from 2 to 4.
The Compose volume `llm-proxy_pgdata` stayed in place.
