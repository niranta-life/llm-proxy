# Five identities, each with the least it needs:
#   app      Vertex AI calls (Workload Identity, no key)
#   backup   object admin on the one backup bucket (production Postgres only)
#   restore  read-only on the backup bucket (restore drill only)
#   nodes    logs, metrics, image pulls
#   build    Cloud Build: push images, write logs, read the source staging bucket

resource "google_service_account" "app" {
  account_id   = "llm-proxy-app"
  display_name = "llm-proxy app (Vertex AI)"

  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "app_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.app.email}"
}

resource "google_service_account_iam_member" "app_wi" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[llm-proxy/llm-proxy]"

  depends_on = [google_container_cluster.main]
}

resource "google_service_account" "backup" {
  account_id   = "llm-pg-backup"
  display_name = "CloudNativePG backups"

  depends_on = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "backup" {
  bucket = data.google_storage_bucket.pg_backup.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.backup.email}"
}

# Only the production Postgres service account (llm-pg) uses the backup identity.
resource "google_service_account_iam_member" "backup_wi" {
  service_account_id = google_service_account.backup.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[llm-proxy/llm-pg]"

  depends_on = [google_container_cluster.main]
}

# The restore drill reads backups; it must not be able to delete or overwrite them.
resource "google_service_account" "restore" {
  account_id   = "llm-pg-restore"
  display_name = "CloudNativePG restore drill (read-only)"

  depends_on = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "restore" {
  bucket = data.google_storage_bucket.pg_backup.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.restore.email}"
}

resource "google_service_account_iam_member" "restore_wi" {
  service_account_id = google_service_account.restore.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[llm-drill/drill]"

  depends_on = [google_container_cluster.main]
}

resource "google_service_account" "nodes" {
  account_id   = "llm-proxy-nodes"
  display_name = "GKE nodes"

  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_artifact_registry_repository_iam_member" "nodes_pull" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.nodes.email}"
}

# Used by scripts/gcp/build.sh through --service-account.
# Not yet verified on a live cluster: see "Verify first" U10 in docs/gcp-deployment.md.
resource "google_service_account" "build" {
  account_id   = "llm-proxy-build"
  display_name = "Cloud Build for llm-proxy"

  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "build" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.build.email}"
}

# Read the uploaded source archive: this bucket only, not every bucket in the project
# (which would include the database backups and the OpenTofu state).
resource "google_storage_bucket_iam_member" "build_source" {
  bucket = data.google_storage_bucket.build_staging.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.build.email}"
}

resource "google_artifact_registry_repository_iam_member" "build_push" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build.email}"
}
