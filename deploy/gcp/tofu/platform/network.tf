# Private nodes reach OpenAI and Anthropic through Cloud NAT, which also gives
# the cluster one fixed egress IP.

resource "google_compute_network" "vpc" {
  name                    = "llm-proxy"
  auto_create_subnetworks = false

  depends_on = [google_project_service.api]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "llm-proxy-gke"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}

resource "google_compute_address" "nat" {
  name   = "llm-proxy-nat"
  region = var.region

  depends_on = [google_project_service.api]
}

resource "google_compute_router" "router" {
  name    = "llm-proxy"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "llm-proxy"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
