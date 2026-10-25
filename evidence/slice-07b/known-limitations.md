# Known limitations

This slice does not score quality. It does not call a judge. It does not rank outputs.

The optional live-provider smoke was not run. `OPENAI_LIVE` was unset. The regression suite uses the mock provider.

`EVALUATION_EXECUTION_ENABLED=true` does not call a model by itself. The tenant id must be in `EVALUATION_REPLAY_TENANTS`. The job kind must be `replay`. Other tenants stay off.

A crash after dispatch stores the attempt as `uncertain`. The worker does not send that provider call again.

A kill switch that flips after a job is claimed fails that item with `kill_switch`. Jobs that are still queued stay queued. Later polls do not claim them while execution is false.

Replay reads breaker admission. It does not claim a production probe and it does not change the breaker row. It does not call `noteUpstream`. A replay timeout does not open the production circuit breaker. The worker still refuses an unhealthy deployment and a breaker that is open inside its cooldown. A half-open breaker with a free probe slot does not block replay. Production keeps that slot.

The queue is PostgreSQL. This slice does not add Redis.

`model=auto` is not used for evaluation execution. A production chat still follows the existing alias.

An OpenAI connection must keep `location` null. That rule is migration 009. The residency rejection in the test uses a sample source location and a null connection location.

A cancel request that sets `Content-Type: application/json` must send a JSON body. An empty body is rejected by the HTTP server before the evaluation route.

The dirty worktree still has unfinished files that are not part of this commit. Those files include the GKE shutdown tests, the CLI stdin tests, and the timeout fields in `src/config.ts`. This slice does not implement that work.
