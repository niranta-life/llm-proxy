# Production readiness

Parent commit: 6e8e22f93b2eb7fc84eef0d63db05cbb0340b16f. The commit that adds this file is the Slice 07F commit. Read it with `git rev-parse HEAD`. This file does not store that id.

## 1. Implemented functionality

An operator can enable, disable, and read one tenant-scoped evaluation schedule, and can start one run by hand. A tick selects a bounded set of approved samples. The decision records why the run starts or why it skips. Prioritization uses workload volume, coverage, evidence age, model or config or price version changes, quality regression, efficiency, estimated cost, and uncertainty. The same inputs produce the same selection. No scheduling step calls a model.

The worker reserves the estimate before a provider call. It rechecks the sample and the deployment immediately before dispatch. A failed recheck does not call the provider. A call that already left the worker is not sent again. Production capacity in hard mode is checked before a run is created. A full production slot skips the tick.

Drift is computed on read from rows stored at or before `asOf`. A completed scheduled run appears on the existing report and recommendation reads. Those reads do not change an alias or a fallback policy.

The scheduler is off unless `EVALUATION_SCHEDULE_TENANTS` names one tenant. The inference process does not tick. Live DGX evaluation stays off.

## 2. Actual API contracts

All of these routes use the tenant id and secret.

- `POST /internal/v1/evaluation-schedules` requires `Idempotency-Key`. The same key and the same body return HTTP 200. A different body for that key returns HTTP 409. A new schedule returns HTTP 201. A tenant that is not named returns HTTP 404.
- `POST /internal/v1/evaluation-schedules/disable` turns the schedule off.
- `POST /internal/v1/evaluation-schedules/tick` and `POST /internal/v1/evaluation-schedules/runs` require an empty body and `Idempotency-Key`. HTTP 201 means a new run. HTTP 200 means the stored decision.
- `GET /internal/v1/evaluation-schedules` returns `{ schedule }` or `{ schedule: null }`.
- `GET /internal/v1/evaluation-schedules/decisions` returns `{ decisions, nextCursor }`.
- `GET /internal/v1/evaluation-schedules/drift?asOf=` returns `{ asOf, statements, workloadMixChange, limits, historical: true }`.
- `POST /internal/v1/evaluation-controls` accepts `{ "killSwitch": true }` or `{ "killSwitch": false }`. Only the named schedule tenant can set it.

A decision has `id`, `kind`, `action`, `skipReason`, `reasonCodes`, `selectedSampleIds`, `runId`, `asOf`, and `fresh`. It has no prompt and no completion text.

## 3. Database changes

`025_evaluation_schedules.sql` adds `evaluation_controls`, `evaluation_schedules`, `evaluation_schedule_decisions`, and `evaluation_budget_reservations`. It adds `request_samples.deletion_hold`. It replaces `delete_request_sample`, `cleanup_sample_rows`, and `load_replay_sample_envelope`. Migrations 001 through 024 are byte-for-byte unchanged. The new file drops no column, table, or constraint. `sample_jobs` stays `expire_cleanup` only.

A sample that an evaluation item or attempt still references is wiped in place. The foreign key stays. Operator reads omit `deletion_hold` rows. The worker treats that sample as not owned.

## 4. End-to-end journey proof

The schedule test enables one synthetic tenant, ticks a new approved sample, reserves `0.01` USD before any provider call, replays through the existing worker, and reads the report. `routingChange` is false. Alias `auto` still points at `chat`. A second boot of `dist/index.js` with the schedule unset records `scheduler_disabled` and makes no provider call. With the tenant named, one tick creates one run. The same tick returns that run with `fresh: false`. Two worker drains record one provider call, then zero. Both report reads agree: `inconclusive`, `routingChange` false. See `schedule-launch.txt` and `scheduler-tests.txt`.

## 5. Test results

`test/evaluations-schedule.test.ts` on Node v24.22.1: 26 passed, exit 0. The cases cover new samples, no eligible samples, a budget that is too small, an exhausted judge budget, production capacity, model and price version changes, a new deployment, quality, latency, workload mix, stale evidence, a duplicate tick, a worker crash, a database outage, the kill switch, cancellation, revocation, expiry, deletion, two replicas, cross-tenant reads, no extra provider calls, no raw content, and no routing change. A duration of 2147483647 ms with a stored latency of 1 ms returns HTTP 201 and action `run`. A validator and a completion stored after `asOf` leave the historical statement comparable, with quality drift false and schema validity regression false.

`npm test` on Node v24.22.1: 623 passed, 5 skipped. Test files: 63 passed, 3 skipped. Exit 0. The new schedule cases are in that suite. See `regression.txt`.

## 6. Performance evidence

Synthetic workload, mock provider, in-process worker. Copied from the passing schedule run:

- Evaluation throughput: 26.253692409547572 completions per second. 8 completions.
- Evaluation backlog: 8 pending jobs at the tick.
- Worker memory: heapUsed 41591992, rss 221757440. This is the vitest process.
- PostgreSQL contention: locks 2 before and 6 after, waiting 0, deadlocks 0.
- Budget reservation overhead and scheduler overhead: 58.46087500000067 ms. Both values are the same tick.
- Cancellation latency: 28.849041999999827 ms. This is the separate cancel case in that run.
- Production inference latency: 45.153416999999536 ms before, 44.60462500000085 ms after.
- Evaluation cost per valid comparison: 0.012. Reserved amount `0.080000000000`. Valid pairs 8. Provider calls 8.
- Judge disagreement rate: null. The synthetic load does not call a judge.

## 7. Security verification

The operator JSON in the schedule test does not contain the prompt or the completion. A second tenant receives HTTP 404 for enable and for the kill switch, and empty schedule, decision, and recommendation pages. A provider call is counted only at the mock. Disabled, killed, expired, revoked, and deleted samples do not increase that count. A crash after dispatch does not send the call again. Ciphertext for a referenced deleted sample is replaced with zeros. The replay envelope function does not return a held sample.

## 8. Deployment and rollback

The scheduler is off by default. Compose does not set `EVALUATION_SCHEDULE_TENANTS` or `EVALUATION_GLOBAL_KILL`. Enable one synthetic tenant and a daily budget at most 1 USD. The image command is `node dist/index.js`. The image user is `node`. The image does not start the evaluation worker. Built image `sha256:55a1f4618c2205382e07a0f77c5cdfd2b215f8ec581ea24fd36d3141af5b4248`.

Rollback: stop the worker, leave `EVALUATION_SCHEDULE_TENANTS` empty, leave `EVALUATION_EXECUTION_ENABLED` false, and leave `025_evaluation_schedules.sql` applied. New ticks create no run. Existing evaluation rows stay. A reservation stays `reserved`. Readiness checks for `025_evaluation_schedules.sql`. The `024_evaluation_judgments.sql` row remains.

Live DGX evaluation stays off.

## 9. Limitations

One tick run is stored per tenant per UTC day. A skip stored for an idempotency key is returned again for that key. Cancellation does not refund the schedule reservation. The candidate scan is capped at 200. The workload scan is capped at 5000. Observe-mode concurrency does not block evaluation. Different rubrics or populations are not pooled. Historical drift counts a run when `created_at` and `updated_at` are at or before `asOf`. It counts a validator or an attempt only when that row was stored at or before `asOf`. A referenced sample remains as a wiped row so the foreign key can stay. The scheduler does not call a model and does not change a route. The per-run judge ceiling stays 1. Judging stays off unless one judge tenant is named.

## 10. Commit identifier

The commit identifier is `git rev-parse HEAD` after this file is committed. Parent: `6e8e22f93b2eb7fc84eef0d63db05cbb0340b16f`.
