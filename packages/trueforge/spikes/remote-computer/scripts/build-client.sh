#!/usr/bin/env bash
# Builds the spike client in Docker, because Go is not installed on the host.
# Outputs are gitignored: client/bin/ is never committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${SPIKE_GO_IMAGE:-golang:1.23}"
# Holds the module cache and the checksum database; owned by the invoking user so the
# build can run unprivileged and leave no root-owned files in the worktree.
cache="${SPIKE_GO_CACHE_VOLUME:-spike-gopkg}"

docker volume create "$cache" >/dev/null
docker run --rm -v "$cache":/go/pkg "$image" chown -R "$(id -u):$(id -g)" /go/pkg
mkdir -p "$here/client/bin"

cat > "$here/client/bin/.build.sh" <<'INNER'
set -euo pipefail
go mod tidy
for target in "linux/amd64" "darwin/arm64"; do
  GOOS="${target%%/*}" GOARCH="${target##*/}" go build -trimpath -ldflags "-s -w" \
    -o "bin/spike-client-${target%%/*}-${target##*/}" .
done
ls -l bin/
INNER

docker run --rm \
  -v "$here/client":/src \
  -v "$cache":/go/pkg \
  -w /src \
  -u "$(id -u):$(id -g)" \
  -e CGO_ENABLED=0 \
  -e HOME=/tmp \
  -e GOCACHE=/tmp/.gocache \
  "$image" bash bin/.build.sh

rm -f "$here/client/bin/.build.sh"
