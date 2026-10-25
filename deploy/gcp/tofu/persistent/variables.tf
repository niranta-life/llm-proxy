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
  description = "Region for the buckets."
  type        = string

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must look like us-central1."
  }
}
