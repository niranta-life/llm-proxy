# Schema and migrations

`migrations/026_routing_policies.sql` sha256 `e61b6e1ae7a93fa31632c7c31fbe1e8acb75741dbd9f6f97a2db3117099f098a`.

`migrations/027_evidence_qualification.sql` sha256 `1cdf7dc07e50feee159c9200bf5727cb50368387ad565e6588facda4410f1116`.

Migrations 001 through 026 stay byte-for-byte. The new file adds a unique constraint on `evaluation_profile_versions (tenant_id, id)`. It does not contain `DROP COLUMN`, `DROP TABLE`, or `DROP CONSTRAINT`.

## Added

`qualification_profiles` binds one name to one tenant.

`qualification_profile_versions` stores version 1 of that profile. The row names the task category, the complexity, the input-size category, the approved evaluation profile version, the required capabilities, the candidate deployment, the model version, the deployment config version, the adapter version, and the numeric gates. A later write does not edit the row.

`evidence_snapshots` stores one insert-only snapshot. It names the profile version and the source evaluation run ids. It has no prompt column and no completion column.

`evidence_candidate_assessments` stores the status, the reason codes, the Wilson bounds, the Newcombe difference bound, the matched sample count, and the coverage rate.

A before-update-or-delete trigger rejects a change to any of these four tables. Each table enables row-level security and forces it. `llm_runtime` can select and insert. It cannot update or delete.

## Unchanged

Alias resolution, fallback, and the chat path do not read these tables. `eligible_for_canary` stays a report label.
