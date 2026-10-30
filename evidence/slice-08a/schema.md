# Schema and migrations

`migrations/026_routing_policies.sql` sha256 `e61b6e1ae7a93fa31632c7c31fbe1e8acb75741dbd9f6f97a2db3117099f098a`.

Migrations 001 through 025 match the parent commit byte for byte. `git diff` on those files is empty. The new file does not contain `DROP COLUMN`, `DROP TABLE`, or `DROP CONSTRAINT`.

## Added

`tenant_api_keys` gains `UNIQUE (tenant_id, id)` so a composite foreign key is legal. Existing key ids stay unique because `id` is already the primary key.

`tenant_key_grants` stores `routing:read` and `routing:admin` for one tenant key. `llm_runtime` has no privilege on this table. `key_routing_permissions(uuid, uuid)` is granted to `llm_auth`. `grant_routing_permission(uuid, uuid, text)` is granted to `llm_migrator`.

`routing_policies` binds one name to one tenant and the alias `auto`.

`routing_policy_versions` stores the baseline deployment, one to eight candidate deployments, the pass-rate floor, the valid-pair floor, the cost ceiling, the latency ceiling, the task segments, the configuration digest, the idempotency key, and the request hash. A before-insert trigger checks that the alias exists and that the baseline and the candidates are enabled deployments on an enabled connection for that tenant.

`routing_policy_activations` stores the current status and epoch. A partial unique index allows one `shadow` row per tenant and alias. The update trigger accepts only draft to validated, validated to shadow, validated to disabled, and shadow to disabled, and it requires the epoch to increase by one.

`routing_policy_activation_events` stores each status change. The row is insert-only.

`routing_decisions` stores one row per production chat. Columns are the tenant, the request id, the alias, the baseline deployment, the selected deployment, the policy version, the activation epoch, the feature-extractor version, the routing mode, and the reason codes. There is no prompt column and no response column. `bypass` leaves the alias, the baseline, the policy, and the epoch null. `static` requires the alias `auto` and a baseline, and leaves the policy and the epoch null. `shadow` requires all of those fields.

Each new tenant table enables row-level security and forces it. The policy compares `tenant_id` to `app.tenant_id`.

## Unchanged

`model_deployments`, `model_aliases`, `tenants`, and `proxy_requests` are referenced. They are not copied. Alias resolution and fallback policy stay in the existing tables.
