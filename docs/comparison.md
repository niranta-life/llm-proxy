# Comparison

Back to [README](../README.md)

This page compares llm-proxy with other LLM gateways, proxies, and routers. All sources were read on 2026-10-22. Products change fast. Check the source before you rely on a row. "Not documented" means we found no public statement, not that the feature is missing.

## Market table

| Product | Deployment | OSS license | Multi-tenancy | Key custody | Failover (mid-stream) | Budgets / cost | Eval / learning loop | 2026 status |
|---|---|---|---|---|---|---|---|---|
| **llm-proxy** | Self-host (Docker + Postgres) | MIT | Postgres row-level security per tenant | AES-256-GCM in the database; caller never sees keys | Fallback only before the first byte; named model never switches | Monthly budgets, observation mode; cost labeled estimated, provisional, or unknown | Pinned replay, deterministic checks, an optional judge, a schedule, and a shadow ranking. The ranking is an estimate and does not change the route. Replay stays off until execution is enabled for one tenant. The judge and the schedule stay off until one tenant is named. | Used internally for all our products |
| **LiteLLM** | Self-host; managed cloud | Core MIT; `enterprise/` folder commercial [1] | Teams in OSS; organizations enterprise-only [2] | Virtual keys; secret managers enterprise [3] | Ordered fallbacks; continues a broken stream on another model [4][5] | Per key, team, user, customer, model [3] | Not documented | PyPI releases 1.82.7 and 1.82.8 backdoored on 2026-03-24 [6] |
| **Portkey** | SaaS and self-host gateway | MIT (repo) [7]; one review says Apache-2.0 | Workspaces under RBAC [7] | Enterprise key management [7] | Fallbacks, retries, load balancing [7]; mid-stream not documented | Budgets on a paid tier [8] | Not documented | Gateway open-sourced 2026-03-24 [9]; acquired by Palo Alto Networks, now Prisma AIRS [10] |
| **Kong AI Gateway** | Konnect SaaS control plane or self-host enterprise | Core Apache-2.0; AI plugins enterprise [11] | Not documented | Not documented | Round-robin fallback (3.13+) [12] | Token and cost limits enterprise [11] | Semantic routing [12] | Active |
| **Cloudflare AI Gateway** | SaaS only | Not OSS | Custom metadata scopes [13] | Your keys in Cloudflare Secrets Store [14] | Dynamic routing; up to 5 retries [15] | Spend limits, eventually consistent [13] | Not documented | Active |
| **Helicone** | Self-host Rust gateway | License sources conflict [18] | Not documented | Not documented | Load balancing [18] | Rate limits [18] | Observability only | Acquired by Mintlify, March 2026 [19] |
| **OpenRouter** | SaaS only | Not OSS | n/a | Its credits or your keys [20] | Fallbacks on by default [21] | Fee details vary by source [21] | Not documented | Active; zero-data-retention routing [20] |
| **TensorZero** | Self-host | Apache-2.0 | Not documented | Self-hosted | Retries, fallbacks, load balancing [22] | Not documented | Yes: feedback, LLM-judge evals, fine-tuning, A/B tests [22] | Archived 2026-06-12 [22][23] |
| **Envoy AI Gateway / Agent Router** | Self-host on Kubernetes | Apache-2.0 [25] | Quota-aware routing [24] | Per-request credentials [25] | Not documented | Token rate limits [25] | Not documented | 1.0 GA June 2026 [24]; renamed Agent Router, September 2026 [26] |
| **Bifrost (Maxim)** | Self-host; enterprise private deploy | Apache-2.0 [27] | Customer → team → virtual key [28] | Vault secrets enterprise [28] | Provider failover [27] | Budgets and virtual keys in OSS [28] | Not in the gateway | Active; clustering enterprise [27] |
| **AWS Bedrock** | Managed in your AWS account | Not OSS | IAM and inference profiles [29] | IAM; no provider keys | Cross-region inference [29] | Cost by profile tags [29] | Prompt routing within one model family [30] | Active |
| **Azure API Management** | Managed, or self-hosted gateway configured from Azure [32] | Not OSS | Subscriptions, counter keys [31] | Managed identity [31] | Priority or weighted backends, circuit breaker [31] | `llm-token-limit` [31] | Not documented | Active |
| **Not Diamond** | SaaS router | Not OSS | n/a | n/a | n/a | Picks cheaper models | Custom routers from eval data [33] | Not documented |
| **Martian** | SaaS router | Not OSS | n/a | n/a | n/a | Picks by cost and quality | Model router [34] | Unclear |
| **RouteLLM** | Library and server | Apache-2.0 [36] | n/a | n/a | n/a | Savings claim from the project [37] | Routers trained on preference data | Repo active [36] |

## What the market shows

- **Consolidation.** In 2026 Portkey went to Palo Alto Networks, Helicone went to Mintlify, TensorZero was archived, and Envoy AI Gateway became Agent Router.
- **The gateway is a target.** The LiteLLM backdoor took `.env` files that hold LLM API keys. Everyone who installed it had to rotate every credential [6].
- **Mid-stream behavior differs.** Some gateways end a broken stream with an error [40]. Others feed the partial text to a second model and continue [41]. llm-proxy does neither after the first byte: it never falls back once output starts.
- **Database-enforced tenant isolation.** We found no other gateway that documents it.
- **The learning-loop slot is partly open.** TensorZero was the self-hosted gateway that led with evals and optimization. It is archived. llm-proxy stores outcomes, replays an approved sample on one pinned challenger, runs deterministic checks, and can judge that pair. A schedule refreshes that evidence. An offline snapshot can mark a candidate qualified for one task segment. A shadow ranker can record an estimated recommendation for `auto`. The router does not execute it. Replay, the judge, the schedule, the snapshot, and the ranking do not change production routing.
- **Analyst coverage.** Gartner published a Market Guide for AI Gateways (2025-10-13) [38] and a Market Overview (2026-05-13) [39]. Data protection and identity are in scope.

## Where llm-proxy is behind

- Text chat only. No tools, images, audio, embeddings, or MCP.
- No admin API or UI, no SSO or RBAC, no TLS on the listen port, no external secret manager.
- Six providers, at most two attempts, no response cache, no guardrails, no clustering guide.
- The private endpoint (DGX) is not live-validated.
- Quality-based routing is not built. An operator can store a shadow policy for the alias `auto`. That policy records the decision and does not choose a deployment. When the policy is in shadow, a ranker can read qualified evidence and store an estimated recommendation. The router does not execute it. An evidence snapshot can mark a candidate qualified for one task segment. That mark does not choose a deployment. Replay stays off until you enable execution for one tenant. The judge and the schedule stay off until you name one tenant.

## Who uses it in an enterprise

- **Platform engineering** runs it as the one gateway that every app uses, so no app holds a provider key.
- **Security** can answer "why can't tenant A read tenant B's data?" with "the database enforces it."
- **FinOps** gets per-tenant cost that never hides a failed call as $0.
- **App teams** keep the OpenAI SDK and send `model: "auto"`.

## Sources

[1] https://www.promptquorum.com/power-local-llm/litellm-review
[2] https://docs.litellm.ai/docs/proxy/multi_tenant_architecture
[3] https://www.truefoundry.com/blog/what-is-litellm
[4] https://docs.litellm.ai/docs/proxy/reliability
[5] https://github.com/api7/aisix/pull/882
[6] https://bastion.tech/blog/litellm-pypi-supply-chain-attack
[7] https://github.com/Portkey-AI/gateway
[8] https://www.getmaxim.ai/articles/bifrost-vs-portkey-self-hosted-open-source-ai-gateway-comparison-2026/
[9] https://www.globenewswire.com/news-release/2026/03/24/3261574/0/en/Portkey-s-Gateway-is-Now-Fully-Open-Source-Processing-over-1-Trillion-Tokens-Every-Day.html
[10] https://nand-research.com/palo-alto-networks-portkey-acquisition-anchors-its-agentic-security-stack/
[11] https://www.truefoundry.com/blog/kong-gateway-pricing-architecture-an-analysis-for-ai-teams-2026-edition
[12] https://developer.konghq.com/ai-gateway/load-balancing/
[13] https://developers.cloudflare.com/ai-gateway/features/spend-limits/
[14] https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
[15] https://developers.cloudflare.com/changelog/post/2026-04-02-auto-retry-upstream-failures/
[18] https://dev.co/observability/open-source/ai-gateway
[19] https://ai-startups.dealroom.co/news/feed/mintlify-acquires-open-source-ai-observability-platform-helicone
[20] https://openrouter.ai/enterprise
[21] https://www.truefoundry.com/blog/openrouter-byok-explained-cheaper-often-faster-and-changing
[22] https://github.com/tensorzero/tensorzero
[23] https://www.tensorzero.com
[24] https://aigateway.envoyproxy.io/release-notes/v1.0/
[25] https://www.truefoundry.com/blog/envoy-ai-gateway-review
[26] https://aaif.io/blog/agent-router-joins-aaif
[27] https://github.com/maximhq/bifrost
[28] https://www.getmaxim.ai/bifrost/pricing
[29] https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-create.html
[30] https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-bedrock-intelligent-prompt-routing-generally-available
[31] https://docs.azure.cn/en-us/api-management/genai-gateway-capabilities
[32] https://learn.microsoft.com/en-us/azure/api-management/api-management-gateways-overview
[33] https://apis.io/providers/notdiamond/
[34] https://docs.withmartian.com/martian-model-router/getting-started/benchmarking-the-router
[36] https://github.com/lm-sys/RouteLLM
[37] https://lmsys.org/blog/2024-07-01-routellm/
[38] https://www.gartner.com/en/documents/7051698
[39] https://www.gartner.com/en/documents/7855181
[40] https://langwatch.ai/docs/ai-gateway/streaming.md
[41] https://docs.api7.ai/ai-gateway/routing/mid-stream-fallback
