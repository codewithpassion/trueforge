/**
 * The script `GET /install.sh` serves. POSIX sh: it detects the platform, downloads the client from
 * the configured release base, verifies its checksum, enrolls with the code it was given, and runs.
 */

export const INSTALL_SCRIPT_UNCONFIGURED =
  'This server has no remote-computer client release configured. Set REMOTE_COMPUTER_RELEASE_BASE_URL.';

export const INSTALL_SCRIPT_NO_BASE_URL =
  'This server does not know its own public URL, so it cannot write an installer that points back at it.';

/** The packages `install.sh --desktop` needs, as one line the user can paste. */
export const DESKTOP_APT_LINE = 'sudo apt-get install -y xvfb openbox xterm chromium xdotool xclip';

export function renderInstallScript({ baseUrl, releaseBaseUrl }: { baseUrl: string; releaseBaseUrl: string }): string {
  return `#!/bin/sh
# TrueForge remote computer installer.
#   curl -fsSL ${baseUrl}/install.sh | sh -s -- --url ${baseUrl} --code <code>
#
# --desktop (Linux only) also runs a virtual desktop agents can see and drive. Its packages must
# already be installed; the script names them and stops if any is missing.
#
# Downloads are checked against the SHA256SUMS published beside them. Signature verification
# (cosign) is not here yet; it arrives with the signed releases in a later phase.
set -eu

TRUEFORGE_URL="${baseUrl}"
RELEASE_BASE="${releaseBaseUrl}"
CODE=""
ALLOW_ROOT=0
SKIP_VERIFY=0
SYSTEM=0
DESKTOP=0
RUN_AS=trueforge

while [ $# -gt 0 ]; do
  case "$1" in
    --url) TRUEFORGE_URL="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --run-as) RUN_AS="$2"; shift 2 ;;
    --url=*) TRUEFORGE_URL="\${1#--url=}"; shift ;;
    --code=*) CODE="\${1#--code=}"; shift ;;
    --run-as=*) RUN_AS="\${1#--run-as=}"; shift ;;
    --allow-root) ALLOW_ROOT=1; shift ;;
    --insecure-skip-verify) SKIP_VERIFY=1; shift ;;
    --system) SYSTEM=1; shift ;;
    --desktop) DESKTOP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The code may also arrive in the environment, which keeps it out of the process list.
CODE="\${TRUEFORGE_ENROLL_CODE:-$CODE}"
if [ -z "$CODE" ]; then
  echo "an enrollment code is required: --code <code>, or TRUEFORGE_ENROLL_CODE" >&2
  exit 2
fi

if [ "$(id -u)" -eq 0 ] && [ "$ALLOW_ROOT" -eq 0 ] && [ "$SYSTEM" -eq 0 ]; then
  echo "Refusing to run the agent as root." >&2
  echo "Run this as the user it should act as, or pass --system to create a dedicated" >&2
  echo "'$RUN_AS' user, or --allow-root if you really mean root." >&2
  exit 1
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

DESKTOP_FLAG=""
if [ "$DESKTOP" -eq 1 ]; then
  if [ "$OS" != linux ]; then
    echo "--desktop is only supported on Linux." >&2
    exit 1
  fi
  MISSING=""
  for tool in Xvfb openbox xterm chromium xdotool xclip; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      MISSING="$MISSING $tool"
    fi
  done
  if [ -n "$MISSING" ]; then
    echo "The desktop needs programs this machine does not have:$MISSING" >&2
    echo "On Debian or Ubuntu, install them with:" >&2
    echo "  ${DESKTOP_APT_LINE}" >&2
    exit 1
  fi
  DESKTOP_FLAG="--desktop"
fi

ARTIFACT="trueforge-computer_\${OS}_\${ARCH}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading \${ARTIFACT}…"
curl -fsSL "\${RELEASE_BASE}/latest/\${ARTIFACT}" -o "\${WORK}/\${ARTIFACT}"

if [ "$SKIP_VERIFY" -eq 1 ]; then
  echo "WARNING: skipping checksum verification because --insecure-skip-verify was passed." >&2
else
  # Fail closed: a missing or unmatched sums file stops the install rather than trusting the bytes.
  if ! curl -fsSL "\${RELEASE_BASE}/latest/SHA256SUMS" -o "\${WORK}/SHA256SUMS"; then
    echo "Could not fetch SHA256SUMS from \${RELEASE_BASE}/latest/." >&2
    echo "Refusing to install an unverified binary. Pass --insecure-skip-verify to override." >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$WORK" && sha256sum --check --ignore-missing SHA256SUMS )
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$WORK" && shasum -a 256 --check --ignore-missing SHA256SUMS )
  else
    echo "Neither sha256sum nor shasum is available; cannot verify the download." >&2
    exit 1
  fi
fi

chmod 0755 "\${WORK}/\${ARTIFACT}"

if [ "$SYSTEM" -eq 1 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "--system installs for a dedicated user and needs root." >&2
    exit 1
  fi
  if ! id -u "$RUN_AS" >/dev/null 2>&1; then
    echo "Creating the unprivileged user '\${RUN_AS}'…"
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --create-home --shell /usr/sbin/nologin "$RUN_AS"
    elif command -v adduser >/dev/null 2>&1; then
      adduser -S -h "/home/\${RUN_AS}" -s /sbin/nologin "$RUN_AS"
    else
      echo "No useradd or adduser on this system; create '\${RUN_AS}' yourself and re-run." >&2
      exit 1
    fi
  fi
  HOME_DIR="$(eval echo "~\${RUN_AS}")"
  BIN_DIR="\${HOME_DIR}/.local/bin"
  mkdir -p "$BIN_DIR"
  BIN="\${BIN_DIR}/trueforge-computer"
  mv "\${WORK}/\${ARTIFACT}" "$BIN"
  chown -R "\${RUN_AS}" "$BIN_DIR"
  echo
  echo "Installed at \${BIN}, to run as '\${RUN_AS}'."
  echo "Enrolling…"
  TRUEFORGE_ENROLL_CODE="$CODE" su -s /bin/sh "$RUN_AS" -c "TRUEFORGE_ENROLL_CODE=\\"\\$TRUEFORGE_ENROLL_CODE\\" \\"$BIN\\" enroll --url \\"$TRUEFORGE_URL\\" $DESKTOP_FLAG"
  echo
  echo "Enrolled. Start it with:"
  echo "  su -s /bin/sh \${RUN_AS} -c '\${BIN} run'"
  exit 0
fi

BIN_DIR="\${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
BIN="\${BIN_DIR}/trueforge-computer"
mv "\${WORK}/\${ARTIFACT}" "$BIN"

# --desktop is stored in the config, so every later run starts the desktop too.
TRUEFORGE_ENROLL_CODE="$CODE" "$BIN" enroll --url "$TRUEFORGE_URL" $DESKTOP_FLAG

echo
echo "Enrolled as $(id -un). Starting in the foreground; press Ctrl-C to stop."
echo "To keep it running after you log out, install it as a service or run:"
echo "  nohup \${BIN} run >/dev/null 2>&1 &"
echo
exec "$BIN" run
`;
}
