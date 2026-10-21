# Slice 04B implementation plan

The Node 24 suite passed before this slice.
The result is 21 files and 116 tests.
The exit code is 0.

## Adapter changes

The catalog selects the Vertex project, location, auth mode, approved identity, API version, and connection config version.
`connectionVersion` stays the credential version.
A chat caller still cannot choose a project, an identity, or a URL.

`@google/genai` is pinned at 2.30.0.
The client sets `vertexai: true` and passes the stored project, location, and API version.
The stable API version is `v1`.
An operator can store `v1beta1` for a model that needs it.
The SDK default is `v1beta1`, so the proxy does not leave the version unset.
The request sets the location host itself.
`GOOGLE_VERTEX_BASE_URL` cannot redirect that tenant.
The request does not write `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, or a credential path.

Auth modes are `service_account`, `adc`, `workload_identity`, and `impersonation`.
An existing service-account row stays valid.
ADC, workload identity, and impersonation store no key.
Impersonation requires one approved identity.
The client cache key is the tenant, connection, identity, config version, credential version, API version, auth mode, project, and location.
A token inside 60 seconds of expiry is minted again.
HTTP 401 drops that cache entry.
The proxy does not call `gcloud` on a request.

Text conversion is a pure function.
It keeps user and assistant order.
It maps one leading system instruction, max output tokens, temperature, and stop sequences.
It rejects every other field.
Thinking text is not returned.
Cached tokens stay inside the prompt count.
Thinking tokens are stored on the attempt and are not added to the visible output count.
`totalTokenCount` is kept when Vertex sends it.

Streaming reads `generateContentStream` and writes the existing SSE frames.
A failed or cancelled stream does not emit `[DONE]`.
The proxy does not retry after the stream starts.

Migration `009_vertex_provider.sql` is additive.
Migrations 001 through 008 are unchanged.
xAI, OpenRouter, and DGX still do not serve chat.
Vertex chat stays off until an operator enables that deployment.

A live Vertex call runs only when `VERTEX_LIVE` is `1`.
