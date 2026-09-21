# trueforge-computer

A small Go daemon that connects a machine you own to TrueForge. Once it is running, an agent
attached to this computer runs its shell commands and file transfers here instead of in a
disposable sandbox.

The daemon dials out over a WebSocket, so the machine needs **no inbound port, no tunnel and
no public address**. It works behind NAT.

Read the security model below before you point one of these at a machine that matters.

## Install

Download the binary for your platform from the release page and put it on the path:

```sh
curl -fsSLO https://github.com/truefoundry/trueforge/releases/latest/download/trueforge-computer-linux-amd64
install -m 0755 trueforge-computer-linux-amd64 /usr/local/bin/trueforge-computer
```

Builds are static, with no runtime to install: `linux/amd64`, `linux/arm64`, `darwin/amd64`
and `darwin/arm64`. Windows is not supported.

To build from this repository instead:

```sh
pnpm --filter @truefoundry/trueforge-computer build       # all four targets into bin/
pnpm --filter @truefoundry/trueforge-computer build:local # just this machine
```

Go does not need to be installed: the scripts use a `golang` container when there is no local
toolchain, and the local one when there is.

## Enroll, then run

In TrueForge, open **Settings → Computers**, add a computer, and copy the enrollment code. It
is single use and expires after fifteen minutes.

```sh
trueforge-computer enroll --url https://trueforge.example.com --code <code>
trueforge-computer run
```

`enroll` exchanges the code for a long-lived machine credential, writes it to
`<state-dir>/credential` at mode `0600`, and records the server URL and computer id in
`<state-dir>/config.json`. `run` reads both and connects. The computer appears online in the
UI within a second or two.

`run` also accepts `--url` and `--code` directly, and enrolls itself if it has no credential
yet. That is what makes the container command below survive a restart: a code that has already
been spent is ignored rather than presented again.

### Docker

```sh
docker run -d --restart unless-stopped \
  --name trueforge-computer \
  -v trueforge-computer:/var/lib/trueforge-computer \
  ghcr.io/truefoundry/trueforge-computer \
  --url https://trueforge.example.com --code <code>
```

The image is busybox-based, because `exec` needs a shell. It runs as uid 1000, keeps its state
in the named volume, and carries a CA bundle — without one the client cannot verify the
server's certificate and retries forever, which looks like a network fault and is not.

For a read-only root filesystem, give it a writable `/tmp`:

```sh
docker run -d --restart unless-stopped \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -v trueforge-computer:/var/lib/trueforge-computer \
  ghcr.io/truefoundry/trueforge-computer \
  --url https://trueforge.example.com --code <code>
```

A container reports `python3: false` and `git: false` unless you add them, so TrueForge will
not mount skills on it.

### systemd

`install-service` arrives with Phase 8d. Until then, install the unit yourself. A working
example is committed at [`packaging/trueforge-computer.service`](packaging/trueforge-computer.service):

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin trueforge
sudo install -m 0644 packaging/trueforge-computer.service /etc/systemd/system/
sudo -u trueforge trueforge-computer enroll \
  --state-dir /var/lib/trueforge-computer \
  --url https://trueforge.example.com --code <code>
sudo systemctl enable --now trueforge-computer
journalctl -u trueforge-computer -f
```

The unit sets `KillMode=control-group` on purpose. Without it, stopping the service signals the
daemon only, and the commands it started stay running, reparented to PID 1, with nobody to
collect them.

## Commands

| Command                   | What it does                                                                |
| ------------------------- | --------------------------------------------------------------------------- |
| `enroll --url … --code …` | Exchanges the code for a credential and writes the config                   |
| `run`                     | Connects and serves requests until stopped                                  |
| `status`                  | Prints what is on disk and what this machine can do. Local only, no network |
| `version`                 | Prints the version                                                          |
| `install-service`         | Phase 8d. Prints how to install the unit above and exits 4                  |

### Flags

`enroll`:

| Flag           | Default                  | Meaning                                      |
| -------------- | ------------------------ | -------------------------------------------- |
| `--url`        | `$TRUEFORGE_URL`         | Base URL of the TrueForge server             |
| `--code`       | `$TRUEFORGE_ENROLL_CODE` | The single-use enrollment code               |
| `--name`       | the machine's own        | Hostname to report instead of this machine's |
| `--state-dir`  | see below                | Where the credential and config are kept     |
| `--log-format` | `text`                   | `text` or `json`                             |

`run`:

| Flag               | Default                  | Meaning                                                              |
| ------------------ | ------------------------ | -------------------------------------------------------------------- |
| `--url`            | the enrolled one         | Overrides the stored server URL                                      |
| `--code`           | `$TRUEFORGE_ENROLL_CODE` | Enrolls first if there is no credential yet                          |
| `--name`           | the enrolled one         | Hostname to report                                                   |
| `--state-dir`      | see below                | Credential, config, audit log and process-group records              |
| `--workdir`        | `<state-dir>/sessions`   | Root for the per-session directories                                 |
| `--allow-root`     | off                      | Run as root anyway                                                   |
| `--read-only`      | off                      | Refuse every `exec` and every write                                  |
| `--workdir-only`   | off                      | Refuse file operations outside `--workdir`                           |
| `--allow <regex>`  | none                     | A command must match one of these. Repeatable; empty allows all      |
| `--deny <regex>`   | none                     | A command must match none of these. Repeatable, checked before allow |
| `--max-concurrent` | `4`                      | Commands running at once                                             |
| `--max-queue`      | `32`                     | Commands allowed to wait for a slot                                  |
| `--log-format`     | `json`                   | `json` or `text`                                                     |

`status` also takes `--state-dir` and `--json`.

### Environment and the state directory

`TRUEFORGE_URL`, `TRUEFORGE_ENROLL_CODE` and `TRUEFORGE_STATE_DIR` are the defaults for
`--url`, `--code` and `--state-dir`. A flag always wins.

The state directory is `$TRUEFORGE_STATE_DIR` if set, otherwise `~/.trueforge`, otherwise
`/var/lib/trueforge-computer`. The image sets the variable, so a container uses the last one.
It is created at mode `0700` and holds:

```
config.json        the server URL, computer id and reported hostname
credential         the machine credential, mode 0600
audit.jsonl        one JSON line per operation
running/           one record per live command group, swept at the next start
sessions/          the per-session working directories
```

## Security model

The short version: **an agent attached to this computer can run any command the daemon's user
can run.** Everything below narrows that; nothing removes it.

- **Run as a dedicated unprivileged user.** The daemon refuses to start as root unless you
  pass `--allow-root`. Give the account only what you are willing to let an agent reach — in
  particular, not the owner's SSH keys or cloud credentials.
- **Commands get a built environment**, not an inherited one: `PATH`, `HOME`, `LANG`, `TERM`,
  plus whatever the request carries. The machine credential is never in it, so no command can
  read it back out of its own environment.
- **`--read-only`** refuses `exec` and every write while still allowing reads. Useful for a
  machine you want an agent to look at but not touch.
- **`--allow` and `--deny`** are RE2 regular expressions matched against the whole command
  line. Deny is checked first and always wins, so widening the allow list cannot defeat it.
- **`--workdir-only`** confines file transfers to the working directory. Paths are resolved
  through symlinks before they are compared, so a symlink planted inside the directory is not
  a way out. It does not confine `exec`: a shell can `cd` anywhere the user can.
- **All of this is enforced here, on the machine.** A compromised or hostile server cannot
  lift any of it by asking; the limits live in the flags you started the daemon with.
- **Everything is audited locally.** `audit.jsonl` records every operation with its outcome,
  exit code and byte counts, at mode `0600`. Environment values are never written to it.
  The file has no rotation yet; truncate it from a cron job on a busy machine.
- **Revocation is immediate.** Revoking the computer in TrueForge closes the live socket. The
  daemon treats that as final: it logs one line and exits 3 rather than retrying.

What TrueForge cannot control from here: what the machine can reach on your network, and what
an agent does with the files the daemon's user can read. Those are yours.

### At-least-once delivery

A reply is written back on the socket the request arrived on. If that socket has closed, the
reply is dropped rather than sent on the next one, because the server could not match it; the
drop is recorded in the audit log as `reply_dropped`, which means the work was done and its
outcome is unknown to the server. The server may reissue the request after a reconnect, so
**an operation can run twice**. Commands should be written with that in mind.

File uploads are safe against this. Chunks may arrive in any order — the relay pipelines a
window of them and each is handled on its own goroutine — so a chunk ahead of its turn waits
for its predecessor, and a chunk the transfer has already taken is answered without being
written again. When the socket drops, open uploads are discarded along with their partial
files, and the server restarts the transfer from chunk zero.

## Troubleshooting

### Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Stopped cleanly                                                          |
| `1`  | Failed. The last log line says why                                       |
| `2`  | Bad flags, not enrolled, or refusing to run as root                      |
| `3`  | The machine credential was revoked. Re-enroll; the daemon will not retry |
| `4`  | Not ready: `status` on an unenrolled machine, or `install-service`       |

### Close codes in the log

| Code   | Meaning                       | What the daemon does                                                                                                    |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `4401` | Revoked                       | Logs one line and exits 3. It never reconnects                                                                          |
| `4408` | The server stopped hearing us | Reconnects with the usual backoff                                                                                       |
| `4409` | Another connection took over  | Waits at least five minutes. Two daemons sharing one credential would otherwise evict each other forever — run only one |

### Common problems

**`x509: certificate signed by unknown authority`, forever.** The container has no CA bundle.
Use the published image, or copy `/etc/ssl/certs/ca-certificates.crt` into yours.

**The computer shows offline but the daemon is running.** A suspended laptop leaves the socket
open with nothing arriving. The daemon pings every ten seconds and closes a socket that misses
two answers; the server notices within about 25 seconds and the daemon reconnects.

**A command comes back with exit 124.** It hit its deadline and the whole process group was
killed. Raise the timeout on the TrueForge side.

**A command comes back with exit 137 or 143.** It was killed: 137 by a cancel or a shutdown,
143 by a `SIGTERM` it sent itself. Signalled commands report 128 plus the signal number.

**Output ends with `[... N bytes dropped ...]`.** Output is capped at 1 MiB across both
streams. The head and the tail are both kept, so a failure at the end of a build is still
visible; the middle is what goes.

**`status` shows `left behind N command group(s)`.** The daemon was killed while commands were
running and they outlived it. The next `run` kills them before accepting anything new. On
systemd, `KillMode=control-group` prevents this in the first place.

**`enrollment code was refused`.** Codes are single use and last fifteen minutes. Issue a new
one. If you are re-running a container that already enrolled, drop `--code` — the stored
credential is what it needs.

## Developing

```sh
pnpm --filter @truefoundry/trueforge-computer check   # go vet, gofmt -l, go test ./...
pnpm --filter @truefoundry/trueforge-computer test
pnpm --filter @truefoundry/trueforge-computer fmt
```

`testdata/protocol` and `testdata/enroll` hold the wire fixtures. They are the shared reference
for the server's schemas, so a change to either side should fail a test on both.
