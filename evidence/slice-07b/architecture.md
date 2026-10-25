# Slice 07B architecture

The worker replays one approved sample against one pinned challenger deployment. It records encrypted output, cost, latency, usage, and status. It does not score quality.

A run snapshot is `dry_run` with `modelExecution` `off`, or `replay` with `modelExecution` `pinned`. Dry-run rows from Slice 07A still load. The snapshot does not store a prompt, a message, content, or ciphertext.

The worker uses the authorized tenant context. Before each provider call it rechecks sample expiry, tenant ownership, replay permission, target approval, capability compatibility, residency, budget, rate and concurrency limits, and deployment health. A failed check marks that item failed. It does not call the provider. An unsupported semantic conversion is rejected. Tools are not executed.

The challenger is one deployment. The worker does not resolve aliases. It does not use `model=auto`. It does not call `executeChat`. It does not call `POST /v1/chat/completions`. It calls the existing provider adapter. It reads breaker admission. It does not claim a production probe and it does not change the breaker row. It does not call `noteUpstream`. A replay timeout does not open the production breaker.

The worker writes the attempt row before the cost reservation. It writes the reservation before the provider call. It marks the attempt dispatched only after that reservation. A crash before dispatch does not call the provider. A crash after dispatch stores `uncertain` and does not send the call again. Finish is idempotent on the attempt id. A duplicate job does not complete the item again and does not record the cost again.

Challenger output uses the existing tenant-scoped sample encryption. The attempt id is the sample id in the additional data. Operator JSON has cost, latency, usage, and status. Logs name the attempt, the item, the status, the reason, and the model-call count. They do not contain prompt or completion text.

`proxy_requests.traffic_class` is `production` or `evaluation`. A production insert stays `production`. A replay insert is `evaluation`. Active routing policies stay unchanged.

`EVALUATION_EXECUTION_ENABLED` defaults to false. `EVALUATION_REPLAY_TENANTS` defaults to empty. A replay call runs only when execution is true, the tenant id is listed, and the job kind is `replay`. Dry-run does not call a model. The inference process does not start the worker. `src/index.ts` does not name `evaluation-worker`. The image command stays `node dist/index.js`. The worker command is `node dist/evaluation-worker.js`.

Migration `022_evaluation_replay.sql` is additive. It widens the evaluation checks. It adds `evaluation_attempts` and `traffic_class`. It drops no table and no column. Migrations `001` through `021` are unchanged. Rollback stops the worker, leaves execution unset or false, leaves the tenant list empty, and leaves `022` applied. Readiness for `021_evaluation_orchestration.sql` and `020_stream_samples.sql` still finds those rows.

This slice does not rank outputs and does not call a judge.
