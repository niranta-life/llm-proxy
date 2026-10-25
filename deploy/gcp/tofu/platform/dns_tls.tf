# Static IP, Google-managed certificate (DNS-authorized, so it can issue before
# the A record exists), Cloud DNS records when dns_zone is set, and the TLS policy.

locals {
  manage_dns = var.dns_zone != ""
}

resource "google_compute_global_address" "lb" {
  name = "llm-proxy-lb"

  depends_on = [google_project_service.api]
}

resource "google_certificate_manager_dns_authorization" "auth" {
  name   = "llm-proxy"
  domain = var.domain

  depends_on = [google_project_service.api]
}

resource "google_certificate_manager_certificate" "cert" {
  name = "llm-proxy"

  managed {
    domains            = [var.domain]
    dns_authorizations = [google_certificate_manager_dns_authorization.auth.id]
  }

  depends_on = [google_project_service.api]
}

resource "google_certificate_manager_certificate_map" "map" {
  name = "llm-proxy"

  depends_on = [google_project_service.api]
}

resource "google_certificate_manager_certificate_map_entry" "entry" {
  name         = "llm-proxy"
  map          = google_certificate_manager_certificate_map.map.name
  certificates = [google_certificate_manager_certificate.cert.id]
  hostname     = var.domain
}

resource "google_dns_record_set" "cert_auth" {
  count        = local.manage_dns ? 1 : 0
  managed_zone = var.dns_zone
  name         = google_certificate_manager_dns_authorization.auth.dns_resource_record[0].name
  type         = google_certificate_manager_dns_authorization.auth.dns_resource_record[0].type
  ttl          = 300
  rrdatas      = [google_certificate_manager_dns_authorization.auth.dns_resource_record[0].data]
}

resource "google_dns_record_set" "a" {
  count        = local.manage_dns ? 1 : 0
  managed_zone = var.dns_zone
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.lb.address]
}

# Minimum TLS 1.2; attached by the GCPGatewayPolicy in k8s/app. Not yet verified on a live cluster: see "Verify first" U6 in docs/gcp-deployment.md.
resource "google_compute_ssl_policy" "modern" {
  name            = "llm-proxy-modern"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"

  depends_on = [google_project_service.api]
}
