# Secret Manager containers only. Values are added by scripts, never by OpenTofu,
# so no secret value ever lands in state.
#
# These live in the persistent stack: scripts/gcp/down.sh must never delete them.
# Without llm-provider-credential-key a restored database cannot decrypt the
# stored provider keys.

locals {
  secrets = [
    "llm-migrator-password",
    "llm-auth-password",
    "llm-runtime-password",
    "llm-pg-superuser-password",
    "llm-openai-api-key",
    "llm-anthropic-api-key",
    "llm-tenant-default",
  ]
}

resource "google_secret_manager_secret" "s" {
  for_each  = toset(local.secrets)
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.api]
}

# The one secret whose loss makes backups useless. prevent_destroy makes any plan
# that would delete it fail. scripts/gcp/purge.sh removes it from state first and
# deletes it itself, after a typed confirmation.
resource "google_secret_manager_secret" "credential_key" {
  secret_id = "llm-provider-credential-key"

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.api]
}
