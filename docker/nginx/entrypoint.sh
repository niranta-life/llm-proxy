#!/bin/sh
set -eu
/bin/sh /usr/local/bin/install-certs
exec nginx -g 'daemon off;'
