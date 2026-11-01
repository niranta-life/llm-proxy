#!/bin/sh
# Report certificate valid or certificate expired.
# Do not print the private key.
set -eu
cert="${1:-/etc/nginx/ingress/server.crt}"
case "$cert" in
  *.key)
    echo "certificate check refuses a private key path" >&2
    exit 2
    ;;
esac
if [ ! -f "$cert" ]; then
  echo "certificate file is missing" >&2
  exit 2
fi
if grep -q "PRIVATE KEY" "$cert"; then
  echo "certificate check refuses a private key" >&2
  exit 2
fi
if openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1; then
  echo "certificate valid"
  exit 0
fi
echo "certificate expired"
exit 1
