# Integrations layer and Slack plan

Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation.

Status: Phase I1 (the layer) landed on 2026-09-16. Phase I2 (Slack messaging) landed on 2026-09-17 apart from the live workspace test (I2.4). Phase I2.5 landed on 2026-09-21: connecting a workspace is now a Settings section, reached through an `integrationCatalog` slot added to `CatalogServer` by a types-only `pnpm patch` of `@truefoundry/assistant-ui-runtime` (`patches/@truefoundry__assistant-ui-runtime@0.1.37.patch`), and TrueForge generates the Slack app manifest rather than asking people to build the app by hand (Section 3.1). Phases I3 (approvals and questions) and I4 (notification rules) landed on 2026-09-21, apart from their live workspace test, which shares I2.4's blocker.

> **An app created from an earlier manifest does not have interactivity.** The generated manifest now carries an `interactivity` block pointing at `/api/v1/integrations/<id>/interactions`; an existing Slack app must be updated from the regenerated manifest before any button works. Nothing else about an installed app changes: the scopes and subscriptions are the same three and two.

> **Do not publish `@truefoundry/trueforge-ui` while that patch is in place.** It is workspace-local, and the package's built `.d.ts` re-exports the new port types by name from `@truefoundry/assistant-ui-runtime/server`. Deploying this fork is unaffected, because it does not publish trueforge-ui. Publishing is unblocked when the slot ships upstream and the patch is dropped — which is also the moment the patch stops needing to be re-rolled by hand, since its filename `dist/types-hS8TQqBP.d.ts` carries a content hash and will not survive a version bump.
>
> Measured, not assumed: `pnpm pack` of `@truefoundry/trueforge-ui@0.3.0-rc.8` installed into a bare project alongside stock `@truefoundry/assistant-ui-runtime@0.1.37`, then `tsc --noEmit`:
>
> - with `skipLibCheck: false`, seven `TS2305` errors in `node_modules/@truefoundry/trueforge-ui/dist/index.d.ts` line 5 — `Module '"@truefoundry/assistant-ui-runtime/server"' has no exported member` for `CreateIntegrationRequest`, `IntegrationAuthInput`, `IntegrationBase`, `IntegrationCatalogServer`, `IntegrationSetupManifest`, `IntegrationStatus` and `UpdateIntegrationRequest`;
> - with `skipLibCheck: true` (the usual default) those are suppressed and the imported names silently degrade, but any real use still fails: `CatalogServer['integrationCatalog']` gives `TS2339 Property 'integrationCatalog' does not exist on type 'CatalogServer<…>'`.
>
> **The upstream request is therefore exactly:** add an optional `integrationCatalog?: TIntegrationCatalog` slot to `CatalogServer` with a `TIntegrationCatalog extends IntegrationCatalogServer = IntegrationCatalogServer` parameter, and export `IntegrationCatalogServer`, `IntegrationBase`, `IntegrationStatus`, `IntegrationAuthInput`, `IntegrationSetupManifest`, `CreateIntegrationRequest` and `UpdateIntegrationRequest` from `src/server/types.ts` and its barrel. The patch in this repo is that change and can be sent as-is.

Goal: let people talk to TrueForge agents from Slack, and let agents and schedules post results back to Slack. Build a small integrations layer first, then ship Slack as its first channel. It must run on both the Node deploy and the Workers deploy.

Non-goals:

- A general plugin system that loads third-party code at runtime.
- Slack features beyond messaging, threads, and the interactive approval flow in Phase I3.
- Replacing MCP. An agent that only needs to post to Slack can already attach a Slack MCP server under Settings → Connectors.

## 1. What exists today

**No integrations.** There is no Slack code, no webhook ingress, and no outbound notification hook in `packages/trueforge` or `packages/trueforge-core`. There is also no plugin registration point:

- Built-in capabilities are a fixed list in `trueforge-core/src/agent-session/builtinsFromSpec.ts`.
- MCP servers and skills are configuration, not code.

**Sessions keyed by an outside id.** `POST /api/internal/sessions/get-or-create-by-external-id` returns the session for an `external_id` that is unique per tenant, or creates it. `external_id` is at most 128 characters. Session `source` is a discriminated schema, `SessionSourceSchema` in `trueforge-core/src/agent-session/schemas/session.ts`, and today its only variant is `{ type: "schedule", id, run_id }`.

**Running as a user without a request.** Schedules store `created_by_subject` and rebuild a request context with `requestContextFromCreatedBySubject` in `src/auth/identity.ts`. An integration runs turns the same way, as the admin who connected it.

**Auth.** API routes accept an OIDC bearer token or login cookie (`src/auth/token.ts`). The only service key, `TRUEFORGE_API_KEY`, is Node-only and gates the internal schedule execution route. An external Slack webhook therefore cannot call the existing API. It needs its own ingress route that verifies Slack's signature instead of user auth.

**Turn completion.** `startTurnInProcess` in `src/runtime/turnRunner.ts` returns `{ turn, drained }`, and `drained` settles when the turn's event drain ends:

- On Workers, `SessionDO` holds `drained` inside an alarm invocation. Non-streaming turns there are reliable since commits `be85cc7e`, `8d7241b4`, `4e72abc9`.
- On Node, the same promise resolves in process.

**Stores.** Every store has SQLite, Postgres, and D1 implementations under `src/db/sqlite`, `src/db/postgres`, and `src/db/d1`, backed by one shared contract suite. The root AGENTS.md requires schema changes to keep `trueforge-core`, `frontend`, `trueforge`, and `patches` in sync.

## 2. The integrations layer

Modules live in `packages/trueforge/src/integrations/`. Channel code never imports turn or session internals directly; it goes through the layer's ports.

### 2.1 Concepts

- **Integration.** One configured connection per tenant and channel type, such as one Slack workspace. It is stored as a manifest (see 2.3) and carries:
  - the default agent name,
  - allowed conversations,
  - credentials, redacted on read,
  - `created_by_subject`.
- **Conversation key.** A stable string from the channel that identifies a conversation, for example `slack:<team_id>:<channel_id>:<thread_ts>`. It becomes the session `external_id`. Keys over 128 characters are hashed (SHA-256, base64url) with a readable prefix.
- **Inbound event.** A verified, parsed channel event reduced to `{ integration_id, conversation_key, sender, text, attachments, event_id }`.
- **Delivery.** An outbound message to a conversation, produced when a turn reaches a terminal state or by a notification rule (Phase I4).

### 2.2 Ports

```ts
// src/integrations/types.ts
interface ChannelAdapter<TManifest> {
  readonly type: string;
  /** Verifies authenticity and returns the parsed event, a challenge reply, or an ignore. Must finish well under 3 s. */
  receive(input: { request: Request; manifest: TManifest; integration_id: string }): Promise<InboundResult>;
  /** Posts one message; idempotent per delivery id. */
  deliver(input: { manifest: TManifest; delivery: Delivery }): Promise<DeliveryResult>;
  /** Posts a line the outbox does not owe, such as the busy-thread reply. Best-effort. */
  notice(input: { manifest: TManifest; conversation_key: string; text: string }): Promise<DeliveryResult>;
}
```

- `InboundResult` is a discriminated union: `event`, `respond` (for example Slack's `url_verification` challenge), or `ignore`, with a reason.
- `IntegrationRouter` resolves the integration and conversation, then:
  - gets or creates the session through `Sessions` with `external_id` and `source: { type: "integration", id, conversation_key }`,
  - starts a non-streaming turn as `created_by_subject`,
  - records the turn in the outbox.
- `TurnCompletionNotifier` is called with the terminal turn after `drained` settles. On Node it runs in `turnRunner`'s drain end; on Workers it runs in `SessionDO`'s drain settle, inside the alarm invocation. It reads the outbox and calls `ChannelAdapter.deliver`.
- **Registry.** A single `integrationAdapters` map, `type` to adapter, built at startup from code. It is not loaded dynamically. Adding a channel means adding an adapter module and a manifest schema variant.

### 2.3 Data

New tables, with the migration paired across Kysely SQLite and Postgres and D1 `.sql` (see the port plan's pairing rule):

- **`integration`:** `tenant_id`, `id`, `type`, `manifest` (jsonb/json), `created_by_subject`, `created_at`, `updated_at`.
  - Unique on (`tenant_id`, `type`, `external_account_id`), for example the Slack `team_id`.
- **`integration_event`:** `integration_id`, `event_id`, `received_at`.
  - Unique on (`integration_id`, `event_id`) for replay and retry dedupe.
  - Rows older than 24 hours are pruned by the `SchedulerDO` alarm on Workers and by the controller on Node.
- **`integration_delivery`,** the outbox: `id`, `integration_id`, `conversation_key`, `turn_id`, `session_external_id`, `status` (`pending` | `sending` | `sent` | `failed`), `attempts`, `last_error`, `created_at`, `updated_at`, `next_attempt_at`.
  - Unique on (`turn_id`, `conversation_key`), so a turn delivers at most once per conversation. It was unique on `turn_id` alone until I4, which needed one schedule run to reach several channels.
  - `session_external_id` is the session the turn belongs to. Until I4 the sweep derived it from `conversation_key`, which held while every delivery went back to the thread it came from; a rule posts to a channel the session was never keyed by.
  - `pending` to `sending` is one guarded write and is the exactly-once gate: several callers can read the same owed row, but only the one that changes it posts to the channel.
  - `attempts` and the partial index on the unsettled statuses exist for the I2 retry sweep; I1 counts the one attempt and settles the row.
  - The index covers `sending` as well as `pending`, because a process that stops between the claim and the post strands a row there. `next_attempt_at` (added in I2) is when a row is next owed — a backoff for `pending`, a deadline to finish in for `sending` — so the sweep reads due rows in due order instead of deriving two rules from `updated_at`.

Writes that go together use the conditional-chain rule on D1 (port plan Section 4.2). Examples: the dedupe insert plus the session get-or-create, and the outbox row plus turn start.

Schemas:

- `IntegrationManifestSchema` carries a `type` discriminator and snake_case fields under named `.openapi()` components. While Slack is the only variant it names the Slack object directly: the repo forbids a one-member `oneOf`, so it becomes a `z.discriminatedUnion("type", …)` when a second channel lands (the same shape `SandboxProviderManifest` uses).
- `SessionSourceSchema` gains the `integration` variant, and `SessionSourceType` gains `"integration"`.

### 2.4 API

Admin settings routes, following the repo's OpenAPI naming convention:

- `GET /api/v1/settings/integrations` returns `ListIntegrationsResponse`.
- `POST /api/v1/settings/integrations` takes `CreateIntegrationRequest { manifest }` and returns `201` `GetIntegrationResponse`.
- `GET`, `PUT`, and `DELETE /api/v1/settings/integrations/{integration_id}`.
- Credentials are redacted on read. On `PUT`, a redacted value keeps the stored secret, the same pattern as the Daytona `api_key`. A `PUT` that moves the integration to another channel account while sending a redacted credential is rejected, since the stored secret belongs to the old account. That check compares `external_account_id` alone; once a second channel type exists it must compare `(type, external_account_id)`, and `type` has to become updatable.

Ingress for channels, with no user auth middleware:

- `POST /api/v1/integrations/{integration_id}/events` takes the raw body and calls the adapter's `receive`.
- It is covered by the existing `/api/*` `run_worker_first` entry on Workers.

After schema changes, regenerate OpenAPI with `pnpm openapi:write` and the SDK through its script. Never hand-edit either. Add changesets for `@truefoundry/trueforge` and `@truefoundry/trueforge-core`.

### 2.5 Identity and permissions

- **Run-as user.** Turns run as the integration's `created_by_subject`, like schedules, so an admin connects Slack and the bot acts with that admin's agent access.
- **Sender recorded.** The Slack sender's id and display name go into session `metadata`, but they do not change permissions in I2.
- **Per-sender identity** (mapping Slack users to OIDC subjects) is deferred. It needs a linking flow and is not required to ship.
- **Deleting an integration** stops ingress at once. Existing sessions stay.

## 3. Slack channel

Slack adapter in `src/integrations/slack/`.

**Manifest (`type: "slack"`):**

- `bot_display_name`, the name the person chooses for the app and its bot user
- `default_agent_name`
- `allowed_channel_ids` (empty means none are allowed; a DM with the bot is allowed when `allow_direct_messages` is true)
- `reply_mode` (`thread`)
- `approver_slack_user_ids` (empty allows nobody to approve) and `notification_rules` (Phase I4)
- `team_id`, `bot_user_id` and `auth: { bot_token, signing_secret }` — absent until the app is installed; the credentials are redacted on read

### 3.1 App setup, generated

The app cannot exist before its request URL does, and its credentials cannot exist before the app does, so the order is fixed:

1. Create the integration with a bot name and an agent. It is `pending`: no workspace, no bot user, no credentials, and `external_account_id` stands on the integration's own id so two pending integrations do not collide on the unique key.
2. `GET /api/v1/settings/integrations/{integration_id}/app-manifest` builds the manifest from the bot name and `<PUBLIC_BASE_URL>/api/v1/integrations/<id>/events`. Scopes, event subscriptions and the interaction `action_id`s come from `src/integrations/slack/appCapabilities.ts`, the same list `slack/events.ts` and `slack/interactions.ts` parse against, so the generated app and the adapter cannot drift. Since I3 the manifest also carries `interactivity`, pointing at `<PUBLIC_BASE_URL>/api/v1/integrations/<id>/interactions`.
3. The person pastes it into Slack. **Slack posts the `url_verification` challenge while it creates the app**, before the signing secret exists on this side, so a pending integration answers the challenge unsigned and refuses everything else with `409`. Once credentials are stored the signature is required again, challenge included — the unsigned branch is unreachable from then on.
4. Saving the bot token calls `auth.test` (30 s timeout, token only in the Authorization header, never logged) and stores the `team_id` and `bot_user_id` it returns. A token naming another workspace is `409`; one Slack refuses is `502` and the integration stays pending.

Bot names are constrained to what both Slack fields accept — up to 35 characters of `a-z`, `0-9`, `.`, `-`, `_` — since `display_information.name` caps at 35 and `features.bot_user.display_name` restricts the character set.

**Inbound flow:**

0. **A pending integration** parses the body and answers only `url_verification`; see 3.1.
1. **Verify the signature** before parsing JSON:
   - The base string is `v0:<X-Slack-Request-Timestamp>:<raw body>`.
   - Compute HMAC-SHA256 with the signing secret and compare it in constant time to `X-Slack-Signature`.
   - Reject timestamps older than 5 minutes.
   - Use Web Crypto, so the same code runs on Node and Workers.
2. **Answer `url_verification`** with the challenge.
3. **Ignore events** from bots (`bot_id` set), from the bot's own user, edits and deletes, and channels outside `allowed_channel_ids`.
4. **Dedupe** on `event_id` through the unique insert. A retry with `X-Slack-Retry-Num` that is already recorded is acknowledged and dropped.
5. **Map the conversation.** The key is `slack:<team_id>:<channel_id>:<thread_ts ?? ts>`. The first mention starts a thread session, and replies in the thread continue it.
6. **Strip the bot mention** from the text, then start a non-streaming turn on the session with `previous_turn_id: "auto"`.
7. **Acknowledge** with `200` inside Slack's 3-second window.
   - The turn start is a Durable Object RPC on Workers and an in-process start on Node. Both return in under 1 s: the live `startTurn` measured 0.4 to 0.6 s.
   - If a session already has a running turn, reply in the thread "still working on the previous message" and do not start a second turn.
8. **Optionally add a reaction** (`eyes`) to the message while the turn runs.

**Outbound flow:**

- On turn terminal, `TurnCompletionNotifier` posts `chat.postMessage` with `channel`, `thread_ts`, and the final `model.message` content converted to Slack mrkdwn. Long text is split into messages of at most 3,500 characters.
- A turn that ends `error`, `cancelled`, or `abandoned` posts a short status line instead.
- Delivery failures are retried with backoff, up to 5 attempts, from the outbox. On Workers the `SessionDO` alarm drives retries; on Node the controller does.
- Slack's `429` `Retry-After` is honored.

## 4. Phases

Each phase follows the port process:

- forge agents in worktrees
- an Opus adversarial review, with fix rounds re-reviewed
- the progress skill before commits
- landing by cherry-pick
- a live test on the Workers deploy with the log tail started first

### Phase I1: integrations layer (no channel)

1. Schemas: `IntegrationManifestSchema` with its Slack variant (schema only; the adapter lands in I2), plus the `integration` session source.
2. Stores and migrations on SQLite, Postgres, and D1, with contract tests in the shared store suite.
3. `IntegrationRouter`, the outbox, and `TurnCompletionNotifier`, wired into Node `turnRunner` and Workers `SessionDO`.
4. Settings routes and the ingress route, which returns `404` for unknown integrations and `501` for types without an adapter.
5. Tests:
   - router idempotency (the same `event_id` twice gives one turn),
   - one outbox row per turn,
   - the notifier fires once after `drained` on both runtimes (Workers tests with a fake adapter),
   - the D1 conditional chain under concurrent duplicate events.
6. OpenAPI and SDK regeneration, and changesets.

### Phase I2: Slack messaging

1. The Slack adapter: signature verification, parsing, filtering, mention stripping, mrkdwn conversion, chunking, and `chat.postMessage` over `fetch`. No Slack SDK is needed.
2. A settings UI section to connect Slack. It shipped first as a host page in `packages/frontend`, and moved into `SettingsBuilder` in I2.5 once `CatalogServer` gained an `integrationCatalog` slot through a types-only `pnpm patch`; the host page, its route helper and its nav override were deleted in the same change.
3. Tests:
   - signature fixtures (valid, bad signature, stale timestamp, wrong secret),
   - `url_verification`,
   - bot, self, and edit filtering,
   - thread-to-session mapping,
   - the busy-thread reply,
   - retries,
   - delivery chunking.
4. Live test on the Workers deploy with a test Slack workspace:
   - a mention starts a thread and gets a reply,
   - a thread reply continues the same session,
   - a DM works when allowed,
   - a duplicate delivery from a Slack retry does not start a second turn,
   - a long Context7 answer arrives in chunks,
   - a turn cancelled by a deploy posts a status line.
5. Deploy guide: a "Connect Slack" page under `docs/` (user documentation, added to `docs.json`) after the live test passes.

### Phase I3: approvals and questions in Slack (landed 2026-09-21)

- **Approvals and questions.** A turn that ends `done` with `required_actions` is resolved by `readPendingAction`, which reads the `model.message` the action's `source_event_id` names — one extra page read, and only for a turn that actually paused. `DeliveryContent` gained `approval_request` and `question`, and the Slack adapter renders them as Block Kit: approve/deny per held call with the tool name and a redacted, truncated argument line, or the question with one button per option plus the line saying a plain reply answers in free text. A held turn is checked **before** its text, because the model usually narrates the call it is about to make; that narration rides along as `intro`.
- **Interactivity endpoint.** `POST /api/v1/integrations/{integration_id}/interactions`. Slack posts `application/x-www-form-urlencoded` with the JSON in `payload`, and signs the **raw form body**; the same `verifySlackSignature` and the same five-minute window apply, the `team_id` must match, and a pending integration answers `409`. The route acknowledges with `200` and does every Slack-facing and turn-starting thing afterwards through the I1 `deferDelivery` / `waitUntil` seam.
- **Idempotency is keyed on the held turn, not the click.** Two clicks carry two `action_ts` values, so deduping on those would not stop the second one — and a second resume would fork the session. Every settlement takes one guarded `integration_event` row, `resume:<turn_id>`, whoever it comes from: a double click, a Slack retry, and a text reply racing a button all collapse onto it. The loser is told the decision was already taken; a start failure releases the row.
- **Nothing about the pending turn is trusted from the button.** The click names a turn and a tool call; the layer then requires that turn to be the conversation's tip, finished, and still holding that call, and takes `thread_id` from the turn's own `required_actions`.
- **Who may approve.** `approver_slack_user_ids` on the manifest, checked in the adapter because it is the channel's own user-id space, like `allowed_channel_ids`. An empty list allows nobody. A refusal is an ephemeral reply through the click's `response_url` and changes nothing; a decision replaces the original message with who decided and what, so the buttons cannot be used twice. The `response_url` is only posted to when it is a `hooks.slack.com` URL.
- **Recording the approver.** `UserToolApprovalMessage` has no metadata field, so the Slack user id reaches the agent only in the denial `reason`, and reaches people in the replaced message. Recording it on the turn input would need a core change the plan does not allow.
- **A plain reply answers a question**, because that is the only free-text route; a held **approval** does not accept one, since a decision needs the buttons.

### Phase I4: notification rules (landed 2026-09-21)

- **Rules.** `notification_rules` on the manifest: `schedule_name`, `channel_id` and a required `outcome` (`any` | `success` | `failure`) — a filter that is always explicit rather than an optional flag. `TurnCompletionNotifier.deliverForTurn` branches on `source.type === 'schedule'` and enqueues through the same claim-first outbox and retry sweep.
- **Channel, not thread.** A rule delivery's conversation key is `slack:<team>:<channel>:channel`; the sentinel reads back as "post at the top level", so `chat.postMessage` carries no `thread_ts`.
- **One delivery per rule per turn**, collapsed per channel: two rules naming the same channel both match, and the unique `(turn_id, conversation_key)` key lets only the first row land, so nobody is told twice. That collapse is the definition of "one per rule".
- **Rule channels are separate from `allowed_channel_ids`** — one is where the bot posts, the other where it listens — and the bot must be invited to the posting channel, because `chat:write` alone does not reach a channel it is not in. Adding `chat:write.public` would be a scope change requiring a reinstall, so the guide says "invite the bot" instead.
- **Added D1 statements per finished schedule turn:** 1 (`listIntegrations`). If no connected integration carries a rule, that is the whole cost. Otherwise +1 `getSchedule` (the session source carries the schedule id; rules name it), +1 turn read, and per matching channel 3 (enqueue, claim, settle) — so `2 + 1 + 3N`. A turn from any other source costs nothing new.
- **Why not MCP.** Posting stays out of the agent's tool set, so results arrive even when the agent does not call a Slack tool.

## 5. Rules

- No casts, no `z.merge`, no inline nested object schemas. `z.discriminatedUnion` for the session source, and for the manifest once it has a second variant — a single-variant union is a plain object alias.
- Secrets never go in `wrangler.jsonc` vars or `.env` files. Slack credentials live in the integration record, which is redacted on read.
- The ingress route never trusts path or body data for tenant selection beyond the stored integration record. The Slack `team_id` in the payload must match the manifest.
- Ingress work before the `200` stays under 1 s on both runtimes. No model calls or MCP calls happen before the acknowledgement.
- `packages/trueforge-core` changes are limited to the session source schema. Channel code stays in `packages/trueforge`.

## 6. Risks and open questions

- **Busy threads.** Several messages in one thread while a turn runs. I2 replies "still working"; queuing follow-up messages is a later option.
- **Run-as admin.** The bot runs with the connecting admin's access, so anyone in an allowed channel can use that agent. Allowed channels and the approval allowlist are the mitigation until per-sender identity exists.
- **Slack retries.** Slack retries delivery when the acknowledgement is slow. Dedupe covers it, but the 3-second window depends on the turn start staying fast, especially during a Workers cold start.
- **D1 query budget.** Each inbound event adds a few statements (dedupe, session, outbox) outside the turn. The turn budget is unchanged.
- **Formatting.** Markdown-to-mrkdwn conversion loses tables and some formatting. Generative UI blocks are replaced with a text fallback.
- **Multiple workspaces per tenant.** Supported by the unique key, but the settings UI in I2 shows one Slack integration.
- **Dropped event on a failed start.** A start failure deletes the event's dedupe row so the channel's retry runs it, but a retry that arrives between the dedupe write and that delete reads as a replay and is dropped. Slack retries three times over roughly 20 minutes, so a later attempt still runs; the message is only lost if every retry lands inside that window.
- **A second app in the same workspace can be half-connected.** `auth.test` proves which workspace a bot token belongs to, not which app issued it. A `PUT` carrying a real bot token from a _different_ Slack app in the _same_ workspace passes the workspace check, and a redacted signing secret is kept — so the stored pair is app A's secret with app B's token, and every inbound event fails signature verification with 401 until both are re-saved. Pairing the two credentials on any rotation would close it. Not reachable from the Settings section, which sends both or neither; API callers can hit it.

- **Ingress probing.** The ingress looks the integration up by the id in the URL before the adapter checks the signature, so an unauthenticated caller can tell a live integration id from a dead one. Acceptable while the id grants nothing on its own — the credentials live in the record and every event is signature-checked — but worth closing if ids ever become guessable.
- **Code execution.** Sandbox features depend on Phase 7 (`docs/cloudflare-workers-sandbox-plan.md`). Slack turns follow the agent's sandbox settings on each runtime.
