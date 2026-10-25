# Only team IP ranges get past the load balancer. Everything else gets 403.
#
# A Cloud Armor rule matches at most 10 source ranges, so the allowlist is split
# into one allow rule per 10 ranges (priorities 1000, 1001, ...).

locals {
  team_cidr_chunks = chunklist(var.team_cidrs, 10)
}

resource "google_compute_security_policy" "team_only" {
  name = "llm-proxy-team-only"

  dynamic "rule" {
    for_each = local.team_cidr_chunks
    content {
      action      = "allow"
      priority    = 1000 + rule.key
      description = "team ranges ${rule.key + 1}"

      match {
        versioned_expr = "SRC_IPS_V1"

        config {
          src_ip_ranges = rule.value
        }
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 2147483647
    description = "default deny"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [google_project_service.api]
}
