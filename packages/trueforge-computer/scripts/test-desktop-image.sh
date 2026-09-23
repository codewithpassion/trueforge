#!/usr/bin/env bash
# Builds the desktop image and runs the desktop integration tests inside it, twice: once with the
# documented seccomp profile, where everything must work, and once with Docker's default profile,
# where Chromium's sandbox must be refused and reported rather than bypassed.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${TRUEFORGE_DESKTOP_IMAGE:-trueforge-computer-desktop:local}"
test_binary="bin/desktop-integration.test"

docker build -f "$package_dir/Dockerfile.desktop" -t "$image" "$package_dir"
mkdir -p "$package_dir/bin"
bash "$package_dir/scripts/go.sh" go test -c -tags desktop_integration -o "$test_binary" ./internal/agent

run_tests() {
  docker run --rm --init \
    -v "$package_dir/bin:/tests:ro" \
    --entrypoint "/tests/$(basename "$test_binary")" \
    "$@" \
    "$image" -test.v -test.run 'TestDesktop'
}

echo "== with --security-opt seccomp=packaging/desktop/seccomp.json"
run_tests --security-opt "seccomp=$package_dir/packaging/desktop/seccomp.json"

echo "== with Docker's default seccomp profile"
run_tests -e TRUEFORGE_DESKTOP_EXPECT_SANDBOX=refused
