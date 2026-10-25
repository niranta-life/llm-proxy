# Deploy on GCP (GKE Autopilot)

Back to [README](../README.md)

The OpenTofu, manifests and scripts described here exist in `deploy/gcp/` and `scripts/gcp/`. They have been validated locally only (formatting, `tofu validate`, shellcheck, kustomize render, `up.sh --dry-run`); **nothing has been run against GCP**. Anything tagged **[U1]** to **[U16]** is unverified and listed in [Verify first](#verify-first).

## TL;DR

| Question | Answer |
|---|---|
| What runs where | One stateless llm-proxy Deployment and a CloudNativePG (CNPG) Postgres 16 cluster on one GKE Autopilot cluster. |
| Internet and TLS | Global HTTPS load balancer, Google-managed certificate, HTTP redirects to HTTPS, TLS 1.2 minimum. |
| Who can reach it | Cloud Armor allowlist of team IPs, then llm-proxy's own tenant API keys. |
| Providers | OpenAI and Anthropic keys encrypted in Postgres. Vertex AI through Workload Identity, no key. |
| Deploy | One command, `scripts/gcp/up.sh`, from your Mac. No CI. Image built by Cloud Build, tagged with the git SHA. |
| Scaling | HPA on CPU, minimum 1 replica. KEDA HTTP add-on is not recommended (below). |
| Cost | Roughly 190 to 280 USD a month before provider usage. Estimate, [U12]. |
| Biggest risks | BYPASSRLS on CNPG [U1] and SSE through the load balancer [U2]. Check both first. |

### One replica means outages on every node event

The app runs at **minimum 1 replica** (the choice for this plan). With one replica, any node upgrade, eviction or crash is a **full outage of tens of seconds to a few minutes**, and every open stream is cut. GKE upgrades nodes automatically, so this will happen.

Two replicas plus a PDB that keeps one pod up remove the outage for about 20 USD a month. To switch, set two values in `deploy/gcp/settings.env` (MIN_REPLICAS=2, PDB_MIN_AVAILABLE=1) and run `scripts/gcp/deploy.sh`:

```bash
MIN_REPLICAS=2
PDB_MIN_AVAILABLE=1
```

Recommendation: do this as soon as other people depend on the tool.

### KEDA or HPA?

**Use the plain HPA. Do not use the KEDA HTTP add-on.**

- With minimum 1, "scale to zero" applies only to extra replicas above 1, which an HPA already does. The add-on's special feature (waking from zero) is not needed.
- The add-on puts an interceptor proxy in the path of every request and stream. Whether it passes SSE unbuffered and what its timeouts are is unknown [U2], and streams last up to 10 minutes. That is risk for no gain.
- The scale signal is CPU: every request pays a scrypt hash (tens of milliseconds, modeled, not measured). The app exports no concurrency metric to scale on (see [Open issues](#open-issues)).

KEDA core (no interceptor) is supported as a setting: `AUTOSCALER=keda` in `settings.env` renders a `ScaledObject` instead of the HPA. The deploy script renders exactly one of the two and removes the other. Pick it only if you later want Prometheus or cron triggers. If you still want the HTTP add-on, test it in a throwaway namespace with a 10-minute stream first.

## Glossary

| Term | Meaning |
|---|---|
| HPA | Horizontal Pod Autoscaler: Kubernetes adds or removes pods by a metric (here CPU). |
| KEDA | Event-driven autoscaler for Kubernetes. Optional here. |
| SSE | Server-sent events: how streamed chat responses are sent. |
| CNPG | CloudNativePG, the operator that runs Postgres in Kubernetes. |
| WAL, PITR | Write-ahead log. Point-in-time recovery: restore to a chosen moment by replaying archived WAL. |
| RPO, RTO | How much data can be lost, and how long recovery takes. |
| BYPASSRLS | Postgres role attribute that skips row-level security. The `llm_owner` role needs it. |
| KSA, GSA | Kubernetes service account, Google service account. Workload Identity links one to the other. |
| PDB | PodDisruptionBudget: how many pods may be down during voluntary disruption such as upgrades. |
| IAP | Identity-Aware Proxy: Google's login gate in front of web apps. |
| CIDR | An IP range such as `203.0.113.0/24`. |

## Architecture

| Piece | Choice | Why |
|---|---|---|
| Compute | GKE Autopilot, regional, private nodes, Cloud NAT | No node management. Pay per pod request. NAT gives one fixed egress IP. |
| App | Deployment, HPA 1 to 4 | Stateless, CPU bound. |
| Database | CNPG, Postgres 16, 2 instances | Real superuser, so `llm_owner` BYPASSRLS can be created. |
| Backups | barman-cloud plugin to GCS, PITR | Workload Identity, no keys. |
| Entry and TLS | GKE Gateway `gke-l7-global-external-managed`, Certificate Manager | Google-managed cert, redirect, SSL policy. |
| Lock-down | Cloud Armor allowlist, NetworkPolicy, tenant API keys | Internal tool. |
| Secrets | Secret Manager, copied into Kubernetes Secrets by script | No secret values in OpenTofu state. |
| Infra as code | OpenTofu (GCP), Helm (operators), kustomize (app) | See Tool choices. |

```
 team laptop / app
       |  HTTPS (Google-managed cert, TLS 1.2+)
       v
 Global external Application LB  <-- Cloud Armor allowlist (team IPs)
       |  (HTTP :80 -> 301 to HTTPS)
       v
 GKE Gateway --> HTTPRoute --> Service llm-proxy :8080
                                  |
                   Deployment llm-proxy (HPA 1..4)
                     KSA llm-proxy --WI--> GSA llm-proxy-app (aiplatform.user -> Vertex AI)
                                  | TCP 5432
                                  v
                   Service llm-pg-rw --> CNPG cluster llm-pg (primary + replica)
                                           | WAL + base backups
                                           v  KSA llm-pg --WI--> GSA llm-pg-backup
                                         GCS bucket (objectAdmin on that bucket only)

 Egress to api.openai.com and api.anthropic.com goes through Cloud NAT (one IP).
```

IAM: backup GSA `llm-pg-backup` has objectAdmin on the backup bucket only; restore GSA `llm-pg-restore` has objectViewer on it (drill only); the Cloud Build service account `llm-proxy-build` can read only the build staging bucket (objectViewer) plus the roles in `iam.tf`; app GSA `llm-proxy-app` has `aiplatform.user`. All pods use Workload Identity; no key files.

Namespaces: `llm-proxy` (app and database), `cnpg-system`, `cert-manager`, optionally `keda`.

### Alternatives considered

| Option | Why not |
|---|---|
| Cloud Run + Cloud SQL | Simplest, but Cloud SQL has no real superuser, so `llm_owner` with BYPASSRLS probably cannot be created (web search, not a live test). Short shutdown window for streams. |
| Cloud Run + Postgres on a VM | Patching, backups and failover become ours. |
| GKE Standard | More node toil for no gain here. |
| KEDA HTTP add-on | See above. |
| IAP in front | IAP reads `Authorization: Bearer`, the header every OpenAI-style SDK and curl call uses for the proxy key. Clients would have to mint Google ID tokens. Not worth it. A VPN with a fixed egress IP is the answer for roaming users. |

## Verify first

Every **[Un]** tag in this doc points here. Do 1 to 3 before building anything else; each can end the plan.

| # | Check | Where |
|---|---|---|
| U1 | `llm_owner` shows `rolbypassrls = t` after bootstrap on CNPG. | `up.sh` database step |
| U2 | A stream arrives chunk by chunk through the Gateway and survives more than 60 s. The KEDA HTTP add-on's SSE behavior is unknown (only matters if used). | `smoke.sh` |
| U3 | Vertex `workload_identity` works: google-auth's `Compute` client (`src/inference/vertex-client.ts:146`) against the GKE metadata server, with the NetworkPolicy applied. | `providers.sh` |
| U4 | Autopilot accepts `terminationGracePeriodSeconds: 90` (a cap may exist, mainly for Spot pods). | `kubectl describe pod` |
| U5 | CNPG and barman-cloud plugin names match the pinned versions: `barmancloud.cnpg.io/v1`, `plugins:`, `method: plugin`, plugin manifest URL, metric names, `metrics` port name, `premium-rwo` class. | `kubectl explain`, release notes |
| U6 | `HealthCheckPolicy`, `GCPBackendPolicy` (`securityPolicy`, `connectionDraining`) and `GCPGatewayPolicy` (`sslPolicy`) field names. | `kubectl explain` |
| U7 | The Certificate Manager cert map annotation attaches on the global managed Gateway class, and the cert becomes ACTIVE. | `dns.sh wait` |
| U8 | Load balancer traffic reaches pods from 35.191.0.0/16 and 130.211.0.0/22 only; Dataplane V2 enforces NetworkPolicy; NodeLocal DNS address is 169.254.20.10. | `dns.sh wait`, `providers.sh` |
| U9 | `readOnlyRootFilesystem` does not break the app; the custom node service account attribute is accepted on Autopilot. | first deploy |
| U10 | Cloud Build with a custom service account needs no roles beyond those in `iam.tf`. | first build |
| U11 | CNPG's default `pg_hba` accepts password connections without TLS from the pod network; the DB NetworkPolicy ports are complete. | first deploy |
| U12 | Cost figures against the Google Cloud pricing calculator. | owner to check |
| U13 | `kubectl exec -it` stdin is not recorded in audit logs, and the guided CLI prompt hides or echoes the API key (it marks it `(hidden)` only in its summary). | `providers.sh` |
| U14 | Streaming works for each of OpenAI, Anthropic and Vertex deployments; model IDs in this doc are current. As written, none of the three is tested. | `smoke.sh` |
| U15 | `set-tenant-limits` accepts only the flags used in `providers.sh` (docs show it with a subset) and how omitted flags behave. | `providers.sh` |
| U16 | The master-to-nodes firewall rule on tcp 9443 lets the API server reach the CNPG and cert-manager webhooks (private nodes); `master_cidr` does not overlap your VPC. `down.sh` name filters find the leftovers: forwarding rules `gkegw*`, NEGs `k8s1-*`, disks `pvc-*`. | `operators.sh`, `down.sh` |

## Open issues

One table for platform risks and app-side gaps. Items 2, 4, 5, 9, 12 and 14 are **FIXED (pending review)** in the app by andreas: migrator timeouts, keep-alive 620000, readiness 503 `shutting_down` on SIGTERM with drain, pg keepalive delay, Cloud Logging `severity` and `message`, and `--api-key-stdin` (refuses a TTY, so pipe through `kubectl exec -i`; the scripts use it for every provider key). Remaining caveat: migrations still run at startup with no separate entrypoint (item 3).

| # | Issue | Effect | Recommended fix |
|---|---|---|---|
| 1 | `llm_owner` needs BYPASSRLS (FORCE RLS plus owner SECURITY DEFINER functions). | Needs a real superuser. | CNPG provides one; check [U1]. |
| 2 | FIXED (pending review): migrator pool had the 5 s `query_timeout`. | Was: a wait on the migration lock failed the rollout. | Migrator pool now uses `MIGRATION_LOCK_TIMEOUT_MS` (60000) and `MIGRATION_STATEMENT_TIMEOUT_MS` (600000). Deploys still must not overlap. |
| 3 | Migrations run on every start with no separate command (`src/index.ts`). | A pre-deploy Job needs a code change. | Keep startup migration (new pod migrates, then turns ready; old pods keep serving). Add a `migrate` entry point if a Job is wanted. |
| 4 | FIXED (pending review): Fastify default `keepAliveTimeout` 72 s under Google's ~600 s load balancer reuse. | Was: intermittent 502s. | `HTTP_KEEP_ALIVE_TIMEOUT_MS=620000` in the deployment. |
| 5 | FIXED (pending review): readiness did not turn 503 on shutdown and non-stream requests were not drained. | Was: long requests killed on deploy. | Readiness returns 503 `shutting_down` on SIGTERM; all requests drain. Budget: preStop 10 s + drain 30 s + 15 s allowance + up to 10 s settle = 65 s, under the 90 s grace period [U4]. |
| 6 | Stream caps are per process (`MAX_ACTIVE_STREAMS`, `MAX_STREAMS_PER_TENANT`, 32 each). | Per-tenant cap multiplies by replicas. A CPU HPA cannot see stream load. | Shared cap via `set-tenant-limits --concurrent-streams`; add a stream gauge and scale on it. |
| 7 | The shared tenant lease defaults to 120000 ms (`docs/limits.md`); streams can run 600 s. | The lease expires mid-stream, so the cap under-counts. | Set `--lease-ms 600000` (`providers.sh`). |
| 8 | Up to 20 DB connections per process (two pools of 10). | Limits replicas. | Connection budget below. |
| 9 | FIXED (pending review): pg keepalive had no initial delay. Pools still set `options: '-c search_path=public'`. | PgBouncer would reject the `options` startup parameter unless `ignore_startup_parameters` includes it. | Keep no pooler; see budget. |
| 10 | No DB `ssl` option in `src/db/pools.ts`. | App to Postgres is plaintext on the pod network. | NetworkPolicy limits who can connect. Add an `ssl` option if in-cluster TLS is required. |
| 11 | One `PROVIDER_CREDENTIAL_KEY`, no key versions. | Rotation means re-storing every provider key. | Add key versioning. |
| 12 | FIXED (pending review): logs now carry `severity` and `message`. | Was: Cloud Logging severity DEFAULT. | Filter on `severity`; `level` and `msg` are still present. |
| 13 | No `/metrics` endpoint, no stream gauge. | App signals come from LB metrics and logs. | Add a Prometheus endpoint. |
| 14 | The CLI prints tenant secrets to stdout. Provider keys are passed with `--api-key-stdin` (FIXED, pending review); `--api-key` still exists for interactive use. | Secrets must never reach a logged workload or an exec command line. | Run only via `llm-cli.sh`; never in a Job or CronJob; never use `--api-key` on a shared machine. |
| 15 | Vertex validation needs the in-cluster identity. | Cannot run from a laptop. | `llm-cli.sh`. |
| 16 | Model IDs in docs may be retired. | Provider 404s. | Use current IDs. |
| 17 | Platform: one region, one GCS bucket, one Secret Manager project. | Regional outage means a manual restore elsewhere. | Accepted for an internal tool; dual-region bucket if this changes. |
| 18 | Platform: team IP changes lock people out. | 403s. | VPN with fixed egress; edit `TEAM_CIDRS`. |
| 19 | Platform: lost credential key makes stored provider keys unreadable. | Re-register all keys. | Copy to the team vault. |

## Tool choices

- **OpenTofu** for all of GCP. State in a versioned GCS bucket.
- **Helm** wherever a chart exists (cert-manager, CNPG, optional KEDA). The barman-cloud plugin is installed from its pinned release manifest because no chart is known [U5]. That is the only non-Helm operator.
- **kustomize** for our own manifests: one app, one environment, no conditionals. `kubectl kustomize` is built in.
- **Cloud Build** for images, not local `docker buildx`: builds linux/amd64 from an arm64 Mac without emulation, needs no local Docker, avoids uploading layers from a laptop, and records builds in the project. Cost is covered by free minutes at this volume.
- **Secrets** copied by script from Secret Manager into Kubernetes Secrets. External Secrets or the CSI driver would automate it, but it is another operator for five secrets.
- **One small settings file.** `deploy/gcp/settings.env` (gitignored; `up.sh` writes it from two prompts) holds PROJECT_ID, DOMAIN and optional overrides. `deploy/gcp/env.sh` supplies defaults, derived names and pinned versions. `scripts/gcp/tofu.sh` writes tfvars from it; manifests use `__NAME__` placeholders and scripts fail on any unresolved one.


## Repository layout

```
deploy/gcp/
  settings.env.example       copy of the settings you may override (settings.env is gitignored)
  env.sh                     defaults, derived names, pinned versions
  cloudbuild.yaml            image build
  tofu/persistent/           stack 1: Secret Manager secrets (credential key has prevent_destroy),
                             backup bucket, build staging bucket. Survives down.sh.
  tofu/platform/             stack 2: apis, network, cluster, registry, iam, dns_tls, armor,
                             outputs (main.tf, variables.tf, versions.tf, ...). Removed by down.sh.
                             Lock files are committed.
  k8s/platform/              namespace, Gateway
  k8s/app/                   deployment, service, pdb, networkpolicy, gateway policies, httproute
  k8s/autoscaler/            hpa.yaml, keda.yaml (exactly one is rendered)
  k8s/db/                    CNPG cluster, ObjectStore, ScheduledBackup, networkpolicy
  k8s/drill/                 restore drill cluster
scripts/gcp/                 see scripts/gcp/README.md
```

Read the files themselves; this doc does not copy them.

## How to run it

Manual steps, in order (everything else is `up.sh`):

1. Install tools: `brew install bash helm jq opentofu kubectl openssl python3` (macOS ships bash 3.2; the scripts need bash 5 and stop with an install hint otherwise) and `gcloud components install gke-gcloud-auth-plugin`. gcloud itself from Google.
2. `gcloud auth login`
3. `gcloud auth application-default login` (OpenTofu uses these credentials)
4. Commit `deploy/gcp`, `scripts/gcp` and the `.gitignore` change. `deploy.sh` refuses a dirty git tree because the image tag is the git SHA.
5. `scripts/gcp/up.sh --dry-run` to see every step, then `scripts/gcp/up.sh`.
6. If you have no Cloud DNS zone: when `up.sh` prints the A and CNAME records, create them at your DNS provider. It polls until they resolve and the certificate is ACTIVE.
7. After success: copy Secret Manager secret `llm-provider-credential-key` to the team vault.

`up.sh` prompts for: PROJECT_ID and DOMAIN (first run only), a billing account (only if the project does not exist), allowed IP ranges (default: this machine's public IP, shown for confirmation), "Go ahead?", the OpenTofu plan confirmation, the deploy confirmation, and the OpenAI and Anthropic API keys (hidden input; Enter skips a provider). Re-running after success is safe: finished steps are skipped or only checked, but it still asks "Go ahead?" and "Continue?" (`--yes` skips both), re-applies the manifests, and runs the smoke tests, which make small billable calls to your providers (`--skip-smoke` skips them). Settings are validated (project id, domain, CIDRs, replica and PDB numbers) before anything is written. `--yes` skips ordinary confirmations only; typed confirmations (tofu destroy, down.sh, purge.sh) always need a terminal.

What `up.sh` does, in order: `bootstrap.sh` (project, billing check, APIs, state bucket), `infra.sh` (tofu plan for both stacks, confirm, apply; any plan with a destroy is called out and needs a typed `destroy <stack>`), `dns.sh show`, `operators.sh` (cert-manager, CNPG, barman plugin), `secrets.sh` (random passwords and credential key into Secret Manager, then Kubernetes Secrets), `database.sh` + `db-bootstrap.sh`, `deploy.sh` (Cloud Build, manifests, rollout), `providers.sh` (tenant, OpenAI, Anthropic, Vertex, streaming, alias `auto`), `dns.sh wait`, `smoke.sh` (each provider plain and streaming).

Secrets: generated and stored in Secret Manager automatically; provider keys reach the CLI on stdin only (`--api-key-stdin`), never argv; the tenant secret is kept in Secret Manager secret `llm-tenant-default` and passed to curl on stdin.

## App tuning env vars

The "APP TUNING" block in `deploy/gcp/k8s/app/deployment.yaml` sets `MIGRATION_LOCK_TIMEOUT_MS=60000`, `MIGRATION_STATEMENT_TIMEOUT_MS=600000` and `HTTP_KEEP_ALIVE_TIMEOUT_MS=620000` (each 1000 to 3600000). Keep-alive must stay above the load balancer's ~600 s backend keepalive. Shutdown budget: preStop 10 s + drain 30 s + 15 s allowance + up to 10 s settle = 65 s, under `terminationGracePeriodSeconds: 90` [U4]. Startup budget: startupProbe 5 s x 150 = 750 s, rollout wait 900 s (`progressDeadlineSeconds: 900`), so a migration that takes the full 600 s statement timeout still fits. A separate migrate step remains a future option (item 3). Keep a preStop sleep, because the process now exits at once when nothing is in flight. These are not user-tunable in `settings.env`.

## Pinned versions

Set in `deploy/gcp/env.sh`. Checked on 2026-10-22 by reading upstream indexes: cert-manager v1.21.2, cloudnative-pg chart 0.29.1 (operator 1.30.1), barman-cloud plugin v0.15.1 (manifest and CRD fields read), Postgres image 16.15-standard-bookworm (tag exists), google provider ~> 7.0 (lock resolved 7.46.1). **Not checked:** KEDA chart 2.21.0 (taken from a GitHub tag), and that these versions work together on a live cluster [U5]. helm was not installed on the authoring machine, so the helm invocations in `operators.sh` have never been run.

## Local verification done

`tofu fmt -check`, `tofu init -backend=false` and `tofu validate` for each stack; the mocked-command tests in `scripts/gcp/tests/run.sh` (settings and CIDR validation, key-fetch failure, helm release status, down.sh abort, secrets off argv and idempotent re-apply, release record byte round-trip, fail-closed plan inspection, deletion-protection step, teardown orphan checks, database fresh/restore paths, tenant-missing check) plus a throwaway local `postgres:16` run of `db-verify.sql` when that image is present; `shellcheck -x` and `bash -n` on every script; `kubectl kustomize` and the `render` placeholder check for every manifest directory; `up.sh --dry-run` with fake settings. No cloud command that changes anything was run.

## Restore drill

`scripts/gcp/restore-drill.sh [--time "YYYY-MM-DD HH:MM:SS+00"]` recovers the backups bucket into a throwaway cluster `drill` in namespace `llm-drill` (manifest: `deploy/gcp/k8s/drill/drill.yaml`, which has no `plugins:` block so it cannot write WAL into production's path) using its own read-only identity, GSA `llm-pg-restore` (objectViewer on the backup bucket, Workload Identity bound to `llm-drill/drill`). The Workload Identity binding is fixed to those names, so the script creates the namespace with `kubectl create` (it fails if one exists: clean slate) and, on exit, reports anything it left behind. It prints the duration and the latest migration version, then asks before deleting; on yes it waits for the namespace to go and for the drill's persistent disks to disappear before it considers the drill cleaned up. Run it after the first backup, monthly, and after operator upgrades. Record the measured time as the RTO.

## Monitoring and alerts

Managed Prometheus is on in Autopilot. The app exposes no `/metrics` (open issue 13), so app signals come from the load balancer and logs.

| Alert | Symptom users feel | Signal | Action |
|---|---|---|---|
| Availability burn | errors | LB `https/request_count` 5xx over total, 5 min, SLO 99.5% | `status.sh`, pod logs, DB |
| Not ready | failed requests | unavailable replicas > 0 for 10 min, or container restarts rising | readiness: DB down or migration failed |
| Backup stale | silent data-loss risk | CNPG last-backup timestamp older than 36 h [U5] | ScheduledBackup, bucket IAM |
| WAL archive failing | PITR gap | CNPG archiver failed count increasing [U5] | plugin sidecar, bucket |
| Replica lag | failover would lose data | replication lag > 60 s for 10 min [U5] | storage, node |
| Database disk | outage when full | PVC usage above 80% | resize PVC |

Provider errors: a log-based metric on `severity>=ERROR`. App logs carry Cloud Logging `severity` and `message`; `level` and `msg` are still present. Alert-worthy events use `severity=CRITICAL`. CPU and memory are tickets, not pages. Every alert links to the Day-2 section as its runbook; an alert nobody acts on is deleted.

Scrape CNPG metrics:

```yaml
apiVersion: monitoring.googleapis.com/v1
kind: PodMonitoring
metadata: { name: llm-pg, namespace: llm-proxy }
spec:
  selector: { matchLabels: { cnpg.io/cluster: llm-pg } }
  endpoints: [{ port: metrics, interval: 30s }]     # [U5] port name
```

A Cloud Monitoring uptime check would be blocked by the Cloud Armor allowlist; rely on the LB error rate instead. Log filter: `resource.type="k8s_container" resource.labels.namespace_name="llm-proxy" severity>=ERROR`.

## Cost estimate

**Estimate** in USD per month, using list prices recalled from memory (Autopilot about 0.045 per vCPU-hour and 0.005 per GiB-hour in us-central1, 730 hours). Not checked against the current price list [U12]. Owner to check against the pricing calculator.

| Item | Estimate |
|---|---|
| App pod 0.5 vCPU / 0.5 GiB (min 1) | 17 |
| Postgres 2 x (1 vCPU / 2 GiB) | 80 |
| Operator pods (CNPG, cert-manager, barman plugin) | 15 |
| Disks 2 x (20 + 10 GiB) SSD | 10 |
| GKE cluster fee (a free credit may cover one cluster) | 0 to 73 |
| HTTPS load balancer | 20 |
| Cloud Armor | 10 |
| Cloud NAT and static IPs | 35 |
| GCS, Artifact Registry, Secret Manager, logging | 5 to 15 |
| **Total** | **about 190 to 280** |

Provider token spend is separate; see [Limits](limits.md). A second app replica adds about 17. A single database instance saves about 40. Removing Cloud NAT requires public nodes (saves about 35, exposes node IPs).

## Day-2 operations

| Task | How |
|---|---|
| See state | `scripts/gcp/status.sh`, `scripts/gcp/logs.sh` |
| Deploy | `scripts/gcp/deploy.sh` |
| Roll back | `scripts/gcp/rollback.sh <sha>` (or `--list`). Every deploy records a ConfigMap `llm-release-<time>-<sha>` with the rendered bundle and its hash (newest 20 kept); rollback verifies the hash and re-applies that bundle. |
| Add tenant or provider | `scripts/gcp/llm-cli.sh ...`; rotate a provider key with `rotate-provider-key.sh openai\|anthropic` |
| Rotate a role password | new Secret Manager version, `ALTER ROLE` via `kubectl exec ... psql`, `secrets.sh`, `kubectl rollout restart deploy/llm-proxy` |
| Rotate `PROVIDER_CREDENTIAL_KEY` | not supported (open issue 11): change the key, then re-store every provider key |
| Change team IPs | `scripts/gcp/add-team-ip.sh [--remove] [cidr]` |
| Open a DB shell | `kubectl -n llm-proxy exec -it llm-pg-1 -c postgres -- psql -U postgres llm_proxy` |
| Force a failover | `kubectl cnpg promote llm-pg llm-pg-2` (needs the cnpg kubectl plugin) |
| On-demand backup | `scripts/gcp/backup-now.sh` |

Incident checklist: `status.sh`; is `/health/ready` 200 (DB reachable and migrated)?; app logs filtered on `severity>=ERROR`; did the last deploy change anything (`rollback.sh` is safe only for additive migrations); cluster `Ready`; Cloud Armor 403s in the LB logs for a new IP.

## Upgrades

| What | How | Watch |
|---|---|---|
| GKE | Release channel REGULAR upgrades automatically. Set a maintenance window in tofu. | brief outage with 1 replica |
| App | `deploy.sh` | rollout status, `/health/ready` |
| CNPG operator, cert-manager, plugin | bump the version in `deploy/gcp/env.sh`, re-run `operators.sh` after reading release notes | cluster status; the operator may roll Postgres pods. Run the restore drill afterwards |
| Postgres minor | change `CNPG_POSTGRES_IMAGE`, apply; CNPG updates the replica, then switches over | replication lag, app 503s |
| Postgres major | 16 is the only version used locally (`docs/operations.md` says other majors with row-level security can work). Rehearse on a staging cluster with the test suite and the restore drill, then use CNPG import into a new cluster. | plan it as a project |
| KEDA | bump the chart version | scaling still works |

Read `tofu plan` or `helm diff` before applying any of these to production.

## Teardown

`scripts/gcp/down.sh` destroys the platform stack only. It first checks read-only that the cluster exists and the Kubernetes API answers; if the API is unreachable it stops and deletes nothing. Typed confirmations, in order: the project id (removes Gateway/HTTPRoute, waits until the load balancer forwarding rules, NEGs and `pvc-` disks are gone, then the cluster), and `delete database` (Postgres cluster and disks) only if the database exists. `--yes` does not skip them. Order: the drill namespace, Gateway/HTTPRoute, the database, then a check that no `gkegw` load balancer parts, `k8s1-` NEGs or `pvc-` disks remain (this check runs even if the cluster is already gone, so orphans from an earlier partial run are found), then the cluster's deletion protection is turned off with a saved targeted plan (skipped when the cluster is absent; refused if the plan would create or replace anything), then destroy. The persistent stack (backup bucket, Secret Manager secrets including the credential key) is kept. The project and state bucket are left for you. Take a final backup and run the restore drill first.

### Coming back after a teardown (recovery)

`up.sh` stops at `database.sh` if the backups bucket holds backups and cluster `llm-pg` is absent: a fresh database must not write WAL next to the archive you need. Recover instead:

1. `scripts/gcp/database.sh --restore [--from SERVER] [--time "YYYY-MM-DD HH:MM:SS+00"]`. `--from` is the server name inside the bucket (default `llm-pg`; list with `gcloud storage ls gs://<project>-llm-pg-backup/`). Without `--time` it recovers to the end of the archived WAL. It asks before creating anything.
2. The restored cluster archives under a NEW server name `llm-pg-r<timestamp>`; the old prefix is left untouched. Run `scripts/gcp/backup-now.sh` right away so the new archive has a base backup.
3. Re-run `scripts/gcp/up.sh`; finished steps are skipped. `providers.sh` stops if the tenant secret exists but the tenant is not in the database (it means the database was not restored).

Secrets must be retained (do not run `purge.sh`): the restored database holds provider keys encrypted with `llm-provider-credential-key`. If you only want a new, empty database, `purge.sh` the old backups first.

Re-running `database.sh` on a restored cluster re-applies the recovery manifests (it reads the live cluster to choose them), never the fresh-database ones.

## Image retention

Artifact Registry tags are immutable (git SHA) and kept indefinitely: the registry has no cleanup policy, because the previous one could not be shown to work and rollback needs old images. Cost is small for an internal team (one image is roughly 0.4 GB uncompressed; storage is about 0.10 USD per GB-month, from memory, check current pricing). Prune by hand when it matters; keep the digest of every release you may still roll back to (`rollback.sh --list`):

```
gcloud artifacts docker images list REGION-docker.pkg.dev/PROJECT/REPO/IMAGE --include-tags
gcloud artifacts docker images delete REGION-docker.pkg.dev/PROJECT/REPO/IMAGE@sha256:DIGEST --delete-tags
```

## Known limits

Accepted for a first run by an internal team. Each has a manual way out.

- **Provider key rotation can commit ambiguously.** If `rotate-provider-key.sh` is interrupted or the CLI answer is lost, the new key may or may not be live. Re-run it (it is safe to repeat), then check with the CLI `list-inference` which connection version is current, and make a test call.
- **Tenant creation can leave a duplicate.** A crash between the CLI creating the tenant and `providers.sh` recording it can create a second tenant on re-run. The CLI has no tenant list or delete command. The extra tenant has no provider connections and its key secret was never stored, so it is inert; if you want it gone, find it with `psql` on the primary (`kubectl -n llm-proxy exec llm-pg-1 -c postgres -- psql -U postgres -d llm_proxy`) and revoke any key with `llm-cli.sh revoke-key`. The tenant the scripts use is the one in Secret Manager secret `llm-tenant-default`.
- **Migrations run at startup, with a 750 s startup budget.** If one takes longer, pods never become ready and the rollout fails. Raise `startupProbe.failureThreshold`, `progressDeadlineSeconds` and `MIGRATION_STATEMENT_TIMEOUT_MS` (max 3600000) in `deploy/gcp/k8s/app/deployment.yaml` and re-run `deploy.sh`. A separate migrate step does not exist yet.
- **Rollback picks the newest record per git SHA.** Two releases of the same SHA (different image digests) are not distinguishable; `rollback.sh --list` shows what is recorded. Release records are ConfigMaps labelled `app=llm-proxy-release` (`kubectl -n llm-proxy get configmap -l app=llm-proxy-release`).
- **Do not point these scripts at a project deployed by an older version of them.** There is no state migration guard; use a fresh project or import by hand.
- **`docker/postgres/init.sh` takes passwords on argv.** That is the local compose path only; the GKE path passes them on stdin.

## Related

- [Operations](operations.md): database roles, migrations, health checks
- [Streaming](streaming.md): stream timeouts and shutdown behavior
- [Providers](providers.md): connections and deployments
- [Tenants](tenants.md), [Limits](limits.md), [Architecture](architecture.md)
