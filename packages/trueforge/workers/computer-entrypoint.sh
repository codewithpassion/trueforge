#!/bin/sh
# Trust the egress CA, then hand over to computerd.
#
# When Cloudflare intercepts the container's outbound HTTPS it terminates TLS with a CA it mints for
# this container at start time, so the certificate cannot be baked into the image and every HTTPS
# call from the sandbox fails to verify until it is in the trust store.
set -eu

CA_SOURCE=/etc/cloudflare/certs/cloudflare-containers-ca.crt
CA_TARGET=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt
CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# The certificate is written as the container comes up, so wait briefly instead of racing it.
attempt=0
while [ ! -s "$CA_SOURCE" ] && [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
done

# Tested inside the `if`, so a container that cannot trust the CA still starts with broken HTTPS
# rather than not starting at all, which the platform only reports as "Container failed to start".
if [ -s "$CA_SOURCE" ]; then
  if cp "$CA_SOURCE" "$CA_TARGET" && update-ca-certificates >/dev/null 2>&1; then
    # certifi users (requests, httpx) read neither the system store nor each other's.
    REQUESTS_CA_BUNDLE="$CA_BUNDLE"
    SSL_CERT_FILE="$CA_BUNDLE"
    export REQUESTS_CA_BUNDLE SSL_CERT_FILE
  else
    echo 'trueforge: could not trust the Cloudflare egress CA; HTTPS from the sandbox will not verify' >&2
  fi
else
  # Direct egress is not intercepted and needs no extra CA, so this is only worth a note.
  echo 'trueforge: no Cloudflare egress CA appeared; assuming egress is not intercepted' >&2
fi

exec /usr/local/bin/computerd "$@"
