# Cloudflare Workers port plan

Engineering plan, not user documentation. Intentionally left out of `docs.json` navigation.

Goal: run the TrueForge server natively on Cloudflare Workers with D1 as the database, Durable Objects for turn-event fan-out and cross-request coordination, and code execution (sandbox) disabled. Optimize for the least rewrite and zero duplicated store logic. The Node paths (standalone SQLite, distributed Postgres + Redis) stay working throughout.

Status: in progress on branch `feat/cloudflare-workers-port`. Phase 0 done; Phase 1a (logger type, guidance leaf) committed; Phase 1b (sandbox and TLS seams, agent import port) in review fixes; Phase 2a (AtomicRunner and conditional-chain writes) implemented on a worktree branch and in adversarial review.

## 1. What the surveys found

The runtime is closer to portable than the dependency list suggests.

Already portable:

- The HTTP layer is Hono (`packages/trueforge/src/app.ts`). `createServerApp` takes every dependency by injection and never touches Node APIs itself.
- LLM calls go through the Vercel AI SDK with global `fetch` (`packages/trueforge-core/src/core/llm/VercelAILLM.ts`). No `@anthropic-ai/sdk`, no `openai` client at runtime.
- Remote MCP uses `StreamableHTTPClientTransport` and `SSEClientTransport` from `@modelcontextprotocol/sdk` over global `fetch`. Nothing spawns stdio MCP servers.
- OIDC auth uses `openid-client` v6 and `jose`, both fetch and WebCrypto based. `packages/trueforge/src/auth/*` has no Node imports.
- The turn loop is async generators end to end (`TurnHandle.stream()`, `AgentThread`, `AgentThreadOrchestrator`). No `EventEmitter`, no `setInterval` on the hot path.
- Hot-path Node surface of `trueforge-core` is `node:path/posix` plus the `Buffer` global. Both exist under `nodejs_compat`.
- The SQLite store implementations under `packages/trueforge/src/db/sqlite/**` are written in SQLite dialect with JS-computed timestamps (`nowIso()`), JSONB columns, and `RETURNING`. D1 is SQLite, so these are the stores D1 reuses.
- Sandboxing has a single injection seam: omit `sandboxProvider` from `TurnResourceResolver` deps (`packages/trueforge-core/src/agent-session/TurnResourceResolver.ts:78-79,124`) and no sandbox code runs. `config.sandbox.enabled` already defaults to `false`.
- `process.env` is populated from Worker vars and secrets under `nodejs_compat` for compatibility dates on or after 2025-04-01, so `config.ts`'s `getEnv` works unchanged.

Not portable, must change:

| Area               | Node-only piece                                                                                                                                                                                                                  | Files                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB driver          | `better-sqlite3` sync API, pragmas, `BEGIN IMMEDIATE`, Kysely `db.transaction()`                                                                                                                                                 | `db/sqlite/client.ts`, 9 sites in `db/sqlite/session-store/queries/*.ts`, every `withTransaction` caller                                           |
| Migrations         | `node:fs`, `FileMigrationProvider`, dynamic `import()`, migrations open their own transactions and toggle `PRAGMA foreign_keys`                                                                                                  | `db/migrateSqlite.ts`, `db/sqlite/migrations/*.ts`, `util/crossPlatform.ts`                                                                        |
| Coordination       | Redis Streams for turn events, Redis pub/sub request-reply for cross-replica cancel, in-process `ActiveTurnRegistry`                                                                                                             | `runtime/event-subscription/redis.ts`, `runtime/redis.ts`, `trueforge-core/src/request-reply/*`, `runtime/activeTurns.ts`, `runtime/peeringIds.ts` |
| Detached execution | `stream:false` turns and schedule runs keep running after the response returns                                                                                                                                                   | `apis/turns.ts:458-480`, `apis/schedules.ts:188-220`                                                                                               |
| Scheduler          | `setInterval` control loop plus HTTP loopback to `/api/internal/schedules/runs/execute`                                                                                                                                          | `controller/*`, `controller.ts`, `controller-main.ts`                                                                                              |
| Static UI          | `@hono/node-server/serve-static`, `readFileSync` of `index.html`                                                                                                                                                                 | `frontend.ts`                                                                                                                                      |
| Config             | `existsSync`, `fileURLToPath`, `os.tmpdir()`, `env-paths` evaluated at module load; `STANDALONE` couples DB choice to auth availability                                                                                          | `config.ts:14-30,216-222,259-261,677-678`                                                                                                          |
| Import reach       | `app.ts` statically reaches `undici` and `node:https` (`http/tls.ts`), `@anthropic-ai/sandbox-runtime` and `child_process` (`runtime/sessionResources.ts` → `LocalSandboxProvider`), `@daytona/sdk` (`sandbox/providerUtils.ts`) | `app.ts`, `apis/turns.ts`, `runtime/sessionResources.ts`, `controller/scheduleDispatch.ts`                                                         |
| Logger             | `winston` value import in one file, `import type { Logger } from 'winston'` in 42 files                                                                                                                                          | `logger.ts`, 26 files in `trueforge/src`, 17 in `trueforge-core/src`                                                                               |
| Core barrel        | `@truefoundry/trueforge-core/core` value-exports `DaytonaSandboxProvider`, `TFYSandboxProvider`, `SkillMounter` and drags in `@daytona/sdk`, `@nats-io/nats-core`, `ws`                                                          | `trueforge-core/src/core/index.ts:140-175`, `core/capabilities/builtins/LargeToolResponse.ts:6`                                                    |

## 2. Platform facts this plan relies on

Verified against Cloudflare docs and a local `wrangler d1 execute --local` probe on 2026-09-15.

- D1 has no interactive transactions. `BEGIN` is rejected. `batch()` runs a list of prepared statements as one transaction and rolls back the whole list only if a statement errors. A statement that matches zero rows is a success with `changes: 0`, and the rest of the batch still commits. Probed locally: `batch([UPDATE s ... WHERE tip='zzz', INSERT INTO t ...])` left the row in `t`.
- Confirmed through the D1 binding in a local Worker (Phase 0): plain guard `batch([UPDATE ... WHERE tip='zzz', INSERT ...])` returns changes `[0, 1]` and the insert persists; the `INSERT ... SELECT ... WHERE EXISTS` chain returns `[0, 0, 0]` with nothing written when the precondition is false and `[1, 1, 1]` when true; a failing statement rolls back the whole batch. `--remote` is unverified (no account login during Phase 0).
- Local D1 accepts `STRICT` tables, `jsonb()`, `jsonb_set()`, `json()`, `json_extract()`, `->>`. `sqlite_version()` is blocked, so the exact version is unknown; the functions the stores use all work.
- Wrangler bundles have `import.meta.url` undefined, and workerd's `node:fs` is a virtual filesystem without package files. Any module-load call to `fileURLToPath(import.meta.url)`, `createRequire(import.meta.url)`, or `readFileSync` of a repo file crashes the Worker at startup, and `wrangler deploy --dry-run` does not catch it.
- Wrangler has no config key for build conditions; it reads `WRANGLER_BUILD_CONDITIONS`. Workspace packages resolve from source with `WRANGLER_BUILD_CONDITIONS=trueforge-dev,workerd,worker,browser`.
- D1 Sessions API (`withSession('first-primary')`) gives sequential consistency across statements in a session. It does not give a snapshot.
- Workers HTTP requests have no wall-time limit while the client stays connected. `waitUntil` extends at most 30 seconds after the response. CPU limit is 30 seconds by default, configurable to 5 minutes.
- Durable Objects stay active while a request, RPC call, response stream, WebSocket, or pending I/O is in flight. An outbound `fetch` keeps a DO alive up to 15 minutes per connection. A DO with `setTimeout`/`setInterval` armed cannot hibernate. Alarm handlers have a 15-minute wall-time limit.
- Cron Trigger invocations have a 15-minute wall-time limit and no non-overlap guarantee.
- Worker bundle limit is 64 MiB uncompressed; global scope must finish within 1 second.
- Static assets: `assets.directory`, `not_found_handling: "single-page-application"`, `run_worker_first: [...]` are supported.
- `nodejs_compat` provides `node:crypto`, `node:path`, `Buffer`, `node:tls` (partial). Do not rely on `node:fs`, `node:child_process`, `node:https` or `undici`.

## 3. Target architecture

One Worker script, three roles:

1. `fetch` handler: the existing Hono app from `createServerApp`, with D1-backed stores, plus static assets for the UI. Turn routes are thin: they authenticate and authorize in the Worker, then delegate to the session's Durable Object.
2. `SessionDO` (one per `tenant_id:session_id`): runs turns, owns the per-turn event log, serves subscribe streams, handles cancel. This replaces Redis Streams, the request-reply executor, `EXECUTOR_ID`, `peeringIds`, and the cross-replica half of `ActiveTurnRegistry`.
3. `SchedulerDO` (singleton): a 60-second alarm that runs `dispatchScheduledRuns` and hands each run to the right `SessionDO`. This preserves the "exactly one controller per database" invariant the dispatch code relies on (`controller/scheduleDispatch.ts:262-264`). Cron Triggers do not guarantee non-overlap, so they are not used.

Persistence is D1 for every store. `SessionDO` storage holds only the transient event log for in-flight turns; the durable record stays in D1 through the unchanged `ISessionStore` writes.

Decisions made here, not open for re-litigation in implementation:

- Turns always execute inside `SessionDO`, regardless of `stream`. Splitting by mode would keep two execution paths alive.
- Phase 1 turns are not durable across DO eviction or deploy. An alarm watchdog freezes orphaned turns using the existing first-terminal-write-wins path (`apis/sessions.ts:182-203`). Durable resume is out of scope.
- Sandbox is off. `GET /capabilities` reports `sandbox.enabled: false` and `skill.enabled: false` (skill carries a reason; the sandbox schema has no reason field) so the UI hides those features. User-visible deltas: no `exec` tool, no skills, no Code Mode, non-inline file uploads fail with `AgentSandboxRequiredError`, sandbox-enabled turns and agent specs get the existing 422 "no sandbox provider configured", sandbox-provider settings return 404 on GET and 422 on PUT, and turn file download keeps its existing 412. No route, schema, or OpenAPI change.
- Standalone auth (everyone is admin) is not allowed on this target. OIDC is required; Cloudflare Access in front is recommended additionally.
- The Worker entry lives inside `packages/trueforge` (`src/workers/`) rather than a new workspace package. `packages/trueforge` is not built as a library, the Worker imports `app.ts`, `apis/*`, and `db/*` directly, and a new package would need CI filter, matrix id, and root `test:*` sync per `AGENTS.md`. Node-only modules are kept out of the Worker bundle by an ESLint `no-restricted-imports` rule scoped to `src/workers/**`; `pnpm workers:check` (`wrangler deploy --dry-run`) is run locally per phase until the CI backlog (Section 8) is picked up.

## 4. D1 transaction strategy

This is the crux. Every site below is enumerated; do not hand-wave it during implementation.

### 4.1 Two transaction shapes exist today

- Route-owned: `WithTransaction<TTransaction>` (`db/transaction.ts`) opens `db.transaction().execute(cb)` and passes the handle into route code; `IScheduleStore`, `IAgentStore`, `IMcpServerStore`, `IModelProviderStore`, `ISandboxProviderStore`, `ISkillStore`, `IOAuthTokenStore` take `transaction?: TTransaction` on every method.
- Store-owned: `ISessionStore` takes no transaction parameter; the SQLite implementation opens `db.transaction()` internally at 9 sites.

### 4.2 D1 rules

- `TTransaction` for D1 is a `Kysely<SqliteDatabase>` bound to `env.DB.withSession('first-primary')`. `withTransaction` on D1 creates the session, runs the callback against it, and returns. No atomicity, sequential read consistency only.
- Multi-statement writes that must be atomic go through one `batch()` call. A helper `batchWrite(db, queries)` compiles Kysely queries with `.compile()`, binds them with `env.DB.prepare(sql).bind(...params)`, and calls `env.DB.batch()`.
- A guard is only real if every later statement is conditional on it. Rule: the first statement of a batch is the guarded write, expressed as `INSERT ... SELECT ... FROM <parent> WHERE <precondition>` or `UPDATE ... WHERE <precondition>`; every following statement is `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM <row written by statement 1>)`. With that chain, `meta.changes` on the first statement is decisive: zero means nothing was written, and the caller throws the existing domain error. A plain `WHERE` guard followed by unconditional inserts is a bug on D1 (see Section 2).
- A batch cannot feed one statement's `RETURNING` into the next. Ids that later statements need are either minted in JS before the batch (ULIDs) or derived inside a later statement with `INSERT ... SELECT` over rows an earlier statement wrote (for example `ROW_NUMBER() OVER (ORDER BY append_id)`). Do not precompute `AUTOINCREMENT` values in JS; concurrent writers would collide.
- Reads before a batch use the same session. Validation happens in JS between the reads and the batch.
- The `packages/trueforge/AGENTS.md` rule "no remote I/O inside `withTransaction`" stays. On D1 there is no rollback, so violating it is now silently wrong instead of loudly wrong.

### 4.3 Site-by-site treatment

`ISessionStore` (SQLite implementation, reused by D1):

| Site                                                                              | Treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createTurn` (`session-store/queries/turns.ts:346`)                               | Contract (unchanged): concurrent forks from a finished tip both succeed with isolated context (`storeContractSuite.ts` "concurrent createTurn forking the same tip"); only a running previous turn is rejected. Pre-read and validate in JS as today. One batch: statement 1 `INSERT INTO turn ... SELECT ...` guarded on the same previous-turn-not-running precondition the pre-read checks; every later statement (session tip and metrics update, threads, capability state, context) is chained on `EXISTS (SELECT 1 FROM turn WHERE id=?new_turn_id)`. `append_id` stays `AUTOINCREMENT`; `turn_thread_context` is filled with `INSERT ... SELECT ... ROW_NUMBER() OVER (ORDER BY append_id)` from the new turn's own rows, so concurrent forks never collide on precomputed ids (window functions verified on local D1). Zero changes on statement 1 maps to the error the pre-read would have thrown. The same SQL runs unchanged on better-sqlite3. |
| `freezeAndGetTurn` (`turns.ts:688`)                                               | Implemented (Phase 2a) with the event first: read; if running, one batch: statement 1 `INSERT INTO session_event ... SELECT ... FROM turn WHERE id=? AND running` with an event id minted per call, then the session metrics fold and the state flip, both guarded on `running AND EXISTS (event_id)`; then `getTurn`. Zero changes means another terminal write won and the read returns the winner. `updateTurnState` uses the same three statements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `getTurn` (`turns.ts:740`)                                                        | Per-statement reads inside one D1 session. Snapshot isolation is dropped; sequential consistency is enough because turns are append-only after creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `turns.ts:348,798`, `threads.ts:32,180,249`, `events.ts:37`, `capabilities.ts:16` | Implemented (Phase 2a): `addThreads`, `appendToThreadContext`, `overwriteThreadContext` are batches whose statement 1 is guarded on the turn still running and whose later statements repeat that guard (plus `EXISTS` on the row statement 1 wrote); `removeThreads` is three guarded DELETEs; `appendToEvents` and `patchThreadCapabilityState` are single guarded statements. Zero changes is classified with a follow-up read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Route-owned `withTransaction` callers:

| Site                                                                                                                         | Treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqliteScheduleStore.updateScheduleAndRun` and `#syncPendingRun` (`SqliteScheduleStore.ts:184-270`)                          | Read `previous` in the session; statement 1 `UPDATE schedule SET ..., updated_at=?now WHERE id=? AND updated_at=?previous.updated_at`; statement 2 `DELETE FROM schedule_run WHERE schedule_id=? AND status='scheduled' AND EXISTS (SELECT 1 FROM schedule WHERE id=? AND updated_at=?now)`; statement 3 `INSERT INTO schedule_run ... SELECT ... FROM schedule WHERE id=? AND updated_at=?now`. `schedule_run_pending_uq` still rejects a duplicate pending row. Zero changes on statement 1 throws a new `ScheduleConcurrentUpdateError` mapped to 409. |
| `finishScheduledRun` (`controller/scheduleDispatch.ts:172-228`)                                                              | Implemented (Phase 2a) as a new `IScheduleStore.finishRun`: the controller computes the next trigger, the SQLite store batches the run status update and the next pending run, both guarded on `schedule.updated_at` as read. `ScheduleConcurrentUpdateError` makes the controller retry the whole finish up to 3 times. Postgres keeps `FOR UPDATE` and never throws it.                                                                                                                                                                                 |
| `getScheduleForUpdate`                                                                                                       | Keep the SQLite no-op alias. Locking is replaced by the `updated_at` guard above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apis/mcpServers.ts:228,273` (server + token)                                                                                | Implemented (Phase 2a): `createServer` takes `oauth_client` and writes it in the same INSERT; `upsertServer` takes `oauth_client` and `reset_authorizations`, and the token and pending-authorization deletes are chained on the server row's new `updated_at`. The routes no longer use `tokenStore` for these writes.                                                                                                                                                                                                                                   |
| `apis/modelProviders.ts:110`                                                                                                 | Read then a single upsert, so no batch. Open on D1: the read-then-write of the stored secret can lose a concurrent rotate; needs an `updated_at` guard and 409 (same gap in the MCP PUT path).                                                                                                                                                                                                                                                                                                                                                            |
| `apis/agents.ts`, `apis/skills.ts`, `apis/settings.ts`, `apis/sandboxProviders.ts`, `apis/models.ts`, `apis/capabilities.ts` | Audit each callback. Single-write callbacks need nothing. Multi-write callbacks get `batchWrite`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 4.4 Atomicity helper for the shared SQLite stores

Introduce `db/sqlite/atomic.ts`:

```ts
export interface AtomicRunner<DB> {
  // Read grouping only. better-sqlite3: a deferred read transaction (one snapshot).
  // D1: pass-through on the same session; no snapshot, no atomicity.
  readGroup<T>(cb: (db: Kysely<DB>) => Promise<T>): Promise<T>;
  // All-or-nothing writes. better-sqlite3: one BEGIN IMMEDIATE transaction running the
  // statements in order. D1: env.DB.batch(). Returns per-statement change counts.
  batchWrite(queries: readonly CompiledQuery[]): Promise<readonly { changes: number }[]>;
}
```

The SQLite stores receive an `AtomicRunner` in their constructor instead of calling `db.transaction()` directly. The 9 session-store sites and the schedule store are rewritten once, against this interface and the conditional-chain rule from 4.2, and both backends get the same SQL. `readGroup` is used only by `getTurn`. There is no interactive write transaction in the shared stores after this phase; anything that needs one is a design error.

## 5. Phases

Each phase ends with a verification line. The Node paths must stay green at every phase boundary.

### Phase 0: gates

Results (2026-09-15, spike in a scratch directory against commit `cf6ecdd3` content):

- Gate 1 passed: `process.env.FOO` and `env.FOO` both returned the `vars` value under `wrangler dev --local`.
- Gate 2 passed locally through the D1 binding (see Section 2). `--remote` not run; it stays an open gate before Phase 2b ships to a real account.
- Gate 3 passed only with scratch stubs. Unstubbed, workspace packages fail to resolve without `WRANGLER_BUILD_CONDITIONS`, and the gitignored `sandboxScripts.gen.ts` is missing. With stubs the bundle is 9.3 MiB uncompressed and startup is 130 ms locally (`wrangler check startup`). Load-time crashes found in order: `fileURLToPath(import.meta.url)` in `config.ts`, `createRequire(import.meta.url).resolve` in `sandbox/local/core/hostRun.ts`, `readFileSync` of `package.json` in `packageVersion.ts`. About 2.9 MB of the bundle is sandbox-only code (Daytona, NATS, sandbox-runtime), 1.1 MB is `undici`, and 0.25 MB is `pg`. `eventsource` (MCP SSE) and `@opentelemetry/*` resolve to browser builds and load fine.
- New Phase 1 work found by gate 3 is folded into the Phase 1 bullets below (`packageVersion.ts`, `apis/agentImport.ts`, `apis/capabilities.ts` and `apis/sandboxProviders.ts`, the schedule executor module split, the core barrel).

1. `process.env` on Workers: set `compatibility_date` to `2026-09-01` or later; `nodejs_compat_populate_process_env` is on by default. Verify with a stub Worker logging `process.env.FOO` from `vars`.
2. D1 SQLite features: a scratch `wrangler.jsonc` with a D1 binding; run `create table t(a blob) strict; insert into t values (jsonb('{"x":1}')); update t set a=jsonb_set(a,'$.y',jsonb('2')); select json(a), a->>'x' from t` with `--local`. If any step fails on `--remote`, the fallback is `json()` text through `jsonbBind`/`jsonText` in `db/sqlite/sqlExpressions.ts` plus `BLOB` to `TEXT` in the squashed schema. Both `--local` and `--remote` must pass before Phase 2.
3. Bundle spike: a stub `src/workers/index.ts` importing `createServerApp`, then `wrangler deploy --dry-run --outdir /tmp/tf-bundle`. Record bundle size and every unresolved or Node-only module. Expected offenders are exactly those listed in Section 1; anything else is new information and gets added to Phase 1.

Verify: three commands run, outputs pasted in the PR.

### Phase 1: seams, logger, config (Node paths unchanged)

Goal: `createServerApp` and the turn API become importable without Node-only modules, without changing behavior on Node.

Files and changes:

- `packages/trueforge-core/src/core/util/logger.ts` (new): `export interface Logger { debug, info, warn, error, child }`, log methods typed `(message: string, meta?: unknown) => void` (`meta` is `unknown` because call sites pass `ErrorLogFields`, an interface without an index signature) and `child(bindings: Record<string, unknown>): Logger`. Replace every `import type { Logger } from 'winston'` in core and trueforge (src and tests) with this type; `CodeModeLogger` is folded into it. Winston's `Logger` satisfies it structurally. Move `winston` from `dependencies` to `devDependencies` in `trueforge-core/package.json` (core tests still import it; only `logger.ts` in `packages/trueforge` imports it as a value).
- `packages/trueforge-core/src/core/sandbox/largeToolResponseGuidance.ts` (new leaf): move `createSandboxLargeToolResponseGuidance`, `SANDBOX_SCHEMA_INFER_TAG`, and `SANDBOX_MCP_REMINDER_TAG` out of `Sandbox.ts`. Update `LargeToolResponse.ts:6`. After this the hot path no longer imports `sandbox/Sandbox.ts`.
- Status: done (logger type and guidance leaf).
- Sandbox integration port (Phase 1b): `runtime/sessionResources.ts`, `apis/turns.ts`, `apis/capabilities.ts`, and `apis/sandboxProviders.ts` stop importing `LocalSandboxProvider`, `localRuntime`, and `providerUtils`. One injected `SandboxIntegration` port on `ServerDeps` covers provider resolution, snapshot status, local-fallback availability, and provider-settings validation. `main.ts` builds the Node implementation exactly as today. The Workers entry passes `undefined`, which disables sandbox and skills.
- `packages/trueforge/src/app.ts`: `createClientCertificateMiddleware` is injected as an optional `ServerDeps.clientCertificateMiddleware`; `main.ts` supplies it when mTLS is on. `app.ts` no longer imports `http/tls.ts`.
- `packages/trueforge/src/controller/scheduleDispatch.ts`: `apis/schedules.ts` imports this module, so it must not import `http/tls.ts`. `createHttpScheduleRunExecutor({ baseUrl, fetch })` takes its transport as input and `scheduleDispatchLoop` takes `executeRun`; `controller.ts` builds both with `normalizeTlsUrl` and `createTlsFetch`.
- `packages/trueforge/src/apis/agentImport.ts`: value-imports `PostgresSessionStore` (reaches `pg`) and reaches `truefoundry/TrueFoundryServiceFoundryServerClient.ts` (`undici`) and `truefoundry/internalTls.ts`. Inject the session importer through `ServerDeps`, move `SessionImportValidationError` to an engine-neutral module, and leave the route unavailable when the port is absent. Implemented as `SessionImport` in `db/sessionImport.ts` (implemented by `PostgresSessionStore`, `undefined` in standalone and on Workers; the routes keep their existing 500 "requires Postgres" response), with the assume-user header helpers moved to the import-free `truefoundry/assumeUserHeaders.ts`.
- `packages/trueforge/src/packageVersion.ts` (Phase 1c): reads `package.json` with `readFileSync` at module load and crashes workerd. Replace with a build-time constant or inject the version through `ServerDeps`. No module-load reads of repo files anywhere on the `app.ts` graph.
- Core barrel (Phase 1d): `app.ts` and 18 other files reached from it import `@truefoundry/trueforge-core/core`, whose value exports pull in `@daytona/sdk`, `@nats-io/nats-core`, and `ws` (about 2.3 MB that tree-shaking keeps). Convert those importers to deep imports. Do not move the barrel exports to a new subpath; that is a breaking change for published consumers. Extend the ESLint barrel ban from `src/workers/**` to all of `packages/trueforge/src`.
- `packages/trueforge/src/config.ts`:
  - Add a third discriminated member `WorkersServerConfiguration` with `RUNTIME: 'workers'` (env `TRUEFORGE_RUNTIME=workers`), OIDC keys allowed, no `SQLITE_PATH`, `DATABASE_URL`, `REDIS_URL`, `EXECUTOR_ID`, `SERVER_URL`, mTLS, or TrueFoundry keys. `STANDALONE` is `false` in this member so existing `!STANDALONE` guards keep meaning "auth may be configured".
  - `isOidcConfigured`, `isTrueFoundryModeEnabled`, `getTrueForgeAuthMode` updated for the third member. TrueFoundry mode is rejected when `RUNTIME='workers'`.
  - Narrowing fallout: every `!configuration.STANDALONE` narrowing (13 sites in `apis/`, `runtime/`, `auth/`, plus `main.ts`, `app.ts`, `controller-main.ts`) now yields `Distributed | Workers`, so any read of `REDIS_URL`, `DATABASE_URL`, `EXECUTOR_ID`, `SERVER_URL`, or the mTLS keys fails typecheck. Switch those sites to `configuration.RUNTIME === 'distributed'`. This is the bulk of the config work; budget it.
  - `app.ts:227` calls `createApiKeyAuthMiddleware(configuration.TRUEFORGE_API_KEY)` unconditionally and mounts `/api/internal/schedules`. Both become conditional on `RUNTIME !== 'workers'`; the Workers member has no `TRUEFORGE_API_KEY`.
  - Module-load filesystem work (`resolveDefaultFrontendDir`, `PACKAGE_ROOT`, `CODE_MODE_SOCKET_PARENT`, `appDataDir`) moves behind lazy getters or into `config.node.ts`, imported only by `main.ts`, `cli.ts`, `controller-main.ts`. `fileURLToPath(import.meta.url)` is the one that actually crashes on Workers and must not run on the Workers path at all; `existsSync`, `env-paths`, and `os.tmpdir()` did not throw in the spike, so moving them is cleanup.
- `packages/trueforge/src/apis/capabilities.ts`: with no `SandboxIntegration`, report `sandbox.enabled: false` and `skill: { enabled: false, reason }`.
- ESLint: `@typescript-eslint/no-restricted-imports` for `src/workers/**` banning `node:fs`, `node:child_process`, `node:https`, `node:net`, `node:tls`, `node:os` and their bare names (`fs`, `os`, ...; `paths` entries are exact strings), `undici`, `better-sqlite3`, `pg`, `redis`, `@hono/node-server`, `@anthropic-ai/sandbox-runtime`, `@daytona/sdk`, `@nats-io/nats-core`, `ws`, `winston`, `env-paths`, repo paths under `db/postgres/**`, `truefoundry/**`, `sandbox/local/**`, `sandbox/providerUtils`, `sandbox/nodeSandboxIntegration`, `http/tls`, `db/sqlite/client`, and the Node migrators, plus value imports of the `@truefoundry/trueforge-core` and `@truefoundry/trueforge-core/core` barrels (`allowTypeImports: true` on the barrels only; the base rule cannot allow type imports). `kysely` and `db/sqlite/**` stores are allowed. The rule checks direct imports only; `workers:check` (bundle, `wrangler dev`, `wrangler check startup`) is the real gate.

Verify: `pnpm typecheck && pnpm test && pnpm smoke` pass. A stub Workers entry importing `createServerApp` bundles with `WRANGLER_BUILD_CONDITIONS=trueforge-dev,workerd,worker,browser wrangler deploy --dry-run` with none of the banned modules, and also passes `wrangler dev` plus `curl /healthz` returning 200 and `wrangler check startup`. A clean dry-run alone is not enough; all three spike crashes passed it.

### Phase 2: D1 dialect, atomicity helper, migrations, contract suite

Files and changes:

- `packages/trueforge/src/db/d1/client.ts` (new): `createD1Db(session: D1DatabaseSession)` returning `Kysely<SqliteDatabase>` over `kysely-d1` (`D1Dialect`). `D1Dialect` is typed against `D1Database`; `D1DatabaseSession` has `prepare` and `batch` but not `exec` or `dump`. If the types do not line up, write a 40-line dialect over `prepare().bind().all()` in this file rather than adding an assertion. Same `ParseJSONResultsPlugin` allowlist as `db/sqlite/client.ts` (move `JSON_RESULT_COLUMNS` and `shouldParseJsonResultColumn` to `db/sqlite/jsonColumns.ts` so both clients import one owner). `isUniqueViolation` gains a D1 branch matching `/UNIQUE constraint failed/` in `error.message`; the better-sqlite3 code check stays.
- `packages/trueforge/src/db/d1/atomic.ts` (new): `D1AtomicRunner` implementing `AtomicRunner` from Section 4.4 over `env.DB.batch()`.
- `packages/trueforge/src/db/sqlite/atomic.ts` (new): `BetterSqliteAtomicRunner`.
- `packages/trueforge/src/db/sqlite/session-store/**`, `SqliteScheduleStore.ts`, and the route callbacks in Section 4.3: rewritten against `AtomicRunner` and `batchWrite` exactly as specified there. No store file is copied; `db/sqlite/**` is the single owner of SQLite-dialect stores.
- `packages/trueforge/src/db/sqlite/types.ts` header comment updated: "used by better-sqlite3 and D1".
- Migrations: `packages/trueforge/migrations/d1/0001_init.sql` (new), generated once by running the 30 Kysely SQLite migrations to latest against a scratch better-sqlite3 file and dumping `.schema` (drop the `kysely_migration*` tables). Add a script `scripts/dump-sqlite-schema.mjs` and a root script `d1:schema:dump` so regeneration is repeatable. Apply with `wrangler d1 migrations apply`. D1 does not use the Kysely `Migrator`.
- `packages/trueforge/src/db/sqlite/AGENTS.md` gains: "Every new `migrations/*.ts` MUST ship a paired `packages/trueforge/migrations/d1/NNNN_<name>.sql` with the equivalent DDL; D1 has no transactional migrations, so multi-statement rebuilds use `PRAGMA defer_foreign_keys = true`."
- Tests: `packages/trueforge/tests/db/d1/` runs `storeContractSuite.ts` and the schedule/agent/mcp store tests against D1 under `@cloudflare/vitest-pool-workers` with `applyD1Migrations`. The suite uses `describe`/`it`/`expect` globals (no `@jest/globals` import), so it is drop-in under vitest globals. Add root script `test:store:d1`. Jest keeps the better-sqlite3 and Postgres runs; the Workers tests use vitest because the pool only supports vitest. The `test:store:d1` script exists from this phase; wiring it into CI is backlog (Section 8).

Verify: `pnpm test:store:sqlite`, `pnpm test:store:postgres`, and `pnpm test:store:d1` all pass the same contract suite. Contract tests on every backend: concurrent `createTurn` from the same finished tip both succeed with isolated context and no orphan thread, context, or capability rows; `createTurn` while the previous turn is running throws `PreviousTurnRunningError` and writes nothing for the rejected turn. `pnpm smoke` still passes.

### Phase 3: `SessionDO`, event stream, cancel

Files and changes:

- `packages/trueforge/src/workers/env.ts` (new): the `Env` interface (`DB: D1Database`, `SESSION_DO: DurableObjectNamespace<SessionDO>`, `SCHEDULER_DO`, `ASSETS: Fetcher`, plus the config vars).
- `packages/trueforge/src/workers/runtime.ts` (new): `createWorkersPersistence(env)` builds the same `ServerPersistence` shape as `createStandalonePersistence` in `main.ts` but from D1 stores, with `redis: undefined`, `serviceFoundryClient: undefined`, and the empty sandbox factory. `main.ts`'s `createServerRuntime` is extracted to `runtime/createServerRuntime.ts` so the Worker and the Node entry share it; `main.ts` keeps only Node wiring.
- `packages/trueforge/src/runtime/turnRunner.ts` (new): `beginTurnExecution` and `drainTurnEvents` move here from `apis/turns.ts` unchanged, so the DO can call them without importing the HTTP handlers.
- `packages/trueforge/src/runtime/event-subscription/durableObject.ts` (new): `DurableObjectEventSubscription` implementing the existing `EventSubscription<T>` interface (`put`, `assertSubscribable`, `poll`). `put` inserts into the DO's SQLite (`turn_events(stream_id, seq, data, expires_at)`); `poll` reads rows after the cursor and waits on an in-memory notifier, so subscribers get sub-second latency instead of the 1-second Redis poll. TTLs follow the same absolute rule as `redis.ts` (`TURN_STREAM_TTL_SECONDS`, rewritten on `turn.done`).
- `packages/trueforge/src/workers/SessionDO.ts` (new):
  - `startTurn(input)` RPC: builds a `TurnResourceResolver` from `createWorkersPersistence(env)`, calls `beginTurnExecution`, starts `drainTurnEvents` as a detached promise, resolves after the first `put` (same "immediate subscribe cannot 412" guarantee as `startTurnInProcess`).
  - `subscribe(turnId, afterSeq, signal)`: returns a `ReadableStream` of SSE frames from `DurableObjectEventSubscription.poll`. The Worker's `GET .../subscribe` and `POST .../turns` with `stream:true` proxy this stream to the client; the DO stays active while the response stream is in flight.
  - `cancel(turnId, reason)`: aborts the local `AbortController` via `ActiveTurnRegistry.cancelIfRunning`. Returns 412-equivalent when not running here, and the Worker then freezes the turn exactly as `cancelSessionTurn` does today.
  - Keepalive: while any turn is running, a `setInterval` of 20 seconds is armed (blocks hibernation) and `ctx.storage.setAlarm(now + 60s)` is refreshed.
  - `alarm()`: watchdog. For every turn this DO started that D1 still reports as `running` and that has no in-memory task, call `session.freezeTurn(...)` with `CancellationReason.Abandoned`. Re-arm the alarm only while turns are running.
  - `SERVER_EXECUTION_TIMEOUT_SECONDS` keeps its meaning (the abort timer lives in `beginTurnExecution`).
- `packages/trueforge/src/apis/turns.ts` and `apis/sessions.ts`: behind an injected `TurnExecutor` port (`start`, `subscribe`, `cancel`). The Node implementation wraps today's in-process code plus Redis request-reply; the Workers implementation calls the `SessionDO` stub. `ServerDeps.redis`, `requestReplyRouter`, and `eventSubscriptions` fold into this port. `EXECUTOR_ID` and `mintPeeredTurnId` stay Node-only.
  - Errors do not keep their class across a DO RPC boundary, and `getTurnExecutionError` (`apis/turns.ts:492-516`) maps by `instanceof`. The port therefore returns a discriminated result, `{ ok: true, ... } | { ok: false, status: number, code: string, message: string }`, and never throws domain errors. The Node implementation converts the same `instanceof` chain into that shape, so the HTTP mapping lives in one place.
- `wrangler.jsonc` migration: `new_sqlite_classes: ["SessionDO"]`.

Verify: with `wrangler dev`, `POST /api/v1/sessions/{id}/turns` streams a full turn; `stream:false` returns `running` and `GET .../subscribe` replays from `Last-Event-ID`; `POST .../cancel` aborts a running turn; killing the DO mid-turn (`wrangler dev` restart) leaves the turn frozen after the next alarm.

### Phase 4: `SchedulerDO`

Files and changes:

- `packages/trueforge/src/workers/SchedulerDO.ts` (new): constructor arms `setAlarm(now)`; `alarm()` calls `dispatchScheduledRuns` from `controller/scheduleDispatch.ts` with `onTriggered` implemented as `env.SESSION_DO.get(idFor(run)).startTurn(...)` (direct RPC, no HTTP loopback, no `TRUEFORGE_API_KEY`), then re-arms `setAlarm(now + SCHEDULE_DISPATCH_INTERVAL_MS)`.
- `controller/scheduleDispatch.ts`: `onTriggered` already exists as a callback; `createHttpScheduleRunExecutor` becomes one of two implementations. `startScheduleRunOnRequest` in `apis/schedules.ts` is reused by the DO path through the `TurnExecutor` port.
- Bootstrap: a Cron Trigger `*/5 * * * *` whose `scheduled()` handler only calls `env.SCHEDULER_DO.get(idFromName('singleton')).ensureAlarm()`. It is idempotent and cheap, and it means dispatch resumes after a deploy without waiting for user traffic. Worker `fetch` does not touch the scheduler.
- `/api/internal/schedules` stays mounted for the Node topology; on Workers it is not needed and is not mounted.

Verify: create a schedule with a 1-minute cron in `wrangler dev`; a run row flips to `completed` and a session with `external_id = run.id` exists within two minutes; pausing the schedule stops new pending rows.

### Phase 5: static assets and wrangler config

Files and changes:

- `packages/frontend`: build-time replacement of `%%TRUEFORGE_BASE_PATH%%` with `/` for the Workers build (Vite `define` or a post-build step). `frontend.ts` is not used on Workers.
- `packages/trueforge/wrangler.jsonc` (new): `main: "src/workers/index.ts"`, `compatibility_date: "2026-09-01"`, `compatibility_flags: ["nodejs_compat"]`, `assets: { directory: "../frontend/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/healthz"] }`, `d1_databases` with `migrations_dir: "migrations/d1"`, `durable_objects.bindings` for `SessionDO` and `SchedulerDO`, `limits.cpu_ms: 300000`, `vars` for the non-secret config, `observability.enabled: true`. Set a D1 `location` hint matching where turns run.
- Secrets: `OIDC_CLIENT_SECRET` and model provider keys through `wrangler secret put`. Local development uses `packages/trueforge/.env` (wrangler reads `.env`; do not create `.dev.vars`).
- `packages/trueforge/src/workers/index.ts` (new): `export { SessionDO, SchedulerDO }`; `fetch` lazily builds the Hono app once per isolate (global-scope budget is 1 second) and for non-API paths falls through to `env.ASSETS.fetch(request)`.
- Root `package.json` scripts: `workers:dev` (`wrangler dev` in `packages/trueforge`), `workers:deploy`, `workers:check` (`wrangler deploy --dry-run --outdir`, then `wrangler check startup`), `d1:migrate:local`, `d1:migrate:remote`, `test:store:d1`, `d1:schema:dump`. Every `workers:*` script sets `WRANGLER_BUILD_CONDITIONS=trueforge-dev,workerd,worker,browser` through `cross-env` and runs wrangler via `bunx`. No custom `build.command`: plain esbuild lacks wrangler's `require` shim and crashed on `pg`'s dynamic `require("node:events")` in the spike. `workers:check` runs the `build:gen` codegen first until nothing on the graph imports `sandboxScripts.gen.ts`.
- `docs/`: a user-facing `deploy/cloudflare.mdx` is written only after Phase 5 lands.
- No CI changes in this phase (Section 8).

Verify: `pnpm workers:check` under 64 MiB with zero banned modules; `pnpm workers:dev` serves the UI at `/`, `/api/v1/docs`, and a streamed turn; `wrangler deploy` to a preview environment, then OIDC login and one turn end to end.

## 6. What is deleted or left Node-only

Deleted from the Workers bundle by construction (still shipped for Node):

- `trueforge-core/src/request-reply/*`, `runtime/redis.ts`, `runtime/event-subscription/redis.ts`, `runtime/peeringIds.ts`, `EXECUTOR_ID`
- `controller-main.ts`, the HTTP loopback executor, `createApiKeyAuthMiddleware` for schedules
- `frontend.ts`, `http/tls.ts`, `truefoundry/*`, `sandbox/**`, `db/postgres/**`, `db/sqlite/client.ts`, `db/migrateSqlite.ts`, `db/migratePostgres.ts`

Nothing is deleted from the repository in this port. Dead code created by the port (for example an unused `redis` field on `ServerDeps` once the `TurnExecutor` port lands) is removed in the same change that makes it unused.

## 7. Risks and open items

- D1 write latency: `TurnHandle` persists every event before yielding it, so each event is a network round trip from the DO to D1 instead of a local better-sqlite3 write. Expect higher per-event latency. Mitigation is the D1 location hint; batching persistence is out of scope.
- Non-atomic route callbacks: Section 4.3 lists the sites. Any new multi-write callback must use `batchWrite`; add this to `packages/trueforge/AGENTS.md` when Phase 2 lands.
- Known D1 gaps after Phase 2a: model provider and MCP PUT secret read-then-write races (no `updated_at` guard yet); `apis/sandboxProviders.ts` awaits `provider.buildImage()` inside `withTransaction` (pre-existing rule violation, harmless while sandbox is off on Workers); the schedule store tells a run-index unique violation from a name clash by matching `schedule_run.` in the error message, which D1's `UNIQUE constraint failed: <table>.<column>` text must keep satisfying (Phase 2b test).
- DO eviction mid-turn: turns die and are frozen by the watchdog. Acceptable for phase 1; durable resume would need the turn loop to checkpoint per iteration.
- Two migration systems: Kysely `.ts` for better-sqlite3, `.sql` for D1. The pairing rule keeps them aligned; nothing proves equivalence until the schema-diff job in Section 8 exists. Until then, run `pnpm d1:schema:dump` and diff by hand whenever a SQLite migration is added.
- Closed in Phase 0: `@opentelemetry/*` resolves to its browser build and the MCP SDK's SSE transport pulls `eventsource` with no Node builtins; both load in workerd.
- `--remote` D1 behavior is unverified. Re-run the Section 2 batch probes against a real D1 database before the first remote deploy.
- Free-tier D1 daily row limits are enforced from 2026-09-01; a paid plan is assumed.

## 8. Backlog: CI

Deferred on purpose. None of it blocks Phases 0 to 5; each phase's verification line is run locally instead. Pick these up once the Workers target runs end to end.

- `.github/workflows/ci.yml`: add a `workers:check` job (`wrangler deploy --dry-run --outdir`) that fails on any module from the Phase 1 banned list or a bundle over 64 MiB.
- `.github/workflows/ci.yml`: add a `test:store:d1` job under `@cloudflare/vitest-pool-workers`, and sync the `store` path filter per `packages/trueforge-core/src/agent-session/store/AGENTS.md`.
- Schema equivalence job: run `d1:schema:dump` from the Kysely SQLite migrations and diff against a fresh local D1 after `wrangler d1 migrations apply --local`. Fails when a SQLite migration lands without its paired `.sql`.
- Path filters and matrix ids for any new root `test:*` scripts added by the port (`AGENTS.md` sync rule).
- Preview deploy on PRs (`wrangler versions upload`) once secrets handling for CI is decided.
