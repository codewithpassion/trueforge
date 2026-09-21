# Remote computers: agents that run on a real machine (Phase 8 PRD)

Status: approved by the owner on 2026-09-21 with the decisions in Section 9; Phase 8a (spike) is next. Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation. Nothing in this plan is implemented.

## 1. Problem, goal, non-goals

Every TrueForge sandbox today is disposable and per session (Daytona, TFY, local, or `ComputerDO` on Workers). Users want agents to work on machines they own.

**Goal.** A user creates a computer, copies one command, runs it on a Linux or macOS machine (bare or in Docker), and sees it come online. They attach it to an agent, and from then on that agent's `exec`, file uploads, downloads and tool-result offload run on that machine. The binary dials out, so no inbound port or tunnel is needed. Both runtimes; Workers first (Section 8).

**Non-goals.** Interactive PTY, stdin, or streaming output to the UI. Windows hosts. Fly or any hosted-machine lifecycle (Agentum's Fly path was never run live). Moving the agent loop off the server. Replacing the per-tenant sandbox provider.

## 2. What Agentum does, and what to reuse

**Shape.** `apps/computerd` is a dependency-free Bun daemon shipped as a Debian image (`apps/computerd/Dockerfile`), not a binary. In connect mode it dials `/api/computer-hosts/connect` with a bearer token, sends `hello`, heartbeats every 30 s (`apps/computerd/src/connect.ts:19`), and reconnects forever with jittered backoff (`apps/computerd/src/connect.ts:73`). Config is env only (`apps/computerd/src/config.ts`).

**Protocol.** `{ id, op }` in, `{ id, result }` out, ops `read | write | edit | list | exec | ping` (`apps/computerd/src/protocol.ts`). `exec` runs `sh -c` under `setsid`, kills the process group at the deadline with exit 124, keeps 16,000 bytes per stream, and runs one command at a time (`apps/computerd/src/exec.ts:81-174`, `apps/computerd/src/output.ts:8`). Paths are jailed to the root (`apps/computerd/src/paths.ts:104`). No stdin, PTY, env, cancel or streaming.

**Server.** `ComputerRelay` (`apps/web/src/modules/computer/relay.ts:114`), one Durable Object per host, holds a hibernating socket, replaces an older one on reconnect, keeps an in-memory pending map, serialises exec (`relay.ts:293`) and fails fast with an offline reason naming last-seen time (`relay.ts:329`). The connect route hashes the token and answers every failure with a bare 401 (`apps/web/src/modules/computer/connect-route.ts`). `computer_hosts` stores `token_hash` when the daemon presents the token and `token_enc` when Agentum does (`apps/web/src/modules/computer/schema.ts:92-100`). The UI shows the token once inside a copyable `docker run` command. One agent per host.

**Production-grade:** exec runner, path jail, reconnect, relay, offline reasons; self-hosted passed live acceptance (PROGRESS.md, Cycle 17). **Prototype:** Fly and Podman (never run), multi-minute exec through a managed agent (unverified).

**Pitfalls to carry over** (PROGRESS.md Cycle 17 and code reading):

- File paths rooted at home while the shell sees the real filesystem confused the agent. TrueForge avoids this by using real absolute paths everywhere.
- Rotating or deleting a host does not close the socket that is already authenticated (`hosts.ts:272` only rewrites the hash, and the token is checked only at connect). Revocation must close it.
- One D1 write per heartbeat per host; the one-time token screen was once lost to a remount.

**Reuse verdict: rewrite, borrowing the design.** Vendoring does not fit: it is a Bun script in an image, not a binary; its result shapes are not `ExecResult` (`packages/trueforge-core/src/core/sandbox/provider/Provider.ts:16`); its 16 KB cap differs from `COMPUTER_EXEC_OUTPUT_MAX_BYTES` (1 MiB); and it has one root, no per-session cwd, no env on exec and no single-use enrollment.

Keep: the envelope, `hello`/`heartbeat`, the setsid group kill and 124 convention, backoff with jitter, relay socket replacement, offline reasons, and the rule "the side that presents a credential decides hash vs encrypt". **Licence:** Agentum has no LICENSE and one author (Dominik Fretz, personal address); TrueForge is MIT (`LICENSE`). Porting ideas and code is the owner's call. Confirm that Agentum is personal IP, not employer IP, before copying code verbatim.

## 3. User stories and flow

1. **Create.** In Settings → Computers (or from the agent), "Add computer" shows two commands with a single-use enrollment code: `curl -fsSL <base>/install.sh | sh -s -- --url <base> --code <code>`, and `docker run -d --restart unless-stopped -v trueforge-computer:/var/lib/trueforge-computer ghcr.io/<org>/trueforge-computer --url <base> --code <code>`.
2. **Online.** The binary enrolls and dials in; the row shows online, hostname, OS, version and last seen.
3. **Attach.** In the agent's Sandbox section, choose "Run on computer: office-box"; other agents keep the tenant provider.
4. **Work.** `exec` runs there; commands appear in the turn and in a per-computer activity list.
5. **Offline.** The next `exec` returns at once with "Computer office-box is offline (last seen 12 minutes ago)"; the turn continues.
6. **Manage.** Rename, rotate (re-enroll), revoke (the live socket closes within seconds), and delete (refused while agents are attached, as in Agentum).

## 4. Architecture

**Mapping to TrueForge's sandbox model.** Keep the per-tenant provider singleton and add a per-agent attachment: `sandbox.computer_id` (nullable) on `SandboxConfigSchema` (`packages/trueforge-core/src/agent-session/schemas/agentSpec.ts:162`). When set, it overrides the tenant provider for that agent's sessions. `SandboxIntegration.resolveProvider` (`packages/trueforge/src/sandbox/integration.ts:27`) gains a `computer_id` input; that signature change, synced across core, frontend, trueforge and patches, is part of the cost. A new `RemoteComputerProvider` (`type = 'remote-computer'`) implements `SandboxProvider` (`Provider.ts:83`):

- `createSandbox` returns the raw id `<computer_id>/<session_id>`, persisted as `v1:remote-computer:<computer_id>/<session_id>`, so `existingSandboxIdForProvider` (`packages/trueforge-core/src/core/sandbox/sandboxRef.ts:43`) carries it forward unchanged. It runs `mkdir -p` on the session directory.
- **Session directory.** `<state_root>/sessions/<session_id>` (default state root `~/.trueforge`). `exec` defaults `cwd` to it. Path getters return real absolute paths under it: `uploads/`, `.trueforge/tool-results/`, `.trueforge/skills/`, `.trueforge/bin/skill_downloader.py`, `.trueforge/git-credentials`. This is a default cwd, not a jail: commands see the whole machine as the run-as user.
- `exec` sends `{ op: 'exec', command, cwd, env, timeout_ms }` and maps the reply to `{ success: true, response: { exitCode, result } }`. An offline computer, a dropped socket or a relay timeout maps to `{ success: false, error: <offline reason> }`. It never throws `SandboxNotAvailableError`, because `Sandbox.ts` answers that error by recreating the sandbox, which is meaningless for a real machine.
- `uploadFile` and `downloadFile` are chunked (`file_put` / `file_get` in 256 KiB base64 frames, sha256 checked), capped by `SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD`. Not-found, directory and too-large map to the `SandboxErrors` classes; offline maps to a new `SandboxOfflineError`, never `SandboxNotAvailableError`.
- `buildImage` and `getImageBuildStatus` return `ready`. `getAdditionalInstructions` says it is a real, shared, persistent machine and the session folder is the cwd.
- **Code Mode:** `supportsCodeMode = false` until 8e: NATS lives in the image and the Workers HTTP bridge relies on container egress interception, neither of which exists on a user's machine. 8e adds a reverse channel: the binary serves `127.0.0.1:<random>`, and `mcp_client.py` in HTTP mode (`TFY_CM_HTTP_URL` / `TFY_CM_HTTP_TOKEN`, sandbox plan Section 13) posts to it; frames go up the same socket to `SessionDO.dispatchCodeMode`.
- **Skills:** the downloader needs `python3`, `pydantic` and `git`. `hello` reports detected tools, and skill mounting is enabled per computer only when they are present.

**Workers.** `RemoteComputerDO` (new class, `idFromName(computer_id)`), modelled on Agentum's `relay.ts`, with these changes:

- **Heartbeats.** `setWebSocketAutoResponse` answers them, and `last_seen_at` is written by a 60 s alarm only while connected, not by one D1 write per heartbeat.
- **Tenant check.** Every `request` carries `tenant_id`, and the DO refuses a mismatch with its stored computer row.
- **Concurrency.** Per-session serialisation (a turn is already sequential) plus a cap on in-flight execs per computer (default 4, queued beyond that). This replaces Agentum's one exec per host.
- **Revocation.** A `revoke()` RPC closes sockets with 4401.

The in-memory pending map is safe because `SessionDO`'s RPC holds the object active for the call, the same argument `ComputerDO` relies on. The exec timeout stays at or under `SANDBOX_EXEC_TIMEOUT_SECONDS`, which is already capped at two thirds of `ALARM_PASS_BUDGET_MS` (`packages/trueforge/src/workers/alarmBudget.ts:2`, `packages/trueforge/src/config.ts:461`). The relay adds 10 s of grace so the daemon's own 124 wins the race. The spike must measure the inbound WebSocket message size limit; chunking keeps frames at 256 KiB regardless.

**Node standalone.** An in-process `ComputerHub` holds sockets on the Hono upgrade path with the DO's `request` surface.

**Node distributed.** A turn may run on replica A while the socket sits on B. The hub writes `computer:<id>:owner = <EXECUTOR_ID>` with a TTL refreshed by heartbeat. A routes through the existing Redis request-reply executor (`packages/trueforge-core/src/request-reply/executor.ts`, route `computers/request`). Its 120 s default reply TTL must be raised above the exec cap.

**Cancellation and caps.** A turn abort sends `{ op: 'cancel', id }`, and the daemon kills the process group. Output is counted in full and the head is kept, up to 1 MiB combined, matching `COMPUTER_EXEC_OUTPUT_MAX_BYTES`.

## 5. Data model and API

Tables (Kysely, SQLite, Postgres and D1 migrations, snake_case):

- `computer`: `id`, `tenant_id`, `name` (unique per tenant), `owner_subject`, `credential_hash` (unique), `status` (`pending | online | offline | revoked`), `hostname`, `os`, `arch`, `agent_version`, `capabilities` jsonb (`python3`, `git`, `skills`), `run_as_user`, `last_seen_at`, `created_at`, `updated_at`.
- `computer_enrollment`: `code_hash`, `computer_id`, `expires_at`, `used_at`.
- `computer_audit`: `id`, `computer_id`, `tenant_id`, `session_id`, `turn_id`, `op`, `command` (truncated to 4 KiB), `exit_code`, `duration_ms`, `bytes_out`, `created_at`, with a 30-day retention sweep on `SchedulerDO` and the Node controller.

Routes (OpenAPI, then SDK regen through CI and `pnpm changeset:sdk-regen`):

| Route                                   | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `GET/POST /api/v1/computers`            | List and create; create returns the one-time `enrollment_code` and commands |
| `PATCH /api/v1/computers/{computer_id}` | Rename                                                                      |
| `POST .../{computer_id}/enrollment`     | Rotate: issue a new code and invalidate the credential                      |
| `POST .../{computer_id}/revoke`         | Revoke: close the socket                                                    |
| `DELETE .../{computer_id}`              | Delete (409 while attached)                                                 |
| `POST /api/v1/computers/enroll`         | Unauthenticated; code in, `machine_credential` out                          |
| `GET /api/v1/computers/connect`         | WebSocket; bearer credential                                                |

Capabilities: `GET /capabilities` gains `computers.enabled`. `resolveSandboxUsability` (`packages/trueforge/src/workers/sandbox/workersSandboxIntegration.ts:78`, `packages/trueforge/src/sandbox/nodeSandboxIntegration.ts:55`) takes the optional `computer_id`. An attached computer is `usable` when it exists in the tenant and is not revoked; being offline is a turn-time reason, not a spec-validation failure, since a laptop is offline often. UI: Settings → Computers beside `SandboxSettings.tsx`, and a picker in the agent's sandbox section.

## 6. Security

- **Credentials.** Enrollment codes are 32 random bytes, hashed, single use, 15-minute TTL. The binary exchanges one for a machine credential stored as sha256 server-side (the machine presents it) and `0600` in `<state_dir>/credential` or the Docker volume; it travels only in a header. Revoke or rotate deletes the hash and calls `revoke()`, closing the live socket, which fixes Agentum's gap. `resolveProvider` and the relay both check `computer.tenant_id` against the session's tenant.
- **Run-as user.** The installer uses a dedicated unprivileged `trueforge` user by default (`--run-as` overrides) and refuses root without `--allow-root`. Docker runs as uid 1000, no capabilities, read-only rootfs except the volume and `/tmp`. Commands get a scrubbed environment that never includes the daemon's credential. Optional daemon-side allow and deny regex lists, a `workdir_only` mode for file ops, and a `--read-only` mode that refuses `exec` and writes; the daemon enforces these, so a compromised server cannot lift them.
- **Approval.** The sandbox `exec` tool is served by `Sandbox extends LocalToolMCP` (`packages/trueforge-core/src/core/sandbox/Sandbox.ts:189`), and `LocalToolMCP.toolCallInfo` hard-codes `is_approval_required: false` (`packages/trueforge-core/src/core/mcp/LocalToolMCP.ts:118-127`). So `require_approval_for_tools` cannot gate it today. Phase 8d adds a core change: a per-computer `require_approval` setting (default on) that marks `exec` approval-required, reusing the existing approval events and UI.

| Threat                                 | Vector                                         | Control                                                        | Residual                                                   |
| -------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Prompt injection runs harmful commands | Web page, file or tool output steers the model | Unprivileged user, approval gate, deny list, audit             | High: a real machine with network access; the UI states it |
| Stolen enrollment code                 | Shoulder-surf, chat paste                      | Single use, 15-minute TTL, hashed                              | Low                                                        |
| Stolen machine credential              | Disk or volume copy                            | Hashed at rest, instant revoke, `hello` shows hostname changes | Medium until revoked                                       |
| Cross-tenant use                       | Forged `computer_id` in a spec                 | Tenant check in `resolveProvider` and in the relay             | Low                                                        |
| Session escape on a shared machine     | `cd ..`, symlinks                              | None for `exec` by design; `workdir_only` for file ops         | Accepted: one owner, one trust domain                      |
| Secret leakage                         | `env`, reading `~/.ssh`                        | Scrubbed env, run-as user without the owner's keys             | Medium: depends on the chosen user                         |
| Egress abuse                           | Machine used as a proxy                        | Owner's network controls; outside TrueForge's reach            | Accepted, documented                                       |
| Compromised TrueForge server           | Server sends commands                          | Daemon-side deny list, local audit log, `--read-only` flag     | Medium                                                     |

## 7. The client binary

**Language: Go**, for a single static binary of about 10 MB, trivial cross-compilation (linux and darwin, amd64 and arm64), mature process-group and PTY libraries, `kardianos/service` for systemd and launchd, and no runtime on the target. The alternative, `bun build --compile` of a TS port, reuses Agentum code but yields about 90 MB binaries, a thinner target matrix, and Bun in a pnpm repo.

**Packaging.** New workspace package `packages/trueforge-computer` (Go module with `package.json` scripts wrapping `go`); AGENTS.md requires syncing the CI path filters, matrix id and root `test:*` scripts. Releases on GitHub with checksums and cosign signatures; `install.sh` is served by the TrueForge server at `/install.sh` so the one-liner points at the tenant's base URL; a distroless image goes to GHCR. `hello` reports the version and the server answers `update_available`; no self-update in v1.

**Config and operation.** Flags, env (`TRUEFORGE_URL`, `TRUEFORGE_ENROLL_CODE`, `TRUEFORGE_STATE_DIR`) or `config.toml`. JSON logs to stderr (journald under systemd) plus a local audit file. Commands: `enroll | run | install-service | uninstall-service | status`.

### The client as built (Phase 8b)

`packages/trueforge-computer` is the binary; `packages/trueforge-computer/README.md` is its operator documentation. Where it differs from the paragraphs above:

- **Config is `config.json`, not `config.toml`.** It holds only the server URL, the computer id and the reported hostname; everything else is a flag or an environment variable. JSON needs no dependency and the repository already reads it everywhere.
- **`run` can enroll itself.** Section 3's `docker run` command re-passes a single-use code on every restart. `run --url --code` therefore enrolls only when `<state_dir>/credential` is absent and ignores the code otherwise, and the image's entrypoint is `trueforge-computer run` so the copied command is just the two flags.
- **`enroll --name` overrides the reported hostname**, at enrollment and on every later `hello`; the enrollment body itself stays the frozen `{ enrollment_code, hostname, os, arch, version }`.
- **`install-service` and `uninstall-service` are stubs** that print how to install the unit and exit 4; a working systemd unit with `KillMode=control-group` ships at `packages/trueforge-computer/packaging/trueforge-computer.service`. Phase 8d replaces them.
- **Exit codes:** 0 clean, 1 failure, 2 usage or not enrolled or refusing root, 3 revoked, 4 not ready (`status` unenrolled, or a deferred command).
- **Output truncation keeps head and tail** inside one 1 MiB budget across both streams, 256 KiB of each end per stream, with `[... N bytes dropped ...]` naming the loss and both seams cut back to rune boundaries. This is change 9 of Section 10, implemented.
- **The frame guard is 8 MiB**, an eighth of the measured platform limit, because JSON escaping can multiply a capped 1 MiB of output several times over. An answer above it is replaced with a `frame_too_large` error reply rather than written.
- **A reply whose socket has closed is dropped**, never written to a newer one, so the relay cannot receive an answer it has no pending entry for. The drop is audited as `reply_dropped`. The consequence is that every op is at-least-once once the relay reissues; the README states it.
- **`file_put` is order-independent and idempotent**, which change 8 requires of this side: each frame is handled on its own goroutine, so a pipelined window arrives in no particular order. A chunk ahead of its turn waits for its predecessor (bounded by a 32-chunk window and a 60 s timeout, after which the transfer is given up), and a chunk already taken is answered without rewriting. A dropped socket discards open transfers and their partial files, so the server restarts from `seq` 0.
- **Error codes the client returns**, for the server to map: `denied`, `read_only`, `queue_full`, `duplicate_id`, `bad_request`, `not_found`, `is_a_directory`, `not_a_regular_file`, `too_large`, `frame_too_large`, `unknown_op`, `op_failed`. They are published as `testdata/protocol/error_codes.json` and pinned to the constants by a test, so the list cannot drift without failing. `not_found`, `is_a_directory` and `not_a_regular_file` are separated deliberately, because Section 4 maps them to different `SandboxErrors` classes.
- **A command's life is bounded by the daemon, not by the socket.** A reconnect does not kill work already under way; the session is only where the reply goes. This is what change 11 needs from this side, and getting it wrong turns every 4408 into a mass kill.
- **The server cannot lift the allow list through `env`.** Once any of `--allow`, `--deny`, `--read-only` or `--workdir-only` is set the environment is an **allowlist**: `LANG`, `LC_*`, `TZ`, `TERM`, `NO_COLOR`, `CI`, `TFY_*`, `TRUEFORGE_SESSION_*`, plus what `--allow-env` names (trailing `*` for a prefix). Everything else refuses the exec with `denied`. A denylist was tried first and abandoned — `HOME` with an uploaded `.gitconfig`, `KUBECONFIG` exec plugins, `AWS_CONFIG_FILE` `credential_process`, `BASH_FUNC_*`, `RUSTC_WRAPPER` and `CC` all reach the same place. `LD_*`/`DYLD_*` are refused on every computer and cannot be permitted. **Two TrueForge features need a grant on a restricted computer:** skills using git credentials need `--allow-env 'GIT_CONFIG_*'`, and Code Mode will need `PYTHONPATH`; granting `GIT_CONFIG_*` is equivalent to allowing arbitrary commands, because git config names programs. A `cwd` pointing at an uploaded repository whose `.git/config` sets `core.fsmonitor` defeats `--allow '^git status$'` with no environment at all.
- **Path containment compares identity, not text.** `filepath.Rel` is case-sensitive and APFS is not, so `~/.TRUEFORGE/credential` would otherwise read as outside the state directory on macOS. Both the state-dir refusal and `--workdir-only` walk the resolved path comparing device and inode. A `--workdir` that overlaps the state directory is refused at startup.
- **Plaintext is refused except to loopback**, for the enrollment call and the dial alike, and the enrollment call refuses redirects: a 307 re-sends the single-use code to wherever it points.
- **Uploads are staged and renamed**, never written to the destination directly, so a failed transfer cannot truncate or delete the file it was replacing, and the destination is re-checked against the policy immediately before the rename. Only regular files are read or written, and both directions are capped by `--max-file-bytes` (256 MiB).
- **Nothing reaches the state directory** except through `sessions/`, in any mode. `config.json` decides where the next start connects and `running/` decides what the next sweep kills, so neither is the server's to write.
- **The startup sweep never kills on existence alone.** It matches the group leader's kernel start tick — `/proc/<pid>/stat` on Linux, `kern.proc.pid` on darwin — and a record it cannot positively identify is logged and dropped, because a pid is recycled within hours. **Argv is deliberately not part of the check**, although the review asked for it: dash and bash replace themselves with a lone command, so `sh -c 'sleep 400'` becomes `sleep 400` with the same pid and the same start tick, and comparing argv would skip exactly the orphan the spike documented. The start tick survives that exec and is the standard pid-reuse defence on its own.
- **Release artifacts are `trueforge-computer_<os>_<arch>`** (os `linux`/`darwin`, arch `amd64`/`arm64`) with a `SHA256SUMS` beside them, which is the contract with the server's `/install.sh`.
- **A cancel is answered whether or not it found anything** (`cancelled: false` for an unknown id), and a command cancelled before it got a slot reports 137, the same as one killed while running.
- **The exec registry outlives any one socket.** A `cancel` arriving after a reconnect still reaches a command the previous connection started, which is what change 11 needs from this side.
- **4409 waits at least five minutes** (jittered to 7.5), and a 401 on the upgrade takes the same slow path. Neither disturbs the exponential step, which only resets after a connection that lasted 60 s. This is change 17.
- **Startup sweep:** the daemon records one file per live process group under `<state_dir>/running/`, matching the group leader's `/proc` start tick on Linux so a recycled pid is not killed by mistake, and reaps them at the next start. macOS has no portable equivalent and falls back to existence only. This is change 10.
- **Tests are `_test.go` files beside the code**, not under a package-top-level `tests/`: Go's test tooling requires it for unexported symbols, and the root `AGENTS.md` rule is shaped for the TypeScript packages. The shared wire fixtures do sit at the package top level, in `testdata/protocol` and `testdata/enroll`, so the server's schemas can be checked against the same bytes.
- **CI** gets a `trueforge-computer` path filter, matrix id and root `test:trueforge-computer` (vet, `gofmt -l`, `go test ./...`), with `actions/setup-go` conditional on that matrix entry. It stays out of the aggregate `test` script, which the Windows job runs and which has no Go. The package's scripts prefer a local toolchain and fall back to a `golang` container, so one command works in both places.

## 8. Phases

Process as in the sandbox plan: forge agents in worktrees, an Opus adversarial review per phase with re-reviewed fix rounds, a PROGRESS.md cycle entry before each commit, a changeset for published packages, landing by fast-forward onto `main` (the sandbox plan said cherry-pick; this plan uses fast-forward), and deploying from `main`. Never push `main` to origin. Workers ships first, because the relay pattern is proven there and the owner's live deploy is Workers.

- [ ] **8a: spike (time box: 3 working days).** A throwaway Go client and a `RemoteComputerDO` on a branch deploy, with an enroll code hardcoded. It rules on four questions: hibernating sockets while a `SessionDO` RPC is pending; the inbound message limit; reconnect after DO eviction and after a deploy; and whether `resolveProvider` can take `computer_id` without a wide refactor. **Go** when, on the live deploy, with the binary behind NAT on this machine: a streaming and a non-streaming turn run `uname -a` and a 5 MiB upload/download round-trip; killing the binary mid-exec returns the offline reason within 35 s; warm exec overhead is under 1 s over 20 consecutive execs with none lost; and there are no casts. **No-go** on lost replies or an unexplained drop in the socket: fall back to HTTP long-poll from the binary.
- [ ] **8b: Workers MVP.** Tables, enrollment, the `RemoteComputerDO`, the provider, the agent attachment, Settings → Computers and the picker, OpenAPI and SDK regen, the audit log, and the revoke that closes sockets. Live test: create, copy the command, run it in Docker and bare, attach, run a real task (`git clone` and run its tests), revoke mid-session and confirm the next exec is refused and the socket closed.
- [ ] **8c: Node.** Standalone hub, then distributed routing over Redis request-reply. Live test: `pnpm smoke` stack plus a second replica; the turn on replica A reaches a machine connected to B.
- [ ] **8d: safety.** The approval gate for `exec` (core change), allow and deny lists, `workdir_only`, the `install-service` command, signed releases. Live test: an approval-required exec pauses the turn and runs only after approval.
- [ ] **8e: skills and Code Mode.** Capability-gated skill mounting; the Code Mode reverse channel. Live test: a skill runs, and an MCP call through `mcp-client` completes from the machine.

## 9. Decisions (owner, 2026-09-21)

1. **Scope: tenant-wide computers with a per-computer agent allowlist.** A computer belongs to the tenant, not to one agent. An admin chooses which agents may use each computer (`computer_agent_access`: `computer_id`, `agent_name`). An agent selects a computer with `sandbox.computer_id`; the server refuses a computer the agent is not allowed to use, at spec validation and again at turn time. Inline (unnamed) agents cannot use a computer. This replaces the per-agent attachment described in Sections 3 and 4 wherever they differ; the `sandbox.computer_id` field and `RemoteComputerProvider` stand.
2. **One computer serves many sessions:** yes, with per-session directories and 4 concurrent execs.
3. **Binary language: Go.** Single static binary, easy cross-compilation, no runtime on the target.
4. **Approval is on by default** for new computers; an admin can turn it off per computer.
5. **Offline at turn time: fail fast** with the last-seen reason.
6. **Admins only** create, manage, and grant access to computers.
7. **Agentum code: rewrite from the design.** The owner confirms Agentum is entirely their own work, so ideas and code may be ported freely.
8. **Windows and PTY** stay out until after 8e.

## 10. Phase 8a spike report

Run on 2026-09-21 against a throwaway Worker, `trueforge-computer-spike`, on `workers.dev` (no D1, no custom domain, two secrets set with `wrangler secret put`). The Worker has been deleted; the code is committed under `packages/trueforge/spikes/remote-computer/` and is excluded from the `trueforge` CI path filter.

The client is Go, built in Docker because Go is not installed on this machine (`golang:1.23`, `CGO_ENABLED=0`). Cross-compilation is real, not assumed: `linux/amd64` is 5,849,240 bytes and `darwin/arm64` is 5,709,906 bytes from the same source in one pass — well under the 10 MB Section 7 budgeted. It ran bare on this machine (behind NAT, no inbound port) and in a `busybox:1.37` container as uid 1000.

### Q1. Hibernating sockets while a caller's RPC is pending

**Sockets hibernate and survive; the pending map survives for the reason Section 4 gives; an evicted relay loses in-flight requests without an offline reason.**

A `boots` counter incremented in the constructor went 2 → 3 → 5 → 7 across idle gaps of 0, 5, 15, 30 and 60 seconds while `socket_count` stayed 1 and the connection generation stayed 1. The object is evicted from memory repeatedly and the socket outlives it. `getWebSocketAutoResponseTimestamp` kept advancing by one heartbeat interval through all of it, so liveness is readable after a wake without the object ever having been woken to record it.

The pending map is safe, but only by construction: an entry exists only while a caller's RPC is in flight, and an object with an in-flight RPC is not evicted. Nothing else in memory is safe. The spike proved this the hard way — `hello` was held in a field, the object hibernated seconds after the client connected, and the field was empty at the next call. It is storage-backed now. **Anything `RemoteComputerDO` must still know after an idle minute belongs in storage, not in a field.**

Forced eviction mid-request (`ctx.abort()` while an `exec` was pending) is the bad case. The caller's RPC **rejects**; it does not return an offline outcome. The Worker answered HTTP `error code: 1101` seventy-two milliseconds after the abort. The socket dropped too, and the client reconnected by itself 1.9 s later. A `wrangler deploy` while the relay was holding a request did the same: the socket dropped, the client reconnected after 3.6 s, the in-flight `exec` was never answered, and the `sleep 60` it had started kept running on the machine with nobody to collect it.

The same deploy also reset `CallerDO` and re-entered its `alarm()`. The idempotency guard caught it — the run was recorded as `alarm_entries: 2` with "alarm re-entered after a Durable Object reset" rather than replaying the work. `SessionDO` has the same exposure today.

A deploy while the relay was **idle** kept everything: generation unchanged, no reconnect in the client's log, and the next `exec` worked. So a deploy costs a reconnect only for the computers that were mid-request.

### Q2. Message size limit and the 5 MiB round trip

**The limit is exactly 33,554,432 bytes (32 MiB), it is enforced by closing the whole socket, and 256 KiB chunking gives a correct 5 MiB round trip.**

Frames from the client to the relay were accepted up to a 22,369,661-byte JSON message (a 16 MiB payload, 4.85 s). A 24 MiB payload produced a 33,554,491-byte message and the platform closed the connection with `StatusMessageTooBig` and the reason `Message is too large: 33554491 > 33554432`. That is 32 MiB to the byte.

The failure mode matters more than the number: **an oversized frame kills the connection, it does not fail one request.** The caller saw `offline … socket closed with 1006` and every other in-flight request on that computer died with it. A provider that sends an unchunked write is not slow, it is a disconnect.

In the other direction the relay sent payloads up to 4 MiB raw (about 5.6 MiB base64 on the wire) with no trouble; the ceiling was not probed further because the client's own read limit is set to 8 MiB.

The 5 MiB round trip, 20 chunks of 256 KiB, through the alarm-held caller:

| Leg      | Time     | Throughput |
| -------- | -------- | ---------- |
| Upload   | 2,408 ms | 2.08 MiB/s |
| Download | 2,919 ms | 1.71 MiB/s |

All four digests agreed (`ee75285c…41dd`): the bytes the caller generated, the digest the client computed after writing the file, the digest it reported at the start of the download, and the digest of the reassembled download. 5,242,880 bytes in, 5,242,880 bytes out.

Throughput is round-trip-bound, not bandwidth-bound: each chunk is a separate request that waits for its reply, so 5 MiB costs 40 sequential round trips at roughly 120 ms each. Pipelining a few chunks would multiply this several times over, and nothing in the protocol prevents it.

### Q3. Reconnect, offline detection, and revocation

| Event                                    | Caller learns after | How                                           |
| ---------------------------------------- | ------------------- | --------------------------------------------- |
| `SIGKILL` the client mid-exec            | 38 ms               | TCP closes, `webSocketClose` with 1006        |
| `SIGTERM` the client mid-exec            | 39 ms               | same                                          |
| Host freezes (`SIGSTOP`, TCP still open) | 23.1 s              | relay's heartbeat-staleness check, close 4408 |
| `revoke()` on a live socket              | 118 ms              | `revoke()` closes 4401 and fails the pending  |
| Relay force-evicted mid-request          | 72 ms               | **RPC rejection, not an offline outcome**     |

Killing the process is the easy case: the kernel closes the socket and the relay hears about it immediately. The case worth designing for is a laptop that suspends or loses its network, where TCP stays open and nothing arrives. `SIGSTOP` reproduces it exactly, and the relay's staleness check — comparing the platform's heartbeat timestamp against a 25 s threshold, polled every 2 s while a request waits — answered in 23.1 s with "Computer spike-a is offline (last seen 25 seconds ago)". **Under the 35 s target, and that is the worst case, not the typical one.**

No alarm is needed for this. Because the object is awake for the whole of a pending request, the staleness poll runs inside the request. A 5-second alarm across every connected computer would have cost a wake per computer per five seconds for nothing.

Reconnection was automatic in every case: 1.1 s after the 4408 close on thaw, 1.9 s after a forced eviction, 3.6 s after a deploy that reset the object. Backoff is uniform in [0.5c, c] with c = min(1000·2^step, 60000) ms; against a client that could not verify the certificate it went 1.79 s, 3.80 s, 4.21 s and kept growing.

`revoke()` closed the socket, failed the in-flight request with `revoked` in 118 ms, and refused the next request in 20 ms without touching the network. The client treated 4401 as terminal: it logged one line, exited 3, and wrote nothing else in the following 30 seconds. Agentum's gap — a rejected client hammering the endpoint forever — does not reproduce.

### Q4. Can `resolveProvider` take a `computer_id`?

**Yes, and the signature change is narrow. The cost is three behavioural sites and one missing field, not a wide refactor.** This is from code reading; nothing in this section was changed, and every line reference below was checked against the tree at `ae01be68`.

`resolveProvider` (`packages/trueforge/src/sandbox/integration.ts:27-32`) and `resolveSandboxUsability` (`:39-43`) already take a single options object, so an optional `computer_id` is additive. Two implementations change (`nodeSandboxIntegration.ts:38,55`, `workers/sandbox/workersSandboxIntegration.ts:64,78`) and two production call sites (`runtime/turnRunner.ts:142`, which has the spec in scope; `apis/turns.ts:230`, which does not). Core needs one field on `SandboxConfigSchema` (`packages/trueforge-core/src/agent-session/schemas/agentSpec.ts:162`); `TurnSandboxFactory` already passes the whole spec, so no core signature moves.

`sandboxRef.ts` needs nothing. Only the first colon after `v1:` is a delimiter and the raw id is a plain slice, so `v1:remote-computer:<computer_id>/<session_id>` round-trips with its slash and any colons intact, and `existingSandboxIdForProvider` carries it forward unchanged. The provider `type` is an open string, so `'remote-computer'` adds no union member — deliberately: making remote computers a sandbox-provider **settings manifest** instead would touch the closed union in `schemas/sandboxProvider.ts`, `apis/sandboxProviders.ts`, `apis/catalog.ts`, the UI catalog and the TrueFoundry store. Computers get their own tables, routes and Settings section; `sandbox.computer_id` stays the only selector.

Three sites would silently misbehave for a computer-attached agent today:

1. `turnRunner.ts:159` gates a fresh sandbox on `checkSnapshotStatus` (`:161`) for every provider except `local`. That call answers about the tenant's stored provider record — on Workers it returns `undefined` unless the built-in sandbox is enabled (`workersSandboxIntegration.ts:86`) — so a computer-attached agent gets 422 "sandbox image is activating". The `provider.type !== 'local'` exclusion has to widen.
2. `apis/turns.ts:230` (turn file download) has no spec. Either load the agent spec there or derive `computer_id` from the persisted ref with `parseSandboxId`; either way it needs its own tenant check.
3. `workersSandboxIntegration.ts:64-65` opens `resolveProvider` with `if (!(await isEnabledForTenant(…))) return undefined`, so `computer_id` must short-circuit **before** that line or a tenant without the built-in sandbox gets nothing. Node has the same ordering question at `nodeSandboxIntegration.ts:38`, where the stored record currently wins.

**The allowlist.** `validateAgentSpec` (`runtime/sessionResources.ts:224`, sandbox block 284-298, five callers across `apis/sessions.ts` and `apis/agents.ts`) has the spec and the tenant but no computer store. Put the check inside `resolveSandboxUsability` and let the integration own the lookup, rather than threading a new store dependency through five call sites. `capabilities.ts:51` has no spec, so `computer_id` must stay optional on that path. At turn time the same call is made again next to `turnRunner.ts:149`.

**`resolveSandboxUsability` when the computer is offline: `usable: true`.** Section 5 already says this and the spike agrees — a laptop is offline most of the time, and refusing to save or start an agent for that is wrong. Offline is a turn-time reason. But `SandboxUsability` (`integration.ts:15-19`) has no reason field today, so "unknown computer", "not allowed for this agent" and "revoked" cannot be told apart from each other or from "offline". **Add a reason to that shape**; the first three are `usable: false` and only offline is `usable: true`.

Two things to verify before promising the UX: whether a throw next to `turnRunner.ts:149` surfaces in the create-turn HTTP response or as a turn error event (it goes through `SessionHandle.createTurn`, `SessionHandle.ts:206-216`, and was not traced), and that `SandboxNotAvailableError` (`SandboxErrors.ts:20-28`, 410, "no longer exists") is not reused — its wording is wrong for offline and `Sandbox.ts` answers it by recreating the sandbox. A new subclass, mapped at `turns.ts:249-251`.

UI: the picker belongs beside the sandbox switch at `trueforge-ui/src/atoms/draft/AgentRuntimeConfigFields.tsx:73-88`. `SandboxConfig` and `AgentSandboxConfig` are owned by `@truefoundry/assistant-ui-runtime` and exported from the type barrel that `patches/@truefoundry__assistant-ui-runtime@0.1.37.patch` (the repository's only patch) already rewrites, so a typed `computerId` is a new hunk in that same file rather than a new patch. `packages/frontend` needs no change. OpenAPI and both SDKs regenerate.

### Warm exec and concurrency

Twenty consecutive `uname -a` through the alarm-held caller, which is the path a real turn takes:

| min   | median | mean  | max   | over 1 s | lost |
| ----- | ------ | ----- | ----- | -------- | ---- |
| 42 ms | 43 ms  | 44 ms | 63 ms | 0        | 0    |

The same command called straight from the Worker, with no alarm, took 50–58 ms wall and 27–30 ms inside the relay. **Holding the call inside `alarm()` costs nothing measurable.**

Four `sleep 3` issued together plus a fifth `uname -a`: the four finished at 3,063 ms each, so they ran in parallel, and the fifth finished at 3,091 ms — it waited for a slot and then took 28 ms. The cap and its queue behave as Section 4 describes.

### Exec semantics, checked in the container

- Deadline: exit **124** at 4,020 ms for a 4 s timeout.
- Process group: `(sleep 120 &) ; sleep 60` under a 4 s deadline left **zero** survivors. The detached grandchild dies with the group.
- `exit 7` returns 7 with stdout and stderr separated; `kill -TERM $$` returns **143**, not 1. Agentum reported 1 for every signalled command.
- Output cap: 3,000,000 bytes of output reported `bytes_total: 3000000`, `truncated: true`, and kept 524,288 bytes. Everything is counted, the head is kept.
- Relay-side cancel: with a 2 s relay timeout against a 300 s command, the caller got `timeout` at 12,001 ms (2 s plus the 10 s grace) and the client logged `cancel … cancelled: true`. The command did not outlive it.
- **Killing the daemon orphans its commands.** After `SIGKILL`, `/bin/sh -c sleep 400` was still running, reparented to PID 1. Nothing collects it.
- The `busybox` image needed the CA bundle copied from the build stage. Without it the client loops on `x509: certificate signed by unknown authority` — with correct backoff, but forever.
- Capability detection works and would do the right thing: the container reported `python3: false, git: false`, the host `true, true`.

### Verdict: go

Against the Section 8 criteria:

| Criterion                                                 | Result                                            |
| --------------------------------------------------------- | ------------------------------------------------- |
| Offline reason within 35 s of killing the binary mid-exec | **Pass** — 0.04 s on a kill, 23.1 s on a freeze   |
| Warm exec under 1 s over 20 consecutive execs, none lost  | **Pass** — 63 ms worst, 0 lost                    |
| 5 MiB upload and download round trip                      | **Pass** — digests match on all four measurements |
| No casts                                                  | **Pass** — guards and parsers, no `as`, no `!`    |
| No unexplained drop in the socket                         | **Pass** — every drop had a named cause           |
| No lost replies                                           | **Qualified** — see below                         |
| A streaming and a non-streaming turn                      | **Not tested** — see below                        |

**Not tested, and why.** The real streaming and non-streaming turns need the signed-in production app, and this spike had no browser access and was barred from touching `trueforge.rockyshoreslabs.io`. `CallerDO` is the stand-in: it calls the relay over RPC from inside `alarm()`, which is exactly what `SessionDO` does, and it passed. The controller runs the real turns before 8b closes. Nothing measured here depends on the turn loop, so the risk is integration, not transport.

**The qualification on lost replies.** Replies are not lost on the wire, on reconnect, or under load. They are lost when the relay object itself is reset mid-request — a forced eviction or a deploy against an active object — and the caller gets an RPC rejection rather than an outcome. That is explained, bounded, and the same exposure `SessionDO` already documents for turns; it is not the "unexplained drop" the no-go clause is about. It does mean the provider must treat an RPC rejection as a first-class failure, which is a requirement below, not a blocker. **No fallback to HTTP long-poll is needed.**

### Changes to Sections 4 to 8 before 8b starts

**Section 4, relay.**

1. **`request()` can still reject.** Section 4 promises the provider never throws; the transport does not honour that. `RemoteComputerProvider` must wrap every RPC call and map a rejection to the same offline-shaped failure, with its own message ("the connection to the computer was interrupted"), so a reset relay reads like an offline computer rather than a 500.
2. **Say that only the pending map may live in memory.** Last-seen, capabilities, the connection generation, the revoked flag and the enrolled identity all go to storage. The spike lost `hello` to a hibernation within seconds of connecting.
3. **Drop the periodic liveness alarm; poll inside the pending request.** The object is awake for the whole of a request, so a 2-second poll against `getWebSocketAutoResponseTimestamp` catches a frozen host in 23 s with no wake cost. Keep the 60 s alarm only for writing last-seen while connected, as Section 4 already says.
4. **Track the current socket by connection generation, not identity.** A socket closed on replacement stays in `getWebSockets()` long enough to be picked for dispatch. The generation lives in storage, is stamped into the attachment at accept, and is checked on dispatch, on reply and on close.
5. **Register the pending entry before writing the frame,** on both sides. The reply can arrive first.
6. **Per-request timeout with the grace, plus a bounded queue.** `timeout_ms + 10 s`, and a cap on queue depth (32 in the spike) so a stalled computer cannot grow an unbounded backlog.

**Section 4, chunking and limits.**

7. **Record the measured limit: 32 MiB, enforced by closing the socket.** Section 4 says the spike must measure it; the number is 33,554,432 bytes and the consequence is a disconnect, not a failed request. 256 KiB stays, with a hard guard in the provider so no path can build a larger frame.
8. **Pipeline file chunks.** 1.7–2.1 MiB/s is a round-trip artefact. Allow a small window of in-flight chunks per transfer.
9. **Keep head and tail, not head only.** The spike kept the head, as Agentum did, and 3 MB of output came back as the first 512 KiB. Build and test failures are at the end. Split the 1 MiB cap and mark the elision.

**Section 4, and a new line in Section 6.**

10. **Killing the daemon leaves its commands running.** Verified. The daemon must record its process-group ids and sweep them on startup, and the service unit should use a cgroup (`KillMode=control-group`) so a stop takes the group with it.
11. **A reset relay leaves an orphaned command.** The command keeps running and its output is discarded. 8b should re-send `cancel` for a request the relay no longer has a caller for, and the audit row should record that the outcome is unknown.

**Section 5.**

12. **`SandboxUsability` needs a reason field.** Otherwise "unknown computer", "not allowed for this agent", "revoked" and "offline" are one boolean. Offline is the only one that stays `usable: true`.
13. **Put the allowlist check inside `resolveSandboxUsability`.** `validateAgentSpec` has five callers and no computer store; giving the integration the lookup keeps the change to one place.

**Section 7.**

14. **The binary is ~5.7 MB, not ~10 MB,** for both targets, with `-trimpath -ldflags "-s -w"`.
15. **The image must carry a CA bundle.** A scratch or busybox base without one fails to dial and retries forever. Say so where the distroless image is specified.
16. **The client must check its own heartbeats.** Without a read deadline of about two intervals, a half-open socket looks connected. The spike closes and reconnects after two unanswered pings.
17. **Treat 4401 as terminal and reset the backoff step only after a stable connection,** not on every open. Agentum reset on open, which is why two clients sharing a credential could evict each other forever.

**Section 8.**

18. **8b must cover a deploy during an active turn** in its live test, not just create/attach/revoke. It is the one event that loses an in-flight request, and it happens on every release.
19. **Add the `probe` op to the protocol permanently**, or keep an equivalent, so the frame ceiling can be re-measured when the platform changes it.
