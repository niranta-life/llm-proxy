#!/bin/sh
# Replace the runtime certificate and reload Nginx.
# Do not print the private key.
set -eu
/bin/sh /usr/local/bin/install-certs
nginx -s reload
echo "ingress reloaded"
