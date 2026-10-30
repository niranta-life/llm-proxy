# Slice 08A implementation plan

Parent commit: 10aaae13852dcbb661a05b9acbc7f7dc41cc2dad. The commit that adds this file is the Slice 08A commit. Read it with `git rev-parse HEAD`. This file does not store that id.

## Scope

Store immutable routing-policy versions, activation history, and one decision row per production chat. Do not change which deployment runs. Do not add a provider adapter. Do not change the chat response. Stop after this slice. Canary and active selection stay absent.

## Behavior

`POST /internal/v1/routing/policies` inserts one policy, version 1, a draft activation at epoch 1, and one activation event. The version row is insert-only. The same idempotency key and the same body return the stored version. A different body for that key conflicts. A second policy with the same name conflicts.

Validation rejects an unknown alias, a missing baseline, a disabled deployment, and a candidate the caller cannot see. A candidate that belongs to another tenant is invisible under row-level security, so the call rejects it as not in this tenant. The stored row does not keep that foreign id.

Status moves only from draft to validated, from validated to shadow, from validated to disabled, and from shadow to disabled. The writer sends `expectedEpoch`. A stale epoch conflicts. One shadow activation is allowed for the alias `auto` in a tenant. `POST /internal/v1/routing/policies/{id}/status` exists because the five named routes cannot reach shadow or disabled, and the decision trace requires shadow.

`model=auto` still resolves through `model_aliases`. The decision is written from that route in the same transaction as the request row. The trace is not passed back into selection. A named deployment records `bypass` and skips the policy. With no shadow activation, the decision is `static`. With a shadow activation, the decision is `shadow` and the selected deployment is still the alias baseline. No extra provider call is made.

`routing:admin` covers create, validate, and status. `routing:read` covers list, get, and the decision read. A chat secret without those grants can still call chat. The grants live on `tenant_key_grants`. Chat does not read them.

## Database

`migrations/026_routing_policies.sql` is the only new migration. Migrations 001 through 025 stay byte-for-byte. The new tables use tenant-scoped foreign keys, row-level security, and forced row-level security. `llm_runtime` can insert the routing rows and can update only the activation status, epoch, version id, and timestamp. It cannot delete those rows and cannot read `tenant_key_grants`.

## Release

No shadow row is the default. Existing alias and fallback routing stay in force. Rollback leaves `026_routing_policies.sql` applied and moves every shadow policy to disabled, or leaves shadow unset. `model=auto` then stays on the alias baseline.

## Proof

`test/routing-policy.test.ts` drives the HTTP routes on PostgreSQL 16 and a mock provider. The full `npm test` run after the change exited 0. See `routing-policy-tests.txt`, `regression-before.txt`, and `regression-after.txt`.
