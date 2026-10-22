# llm-proxy

llm-proxy is an OpenAI-compatible chat proxy for many tenants.

Your apps keep one client and one request shape. You keep the provider keys, the model each tenant may call, and the rules for spend, retries, and failover. A caller sends a tenant id and a tenant secret. The caller never sends a provider key or a provider URL.

## Why it is useful

Each model provider has its own API, its own key, and its own failures. If every app handles that itself, keys leak and spend is hard to stop.

llm-proxy sits in front of those providers. Each tenant can read only its own rows. You name a deployment, point the alias `auto` at it, and turn on streaming, retry, fallback, limits, and budgets when you want them. Those controls stay off until you enable them.

There is no login, no saved caller state, and no payment. Every tenant request is checked with a secret. A successful chat comes back as an OpenAI chat completion.

## Get started

You need Colima, the Docker CLI, Docker Compose, and curl. Tests and the check script also need Node.js 24. If your shell is on another Node version, run `nvm use 24`, then `npm install`, before `npm test`.

Point Docker at the Colima socket, then start the stack. The script starts Colima when it is down, then PostgreSQL 16 and the proxy on port 8080.

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
scripts/colima.sh start
```

`npm run stack -- start` is the same script. `scripts/colima.sh start --build` rebuilds the image. `scripts/colima.sh stop` stops the containers and keeps the database volume. Colima itself stops only with `scripts/colima.sh stop --vm`.

Check the process:

```bash
curl -s http://127.0.0.1:8080/health/live
curl -s http://127.0.0.1:8080/health/ready
```

Live returns `{"status":"live"}`. Ready returns `{"status":"ready","database":"ready"}` when Postgres is up and `schema_migrations` has the latest migration for this image. If it is not ready, the route returns HTTP 503 and live stays 200.

Chat stays off until inference is on and a deployment is enabled. Create a tenant, turn inference on, and register OpenAI:

```bash
docker compose run --rm app node dist/cli.js provision-tenant --name Acme

export INFERENCE_ENABLED=true
export PROVIDER_CREDENTIAL_KEY="$(openssl rand -base64 32)"
export OPENAI_BASE_URL="https://api.openai.com/v1"
docker compose up -d --force-recreate app

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
```

The CLI prints the tenant secret once. Save it. The database stores only a verifier.

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "X-Tenant-ID: <tenant-id>" \
  -H "Authorization: Bearer <tenant-secret>" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

`model` is `auto` or the name of an enabled deployment. Other providers use the same request. You change only `model`.

To check a running proxy without calling OpenAI:

```bash
npm run check:deployed -- --prepare-local
```

Compose database passwords are for local development. The proxy listens without TLS. Put TLS on the reverse proxy in front of it.

## Capabilities

- **[Tenants](docs/tenants.md).** Every call carries a tenant id and a secret. You can add and revoke keys. One tenant cannot read another tenant's rows.
- **[Chat](docs/chat.md).** `POST /v1/chat/completions` and `GET /v1/models`. Text only. Success and errors use the OpenAI shape.
- **[Providers](docs/providers.md).** OpenAI, Anthropic, Vertex, xAI, OpenRouter, and one private DGX endpoint per tenant. You store the key. The caller does not.
- **[Streaming](docs/streaming.md).** Server-sent events for a text chat. Off until you enable it for the tenant and the deployment.
- **[Retry](docs/retry.md).** One more attempt on the same deployment, with deadlines. Off until you turn it on.
- **[Fallback](docs/fallback.md).** One more deployment for the alias `auto`, and only before any output. A named model never switches.
- **[Limits and budgets](docs/limits.md).** Shared caps on rate, concurrency, and monthly spend. Start in observation mode.
- **[Cost](docs/cost.md).** You register the price. Each attempt is estimated, provisional, or unknown. The proxy does not take a payment.
- **[Circuit breaker](docs/breaker.md).** An optional breaker per deployment. An open breaker returns HTTP 503 and does not call the provider.
- **[Metrics](docs/metrics.md).** Counts, latency, stream percentiles, attempts, breaker state, and cost for the caller's own tenant.
- **[Operations](docs/operations.md).** Configuration, health, shutdown, migrations, incidents, and tests.

## Not included

- Login, OAuth, user accounts, and saved caller state.
- Tools, images, and audio.
- A verified live call to DGX. A DGX deployment is not `validated_live`.
- Choosing a model by a quality score.
- An HTTP admin API. Tenants, providers, limits, and policies change through the CLI.
- TLS on the proxy listen port.
- A payment flow.

## License

MIT. See [LICENSE](LICENSE).
