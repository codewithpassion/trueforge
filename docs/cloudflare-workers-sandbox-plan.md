# Cloudflare Workers sandbox plan (Phase 7)

Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation. It follows `docs/cloudflare-workers-port-plan.md`, which shipped Phases 0 to 5 with code execution disabled.

Status: proposed on 2026-09-16. Phases 7a and 7b are complete; 7c (Code Mode) is built and reviewed, with the review fixes on the branch but not yet deployed; its live acceptance test has not run. Section 8 records what 7a steps 1 to 8 found, Section 9 the 7a live acceptance test, Section 10 the Section 6 verdict, Section 11 Phase 7b: skills plus the two must-fixes 7a left behind, Section 12 the settings surface that replaced the deploy-var-only switch, and Section 13 Phase 7c: Code Mode, its design note and what is still open.

Goal: restore code execution on the Workers deploy with a Cloudflare-native sandbox provider, starting with a time-boxed spike on Cloudflare Computer (`@cloudflare/computer`). The spike decides whether Computer, or the Cloudflare Sandbox SDK as the fallback, backs a new `SandboxProvider`.

Non-goals for this plan:

- Changing the Node deployments. Daytona, TrueFoundry, and the local sandbox stay as they are.
- ~~Exposing the new provider through the settings API. The settings OpenAPI stays Daytona-only, so there is no SDK or OpenAPI regeneration.~~ Revised: the deploy var alone left Settings offering only Daytona, which cannot work on Workers. Section 12 records the settings surface that replaced it.
- Production readiness while Computer is a preview. Its README says it is "NOT suitable for production use at this time".

## 1. What exists today

**Provider contract.** `packages/trueforge-core/src/core/sandbox/provider/Provider.ts` defines `SandboxProvider`. A provider implements:

- `type`
- `buildImage` and `getImageBuildStatus`
- `createSandbox`
- `exec({ sandboxId, command, cwd, env, timeoutSeconds })`, which returns `{ success, response: { exitCode, result } }`
- `uploadFile` and `downloadFile`
- path getters for tool-result dumps, file uploads, skills, the skill downloader, and git credentials
- `getAdditionalInstructions`
- `createCodeModeTransport`

**Sandbox lifecycle.** `Sandbox.ts` drives the provider:

- It creates the sandbox lazily on first use.
- On first init it runs one `mkdir -p` for the upload, dump, and skills directories.
- It uploads the Code Mode MCP client (`mcp_client.py`) when a Code Mode transport exists.
- It runs the skill downloader, `python3 skill_downloader.py`.
- It writes git credentials.
- It recreates the sandbox when the provider throws `SandboxNotAvailableError`.

**Existing providers.**

- `DaytonaProvider` runs on `@daytona/sdk`.
- `TFYSandboxProvider` talks to an HTTP server.
- `LocalSandboxProvider` is Node standalone only.

Code Mode uses `CodeModeNatsTransport`: the host connects to a NATS server inside the sandbox over WebSocket, using `ws` and a global `WebSocket` assignment.

**Integration seam.** `packages/trueforge/src/sandbox/integration.ts` defines `SandboxIntegration`. It resolves a provider for a tenant, reports image status, builds a turn `Sandbox`, and holds the Daytona helpers. The Workers runtime passes `sandboxIntegration: undefined` in `src/workers/runtime.ts` and `src/workers/SessionDO.ts`, so routes report sandbox and skills as disabled.

**Sandbox image.** `packages/trueforge-core/scripts/sandbox/sandbox.Dockerfile` builds on `python:3.13-slim-bookworm`. It installs:

- apt packages: git, jq, ripgrep, supervisor, curl, zip
- helm
- `nats-server`, run under supervisor
- Python packages: aiohttp, mcp, nats-py, pandas, pydantic, requests

The digest is pinned in `sandboxImage.json`.

## 2. Options

|                     | A. Cloudflare Computer, container backend                                                   | B. Sandbox SDK, stable (`@cloudflare/sandbox` 0.12.x)              | C. Sandbox SDK 1.0 preview (`@next`)                        | D. Daytona from Workers                         |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------- |
| Maturity            | Preview, 0.3.0, five releases in about six weeks                                            | Stable line, experimental label since launch                       | Preview                                                     | Existing provider                               |
| Runs on             | Cloudflare Containers plus a Durable Object that owns a SQLite VFS                          | Cloudflare Containers plus a Durable Object                        | Same as B                                                   | Daytona cloud                                   |
| Exec                | `workspace.runtime.exec(cmd, { cwd, env, timeoutMs })` gives `{ exitCode, stdout, stderr }` | `sandbox.exec(cmd)`                                                | argv process handles; the call resolves at launch, not exit | `@daytona/sdk`                                  |
| Files               | `workspace.fs` (`node:fs/promises`-like), durable in DO SQLite                              | files API in the container                                         | files API                                                   | SDK                                             |
| Durable workspace   | Yes: DO SQLite is authoritative, and the container VFS is resynced after a restart          | Container disk only; backup and restore APIs exist                 | Container disk                                              | Daytona volumes                                 |
| Ports and Code Mode | No public port; container to DO over capnweb                                                | `exposePort` (needs a wildcard custom domain) or `sandbox.tunnels` | tunnels                                                     | preview URLs (today's NATS path)                |
| New infra           | Container image with `computerd`                                                            | Container image from the SDK line                                  | Same as B                                                   | None on Cloudflare; Daytona account             |
| Unknowns            | API churn, FUSE I/O, stdout size, casts in examples                                         | Session model, image size                                          | API churn                                                   | Whether `@daytona/sdk` and `ws` load in workerd |

**Choice.** Spike A first, because it keeps the workspace in the session's own Durable Object and matches the "one computer per agent session" model. Keep B as the fallback. Put the provider behind the existing `SandboxProvider` contract, so the backend can switch without touching `Sandbox.ts` or the routes.

D is out of scope, except for one Phase 0-style load check, recorded as spike step 7a.1. If `@daytona/sdk` loads in workerd, it is a cheap way to offer bring-your-own sandbox on Workers.

## 3. Target architecture

```
Worker (HTTP) ──RPC──► SessionDO (tenant:session)          turn loop, alarm-held
                           │  CloudflareComputerProvider (implements SandboxProvider)
                           │  RPC per call
                           ▼
                       ComputerDO (tenant:session)          Workspace + CloudflareContainerBackend
                           │  capnweb WebSocket, egress interceptor
                           ▼
                       Container: trueforge-computer image  computerd (FUSE /workspace) + sandbox userland
```

**Rules.**

- **Storage type gap.** `DurableObjectStorage` is not assignable to Computer's `DurableObjectStorageLike`. Its `sql.exec<Row extends object>` promises `Row[]` for a row type the caller picks, while workerd's `SqlStorage` only ever yields `Record<string, SqlStorageValue>`, so no implementation can honour the wider promise and the Computer examples reach it with `as unknown as`. `src/workers/sandbox/workspaceStorage.ts` keeps that one unprovable step in an overload declaration instead of a cast. That is not sound either — an overload signature widens the same way — but it is three lines with a note rather than an assertion at a call site, and bindings pass through untouched because the workspace binds chunk hashes as byte arrays that a narrower guard rejects. Report it upstream; drop the adapter once Computer's storage port is parameterised on the row type.
- **Separate class.** `ComputerDO` is a new container-enabled Durable Object class, not a mixin on `SessionDO`. This keeps `SessionDO` free of container wiring, gives the container binding its own `class_name`, and keeps the `SessionDO` migrations untouched. It uses the same name, `tenant_id:session_id`, so one session maps to one workspace.
- **Provider location.** `CloudflareComputerProvider` lives in `packages/trueforge/src/workers/sandbox/`. It is Workers-only and never imported by Node entrypoints. It calls `ComputerDO` over Workers RPC, and each RPC call keeps `ComputerDO` active for the duration of the command. The `SessionDO` side is already held by its alarm or stream.
- **Sandbox id.** `createSandbox` returns the `ComputerDO` name as the raw id. `Sandbox.ts` persists it as `v1:cloudflare-computer:<tenant>:<session>`.
- **Paths.** Everything lives under the mount root `/workspace`:
  - uploads: `/workspace/uploads`
  - tool-result dumps: `/workspace/.trueforge/tool-results`
  - skills: `/workspace/.trueforge/skills`
  - skill downloader: `/workspace/.trueforge/bin/skill_downloader.py`
  - git credentials: `/workspace/.trueforge/git-credentials`
  - All paths are absolute. `exec` defaults `cwd` to `/workspace`.
- **Method mapping.**
  - **`exec`:** calls `runtime.exec` on the container backend, drains `result()`, and maps it to `{ success: true, response: { exitCode, result: stdout + stderr } }`. Infrastructure failures (connect, `EEXEC_LOST`, sync `pending` after a completed command) map to `{ success: false, error }`.
  - **`timeoutSeconds`:** becomes `timeoutMs`. The default comes from a deploy var.
  - **`uploadFile`:** `workspace.fs.writeFile`.
  - **`downloadFile`:** `workspace.fs.readFile`. It streams across RPC, because a serialized RPC message caps at 32 MiB. It maps not-found, directory, and too-large errors to the `SandboxErrors` classes. The size cap reuses `SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD`.
  - **`buildImage` and `getImageBuildStatus`:** return `ready`, because `wrangler deploy` builds and rolls the image. There are no runtime builds.
  - **`getAdditionalInstructions`:** a short note that `/workspace` persists across the session and the container may restart.
  - **`createCodeModeTransport`:** throws in 7a and 7b. Phase 7c replaces this.
- **Provider selection.** Written here as deploy-configured, not settings-configured; Section 12 replaced that with a deploy var that makes the provider _available_ and a settings record that turns it on.
  - `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer` in `wrangler.jsonc` vars enables it.
  - `WorkersSandboxIntegration` implements `SandboxIntegration`:
    - `resolveProvider` returns the Computer provider when enabled and `undefined` otherwise.
    - `isSandboxUsableWithoutStoredRecord` returns `true` when enabled: the workspace comes from the deploy var and never has a stored record. (Written here as `isLocalFallbackEnabled` returning `false`; Section 9 found that rejects every sandbox-enabled agent, and the flag was renamed in 7b to say what it means. Section 12 removed the flag altogether: a stored record decides, and one method answers.)
    - `checkSnapshotStatus` returns `ready`.
    - The Daytona helpers throw a typed "not supported on Workers" error. The existing settings routes already return `404` and `422` on Workers.
  - If a stored record type is needed, add `cloudflare-computer` to `StoredSandboxProviderManifestSchema` only (store and runtime, not OpenAPI), the same way `truefoundry` is handled. Section 12 needed one, and put it on the wire as well.
- **Egress.** The spike starts with `egress: { mode: "direct" }`. Phase 7d moves to an `http-gateway` allowlist.
- **Image.** A new `packages/trueforge/workers/computer.Dockerfile` builds `FROM` the pinned TrueForge sandbox image digest.
  - It copies `computerd` from `ghcr.io/cloudflare/computer-computerd-linux-x64:<exact version>` and installs `fuse3`.
  - It sets `ENTRYPOINT ["/usr/local/bin/computerd"]` with `MOUNT_POINT=/workspace` and `FUSE_MOUNT=auto`.
  - supervisor and `nats-server` are not started in 7a and 7b. Phase 7c decides whether NATS stays.
  - The `computerd` image tag and the npm package version are pinned to the same exact version and bumped together.

## 4. Phases

### Phase 7a: spike, exec and files (time box: 3 working days)

1. **Gate: load checks in workerd** (`tests/workers`, dry-run bundle):
   - `@cloudflare/computer` and `@cloudflare/computer/backends/container` load with `nodejs_compat` and without the `experimental` flag.
   - Record whether `@daytona/sdk` loads, for option D.
   - If Computer needs `experimental` for the container backend, stop and report. The Worker backends need it, and we do not use them.
2. **Dependencies.** Add `@cloudflare/computer` at an exact version with pnpm, per the Bun scope decision. Never hand-merge the lockfile.
3. **`ComputerDO`.** Add it with `withWorkspaceContainer` and a `CloudflareContainerBackend`.
   - `withWorkspace` is not used: it exists to hand a Worker a stub through `getWorkspace`, and the package exports neither the `WORKSPACE` symbol nor a stub type a `DurableObjectStub<ComputerDO>` satisfies, which is the second cast in the examples. `ComputerDO` instead owns its `Workspace` and exposes exec and file access as plain RPC methods whose arguments and results are serializable, which is also what lets the provider map failures to the `SandboxErrors` classes (error classes do not survive Workers RPC).
   - The Worker entry must re-export `WorkspaceProxy`: the container's egress interceptor is built from `ctx.exports.WorkspaceProxy`, which only resolves for a `WorkerEntrypoint` exported at the Worker's top level, in every egress mode.
   - The Computer examples cast `ctx.storage` and the stub (`as unknown as`). This repo forbids casts. Write a typed adapter with guards, and if the package types make that impossible, record the exact type gap and report it upstream instead of casting. The storage gap is real and is described in Section 3.
4. **`wrangler.jsonc` and types.**
   - Add the `containers` entry (`class_name: "ComputerDO"`, `image: "./workers/computer.Dockerfile"`, `instance_type` starting at `standard-2`, `max_instances` 5).
   - Add the `COMPUTER_DO` binding and migration `v3` with `new_sqlite_classes: ["ComputerDO"]`.
   - Regenerate `worker-configuration.d.ts` with `pnpm workers:types`.
5. **Provider.** Implement `CloudflareComputerProvider` for `exec`, `uploadFile`, `downloadFile`, and the path getters, with unit tests against a fake `ComputerDO` stub.
6. **Integration.** Wire `WorkersSandboxIntegration` into `createWorkersRuntimeDeps` and `SessionDO`, behind `TRUEFORGE_SANDBOX_BACKEND`. With the var unset, everything behaves as today, and a Workers test pins that.
7. **Capabilities.** `GET /api/v1/capabilities` reports sandbox enabled when the var is set. Skills stay disabled until 7b.
8. **Local check.** `pnpm workers:dev` needs Docker for containers. `computerd` falls back to its userspace FUSE shim under `wrangler dev`. Record whether local exec works. If it does not, the live deploy is the only test.
9. **Live acceptance test on the deploy.** Enable the var, deploy, then run each item as a streaming turn and a non-streaming turn:
   - An agent with `sandbox.enabled` runs `exec` for `python3 --version`, `ls -la /workspace`, and `echo hi > /workspace/a.txt && cat /workspace/a.txt`.
   - A second turn in the same session reads `/workspace/a.txt`, which shows persistence across turns.
   - A large Context7 result is offloaded to `/workspace/.trueforge/tool-results` and read back with `exec`.
   - A non-inline file upload lands in `/workspace/uploads`, and a turn file download returns it.
   - An agent with `sandbox.enabled` and one MCP server runs a turn that calls an MCP tool directly, since Code Mode is off on this provider until 7c.
   - Record cold-start time, exec latency, and the alarm invocation's CPU.
   - Record Containers cost (vCPU, memory, egress) and how long a container stays warm, so 7d can set `max_instances` and the idle timeout from measurements rather than guesses.
   - Record whether any command's output hit the 1 MiB cap.
10. **Spike report.** Findings and a go or no-go against Section 6, appended to this document. Commits stay on a worktree branch until the Opus review.

### Phase 7b: skills

1. Confirm the sandbox userland has the Python packages `skill_downloader.py` needs, via the image in Section 3.
2. Turn on skills in the Workers capabilities when the provider is enabled.
3. **Live test:**
   - Attach one catalog skill to an agent.
   - Verify the mount under `/workspace/.trueforge/skills` and a turn that uses it.
   - Verify that removing the skill cleans it up on the next init.
4. Measure init time. Skill downloads run inside the first `exec` of a turn, and a slow download counts against the 14-minute alarm window.

### Phase 7c: Code Mode transport

Code Mode needs a channel from the sandbox's `mcp_client.py` back to the host dispatcher. NATS over a public WebSocket does not exist here.

1. Design a `CodeModeTransport` that fits Computer. Candidates:
   - `mcp_client.py` calls HTTP on the container's egress host, which the egress interceptor routes to `ComputerDO`, which forwards to `SessionDO` over RPC.
   - A small in-container relay that `computerd` exposes over capnweb.
   - Pick one in a short design note appended here. The Opus review covers the security of the egress route, since no other tenant's session may be reachable.
2. Implement it behind the existing interface, and keep `CodeModeNatsTransport` for the Node providers.
3. **Live test:** an agent with Code Mode and one MCP server runs a script that calls two tools and returns a value.

The design note and the results are Section 13; the egress route won.

### Phase 7d: hardening

- **Egress.** Use `http-gateway` mode with an allowlist from config. The default denies everything except the model provider hosts the sandbox needs, the skill catalog, and git hosts.
- **Process user.** Run `computerd` and exec as a non-root user once Computer supports it. Track the open item in Computer's `docs/07_injected_service.md`.
- **Container lifetime.** Set idle sleep and instance limits, and document the cost of Containers vCPU, memory, and egress next to Durable Objects and D1.
- **Signal versus timeout.** `ComputerDO` must record whether its own `timeoutMs` fired, so a command killed by a signal (137 for out of memory) stops reading as a sandbox timeout. Computer derives `cancelled` from the exit code alone and cannot tell them apart.
- **Cancellation.** A cancelled turn does not cancel the command it is waiting on: `SandboxExecParams` carries no `AbortSignal`, so `runtime.exec` runs to its own timeout while the turn is already terminal. Give the provider contract a signal, thread it to `runtime.killExec`, and keep the Node providers behaving as they do today.
- **Instance limits.** `max_instances` bounds concurrent sessions; past it a session gets whatever the platform returns. Decide the limit from the 7a.9 cost numbers. Mapping the no-capacity failure to a message that names the limit moved into 7b (Section 11).
- **Container restart.** Verify on the deploy that the DO SQLite state resyncs into a fresh container, that `SandboxNotAvailableError` recreates correctly, and that an in-flight exec reports `EEXEC_LOST` as `{ success: false }`.
- **Deploy guide.** ~~Update `docs/deploy/cloudflare.mdx`: sandbox, skills, and Code Mode move out of "Not supported on Workers" into a section on enabling code execution, with the preview warning.~~ Done in 7b; only Code Mode is still listed as unsupported.
- **Changesets.** One for `@truefoundry/trueforge`, plus the frontend if capabilities change the UI.
- **CI.** Workers tests with a stub `ComputerDO`. Container image builds need Docker in CI (see the port plan's Section 8 backlog).

## 5. Rules for every phase

- Same process as Phases 0 to 5:
  - forge agents in worktrees
  - an Opus adversarial review per phase, re-reviewing fix rounds
  - the progress skill before each commit
  - landing by cherry-pick
- **Casts.** No casts, no `.dev.vars`. Never create `packages/trueforge/.env` before running `wrangler types`.
- **Wrangler.** Use `bunx wrangler@4.131.2` unless a Containers feature needs a newer pinned version. Bump the pin in one commit and regenerate types.
- **Scope.** Node sandbox code in `trueforge-core` stays untouched except for additions that every provider needs. Any change there needs its own changeset and must keep Daytona, TFY, and local tests green.
- **Live testing.**
  - Start the log tail before the tests.
  - Test both streaming and non-streaming turns.
  - Record invocation wall and CPU from the tail, not only the API status.

## 6. Go or no-go criteria after 7a

Go, continuing to 7b with Computer, when all of these hold:

- Every item in 7a.9 passes on the live deploy, in both streaming and non-streaming turns.
- There are no casts, or only an upstream-reported type gap with a typed adapter.
- A cold start plus the first exec takes under 30 s, and warm exec overhead is under 1 s.
- There are no unexplained sync `pending` results or lost execs across 20 consecutive execs.

Switch to option B, the Sandbox SDK stable, with the same provider shape, when any of these happens:

- The container backend needs the `experimental` flag.
- The API changed in a way that broke the pinned version within the spike.
- Stdout or file transfer limits make large tool results or downloads fail.
- The capnweb or FUSE path is unreliable on the deploy.

Stop, and keep code execution disabled, when both A and B fail the live exec and file tests.

## 7. Risks and open questions

- **Preview churn.** Pin exact versions of the npm package and the `computerd` image, and re-run 7a.9 on every bump.
- **Container VFS is in memory.** A container restart loses the container-side state. DO SQLite stays authoritative and resyncs, and 7d verifies that.
- **Alarm window.** An exec runs inside an alarm-held or streaming turn. A long command or a slow skill download counts against the 14-minute alarm pass. The per-exec timeout must stay well below it.
- **RPC limits.** A serialized message caps at 32 MiB. Downloads and large stdout must stream. Record whether `runtime.exec` stdout is buffered, and its size limit.
- **FUSE I/O.** Heavy I/O (package installs, big archives) is slower than native disk, per Computer's `docs/19_performance.md`.
- **A signalled command is indistinguishable from a timeout.** Computer maps exit codes 129, 130, 137 and 143 to `cancelled`, so a user command the kernel kills — an out-of-memory kill is 137 — reaches the agent as "Sandbox exec timed out", which sends it to shorten the command rather than shrink its memory. Recorded, not fixed: 7d gives `ComputerDO` a record of whether its own timeout fired, so the provider can tell the two apart.
- **Security.**
  - `computerd` runs as root by default.
  - Egress starts as direct.
  - One `ComputerDO` per session keeps workspaces isolated between tenants and sessions. The Opus review must check that the RPC surface does not accept a caller-supplied DO name.
- **Cost.** Containers bill vCPU, memory, and egress on top of Durable Objects and D1. Measure it in 7a.9 before recommending the feature.
- **Local development.** Containers need Docker for `wrangler dev`. The main checkout's Docker smoke rule (no root-owned files) applies.
- **Deploy.** Rolling a new image restarts containers, and a deploy already cancels running turns.

## 8. What Phase 7a steps 1 to 8 found

Built on a worktree branch off `feat/cloudflare-workers-port`. Step 9 (live acceptance test) and step 10 (spike report and the Section 6 verdict) are still open; nothing here decides go or no-go.

**Gate (step 1): pass.** `@cloudflare/computer` and `@cloudflare/computer/backends/container` both load in workerd under `nodejs_compat` with no `experimental` flag, and the same Worker bundles and passes `wrangler deploy --dry-run`. Only the worker-shell and worker-javascript backends need `experimental`, and neither is used. `tests/workers/sandboxBackendLoad.test.ts` keeps this honest. The same test records the option D data point: `@daytona/sdk` also loads in workerd.

**Computer API used.** `Workspace` (`fs.writeFile`, `fs.readFile`, `fs.lstat`, `fs.mkdir`, `runtime.exec`), `CloudflareContainerBackend`, `withWorkspaceContainer`, and `WorkspaceProxy`. `runtime.exec(command, { cwd, env, timeoutMs, encoding: 'utf8' })` returns a disposable handle whose `result()` gives `{ status, exitCode, stdout, stderr, sync }`; `status` is `completed | failed | cancelled` and `sync.status` is `complete | pending`. This section first read `status` as the line between a non-zero exit and an infrastructure failure; Section 9 found that it is not. Computer derives `status` from `exitCode` alone — `0` is `completed`, a signal code is `cancelled`, everything else is `failed` — and leaves `exitCode` at `-1` when no exit event arrived. A negative exit code, not `failed`, is what says the command never launched; `sync.status` covers the second failure, a command that ran without its writes reaching the store.

**Type gaps.** One, described in Section 3: `ctx.storage` is not assignable to `DurableObjectStorageLike`, and no implementation of that interface can be sound. It is the single deviation from the no-cast rule and is worth reporting upstream. The other two casts in the Computer examples are avoided by owning the `Workspace` inside the Durable Object and exposing typed RPC methods; `tests/workers/computerDO.test.ts` proves at runtime that a `DurableObjectStub<ComputerDO>` satisfies the port and that a `ReadableStream` inside a discriminated-union return survives Workers RPC.

**Local containers (step 8): not working here, so the live deploy is the only exec test.** `pnpm workers:dev` starts, builds the container image from `workers/computer.Dockerfile`, and serves (`/healthz` 200, `/api/v1/capabilities` 401 unauthenticated) with `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer` set. Exec then fails: the Workspace reports `workspace.container.exited` with `reason: "Container failed to start"`, and `connect failed at stage=egress port=8080`, after about 30 s per attempt. Docker only ever creates the `cloudflare/proxy-everything` sidecar; the workload container is never created. Isolated on a throwaway probe Worker that calls `ComputerDO` directly:

- A minimal `debian:stable-slim` plus `computerd` image fails identically, so it is not our base image.
- wrangler 4.131.2 and 4.132.0 fail identically, so the pin stays at 4.131.2.
- `computerd` from the built image runs fine outside wrangler: `FUSE_MOUNT=auto` resolves to the userspace shim and it listens on `:8080`.

Environment: Docker 29.2.1, overlayfs, cgroup v2, not rootless.

**`workers:check` now builds the container image.** `wrangler deploy --dry-run` builds `workers/computer.Dockerfile`, so the check needs Docker and anonymous pull access to `ghcr.io/cloudflare/computer-computerd-linux-x64` and the TrueForge sandbox image. A stale `ghcr.io` credential in `~/.docker/config.json` breaks it with `failed to authorize`. This belongs in the port plan's Section 8 CI backlog.

**Bundle.** 5423 KiB (from 4973 KiB), gzip 989 KiB; startup about 85 ms active. `just-bash` and its native codecs stay out of the bundle because the worker-shell backend is never imported.

**Deploying is not a no-op even with the var unset.** Runtime behaviour is unchanged — no provider resolves, capabilities report code execution off — but the `containers` entry provisions Containers on the account and pushes the image on the next deploy. Turning the feature off is the var; not provisioning is removing the `containers` entry.

**Limits chosen here.**

- Exec output: stdout plus stderr is capped at 1 MiB in `ComputerDO`, past which the head is kept and a marker names the full size. A serialized RPC message caps at 32 MiB, and an uncapped result would fail opaquely there and again on the way into the model's context. No Node provider caps exec output today; this cap is Workers-only.
- Exec timeout: `SANDBOX_EXEC_TIMEOUT_SECONDS` is capped at two thirds of the alarm pass that holds a turn (560 s of 840 s), so a command cannot outlast the pass waiting for it.
- Container idle: `ComputerDO` asks for a 10-minute inactivity timeout after the first command, best effort.

**Code Mode is off by capability, not by exception.** `SandboxProvider` gained `supportsCodeMode`; `Sandbox.configureCodeMode` returns early when it is false, so `createCodeModeTransport` is never called and the `mcp_client` instructions stay out of the prompt. MCP tools remain available to the model directly. Node providers set it to `true` and behave exactly as before. A Workers test runs a whole turn with `sandbox.enabled` and one MCP server; flipping the flag back to `true` fails it.

**Still open from the review.** The no-capacity failure past `max_instances` is not mapped to a message that names the limit; Section 9 records the error shape observed live. (7b closed this — see Section 11.) The container inactivity timeout is set once per Durable Object instance, so a container that restarts under a live instance keeps the platform default until that instance is evicted.

## 9. Phase 7a step 9: the live acceptance test

Run on `trueforge.rockyshoreslabs.io` on 2026-09-16 against Worker version `98fa9ab0-7a55-41fc-8b86-243c385db2e3`, with `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer` in `wrangler.jsonc` vars. `wrangler tail --format json` ran from before the first deploy until after the last test; 328 invocations were captured and none threw.

**Deploy.** Containers is enabled on the account and `wrangler deploy` provisioned it without complaint. The image built from `workers/computer.Dockerfile` and pushed as `registry.cloudflare.com/<account>/trueforge-computerdo@sha256:69ab7479…`, creating application `trueforge-computerdo`. `instance_type: standard-2` resolves to 1 vCPU, 6 GiB memory, 12 GB disk on the firecracker runtime. Worker bundle 5462 KiB, gzip 996 KiB, startup 230 ms. The remote D1 migration `0002_integration.sql` applied first (10 commands, 2.11 ms); `PRAGMA table_info(integration_delivery)` confirms it on the remote database. `/healthz` answers 200 and `/api/v1/capabilities` answers 401 unauthenticated. The Containers application takes about three minutes to move from `provisioning` to `ready` after the first deploy; cold-start numbers taken before that measure image distribution, not container start.

**One blocker had to be fixed before any turn could run.** With the var set, `GET /api/v1/capabilities` reported the sandbox enabled while `POST /api/v1/agents` with `sandbox.enabled` answered 422 "no sandbox provider is configured". Two definitions of "configured" had drifted: `capabilities.ts` asks `checkSnapshotStatus()`, which the Workers integration answers `ready`, while `validateAgentSpec` in `sessionResources.ts` requires a row in the sandbox-provider table or `isLocalFallbackEnabled()`, which returned `false`. The Workers workspace comes from the deploy var and never has a stored record, so every sandbox-enabled agent and session was rejected. The integration now reports that a sandbox needs no stored record, which is what the port's own doc comment already says the flag means. The name `isLocalFallbackEnabled` now reads wrong on Workers and is worth renaming in the review. `tests/workers/sandboxTurn.test.ts` could not catch this because it writes its session straight to the store; the pin added here drives the real validator.

**Results.** Every item ran once as a streaming turn and once as a non-streaming turn. All passed. The upload was worth running twice rather than assuming: `startStreaming` bypasses `startTurnInProcess`, so a file part inside a streaming body is its own path, and it is the one the UI uses.

| 7a.9 item                                             | Non-streaming                          | Streaming                            |
| ----------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `python3 --version`                                   | pass, `Python 3.13.15`                 | pass                                 |
| `ls -la /workspace`                                   | pass, `.trueforge` and `uploads` only  | pass                                 |
| `echo hi > /workspace/a.txt && cat …`                 | pass                                   | pass                                 |
| Second turn reads `/workspace/a.txt`                  | pass, 312 ms, no new sandbox           | pass                                 |
| Large tool result offloaded and read back with `exec` | pass, 3 files (9871, 6374, 6231 bytes) | pass, 2 files (9988, 6374 bytes)     |
| Non-inline upload to `/workspace/uploads`             | pass, 3034 bytes, 201 lines            | pass, 1206 bytes, 151 lines          |
| Turn file download                                    | pass, byte-identical, 172 ms           | pass, byte-identical, 197 and 641 ms |
| Sandbox plus one MCP server, tool called directly     | pass                                   | pass                                 |
| 20 consecutive execs                                  | 20 of 20, no `pending`, none lost      | n/a                                  |

**Measurements.**

| What                                                          | Value                                        |
| ------------------------------------------------------------- | -------------------------------------------- |
| Cold start plus first exec, one container at a time           | 4.6 s, 5.5 s, 5.8 s                          |
| Cold start plus first exec, three containers starting at once | 8.7 s, 12.1 s                                |
| Warm exec, 20 samples                                         | min 167 ms, median 171 ms, max 257 ms        |
| Turn file download                                            | 163 to 172 ms                                |
| `SessionDO` alarm holding a turn                              | wall 13 to 128 s, CPU 97 to 2711 ms          |
| `ComputerDO` RPC invocation                                   | CPU median 3 ms, max 12 ms; wall up to 326 s |
| Exec output hitting the 1 MiB cap                             | never; no `outputTruncated`, no warning      |

Container lifetime: `ComputerDO` asks for a 10-minute inactivity timeout on the first command, and the five containers were still `active` three minutes after their last exec, so a session holds an instance slot well past the turn that used it. Egress was not billed separately here because the workspace only talks to its Durable Object; a sandbox that reaches the internet is unmeasured and 7d must price it.

`ComputerDO` costs almost no CPU and a lot of wall clock: a single invocation stayed active 326 s for about 8 ms of CPU, because the object is held while the session works. Durable Object duration bills on wall time, so 7d should size that alongside the Containers vCPU and memory bill rather than assuming the container dominates.

**Context7 rarely triggers the offload on its own.** One `query-docs` call returns 2 to 7.5 KB, about 1900 estimated tokens, well under the 6000-token individual threshold — the same thing Cycle 13 saw. Eight parallel calls reached 36.8 KB, still short of the 10000-token total threshold, and nothing was written. Twelve parallel calls cleared it and the offload fired in both turn modes. Anyone re-running 7a.9 should ask for twelve parallel calls, not one large one.

**The no-capacity failure shape is now known.** Six concurrent sessions against `max_instances: 5` left five containers `active` and `0` healthy, and the sixth session's first exec failed with:

```
Sandbox initialization failed: Sandbox exec failed: Workspace backend "container-shell":
shell.exec failed after 1 reconnect retry: initial=CloudflareContainerBackend(container-shell):
connect failed at stage=health port=8080 attempt=2/2 restarts=1 timeoutMs=30000 …
lastError=container exited: Maximum number of running container instances exceeded.
Try again later, or try configu…
```

The limit is named, but only at the end of a transport string that opens with a health-check timeout. The turn did not crash: the sandbox init failed twice and the turn finished as `done` with the agent reporting the transport error. 7d should match `Maximum number of running container instances exceeded` and answer with a message that names the limit.

**A non-zero exit is reported as an infrastructure failure.** Section 8 assumed `status` separates a non-zero exit from a failure to run. It does not. `sh -c 'echo OUTLINE; echo ERRLINE 1>&2; exit 3'` comes back as `{"success": false, "error": "Sandbox exec did not run: OUTLINE\nERRLINE\n"}`, and `ls /nope` the same way. Computer sets `result.status` to `failed` whenever the command exits non-zero, so `CloudflareComputerProvider.exec` maps it to `{ success: false }` and the exit code is dropped. The Node providers return `{ success: true, response: { exitCode, result } }` for the same command, so an agent on Workers sees a shell error as a broken sandbox. The output text still reaches the model, which is why the acceptance items passed, but this must be fixed before 7b: read `exitCode` and treat `failed` as a real failure only when the command never ran.

**The workspace survives an idle container.** The streaming upload turn ran 14 minutes after that session's first exec and still read back `/workspace/a.txt` and both files under `/workspace/.trueforge/tool-results`, so the Durable Object SQLite state is what the workspace serves. A full container restart is still 7d's to verify.

**Test data left on the deploy.** Agent `smoke-sandbox`, six sessions with Computer workspaces, and the files those turns wrote under `/workspace`.

## 10. Go or no-go after 7a

**Go, continue to 7b with Cloudflare Computer.**

Against Section 6:

- **Every 7a.9 item passes live, in both turn modes.** Yes. One Worker-side validation bug blocked the first attempt; it was fixed with a one-line change to the integration plus a test pin, redeployed once, and every item then passed. No fix was made to the container path.
- **No casts beyond the reported type gap.** Unchanged. `workspaceStorage.ts` still holds the single overload for `DurableObjectStorageLike`, and it is still worth reporting upstream.
- **Cold start plus first exec under 30 s, warm exec under 1 s.** Comfortably: 4.6 to 12.1 s cold, 171 ms median warm.
- **No unexplained `pending` results or lost execs across 20 execs.** 20 of 20 in order, zero `pending`, zero `EEXEC_LOST`, zero exceptions in the tail.

None of the switch-to-B conditions fired. The container backend needs no `experimental` flag, the pinned `0.3.0` API did not move during the spike, stdout and file transfer handled a 10 KB offload and a 3 KB download with the 1 MiB cap never reached, and the capnweb and FUSE path ran 76 `ComputerDO` invocations without a single exception. The only exec failures in the whole run were the deliberate instance-limit probe and the deliberate non-zero exit.

Two must-fix items carry into 7b, neither of which changes the verdict:

1. Map a non-zero exit to `{ success: true, exitCode }` instead of a failure.
2. Map the instance-limit failure to a message that names the limit.

Both landed as the first two commits of 7b; Section 11 records how.

## 11. Phase 7b: skills

Built on a worktree branch off `feat/cloudflare-workers-port`, and run live on `trueforge.rockyshoreslabs.io` on 2026-09-16 against Worker version `fd7c5f89-41cc-41a2-a0aa-d1792efa89c5`. `wrangler tail --format json` ran from before the deploy until after the last test, and again for the exit-code check: 173 invocations, zero exceptions. The only three non-`ok` outcomes are the `canceled` halves of one client-cancelled stream, described below.

**The two must-fixes from Section 10 landed first.**

- **A non-zero exit is a result, not a broken sandbox.** Computer derives `status` from `exitCode` alone — `0` is `completed`, a signal code (129, 130, 137, 143) is `cancelled`, everything else is `failed` — and leaves `exitCode` at `-1` when no exit event ever arrived. So a negative exit code, not `failed`, is what says the command never launched. `CloudflareComputerProvider.exec` now returns `{ success: true, response: { exitCode, result } }` for any command that ran, matching the Node providers, and keeps `{ success: false }` for a command that never launched, one that was cancelled, and one whose writes never reached the workspace store. Section 8's claim that `status` separates the two is corrected there. Re-checked live with the two commands Section 9 used to find it: `sh -c 'echo OUTLINE; echo ERRLINE 1>&2; exit 3'` now returns `{"success":true,"response":{"exitCode":3,"result":"OUTLINE\nERRLINE\n"}}`, and `ls /nope` returns `exitCode: 2` with its stderr in `result`.
- **The instance limit names itself.** The provider matches `Maximum number of running container instances exceeded` in a transport failure and answers with a message that names `max_instances` and asks the caller to retry, instead of surfacing a connect trace that opens with a health-check timeout. The test uses the string captured live in Section 9. It is a failed command, not a `SandboxNotAvailableError`: the workspace is intact in Durable Object storage, and on this provider recreating a sandbox returns the same id, so treating it as gone only spends the container health-check budget a second time — two 30 s attempts — before the caller learns why. A second test drives a real `Sandbox` reattached to an existing id and pins that a capacity failure makes exactly one init attempt.

**The flag that Section 9 found misnamed is renamed.** `SandboxIntegration.isLocalFallbackEnabled` is now `isSandboxUsableWithoutStoredRecord`, which is what its doc comment already said and what both runtimes actually decide. No behaviour changed. (Section 12 later deleted the flag in favour of `resolveSandboxUsability`.)

**The image needs nothing added (7b.1).** `workers/computer.Dockerfile` builds on the release sandbox image, which already carries everything `skill_downloader.py` uses: Python 3.13.15, pydantic 2.12.5, git 2.39.5, a CA bundle, and the stdlib `tarfile`/`urllib`. Checked by running the real downloader inside the built image rather than by reading the Dockerfile: it installed a git skill in 2.2 s and removed it again in 0.1 s on overlayfs. No Dockerfile change, so no image-pin fixture to regenerate.

**Skills follow the workspace (7b.2).** `isSkillMountingSupported` now returns whether the sandbox backend is set, so `GET /api/v1/capabilities` reports `skill.enabled` exactly when `sandbox.enabled`. `buildTurnSandbox` no longer throws 422 on skills and always carries a `SkillMounter`, empty or not — which is what makes a dropped skill get cleaned up on the next init, the same as on Node.

**Live test (7b.3).** Agent `smoke-skills`, sandbox enabled, one catalog skill (`algorithmic-art`, a git skill: 4 files, 59 KB, sparse-cloned from `github.com/anthropics/skills`).

| Item                                                           | Result                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A turn on an agent with a skill and `sandbox.enabled`          | pass — pre-7b this turn, not the agent create, is where `buildTurnSandbox` answered 422                                         |
| Mount under `/workspace/.trueforge/skills`, non-streaming turn | pass: `algorithmic-art/` plus a 213-byte state file; `SKILL.md` read back from the FUSE mount                                   |
| Same, streaming turn                                           | pass, identical listing; the prompt carried a 185-token skills section                                                          |
| A turn that actually uses the skill                            | pass: the agent read `SKILL.md`, wrote a 68-line p5.js sketch to `/workspace`, and named the seeded-randomness rule it followed |
| Removing the skill cleans up on the next init                  | pass: after `PUT /agents/{id}` with no skills, the next turn's listing is the state file alone, shrunk to 69 bytes              |
| Re-adding the skill reinstalls it                              | pass, back to `algorithmic-art/` and 213 bytes                                                                                  |

**Measurements (7b.4).** The skill download runs inside the first `exec` of a turn, so it is charged to the alarm pass holding that turn.

| What                                                          | Value                                        |
| ------------------------------------------------------------- | -------------------------------------------- |
| Skill-downloader exec, cold container, one skill installed    | 4373 ms and 3703 ms                          |
| Skill-downloader exec, warm container, one skill installed    | 3428 ms                                      |
| Skill-downloader exec, warm container, skill unchanged        | 1103 ms                                      |
| Skill-downloader exec, warm container, one skill removed      | 431 ms                                       |
| Whole sandbox init, cold (first exec through git credentials) | 9.8 s, of which 5.3 s is the container start |
| Whole sandbox init, warm                                      | 0.7 s to 3.6 s                               |
| `SessionDO` alarm holding a turn                              | wall 12.0 to 167.0 s, CPU 263 to 3546 ms     |
| `ComputerDO` RPC invocation                                   | CPU 0 to 97 ms; wall up to 96.9 s            |

The download fits the 14-minute alarm window with room to spare: the worst observed was 4.4 s, about 0.5 % of the 840 s pass, and `SKILL_DOWNLOAD_TIMEOUT_SECONDS` caps it at 180 s, 21 % of the pass. A skill an order of magnitude larger still cannot exhaust it, because the downloader's own per-clone timeout stops first.

**Notes.**

- A git skill installs a sparse, blob-filtered clone, so its cost tracks the skill subdirectory rather than the repository. FUSE did not show up in the numbers: a warm reinstall of the same skill took 3.4 s against 2.2 s on overlayfs outside the container.
- A turn whose skill pin has not moved still pays about 1.1 s, because the downloader runs on every init to reconcile state. That is the price of cleanup being automatic.
- Streaming a turn through a browser tab is limited by the tool driving it, not by the server: one streaming turn here was cut off client-side after 45 s and finished as `cancelled` with `reason: client-cancelled`. The server behaved correctly; re-run long turns non-streaming when the client has a short ceiling.
- Test data removed afterwards: agent `smoke-skills` and its sessions; the tenant ends with zero agents and zero sessions. The tenant skill `algorithmic-art` stays configured, because the settings skills API has no delete.

## 12. Turning the built-in sandbox on from Settings

Section 3's "the provider is deploy-configured, not settings-configured" and the non-goal above both had to go. On a live Workers deploy, Settings → Sandbox providers offered exactly one card, Daytona, whose `PUT` answers `422` on that runtime, and there was no way to turn the Computer sandbox on at all — only a redeploy could.

**The split that replaced them.** `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer` (with the `COMPUTER_DO` binding) now means the built-in provider is _available_ on this deploy. A tenant _enables_ it by storing a sandbox-provider record of the new manifest variant `cloudflare-computer`, which carries no credentials and no settings. Both must hold; either alone reports the sandbox off.

**What changed.**

- `SandboxProviderManifest` is a real `z.discriminatedUnion('type', …)` of `DaytonaSandboxProvider` and `CloudflareComputerSandboxProvider`, and so is the catalog wire type (`CatalogDaytonaSandboxProvider` plus the same credential-free `CloudflareComputerSandboxProvider`). The shipped `sandbox-catalog.yaml` stays Daytona-only; the built-in entry is synthesized by the catalog route. The store's jsonb gained a third member, which is additive — no migration.
- `GET /api/v1/catalogs/sandbox-providers` is runtime-aware: the Daytona presets only where `isDaytonaSettingsSupported()`, the built-in entry only where `isCloudflareComputerSettingsSupported()`. On Workers that is one entry, or none with the var unset. Node is unchanged.
- `DELETE /api/v1/settings/sandbox-providers` is new, so a tenant can disable. It exists on Node too, which is how the settings UI's "Remove" button finally has a route behind it.
- `SandboxIntegration.resolveSandboxUsability({ store, tenant_id, logger })` is the one source for "can a sandbox run for this tenant", returning `{ usable, status }`. `GET /capabilities` and `validateAgentSpec` both call it, and the booleans they used to reason from — `isSandboxUsableWithoutStoredRecord` and the short-lived `isSandboxConfigured` — are gone from the port, so there is no second way to compute the answer. The Workers integration answers it, `checkSnapshotStatus` and `resolveProvider` from one check, and needs no record-free fallback, which is where Section 9 started. A build that is `pending` or `failed` is now refused at spec validation rather than at turn time, and a provider that cannot be reached to check is a 503, not a 500.
- The settings UI shows the built-in provider with an **Enable** action that opens no form, the existing status line, and **Disable**. No Daytona card appears on Workers.

**Why the UI DTO has zeros.** `@truefoundry/assistant-ui-runtime`'s `SandboxConfig` requires the four Daytona interval numbers and `CreateSandboxRequest` requires an `apiKey`. Rather than patch the package for one credential-free provider, the adapter maps the built-in entry to zeros and an empty key, and the settings section never shows those fields for it. Patch the runtime package only if a second credential-free provider arrives.

## 13. Phase 7c: Code Mode over the container's egress

Built on a worktree branch off `feat/cloudflare-workers-port`.

### The design (7c.1)

Of the two candidates in Phase 7c, the egress route won. A relay behind capnweb would have meant a second protocol inside the container and a second thing to keep alive for a turn; the egress route reuses a path Computer already builds.

```
container ──http://code-mode.trueforge.internal/dispatch──►  (egress interception)
                                                             │
                                                    WorkspaceProxy ──► ComputerDO.fetch
                                                             │
                                               SandboxEgressGateway  (host match)
                                                    │                │
                                       Code Mode ───┘                └─── everything else: fetch(request)
                                                    ▼
                                    SessionDO(tenant:session).dispatchCodeMode
                                                    ▼
                                            CodeModeDispatcher
```

**Egress mode.** `ComputerDO` moves from `egress: { mode: 'direct' }` to `{ mode: 'http-gateway', gateway }`. Computer then asks the platform to intercept all outbound HTTP and all outbound HTTPS, and hands each request to the gateway with its **original URL** — host, path and query intact. `http-gateway` also turns off direct internet, so nothing leaves the container except through the gateway.

**The gateway.** `SandboxEgressGateway` is a `WorkerEntrypoint` exported at the Worker's top level, so `ctx.exports` resolves it, and it satisfies `WorkspaceEgressPolicy.gateway` with no cast. One hostname, `code-mode.trueforge.internal`, is Code Mode; every other request is `fetch(request)`, unchanged. That hostname resolves nowhere publicly, which is the point: it is answered before anything leaves the machine, the same way Computer's own `computer.internal` is.

**Which session it may reach.** The gateway's props carry `sessionDurableObjectName`, and `ComputerDO` sets it from `ctx.id.name` — the workspace's own name, which is `tenant_id:session_id`. Nothing in the request can change it: a path, a header or a body naming another session is ignored, and a workspace that cannot name itself gets 503 rather than a guess. `tests/workers/sandboxEgress.test.ts` shows the workspace carries its name whether it is addressed by name or woken cold by id string, which is how `WorkspaceProxy` reaches it. It builds its own gateway with props of its choosing, so it cannot show that `ComputerDO` passes that name on. `tests/workers/codeModeRouting.test.ts` does that. It opens a channel through the provider the real `SessionDO` hands out, then presents the token on the gateway the session's own `ComputerDO` built. The token is answered there and refused with 401 through another session's workspace. Hard-coding the gateway's session, or dropping `SessionDO`'s bridge, now fails that test; both passed the earlier suite.

**The token.** `CodeModeBridgeRegistry` lives in `SessionDO`. The transport opens a channel when a turn starts Code Mode, gets a random token back, hands it to the sandbox as `TFY_CM_HTTP_TOKEN`, and closes the channel when the turn ends. A token the registry does not hold is refused with 401 before any dispatcher is consulted. The two controls are independent: the DO name decides which session answers, the token decides which turn of it. The token is in the command's environment, so every process in the sandbox can read it, and a background job keeps it usable until the turn ends. NATS mode exposes its subject the same way. The client ignores any proxy the sandbox configures, so the token only ever goes to the bridge. The gateway passes on a sandbox-supplied `traceparent` only if it is well-formed W3C, and a `tracestate` only up to 512 characters.

**Timeouts.** `TFY_CM_REQUEST_TIMEOUT_SECONDS` is capped at `SANDBOX_EXEC_TIMEOUT_SECONDS`, which is itself capped at two thirds of the 840 s alarm pass, so the client gives up before the command waiting on it is killed and long before the pass ends. The host side gives up at the same bound, so a hung MCP server cannot hold the reply. **The host abandons the reply, not the tool.** `IToolSet.callTool` takes no abort signal, so the MCP call keeps running inside `SessionDO` after the sandbox has been told it timed out, and a slow write can still land. The deploy guide lists this as a known limit. Stopping it needs a signal through `IToolSet`, which is a core change for every provider.

**Request size.** A Code Mode request is a tool name and its arguments, so the gateway refuses a body over 1 MiB with 413. It checks the declared length first and counts again while reading, so an oversized body is never buffered into the isolate.

**Destructive tools.** `mcp_client.py` refuses a tool with a destructive hint, or one whose `readOnlyHint` is false, so that it goes through the approval flow instead. The sandbox holds the channel token, so a single `curl` could skip that check. `CodeModeDispatcher` in core now applies the same rule before it calls a tool, as a caller error, and also refuses a tool the server does not list. Node's NATS path shares the dispatcher and gets the same check.

**Nothing throws across RPC.** `SessionDO.dispatchCodeMode` returns either a refusal (`status` plus `message`) or the dispatcher's reply **already serialized**: `CodeModeReply.result` is `unknown`, which the Workers RPC types cannot carry. The request crosses as text for the same reason, which also puts parsing and validation in one place.

**The client.** `mcp_client.py` picks its bridge from the environment: `TFY_CM_HTTP_URL` plus `TFY_CM_HTTP_TOKEN` for HTTP, `TFY_NATS_URL` plus `TFY_NATS_SUBJECT_PREFIX` for NATS. The HTTP path is `urllib.request` on a worker thread — standard library only — and retries only a refused connection or an unresolvable host, because those prove nothing was delivered; a timeout, a reset, or any HTTP status is reported, never retried, so a non-idempotent tool cannot double-execute. NATS is untouched for the Node providers.

**The image.** `http-gateway` means Cloudflare terminates the container's TLS with a certificate authority it mints per container, which cannot be baked into an image. It also appears late. `@cloudflare/computer` calls `host.start()` first and sets up interception afterwards, and Cloudflare injects the CA only once interception exists. So the first version, which waited 3 s in the entrypoint and then started without the CA for good, would likely have started without it every time.

`workers/trust-egress-ca.sh`, installed as `trueforge-trust-egress-ca`, now does the install. It waits up to the number of seconds it is given, copies `/etc/cloudflare/certs/cloudflare-containers-ca.crt` into the trust store, runs `update-ca-certificates`, and writes a marker only on success, so running it again costs nothing. It can run from two places:

- The entrypoint starts it in the background with 120 s, then `exec`s `computerd`, so startup never waits.
- `ComputerDO` runs it before the first command with 5 s, and again before the next command after the container host has recorded an exit, because a restarted container has a CA of its own. If the CA is still missing, it logs an error naming the exit code and retries on the next command. A certificate failure therefore has a cause in the Durable Object log, not only in the command's stderr.

Every command also gets `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT` and `NODE_EXTRA_CA_CERTS`, all pointing at the system bundle. They come from one constant, `COMPUTER_TLS_TRUST_ENV`, and are applied on top of the caller's env, so no caller can unset them. The entrypoint used to export two of these into `computerd`'s own environment, which exec children may never inherit, and it set nothing for Node.

The helper was checked in the built image against a test CA:

- With no CA it exits 3 after the wait.
- Run twice with a CA, it exits 0 both times.
- Started in the background before the CA appeared, it installed the CA 2 s later.
- Python's default context sees the certificate.

The image needs nothing else: it already carries `mcp` 1.29.0 and `pydantic` 2.12.5, the versions the client's inline dependency header names.

**NATS stays out.** `supervisor` and `nats-server` are still unstarted in this image, and `CodeModeNatsTransport` is untouched.

### What is verified, and where

| Claim                                                                                                                                 | Verified by                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The gateway forwards a non-Code-Mode request with host, path, method and body intact                                                  | `tests/workers/sandboxEgress.test.ts`                                                                                                                             |
| A workspace carries its `tenant:session` name whether addressed by name or woken cold by id string                                    | `tests/workers/sandboxEgress.test.ts`                                                                                                                             |
| The gateway `ComputerDO` builds routes to its own session, and the real `SessionDO` hands out Code Mode providers bound to its bridge | `tests/workers/codeModeRouting.test.ts`                                                                                                                           |
| A live token of one session is refused through another session's workspace, and still answered through its own                        | `tests/workers/codeModeRouting.test.ts`                                                                                                                           |
| No token, a token no turn opened, a non-POST, a nameless workspace, a body over 1 MiB: all refused                                    | `tests/workers/sandboxEgress.test.ts`                                                                                                                             |
| A destructive tool is refused on the host, whether sent through the client or straight to the gateway                                 | `packages/trueforge-core/tests/core/sandbox/codeMode/CodeModeDispatcher.test.ts`, `tests/workers/codeModeRouting.test.ts`                                         |
| A turn opens a channel, the dispatcher answers for that turn's MCP servers only, the token dies with the turn                         | `tests/workers/sandboxTurn.test.ts`                                                                                                                               |
| Code Mode stays off until the tenant enables the built-in provider, and the HTTP app's providers never offer it                       | `tests/workers/sandboxTurn.test.ts`, `tests/workers/workersSandboxIntegration.test.ts`                                                                            |
| Registry and transport: token lifecycle, malformed requests, the dispatch timeout                                                     | `tests/workers/codeModeBridge.test.ts`                                                                                                                            |
| Every command gets the TLS trust env, and a caller cannot override it                                                                 | `tests/workers/computerDO.test.ts`                                                                                                                                |
| The Python client's HTTP mode: URL, bearer token, body, trace headers, retry policy, mode selection                                   | `packages/trueforge-core/tests/core/sandbox/scripts/mcp_client_http_test.py`, run in the built image by `pnpm --filter @truefoundry/trueforge test:sandbox-image` |
| The image ships the CA helper, the entrypoint starts it in the background and becomes `computerd`                                     | `tests/unit/workers/computerImage.test.ts`, plus runs of the helper in the built image                                                                            |

Local containers still do not start on this machine (Section 8), so **nothing above exercises a real container**. Whether the gateway sees real container traffic, and whether ordinary HTTPS survives interception, is the live deploy's to answer.

### Live test (7c.3): not yet run

Deployed as Worker version `9e10a572-3299-4712-8976-e2ed03b65838` with the gate — the egress switch, the pass-through gateway and the CA entrypoint — on 2026-09-18. The remote D1 migration `0003_delivery_next_attempt.sql` applied first (5 commands, 1.46 ms). `/healthz` answers 200 and `/api/v1/capabilities` answers 401 unauthenticated. The container image rebuilt and pushed as `trueforge-computerdo@sha256:59d23276…`; `enableInternet` flips with the egress mode, so existing containers relaunch on their next command.

**Only the gate is deployed.** `9e10a572` is the first commit of the phase and nothing else: the transport, the registry, the routing and the provider flip are on the branch, not on the deploy, so `supportsCodeMode` is still false live and Code Mode is still off for every agent. Leaving it up costs nothing — the tenant has no sessions, and the only behaviour that changed is where a container's outbound requests go.

The acceptance run did not happen: the deploy's own session had expired, and re-establishing it stops at a Clerk OAuth consent screen, which an agent must not click.

**The whole branch is deployed since 2026-09-21**, rebased onto `0cbddda5`, as Worker version `688d2bfb-d63c-421a-9f3b-b3ab3e18d8e7`. No D1 migration was pending. The image pushed as `trueforge-computerdo@sha256:33c4ebc5…`, and the Containers application `trueforge-computerdo` reported `ready` right after the deploy. `/healthz` answers 200 (0.60 s) and `/api/v1/capabilities` answers 401 unauthenticated. A tail over the deploy recorded 5 events, all `ok`, and no exception. That deploy carries the transport, the registry and the routing as well as the gate, so the two passes below collapse into one. The built-in sandbox is still not enabled for the tenant, so no container has run a command through the gateway, and Code Mode is unreachable until a tenant admin enables the provider in Settings.

### Most likely to break live

Check these first, in this order. None of them can be seen without a real container.

1. **CA timing.** The first command after a cold start is the likeliest to hit HTTPS before the CA is installed. Look for `does not trust the Cloudflare egress CA` from `ComputerDO` in the tail. If the error appears, run `ls -la /etc/cloudflare/certs/` in the sandbox and look at the exit code the log gives.
2. **Trust stores.** `curl`, `git`, `pip` and Python `urllib` each read a different setting. Probe each of them once over HTTPS, not only `curl`.
3. **Exec env.** Run `env | grep -E 'SSL_CERT_FILE|NODE_EXTRA_CA_CERTS'` inside a command to confirm the trust env reaches exec children. If it is missing there, it is missing for every tool.
4. **The workspace's own name.** Routing depends on `ctx.id.name` whichever way the live deploy wakes `ComputerDO`: by a named stub, by id from `WorkspaceProxy` when the container calls back, or by an alarm. The Workers tests show it only for a named stub and a cold wake by id string, and only in workerd. If it is undefined live, every Code Mode call gets 503, and the tail shows `cannot name its session`.
5. **Same-zone fetches.** A request from the sandbox to the Worker's own custom domain goes through the gateway's `fetch`, which may fail as a same-zone loop (Cloudflare error 1042) instead of passing through. Probe it with `curl -sS https://trueforge.rockyshoreslabs.io/healthz` from inside the sandbox.

The acceptance run stopped again before its first probe: the agent running it had no permission to drive the signed-in browser, and every probe needs an authenticated session. Nothing below has been measured. The list stays in its two-pass order.

**The review fixes are not deployed.** The CA helper, the trust env, the 1 MiB cap and the host-side destructive check all postdate `688d2bfb`. A live run needs a fresh `pnpm workers:deploy` from the branch first, and should record its version id here.

**Pass one decides the gate, against `9e10a572` as deployed.** Stop here and report if any of it fails.

1. From inside a sandbox, timed with `curl -w '%{time_total}'`: `curl https://example.com`, `curl http://example.com`, and `python3 -c "urllib.request.urlopen('https://example.com')"` — the last one checks the system CA path the skill downloader uses.
2. `curl http://code-mode.trueforge.internal/` ten times, for the round trip and for whether the name is reachable at all. On the gate build the gateway passes it through, so the answer says whether the interception catches a host that resolves nowhere.
3. A skill download, which is a `git clone` over intercepted HTTPS.

**Pass two needs a second `pnpm workers:deploy`** from the branch, and its own version id.

4. `mcp-client call-tool …` from the shell, not only `from mcp_client import call_tool`. The module is installed on the FUSE mount and `chmod 0555`, with the PATH link at `/usr/local/bin/mcp-client`; if the mount does not keep the mode, the CLI half of the prompt's promise is broken while the import half still works, and the module moves to the container disk.
5. Agent `smoke-codemode` with the sandbox, Code Mode and the `context7` MCP server: a streaming turn and a non-streaming turn where a script calls two tools and returns a value.
6. `curl http://code-mode.trueforge.internal/dispatch` with no token and with a made-up one; both must be refused without leaving the machine.
7. From the tail: round-trip latency per dispatcher call, alarm wall and CPU, and any exception.

The likeliest failure is item 2. `http-gateway` sets `enableInternet: false`, which leaves the container only ports 80 and 443 and Cloudflare's resolvers, and whether intercept-all catches a name that resolves nowhere — before a lookup, not after it — is exactly what that probe answers. Computer's own `computer.internal` is the existence proof that some such name works, because `computerd` dials `http://computer.internal/api` from inside the container in every egress mode.

If HTTPS does not survive interception, the fallback needs no new protocol: Computer routes `computer.internal` to `ComputerDO.fetch` in **every** egress mode, so the same client, token, registry and dispatcher work with `egress: { mode: 'direct' }` and a path match in `ComputerDO.fetch` ahead of `backend.handleFetch`. Only the host match moves.
