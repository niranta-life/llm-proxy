#!/bin/sh
# Report Nginx readiness and application readiness.
set -eu
body="$(curl -fsS --cacert /etc/nginx/ingress/ca.crt https://127.0.0.1/health/ingress)"
printf '%s\n' "$body"
printf '%s\n' "$body" | grep -q '"nginx":"ready"'
printf '%s\n' "$body" | grep -q '"application":"ready"'
