# PRD: Agent calling (Phase 9)

Status: proposed on 2026-09-23. Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation. Nothing in this plan is implemented. The sibling plan `docs/a2a-plan.md` (Phase 10) builds on it.

## 1. Problem, goal, non-goals

An agent can only delegate to a clone of itself. `create_sub_agent` spawns a thread with the same spec, tools and sandbox, a forced sub-agent identity and no structured output (`DynamicSubAgents.ts:14-15,75`, `TurnResourceResolver.ts:230`). There is no way to say "ask the Research agent, which has web search and the office computer".

**Goal.** At config time the owner of agent A names the agents A may call. At run time A's model sees one `call_agent` tool whose `agent` parameter is an enum of exactly those names. Calling it runs a real turn on a real session of agent B under B's own model, instructions, MCP servers, skills, sandbox or computer and approvals, and returns B's final message as a tool result. Both sessions are linked so a person can walk from A to B and back.

**Non-goals.** Streaming B's tokens into A's transcript. Sharing a sandbox or files. Cross-tenant calls. Human-in-the-loop inside B. A2A over the wire: this phase builds the seam a sibling PRD plugs into.

## 2. What exists today

**Dynamic subagents are threads, not sessions.** The tool returns `{ createSubAgent }` (`DynamicSubAgents.ts:94-102`), `executeToolCalls.ts:110-118` raises an internal event, and `AgentThreadOrchestrator.ts:390-413` builds a thread from the **parent's** definition: one turn, one `AbortController`, one metrics fold, one sandbox. It cannot target another saved agent, so agent calling is not an extension of `AgentInfoSchema`.

**Nothing can await a turn across a boundary.** Every existing "external event starts a turn" path is fire and forget plus a push: the integration router finds or creates a session by `external_id`, starts a turn, writes an outbox row, and `TurnCompletionNotifier.deliverForTurn` delivers later from a guarded claim (`integrations/router.ts:142-150,388-432`, `TurnCompletionNotifier.ts:66-115`). `startTurnInProcess` returns at first-event dual write and its `drained` promise never crosses an RPC (`turnRunner.ts:428-470`); `SessionDO.startTurn` arms an alarm and returns the running turn, and `RunningTurn.settled` is private (`SessionDO.ts:87-90,141,220`). Agent calling is the first caller that wants a result.

**The allowlist pattern is settled.** `computer_agent_access` is keyed by immutable agent id with a display-only name; names resolve to ids once in the PUT handler and an unknown name is a 422 (`apis/computers.ts:292-323`). One function decides (`computers/resolveComputer.ts:1-4,60-101`) and three points ask it: `validateAgentSpec` (`runtime/sessionResources.ts:355-381`), turn start (`turnRunner.ts:142-160`) and the file download (`apis/turns.ts:233-252`).

**Sessions carry a typed, indexed source.** `SessionSourceSchema` is a `z.discriminatedUnion` over `schedule` and `integration` (`schemas/session.ts:86-95`), `ListSessionsInput` filters `source_type` / `source_id` on an expression index (`store/ISessionStore.ts:87-93,290-295`), and the list row already renders a source icon (`AgentSessionListRow.tsx:41-47,87-93`).

## 3. User stories and flow

**Configure.** A new "Agents this agent may call" section in the builder: chips plus an add control built from the existing `AgentSearchPicker.tsx` over `AgentBuilderServer.searchAgents` (`assistant-ui-runtime/src/server/types.ts:457`), so no new catalog port. Saving writes `config.agent_calls.allowed_agents`; the server resolves each name to an id or answers 422.

**Run.** One tool: `call_agent({ agent: enum[<allowed names>], message: string, context?: string })`. One tool with an enum rather than one per callee, mirroring `create_sub_agent`'s `model: z.enum(modelKeys)` (`DynamicSubAgents.ts:92`): it keeps the tool list flat at ten callees and keeps one branch in `toolCallParsing.ts:14`. Each allowed agent's stored `description` goes into the tool description, as model descriptions already do (`DynamicSubAgents.ts:64-70`).

The handler creates a fresh session bound to B by reference, starts a turn, waits, and returns B's final text plus `{ callee_session_id, callee_turn_id, metrics }`. While B runs, A's turn stays open on that tool call; the card shows as pending and, once the result lands, names B and links to B's session, while B's session shows a "Called by A" line and a link back. A live in-progress card needs the emission seam in Section 6 and arrives in 9b.

## 4. Design decisions

**(a) Where the allowlist lives.** On the **caller's spec**: `config.agent_calls.allowed_agents`, an array of `{ name, id }` with names resolved to immutable ids at save time, 422 for an unknown name, re-checked at turn time and again per call. Recommended because the grant is decided by the caller's own owner, making it the same kind of field as `mcp_servers` and `skills`, which already live on the spec and are validated in `validateAgentSpec`; a table would be right only if an admin granted it, as with computers. Since `read` and `use` are unconstrained inside a tenant (`auth/authorizer.ts:43-48`), a caller-side list grants nothing its owner could not do directly. Alternative: a callee-side `callable_by` plus an `agent_call_access` table, meaningful only under an `Authorizer` that constrains `use`. The spec is both wire and storage, so on every save the server re-resolves `name → id` and overwrites whatever `id` the client sent; a client-supplied id is never trusted. Cap the list at 10 so save-time resolution fits the D1 query budget. Deleting B leaves a stale entry the turn-time re-check refuses, as a deleted computer does.

**(b) Identity.** B's turn runs under the **caller session's `created_by_subject`**, with `canAccessAgent({ action: 'use' })` re-checked for that subject against B at call time, on the precedent that owning a trigger is not permission to invoke an agent (`apis/schedules.ts:291-303`). Recommended because `isSessionOwner` gates creating turns, cancelling and downloading files (`apis/turns.ts:216-222,352-360`): a system subject would make B's session undrivable and invisible to the person looking for the trace. B's MCP servers, skills and computer resolve from B's own spec, so B's computer grant is checked against **B's** agent id. A Slack-originated A already runs as the connecting admin (`docs/integrations-slack-plan.md:259`) and that identity flows through unchanged.

**(c) Sessions and finding the trace.** A third `SessionSource` arm:

```
{ type: 'agent_call', id: <caller_session_id>, turn_id, agent_id: <caller_agent_id>, trace_id, depth }
```

`id` is the caller session, deliberately, so the existing indexed `source_type` / `source_id` filter answers "what did this session call" with no new index. `trace_id` is **the root session's id by convention**: a root keeps its existing source and its own id is the trace id, and every callee copies its caller's.

**Session per call**, created fresh each time. Recommended for two reasons: it is the only correct shape when A asks B two unrelated questions, and `SessionHandle.createTurn` freezes the session's previous tip with `CancelledForNextTurn` (`SessionHandle.ts:192-198`), so a reused session would let one call kill another's in-flight turn, which is why the integration router refuses instead (`router.ts:19-24,153-158`). Alternative for a later phase: a reusable callee session per caller session keyed by `SessionRecord.external_id` through `getOrCreateByExternalId`, plus that busy refusal.

Listing a trace needs an expression index on `source.trace_id`, still a paired SQLite / Postgres / D1 migration, and it still misses the root, so the UI does one extra read by id. Recommended over a real nullable `trace_id` column backfilled to `session_id`, which is one query but adds a field to `SessionRecord` and the `Session` wire shape; that is the alternative if the UI later wants root and callees in one list call.

**(d) Depth, fan-out, cycles and budget.** Phase 9 is **depth 1**, enforced by the host, not by core: `builtinsFromSpec` never sees the session, so the host omits `agentCallPort` from the resolver when `session.source?.type === 'agent_call'`, and the capability gates on port presence exactly as `webSearchProvider && config.web_search.enabled` does (`builtinsFromSpec.ts:69-71`). Cycle prevention is then free. Beyond depth 1, carry `depth`, refuse past a max, and refuse a callee id already on the chain. Fan-out: one in-flight call per turn, plus a per-turn total cap.

On Workers B's turn runs in its own `SessionDO`, so the two 14-minute alarm budgets are independent (`workers/alarmBudget.ts:2`). A must not park on one long RPC: Cycle 32 showed the platform replaces an instance parked without a storage access, and the turn dies as `client-cancelled` (`docs/remote-computers-plan.md` Section 11). Recommended mechanism: call the existing `SessionDO.startTurn`, which returns promptly, then loop a **new bounded-wait RPC** `waitForTurn({ turn_id, timeout_ms })` capped near 20 seconds that races the private `settled` handle and answers from memory. About 25 hops for an eight-minute call, each short enough that the caller's five-second liveness probe keeps touching storage (`workers/instanceLiveness.ts:2`). Do **not** read `sessionStore.getTurn` per hop: a 100-iteration turn already spends about 818 D1 statements against the 1000-per-invocation limit and warns past 800 (`docs/cloudflare-workers-port-plan.md:293`, `SessionDO.ts:38-39`). `waitForTurn` answers from memory, so a replaced callee instance answers "unknown turn"; on that one answer only, A does a single D1 `getTurn` read, which converges because the watchdog freezes an orphan as `Abandoned` within about 60 seconds (`SessionDO.ts:37,377-414`). The per-call ceiling is `min(8 minutes, A's remaining execution budget less a margin)`, because `SERVER_EXECUTION_TIMEOUT_SECONDS` is 600 seconds counted from `beginTurnExecution` and A may call at minute five (`config.ts:866-870`); at the ceiling the tool returns a defined "still running, session X, turn Y" result. `onTurnDrained` (`turnRunner.ts:454-467`) is the seam for a later fire-and-collect variant, not needed while A must be alive to receive the tool result.

**(e) What returns.** B's final assistant text, extracted as `assistantText` already does (`integrations/deliveryContent.ts:6-18`), plus structured content carrying `callee_session_id`, `callee_turn_id` and B's `TurnMetrics`. B's turn is a root turn, so its `response_format` applies normally, unlike a sub-agent thread which has it stripped (`TurnResourceResolver.ts:230`); no parsed structured-output field exists anywhere, so the JSON arrives as B's assistant text and the result flags that B has a response format. Files stay **by reference**: the ids address B's existing download endpoint, which is `isSessionOwner`-gated and so works for the same person because of decision (b). Metrics roll into **B's** session in the same atomic batch as its terminal transition; A echoes them in the tool result and does not add them to its own session metrics, so nothing is double counted.

**(f) Approvals and questions inside B.** **Fail fast.** A paused turn is not a distinct status: it ends `done` with `output: null` and non-empty `required_actions`, covering `tool.approval_required`, `tool.response_required` and `mcp.auth_required` (`schemas/turn.ts:94-108`). The handler then cancels B's turn and returns an error tool result naming the pending action, B's name and B's session id, so the model can rephrase and the person can open B's session and resolve it. Recommended over bubbling into A's `required_actions`, which needs a cross-session resume path and a UI that renders B's held call inside A's turn. A Slack-originated A is unchanged: A's own held actions still reach Slack (`docs/integrations-slack-plan.md:228`), B's do not. Note `call_agent` itself cannot be approval-gated: `LocalToolMCP.toolCallInfo` hard-codes `is_approval_required: false` (`core/mcp/LocalToolMCP.ts:125`), the same blocker Phase 8d opens for sandbox `exec`.

**(g) Cancellation.** The handler holds the turn's `AbortSignal` and issues a cancel on B's turn on abort. A caller lost to an instance replacement is recorded `Abandoned` and cannot cancel B, so B completes into its own session unread. Accept and say so: the work is recorded and reachable.

**(h) Node runtime.** Same port, Node implementation. A Node process starts B's turn in process and awaits `drained` directly, so no Redis hop is needed on the happy path; `NodeTurnExecutor.start` drops `drained` today (`nodeTurnExecutor.ts:200-211`) and the port keeps it. Cross-replica cancel already exists as `redisRequest` peer cancel (`:104-166`) and is reused unchanged; its 60-second reply timeout is a cancel budget, not a call budget.

## 5. Data model and API

**Schemas.** `RuntimeConfigSchema` gains `agent_calls: { enabled (default false), allowed_agents: Array<{ name, id }> }` (`schemas/agentSpec.ts:196-222`). `SessionSourceTypeSchema` gains `agent_call` and `SessionSourceSchema` a third strict arm (`schemas/session.ts:74-95`); the union stays a `z.discriminatedUnion`.

**Tables.** None new: the allowlist is on the spec and the link is in the existing `source` JSON. The only migration is the expression index on `source.trace_id`, shipped as the usual three: `src/db/sqlite/migrations/*.ts` and `src/db/postgres/migrations/*.ts` sharing a basename, plus `migrations/d1/NNNN_*.sql` named in line 6 of both, per `src/db/sqlite/AGENTS.md:3`.

**Core.** An `AgentCalls` capability beside `DynamicSubAgents.ts`, wired from `builtinsFromSpec.ts`, and an `agentCallPort` on `ITurnResourceResolver` with `startCall`, `waitForCall`, `cancelCall`. It copies `webSearchProvider` exactly: a port at `ITurnResourceResolver.ts:26`, a capability at `builtinsFromSpec.ts:69-71`, supplied at `turnRunner.ts:376`, refused at `sessionResources.ts:383-386`. One `resolveAgentCall` function is the single decision point, as `resolveComputer.ts` is, with a reason union and one message table.

**Routes.** `GET /api/v1/sessions` gains a `trace_id` query param beside the existing `source_type` / `source_id` pair (`schemas/session.ts:130-142`); session detail needs no new route. `validateAgentSpec` gains the name-to-id resolution and its 422 (`app.ts:129-137`). `GET /capabilities` gains `agent_calls: { enabled }` beside `computers` (`routes/capabilityRoutes.ts:26-30`). OpenAPI and SDK regenerate in CI; add changesets for `trueforge-core`, `trueforge`, `trueforge-ui` and `frontend`.

**UI.** A new `AgentConfigEditor` id and section in `AgentConfigPanel.tsx:459-560` with chips like MCP and skills; a fourth branch in `ToolCallContainer.tsx:137-300` rendering an `AgentCallCard` modelled on `SubAgentCard.tsx:24-88` but linking out instead of nesting a thread; a third source icon in `AgentSessionListRow.tsx:87-93` plus the widened union at `agentSessionsServer.ts:21` and the narrowing at `AgentSessions.tsx:42`; a "Called by" line in `AgentSessionDetailHeader.tsx`. Gate the section on a flag added to `AgentBuilderCapabilitiesResponse` (`assistant-ui-runtime/src/server/types.ts:427-435`), following `webSearch` rather than the port-presence trick used for computers.

## 6. Tracing

The call is a plain tool call, so start is the tool call in `model.message` and end is `tool.response`. **The middle has no channel today.** A tool injects events only through `events` on its _response_ (`core/mcp/IMCPServer.ts:39`, `ToolResponseProcessor.ts:8`), and every capability processor hook runs at a loop boundary (`AgentContextProcessor.ts:31-48`), so a handler still awaiting B cannot push anything. Phase 9a therefore ships start and end only: the tool response carries `callee_session_id`, `callee_turn_id` and `trace_id`, which is enough for the UI to link out. Phase 9b adds a core emission seam (an emitter passed to `LocalToolMCP` handlers) plus one first-class event on `SessionEventSchema` (`schemas/events.ts:101-116`), `agent_call.update`, carrying those ids, the callee agent name and a status. First-class rather than a registered passthrough (`core/events/PassthroughEvents.ts:1-16`) because the UI and the OpenAPI spec both need it and passthrough is deliberately private and ambient. The timeline then renders it as a segment type beside `sub_agent` (`buildSessionTimelineSegments.ts:252-290`).

`AgentTracing` is OTEL-shaped spans with no trace id field (`core/tracing/AgentTracing.ts`). Set `tracingEnabled = true` on the new tool set, unlike `DynamicSubAgents.ts:57`, so `withLocalToolSpan` fires. Propagating a W3C trace context into B's turn is a follow-up.

## 7. Security

- Enforced server side on every call: in the tool enum, again in the handler against the resolved ids, never from anything the model wrote.
- Grants are by **immutable agent id**; the display name may go stale. Creating an agent is not an admin action, so a name-keyed grant would hand access to whoever next takes that name.
- Tenant isolation: B is loaded with the caller session's `tenant_id`; a cross-tenant id is a 404 before a turn exists.
- **Prompt injection reaching a privileged callee** is the real residual risk. B may have a computer or an MCP server A does not, and content that steers A steers B's input string. Controls: A's owner chose B explicitly, B's own approval settings still apply, B's computer grant is checked against B, and every call is on the record in both sessions. The builder copy must say that allowing an agent lends its whole tool surface, the way the computers grant screen says granting trusts everyone who can edit the agent.
- Recursion and fan-out are capped by depth 1 and the per-turn call cap; a per-tenant rate limit is a later phase. The tool call and response in A's session, both sessions' `source` rows and later the `agent_call.update` events are the audit record; no separate table.

## 8. Phases

Each phase runs the repo process: forge agents in worktrees, Opus review with re-reviewed fix rounds, a PROGRESS.md entry, fast-forward land on `dom/main`, deploy from it, live test by the controller with the owner's browser session.

**9a, Workers MVP.** One tool, depth 1, session per call, fail fast on approvals, generic tool card only: spec field, source arm, capability flag, core capability and port, `SessionDO.waitForTurn`, bounded wait, cancel propagation, validation 422. Acceptance: an unknown callee name is refused 422 at save; a session sourced `agent_call` has no `call_agent` tool; a call returns B's text and the callee ids; B's session is bound to B by reference and is listed by `source_id = <caller session>`; cancelling A cancels B; B pausing for approval fails the tool with a message naming B's session; the D1 statement count stays under the 800 warning. Live test: two saved agents where B has a tool A lacks, one turn in the browser, then open B's session from the ids in the result.

**9b, config and trace UI.** Allowed-agents editor, the core emission seam and `agent_call.update`, `AgentCallCard`, the third source icon, the "Called by" line, the `trace_id` filter and its index. Acceptance: the owner configures the list without touching JSON; one click walks A to B and back; a trace filter shows both. Live test: configure, run, walk the trace in the browser.

**9c, Node parity and depth.** Node port, depth above 1 with cycle and fan-out caps, per-turn cap, rate limit. Acceptance: the same scenarios pass under `pnpm smoke` on Postgres; A calls B calls C; A calling B calling A is refused with a named reason. Live test: the Node stack, same scenario.

**9d, continuity and human-in-the-loop.** Reusable callee session with the busy refusal, B's `required_actions` bubbled into A's turn, and `call_agent` behind an approval gate once the `LocalToolMCP` change from Phase 8d lands.

## 9. Risks and open questions, with recommended defaults

1. **Latency against the caller's budget.** A's own turn dies at 600 seconds counted from its start. Default: a ceiling of `min(8 minutes, A's remaining budget less a margin)` and a defined "still running" result. Open: whether the owner would rather A end and be resumed when B finishes, the `onTurnDrained` variant.
2. **Two runtimes billed at once.** A parks while B works. Default: accept, measure on the live test.
3. **D1 query headroom.** Default: no D1 read per wait hop, keep the 800-statement warning.
4. **Orphaned callee on an abandoned caller.** Default: let B finish; its session is the record.
5. **Choosing the callee.** Default: each allowed agent's stored `description` goes in the tool description. Open: whether A's owner may override that blurb per callee.
6. **Inline agents.** Default: a session bound to an inline spec may call but may not be called, since there is no id to grant, matching the computers rule.
7. **Busy callee sessions.** Default: session per call makes it moot now; Phase 9d must adopt the integration router's busy refusal.

**A2A foundation.** Everything externally visible here is transport agnostic on purpose: the allowlist is resolved ids on the caller's spec, the link is a session source arm, the middle is one event, and the mechanism is a three-method port on `ITurnResourceResolver`. A remote peer becomes another entry in `allowed_agents` whose id resolves to a registered remote agent, and another implementation of `startCall` / `waitForCall` / `cancelCall`. The sibling A2A PRD adds the registry, the agent-card fetch and the wire protocol; it should not need to change the spec field, the session source, the event or the UI.
