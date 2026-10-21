# Provider registry plan

Migrations 003 through 007 already store one connection per provider and tenant.
The credential is AES-GCM ciphertext.
A deployment stores the existing capability list and a configuration version.
The operator CLI registers, lists, enables, and disables OpenAI and Anthropic.
Chat calls only those two adapters.

This slice adds columns on `provider_connections` and `model_deployments`.
It does not add a table.
It does not edit migrations 001 through 007.

Each connection gains an auth mode, a configuration version, a project, and a location.
Each deployment gains a validation status and a separate health status.
Existing OpenAI and Anthropic rows stay valid.
Their auth mode defaults to `api_key`.
Their validation status defaults to `unvalidated`.
Their health status defaults to `unknown`.

Vertex uses `service_account` auth.
Vertex requires a project and a location.
Vertex stores no endpoint and no service-account email.
xAI and OpenRouter use `api_key` auth.
They store no endpoint.
DGX uses `api_key` auth and one approved `https` endpoint.
That endpoint has no userinfo.
Its host is not a public provider host.
A chat caller cannot choose a provider URL.

The CLI checks these rules before the write.
The database checks the same rules.
A rejected write leaves no row.
A stored field change increments the configuration version.
A health change does not.
Validation does not change health.
The CLI can register, list, validate, enable, and disable each connection and deployment.

Catalog loading accepts the four new providers.
A chat for one of them fails closed before a request row and before an upstream call.
OpenAI and Anthropic stay on the current adapters.

Vertex key material may be longer than an API key and may contain spaces.
It is still stored as AES-GCM ciphertext.
An email identity is rejected before that write.
A resource name is rejected before that write.
A minified service-account key is accepted.

Rollback does not drop a column.
Image `llm-proxy:67979e9` stays ready while `007_stream_interrupted.sql` remains applied.
