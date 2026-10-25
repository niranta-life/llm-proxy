resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "llm-proxy"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true # a git SHA tag can never be overwritten
  }

  # Retention: indefinite, on purpose. No cleanup policy.
  # With immutable tags, a DELETE policy cannot prune a version that carries a git-SHA tag
  # (the tag is what makes the version immutable), so it would never delete a build, and a
  # KEEP policy alone deletes nothing. Every build therefore stays, and rollback.sh can reach
  # all of them. Cost: images are small (the local build is 436 MB uncompressed; storage
  # is roughly 0.10 USD per GB-month, from memory). Prune by hand if it ever matters; the command is in docs/gcp-deployment.md
  # ("Image retention").

  depends_on = [google_project_service.api]
}

# Created by the persistent stack (apply that first). Read here so the IAM below can
# be scoped to these buckets.
data "google_storage_bucket" "pg_backup" {
  name = "${var.project_id}-llm-pg-backup"
}

data "google_storage_bucket" "build_staging" {
  name = "${var.project_id}-llm-build-staging"
}
