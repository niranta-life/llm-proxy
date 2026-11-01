#!/bin/sh
# Copy the mounted certificate into the runtime directory.
# Do not print the private key.
set -eu
if [ ! -f /etc/nginx/ingress/server.crt ] || [ ! -f /etc/nginx/ingress/server.key ] || [ ! -f /etc/nginx/ingress/ca.crt ]; then
  echo "ingress certificate files are missing" >&2
  exit 1
fi
openssl x509 -in /etc/nginx/ingress/server.crt -noout >/dev/null
openssl x509 -in /etc/nginx/ingress/ca.crt -noout >/dev/null
mkdir -p /etc/nginx/tls
cp /etc/nginx/ingress/server.crt /etc/nginx/tls/server.crt
cp /etc/nginx/ingress/server.key /etc/nginx/tls/server.key
cp /etc/nginx/ingress/ca.crt /etc/nginx/tls/ca.crt
chown nginx:nginx /etc/nginx/tls/server.crt /etc/nginx/tls/server.key /etc/nginx/tls/ca.crt
chmod 644 /etc/nginx/tls/server.crt /etc/nginx/tls/ca.crt
chmod 640 /etc/nginx/tls/server.key
