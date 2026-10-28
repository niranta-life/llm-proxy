# llm-proxy

**Give every team AI access without giving up control.**

llm-proxy is a self-hosted, OpenAI-compatible LLM gateway that makes no silent decisions. It runs in your cloud VPC or on-prem in your own data center, and needs only PostgreSQL. Security gets one place for provider keys. Finance gets per-team spend it can trust. Compliance knows the approved model is the one that answered. Developers keep the OpenAI SDK and never handle a provider key.

## For enterprises

- **Pass your security review.** It runs inside your network. No vendor holds your data, so there is no new third-party risk and no data-residency question.
- **One place for provider keys.** No keys spread across app `.env` files. If a key leaks, you rotate it once, and no app redeploys.
- **The approved model is the one that answered.** A named model never switches. Audits and regulated workloads get the model you tested.
- **See the kind of work, not the prompt.** Each completed chat stores the task category, the model, and the outcome. That record has no prompt and no answer. Encrypted capture is off by default. When you turn it on, an approved chat is stored as ciphertext.
- **Spend you can defend.** Cost per team and per attempt, with no hidden $0 failures. Budgets stop overspend before the invoice.
- **Small to run.** One container and PostgreSQL. No vendor control plane and no extra services to patch or staff.
- **AI where the internet is not allowed.** It can run air-gapped with a model that you host. A live DGX call is not yet validated.

## For developers

- **No new SDK.** Keep the OpenAI client and change the base URL. The same code works for OpenAI, Anthropic, Vertex, Grok, OpenRouter, or your own model.
- **Change models without a deploy.** Point the alias `auto` at a new deployment with the CLI.
- **No provider keys in your app.** You hold one tenant secret. No key rotation work.
- **Reliability is built in.** Retries, deadlines, fallback, and the circuit breaker are set once by the platform team, not rebuilt in each service.
- **Easy to debug.** Errors use the OpenAI shape. The `x-deployment`, `x-attempt-count`, and `x-fallback` headers show what happened. A field the model does not accept is refused, not dropped without notice.
- **Label the task when you know it.** Optional `task` must be a known category. The proxy stores it and does not send it to the provider.
- **Streams you can trust.** The proxy never joins output from two models into one answer.

Two words appear throughout. A **tenant** is one team or app with its own secret, models, limits, and budget. A **deployment** is one model at one provider that you registered.

## Why llm-proxy

Your LLM gateway holds every provider key that you own. It also sees every prompt that you send. That makes it one of the most trusted parts of your stack. Many teams pick one in an afternoon.

Without a gateway, each app has its own provider keys in its own `.env` file. Keys leak, spend is hard to stop, and nobody can say which model answered which request. A gateway fixes that. But many gateways also decide things for you: they switch to a different model when a provider fails or a budget runs out, or they keep a control plane on the vendor's network.

llm-proxy is built on three promises:

- **Contained.** Provider keys stay inside your network. Prompts go only to the provider that you chose, and to no one at all with a self-hosted model. A caller never sees a provider key or a provider URL. The database enforces tenant isolation.
- **Approved.** Every control is off until you turn it on. A request that names a model never switches to a different model. Fallback happens only for the alias `auto`, only to a deployment that passed your policy, and only before the first byte of output.
- **Provable.** Each attempt records which deployment answered and what it cost. Each cost is estimated (verified price, full usage), provisional (unverified price or partial usage), or unknown (no usage reported). A timeout is never recorded as a zero-cost call.

## High-level architecture

```mermaid
flowchart TB
    apps["<b>Applications / Agents / Services</b><br/>OpenAI SDK · HTTP · Streaming"]

    subgraph proxy["Intelligent LLM Proxy"]
        direction TB
        auth["API + Authentication"]
        norm["Request Normalization"]
        cap["Capability Validation"]
        router["Model Router"]
        adapters["Provider Adapters"]
        retry["Retries + Failover"]
        cost["Usage + Cost Tracking"]
        telem["Request Telemetry<br/>metrics + characteristics"]
        capture["Sample Capture<br/>encrypted, off by default"]
        auth --> norm --> cap --> router --> retry --> adapters
        adapters --> cost --> telem
        telem --> capture
    end

    subgraph providers["Model providers"]
        direction LR
        openai["OpenAI"]
        anthropic["Anthropic"]
        grok["Grok (xAI)"]
        openrouter["OpenRouter"]
        vertex["Vertex AI"]
        dgx["Custom / DGX"]
    end

    subgraph learning["Continuous Learning System"]
        direction LR
        history["History<br/>outcomes + encrypted samples"]
        schedule["Schedule<br/>off until named"]
        replay["Replay<br/>pinned challenger"]
        judge["Judge<br/>off until named"]
        optimizer["Optimizer<br/>model rankings"]
        history --> schedule
        schedule --> replay
        replay --> judge
        judge -.-> optimizer
    end

    infra["PostgreSQL 16 · evaluation jobs"]
    infraPlanned["Redis · Secret Manager (planned)"]

    apps --> proxy
    proxy --> providers
    telem --> history
    capture --> history
    replay -->|"separate traffic"| adapters
    optimizer -.-> router
    proxy --- infra
    proxy -.- infraPlanned

    classDef planned stroke-dasharray: 5 5
    class optimizer,infraPlanned planned
```

Solid lines are shipped. Dashed lines are planned. Replay stays off until you enable execution for one tenant. The judge and the schedule stay off until you name one tenant for each. None of them change production routing. The only runtime dependency is PostgreSQL 16. Evaluation jobs use that same database.

### How a request flows

1. **API + Authentication.** The caller sends `X-Tenant-ID` and a tenant secret. The proxy checks the secret against a scrypt verifier. From here, every database query runs as that tenant under PostgreSQL row-level security.
2. **Request Normalization.** The body becomes one standard request format. The same JSON works for every provider.
3. **Capability Validation.** Each deployment lists the fields it accepts, such as `temperature` or `stop`. The proxy refuses a field the deployment does not accept. It does not drop the field and continue.
4. **Model Router.** `model` is the alias `auto` or the name of an enabled deployment. The router resolves it to one deployment. A named model never changes. A shadow routing policy can record that choice. It does not change the deployment. See [Routing policy](docs/operations.md#routing-policy).
5. **Circuit breaker and limits.** An open circuit breaker rejects the attempt before any provider call. Then rate, concurrency, and budget limits are checked, and the proxy sets aside budget for this call.
6. **Provider Adapters.** One adapter per provider family turns the canonical request into the provider's API and back into an OpenAI chat completion or a streamed response.
7. **Retries + Failover.** Retry makes at most one more attempt on the same deployment, within one deadline. Fallback moves `auto` to one approved deployment, only before any output. A new attempt goes back to step 5.
8. **Usage + Cost Tracking.** Each attempt is priced from prices that you registered. The budget reservation is settled.
9. **Request Telemetry.** Each request and attempt is stored for the tenant's metrics. Each completed chat also stores one [request-characteristics](#request-characteristics) record, without the prompt or the answer. Response headers `x-deployment`, `x-attempt-count`, and `x-fallback` show what happened.

Encrypted capture can run after a completed chat. It is off by default. A schedule and a replay use a separate worker. They do not sit on this path, and they do not change the router.

Each box maps to code in `src/`. See [Architecture](docs/architecture.md) for the module map, the data model, and the trust boundaries.

### Request characteristics

Each completed chat stores one versioned record for that tenant. The record has the task category, how that category was chosen, the requested model, the selected deployment, the size, the latency, and the outcome. It does not contain the prompt, the answer, or a credential.

You can set `task` to `classification`, `extraction`, `summarization`, `reasoning`, `coding`, `translation`, `writing`, `general_qa`, or `unknown`. Any other value is rejected. When `task` is absent, local rules choose the category, or it stays `unknown`. The proxy does not call a model to classify the text, and it does not send `task` to the provider.

List and by-id reads use the same tenant headers as chat. A page holds at most 50 rows. Another tenant's rows are not returned. See [Metrics](docs/metrics.md#request-features).

An encrypted sample is a separate store. It is off by default. See [Encrypted samples](docs/metrics.md#encrypted-samples).

### Continuous Learning System

The learning system uses your own traffic. History, pinned replay, deterministic checks, a read-only report, an optional judge, and a schedule are in this release. Rankings are not.

- **History** stores each completed chat as characteristics: the deployment, the latency, the cost, and the result. That record has no prompt. When you turn on encrypted capture, an approved chat is also stored as ciphertext. The default stores no content.
- **Schedule** selects a bounded set of approved samples. It records why a run starts or why it skips. It does not call a model to choose the set. It reserves the estimate before a provider call. The scheduler is off until you name one tenant. It does not change aliases or production routing.
- **Replay** sends one approved sample to one pinned challenger. The worker calls the provider adapter. It does not call `POST /v1/chat/completions`. It does not use `model=auto`. It does not run tools. It stores the challenger output as ciphertext and records cost, latency, usage, and status. Replay is off until you enable execution for one tenant.
- **Checks** compare the original output and the challenger output with one approved profile. Each result is pass, fail, unknown, or not applicable. The checks do not call a model.
- **Report** reads one completed run. It states one recommendation. That recommendation does not change an alias or a fallback policy.
- **Judge** compares the two outputs when a run pins an approved rubric. Judging is off until you name one tenant. The judge budget is at most 1 USD. A judge finding does not change routing.
- **Drift** compares stored runs at or before a chosen time. A run counts only after it is completed by that time. Different populations are not pooled into one rate.
- **Optimizer** is not in this release. The router does not choose a model by a quality score.

Evaluation jobs stay in PostgreSQL. The schedule does not add Redis. See [Evaluation](docs/architecture.md#evaluation).

### How this architecture compares

LLM gateways follow a few designs. Each design puts the trust boundary in a different place.

| Design | Examples | Where prompts and keys live | Tenant isolation | Trade-off |
| --- | --- | --- | --- | --- |
| Hosted aggregator | OpenRouter, Cloudflare AI Gateway | Vendor network | Vendor app logic | No ops work. Traffic and keys leave your network. |
| Hybrid (gateway in your network, vendor control plane) | Portkey hybrid, Kong Konnect, Azure APIM self-hosted gateway | Data plane yours, config at vendor | Vendor app logic | Managed console. The control plane is still outside. |
| Self-hosted general gateway | LiteLLM, Bifrost, Helicone gateway | Your network | App logic (teams, virtual keys) | Breadth: many models and features. A large surface in the path of every key. |
| Kubernetes traffic gateway | Envoy AI Gateway (Agent Router), Kong | Your cluster | Route and quota config | Strong traffic control. Needs Kubernetes and service-mesh skills. |
| Cloud-native managed | AWS Bedrock, Azure OpenAI | Your cloud account | IAM | No provider keys. Locked to one cloud's model catalog. |
| Router service | Not Diamond, Martian, RouteLLM | Varies | n/a | Picks a model by quality. Not a gateway. |
| **llm-proxy** | — | **Your network, your Postgres** | **PostgreSQL row-level security** | Small, strict, auditable. Text chat only today. |

The main design differences:

- **Isolation in the database, not only in app code.** The runtime database role cannot bypass row-level security. It cannot read provider key ciphertext or secret verifiers. We found no other gateway that documents database-enforced tenant isolation.
- **Fallback that never joins two models in one answer.** Some gateways continue a broken stream on another model. llm-proxy never falls back after the first byte, so the answer you audit is the answer one model gave.
- **Policy-checked fallback.** A fallback target must be in the same tenant, pass a live check, come from an approved provider, match your data-handling rule, sit in an allowed region, and accept the required fields.
- **Honest cost.** Unknown stays unknown. A hard budget refuses a call whose cost it cannot estimate in advance.
- **One dependency.** PostgreSQL holds config, policy, keys, costs, the attempt trail, request characteristics, encrypted samples, and evaluation jobs. No vendor control plane.

## Why not an existing gateway?

There are many LLM gateways. Most of them compete on breadth: more models, more agents, more tools, and a hosted console. llm-proxy competes on trust in the request path.

| Question | llm-proxy | Typical gateway |
| --- | --- | --- |
| Where does it run? | Your cloud VPC or your own data center. Only PostgreSQL is needed. | SaaS, hybrid, or self-hosted with extra services. |
| Who sees the provider keys? | Only the proxy. AES-256-GCM ciphertext; the key is not in Postgres. | Gateway config, env vars, or the vendor's secret store. |
| How are tenants isolated? | PostgreSQL row-level security on every tenant query. | Teams or virtual keys in app logic. Some tiers are enterprise-only. |
| Can my model change without notice? | No. A named model never switches. | Often yes: automatic fallbacks, budget fallbacks, or mid-stream continuation. |
| How do I know what happened? | Headers and per-attempt rows name the deployment, the attempt count, and any fallback. A characteristics record names the task and the outcome, without the prompt. A routing decision names the alias, the baseline, and the mode, without the prompt. | Logs or a hosted dashboard. |
| Is a cost figure ever a guess shown as fact? | No. Each amount is estimated, provisional, or unknown. | Often a public price list; failed calls can show $0. |
| License | MIT. No paid enterprise tier. | Mixed: open core with paid enterprise features is common. |

Summary of the market as of October 2026 (full table with sources in [Comparison](docs/comparison.md)):

| Product | Deployment | Mid-stream failover | Tenant isolation | Learning loop |
| --- | --- | --- | --- | --- |
| LiteLLM | Self-host or cloud | Continues a broken stream on another model | Teams; organizations are enterprise-only | No |
| Portkey (now Palo Alto Networks Prisma AIRS) | SaaS or self-host | Not documented | Workspaces | No |
| Kong AI Gateway | Konnect SaaS or self-host enterprise | Not documented | Not documented | Semantic routing |
| Cloudflare AI Gateway | SaaS only | Not documented | Metadata scopes | No |
| OpenRouter | SaaS only | Fallbacks on by default | n/a | No |
| Bifrost | Self-host | Not documented | Customer → team → virtual key | No |
| Envoy AI Gateway / Agent Router | Kubernetes | Not documented | Quota-aware routing | No |
| TensorZero | Self-host | Not documented | Not documented | Yes, but archived June 2026 |
| AWS Bedrock / Azure APIM | Managed in your cloud | Not documented | IAM or subscriptions | Bedrock prompt routing (one model family) |
| **llm-proxy** | **Self-host, Postgres only** | **Never after the first byte** | **Database row-level security** | **Replay, checks, optional judge, and a schedule. No rankings.** |

Use a different gateway today if you need tools, images, audio, embeddings, MCP, an admin UI, SSO, or hundreds of models through one hosted key. llm-proxy does not include them yet.

## Run it in your VPC or on-prem

llm-proxy is built for a network that you control. It is one container and one PostgreSQL 16 database, so it runs anywhere you run containers:

- **Cloud VPC.** AWS, Google Cloud, Azure, or any other cloud, in a private subnet behind your own load balancer.
- **On-prem.** Your own servers and data center, next to your own GPUs.
- **Air-gapped.** With no internet access, when it routes only to a model endpoint that you host, such as a DGX system. Hosted providers (OpenAI, Anthropic, Vertex, xAI, OpenRouter) need outbound access to their APIs. A live DGX call is not yet validated.

In every case, keys, costs, policies, and the attempt trail all stay in your own PostgreSQL. Prompts pass through to the provider that you chose and nowhere else.

- **Prompt text stays out of logs and operator JSON.** Each completed chat stores the task, the model, and the outcome. Encrypted capture is off by default. When you turn it on, an approved chat is stored as ciphertext. A sample route returns metadata only.
- **Small footprint.** One Node.js process and PostgreSQL 16. Seven runtime packages, with a lockfile.
- **No telemetry.** The proxy calls only the providers that you register. It sends nothing to the maintainers or anyone else.
- **Caller never holds a provider key.** The caller sends a tenant id and a tenant secret. It cannot send a provider key or a provider URL.
- **Secrets at rest.** The database stores a scrypt verifier, not the tenant secret. Provider keys are AES-256-GCM ciphertext. The encryption key comes from `PROVIDER_CREDENTIAL_KEY`, not from Postgres.
- **Least-privilege database roles.** The runtime role cannot read provider ciphertext or verifiers. No role that the proxy logs in as can bypass row-level security.
- **Redacted logs.** Logs remove secrets, prompts, and chat messages.
- **No HTTP admin surface.** Tenants, providers, limits, and policies change only through the CLI, with flags or `--interactive`. No network request can change them. Only an operator with CLI and database access can.
- **Private model endpoints.** A self-hosted model, such as one on DGX, must be on an allowlist with pinned addresses. The proxy does not follow redirects.
- **Data residency.** Fallback checks region and data-handling values, so `auto` never moves a request to a region or provider that your policy did not approve. OpenRouter calls go only to the downstream providers that you list.

The proxy does not terminate TLS. Put TLS on the load balancer or reverse proxy in front of it. See [Operations](docs/operations.md).

## We run on it

The maintainers route every internal product's LLM calls through llm-proxy. Each control in this README, from the breaker to honest cost states, is one that our own traffic needed. When it breaks, it breaks for us first.

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

Live returns `{"status":"live"}`. Ready returns `{"status":"ready","database":"ready"}` when Postgres is up and `schema_migrations` has the latest migration for this image. If it is not ready, the route returns HTTP 503 and live stays 200. During shutdown it also returns HTTP 503, with `{"status":"not_ready","reason":"shutting_down"}`.

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

To keep a provider key out of the process arguments, pass it with `--api-key-stdin` instead of `--api-key`. See [docs/providers.md](docs/providers.md).

The same commands can run as prompts. `--interactive` has to be the only argument:

```bash
docker compose run --rm -it app node dist/cli.js --interactive
```

In a terminal, the CLI shows a guided menu:

```text
What do you want to do?
  1) create    Add tenants, secrets, provider connections, deployments, and prices
  2) update    Change secrets, keys, aliases, streaming, limits, budgets, and policies
  3) validate  Check deployments and providers, or show the current setup
action: 1
```

Pick by number or name. Each field shows a hint, such as the values it accepts. Press Enter to leave a field blank. Before a command runs, the CLI shows a summary (provider keys are hidden) and asks `Run <command>? [Y/n]`. A failed command does not end the session. Type `help` to see the menu again, `back` to go up, or `quit` to stop.

When input is piped, the CLI uses plain prompts for scripts: answer `create`, `update`, or `validate`, then the command name, then each field. A blank line leaves that field unset. `done` ends the session, and the first error stops it. In both modes, standard output is the same JSON the flag command prints and prompts go to standard error. Flag commands keep the arguments shown above.

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

- **[Architecture](docs/architecture.md).** Module map, request path, data model, and trust boundaries.
- **[Tenants](docs/tenants.md).** Every call carries a tenant id and a secret. You can add and revoke keys. One tenant cannot read another tenant's rows.
- **[Chat](docs/chat.md).** `POST /v1/chat/completions` and `GET /v1/models`. Text only. Success and errors use the OpenAI shape.
- **[Providers](docs/providers.md).** OpenAI, Anthropic, Vertex, xAI, OpenRouter, and one private DGX endpoint per tenant. You store the key. The caller does not.
- **[Streaming](docs/streaming.md).** Server-sent events for a text chat. Off until you enable it for the tenant and the deployment.
- **[Retry](docs/retry.md).** One more attempt on the same deployment, with deadlines. Off until you turn it on.
- **[Fallback](docs/fallback.md).** One more deployment for the alias `auto`, and only before any output. A named model never switches.
- **[Routing policy](docs/operations.md#routing-policy).** An operator can store a policy for the alias `auto`. Shadow mode records the decision. It does not change which deployment runs. A named model stays on that model.
- **[Limits and budgets](docs/limits.md).** Shared caps on rate, concurrency, and monthly spend. Start in observation mode.
- **[Cost](docs/cost.md).** You register the price. Each attempt is estimated, provisional, or unknown. The proxy does not take a payment.
- **[Circuit breaker](docs/breaker.md).** An optional breaker per deployment. An open breaker returns HTTP 503 and does not call the provider.
- **[Metrics](docs/metrics.md).** Counts, latency, stream percentiles, attempts, breaker state, and cost for the caller's own tenant.
- **[Request characteristics](docs/metrics.md#request-features).** One versioned record per completed chat: the task, the model, the size, and the outcome. The prompt and the answer are not stored.
- **[Encrypted samples](docs/metrics.md#encrypted-samples).** Optional ciphertext for an approved chat. Off by default. Metadata routes return no prompt and no completion.
- **[Evaluation](docs/architecture.md#evaluation).** Pinned replay, deterministic checks, a read-only report, an optional judge, and a schedule. Replay stays off until you enable execution for one tenant. The judge and the schedule stay off until you name one tenant. None of them change production routing.
- **[Cost of a schedule](docs/cost.md#evaluation-schedule).** A tick reserves the estimate before a provider call. Daily and monthly ceilings stay small.
- **[Operations](docs/operations.md).** Configuration, health, shutdown, migrations, incidents, and tests.
- **[Comparison](docs/comparison.md).** The LLM gateway market, with sources.

## Roadmap

- **Rankings.** Rank deployments per task. The router may use a ranking for `auto` only, inside the same policy checks as fallback. A named model still never switches. A judge finding does not change that route today.
- **Redis** for hot counters. Evaluation jobs already use PostgreSQL.
- **External secret manager** support for provider keys.
- **A verified live call to a private endpoint** (DGX), so it can be `validated_live`.

## Not included

- Login, OAuth, SSO, user accounts, and saved caller state.
- Tools, images, audio, embeddings, and MCP.
- A verified live call to DGX. A DGX deployment is not `validated_live`.
- Choosing a model by a quality score.
- An HTTP admin API or admin UI. Tenants, providers, limits, and policies change through the CLI.
- TLS on the proxy listen port.
- A payment flow.

## License

MIT. See [LICENSE](LICENSE).
