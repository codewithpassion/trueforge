# Per-agent integrations plan

Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation.

Status: proposed 2026-09-23. Builds on `docs/integrations-slack-plan.md` (phases I1–I4). P1 and P2 landed and were deployed on 2026-09-23 (Workers version `69e8103c`, D1 migration `0008`). The P3 docs update is done; the P3 live Slack workspace test is still pending and needs a real Slack app, the same blocker as I2.4. Section 1 describes the state before P1.

Goal: a Slack integration belongs to an agent. It is created, edited and deleted from that agent's page by the people who manage the agent, not from the admin Settings section.

Non-goals:

- One bot shared by several agents with channel-based routing. Each agent keeps its own Slack app and bot user. Two agents in one workspace means two Slack apps.
- Per-sender identity. Turns still run as the integration's `created_by_subject`.
- Any change to the channel ingress URLs or to the installed Slack apps.

## 1. What exists today

- **The binding is already one agent per integration.** `SlackIntegrationManifestSchema.default_agent_name` names a single agent, and the app manifest generator mints one Slack app per integration id. `IntegrationRouter` reads `integration.manifest.default_agent_name` in both the message path and the resume path (`src/integrations/router.ts`).
- **Admin-only CRUD.** Routes live under `/api/v1/settings/integrations`, mounted behind `withAdminAuth` in `app.ts`. The UI is the Integrations section of `SettingsBuilder` (`packages/trueforge-ui/src/containers/SettingsBuilder/IntegrationSettings.tsx` and `integrationForm.ts`), reached through the `integrationCatalog` slot on `CatalogServer`.
- **One integration per workspace.** `integration_account_uq` is unique on `(tenant_id, type, external_account_id)`, and `external_account_id` is the Slack `team_id` once installed. A second agent cannot get its own bot in a workspace that already has one.
- **Rules match schedules across agents.** `TurnCompletionNotifier.#deliverScheduleResult` lists every integration in the tenant and matches `rule.schedule_name` against the finished schedule's name. Schedule names are unique per agent, not per tenant, so a rule for agent A's `daily` also fires for agent B's `daily`.
- **The schedule precedent.** Schedules are the existing agent-owned resource, and this plan copies them:
  - the `schedule` table has `agent_id` (FK to `agent(id)` `ON DELETE CASCADE`, immutable) and `agent_name` (create-time snapshot),
  - `CreateScheduleRequest` carries `agent_name`, `UpdateScheduleRequest` does not,
  - `GET /api/v1/schedules` filters by `agent_names`,
  - access is "creator or manager of its agent", computed with `resolveManagedAgentIds` and the `Authorizer`,
  - the UI is the `schedules` tab of `AgentDetailsPage`.
- **No external API callers.** Nobody calls the settings integration routes outside the TrueForge UI, so moving them is not a compatibility concern.

## 2. Design

### 2.1 Data

`integration` gains two columns:

- `agent_id`: FK to `agent(id)` `ON DELETE CASCADE`, `NOT NULL`, immutable. Deleting an agent deletes its integrations; the cascade already removes their events, decisions and deliveries.
- `agent_name`: create-time snapshot of the registry name, for listing and filtering without a join, as on `schedule`.

The unique key becomes `(tenant_id, type, external_account_id, agent_id)`. The same workspace may then hold one integration per agent. The `pending:<integration_id>` sentinel keeps two pending integrations apart as before.

`default_agent_name` is removed from the stored manifest.

### 2.2 Migrating existing rows

One migration per backend, paired as the port plan requires: Kysely SQLite, Kysely Postgres, and `migrations/d1/0008_integration_agent.sql`.

1. Add `agent_id` and `agent_name` as nullable.
2. Backfill from `manifest.default_agent_name`, joining `agent` on `(tenant_id, name)`: `json_extract(manifest, '$.default_agent_name')` on SQLite/D1, `manifest->>'default_agent_name'` on Postgres.
3. Remove the key: `json_remove(manifest, '$.default_agent_name')` on SQLite/D1, `manifest - 'default_agent_name'` on Postgres.
4. Make both columns `NOT NULL`, add the FK, and swap the unique index. On SQLite/D1 this is the usual table rebuild.

**An integration whose agent no longer exists stops the migration.** That is intended: an admin decides whether to recreate the agent or delete the integration. The migration does not guess.

- On Kysely (SQLite and Postgres) the migration checks for orphans before changing anything and throws a readable error listing the orphaned integration ids and the agent names they point at.
- On D1, where a `.sql` file cannot branch, the `NOT NULL` insert into the rebuilt table fails and the whole batch rolls back. The raw constraint error does not say which integration is at fault, so the migration file's header and the release notes carry the query that lists them.
- The fix is done on the old version, before upgrading, from Settings → Integrations, which still exists there.

### 2.3 Schemas

In `src/schemas/integration.ts`:

- Remove `default_agent_name` from `SlackIntegrationManifestSchema`.
- Add `agent_name: NameSchema` to `IntegrationSchema` and to `CreateIntegrationRequestSchema`, beside `manifest` and not inside it (the binding is a column, not part of the document).
- `UpdateIntegrationRequestSchema` stays `{ manifest }`. An integration cannot be moved to another agent: its Slack app is named for the agent, and its threads map to that agent's sessions.
- Add `ListIntegrationsRequestQuerySchema` with `agent_names`, like `ListSchedulesQuery`.

`IntegrationRecord`, `IIntegrationStore.createIntegration` and `listIntegrations` in `src/db/integrationStore.ts` gain `agent_id` / `agent_name`, and `listIntegrations` gains an `agent_ids` filter. The shared contract suite covers the filter, the cascade on agent delete, and two integrations for one workspace on two agents.

### 2.4 API

CRUD moves from `/api/v1/settings/integrations` to `/api/v1/integrations`:

- `GET /api/v1/integrations?agent_names=…` returns `ListIntegrationsResponse`.
- `POST /api/v1/integrations` takes `CreateIntegrationRequest { agent_name, manifest }` and returns `201` `GetIntegrationResponse`.
- `GET`, `PUT`, `DELETE /api/v1/integrations/{integration_id}`.
- `GET /api/v1/integrations/{integration_id}/app-manifest` and `/decisions`.

**The ingress routes do not move.** `POST /api/v1/integrations/{integration_id}/events` and `/interactions` are written into every installed Slack app. They stay mounted without an auth shell. The authed CRUD router is mounted on the same prefix with `authMiddleware` applied per route, not as a prefix-wide `use`, so that it cannot catch ingress requests. A test asserts that an unauthenticated signed Slack event still reaches the events handler.

The Fern group changes from `settings.integrations` to `integrations`. Regenerate with `pnpm openapi:write` and the SDK script; `pnpm changeset:sdk-regen` adds the SDK changeset.

### 2.5 Permissions

The admin gate goes away. Each route checks access the way schedules do:

- **list:** integrations of agents the caller manages, plus the ones the caller created,
- **create:** the caller must be able to manage the named agent,
- **get / update / delete / app-manifest / decisions:** the creator or a manager of the integration's agent.

The UI enables Add, Save and Disconnect only for callers who can manage the agent. That is stricter than the API, which also lets the integration's creator and admins edit it; we accept the gap as the conservative choice.

The run-as model is unchanged: turns run as `created_by_subject`. That subject is now an agent manager rather than necessarily an admin, so the risk in the Slack plan's Section 6 reads "the bot acts with the access of the agent manager who connected it". Allowed channels and the approver allowlist remain the mitigation.

### 2.6 Channel runtime

- `IntegrationRouter` reads `integration.agent_name` (via `agent_id` for the lookup) in both the message and resume paths instead of the manifest.
- `TurnCompletionNotifier.#deliverScheduleResult` reads the schedule first, then lists integrations filtered to `schedule.agent_id`. This fixes the cross-agent name match and drops the tenant-wide list. Statements per finished schedule turn become `1 getSchedule + 1 listIntegrations(agent)`, then the same `1 + 3N` as before when a rule matches.
- The PUT check that refuses a redacted credential when the workspace changes is unchanged.

### 2.7 UI

In `packages/trueforge-ui`:

- **New tab.** `integrations` is added to `AgentDetailsTab`, to `LibraryAgentTab` and its guard in `utils/sessionShareUrl.ts`, and to the tab list in `AgentDetailsTabs`. It is shown only when an integration server is present, like `showSchedules`.
- **Move the page.** `IntegrationSettings.tsx` and `integrationForm.ts` move to `atoms/integrations/`, exposed as an `IntegrationsPage` slot taking `agentId`, following `SchedulesPage`. The page lists and creates integrations for that one agent. The agent picker is removed. The notification rule's schedule picker offers only this agent's schedules.
- **Delete the Settings section.** Remove `hasIntegrations`, the `integrations` section entry and its render branch from `SettingsBuilder/index.tsx`.
- **Server port.** Replace the `integrationCatalog` slot on `CatalogServer` with an `IntegrationServer` provided through `ServerContext` (`useOptionalIntegrationServer`, `isIntegrationsChromeEnabled`), matching the schedule server. Port types stay canonical in `packages/assistant-ui-runtime/src/server/types.ts`: `listIntegrations({ agentNames })`, and `CreateIntegrationRequest` gains `agentName` while losing `defaultAgentName`. `@truefoundry/trueforge-ui` re-exports them as pass-through aliases only. The adapter in `plugins/trueforge-agent-server-adapter/catalogs/integrationCatalog.ts` moves beside the schedule adapter and targets the new paths.
- `packages/frontend` needs no change beyond picking up the new server wiring, if it builds servers explicitly.

## 3. Phases

Each phase follows the usual process: forge agents in worktrees, an adversarial review with fix rounds re-reviewed, the progress skill before commits, and landing by fast-forward.

### Phase P1: backend

1. Migrations on SQLite, Postgres and D1, including the orphan check and the release-note query.
2. Schema, store and contract-suite changes.
3. Routes moved to `/api/v1/integrations` with per-route auth and agent-manager checks. The settings integration routes are deleted in the same change.
4. Router and notifier read the column; the notifier filters by the schedule's agent.
5. Tests:
   - migration: backfill, key removal, and failure with a readable message when an agent is missing,
   - two agents, one workspace, two integrations,
   - agent delete cascades to its integrations,
   - a non-manager gets `403` on another agent's integration and does not see it listed,
   - a signed Slack event still reaches ingress unauthenticated,
   - a rule for agent A's `daily` does not fire for agent B's `daily`.
6. OpenAPI and SDK regeneration. Changesets for `@truefoundry/trueforge`.

### Phase P2: UI

1. `IntegrationServer` port in `assistant-ui-runtime`, the adapter, and the `ServerContext` hook.
2. The Integrations tab and the moved page.
3. Settings section removed.
4. Tests: the moved `IntegrationSettings` and `integrationForm` tests, the tab visibility, and the share-URL guard.
5. Changesets for `@truefoundry/assistant-ui-runtime`, `@truefoundry/trueforge-ui` and `@truefoundry/trueforge` (the frontend ships inside it).

P1 and P2 land together in one release. P1 alone would leave the Settings section calling deleted routes.

### Phase P3: docs and live test

1. Update `docs/integrations-slack-plan.md` Sections 2.1, 2.3, 2.4, 2.5, 3 and 6 to match, and drop its stale `pnpm patch` notes: `assistant-ui-runtime` is now a workspace package and there is no patch.
2. Live test on the Workers deploy:
   - upgrade with one existing integration and confirm it shows on its agent's tab and still answers in Slack,
   - connect a second agent to the same workspace and confirm each bot answers for its own agent,
   - delete an agent and confirm its bot stops answering.

## 4. Risks and open questions

- **Upgrade blocked by an orphan.** Intended, but it stops a deploy until an admin acts. The release notes must lead with the check query and the two fixes (recreate the agent or delete the integration).
- **Wider set of people holding Slack credentials.** Agent managers can now paste bot tokens and see redacted credentials. Nothing is shown unredacted, same as before.
- **Workspace admins may see several TrueForge apps.** Each agent's bot is a separate Slack app to install and approve. That is the cost of per-agent bot identities.
- **No tenant-wide view.** Admins lose the single list of every Slack connection in Settings. Resolved: an admin still sees every integration through `GET /api/v1/integrations`, because the list skips the creator/manager filter for admins, and may open, update, delete, and fetch the app manifest and decisions of any integration.
