# Only the APIs this stack needs. The platform stack enables the rest; enabling
# the same API from both stacks is harmless, and neither disables on destroy.

resource "google_project_service" "api" {
  for_each = toset([
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}
