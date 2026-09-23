# Remote desktops: computer use and human takeover on a remote computer (Phase 9 PRD)

Status: owner decisions recorded 2026-09-23 (Section 11). Revised four times after adversarial review (Section 12). Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation. Builds on Phase 8 (`docs/remote-computers-plan.md`) and the v1 wire contract (`docs/remote-computers-protocol.md`).

## 1. Problem, goal, non-goals

A remote computer today gives the agent one tool, `exec`. That leaves three gaps:

- Anything that only works through a GUI is out of reach: a website without an API, a site that needs a logged-in browser, a desktop app.
- The agent cannot get past a login, CAPTCHA or 2FA by itself.
- A human cannot see what the agent is doing on the machine.

**Goal.**

1. **Agent computer use.** On a remote computer whose desktop is turned on, the daemon runs:
   - a virtual X display (Xvfb);
   - a minimal desktop (openbox);
   - a terminal (xterm);
   - Chromium with a persistent profile.

   The agent takes screenshots and drives the mouse and keyboard through portable tools, and keeps `exec` alongside them.

2. **Human takeover.** In the web UI, anyone with access to the agent can watch that desktop and take control, with mouse, keyboard, and clipboard in both directions. A typical use is logging into an account the agent needs. They then hand control back. The Chromium profile persists on the machine, so the agent stays logged in afterwards.

**The desktop is turned on per computer** (owner decision). An admin enables it on the computer. The daemon owns and supervises the X server, and the agent only uses it, starting apps itself through `exec` with `DISPLAY` set.

**Non-goals (v1).**

- **Other operating systems.** macOS (the real screen via ScreenCaptureKit plus the Accessibility permission) is a later phase. Windows is already out of the daemon.
- **Hosted sandboxes.** No desktop in `ComputerDO`, Daytona or TFY sandboxes. v1 is the user's own machines; a cloud desktop may come later (Phase 9e).
- **Provider-native computer-use tools** (Anthropic `computer_20xx`, OpenAI `computer_use_preview`). v1 uses portable function tools.
- **DOM/CDP browser tools.** Chromium was chosen so a later phase can add them, but v1 is pixel-based only, and no remote-debugging port is opened.
- **Smooth video.** v1 shows polled frames at about 2 fps. A VNC stream is Phase 9d, and only if 9c proves inadequate.
- **Other media and control features.** Audio, drag-and-drop of files, multiple monitors, IME text composition, and recording or replay.

**Reversing a Phase 8 non-goal.** `docs/remote-computers-plan.md` §1 and §9.8 rule out "interactive PTY, stdin, or streaming output to the UI". This plan supersedes that for the desktop only, because a human cannot log in for the agent without a live view and live input. PTY for `exec` stays out.

## 2. What exists today

### Agentum (sibling project): nothing to reuse

- **Browser.** Agentum runs one headless Chromium tab on Cloudflare Browser Run, driven by CSS selectors (`apps/web/src/modules/browser/session.ts`). Its tools are `browser_navigate|snapshot|click|fill|screenshot` (`apps/web/src/modules/mcp/tools.ts:760-866`).
- **No login state.** It saves no cookies or logins, and the session dies after 150 s idle.
- **Screen tab.** `agent-screen-tab.tsx` shows the last screenshot the agent chose to take, re-polled every 4–15 s. It is read-only: no input and no takeover.
- **No desktop.** There is no X server or VNC anywhere. Its computer daemon has no GUI packages and runs `exec` with stdin ignored.

**Lessons for this plan:**

- Agentum's plan said "streamed over a WebSocket", but polling was built and the doc was never corrected. This PRD calls the v1 view **polled frames** on purpose.
- Agentum's screenshots reached the model as URLs, never as images. Section 5 fixes that at the root.
- It had no persistent login, which is the whole reason for takeover.

### TrueForge (Phase 8b)

**Daemon and relay**

- **Daemon.** The `trueforge-computer` Go binary dials `GET /api/v1/computers/connect` over a WebSocket.
  - It speaks JSON text frames with ops `exec | cancel | file_put | file_get`.
  - `hello` carries `capabilities {python3, git, skills}`.
  - An unknown op is answered with `unknown_op` (`internal/agent/agent.go:90-92`).
- **Relay.** `RemoteComputerDO` is one Durable Object per computer.
  - It offers request/response RPC only. Its input is `{tenant_id, op_json, timeout_ms}` (`RemoteComputerDO.ts:128-132`).
  - Exec is capped at 4 concurrent; other ops are uncapped.
  - Binary frames are dropped (`RemoteComputerDO.ts:283`, `conn.go:248`).
  - Frame caps are 4 MiB for server sends and 8 MiB for the client. At 32 MiB the socket closes, and every in-flight request on that computer dies.
- **Routes.** All `/api/v1/computers` management routes are admin-only (`withAdminAuth`, `app.ts:311-313`). The machine connect route mounts before auth (`app.ts:302`).
- **Runtime.** Workers only. On Node, `computers` is `undefined` until Phase 8c.

**Model tools and tool results**

- **One sandbox tool.** The only sandbox tool the model sees is `exec` (`packages/trueforge-core/src/core/sandbox/Sandbox.ts:107`).
- **Tool results are text only, end to end.**
  - `toolResultResponse` builds `{type:'text'}` (`core/mcp/IMCPServer.ts:83-94`).
  - `executeToolCalls.ts:151-166` keeps only text parts, and JSON-stringifies the whole array when there are none. An image-only result would reach the model as base64 text today.
  - `LLMToolMessageSchema.content` is `z.string()` (`core/llm/LLMTypes.ts:133-138`). It is also the persisted, streamed `ToolResponseEvent` (`core/events/schema.ts:186-193`).
  - `toOpenAIChatMessage.ts:17-23` rebuilds tool messages as OpenAI `{role, tool_call_id, content}`, and `convertMessages` (`VercelAILLM.ts:802`) takes `ChatCompletionMessageParam[]`. It always sends `output: {type:'text'}` (`VercelAILLM.ts:841-855`).
- **Prompt caching.** `VercelAILLM.ts:392-400` applies Anthropic `cache_control`.
- **Approval.** `LocalToolMCP.toolCallInfo` hard-codes `is_approval_required: false`, so per-computer `require_approval` is not enforced (Phase 8d).

**Storage**

- **No file or blob store.** There is no R2 binding and no blob API in `ISessionStore`.
- **Databases.** Workers uses D1, where one value is at most 2 MB (`db/d1/client.ts:50`). Node uses Postgres or SQLite.

**Turns and access**

- **Client-side tools do not pause a turn.** When the model calls one (`ClientSideTool.ts:7-10`, for example `AskUserQuestion`), the turn **ends** with status `done` and `required_actions` set, after a `tool.response_required` event (`core/events/schema.ts:338-348`). `user-input-required` is the thread state (`AgentThread.ts:135`), not a turn status. A new turn carrying a `UserToolResponseMessage` resumes it.
- **Forking is a product feature.** `previous_turn_id` may name any turn (`SessionHandle.ts:171-173`), and the assistant-ui runtime uses it for edit-and-resend (`useTrueForgeAgentMessages.ts`). Only `'auto'` resumes race.
- **Turn access over HTTP is creator-only.** Only the session creator may create, list or subscribe to turns (`apis/turns.ts:116-128`, `turnRoutes.ts:181,255`).
- **Server-side turns already exist.** Schedules and Slack create turns without the HTTP route (`controller/scheduleDispatch.ts`, `integrations/router.ts`).
- **The turn-end hook is not universal.** `onTurnDrained` (`runtime/turnRunner.ts:442-465`) fires for every outcome on the paths that use it, but `NodeTurnExecutor.startStreaming` (`runtime/nodeTurnExecutor.ts:213-227`) drains events directly and never calls it. Streaming is the default, so on Node the hook is skipped for most turns.
- **`exec` does not inherit the daemon's environment.** `ScrubbedEnv` (`internal/runner/runner.go:379-398`) builds a fixed base of `PATH`, `HOME`, `LANG` and `TERM`. Backgrounded children survive exec: the shell runs under `Setsid`, and a 2 s `WaitDelay` closes the pipes, so `chromium … &` returns with exit 0 and Chromium keeps running.
- **Agent access** is `authorizer.canAccessAgent({action: 'read'|'use'|'manage'|'delete'})` (`auth/authorizer.ts:16`, `apis/agentAccess.ts`). Chatting with an agent needs `use` (`apis/turns.ts:372`).
- **Browser transport.** The browser gets SSE through Hono `streamSSE` (`apis/turns.ts`), and there is no browser-facing WebSocket.
- **Auth.** Browsers use a `SameSite=Lax` cookie and API callers a bearer token. There is no Origin check.

## 3. User stories

1. **Agent uses a website.** The agent is told to "download last month's invoices from the supplier portal". It runs `chromium https://portal… &` via `exec`, then screenshots, clicks and types its way through. It reads `~/Downloads` with `exec`.
2. **Agent hits a login.** It calls `request_human_takeover({reason: "Log into supplier portal as accounts@…"})`. The turn ends waiting for input. The chat, or the Slack thread, shows a takeover card linking to the agent's **Screen** page.
3. **Human logs in.** Any user with `use` access to the agent opens the Screen page, sees the pending request, and clicks **Take control**. They:
   - type the username;
   - paste the password or 2FA code from their local clipboard;
   - complete the login;
   - click **Hand back**, optionally with a note.

   The server releases control and resumes the agent's session with the tool response. The agent's next `computer_screenshot` shows the logged-in page.

4. **Human watches.** Any user with `use` access opens the Screen page, or the Screen panel in their own session, and watches the desktop update at about 2 fps.
5. **Admin pre-seeds.** From Settings → Computers → Desktop, an admin logs into accounts before any agent runs. With no takeover pending, hand-back only releases control.
6. **Copy out.** While in control, the user selects text in the remote xterm or Chromium and copies it to their local clipboard.

## 4. Architecture

```
 browser (Screen page/panel)                 server (Worker)                              user's machine
 ───────────────────────────                 ───────────────                              ──────────────
 <img>/canvas ◀─ GET screenshot (poll) ────  desktop router ──▶ RemoteComputerDO ══ WS ══▶ trueforge-computer
 input  ──────── POST input (+frame back) ─▶ (auth, agent       (lease + pending          ├─ Xvfb :99 1280x800x24 -nolisten tcp
 clipboard ───── GET/PUT clipboard ────────▶  access, Origin)    takeover, per-op check)  ├─ openbox, xterm
 hand back ───── POST hand-back ───────────▶ ── resumes session server-side               ├─ Chromium (persistent profile)
                                                                                          └─ in-process X capture, xdotool, xclip
 agent turn (SessionDO) ── computer_* tools ── desktop ops ──────────────────────────────▶
          └── screenshots ──▶ file store (R2 / S3 / local fs)
```

### 4.1 The desktop on the machine

**Processes and apps**

- **Linux only.** A daemon started with `--desktop`, or `desktop: true` in its config, supervises two processes. It restarts either one with backoff if it crashes:
  - `Xvfb :<display> -screen 0 1280x800x24 -nolisten tcp -auth <state-dir>/desktop/Xauthority`
  - `openbox`
- **`DISPLAY` and `XAUTHORITY` are set** in the environment of every `exec`, so the agent starts `xterm` or `chromium` itself. They are added to the `ScrubbedEnv` base in `runner.go`, not passed by the server, and the `-auth` file stops other local users on a bare-metal host from attaching to the display.
- **xterm copies to CLIPBOARD.** The image sets `XTerm*selectToClipboard: true`, so an xterm selection reaches the selection that `xclip -selection clipboard` reads.

**Capture and input**

- **Screen capture** happens in Go through X11 `XGetImage`, with JPEG encoding in-process and no fork per frame. JPEG only, to keep live frames and model input small.
- **Input and clipboard.** Input goes through `xdotool` and the clipboard through `xclip`. `type` runs `xdotool type --delay 2`, not the 12 ms default. `clipboard_get` maps xclip's "no owner" error to `{text: ""}`.
- **One fixed resolution, 1280×800.** Screenshots are sent at native size, so the model's coordinates are desktop pixels, with no scaling layer.

**Chromium**

- **Persistent profile.** A `chromium` wrapper on `PATH` pins `--user-data-dir=<state-dir>/desktop/chromium-profile`, `--password-store=basic` (explicit, so behaviour doesn't depend on whether a keyring happens to exist), `--window-size=1280,800 --window-position=0,0` and `--disable-dev-shm-usage` (Docker's default 64 MB `/dev/shm` crashes Chromium), so logins survive sessions and daemon restarts. No `--remote-debugging-port` is set in v1.
- **Password manager off.** A managed policy file (`/etc/chromium/policies/managed/trueforge.json`) sets `PasswordManagerEnabled: false`.
- **Chromium's own sandbox stays on.** It needs unprivileged user namespaces, which is a **host** prerequisite. On recent distros it depends on the `kernel.unprivileged_userns_clone` sysctl and AppArmor's userns restriction, and no image flag fixes a host that forbids it. The 9b spike documents the host requirements, the `docker run` flags (such as a seccomp profile allowing `clone`/`unshare`) and the bare-metal `install.sh --desktop` checks. The wrapper never adds `--no-sandbox` silently: if the sandbox cannot start, `hello.capabilities.desktop` reports `false` with a reason.

**Environment and packaging**

- **Runs as the run-as user.** It is not a jail, the same as `exec` (Phase 8 §4).
- **Desktop image.** A second image, `trueforge-computer-desktop`, is needed because the busybox image cannot host a desktop. It is Debian slim with Xvfb, openbox, xterm, Chromium, xdotool, xclip and fonts.
- **Bare-metal install.** `install.sh --desktop` checks for those binaries. If any is missing, it prints the exact `apt-get install` line and fails. The script is generated by `packages/trueforge/src/computers/installScript.ts`, so the flag is added there.
- **Capability.** `hello.capabilities.desktop` is `true` only once the daemon has confirmed three things: Xvfb is up, `xdotool` and `xclip` resolve, and a Chromium sandbox self-test passes.
- **One display per computer.** Every session and agent on the computer shares it, and access is serialised by the lease (4.4).

### 4.2 Wire protocol: additive v1 extension, capability-gated

The protocol doc says new request shapes need a new `protocol_version`. This plan instead **extends v1 additively**, following the same default-safe rule that `skills` used.

- **Old clients never see desktop ops.** They are only sent to a computer whose `hello.capabilities.desktop === true`. An old client never advertises it, and would answer `unknown_op` anyway.
- **`hello` still parses unchanged.** `capabilities.desktop` is optional and defaults to `false`.
- **Protocol doc update.** `docs/remote-computers-protocol.md` gains a "Desktop extension" section. Its "frozen" paragraph is amended to allow capability-gated additive ops.
- **Schema location.** New request shapes join `ClientOpRequestSchema` in `packages/trueforge/src/computers/protocol.ts` as `z.discriminatedUnion('op', …)` members. Go and TS fixtures go in `testdata/protocol/`.

| op                      | request                                            | result                               |
| ----------------------- | -------------------------------------------------- | ------------------------------------ |
| `desktop_screenshot`    | `{ quality? }`                                     | `{ data_b64, width, height }` (JPEG) |
| `desktop_input`         | `{ actions: DesktopAction[] }`                     | `{ ok }`                             |
| `desktop_clipboard_get` | —                                                  | `{ text }`                           |
| `desktop_clipboard_set` | `{ text, selections: ('clipboard'\|'primary')[] }` | `{ ok }`                             |

- **Input actions.** `DesktopAction` is a `z.discriminatedUnion('type', …)` with these members:
  - `mouse_move {x,y}`
  - `mouse_down {button}`, `mouse_up {button}`
  - `click {x,y,button,count}`
  - `scroll {x,y,dx,dy}`
  - `key {keys}`, an xdotool chord such as `ctrl+l`
  - `type {text}`
- **Limits.**
  - `type` text is capped at 512 characters. Even at `--delay 2` that is about 1 s. The server derives `desktop_input`'s `timeout_ms` from its actions: 200 ms base plus 5 ms per typed character, so a batch containing `type` may run up to about 3 s. Bulk text goes through clipboard plus `ctrl+v`.
  - Clipboard text is capped at 64 KiB.
  - A 1280×800 JPEG at q60 is about 100–200 KB. The daemon answers `too_large` for any result over 3 MiB. That stays well clear of the 8 MiB client cap, the 4 MiB cap on anything relayed onward, and the 32 MiB socket kill.
- **No status op.** Desktop health comes from `hello` capabilities and from failing ops. The controller is not a daemon fact (4.4).

### 4.3 Live view v1: client-polled frames

There is no server-side frame loop and no SSE. The browser polls.

- **Screenshot.** `GET /api/v1/computer-desktops/{computer_id}/screenshot?agent_id=` returns `image/jpeg`.
  - The view polls every 500 ms while visible, with one request in flight at a time.
  - It backs off to 2 s when the tab is hidden.
  - Live frames are relayed, never stored.
- **Why polling.** Each viewer costs one short RPC per frame. The DO keeps no per-viewer state and can hibernate between polls, and nothing new crosses the relay.
- **Input.** `POST …/input` with `{ actions }`, batched by the UI about every 100 ms. Only the human lease holder may send it.
  - The response carries a fresh JPEG frame, so keystroke echo takes one round trip, not a round trip plus the poll interval.
- **Clipboard.** `GET|PUT …/clipboard` is for the lease holder only.
- **Lease and status.** `GET …` returns status, the controller and the list of pending takeovers. `POST …/take-control`, `POST …/hand-back {session_id?, note?}` and `POST …/cancel-takeover {session_id}` cover Sections 4.4 and 6.2.
- **Polling, not streaming.** About 2 fps is enough to log in, read a 2FA page and watch an agent. It is not smooth scrolling. Phase 9d exists for the case where it proves too poor.
- **Phase 8 §11 DO rules apply.**
  - Every call is a short RPC: a screenshot under about 1 s, input under about 200 ms, or about 3 s for a batch with `type`.
  - Anything that must outlive an idle minute goes in storage.

### 4.4 Control lease and pending takeover

**Controller and enforcement**

- **One controller.** The desktop has one controller: `null`, `agent:<session_id, turn_id>`, or `human:<user_id>`. It lives in one `RemoteComputerDO` storage key, `{holder, last_op_at}`, next to a `clearing` state (below).
- **Enforced in the DO, per op.** `RelayRequestInput` gains a `principal`: `{kind:'agent', session_id, turn_id}` or `{kind:'human', user_id}`.
  - The server always sets it from the auth or session context, never from the client.
  - `request()` checks every `desktop_*` op against the matrix below before forwarding, and refuses every other agent op except `cancel` while a human holds the lease.
  - The lease RPCs (`releaseLease`, `takeHumanLease`, `releaseHumanLease`) take the caller's `tenant_id` and check it the way `request()` does.
  - The DO is the only place this check is race-free. A `computer_click` is an input op followed by a screenshot op. If a human takes control between the two, the screenshot must be refused.

  | holder ↓ / caller →   | agent, read (`screenshot`, `clipboard_get`) | agent, write (`input`, `clipboard_set`) | human viewer, read (`screenshot`) | human, write or `clipboard_get`  |
  | --------------------- | ------------------------------------------- | --------------------------------------- | --------------------------------- | -------------------------------- |
  | none                  | ok (takes the agent lease)                  | ok (takes the agent lease)              | ok                                | needs the human lease            |
  | same agent session    | ok                                          | ok                                      | ok                                | needs the human lease (preempts) |
  | another agent session | `desktop_busy`                              | `desktop_busy`                          | ok                                | needs the human lease (preempts) |
  | human (controller)    | `human_in_control`                          | `human_in_control`                      | ok                                | ok                               |
  | human (not caller)    | `human_in_control`                          | `human_in_control`                      | `423 human_in_control`            | `423 human_in_control`           |

- **Every agent op is covered by the human lease.** `exec` runs as the same user with `DISPLAY` set, so it can drive xdotool, xclip or an X screenshot behind the tools' back. While a human holds control, the DO refuses every agent op except `cancel` (`exec`, `file_get`, `file_put` and all `desktop_*`) with `human_in_control`. `exec` never takes or needs the agent lease, so agents on other sessions keep `exec` while another agent uses the desktop.
- **Documented limit: processes already running.** A refusal stops new agent work only. Background processes an agent started earlier keep running through a takeover, so an agent could have left, say, an `xclip` loop behind that reads what the person copies. The Settings desktop warning says so.

**Agent lease**

- **Taking it.** The first `computer_*` call in a turn takes the lease if it is free.
- **Duration.** The lease lasts for the turn.
  - The provider records each computer it sends a desktop op to, per turn, before the op leaves. When the turn finishes, errors or is cancelled, the shared runner's `onTurnDrained` hook calls `RemoteComputerDO.releaseLease({tenant_id, session_id, turn_id})` on exactly those computers. The turn's `sandbox_info` is not used: a turn cancelled mid-op may never record it.
  - The session's next turn takes over the lease as the new holder, so a late release from an earlier turn is a no-op.
    - The hook is in `runtime/turnRunner.ts:442-465`, wired at `SessionDO.ts:198` and `main.ts:468`.
    - Its only consumer today is `notifier.deliverForTurn`. 9b makes it composable: deliver, release the lease, record the takeover pointer.
    - `NodeTurnExecutor.startStreaming` bypasses the hook today (Section 2). Phase 8c, or 9b if it lands first, routes that path through `onTurnDrained` so Node releases leases and records takeovers too. Without that, every Node takeover leaks the agent lease until the 10-minute backstop.
  - As a crash backstop, the lease expires 10 minutes after the last op. Each op renews it from an in-memory last-op time, written to storage at most every 30 s.

**Human lease**

- **Taking it.** Any user with control rights (4.5) may take it at any time, and it **preempts** the agent lease.
- **What the agent sees.** While a human holds control, agent `computer_*` calls and `exec` fail at once with `human_in_control`, and that includes screenshots. So the model never sees a password being typed. The error text tells the model to call `request_human_takeover` and stop, so it does not loop on retries.
- **Other viewers.** Only the controller receives frames; others get `423` and see a placeholder.
- **Expiry.** It expires after 5 minutes without input, and the UI warns at 4 minutes. Renewal is the same as for the agent lease.
- **Hand-back or expiry.** Both CLIPBOARD and PRIMARY are cleared. Until the daemon confirms the clear, the desktop is `clearing`: every op but `cancel` is refused with `desktop_busy`, and a person taking over waits for the clear. A clear that fails (the machine is offline) leaves it `clearing`, stored, and the next op, alarm or reconnect sends it again. Taking control from another person clears first too.

**Pending takeover**

- **Recording.** When a turn ends with status `done` and a `tool.response_required` for `request_human_takeover`, the same turn-end hook calls `RemoteComputerDO.recordTakeoverPointer({session_id, turn_id})`.
  - Pointers are stored in one DO map keyed by `session_id`, because the desktop is shared and several sessions on the computer can be waiting at once. The Screen page lists all of them for the agent.
  - Only the pointer is stored, so the Screen page can find sessions waiting on a human.
  - The payload is never copied into the DO. The turn's terminal state is the source of truth: `thread_id`, `tool_call_id` and `reason` are read from `required_actions` when the Screen page renders and again at hand-back.
  - `readPendingAction` (`integrations/pendingActions.ts:307`) today accepts only `ask_user_question` among client-side tools, so it is extended for `request_human_takeover`. Cancelled or errored turns never register one.
- **Stale pointers.** When a pointer's session tip is no longer that turn (someone answered in chat), it is stale. It is dropped lazily on read. No cross-DO notification is needed.

### 4.5 Access control and routes

**Router and tenancy**

- **Router.** Desktop routes live in a new router mounted at `/api/v1/computer-desktops`. It sits behind `authMiddleware` but **not** `withAdminAuth`, and the management routes stay admin-only.
- **Tenant first.** Every route resolves the computer inside the caller's tenant before it touches the relay.

**Who may view and control (owner decision: anyone with access to the agent)**

- **Agent-scoped requests.** Non-admin calls pass `?agent_id=`. `getAgent` (`db/agentStore.ts:132`) accepts id or name; the route uses id. It loads that agent, then checks two things:
  - `authorizer.canAccessAgent({action: 'use'})`, the same check as chatting with the agent;
  - that the agent's _current_ spec has `sandbox.computer_id` equal to this computer and `sandbox.desktop: true`, and that the agent's name, taken from the loaded record, is on the computer's name-keyed agent allowlist.

  Access follows immediately if an admin moves the agent. Inline session agents cannot use computers (Phase 8 §9.1) and are refused.

- **Tenant admins** may view and control any computer's desktop without `agent_id` (story 5).
- **Viewing and taking control** both need the same `use` access, so no stronger right is required to control. Taking control is allowed at any time, not only when a takeover is pending.
- **The trade-off.** One desktop is shared by every agent on the computer. A user with `use` on agent A can therefore see and drive a screen that agent B is using on the same computer. While anyone holds control, `exec` is refused for every agent on the computer, desktop-enabled or not, so an admin pre-seeding logins pauses all agent work there. The Settings desktop toggle says both, and Section 8 covers it.

**Hand-back and cancel**

- **What they do.** `POST …/hand-back {session_id?, note?}` and `…/cancel-takeover {session_id}` release the human lease. When `session_id` names a pending takeover for a session of that agent, they also **resume that session server-side** with the tool response `{"outcome":"completed"|"cancelled","note":…}`. Hand-back without `session_id` only releases control (story 5). The UI sends the `session_id` of the request the user selected, so with several pending it is never ambiguous. Hand-back requires the human lease. Cancel does not: any user with `use` may cancel a pending request without ever taking control, and if they hold the lease it is released too.
- **How the session resumes.** Through `deps.turnExecutor`, the same path Slack uses, with `previous_turn_id` set to the pending turn. The HTTP turn route stays creator-only.
  - The `UserToolResponseMessage` is built from the turn's terminal state (`thread_id` and `tool_call_id` from `required_actions`), as `integrations/router.ts` (`resumeInput`, :447-477) does for Slack, using the ref extractor in `pendingActions.ts:243-252`.
- **Why this is a narrow exception.** The server only posts the answer to a pending `request_human_takeover`.
- **Attribution goes to audit only.** `TurnStartInput.userRef` feeds harness metadata, not the turn record, and `TurnSchema` has no actor field. So the acting user is recorded in the computer audit row (`computer.desktop.hand_back`), not on the turn. Adding an actor field to turns is out of scope.
- **Race with the creator answering in chat.** Today two `'auto'` resumes of one tip both succeed and **fork** the session (`SessionHandle.ts:171-173`). Slack avoids that with a tip-running check and a dedupe row in `integration_event` (`integrations/router.ts:152-183, 434-437`). That row is keyed by integration and pruned after 24 h, so it is not reused here. `SessionHandle.createTurn` resolves the tip first and persists through `store.createTurn` many awaits later, so a check at the top would still race. 9c instead makes the persist step a compare-and-set:
  - for a `UserToolResponseMessage` with `previous_turn_id` omitted or `'auto'`, `store.createTurn` writes the turn only if `session.last_turn_id` still equals the tip it resolved and that tip is not running, in the same atomic unit that advances the tip. A stale tip is refused with `409`, and the resolver is closed as on any other failure;
  - an explicit `previous_turn_id` (a fork, as edit-and-resend uses) skips the check, so branching keeps working.

  Hand-back, cancel and the chat answer all go through `createTurn`, so whichever arrives first wins and the other gets `409`. Slack keeps its own row; it is unaffected.

- **Slack sessions.** This is why takeover also works for Slack-originated sessions.

**CSRF and errors**

- **Origin check.** For cookie-authenticated requests, state-changing routes (input, clipboard PUT, take-control, hand-back, cancel) require an `Origin` matching the public base URL.
  - Bearer-token callers are exempt: they send no `Origin` and are not exposed to CSRF (`auth/token.ts:38-40`).
- **`423` is new to the codebase.** It is declared in these routes' OpenAPI responses and in `RequestErrorResponse`.

## 5. Prerequisites: file store and images in tool results (Phase 9a)

Computer use is useless if a screenshot reaches the model as a string. **File storage is built first** (owner decision), so images are never stored inline in session history.

### 5.1 File store (9a-1)

- **Port.** `IFileStore` in `trueforge-core` provides `put({tenant_id, session_id, media_type, bytes}) → file_id`, `get`, and `deleteSession`. It has three implementations:
  - **Workers:** an R2 bucket binding (`FILES`) in `wrangler.jsonc`, followed by `pnpm workers:types`, because `workers/env.ts` is generated from it.
  - **Node, production:** S3-compatible (AWS S3, R2 or MinIO), configured through `config.ts`.
  - **Node, dev and single-instance:** the local filesystem under a configured directory. This is the default, so `docker-compose*.yml` and `pnpm smoke` need no new service.
- **Keys and metadata.**
  - Objects are keyed `tenants/<tenant_id>/sessions/<session_id>/files/<file_id>`, with an opaque random `file_id`.
  - Metadata (`file_id, tenant_id, session_id, media_type, size_bytes, created_at`) lives in a new `session_file` table in D1, Postgres and SQLite, with migrations for all three.
- **Retention.** Files are deleted with their session. The deletion happens in the session delete route (`apis/sessions.ts`), not in the session stores: it calls `fileStore.deleteSession`, then `sessionStore.deleteSession`, then `fileStore.deleteSession` again to catch an object a racing `put` wrote between the two. Any future path that deletes sessions must call `fileStore.deleteSession` as well. No tenant-deletion path exists today, so none is added.
- **Media types.** `put` accepts only `image/png`, `image/jpeg`, `image/webp` and `image/gif`, and rejects anything else.
- **Read route.** `GET /api/v1/sessions/{session_id}/files/{file_id}` serves the bytes with `Cache-Control: private`. It uses the same authorization as reading the session's turns (the creator, or a manager of the session's named agent), answered as 404: a caller who may not read the session gets the same 404 as for a missing file. Other users with `use` see the live Screen, not stored screenshots.
- **Deployment.** The filesystem backend holds files on one machine, so it is single-replica only. The images set `FILE_STORE_DIR=/data/files`; the Helm chart mounts a volume there and refuses to render the filesystem backend with more than one replica or with autoscaling, so multi-replica installs must set `fileStore.backend: s3`.
- **Scope.** Only tool-result images use the store in 9a. Moving user attachments (inline data URIs today) onto it is a separate follow-up.

### 5.2 Images in tool results (9a-2), the clean shape (owner decision)

- **Schema.** `LLMToolMessageSchema.content` becomes `ToolContentPart[]`, always an array. `ToolContentPart` is:

  ```ts
  z.discriminatedUnion('type', [
    text  { text },
    image { file_id, media_type, width, height },
  ])
  ```

  - It is owned in `trueforge-core` (`core/llm/LLMTypes.ts`), and `ToolResponseEvent` derives from it.
  - Images are always references into the file store, never inline bytes.

- **Old events.** Persisted events hold a string, and there is no canonical parser on store read today:
  - Postgres returns `e.event` raw (`db/postgres/session-store/queries/events.ts:157`);
  - SQLite passes typed events through;
  - `SessionEventSchema` is only an API-response schema.

  9a-2 therefore adds one shared helper in `trueforge-core`, `normalizeToolContent(content: string | ToolContentPart[]) → ToolContentPart[]`, and applies it at every read boundary:
  - the Postgres, SQLite and D1-backed session stores' event reads;
  - `InMemorySessionStore`;
  - LLM context replay (`runtime/contextUtils.ts` / `AgentThread.ts`).

  A contract test feeds a legacy string event through each one. No database rewrite is needed, and the API and SDK only ever emit the array. If the list of read boundaries grows, a one-time data migration replaces the helper.

- **This is a breaking wire change.** It needs:
  - OpenAPI plus SDK regen (`pnpm changeset:sdk-regen`), with a **major** changeset for `@truefoundry/trueforge-sdk`;
  - a Python SDK note in the changelog;
  - `assistant-ui-runtime` types through the existing patch;
  - the frontend updated to read parts;
  - changesets for every touched published package.
- **LLM input boundary.** `convertMessages` takes OpenAI's `ChatCompletionMessageParam[]` today, via `toOpenAIChatMessage.ts`, and that type cannot carry image parts. Widening it by assertion is barred. So 9a-2 changes the `ILLM` input to a harness-owned message type derived from `LLMContextMessage`. This is the largest single piece of 9a-2.
- **Pipeline.**
  - `toolResultResponse` may return image content.
  - `executeToolCalls` writes each image to the file store and puts an `image` part in `content`.
  - When building the request, the LLM layer loads the referenced bytes and emits `output: {type:'content', value:[{type:'text', text}, {type:'file', mediaType:'image/jpeg', data:{type:'data', data}}]}`. That is `ai@7`'s `ToolResultOutput`; the older `file-data`, `image-data` and `media` names are deprecated or absent.
  - LargeToolResponse offload applies to text parts only.
- **Provider support, checked against the installed adapters (2026-09-23).**
  - `@ai-sdk/anthropic` maps an image `file` part to an `image` block inside `tool_result`.
  - `@ai-sdk/openai` Responses (the path `VercelAILLM` uses) maps it to `input_image`. Chat Completions would stringify it, but is not used.
  - `@ai-sdk/google` sends `functionResponse.parts` with `inlineData` on Gemini 3 models and a top-level `inlineData` part on older ones. Both carry the image.
  - `@ai-sdk/openai-compatible` (fireworks, zai, together, custom, truefoundry), `@ai-sdk/moonshotai` and `@ai-sdk/alibaba` JSON-stringify the whole `value` array. An image would reach the model as base64 text, so the stub is mandatory for these.
  - Those provider types get a text stub (`[screenshot 1280x800 omitted: model does not accept images in tool results]`) from a static per-provider-type table. Spec validation warns when a desktop-enabled agent uses such a provider. 9a-2 still sends one real image through each adapter in a unit test to pin the behaviour.
- **Context size vs prompt caching.** With Anthropic `cache_control`, rewriting an old image into a stub breaks the cached prefix from that point on. So trimming happens **in batches**, at context assembly (`runtime/contextUtils.ts` / `AgentThread.ts`):
  - while there are more than 2N images (N = 5, set in `config.ts`), the oldest are replaced with stubs down to N;
  - the stored history keeps every image;
  - only the model request is trimmed.
- **Chat UI.** Tool cards render `image` parts as thumbnails served from the file route, with click-to-zoom.

## 6. Model-facing tools

### 6.1 Computer tools (Phase 9b)

- **When the tools appear.** Portable function tools are added by the sandbox integration only when both hold:
  - the agent's computer has `capabilities.desktop`;
  - the spec sets `sandbox.desktop: true`.

  A new `SandboxUsability` reason, "computer has no desktop", validates this (`packages/trueforge/src/sandbox/integration.ts:30`). `sandbox.desktop` is a new agent-spec field, so `trueforge-core`, frontend, server and patches change together.

| tool                                                   | params                           | returns                   |
| ------------------------------------------------------ | -------------------------------- | ------------------------- |
| `computer_screenshot`                                  | —                                | image (1280×800 JPEG)     |
| `computer_click`                                       | `x, y, button?, count?`          | image after 500 ms settle |
| `computer_type`                                        | `text` (≤ 512 chars)             | image                     |
| `computer_key`                                         | `keys` (e.g. `ctrl+l`, `Return`) | image                     |
| `computer_scroll`                                      | `x, y, dx, dy`                   | image                     |
| `computer_drag`                                        | `from {x,y}, to {x,y}`           | image                     |
| `computer_clipboard_read` / `computer_clipboard_write` | — / `text` (≤ 64 KiB)            | text / image              |

- **Actions return a screenshot.** That halves the round trips of act-then-look.
- **Additional instructions for the model** say:
  - `DISPLAY` is set, and apps are started with `exec` (`chromium <url> &`, `xterm &`);
  - prefer `exec` and the filesystem over the GUI when both work;
  - call `request_human_takeover` for logins, CAPTCHAs and 2FA rather than guessing credentials.
- **Errors come back as tool errors** the model can act on: `desktop_busy`, `human_in_control`, `desktop_unavailable`. The `human_in_control` text says to call `request_human_takeover` rather than retry.

### 6.2 `request_human_takeover`

- **What it is.** A built-in `ClientSideTool`, modelled on `AskUserQuestion`: `request_human_takeover({ reason })`. It is offered only alongside the computer tools.
- **When the model calls it**, the turn ends `done` with `required_actions` (thread state `user-input-required`), and the turn-end hook records the pending takeover (4.4).
- **Where it shows up.**
  - The web chat renders a card with the reason and **Open screen**, which links to the agent's Screen page.
  - Slack renders the same text with a link.
- **Resuming.** Any user with `use` access resumes the session from the Screen page via **Hand back** or **Cancel** (4.5).
  - The session creator can also answer it in chat, as with `AskUserQuestion`. Whichever answer comes first wins, and the other gets `409` through the `createTurn` check (4.5). Without that check the session would fork.
- **The tool response is text only:** `{"outcome":"completed"|"cancelled","note":"…"}`. The model calls `computer_screenshot` to see the result.

### 6.3 Approval

- **After Phase 8d.** Input tools set `is_approval_required` from the computer's `require_approval` once 8d lands the approval gate for local tools.
- **Before that.** A computer with `require_approval` set is offered only `computer_screenshot` and `computer_clipboard_read`; the input tools are withheld and spec validation says why. The daemon's read-only policy mode is not a substitute, because it refuses every `exec` and the agent could not start Chromium.

## 7. Web UI (Phases 9b and 9c)

**Where the view lives**

- **Screen page.** The agent page gets a **Screen** tab for agents with a desktop computer, visible to anyone with `use`. It shows:
  - the list of pending takeover requests, each with its reason and session, and the one the user selects is the target of Hand back and Cancel;
  - the live frame, scaled to fit with the aspect ratio kept;
  - a status line: last frame age and controller;
  - **Take control**, **Hand back** with a note field, and **Cancel request**;
  - clipboard controls.
- **Screen panel.** The same component appears as a right-side panel in the session view, for the session creator.
- **Settings.** Settings → Computers → _computer_ → **Desktop** holds the admin toggle and warning text (shared screen across agents, and `exec` paused for all agents while a human holds control), plus the same component for pre-seeding logins.

**Input while in control**

- **Pointer.** Pointer events are mapped from the displayed size to 1280×800. The wheel maps to scroll.
- **Keyboard.** Focus is trapped in the view. Printable text is taken from `beforeinput`/`input` events and sent as `type`, so non-US layouts and dead keys work. Only chords (a modifier plus a key) and non-printing keys come from `keydown`, translated to X keysyms.
- **Browser-reserved chords.** A toolbar sends chords the local browser would otherwise take: Ctrl+W, Ctrl+T, Ctrl+L and Super.

**Clipboard, both ways**

- **Remote → local.** **Copy from remote** calls `GET …/clipboard`, then `navigator.clipboard.writeText` under the click gesture.
- **Local → remote.** While in control and focused, a `paste` event is intercepted: `PUT …/clipboard` (CLIPBOARD and PRIMARY), then `ctrl+v`. A **Send text** field covers browsers that block reading the clipboard.

**Chat and gating**

- **Tool cards.**
  - The new tool names go in `toolCallParsing.ts`.
  - A `ComputerToolCallCard` shows the action and a thumbnail.
  - A `HumanTakeoverCard` handles takeover requests.
- **Gating.** Everything is gated by `capabilities.desktop.enabled`, following the computers pattern in `frontend/src/App.tsx`. Lengths are in `rem`.
- **Phase split.**
  - 9b ships the chat cards and thumbnails.
  - 9c ships the Screen page, the Screen panel, the Settings tab and the takeover card.

## 8. Security and privacy

**Screenshots**

- **Screenshots are sensitive.** They are stored in the file store and sent to model providers, and they may contain PII, secrets and tokens.
  - None are taken for the agent while a human holds control.
  - They are deleted with the session.
  - Live frames are never stored.

**Human input and credentials**

- **Credentials a human types** go browser → server → daemon as input ops and never pass through the model. Every new agent op but `cancel` is refused for the duration, so the agent cannot read the display or clipboard through a shell either (4.4).
  - **Limit:** background processes an agent started before the takeover keep running, and one could watch the display or clipboard. The Settings desktop warning states this; admins should attach desktop agents only where that is acceptable.
  - The input route logs only the number of actions and their types, never text, keys or clipboard contents.
  - Takeover start, hand-back and cancel are audited with the acting user.

**The shared browser profile**

- **Wide access by design.** Owner decision 4 means anyone with `use` on any desktop agent attached to a computer can view and drive that computer's shared desktop. That includes browser sessions logged in by someone else. The Settings desktop toggle states this, and admins should attach desktop agents only to computers whose logged-in accounts every such user may use.
- **The profile is readable by the agent.** It lives on disk as the run-as user under `<state-dir>/desktop/chromium-profile`, and every attached agent runs `exec` as that user.
  - Saved passwords are off (policy).
  - Persistent login cookies, localStorage and IndexedDB tokens do persist, since that is the point of takeover. Without a desktop keyring, Chromium encrypts cookies with a fixed key (`--password-store=basic`), so an agent that reads the files with `exec` can recover them.
- **Clipboard.** Both selections are cleared on hand-back, on lease expiry and when one person takes over from another, and nobody gets the desktop until the daemon confirms. Clipboard text is never logged and is capped at 64 KiB. Agent desktop ops are audited as `desktop` rows naming the op and, for input, the action count only.

**Network and identity**

- **Egress** uses the machine's network, the same trust as `exec` on a user-owned machine. There is no URL filtering in v1.
- **Nothing listens.**
  - Xvfb runs with `-nolisten tcp` and `-auth`, so only processes holding the daemon's `XAUTHORITY` can attach.
  - No VNC and no Chromium debugging port run in v1.
  - No inbound port is opened, so the Phase 8 dial-out model is preserved.
- **Lease identity** comes from the server-set `principal`, never from a client field. Routes check the tenant first and the `Origin` on cookie-authenticated writes.

## 9. Phases

**Build order.**

1. **9a-1 File store**, and in parallel **9b Desktop on the daemon, agent tools, agent lease**. 9b's tools return text stubs until 9a-2 lands.
2. **9a-2 Image tool results**, after 9a-1. This includes the major SDK bump.
3. **9c Live view, takeover, clipboard**, after 9a-2 and 9b.
4. **9d Streamed VNC**, only if 9c users find about 2 fps inadequate.
5. **9e Hosted desktop**, deferred.

**Runtimes.** Workers ships first. Node follows Phase 8c for the computer parts. 9a is runtime-neutral and ships on both.

**Test scope.** 9a-1's route tests use a creator-only session. There is no tenant-deletion test, because no such path exists.

| phase                                                  | scope                                                                                                                                                                                                                                                              | done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **9a-1** File store                                    | 5.1: `IFileStore`, R2 / S3 / filesystem implementations, `session_file` table and migrations (D1, Postgres, SQLite), read route, session-delete cleanup                                                                                                            | Contract tests run the same suite against all three implementations. Route tests: the creator gets bytes; another user gets 404; a foreign tenant gets 404. Deleting a session removes its objects and rows. `pnpm smoke` passes unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **9a-2** Image tool results                            | 5.2: `ToolContentPart[]`, legacy-string normalization, harness-owned `ILLM` message type, pipeline, stub table, batch trimming, OpenAPI/SDK regen (major), patch, chat thumbnails                                                                                  | `VercelAILLM` unit tests assert a `file` image part for anthropic, openai and google and the stub for openai-compatible, moonshot and alibaba. A legacy string event read through every store and through context replay yields one text part. An image `tool.response` round-trips through the SDK. The trimming test shows stubs only once the count exceeds 2N                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **9b** Desktop on the daemon, agent tools, agent lease | 4.1, 4.2, agent side of 4.4 (`principal`, per-op check including `exec` under a human lease, turn-end `releaseLease`, Node streaming path routed through the hook), 6.1, 6.3, `sandbox.desktop`, desktop image with Chromium sandbox spike, `install.sh --desktop` | Go integration test in the desktop image: Xvfb up with `-auth`; `desktop_screenshot` decodes to 1280×800; `type` into xterm then screenshot shows it; clipboard set/get round-trips, and get on an empty clipboard returns `""`; `exec chromium … &` returns exit 0 within 3 s and Chromium is still running; the Chromium sandbox self-test passes with the documented flags. Protocol fixtures pass in Go and TS. A client without `desktop` never receives desktop ops. A second session gets `desktop_busy`, and a turn end releases the lease on both Workers and Node (DO and executor tests). With `require_approval` set only the read tools are offered. **Manual:** an agent starts Chromium via `exec` and each `computer_*` tool returns its text stub without error. Reading a value from the GUI is verified in 9c, once images reach the model                                                                                                                                                                                         |
| **9c** Live view, takeover, clipboard                  | 4.3, human side of 4.4 including pending takeover, 4.5, 6.2, Section 7, Origin check                                                                                                                                                                               | DO tests: human preempts agent; agent screenshot and agent `exec` refused under a human lease; clipboard cleared on hand-back; a non-controller gets 423; two sessions' pending takeovers are recorded, listed and cleared independently. Route tests: without `use` on the agent, 404; an agent not on that computer, 403; a missing or foreign `Origin` on a cookie write, 403; bearer requests pass without `Origin`; hand-back with `session_id` resumes exactly that session once; hand-back without `session_id` only releases control; a hand-back racing a creator's chat answer yields one resumed turn and one `409`, never a fork; an explicit-fork `previous_turn_id` is still accepted; a stale takeover pointer is dropped. **Manual** (Chrome and Firefox as the viewing browser): an agent requests takeover on a test login site; a _non-creator_ with `use` takes control, pastes a password, copies text out of xterm and hands back; the agent's next screenshot shows the logged-in page. Repeat from a Slack-originated session |
| **9d** Streamed VNC _(conditional)_                    | Phase 8e reverse channel, binary tunnel stream in `RemoteComputerDO`, `x11vnc -localhost`, noVNC, lease-enforced view-only                                                                                                                                         | Started only if 9c users find about 2 fps inadequate. Done when noVNC holds ≥15 fps on a LAN machine, and a chunking test shows no update can push a frame past the socket limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **9e** Hosted desktop _(later)_                        | A desktop variant of the `ComputerDO` container image                                                                                                                                                                                                              | Deferred by the owner; not planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 10. Repo rules this touches

- **Naming.** Wire and DB names are snake_case. Ops, actions and content parts use `z.discriminatedUnion`.
- **Ownership.**
  - Protocol constants and schemas live in `packages/trueforge/src/computers/protocol.ts`.
  - The tool-content schema and the `IFileStore` port live in `trueforge-core`.
  - DTO and port changes go in `assistant-ui-runtime/src/server/types.ts`, re-exported by `trueforge-ui`.
- **The `desktop` capability** must be added in several places:
  - the computer `capabilities` jsonb (`db/computerStore.ts`, `schemas/computer.ts`);
  - `ComputerCapabilitiesSchema`;
  - the server `capabilities.desktop` flag (`apis/capabilities.ts:45-49`);
  - SDK regen.
- **Daemon environment.** `DISPLAY` and `XAUTHORITY` join the `ScrubbedEnv` base in `internal/runner/runner.go`; they are not request env, so the restricted-policy env filter does not touch them.
- **Migrations.** New `session_file` migrations for D1, Postgres and SQLite. The R2 binding goes in `wrangler.jsonc`.
- **Environment.** No `process.env` outside `config.ts`. New settings (file store backend and credentials, image trim N, lease timeouts) go there.
- **Compose files.** The `docker-compose*.yml` files stay unchanged, since the filesystem store is the default. If MinIO is ever added, it goes into both compose files in sync.
- **Generated code.** OpenAPI and SDK are regenerated in CI, never hand-edited.
- **Types and schemas** change across `trueforge-core`, `frontend`, `trueforge` and `patches` together. 9a-2's SDK changeset is **major**.
- **The new routers** follow `packages/trueforge/AGENTS.md` naming. OpenAPI descriptions stay under 50 words and describe only the caller-visible contract.

## 11. Decisions (owner, 2026-09-23)

1. **Who starts X:** the desktop is turned on per computer. The daemon owns the X server, and the agent only uses it.
2. **Browser:** Chromium, with a persistent profile, the password manager off and its sandbox kept on. DOM/CDP tools may come in a later phase.
3. **Platform:** Linux only for v1. A macOS real-screen variant may come later.
4. **Takeover rights:** anyone with `use` access to the agent can view, take control and hand back. Tenant admins can do the same for any computer.
5. **Hosted desktop:** the user's own machines only for now. A cloud desktop may come later (9e, not planned).
6. **Screenshot storage:** build a file store first (9a-1). Images are never stored inline.
7. **Tool-result schema:** the clean shape. `content` is always `ToolContentPart[]`, legacy strings are normalized on read, and the SDK takes a major bump.

Resolved 2026-09-23: which providers accept images in tool results (5.2, checked against the installed adapters).

Resolved 2026-09-23 (9b spike): which `docker run` flags let Chromium's sandbox work in the desktop image.

- **The answer:** `--security-opt seccomp=packages/trueforge-computer/packaging/desktop/seccomp.json`, and nothing else. That profile is moby's default (`moby/profiles` `seccomp/v0.1.0`) plus one rule allowing `clone` and `unshare` without `CAP_SYS_ADMIN`. No `--cap-add`, `--privileged`, `seccomp=unconfined` or `apparmor=unconfined`, and `--no-sandbox` is never used.
- **Tested on** an Ubuntu 24.04 host (kernel 7.0, `kernel.unprivileged_userns_clone=1`, `kernel.apparmor_restrict_unprivileged_userns=1`) with Docker 29.2.1, running the image as uid 1000:
  - With Docker's default profile, Chromium 153 exits with `No usable sandbox!`. The default profile only allows namespace flags on `clone` and `unshare` with `CAP_SYS_ADMIN`.
  - With the profile above, headless Chromium renders a page, and its renderer and zygote processes run in their own user and PID namespaces.
  - The `docker-default` AppArmor profile did not block user-namespace creation, so the host's AppArmor restriction needed no flag.
- **Tests.** `pnpm --filter @truefoundry/trueforge-computer test:desktop-image` repeats both runs: everything passes with the profile, and without it `capabilities.desktop` is false with the sandbox reason.
- **Bare metal.** The same self-test runs at daemon start. A host that forbids unprivileged user namespaces reports `desktop: false` with Chromium's reason. The usual fixes are Chromium's own AppArmor profile or the `kernel.apparmor_restrict_unprivileged_userns` sysctl.

## 12. Review log

### 2026-09-23: adversarial review (Fable subagent)

**Blockers, all fixed:**

- The file-ref storage assumed a store that doesn't exist. Superseded by decision 6: the file store is now built first.
- The pause/resume flow contradicted how client-side tools work. The turn now ends and is resumed by a tool response.
- The access model contradicted the admin-only mount. Superseded by decision 4: a non-admin router gated on agent `use`.

**Majors, all fixed:**

- Wrong AI SDK part names.
- The lease had no enforcement point.
- The server-side SSE loop had no fan-out.
- Last-N trimming broke prompt caching.
- Privacy gaps.
- Phase order and verifiability.

**Minors, all fixed:**

- Cut: the scale layer, `desktop_status`, `computer_launch`, adaptive fps, `return_screenshot`, and the launcher panel and apt automation.
- Capped `type` at 4 KiB.
- Added the Origin check.

### 2026-09-23: delta re-review (same reviewer)

B1–B3, M1 and M3–M6 were confirmed closed, and M2 half-closed. Fixes:

- **N1.** `images` would be dropped at the OpenAI-typed `ILLM` boundary. Fixed with a harness message type and trimming at context assembly.
- **N2.** Added the per-op lease matrix.
- **N3.** Added the turn-end release hook and per-op renewal.
- **N4.** The Origin check applies to cookie auth only.
- **N5.** JPEG only.
- **N6.** xterm copies to CLIPBOARD, and both selections are cleared.
- **N7.** `computer_id` is read from the current agent spec, and inline agents are refused.
- **N8.** Corrected the profile-exposure wording.
- **N9.** Declared `423` in OpenAPI.
- **Takeover check.** It now reads a `tool.response_required` event rather than a turn status.

### 2026-09-23: owner decisions applied

- **Firefox replaced by Chromium.** Added the password-manager policy and the sandbox-flags spike.
- **Access widened to agent `use`.** The session-scoped `?session_id=` check became the agent-scoped `?agent_name=` check. Takeover now resumes the session server-side via the schedule/Slack turn path. That removes the creator-only limit and makes Slack takeover work, so the former "Slack/API cannot complete takeover" non-goal is dropped.
- **New phase 9a-1 (file store).** Images are stored as file references, not inline.
- **Tool-result `content` is now `ToolContentPart[]`.** The earlier additive `images` field is dropped.
- **Hosted desktop deferred.**

### 2026-09-23: third review (same reviewer), owner-decision delta

**Majors, all fixed:**

- The "first answer wins" claim was false, because two resumes fork the session. Hand-back now reuses Slack's tip check and dedupe row, and `createTurn` refuses an already-answered tool call.
- `thread_id` was missing from the takeover record. The DO now stores only a pointer, and the payload is read from the turn state.
- Attribution had no field on the turn. It is recorded in the audit row only.
- The "one canonical event parser" did not exist. A new `normalizeToolContent` helper is applied at every read boundary.

**Minors, all fixed:**

- The turn-end hook is `onTurnDrained` in `turnRunner.ts`, made composable.
- The tenant-deletion sentence was dropped, since no such path exists.
- The three `deleteSession` implementations are named.
- `pnpm workers:types` follows the R2 binding change.
- The Chromium wrapper now sets `--password-store=basic` explicitly.
- The sandbox spike now covers host userns requirements.
- `?agent_name=` became `?agent_id=`.
- The file route being creator-only is now stated.

### 2026-09-23: fourth review (Fable, with code verification), design delta

**Gaps that broke stated properties, all fixed:**

- `exec` bypassed the human-control blackout: same user, `DISPLAY` set, so xdotool or xclip through a shell went unseen. Agent `exec` is now refused under a human lease (4.4, 8).
- The 4 KiB `type` cap implied about 50 s of xdotool typing against a 200 ms budget. Cap is 512 chars with `--delay 2` and a 5 s timeout.
- The pending-takeover pointer was singular on a shared desktop. It is a map keyed by session, and hand-back and cancel name the `session_id`.
- "Node gets the turn-end hook for free" was false: the Node streaming executor bypasses `onTurnDrained`. Routing it through the hook is now in 9b/8c scope.
- The `createTurn` `409` would have broken edit-and-resend, which forks tips on purpose, and a check at the top of `SessionHandle.createTurn` would still race because the persist happens many awaits later. The check is now a compare-and-set on `last_turn_id` inside `store.createTurn`, for `'auto'` resumes only; the Slack `integration_event` row is not reused.

**Inconsistencies fixed:** 9b's manual gate needed images that only arrive in 9a-2; read-only policy mode refuses all `exec`, so it cannot stand in for approval; `DISPLAY` must be injected into the daemon's scrubbed base env; turns end `done` with `required_actions`, not in a `user-input-required` status.

**Provider spike resolved from the installed adapters:** anthropic, openai Responses and google carry images; openai-compatible, moonshot and alibaba stringify them, so the stub table is mandatory.

**Hardening added:** Xvfb `-auth` plus `XAUTHORITY`; Chromium `--disable-dev-shm-usage` and pinned window geometry; empty-clipboard read returns `""`; human keyboard text from `input` events, chords from `keydown`; `human_in_control` error text tells the model to request takeover.

**Citation drift corrected:** `executeToolCalls` stringifies image-only arrays rather than dropping them; `SandboxUsability` lives in the server's sandbox integration; `pendingActions.ts:243-252` is a ref extractor; `getAgent` accepts id or name; `convertMessages` starts at :802; `install.sh` is generated by `installScript.ts`.
