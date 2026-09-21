/**
 * The script `GET /install.sh` serves. POSIX sh, no sudo: it detects the platform, downloads the
 * client from the configured release base, enrolls with the code it was given, and runs.
 */

export const INSTALL_SCRIPT_UNCONFIGURED =
  'This server has no remote-computer client release configured. Set REMOTE_COMPUTER_RELEASE_BASE_URL.';

export function renderInstallScript({ baseUrl, releaseBaseUrl }: { baseUrl: string; releaseBaseUrl: string }): string {
  return `#!/bin/sh
# TrueForge remote computer installer. Run:
#   curl -fsSL ${baseUrl}/install.sh | sh -s -- --url ${baseUrl} --code <code>
set -eu

TRUEFORGE_URL="${baseUrl}"
RELEASE_BASE="${releaseBaseUrl}"
CODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --url) TRUEFORGE_URL="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --url=*) TRUEFORGE_URL="\${1#--url=}"; shift ;;
    --code=*) CODE="\${1#--code=}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CODE" ]; then
  echo "an enrollment code is required: --code <code>" >&2
  exit 2
fi

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BIN_DIR="\${HOME}/.trueforge/bin"
BIN="\${BIN_DIR}/trueforge-computer"
mkdir -p "$BIN_DIR"

echo "Downloading the TrueForge computer client for \${OS}/\${ARCH}…"
curl -fsSL "\${RELEASE_BASE}/latest/trueforge-computer_\${OS}_\${ARCH}" -o "\${BIN}.tmp"
chmod 0755 "\${BIN}.tmp"
mv "\${BIN}.tmp" "\${BIN}"

"\${BIN}" enroll --url "$TRUEFORGE_URL" --code "$CODE"

echo
echo "Enrolled. Starting in the foreground; press Ctrl-C to stop."
echo "To keep it running after you log out, install it as a service or run:"
echo "  nohup \${BIN} run >/dev/null 2>&1 &"
echo
exec "\${BIN}" run
`;
}
