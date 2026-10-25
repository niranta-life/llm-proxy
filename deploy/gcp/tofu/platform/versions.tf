terraform {
  required_version = ">= 1.8"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # Bucket and prefix are passed by scripts/gcp/tofu.sh (-backend-config).
  # This stack has its own state prefix so that tearing down the platform can
  # never touch the secrets or the backups.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Bill API calls to this project; needed with user (ADC) credentials.
  user_project_override = true
  billing_project       = var.project_id
}
