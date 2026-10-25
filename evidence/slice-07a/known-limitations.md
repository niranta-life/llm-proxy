# Known limitations

The worker does not call a model. It does not replay a sample. It does not score a judge. It does not rank outputs.

`EVALUATION_EXECUTION_ENABLED=true` does not start a provider call in this slice. The dry-run flag is the only switch that advances item state.

The queue is PostgreSQL. This slice does not add Redis.

An OpenAI connection must keep `location` null. That rule is migration 009. The residency rejection in the test uses a sample source location and a null connection location.

A cancel request that sets `Content-Type: application/json` must send a JSON body. An empty body is rejected by the HTTP server before the evaluation route.

Two sessions that insert the same idempotency key at the same time can receive a unique-constraint error. A repeated request after the first commit returns the stored run.

The worker locks the run before the item. Cancel locks the run before the items. Those two operations do not deadlock.

The dirty worktree still has unfinished files that are not part of this commit. Those files include the GKE shutdown tests and the CLI stdin tests. This slice does not implement that work.
