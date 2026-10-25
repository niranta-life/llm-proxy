resource "google_storage_bucket" "pg_backup" {
  name                        = "${var.project_id}-llm-pg-backup"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false # scripts/gcp/purge.sh empties it after a typed confirmation

  depends_on = [google_project_service.api]
}

# Cloud Build uploads the source archive here (build.sh passes --gcs-source-staging-dir).
# Managed so that it has a lifecycle rule and a scoped reader, instead of the
# bucket gcloud would create implicitly. Source archives are disposable.
resource "google_storage_bucket" "build_staging" {
  name                        = "${var.project_id}-llm-build-staging"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 14
    }
  }

  depends_on = [google_project_service.api]
}
