# Performance

Back to [README](../README.md)

These figures are copied from recorded evidence. Each run used mock providers. The figures are not a production service level.

## Where it fits

This page lists the measured times, rates, and memory from those runs. Request counts and stream percentiles on a live proxy are in [Metrics](metrics.md). The canary stop and the guardrail stop are also in [Operations](operations.md).

## Mock stream load

One process served two runs. Each run completed 12 streams and recorded 0 errors. The completion rate is 1. `firstTextDeltaMs` is the time until the first text chunk. `durationMs` is the time until the stream ends. `forwardingOverheadMs` is the client first-chunk time minus the mock first-write time. The RSS sample is the same object on both runs.

| Run | First text P50 | First text P95 | Duration P50 | Duration P95 | Forwarding P50 | Forwarding P95 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 69.51458300000013 ms | 99.6728750000002 ms | 75.47408400000131 ms | 107.77304100000038 ms | 5.461083000001963 ms | 10.293374999997468 ms |
| 2 | 61.099583999999595 ms | 82.15808300000208 ms | 65.98454200000197 ms | 86.80550000000221 ms | 4.607166999998299 ms | 7.247583000000304 ms |

RSS at 1 open stream was 106708992 bytes. RSS at 4 open streams was 158990336 bytes. RSS at 8 open streams was 161464320 bytes. RSS after the streams ended was 163135488 bytes.

The metrics window from the same suite stored nearest-rank stream percentiles. First-text P50 was 11 and P95 was 23, on 2 samples. Stream duration P50 was 11 and P95 was 36, on 5 samples. General latency for that window had 6 samples, a sum of 83 milliseconds, and a maximum of 36 milliseconds. That route does not return a P50 or a P95 for general latency. An empty window returns null latency.

## Reliability workload

This workload is one line from a full suite that exited 0. It is not a production traffic sample. The percentile index is `ceil(p * n) - 1`.

The run sent 21 request ids. 20 succeeded. The success rate is 0.9523809523809523. The upstream attempt count is 21. Retry amplification is 1. The fallback count is 0. One provider attempt failed. The provider failure rate is 0.047619047619047616. Budget denials are 0. Rate-limit denials are 0. The reservation backlog is 0.

Captured latency uses the test wall clock. The captured sample count is 15.

| Measure | Value |
| --- | --- |
| Captured P50 / P95 / P99 | 181 / 310 / 310 ms |
| Captured stream P50 / P95 / P99 | 113 / 144 / 144 ms |
| Metrics latency samples / sum / max | 21 / 825 / 148 ms |
| Metrics stream duration samples / P50 / P95 | 4 / 29 / 50 ms |
| Slow elapsed | 349 ms |
| Mock delay | 100 ms |
| Proxy overhead | 249 ms |
| Database contention | 219 ms |

Proxy overhead is the slow elapsed time minus the mock delay. The four overlapping contention results returned HTTP 200 in 169, 196, 211, and 218 milliseconds. Concurrent streams at the measure read were 0. A shutdown case in the same suite recorded 1 active stream before shutdown.

RSS before the measure was 62062592 bytes. RSS after was 148029440 bytes. Heap before was 40601808 bytes. Heap after was 40102072 bytes. One shared breaker moved from closed to open.

## Evaluation schedule

The schedule run used Node.js 24 and a mock provider. Heap and RSS are the in-process test worker. That worker shares the Vitest process.

| Measure | Stored value |
| --- | --- |
| Cancel latency | 28.849041999999827 ms |
| Evaluation throughput | 26.253692409547572 runs per second |
| Evaluation backlog | 8 |
| Heap | 41591992 bytes |
| RSS | 221757440 bytes |
| Locks before / waiting | 2 / 0 |
| Locks after / waiting | 6 / 0 |
| Deadlocks | 0 |
| Budget reservation overhead | 58.46087500000067 ms |
| Scheduler overhead | 58.46087500000067 ms |
| Production inference before | 45.153416999999536 ms |
| Production inference after | 44.60462500000085 ms |
| Cost per valid comparison | 0.012 |
| Valid pairs / completed attempts / provider calls | 8 / 8 / 8 |

The synthetic load does not call a judge. The judge disagreement rate is null. One schedule case stored `durationMs` 2147483647 and `latencyMs` 1 with status 201. That duration is the stored bound. It is not a measured delay.

## Shadow rank

Forty calls ranked an eight-candidate fixture. The percentile index is `ceil(p/100*n)-1`. The first call missed the cache. The next 39 calls hit it. The rank loop made 0 provider calls.

| Measure | Value |
| --- | --- |
| P50 / P95 / P99 | 0.013 / 0.018 / 0.077 ms |
| Candidates | 8 |
| Cache hits | 39 of 40 |
| Cache hit rate | 0.97500 |
| Decision failures | 0 |
| Added inference overhead | 2 ms |
| Provider calls during the shadow chat | 1 |

Added inference overhead is the stored `computation_ms` of one shadow `model=auto` chat.

## Canary stop

The clock starts before `POST /internal/v1/routing/rollouts/{id}/stop` and stops when a second database session sees status `stopped`. A second database session sees the stopped status within 74 milliseconds. The test requires that delay to stay under 2000 milliseconds.

## Guardrail stop

One measured pass detected the violation in 11.351 milliseconds and completed the stop in 4.636 milliseconds. The monitoring read scanned 1 assignment row in 4.910 milliseconds. The worker heap was 56825088 bytes. A synthetic run inside the gates recorded 0 false stops. The last canary deployment was guard-spare. The next request used gpt-guard-base. An open stream stayed on gpt-guard-spare. A second database session saw that rollback within 93 milliseconds.

A later hardening run recorded a different pass. Detection took 11.629 milliseconds. The stored figure is 11.629000000000815. The stop took 3.706 milliseconds. The stored figure is 3.705832999999984. A second session saw the stopped rollout in 60.103 milliseconds. The stored figure is 60.103290999999444. The [operations](operations.md) page uses the first pass.

## Routing hardening

The full suite passed 730 tests and skipped 5. It passed 70 files and skipped 3. The duration was 699.28 seconds. The exit was 0. Three proxy processes used one PostgreSQL 16 database and mock providers. The table is the hardening cases inside that run.

| Item | Value | Meaning |
| --- | --- | --- |
| Routing CPU | 0.62 seconds | Sum of `ps` CPU across three processes during 12 sequential chats. The stored figure is 0.6199999999999999. This is whole-process CPU. |
| Rank P50 / P95 / P99 | 2 / 6 / 8 ms | Nearest-rank percentile of 34 stored `computation_ms` values. The clock is wall time. |
| Client chat P50 | 74.196 ms | 12 sequential chats, including the mock provider. The stored figure is 74.19583300000158. |
| Added inference latency P50 / P95 | 70.196 / 76.370 ms | Client wall time minus stored `model_attempts.duration_ms` for the same 12 requests. The stored figures are 70.19583300000158 and 76.36962499999936. |
| Evidence-cache hit rate | 0.7352941176470589 | 25 cache-hit rows divided by 34 stored rankings for this tenant since the test clock mark. |
| Policy lookup | 68.559 ms | Client-observed GET. The stored figure is 68.5590000000011. |
| Locks not granted | 0 | Maximum ungranted `pg_locks` across 47 samples while 4 delayed chats overlapped. The maximum lock count in those samples was 127. Deadlocks stayed 0. |
| Memory | 156448, 156032, 158640 KiB | Resident set of the three processes after the burst. |
| Throughput | 13.300 requests per second | 12 sequential chats divided by their wall time. The stored figure is 13.300310391671147. |
| Active streams | 1, then 0 | Attempts with `stream_status` `connecting` or `streaming` while one stream was held, then after release. |
| Canary split | 2 baseline, 2 canary | Cover before promotion. |
| Success rate | 1 | The 12 sequential chats. |
| Stored cost | base 0.75 over 5 attempts; quality 1.56 over 26 attempts | Unit amounts 0.15 and 0.06. |
| Realized savings | 0.09 per success | Difference of those stored unit amounts. |
| Predicted savings | not realized | The shadow estimate on this run was null. |

## How to read the figures

`GET /internal/v1/metrics/summary` does not store a routing P99. `computation_ms` is wall-clock rank time. Added inference latency includes routing, admission, and the HTTP round trip. The evidence cache is per process. The active-stream count is the number of attempts in `connecting` or `streaming`. A lock can start and end between samples. Policy lookup time includes the HTTP round trip. The 12-chat throughput is sequential. Shadow `estimatedSavings` is an estimate. Do not read 0.09 as a forecast.
