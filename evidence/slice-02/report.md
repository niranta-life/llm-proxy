# Slice 02 report

## 1. Changes made

The proxy now selects OpenAI or Anthropic from the tenant deployment. Callers still use `POST /v1/chat/completions` and the OpenAI SDK. `004_anthropic.sql` adds nullable registry and telemetry columns on the existing tables. The Anthropic adapter calls the official Messages API once. OpenAI behavior stays on the same adapter contract.

## 2. Adapter contract

`ProviderAdapter.prepare` validates provider-specific semantics. `ProviderAdapter.execute` makes one call with the decrypted key, base URL, canonical text request, route, and caller abort signal. The OpenAI adapter prepares nothing and executes the existing completion path. The router picks the adapter from `provider`. It does not fall back and it does not replace an explicit deployment name.

## 3. Supported and unsupported API features

Supported on Anthropic: model, text messages, one leading system message, `max_completion_tokens` or `max_tokens`, temperature from 0 through 1, stop sequences, and the configured default max output tokens. Unsupported values are rejected before the upstream call: streaming, tools, multimodal content, non-text response formats, a system message that is not leading, developer messages, assistant prefill, and sampling fields Anthropic cannot represent. OpenAI keeps the fields it already accepted. Finish reasons map `end_turn` and `stop_sequence` to `stop`, and `max_tokens` and `model_context_window_exceeded` to `length`. Refusal text is returned as `content_filter`.

## 4. Database migrations

`004_anthropic.sql` is additive. It allows `provider` `anthropic`, adds `endpoint`, `workspace_id`, `default_max_output_tokens`, `provider_request_id`, `stop_reason`, and three cache-token columns, and adds registry functions. It does not update existing data rows. `003_inference.sql` stays applied, so the previous image can become ready.

## 5. Test evidence and failures

`npm test` on Node.js 24 passed: 15 files, 65 tests, exit 0. See `vitest.txt`, `unit-tests.txt`, `integration-tests.txt`, and `openai-sdk-contract.txt`. There were no failing tests. The repository has no lint script, so lint was not run.

A rejected Anthropic tool-use message still returns `invalid_upstream_response`. The stored attempt in `rollback.txt` has provider request id `msg_tool`, stop reason `tool_use`, prompt tokens 1, completion tokens 1, and total tokens 2. Uncached input tokens are 1. The cache columns are empty. The public body does not contain the block. An HTTP 500 `not_found_error` with `request-id: req_abc` is stored as `not_found_error` and `req_abc`. A 5xx response with no type and no request id stores null for both. The proxy does not store `api_error` unless the provider sent that type.

## 6. End-to-end journey verification

A fresh PostgreSQL 16 database migrated through `004_anthropic.sql`. Image `sha256:616db9bd9c30810d4c786d91ea1b4e8f6a7f9d0a2d953935ce14c8d2a9cfc828` returned an OpenAI chat completion and an Anthropic chat completion for one tenant. The Anthropic mock received `POST /v1/messages` with `max_tokens` 64. HTTP 429 became `rate_limit` and stored `rate_limit_error` with a null provider request id. A tool-use message became `invalid_upstream_response` and the attempt stored `msg_tool`, `tool_use`, and tokens 1, 1, and 2. An HTTP 500 `not_found_error` with `request-id: req_abc` stored `req_abc` and `not_found_error` with null token counts. The public bodies did not include those ids. The same database then served the Slice 01 image: readiness stayed 200 and the OpenAI deployment still returned `gpt-rollback`. Starting the Slice 02 image again returned the Anthropic completion. The mock recorded two OpenAI calls and five Anthropic calls, one for each accepted request. See `rollback.txt`.

## 7. Performance and compatibility observations

The full suite finished in about 47 seconds. The Slice 02 image rebuild finished in about 55 seconds. Image id `sha256:616db9bd9c30810d4c786d91ea1b4e8f6a7f9d0a2d953935ce14c8d2a9cfc828`. No new service was added. `OPENAI_BASE_URL` is still the OpenAI base URL. Anthropic uses the connection endpoint. Existing OpenAI tests passed in the same suite.

## 8. Docker deployment instructions

Build and start with the existing Compose project. Inference stays off until `INFERENCE_ENABLED=true`. Set `PROVIDER_CREDENTIAL_KEY` before enabling inference. Register an Anthropic connection and deployment with the CLI in the README. Leave the deployment disabled until it should be called. Do not remove the database volume.

## 9. Rollback instructions

`004_anthropic.sql` does not rewrite OpenAI rows. Build the previous image with `git archive --format=tar 0b18e92 | docker build -t llm-proxy:slice-01 -`. Stop the current app and start that image on the same database. Readiness stays 200 because `003_inference.sql` remains applied. The OpenAI route still responds. Start the current image to use Anthropic again. The README has the commands. This run proved that sequence on a separate database and did not delete the Compose volume.

## 10. Commit ID and known limitations

One commit carries this slice. Its subject is `feat(proxy): add Anthropic provider adapter`. The id is the hash printed by `git log -1`. Limitations are in `known-limitations.md`. Slice 03 was not started.
