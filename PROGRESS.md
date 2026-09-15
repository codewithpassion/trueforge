# Progress Log

Reverse-chronological log of implementation cycles: what we did, what went wrong, what to avoid.

---

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
