# Values come from deploy/gcp/settings.env through
# generated.auto.tfvars.json, written by scripts/gcp/tofu.sh.

variable "project_id" {
  description = "GCP project that holds everything."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id (6 to 30 characters, lowercase letters, digits, hyphens)."
  }
}

variable "region" {
  description = "Region for the cluster, registry, and NAT."
  type        = string

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must look like us-central1."
  }
}

variable "domain" {
  description = "Public host name, for example llm.example.com."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a lowercase host name such as llm.example.com."
  }
}

variable "team_cidrs" {
  description = "IP ranges allowed through Cloud Armor and to the cluster API (at most 50)."
  type        = list(string)

  validation {
    condition     = length(var.team_cidrs) >= 1 && length(var.team_cidrs) <= 50
    error_message = "team_cidrs needs between 1 and 50 ranges (the cluster API allows at most 50)."
  }

  validation {
    condition     = alltrue([for c in var.team_cidrs : can(cidrhost(c, 0))])
    error_message = "every team_cidrs entry must be a CIDR such as 203.0.113.7/32."
  }
}

variable "dns_zone" {
  description = "Cloud DNS managed zone (name) that holds the domain. Empty means DNS is managed by hand."
  type        = string
  default     = ""

  validation {
    condition     = var.dns_zone == "" || can(regex("^[a-z]([-a-z0-9]*[a-z0-9])?$", var.dns_zone))
    error_message = "dns_zone must be a Cloud DNS managed zone name (lowercase letters, digits, hyphens), or empty."
  }
}

variable "deletion_protection" {
  description = "Protects the GKE cluster from deletion. down.sh sets TF_VAR_deletion_protection=false."
  type        = bool
  default     = true
}

variable "master_cidr" {
  description = "Private /28 for the GKE control plane. Must not overlap 10.10.0.0/20, 10.20.0.0/16 or 10.30.0.0/20."
  type        = string
  default     = "172.16.0.0/28"
}
