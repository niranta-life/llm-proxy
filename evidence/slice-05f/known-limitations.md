Known limitations.

Provider overload has no separate failure class.
The injected status is HTTP 529.
The stored class is the existing value upstream_error.
The public status is 502.

The metrics summary stores P50 and P95 for stream duration and for the time to the first text.
It does not store P99.
P99 in the measurement file is computed from the captured durations in that same run.
The index is ceil(p * n) - 1.

There is no database contention counter.
The observation is the elapsed time and the status of overlapping requests.

Memory and the concurrent stream count are the test process.
They are not a production cgroup.
The stream count is streamGate.active() on that process.

The database-unavailable observation holds the admission advisory lock.
PostgreSQL stays up.
The shared test database was not stopped.
A closed database port was not used.
The public result is HTTP 503 with code admission_unavailable.
The proxy does not call the upstream model.

A closed socket before response headers is stored as ambiguous_network.
A non-stream partial SSE body is stored as upstream_error.
The public code for that body is invalid_upstream_response.
A stream that is cut before response headers is stored as ambiguous_network.
A partial SSE body that ends after a content chunk is stored as stream_started.
The stream status for that end is stream_truncated.

The Vertex cancel step waits until the attempt row is connecting.
It then aborts the caller.
The connect deadline for that step is 5000 ms.
The test restores the 400 ms connect deadline before the timeout check.
The slow consumer assertion is unchanged.
A 50 ms abort on a loaded event loop stored timed_out against the 400 ms deadline.

No live provider call was made.
VERTEX_LIVE, XAI_LIVE, and OPENROUTER_LIVE were unset.
This file does not claim a readiness HTTP status.
