# Progress Log

Reverse-chronological log of implementation cycles: what we did, what went wrong, what to avoid.

---

## Cycle 4 — Phase 2a: AtomicRunner and conditional-chain SQLite writes; Phase 1d built (2026-09-15)

**Goal:** Replace interactive SQLite store transactions with batch-shaped conditional writes that D1 can run, and cut the core barrel out of the server's Worker graph.

**What we did:**

- Phase 2a ran in its own worktree and was cherry-picked onto `feat/cloudflare-workers-port` as `5a8d4bbd` (AtomicRunner and conditional-chain writes) and `9f13052d` (review fixes). Conflicts with Phase 1b in `settings.ts`, `main.ts`, `sandboxFileDownload.test.ts` and `turns.test.ts` were resolved by keeping both sides.
- Added `AtomicRunner { readGroup; batchWrite({ executor, queries }) }` in `db/sqlite/atomic.ts`. `BetterSqliteAtomicRunner` in `db/sqlite/client.ts` joins an outer transaction when one is passed and otherwise uses `BEGIN IMMEDIATE`. Rewrote `createTurn`, `freezeAndGetTurn`, `updateTurnState`, `getTurn`, `addThreads`, `removeThreads`, append/overwrite thread context, `appendToEvents`, `patchThreadCapabilityState`, schedule create/update, the new `IScheduleStore.finishRun`, and MCP `createServer`/`upsertServer` (including `oauth_client` and `reset_authorizations`). `session-store` and `schedule-store` no longer call `db.transaction()`.
- Found that the old store transactions used plain `BEGIN`, not `BEGIN IMMEDIATE` as their comments said.
- Plan correction: `createTurn` allows concurrent forks from a finished tip and rejects only a running previous turn (option A, `ISessionStore` unchanged).
- The Opus review found one D1-only blocker. `updateScheduleAndRun` guards matched only a computed `updated_at` (`max(Date.now(), prev+1)`) that two writers could both produce. The guards now also match the name, status and manifest that statement 1 wrote. Should-fix items: a single JSON bound value could exceed D1's 2 MB value cap (now `chunkJsonRows` at 1 MiB, one log+mapping pair per chunk), and `finishScheduledRun` gave up after 3 conflicts and left the run pending (now retries until it succeeds). Nits: the `createTurn` guard also matches `created_at` and `previous_turn_id`, the MCP contract asserts that a reset deletes tokens, and a stale comment was fixed.
- D1 limits confirmed from Cloudflare docs: 2,000,000 bytes per value/row, 100 bound parameters per statement, 100 KB SQL text, 32 args per function, 1000 queries per Worker invocation. The `removeThreads` IN list is now bound as JSON, and tests assert at most 100 params and under 100 KB for 300-row inputs. A second Opus review of the fix commit is still running.
- D1 gaps left open: read-then-write races on model provider and MCP PUT secrets, `sandboxProviders.ts` awaiting `buildImage` inside `withTransaction` (pre-existing), D1 unique-violation message mapping (Phase 2b), and the 1000-queries-per-invocation budget against per-event persistence in SessionDO (measure in Phase 3).
- Checks after landing: typecheck green, `test:trueforge` 543, `test:trueforge-core` 440 (1 skipped), `test:store:sqlite` 183 (1 skipped), Postgres store suite via Docker 169 (1 skipped), eslint 0 errors.
- Phase 1d (worktree commits `008ba395` and `b25b1b04`, not landed yet): 35 server files moved from the `@truefoundry/trueforge-core/core` barrel to deep imports, with a package-wide ESLint barrel ban using `allowTypeImports`. The stub Worker bundle went from 6608 KiB to 4006 KiB, and Daytona, NATS, ws, axios, socket.io and tweetnacl are gone from it. The Opus review found no blockers; the changeset was reworded so it makes no bundle-size claim for the published server. Still open: `sessionResources.ts` value-imports `Sandbox` and `SkillMounter`, which pulls in the gitignored `sandboxScripts.gen.ts` (Phase 3), and schemas import `VercelAILLM` constants (leaf-module follow-up). Phase 1c (workers config, generated package version) is still running in a worktree.

**Lessons learned:**

- Parallel worktree agents save wall-clock time, but every shared file turns into a merge conflict. Keep slices disjoint by file and land them in a planned order.
- A guard that later batch statements match on must be unique to this call's write (minted ids or the full written content), never a derived timestamp.
- D1's per-statement limits (100 params, 2 MB per value) matter as much as the missing transactions.
- In ESLint flat config, a later block for the same rule replaces its options, so shared restriction lists have to be spread into each block.

**Avoid next time:**

- Don't derive optimistic-concurrency tokens from clocks.
- Don't bind unbounded row lists on D1, either as one value or as a growing placeholder list.
- Don't add uncommitted files to the main checkout while a landing agent that needs a clean tree is running.

## Cycle 3 — Phase 0 results and Phase 1b: sandbox, TLS, and session-import seams (2026-09-15)

**Goal:** Close the Phase 0 gates, then inject the sandbox, client-TLS and session-import dependencies so `app.ts` no longer reaches Node-only modules through them.

**What we did:**

- Phase 0 spike (scratch only). Gate 1: `process.env` is populated from vars. Gate 2: D1 batch semantics confirmed locally. A plain guard reports `[0,1]` changes and the insert persists, an `EXISTS` chain reports `[0,0,0]`, a statement error rolls back the batch, and `BEGIN` is rejected. `--remote` was not run because there was no account login. Gate 3: workspace packages only resolve with `WRANGLER_BUILD_CONDITIONS=trueforge-dev,workerd,worker,browser` (wrangler has no config key for it). The stubbed bundle is 9.3 MiB and starts in 130 ms, with about 2.9 MB of sandbox-only code, 1.1 MB of `undici` and 0.25 MB of `pg`.
- The spike found load-time crashes that `wrangler deploy --dry-run` misses: `fileURLToPath(import.meta.url)` in `config.ts`, `createRequire(import.meta.url).resolve` in `sandbox/local/core/hostRun.ts`, and `readFileSync(package.json)` in `packageVersion.ts`. It also added plan items: `apis/agentImport.ts` (`pg`, `undici`), capabilities/sandboxProviders importing `providerUtils`, `scheduleDispatch` reaching `http`/`tls` through `apis/schedules`, `packageVersion.ts`, and the core barrel.
- Plan correction: the `createTurn` contract allows concurrent forks from a finished tip (storeContractSuite "concurrent createTurn forking the same tip") and rejects only a running previous turn. The plan wrongly asked for exactly one winner, and the Phase 2a agent caught it. New rule: statement 1 is `INSERT INTO turn ... SELECT` guarded on the previous turn not running, and later statements chain on `EXISTS(new turn)`. `append_id` stays AUTOINCREMENT, and context order comes from `ROW_NUMBER() OVER (ORDER BY append_id)` (window functions verified on local D1).
- Phase 1b: added a `SandboxIntegration` port (`sandbox/integration.ts`) and its Node implementation (`sandbox/nodeSandboxIntegration.ts`), built in `main.ts` after the boot probe and passed through `ServerDeps` and the routers. Deleted the `localRuntime.ts` module cache. With no integration, capabilities report sandbox/skill disabled, sandbox-enabled turns and agents return 422, settings GET returns 404 and PUT 422, and turn file download returns 412. OpenAPI is unchanged because route handler types only allow declared statuses.
- `clientCertificateMiddleware` is now injected. `createHttpScheduleRunExecutor({ baseUrl, fetch })` takes a TLS fetch built in `controller.ts`. A `SessionImport` port (`db/sessionImport.ts`, owns `SessionImportValidationError`, implemented by `PostgresSessionStore`) replaces the `instanceof PostgresSessionStore` check in `agentImport`. Assume-user header helpers moved to `truefoundry/assumeUserHeaders.ts`.
- Added an ESLint block for `src/workers/**` that bans Node-only modules, value imports from core barrels, and `db/postgres/**` and `truefoundry/**` paths. The `app.ts` esbuild graph went from 108 to 93 files. Node is now reached only through `config.ts`, `packageVersion.ts` and the core barrel, which later slices handle.
- The Opus adversarial review found no blockers and checked Node behavior parity step by step. Should-fix items applied: `SessionImport` returns the existing `z.infer` `ImportSessionResult` (plus a new unnamed `ImportSessionsCheckpointSchema` so OpenAPI stays unchanged, confirmed by regenerating it), ESLint also bans bare builtin names, barrels use `@typescript-eslint/no-restricted-imports` with `allowTypeImports`, a 412 file-download test is added, internal Node-only paths are banned, and optional `ServerDeps` fields are required `T | undefined`. Final checks: typecheck green, `test:trueforge` 543 passed, `test:trueforge-core` 439 passed, eslint 0 errors.
- Checks at the end of round 2: typecheck green, `test:trueforge` 542 passed, `test:trueforge-core` 439 passed.

**Lessons learned:**

- A successful `wrangler deploy --dry-run` does not mean the Worker boots. Run `wrangler dev` plus `curl /healthz`, and `wrangler check startup`.
- The agent worktree under `.claude/worktrees` makes repo-wide `lint:ci` and `format:check` fail. Verify with `--ignore-pattern '.claude/**'` and add `.claude/` to `.git/info/exclude`.
- ESLint `no-restricted-imports` paths are exact strings, so `fs` and `node:fs` both need listing. The base rule also blocks type-only imports.
- A hand-written DTO next to an existing `z.infer` alias violates AGENTS.md even when the shapes match.

**Avoid next time:**

- Don't specify store concurrency semantics in a plan without reading the contract suite first.
- Don't send agents scope additions after they finish. Send them before the agent wraps up, or bundle them into the next round.

## Cycle 2 — Phase 1a: portable Logger type and sandbox guidance leaf (2026-09-15)

**Goal:** Remove winston and the sandbox module graph from core's type-level and import-level dependencies so core code can bundle for Workers.

**What we did:**

- Added a core `Logger` interface in `packages/trueforge-core/src/core/util/logger.ts` (`debug`/`info`/`warn`/`error` taking `meta?: unknown`, plus `child`). Replaced every winston `Logger` type import in core and `packages/trueforge` src and tests.
- Merged `CodeModeLogger` into `Logger` and removed it from the barrel. Moved `winston` to core `devDependencies`.
- Moved `createSandboxLargeToolResponseGuidance`, `SANDBOX_SCHEMA_INFER_TAG` and `SANDBOX_MCP_REMINDER_TAG` into the import-free leaf `core/sandbox/largeToolResponseGuidance.ts`, so `LargeToolResponse` no longer pulls in `Sandbox.ts`. An esbuild metafile check shows 7 modules and nothing from `sandbox/provider` or `codeMode`.
- An Opus adversarial review found no blockers. Fixes applied: the changeset now documents the deep-path symbol moves and the `CodeModeLogger` removal, and the plan doc bullet is updated.
- Checks green: `pnpm typecheck`, `test:trueforge-core` (439 passed), `test:trueforge` (536 passed), `lint:ci`, `format:check`.

**Lessons learned:**

- `meta` has to be `unknown`, not `Record<string, unknown>`. `ErrorLogFields` is an interface with no index signature, so it isn't assignable to a record.
- Core's deep-path exports (published `./*`) are public API. Moving a symbol is a breaking change for deep importers and needs a changeset note.
- `packages/trueforge/tests/sandbox/local/smoke.test.ts` isn't covered by any typecheck script and already had 5 type errors before this change.

**Avoid next time:**

- Don't add re-export shims to keep old deep paths working. AGENTS.md forbids them, so document the move in the changeset.
- Don't type logger metadata as a record. Interface-typed fields won't fit it.
- Don't count on `pnpm typecheck` to catch errors in `tests/sandbox/local/`.

## Cycle 1 — Cloudflare Workers port plan (2026-09-15)

**Goal:** Plan how to run the TrueForge server on Cloudflare Workers (D1 as the database, Durable Objects for turn events and coordination, sandbox off) with the least rewrite and no copied store logic.

**What we did:**

- Wrote `docs/cloudflare-workers-port-plan.md` on branch `feat/cloudflare-workers-port`: a survey of what is and isn't portable, verified platform facts, target architecture (Worker `fetch` + `SessionDO` + singleton `SchedulerDO`), a D1 transaction strategy that covers every transaction site, Phases 0–5, and a CI backlog.
- Survey: the Hono app, Vercel AI SDK, remote MCP, OIDC (`openid-client`/`jose`) and the async-generator turn loop already work on Workers. What blocks the port: `better-sqlite3` transactions, file-based migrations, Redis Streams and pub/sub, detached turns and schedule runs, the `setInterval` scheduler, Node static serving, file-system work in `config.ts` at module load, and imports that reach `undici`, `@daytona/sdk` and `sandbox-runtime` through `app.ts` and the core barrel.
- Checked two of the three Phase 0 gates during planning: `process.env` population under `nodejs_compat` (Cloudflare docs) and D1 JSONB/STRICT support plus batch semantics (local `wrangler d1 execute`). The bundle dry-run gate runs as the first implementation step.
- Decided: turns always run inside `SessionDO` whether streamed or not; phase 1 turns don't survive DO eviction and an alarm watchdog freezes orphans; OIDC is required (no standalone auth); the Worker entry lives in `packages/trueforge/src/workers/` rather than a new package; CI changes are deferred to a backlog; the repo stays on pnpm for its lockfile and wrangler runs via `bunx`.
- Designed an `AtomicRunner` (`readGroup` + `batchWrite`) so better-sqlite3 and D1 share one set of SQLite-dialect stores under `db/sqlite/**`.

**Lessons learned:**

- D1 has no interactive transactions (`BEGIN` is rejected). `batch()` rolls back only when a statement _errors_. An `UPDATE ... WHERE guard` that matches 0 rows still succeeds, and later statements commit. Probed locally: a guarded no-op UPDATE followed by an INSERT still left the inserted row.
- A batch can't pass one statement's `RETURNING` into the next, so ids and `append_id` values have to be computed in JS before the batch.
- D1 Sessions API (`withSession('first-primary')`) gives sequential consistency, not a snapshot.
- Cron Triggers don't guarantee non-overlap, so a singleton DO alarm keeps one schedule controller per database.
- `sqlite_version()` is blocked on D1, so feature support has to be probed directly (`jsonb`, `jsonb_set`, `->>`, `STRICT` all work locally).

**Avoid next time:**

- Don't port a "`WHERE` guard, then unconditional inserts" pattern to D1. Every statement after the guard must be `INSERT ... SELECT ... WHERE EXISTS (row from statement 1)`.
- Don't copy SQLite stores into a `db/d1/` tree. Change the shared stores to use `AtomicRunner`.
- Don't let errors cross a DO RPC boundary as classes. `instanceof` mapping breaks, so return discriminated `{ ok, status, code }` results.
- Don't add a Kysely SQLite migration without a paired `migrations/d1/NNNN_*.sql` until the schema-diff CI job exists.
- Don't use `.dev.vars` for local Workers secrets; use `packages/trueforge/.env`.
