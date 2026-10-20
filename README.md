# llm-proxy

Slice 00 is the service foundation for a multi-tenant Node.js LLM proxy. It checks tenant credentials, isolates tenant rows in PostgreSQL, and reports health. It does not call a model.

## Run locally

Docker Compose starts PostgreSQL 16 and the service on Node.js 24.

```bash
docker compose up --build
```

- Liveness: `GET http://127.0.0.1:8080/health/live`
- Readiness: `GET http://127.0.0.1:8080/health/ready`

Readiness is HTTP 200 `{"status":"ready","database":"ready"}` only after PostgreSQL is reachable and the migrations have been applied. If PostgreSQL is down, readiness is HTTP 503 and liveness stays HTTP 200.

The Compose database role passwords are local development values. Reset them by recreating the volume:

```bash
docker compose down -v
```

## Provision a tenant

The CLI prints a tenant secret once on standard output. Logs go to standard error. The database stores only a scrypt verifier.

```bash
docker compose run --rm app node dist/cli.js provision-tenant --name Acme
docker compose run --rm app node dist/cli.js add-key --tenant-id <tenant-id> --label backup
docker compose run --rm app node dist/cli.js revoke-key --tenant-id <tenant-id> --key-id <key-id>
```

A tenant can have more than one active key. Revoking one key leaves the other active keys working.

## Tenant API

Every tenant request needs both headers:

```http
X-Tenant-ID: <tenant-uuid>
Authorization: Bearer <tenant-secret>
```

`GET /v1/tenant` returns that tenant's id, name, and key ids. It does not return secrets or verifiers. Missing, malformed, unknown, mismatched, and revoked credentials get HTTP 401 `{"error":"unauthorized"}`.

There is no login, session, OAuth, user account, or model route.

## Configuration

The process exits before it listens when any required setting is missing or invalid.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_HOST` | yes | PostgreSQL host |
| `DATABASE_PORT` | yes | PostgreSQL port |
| `DATABASE_NAME` | yes | Database name |
| `MIGRATOR_USER` | yes | Must be `llm_migrator` |
| `MIGRATOR_PASSWORD` | yes | Migration role password |
| `AUTH_USER` | yes | Must be `llm_auth` |
| `AUTH_PASSWORD` | yes | Authentication role password |
| `RUNTIME_USER` | yes | Must be `llm_runtime` |
| `RUNTIME_PASSWORD` | yes | Runtime role password |
| `HOST` | no | Listen address, default `0.0.0.0` |
| `PORT` | no | Listen port, default `8080` |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error` |

`SIGTERM` stops new work, closes the database pools, and exits.

## Tests

Tests need Node.js 24 and a running Docker daemon. They start real PostgreSQL with Testcontainers. The host default Node is not used. The suite uses the active `docker context` endpoint when `DOCKER_HOST` is unset.

```bash
nvm use 24
npm test
```

## Assumptions

- This directory is the service repository. The workspace root is not the git root.
- Verifiers are Node.js `crypto.scrypt` with `N=16384`, `r=8`, and `p=1`. A native hashing package is not used, so the Node.js 24 image does not need a compiler.
- Tenant secrets are 32 random bytes, prefixed with `yck_`, and shown once. The database check constraint rejects a raw secret as a verifier.
- `llm_owner` is a `NOLOGIN` role with `BYPASSRLS` and `CREATE` on schema `public`. It owns the tables and the security-definer functions. Application connections use only `llm_migrator`, `llm_auth`, and `llm_runtime`. Those three roles are not superusers and cannot bypass row level security.
- `llm_migrator` is a member of `llm_owner` so it can assign ownership during migrations, and it is `NOINHERIT`. A holder of the migration password can `SET ROLE llm_owner`. The request path never uses that role.
- The authentication role may execute only `list_active_key_verifiers`. The runtime role may read tenant rows under row level security and may not read the verifier column.
- Tenant context is `set_config('app.tenant_id', ..., true)` inside a transaction. The setting ends when the transaction ends, before the connection returns to the pool.
- Row level security is forced. With no tenant setting, policies match no rows.
- Migrations are forward-only SQL files in `migrations/`, applied in lexical order and recorded in `schema_migrations`. A second run skips applied files and does not delete rows. Do not edit a file after it has been applied.
- Role creation is separate from migrations. Compose runs `docker/postgres/init.sh` as the database superuser. Tests apply the same attributes through `bootstrapRoles`.
- The service migrates on startup, then listens. A later database outage does not exit the process. Readiness fails and liveness stays up.
- Logs are one JSON object per line. Redaction strips bearer tokens, `yck_` secrets, scrypt verifiers, and fields whose names look like secrets.
- Local Compose passwords are development-only.
- PostgreSQL 16 is the local database image. The major version is not a product requirement beyond row level security support.
- The ASD-STE100 dictionary is not in this environment. The commit subject follows the public style rules for this slice: one active imperative sentence, at most 20 words, American spelling, no semicolon, and no noun cluster longer than three words.

## Limitations

- Model inference is not implemented. The service has no provider client and no completion route.
- There is no rate limit, billing, usage meter, audit product, Kubernetes manifest, CI pipeline, or hosted deployment.
- Provisioning is a command line tool for the migration role. There is no HTTP admin API.
- Database role passwords come from the environment. There is no external secret manager and no TLS termination in this slice.
- Authentication spends scrypt time on each presented secret. Unknown tenants pay one dummy scrypt so an empty key list is harder to time. This is not a formal constant-time proof across every failure branch.
- The authentication function returns verifiers to the authentication role so the application can compare them. Verifiers are not reversible and are not logged.
- A person who holds the migration password can assume `llm_owner` and bypass row level security. Protect that password as an administrative credential.
- Compose init scripts run only when the database volume is empty.

## Unfinished items

- LLM inference, streaming, prompt routes, and provider configuration.
- OAuth, login, sessions, and user accounts.
- Key revocation through HTTP. Revocation is command line only.
- Production management of database role passwords.
- Later-slice features such as billing, rate limits, and usage metering.
