#!/bin/sh
# Issue a local CA and a server certificate into a directory.
# Usage: issue-certificate.sh <directory> <name> <valid|expired>
# Do not print the private key.
set -eu
dir="${1:?directory}"
name="${2:?name}"
mode="${3:?valid or expired}"
mkdir -p "$dir"
chmod 700 "$dir"
ext="$dir/server.ext"
cat > "$ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EOF
if [ ! -f "$dir/ca.key" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$dir/ca.key" 2>/dev/null
  chmod 600 "$dir/ca.key"
  openssl req -new -x509 -key "$dir/ca.key" -sha256 -days 825 -out "$dir/ca.crt" \
    -subj "/CN=llm-proxy-${name}-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 644 "$dir/ca.crt"
fi
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$dir/server.key" 2>/dev/null
chmod 600 "$dir/server.key"
openssl req -new -key "$dir/server.key" -out "$dir/server.csr" -subj "/CN=localhost"
if [ "$mode" = "expired" ]; then
  openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
    -out "$dir/server.crt" -sha256 \
    -not_before 20200101000000Z -not_after 20200102000000Z \
    -extfile "$ext"
elif [ "$mode" = "valid" ]; then
  openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
    -out "$dir/server.crt" -sha256 -days 825 \
    -extfile "$ext"
else
  echo "certificate mode must be valid or expired" >&2
  exit 2
fi
chmod 644 "$dir/server.crt"
rm -f "$dir/server.csr" "$ext" "$dir/ca.srl"
echo "certificate ${mode}"
openssl x509 -in "$dir/server.crt" -noout -subject -issuer -dates -serial
