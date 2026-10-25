output "lb_ip" {
  description = "Create an A record for the domain pointing here (when dns_zone is empty)."
  value       = google_compute_global_address.lb.address
}

output "nat_ip" {
  description = "Fixed egress IP of the cluster."
  value       = google_compute_address.nat.address
}

output "cert_dns_auth" {
  description = "CNAME that proves domain ownership to Certificate Manager (when dns_zone is empty)."
  value = {
    name = google_certificate_manager_dns_authorization.auth.dns_resource_record[0].name
    type = google_certificate_manager_dns_authorization.auth.dns_resource_record[0].type
    data = google_certificate_manager_dns_authorization.auth.dns_resource_record[0].data
  }
}

output "dns_managed" {
  value = local.manage_dns
}
