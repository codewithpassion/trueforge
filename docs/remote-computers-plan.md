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
