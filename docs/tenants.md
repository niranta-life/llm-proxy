# Tenants

Back to [README](../README.md)

## Where it fits

This page covers steps 1 and 5, the tenant key and the per-tenant limits. See the [request path](architecture.md#request-path).

[llm-proxy](../README.md) checks a tenant on every tenant request. There is no login and no user account.

Send these two headers:

```http
X-Tenant-ID: <tenant-uuid>
Authorization: Bearer <tenant-secret>
```

The secret is 32 random bytes with the prefix `yck_`. The CLI prints it once, on standard output. Logs go to standard error. The database stores a scrypt verifier, not the secret. You cannot rebuild the secret from the verifier.

The verifier uses Node.js `crypto.scrypt` with `N=16384`, `r=8`, and `p=1`. The proxy does not use a native package for this check. For an unknown tenant, it still runs one dummy scrypt so an empty key list is not much faster than a list that has keys. That step is not a constant-time proof.

## Keys

```bash
docker compose run --rm app node dist/cli.js provision-tenant --name Acme
docker compose run --rm app node dist/cli.js add-key --tenant-id <tenant-id> --label backup
docker compose run --rm app node dist/cli.js revoke-key --tenant-id <tenant-id> --key-id <key-id>
```

A tenant can have more than one key that is not revoked. Revoking one key leaves the others working. There is no HTTP route that revokes a key.

`GET /v1/tenant` returns the tenant id, the name, and every key with its id, label, `createdAt`, and `revokedAt`. A revoked key stays in the list with a `revokedAt` time. It does not return the secret or the verifier.

A bad secret on that route is HTTP 401:

```json
{"error":"unauthorized"}
```

A secret has the form `yck_` plus base64url text, at least 40 characters in all. `X-Tenant-ID` must be a UUID. The 401 covers a missing header, a secret with the wrong form, an unknown secret, a secret for another tenant, and a revoked key. A chat call uses the OpenAI error object instead, with code `invalid_api_key`. See [Chat](chat.md).

## Limits

Step 5 uses the limits and the budget that you store per tenant, per key, per connection, and per deployment. The commands are `set-tenant-limits`, `set-api-key-limits`, `set-connection-limit`, `set-deployment-limit`, and `set-tenant-budget`. A hard rejection is HTTP 429. See [Limits and budgets](limits.md).

Streaming is off for a tenant until you run `set-tenant-streaming`. See [Streaming](streaming.md).

## Isolation

PostgreSQL row-level security lets a tenant read only its own rows. The proxy sets `app.tenant_id` inside a transaction and clears it when the transaction ends. If `app.tenant_id` is absent, a policy matches no rows.

The runtime role cannot read the verifier column or the provider ciphertext. How the database roles work is in [Operations](operations.md).

## Related

- [Chat](chat.md)
- [Providers](providers.md)
- [Operations](operations.md)
- [Limits and budgets](limits.md)
- [Streaming](streaming.md)
