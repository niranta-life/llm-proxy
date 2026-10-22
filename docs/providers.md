# Providers

[llm-proxy](../README.md) can call OpenAI, Anthropic, Vertex, xAI, OpenRouter, and one private DGX endpoint per tenant. Each tenant has one connection per provider. The caller cannot send a provider URL or a provider API key.

Provider keys are AES-256-GCM ciphertext with the prefix `aes-256-gcm$`. The key is `PROVIDER_CREDENTIAL_KEY`, a 32-byte value in base64. Postgres does not store that key. `list-inference` does not print a provider credential. A new Anthropic, Vertex, xAI, OpenRouter, or DGX deployment stays disabled until you enable it.

Chat itself is the same request for every provider. See [Chat](chat.md).

Turn inference on before any of these calls. Keep the same `PROVIDER_CREDENTIAL_KEY` on the running proxy.

```bash
export INFERENCE_ENABLED=true
export PROVIDER_CREDENTIAL_KEY="$(openssl rand -base64 32)"
docker compose up -d --force-recreate app
```

Timeouts you set are integers from 100 through 600000 milliseconds.

## OpenAI

The base URL is `OPENAI_BASE_URL`. If that variable is absent, the proxy uses `https://api.openai.com/v1`. Set it when you point at a mock server. A caller cannot change it on the request.

```bash
export OPENAI_BASE_URL="https://api.openai.com/v1"
docker compose run --rm app node dist/cli.js register-openai-connection \
  --tenant-id <tenant-id> --api-key "$OPENAI_API_KEY"
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --name primary \
  --upstream-model gpt-4o-mini \
  --timeout-ms 30000 \
  --capabilities temperature \
  --enabled true
docker compose run --rm app node dist/cli.js set-alias \
  --tenant-id <tenant-id> --alias auto --deployment primary
docker compose run --rm app node dist/cli.js list-inference --tenant-id <tenant-id>
```

You can rotate the key or turn the connection and deployment off:

```bash
docker compose run --rm app node dist/cli.js set-openai-credential \
  --tenant-id <tenant-id> --api-key "$OPENAI_API_KEY"
docker compose run --rm app node dist/cli.js set-connection-enabled \
  --tenant-id <tenant-id> --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled \
  --tenant-id <tenant-id> --name primary --enabled false
```

`set-connection-enabled` changes the OpenAI connection when you omit `--provider`. Do not pass `--default-max-output-tokens` for OpenAI. `npm test` uses a mock server and does not call OpenAI.

## Anthropic

Anthropic uses the Messages API. The endpoint is stored on the tenant connection. `OPENAI_BASE_URL` is not that endpoint. There is no Anthropic environment variable. `register-anthropic-connection` enables the connection. The deployment stays off until `--enabled true` or `set-deployment-enabled`.

An Anthropic deployment must have `--default-max-output-tokens`. `--workspace-id` is optional.

```bash
docker compose run --rm app node dist/cli.js register-anthropic-connection \
  --tenant-id <tenant-id> \
  --api-key "$ANTHROPIC_API_KEY" \
  --endpoint https://api.anthropic.com
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --provider anthropic \
  --name claude \
  --upstream-model claude-sonnet-4-5 \
  --timeout-ms 30000 \
  --capabilities temperature,stop,max_completion_tokens \
  --default-max-output-tokens 1024 \
  --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled \
  --tenant-id <tenant-id> --name claude --enabled true
docker compose run --rm app node dist/cli.js set-anthropic-credential \
  --tenant-id <tenant-id> --api-key "$ANTHROPIC_API_KEY"
```

Adding Anthropic does not change an OpenAI deployment that is already stored.

A non-stream chat uses the Anthropic SDK. A stream is one HTTP request to the Messages API and does not use the SDK stream helper. The proxy accepts the configured model, and that model plus an 8-digit snapshot suffix. The caller still receives the configured model. A different model fails the stream. The proxy ignores Anthropic `inference_geo` and `speed`. It does not invent a cache count. A cache count is stored only when Anthropic sends one.

`scripts/anthropic-smoke.mjs` sends nothing unless `ANTHROPIC_SMOKE` is `1`. `npm test` does not run it. The script does not read a provider API key.

```bash
ANTHROPIC_SMOKE=1 PROXY_BASE_URL=http://127.0.0.1:8080 \
  TENANT_ID=<tenant-id> TENANT_SECRET=<tenant-secret> MODEL=claude \
  node scripts/anthropic-smoke.mjs
```

## Vertex

Each tenant has one Vertex connection. You must pass `--project` and `--location`. Vertex stores no endpoint. The caller cannot pick the project, the location, or the credential on a chat request. A chat does not run `gcloud` and does not change `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, or a credential path.

The default auth mode is `service_account`. That mode needs key material in `--api-key`, and the material must contain `private_key`. An email address or a resource name is not a credential. `--service-account` is optional for that mode.

These modes store no key. Do not pass `--api-key` for them.

- `adc` uses Application Default Credentials.
- `workload_identity` uses the metadata server.
- `impersonation` uses one approved service account and requires `--service-account`.

The default API version is `v1`. Store `v1beta1` only when the model needs it. The proxy caches a Vertex client by tenant, connection, identity, and config version, and mints a new token before the current one expires.

The identity needs `roles/aiplatform.user` on the project. Impersonation also needs `roles/iam.serviceAccountTokenCreator` on the target service account.

Application Default Credentials are for a development machine. Do not use a developer credential file in production. Workload identity and approved impersonation are the production modes. The image does not contain the ADC file, and the default Compose file does not mount it.

```bash
export VERTEX_PROJECT_ID="your-project-id"
export VERTEX_LOCATION="us-central1"
gcloud auth login
gcloud config set project "$VERTEX_PROJECT_ID"
gcloud auth application-default login
gcloud auth application-default set-quota-project "$VERTEX_PROJECT_ID"
gcloud services enable aiplatform.googleapis.com --project "$VERTEX_PROJECT_ID"

export VERTEX_ADC_FILE="$HOME/.config/gcloud/application_default_credentials.json"
docker compose -f docker-compose.yml -f docker-compose.adc.yml up
```

The overlay sets `GOOGLE_APPLICATION_CREDENTIALS` to `/var/run/gcp/adc.json`.

```bash
docker compose run --rm app node dist/cli.js register-vertex-connection \
  --tenant-id <tenant-id> \
  --auth-mode adc \
  --project "$VERTEX_PROJECT_ID" \
  --location "$VERTEX_LOCATION" \
  --api-version v1
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --provider vertex \
  --name vertex-chat \
  --upstream-model gemini-2.5-flash \
  --timeout-ms 30000 \
  --capabilities temperature,max_tokens,stop
docker compose run --rm app node dist/cli.js validate-vertex-credential --tenant-id <tenant-id>
docker compose run --rm app node dist/cli.js validate-vertex-access --tenant-id <tenant-id>
docker compose run --rm app node dist/cli.js test-vertex-inference \
  --tenant-id <tenant-id> --deployment vertex-chat
docker compose run --rm app node dist/cli.js set-deployment-enabled \
  --tenant-id <tenant-id> --name vertex-chat --enabled true
```

For `service_account`, pass `--api-key` with the key material instead of `--auth-mode adc`.

`validate-vertex-credential` checks that a token can be minted and does not print the token. `validate-vertex-access` lists models in the stored project and location. That list is not the publisher catalog. A failed list does not mark the project valid. `test-vertex-inference` sends one small text request and can run while the deployment is disabled. `POST /v1/chat/completions` still refuses a disabled deployment.

A live Vertex test runs only when `VERTEX_LIVE` is `1`. `npm test` does not set that variable.

## xAI

Each tenant has one xAI connection. The base URL is fixed at `https://api.x.ai/v1`. The connection stores no endpoint. The caller cannot send `base_url`. Capabilities match an OpenAI deployment. Do not pass `--default-max-output-tokens` or an OpenRouter routing flag. The proxy does not send `X-OpenRouter-Metadata` to xAI.

Enable xAI before you enable OpenRouter. Turn on one of those two providers at a time.

```bash
docker compose run --rm app node dist/cli.js register-xai-connection \
  --tenant-id <tenant-id> --api-key "$XAI_API_KEY"
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --provider xai \
  --name xai-chat \
  --upstream-model grok-example \
  --timeout-ms 30000 \
  --capabilities temperature \
  --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled \
  --tenant-id <tenant-id> --name xai-chat --enabled true
```

A live xAI test runs only when `XAI_LIVE` is `1`. `npm test` does not set that variable.

## OpenRouter

Each tenant has one OpenRouter connection. The base URL is fixed at `https://openrouter.ai/api/v1`. The connection stores no endpoint. The caller cannot send `provider`, `models`, `route`, or a base URL.

Enable OpenRouter only after you decide whether xAI stays disabled.

You store 1 to 8 unique downstream slugs. A slug uses lowercase letters, digits, and hyphens. The proxy sends that list as `provider.only` and does not add to it. `--data-collection` is `allow` or `deny`. `--allow-fallbacks` is the OpenRouter routing flag. The proxy [fallback policy](fallback.md) is separate. The proxy does not drop or widen a stored restriction. An empty downstream list is invalid.

`--require-serving-provider true` demands a provider id in the response. The proxy sends `X-OpenRouter-Metadata: enabled` and reads the selected provider from `openrouter_metadata`. The name must match a stored slug, ignoring letter case. The proxy keeps the name OpenRouter reported. It does not treat the model name as the provider, and it does not read a provider out of a summary sentence. On a stream, it can read the name from the final chunk. A complete stream then ends with `[DONE]`.

A required provider that the response does not name does not succeed. A reported provider outside the stored list does not succeed. These four flags are invalid on every provider except OpenRouter.

```bash
docker compose run --rm app node dist/cli.js register-openrouter-connection \
  --tenant-id <tenant-id> --api-key "$OPENROUTER_API_KEY"
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --provider openrouter \
  --name router-chat \
  --upstream-model openai/gpt-4o-mini \
  --timeout-ms 30000 \
  --capabilities temperature \
  --downstream-providers anthropic \
  --data-collection deny \
  --allow-fallbacks false \
  --require-serving-provider true \
  --enabled false
docker compose run --rm app node dist/cli.js set-deployment-enabled \
  --tenant-id <tenant-id> --name router-chat --enabled true
```

A live OpenRouter test runs only when `OPENROUTER_LIVE` is `1`. `npm test` does not set that variable.

## Private DGX

Each tenant can store one private DGX endpoint. Chat uses the stored endpoint, model, API key, and auth mode. The endpoint is `https`, with no user name and no password. The host is not a public provider host. The proxy does not follow a redirect. Keep TLS verification on for production.

The endpoint must be on that tenant's allowlist, and the allowlist pins the addresses for the host. Chat uses `/v1/models` and `/v1/chat/completions`. A health check uses only the stored health endpoint. DGX does not use `OPENAI_BASE_URL`. Do not pass `--default-max-output-tokens` or an OpenRouter flag.

`set-deployment-concurrency` is a limit inside this process. A limit shared by every process uses `set-deployment-limit`. See [Limits and budgets](limits.md).

```bash
docker compose run --rm app node dist/cli.js register-dgx-connection \
  --tenant-id <tenant-id> \
  --api-key "$DGX_API_KEY" \
  --endpoint https://dgx.lab.internal/v1
docker compose run --rm app node dist/cli.js register-deployment \
  --tenant-id <tenant-id> \
  --provider dgx \
  --name dgx-chat \
  --upstream-model private-model \
  --timeout-ms 30000 \
  --capabilities temperature \
  --enabled false
docker compose run --rm app node dist/cli.js approve-private-endpoint \
  --tenant-id <tenant-id> \
  --host dgx.lab.internal \
  --port 443 \
  --addresses 10.0.0.8 \
  --tls-verify true \
  --health-endpoint https://dgx.lab.internal/health
docker compose run --rm app node dist/cli.js set-deployment-concurrency \
  --tenant-id <tenant-id> --deployment dgx-chat --max-concurrency 2
docker compose run --rm app node dist/cli.js validate-deployment \
  --tenant-id <tenant-id> --deployment dgx-chat --status valid
docker compose run --rm app node dist/cli.js set-deployment-health \
  --tenant-id <tenant-id> --deployment dgx-chat --status healthy
```

`validate-deployment` can record `unvalidated`, `valid`, `invalid`, or `validated_mock`. It refuses `validated_live`. Live DGX is not verified. `set-deployment-health` records `unknown`, `healthy`, or `unhealthy` and does not change the validation status. Tests use a local mock and do not call a DGX host.

## Related

- [Chat](chat.md)
- [Streaming](streaming.md)
- [Cost](cost.md)
- [Operations](operations.md)
