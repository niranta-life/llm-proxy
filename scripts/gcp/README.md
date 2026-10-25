# GCP deployment scripts

Everything runs from your Mac. Design and decisions: `docs/gcp-deployment.md`.

## Quick start

1. Install tools and log in (details: "Before the first run" below).
2. See what would happen, changing nothing:
   `PROJECT_ID=my-project DOMAIN=llm.example.com scripts/gcp/up.sh --dry-run`
3. Run it: `scripts/gcp/up.sh`

`up.sh` needs `PROJECT_ID` and `DOMAIN` (from the environment, `deploy/gcp/settings.env`,
or it asks) and also asks which IP addresses may reach the API (default: this machine).
Every setting is described in `deploy/gcp/settings.env.example`.

## Before the first run

- Tools: bash 5+ (macOS ships 3.2: `brew install bash`), python3, gcloud (with `gke-gcloud-auth-plugin`), tofu (OpenTofu), kubectl, helm,
  jq, git, curl, openssl. Each script says how to install a missing one.
- `gcloud auth login` and `gcloud auth application-default login`.
- Commit `deploy/gcp` and `scripts/gcp` (`deploy.sh` refuses a dirty git tree).

## Scripts you run

| Script | Use |
|--------|-----|
| `up.sh [--dry-run] [--yes] [--skip-smoke]` | Everything, from empty project to smoke-tested. Safe to repeat. |
| `deploy.sh [sha]` | Build and roll out the current commit (or an existing image). Records a release. |
| `rollback.sh <sha>` / `--list` | Put back a recorded release (same image digest and manifests). |
| `status.sh` | Health check; non-zero exit on failure. |
| `smoke.sh` | Plain and streaming calls through the public URL, per enabled deployment. |
| `logs.sh [flags]` | Follow app logs. |
| `llm-cli.sh <args>` | Operator CLI in the pod. `--interactive` works. |
| `rotate-provider-key.sh openai\|anthropic` | New provider key (hidden prompt, stdin only). |
| `add-team-ip.sh [--remove] [cidr]` | Change who may reach the API and cluster. |
| `backup-now.sh` | On-demand database backup. |
| `restore-drill.sh [--time T]` | Restore backups into a throwaway cluster; prints duration. |
| `down.sh` | Tear down the platform. Keeps backups, secrets, state. Typed confirmations. |
| `purge.sh` | After `down.sh`: delete backups and secrets. Typed confirmation. |

## Step scripts (`up.sh` runs these in order; each can be run alone)

`bootstrap.sh` (project, billing, state bucket), `infra.sh` (OpenTofu, both stacks),
`dns.sh show|wait`, `operators.sh` (cert-manager, CloudNativePG, backup plugin, KEDA),
`secrets.sh`, `database.sh`, `build.sh`, `deploy.sh`, `providers.sh`, `smoke.sh`.

## Helpers (not run directly)

- `common.sh`: shared functions (settings, validation, prompts, kubectl, Secret Manager, manifests).
- `lib-deploy.sh`: rollout, gateway checks, autoscaler handoff and release records for `deploy.sh` and `rollback.sh`.
- `tofu.sh <persistent|platform> <args>`: runs OpenTofu for one stack with generated variables.
- `db-bootstrap.sh`: creates and verifies the four database roles. `database.sh` is different:
  it creates the Postgres cluster and then calls `db-bootstrap.sh`. With `--restore [--from SERVER] [--time T]` it
  creates the cluster from the backups bucket instead (it refuses a fresh one when backups exist).
- `lib-plan.sh`, `lib-down.sh`: fail-closed plan inspection and teardown helpers.

## Conventions

- Every script accepts `-h` or `--help`.
- `up.sh --dry-run` (or `DRY_RUN=1`) makes the scripts print what they would do and stop before any
  remote call or file write; the checks of local tools and settings still run.
- `--yes` / `YES=1` skips yes/no prompts only. Destructive steps (a plan that destroys resources,
  `down.sh`, `purge.sh`) always need a typed confirmation and a terminal.
- Tests: `scripts/gcp/tests/run.sh` (stubbed gcloud, kubectl, helm, tofu; touches nothing remote).
