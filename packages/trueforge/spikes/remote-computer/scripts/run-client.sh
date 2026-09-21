#!/usr/bin/env bash
# Runs the already-built linux/amd64 client against the spike Worker.
# Credentials come from the environment or a local .env that is never committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$here/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$here/.env"
  set +a
fi

exec "$here/client/bin/spike-client-linux-amd64" \
  --url "${TRUEFORGE_URL:?TRUEFORGE_URL is required}" \
  --computer-id "${TRUEFORGE_COMPUTER_ID:-spike}" \
  --token "${TRUEFORGE_TOKEN:?TRUEFORGE_TOKEN is required}"
