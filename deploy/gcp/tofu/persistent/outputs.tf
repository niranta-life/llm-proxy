output "backup_bucket" {
  description = "Bucket that holds the database base backups and WAL."
  value       = google_storage_bucket.pg_backup.name
}

output "build_staging_bucket" {
  description = "Bucket that holds Cloud Build source archives."
  value       = google_storage_bucket.build_staging.name
}
