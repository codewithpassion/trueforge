# Cloudflare Workers sandbox plan (Phase 7)

Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation. It follows `docs/cloudflare-workers-port-plan.md`, which shipped Phases 0 to 5 with code execution disabled.

Status: proposed on 2026-09-16. Nothing in this plan is implemented.

Goal: restore code execution on the Workers deploy with a Cloudflare-native sandbox provider, starting with a time-boxed spike on Cloudflare Computer (`@cloudflare/computer`). The spike decides whether Computer, or the Cloudflare Sandbox SDK as the fallback, backs a new `SandboxProvider`.

Non-goals for this plan:

- Changing the Node deployments. Daytona, TrueFoundry, and the local sandbox stay as they are.
- Exposing the new provider through the settings API. The settings OpenAPI stays Daytona-only, so there is no SDK or OpenAPI regeneration.
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
- **Provider selection.** The provider is deploy-configured, not settings-configured.
  - `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer` in `wrangler.jsonc` vars enables it.
  - `WorkersSandboxIntegration` implements `SandboxIntegration`:
    - `resolveProvider` returns the Computer provider when enabled and `undefined` otherwise.
    - `isLocalFallbackEnabled` returns `false`.
    - `checkSnapshotStatus` returns `ready`.
    - The Daytona helpers throw a typed "not supported on Workers" error. The existing settings routes already return `404` and `422` on Workers.
  - If a stored record type is needed, add `cloudflare-computer` to `StoredSandboxProviderManifestSchema` only (store and runtime, not OpenAPI), the same way `truefoundry` is handled.
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
3. **`ComputerDO`.** Add it with `withWorkspace` and `withWorkspaceContainer` and a `CloudflareContainerBackend`.
   - The Computer examples cast `ctx.storage` and the stub (`as unknown as`). This repo forbids casts. Write a typed adapter with guards, and if the package types make that impossible, record the exact type gap and report it upstream instead of casting.
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
   - Record cold-start time, exec latency, and the alarm invocation's CPU.
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

### Phase 7d: hardening

- **Egress.** Use `http-gateway` mode with an allowlist from config. The default denies everything except the model provider hosts the sandbox needs, the skill catalog, and git hosts.
- **Process user.** Run `computerd` and exec as a non-root user once Computer supports it. Track the open item in Computer's `docs/07_injected_service.md`.
- **Container lifetime.** Set idle sleep and instance limits, and document the cost of Containers vCPU, memory, and egress next to Durable Objects and D1.
- **Container restart.** Verify on the deploy that the DO SQLite state resyncs into a fresh container, that `SandboxNotAvailableError` recreates correctly, and that an in-flight exec reports `EEXEC_LOST` as `{ success: false }`.
- **Deploy guide.** Update `docs/deploy/cloudflare.mdx`: sandbox, skills, and Code Mode move out of "Not supported on Workers" into a section on enabling code execution, with the preview warning.
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
- **Security.**
  - `computerd` runs as root by default.
  - Egress starts as direct.
  - One `ComputerDO` per session keeps workspaces isolated between tenants and sessions. The Opus review must check that the RPC surface does not accept a caller-supplied DO name.
- **Cost.** Containers bill vCPU, memory, and egress on top of Durable Objects and D1. Measure it in 7a.9 before recommending the feature.
- **Local development.** Containers need Docker for `wrangler dev`. The main checkout's Docker smoke rule (no root-owned files) applies.
- **Deploy.** Rolling a new image restarts containers, and a deploy already cancels running turns.
