Production readiness.

Result.
The shipped chat route enforced the stored policies together in the full Node 24 suite.
That suite exited 0.
309 tests passed.
3 live provider tests stayed skipped.
No live provider call was made.

What passed.
Each named provider fault stored the existing failure class and the existing public status.
A denied path made no further upstream call.
Two tenants kept separate credentials, deployment names, budgets, rate limits, and attempt history.
Two processes shared one database for budget admission, rate limit, concurrency lease, and breaker state.
A crashed process settled a finished attempt once.
A later request proceeded after the lease expired.
One request made at most two upstream attempts.
Retry and fallback can be turned off for one tenant without changing the other.
A named deployment did not switch.
Shutdown stored interrupted.
A later request during shutdown returned shutting_down and made no new upstream call.

What this does not prove.
This is not a production traffic sample.
The latency numbers are the Rel Measure workload inside the test process.
Memory is that process.
The database-unavailable check is an advisory lock while PostgreSQL is up.
Provider overload is HTTP 529 stored as upstream_error.
The metrics route does not store P99.
Image build output is docker-build.txt.
This report does not claim a readiness HTTP status.

Rollback.
Migrations 001 through 016 are unchanged.
No later migration was added.
The image fb62fa7 stays the prior compatible image.
Retry and fallback turn off through the existing CLI.
Do not delete a policy row or a migration row.
