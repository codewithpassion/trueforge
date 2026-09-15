# Progress Log

Reverse-chronological log of implementation cycles: what we did, what went wrong, what to avoid.

---

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
