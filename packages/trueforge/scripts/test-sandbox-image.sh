#!/usr/bin/env bash
# Runs the sandbox Python tests inside the built container image.
#
# The Code Mode MCP client imports `mcp` and `pydantic`, which exist in the sandbox image and not on
# a developer host, and the image is also the only honest place to check what the agent will run.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_dir="$(cd "$package_dir/../trueforge-core" && pwd)"
tests_dir=/trueforge-core/tests/core/sandbox/scripts
image=trueforge-sandbox-image-tests

docker build -q -t "$image" -f "$package_dir/workers/computer.Dockerfile" "$package_dir/workers" >/dev/null
docker run --rm \
  -v "$core_dir:/trueforge-core:ro" \
  --entrypoint python3 \
  "$image" -m unittest discover --start-directory "$tests_dir" --top-level-directory "$tests_dir" \
  --pattern '*_test.py' --verbose
