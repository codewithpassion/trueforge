# Integrations layer and Slack plan

Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation.

Status: proposed on 2026-09-16. Nothing in this plan is implemented.

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
  receive(input: { request: Request; manifest: TManifest }): Promise<InboundResult>;
  /** Posts one message; idempotent per delivery id. */
  deliver(input: { manifest: TManifest; delivery: Delivery }): Promise<DeliveryResult>;
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
- **`integration_delivery`,** the outbox: `id`, `integration_id`, `conversation_key`, `turn_id`, `status` (`pending` | `sent` | `failed`), `attempts`, `last_error`, `created_at`, `updated_at`.
  - Unique on `turn_id`, so a turn delivers at most once per conversation.

Writes that go together use the conditional-chain rule on D1 (port plan Section 4.2). Examples: the dedupe insert plus the session get-or-create, and the outbox row plus turn start.

Schemas:

- `IntegrationManifestSchema` is a `z.discriminatedUnion("type", [SlackIntegrationManifestSchema])`, with named `.openapi()` components and snake_case fields.
- `SessionSourceSchema` gains the `integration` variant, and `SessionSourceType` gains `"integration"`.

### 2.4 API

Admin settings routes, following the repo's OpenAPI naming convention:

- `GET /api/v1/settings/integrations` returns `ListIntegrationsResponse`.
- `POST /api/v1/settings/integrations` takes `CreateIntegrationRequest { manifest }` and returns `201` `GetIntegrationResponse`.
- `GET`, `PUT`, and `DELETE /api/v1/settings/integrations/{integration_id}`.
- Credentials are redacted on read. On `PUT`, a redacted value keeps the stored secret, the same pattern as the Daytona `api_key`.

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

- `team_id`
- `bot_user_id`
- `default_agent_name`
- `allowed_channel_ids` (empty means none are allowed; a DM with the bot is allowed when `allow_direct_messages` is true)
- `reply_mode` (`thread`)
- `auth: { bot_token, signing_secret }`, both redacted

**App setup (documented, not automated in I2):**

- Create a Slack app with bot scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`, and `reactions:write`.
- Subscribe to the `app_mention` and `message.im` events.
- Set the request URL to `<PUBLIC_BASE_URL>/api/v1/integrations/<id>/events`.
- Install to the workspace, then paste the bot token and signing secret into the settings UI.

**Inbound flow:**

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
2. A settings UI section in `packages/frontend` to connect Slack (manifest form with redacted secrets), and a changeset for the frontend.
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

### Phase I3: approvals and questions in Slack

- **Approvals.** Tool approvals (`require_approval_for_tools`) and `ask_user_question` post Block Kit messages with buttons.
- **Interactivity endpoint.** `POST /api/v1/integrations/{integration_id}/interactions` verifies the signature and maps the action to `user.tool_approval` or `user.tool_response` turn input.
- **Who may approve.** Only allowed Slack users can approve; the allowlist lives in the manifest. Until per-sender identity exists, approvals are recorded with the Slack user id in metadata.

### Phase I4: notification rules

- **Rules.** A manifest-level list of rules such as "post schedule `<name>` results to channel `<id>`". The notifier matches turns from sessions with `source.type === "schedule"`.
- **Why not MCP.** Posting stays out of the agent's tool set, so results arrive even when the agent does not call a Slack tool.

## 5. Rules

- No casts, no `z.merge`, no inline nested object schemas, and `z.discriminatedUnion` for the manifest and the source.
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
- **Code execution.** Sandbox features depend on Phase 7 (`docs/cloudflare-workers-sandbox-plan.md`). Slack turns follow the agent's sandbox settings on each runtime.
