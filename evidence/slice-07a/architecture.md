# Slice 07A architecture

The proxy stores evaluation definitions, definition versions, runs, items, and dry-run jobs in PostgreSQL.

Every row has a tenant id. Foreign keys include the tenant id. Row level security is enabled and forced. `llm_runtime` can select and insert. It can update only the listed status and counter columns. It does not receive table-level update. The code uses a transaction advisory lock. It does not use `SELECT FOR UPDATE` or `INSERT ... ON CONFLICT` on these tables.

A run stores an execution snapshot at create time. A trigger rejects a later change to that snapshot and to a definition version. The snapshot mode is `dry_run`. The snapshot has `modelExecution` set to `off`. The snapshot does not store a prompt, a message, content, or ciphertext.

Run status is one of `created`, `preflight`, `queued`, `running`, `completed`, `completed_partial`, `cancel_requested`, `cancelled`, and `failed`. The same status is idempotent. An illegal status change returns 409 `illegal_transition`. Item status is `pending`, `queued`, `running`, `completed`, `cancelled`, or `failed`.

Create checks the plan, then stores the run. A failed check stores nothing. The same idempotency key and the same request hash return the stored run with HTTP 200. The same key and a different hash return HTTP 409. The body is the OpenAI envelope. The parameter is `Idempotency-Key`. The code is `idempotency_conflict`. That second request does not store another run.

Preflight checks ownership, category, expiry, completeness, replay permission, deployment approval, provider allow-list, residency, capabilities, judge disclosure when a judge is set, the hard budget, and the run and item caps. The sample read selects metadata only. It does not select ciphertext. It does not call a provider.

The HTTP routes are:

- `POST /internal/v1/evaluations/preflight`
- `POST /internal/v1/evaluations`
- `GET /internal/v1/evaluations`
- `GET /internal/v1/evaluations/{id}`
- `GET /internal/v1/evaluations/{id}/items`
- `POST /internal/v1/evaluations/{id}/cancel`

Auth is `X-Tenant-ID` and `Authorization: Bearer <tenant-secret>`. A list uses a cursor. The body limit is 65536 bytes. Evaluation errors use the OpenAI envelope `{ error: { message, type, param, code } }`.

The inference process does not start the evaluation worker. `src/index.ts` does not name `evaluation-worker`. The image command stays `node dist/index.js`. The worker command is `node dist/evaluation-worker.js`.

`EVALUATION_EXECUTION_ENABLED` defaults to false. The worker advances an item only when `EVALUATION_DRY_RUN` is true. That path changes item state. It does not call a model. `EVALUATION_WORKER_DRAIN=true` makes the worker exit when the queue is idle. `SIGTERM` stops new claims. A leased job stays recoverable.

Migration `021_evaluation_orchestration.sql` is additive. Migrations `001` through `020` are unchanged. Rollback stops the worker and leaves `021` applied. Readiness for `020_stream_samples.sql` still finds that version row.

This slice does not replay a sample through a model.
