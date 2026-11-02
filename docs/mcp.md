# MCP catalog

Back to [README](../README.md)

A tenant registers an approved MCP server, discovers its tools, and reads an authorized catalog. Discovery does not call a tool. A separate execution route calls one approved tool. This catalog is separate from [function tools](function-tools.md) on a chat. The proxy does not execute a chat function.

The page is `GET /internal/v1/mcp`. The title is `MCP catalog`. The page says that it does not call a tool. An approved execution calls one approved tool. The page shows the call, the permission, the approval, the failure, the latency, and the history.

## Where it fits

Nginx allows `/internal/` only for an approved client network. The HTML page does not check the tenant secret. Each JSON route checks `X-Tenant-Id` and the bearer token. Another tenant does not read the row.

Nginx rejects `/mcp` when `X-Tenant-Id` or `Authorization` is missing. Nginx forwards `/mcp` when both headers are present. `POST /mcp` serves MCP revision 2026-07-28 for an authenticated tenant. The server does not keep a protocol session. A GET does not open a session stream.

## Registration

`POST /internal/v1/mcp/servers` creates one server. The response status is HTTP 201.

The body has `serverKey`, `displayName`, `endpoint`, `credential`, and `protocolMode`. `enabled` is optional and defaults to false.

`serverKey` starts with a letter or digit. The rest uses letters, digits, or `-`. The key has at most 32 characters.

`displayName` has from 1 to 64 characters. It has no control character.

`protocolMode` is `modern` or `legacy`.

The response does not contain the credential. The credential is stored as a protected reference. The runtime role does not read that reference.

`POST /internal/v1/mcp/servers/{id}/credential` replaces that reference. The previous secret is not left readable.

A body that names `command`, `args`, `cwd`, `stdio`, or `transport` is rejected before a row is stored. The proxy does not launch a local executable.

## Endpoints

A remote endpoint uses `https`. `http` is accepted only for host `127.0.0.1` or `localhost`. That exception is the local mock.

The URL has no userinfo, no query, and no hash. The proxy resolves the host and rejects a private, link-local, or metadata address.

The client does not follow a redirect. A redirect is HTTP 502 `The endpoint redirected.`

## Connection and discovery

`POST /internal/v1/mcp/servers/{id}/test` checks the connection. `POST /internal/v1/mcp/servers/{id}/discover` reads the tool list and stores the catalog.

The modern path uses the official TypeScript MCP client over Streamable HTTP. That path speaks protocol version `2026-07-28`. Discovery calls `server/discover` and `tools/list`.

An explicitly marked legacy server uses the compatibility adapter. A protocol mismatch does not switch to SSE, stdio, or an older handshake. A mismatch is HTTP 409.

The client reads at most 8 pages. A cursor after that page is rejected. The catalog bound is 32 tools. Either bound is HTTP 400 `The catalog is too large.`

An unavailable server is HTTP 503. The stored connection status is `failed`.

## Tool definitions

Each remote name starts with a letter or digit. The rest uses letters, digits, `.`, `_`, or `-`. The name has at most 64 characters.

The stored name is `{serverKey}/{remoteName}`. That name has at most 97 characters. The same remote name on two servers stays two tools.

A description has at most 512 characters and no control character.

The input schema is an object with type `object`. The output schema is omitted, null, or an object with type `object`. Schema depth is at most 8. Schema size is at most 16384 bytes. Schema node count is at most 64.

A `$ref` must be a local fragment. The proxy does not fetch an external schema. A malformed schema is rejected. The catalog from that discovery is not stored.

A new tool is stored with `allowed` false. `POST /internal/v1/mcp/permissions` sets `allowed` for one `serverId` and one `remoteName`.

## Catalog and health

The stored catalog keeps the protocol version, `ttlMs`, `cacheScope`, a fingerprint, and a cache age. `cacheScope` is `public` or `private`.

A later discovery writes a new version only when the fingerprint changes. An unchanged catalog reports `changed` false and refreshes the cache time.

`GET /internal/v1/mcp/servers/{id}/tools` reads the stored tools for one server.

`GET /internal/v1/mcp/catalog` reads the exposed catalog. A server must be enabled. A tool must be allowed. A disabled server is omitted. A tool is omitted until the tenant allows it.

`POST /internal/v1/mcp/servers/{id}/enabled` sets `enabled` to true or false.

`GET /internal/v1/mcp/servers/{id}/health` reads the connection status, the protocol version, the fingerprint, the cache age, and the last error. The body has no credential.

`GET /internal/v1/mcp/servers` lists the caller's servers. The list has no credential.

## Governed execution

`POST /internal/v1/mcp/executions` calls one approved tool. The body names `serverId`, `remoteName`, `schemaVersion`, `requestId`, `toolCallId`, and `arguments`.

The server must be enabled, modern, protocol `2026-07-28`, and connected. The credential must be active. The tool must be allowed. `schemaVersion` must be the stored catalog version. The arguments must match the stored object schema.

`POST /internal/v1/mcp/permissions` can set `effect` to `read` or `write`. A read runs after the checks. A write returns HTTP 202 and waits for approval. Write approval stays required.

`POST /internal/v1/mcp/executions/{id}/approval` accepts `grant`, `deny`, or `cancel` with the execution identity. Denial and cancellation do not call the tool. A grant calls the tool once. A second grant does not call it again.

A duplicate request with the same `requestId` and `toolCallId` returns the stored row. It does not call the tool again. A different argument or tool on that pair is rejected.

`GET /internal/v1/mcp/policy` reads the limits. `POST /internal/v1/mcp/policy` stores concurrency, timeout, cost, loop depth, identity lifetime, and whether a follow-up is allowed. The follow-up stays off until that policy is on.

A timeout or a stop after dispatch stores an uncertain outcome. `POST /internal/v1/mcp/executions/recover` marks a stale dispatch uncertain. The proxy does not retry that call.

`POST /internal/v1/mcp/executions/{id}/submit` accepts the result for the caller. `runMode` must be `continue` and the policy must allow one follow-up. The route records one model request. It does not call a provider. Without that mode, no model request is recorded.

`POST /internal/v1/mcp/servers/{id}/revoke` revokes the server credential. A later call is refused. The response does not contain the credential.

Retained arguments and results are encrypted. The history does not return the credential, the execution identity, or the ciphertext. The runtime role does not read the ciphertext.

A tool description is stored text. It does not add a call. The dispatched name is the approved remote name.

## What discovery does not do

Discovery does not send `tools/call`. A connection test does not send `tools/call`.

The proxy does not execute a discovered tool that is not approved. The proxy does not put a discovered tool on a chat request. The proxy does not execute an arbitrary function.

## Related

- [Function tools](function-tools.md)
- [Operations](operations.md)
- [Architecture](architecture.md)
- [Tenants](tenants.md)
