#!/bin/sh
# Adds the Cloudflare egress CA to the system trust store. Safe to run any number of times.
#
# Cloudflare mints this CA per container and writes it only once outbound interception is set up,
# which happens after the container has started, so it cannot be baked into the image.
#
# Usage: trueforge-trust-egress-ca [wait-seconds]. Waits up to that long for the CA to appear.
# Exit 0: the system bundle trusts the current CA. Exit 3: no CA appeared in time.
# Exit 4: a CA exists but could not be installed.
set -u

CA_SOURCE=/etc/cloudflare/certs/cloudflare-containers-ca.crt
CA_TARGET=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt
# Written only after update-ca-certificates succeeds, so a run that died half-way is redone.
INSTALLED_MARKER=/var/lib/trueforge/egress-ca.installed

tries=$((${1:-0} * 2))
while [ ! -s "$CA_SOURCE" ] && [ "$tries" -gt 0 ]; do
  tries=$((tries - 1))
  sleep 0.5
done

if [ ! -s "$CA_SOURCE" ]; then
  echo "trueforge: no Cloudflare egress CA at $CA_SOURCE" >&2
  exit 3
fi

if [ -f "$INSTALLED_MARKER" ] && cmp -s "$CA_SOURCE" "$INSTALLED_MARKER"; then
  exit 0
fi

if cp "$CA_SOURCE" "$CA_TARGET" &&
  update-ca-certificates >/dev/null 2>&1 &&
  mkdir -p "$(dirname "$INSTALLED_MARKER")" &&
  cp "$CA_SOURCE" "$INSTALLED_MARKER"; then
  exit 0
fi

echo 'trueforge: could not add the Cloudflare egress CA to the system trust store' >&2
exit 4
