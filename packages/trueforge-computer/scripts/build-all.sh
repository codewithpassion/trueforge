#!/usr/bin/env bash
# Cross-compiles the release matrix in one pass. Static binaries, no runtime on the target.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${TRUEFORGE_COMPUTER_VERSION:-}"
if [ -z "$version" ]; then
  version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$package_dir/package.json" | head -1)"
fi
if [ -z "$version" ]; then
  echo "could not determine a version; set TRUEFORGE_COMPUTER_VERSION" >&2
  exit 1
fi

mkdir -p "$package_dir/bin"
targets=("linux/amd64" "linux/arm64" "darwin/amd64" "darwin/arm64")

for target in "${targets[@]}"; do
  goos="${target%%/*}"
  goarch="${target##*/}"
  output="bin/trueforge-computer-${goos}-${goarch}"
  echo "building $output (version $version)"
  GOOS="$goos" GOARCH="$goarch" bash "$package_dir/scripts/go.sh" \
    go build -trimpath -ldflags "-s -w -X main.version=${version}" -o "$output" ./cmd/trueforge-computer
done

ls -l "$package_dir/bin"
