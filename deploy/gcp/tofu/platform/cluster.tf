resource "google_container_cluster" "main" {
  name                = "llm-proxy"
  location            = var.region
  enable_autopilot    = true
  network             = google_compute_network.vpc.id
  subnetwork          = google_compute_subnetwork.gke.id
  deletion_protection = var.deletion_protection

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false # kubectl from the team, limited below
    master_ipv4_cidr_block  = var.master_cidr
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.team_cidrs
      content {
        cidr_block   = cidr_blocks.value
        display_name = "team"
      }
    }
  }

  # Custom node identity instead of the default Compute service account.
  # Not yet verified on a live cluster: see "Verify first" U9 in docs/gcp-deployment.md.
  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]

    managed_prometheus {
      enabled = true
    }
  }

  depends_on = [
    google_project_service.api,
    google_project_iam_member.nodes,
    google_artifact_registry_repository_iam_member.nodes_pull,
  ]
}

# The control plane calls admission webhooks that listen on 9443 (CloudNativePG and
# KEDA charts). GKE opens 443 and 10250 from the control plane by itself, not 9443,
# so without this rule creating a Postgres Cluster can fail with a webhook timeout.
# Scoped to the control plane range, the node identity, and one port.
# Not yet verified on a live cluster: see "Verify first" U16 in docs/gcp-deployment.md.
resource "google_compute_firewall" "master_to_webhooks" {
  name      = "llm-proxy-master-to-webhooks"
  network   = google_compute_network.vpc.name
  direction = "INGRESS"

  source_ranges           = [var.master_cidr]
  target_service_accounts = [google_service_account.nodes.email]

  allow {
    protocol = "tcp"
    ports    = ["9443"]
  }
}
