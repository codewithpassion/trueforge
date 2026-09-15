# Progress Log

Reverse-chronological log of implementation cycles: what we did, what went wrong, what to avoid.

---

## Cycle 10 — Phase 5 landed and first real Cloudflare deploy (2026-09-15)

**Goal:** Land Phase 5 on the branch, then deploy the Worker to a custom domain and test it end to end on real Cloudflare.

**What we did:**

- Phase 5 landed as `044b6e82..17b95687` with no conflicts. `62caeabe` added the review nits: workers now reject an empty `PUBLIC_BASE_URL`, the `run_worker_first` sync test in `tests/unit/frontendShell.test.ts` checks both directions, and there is a HEAD Cache-Control assertion. Verified: typecheck, `test:trueforge` 595, core 440, frontend 18, SQLite 196, D1 220, Workers 46, Postgres 196, eslint 0 errors, `workers:check` with no drift (4973 KiB), 0 banned modules, openapi unchanged. An adversarial review of the landed range is still running.
- Deploy setup: the Cloudflare account that owns `rockyshoreslabs.io`; `wrangler.jsonc` gained `account_id` and a `custom_domain` route for `trueforge.rockyshoreslabs.io`; a new D1 database `trueforge-rockyshoreslabs` with location hint `oc`. Auth is a new Clerk dev instance ("TrueForge", issuer `https://inviting-ray-7546.clerk.accounts.dev`) with an OAuth application for `/api/v1/auth/callback`. Clerk ID tokens carry no groups claim, so `OIDC_USER_ROLE_CLAIM=email`, and `OIDC_ADMIN_ROLE_VALUE` and `OIDC_ALLOWED_EMAILS` are both the user's Clerk email. The client secret went up via `wrangler deploy --secrets-file`; local copies were deleted and it never entered chat. The user chose to commit the deploy config to feat/cloudflare-workers-port, including account_id, the trueforge-rockyshoreslabs D1 id, the custom domain route, and the Clerk OIDC vars. Remove them before any upstream PR.
- The first deploy was rejected by Cloudflare's upload validation with "OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together". Config is parsed at module load, so the bad config blocked the deploy instead of shipping a Worker that looked healthy. The second deploy succeeded: version `cbcb3e65`, startup 234 ms, 4973 KiB / gzip 895 KiB, cron `*/5`.
- Unauthenticated checks on the live domain passed: `/healthz` 200 (0.2.0-rc.10); `/` and HTML deep links get the shell with `no-cache`; a hashed asset is 200 immutable; a missing asset is 404 with no cache header; a deep link without an HTML accept header is 404; `/api` is a JSON 404; protected APIs are 401; `/api/v1/auth/login` redirects 302 to Clerk with PKCE and the right callback.
- Signed-in checks after the user logged in through Clerk and configured OpenRouter (`z-ai/glm-5.3-flash`): `auth/me` shows oidc-connected with the admin role from the email claim; capabilities show sandbox and skills disabled. A streaming turn produced 52 events (first at 1.8 s, done at 10.3 s). Cancel at the 10th delta ended the stream 0.35 s later with `turn.done` cancelled/client-cancelled, stored as cancelled. A non-streaming turn returned running and subscribe reached `turn.done` in 5.2 s. Turn events returned 200. A 2.5 MB input got 413 "limit is 2000000 bytes". Agent and schedule creation worked; run-now created a triggered run whose turn finished with "SCHEDULED-OK". SchedulerDO alarms fire about every 60 s, the cron re-arms every 5 min, and there were no exceptions.
- Findings: the user's first UI chat failed with an OpenRouter 400 "glm-5.3-flash[1m] is not a valid model ID", which came from the provider model config, not the Worker. A client cancel logs at error level as "Agent thread execution failed … client-cancelled" (noise).
- Correction: the 25-item cap is the shared `PAGE_LIMIT` in `src/schemas/common.ts` for every list endpoint, with keyset pagination via `page_token`/`next_page_token`, the same on Node. The smoke script's `limit=50` was the error, not the server.
- The first landing reviewer, review-p5-land, stalled for about 2 hours waiting on a background task that had already finished, and was stopped. Its salvaged partial report found no blockers. All 8 picks match their sources in range-diff. Suites are green on `62caeabe`: typecheck, `test:trueforge` 595, frontend 18, D1 220, Workers 46, `workers:check`. A tsx probe showed the dropped `!== ''` guard is safe and the empty-`PUBLIC_BASE_URL` check applies only to workers. `workers:check`'s `check startup` runs without vars or secrets, so it never validates runtime config. Nits applied to the docs: the deploy guide names `PUBLIC_BASE_URL` among the required values and says `workers:check` does not catch missing ones; the changeset covers an empty `PUBLIC_BASE_URL`; the plan doc notes the check-startup gap. A narrower reviewer, review-p5-land-2, runs only the N2 mutation check, N4, and a cast and comment scan.
- Still unverified: large tool results and the D1 1000-query budget under sub-agents or compaction on remote D1, the first hourly alarm-dispatched run (due 12:00 UTC), `limits.cpu_ms` for SessionDO, a Clerk production instance, and the CI backlog.
- Completed subagents were shut down at the user's request; review-p5-land-2 is still running.

**Lessons learned:**

- Cloudflare upload validation executes module-load code, so config errors surface at deploy time.
- The browser tool's JavaScript evaluation has a 45 s limit; a test script with a 2-minute polling loop timed out.
- Read enum semantics before judging a status: "triggered" is the success state for schedule runs.
- Tell reviewers not to wait on background-task notifications for work they can check with a file read, and cap command durations. Otherwise a finished background task can leave the reviewer idle forever.

**Avoid next time:**

- Don't assume a run is stuck because its status isn't named "succeeded".
- Don't write browser test scripts that run longer than 45 s; poll with separate calls.

## Cycle 9 — Phase 3 review nits closed; Phase 5 fixes reviewed and ready to land (2026-09-15)

**Goal:** Close the last Phase 3 review nits on the branch, then finish and review the Phase 5 should-fix round so Phase 5 can land.

**What we did:**

- Phase 3 nits landed as `8424c12c`. A `livePolls` test hook sits next to `waitingPollers`. A Workers test asserts that after a Worker-side cancel, the DO poll generator finishes at the next non-terminal event while the turn is still running, and stays live in a control run with no further event. The SessionDO watchdog now opens D1 stores once per alarm pass (`persistence ??=` inside each orphan's try), so the 800-statement warning counts the whole invocation. A mutation check confirmed the test: reverting to `=` fails with "expected 2 to be 1". One docblock line over 120 characters was rewrapped. Verified: typecheck, `test:trueforge` 589, `test:workers` 42, eslint 0 errors, `workers:check`. Phase 3 has no open review items.
- Phase 5 fix round in the worktree (`16af43c7`, `73cd755d`, `ac7ddae5`, `3d5a3086` on top of `39765e5c..10d6c6fe`). `SERVER_PATH_PREFIXES` and `isServerPath` moved to `src/frontendShell.ts`, and both `frontend.ts` and the Workers entry use them. `run_worker_first` is `["/api", "/api/*", "/healthz", "/healthz/*"]`. A sync test parses `wrangler.jsonc` with the new devDependency `jsonc-parser`, which was already a transitive dependency; TypeScript 7 has no JS API for JSONC. With `not_found_handling: "none"`, the Worker handles misses: 404 under `/assets/` with no cache header, the shell with `no-cache` only for HTML GET/HEAD, otherwise 404. The `PUBLIC_BASE_URL` placeholder is gone, and a path-prefixed value is rejected on workers. Guide fixes: D1 budget qualifiers, the localhost callback URL, and the cancel limitation wording.
- Verified on the worktree: typecheck, `test:trueforge` 593, `test:workers` 43, eslint 0 errors (src only, see below), `workers:check` at 4971 KiB. Saved `workers:dev` evidence: a hashed asset hit returns 200 immutable without invoking the Worker (checked with a temporary probe log); a miss returns 404 text/plain with no Cache-Control; the shell and deep links are `no-cache`; a deep link without an HTML accept header is 404; `/api` and unknown API paths return a JSON 404; `stream:true` reaches `turn.done`; cancel is recorded as cancelled/client-cancelled.
- Node Docker `pnpm smoke` in the worktree first failed on a Docker build cache error ("parent snapshot ... does not exist"). The retry passed with "healthz and UI OK". `.env` and the root-owned `data/` were removed afterwards.
- The Opus review of the fixes found no blockers, nothing to fix, and five nits. The reviewer ran its own `workers:dev` with no `.env` and vars passed via `--var`. It confirmed: deep links answered 304 for `If-None-Match` keep `no-cache`; `/index.html` redirects 307 to `/` with no loop; POST with an HTML accept header gets 404; `/apifoo` gets the shell, as on Node; every server path, OAuth callbacks included, reaches the Worker; `_headers` still applies to platform-served files. It also checked that `SERVER_PATH_PREFIXES` is byte-identical to the base, ran a mutation check on the JSONC sync test, found `worker-configuration.d.ts` byte-identical to the merge base once the placeholder was removed, and matched guide claims to code (callback path, default port 8787, the 800 warning, the 100-iteration default).
- Part 2 of the Phase 5 fix review arrived with five nits and no blockers. Four are folded into the landing commit: reject an empty `PUBLIC_BASE_URL` on workers, since otherwise `/healthz` passes and sign-in returns 500; make the `run_worker_first` sync test two-way; move it into `tests/unit/frontendShell.test.ts`; assert Cache-Control replacement on HEAD. The fifth, the Node vs Workers difference for a missing `/assets/` file with HTML accept, is recorded in the plan. The first smoke failure was a BuildKit race: `server` and `controller` in `docker-compose.yml` build the same image tag at once. That is outside Phase 5. The reviewer found no file changed on both sides, so a clean cherry-pick is expected.
- Next: land Phase 5 onto `feat/cloudflare-workers-port`, regenerating the lockfile with `pnpm install` and the worker types, then write a final progress entry.

**Lessons learned:**

- To prove a stream cleans up, pair the waiter count with a live-generator count.
- A sync test between a JSONC config and a TypeScript prefix list catches routing drift. It found the missing `/healthz/*`.
- Docker build cache errors can fail a smoke run on their own. Read the failing log before blaming the change.
- The repo's eslint config ignores test files (this predates the port), so "eslint 0 errors" only covers `src`.
- A config comment saying a missing value "fails loudly" needs checking against when it fails. Here it failed per request, not at startup.

**Avoid next time:**

- Don't claim lint coverage for test files that the repo config ignores.

## Cycle 8 — Phase 4 landing verified; fourth Phase 3 fix round reviewed; Phase 5 built and in review fixes (2026-09-15)

**Goal:** Confirm the Phase 4 landing, close the fourth Phase 3 fix round through review, and build and review Phase 5 (static assets, final wrangler config, deploy guide).

**What we did:**

- Verified the Phase 4 landing (`0e28405a`, `715eaf21`, `70011af4`). Passing: typecheck, `test:trueforge` (588), core (440), SQLite store (196), D1 store (220), Workers (39), the Postgres store suite, eslint (0 errors), and `workers:check` with no type drift (4970 KiB). The banned-module scan was clean; the `dialect/postgres` files it matched belong to kysely itself, not to a driver. `pnpm workers:types` produced no diff, so there was no extra commit. The landing agent skipped `openapi:write`; the next fix round ran it and got no diff.
- Fourth Phase 3 fix round, `b044f470..f848975b` (6 commits). `eventRendezvous` now handles a signal that is already aborted, and the comments about the unpropagated RPC cancel are corrected. A new Workers test uses a `gap` mock scenario: after a Worker-side cancel, a later non-terminal event releases the parked DO poll while the turn keeps running. Because of that, no heartbeat was added. The SessionDO watchdog is now bounded by one hour since the first failure. The old attempt cap is gone because 10 attempts on 60 s alarms ran out after about 10 minutes. `D1ValueTooLargeError` is dropped at once, and failures to create persistence are bounded too. `worker-types.mjs` restores a leftover `.bak` before regenerating. On the tip: typecheck, `test:trueforge` 589, SQLite 196, D1 220, Workers 41, eslint 0 errors, `workers:check`, and `openapi:write` with no diff.
- The Opus review of that round found no blockers and nothing to fix before landing. The reviewer added a live-poll counter to a scratch copy. It showed the DO poll generator finishes at the next non-terminal event (0 live polls at t+5 s while the turn was running) and stays parked when no further event arrives. The reviewer also simulated `worker-types.mjs` failures (leftover `.bak`, a failing `bunx`, empty output); the committed file stayed intact in every case. Nits being applied: the test comment claims more than `waitingPollers` alone proves; per-orphan store creation moved the 800-statement warning to per-orphan scope, but D1's limit of 1000 queries applies per alarm invocation, so stores will be created lazily once inside the guard; and one docblock line is over 120 characters.
- Phase 5 was built in a worktree (`39765e5c..10d6c6fe`). `src/frontendShell.ts` owns the base-path token and the cache policy. `scripts/build-workers-assets.ts` builds `dist-workers-assets` without `.br`/`.gz` files and writes `_headers`. The `/assets/*` rule needs ` ! Cache-Control` because Cloudflare joins repeated headers. The build also sets the final `wrangler.jsonc` assets block, `limits.cpu_ms`, and observability, and adds `workers:deploy`, `d1:migrate:local`, and `d1:migrate:remote`. `TRUEFORGE_RUNTIME` is documented, and `docs/deploy/cloudflare.mdx` is under Getting Started. Smoke on the final tree covered the shell and deep links, immutable hashed assets, a JSON 404 from the API, `/api/v1/docs`, `stream:true` to `turn.done`, `stream:false` plus subscribe with `Last-Event-ID`, and cancel.
- The Phase 5 review found no blockers and 4 should-fix items. (1) A missing hashed asset got the SPA fallback: HTML with a one-year immutable cache, so after a rollback or version skew browsers would keep a blank app. The fix sets `not_found_handling` to `"none"` and handles misses in the Worker: 404 under `/assets/`, and the shell with `no-cache` only for HTML navigations. We rejected adding `/assets/*` to `run_worker_first`, because every asset request would then bill the Worker and skip `_headers`. (2) `/api` without a trailing slash reached the shell. `SERVER_PATH_PREFIXES` and `isServerPath` moved to `frontendShell.ts`, and `"/api"` was added to `run_worker_first` with a test that keeps the two in sync. (3) A stale `wrangler.jsonc` comment. (4) The `PUBLIC_BASE_URL` placeholder is removed so a missing value fails clearly, and the workers config now rejects a path prefix. Accepted as is: the frontend package keeps its own copy of the shell token because of the build boundary. Evidence gaps being closed: saved outputs for cancel, the API 404 bodies, and asset headers; a curl check that misses reach the Worker; corrected cancel wording in the guide; and a Node Docker smoke run inside the Phase 5 worktree, with `.env` and the root-owned `data/` removed afterwards.
- Process: the progress skill now runs before each orchestrator docs commit and before launching any agent that commits on the branch.

**Lessons learned:**

- A counter of waiters can read zero in two different states: the poll was released, or it is suspended at a yield. Pair it with a counter of live generators.
- Per-invocation limits such as D1's query cap need counters scoped to the invocation, not to one helper instance.
- An SPA fallback combined with URL-matched cache headers can cache HTML under an asset URL for a year.

**Avoid next time:**

- Don't assert behavior from a single counter without ruling out the other state it could mean.
- Don't put placeholder values for required URLs in committed config.

## Cycle 7 — Phase 3 landed with three review rounds; Phase 4 SchedulerDO built, reviewed, and landed (2026-09-15)

**Goal:** Land Phase 3 (TurnExecutor port and SessionDO) through its review rounds, then build, review, and land Phase 4 (scheduled runs dispatched from a singleton SchedulerDO).

**What we did:**

- Phase 3 was built in a worktree. It adds the TurnExecutor port in `runtime/turnExecutor.ts` (`start`, `startStreaming`, `subscribe`, `cancel`). These return data results because error classes do not survive DO RPC. It also adds `runtime/turnRunner.ts`, `runtime/nodeTurnExecutor.ts`, and `runtime/createServerRuntime.ts`, which Node and Workers share. SessionDO is keyed `tenant_id:session_id` and keeps `turn_events` and `started_turns` in DO SQLite. It persists the turn id before `createTurn`, runs a keepalive interval, and has an alarm watchdog that freezes orphaned turns. The Workers entry fails closed unless `RUNTIME === 'workers'`. Phase 3 also adds a D1 value size guard, `wrangler.jsonc`, and a Workers vitest project. Measured D1 budget: about 8.2 statements per tool iteration. 99 iterations used 814 statements, against a limit of 1000 per invocation, and the warning fires at 800.
- Review 1 found no blockers and 8 should-fix items: a whole-row D1 size check, lost backpressure on Node `stream:true`, a 413 check that only ran after RPC (Workers RPC caps serialized messages at 32 MiB), two sources of platform types, an untested 412, an untested `WorkersTurnExecutor`, a create path that could return an empty 200, and an undocumented status change on the internal schedule route. Seven commits fixed them. One of those commits (`58bf5cb4`) fails `workers:check` on its own because of stray lines in generated types, and the next commit fixes it. We kept the history.
- Phase 3 landed as `b3810a8d..9060314e` (11 commits, no conflicts). The landing agent skipped `test:workers`, so the orchestrator ran it on the branch (27 passed).
- Review 2 found 1 blocker, introduced by the first fix round. The statement guard summed every bound value, but Kysely upserts bind the same JSON twice. Skill, model provider, and MCP server upserts and `patchMCPServers` over about 1 MB were rejected on D1 and accepted on Node. Should-fix items: unpinned `bunx wrangler` made the drift check depend on the machine, the watchdog retried forever, `eventRendezvous` had edge cases, and the 422 test was weak. Fixed on the branch as `104f79b1..70d24978` (8 commits): distinct-value counting with 1.1 MB upsert cases on SQLite, D1 and Postgres; wrangler pinned to 4.131.2 everywhere, a header-insensitive drift check, and `.bak`-based regeneration; a bounded watchdog with a guarded `ALTER TABLE`; rendezvous fixes; 412 from `startTurnStreaming` when there is no live tip; all four Sessions casts removed; and a cancel-propagation test.
- Confirmed in local workerd that a Worker-side `ReadableStream.cancel()` does not reach SessionDO over RPC. Only a later event releases the parked poller, and so far that is proven only for `turn.done`. The internal schedule execute route never marks runs failed; the controller does that.
- Review 3 found no blockers. Should-fix: a pre-aborted signal in `eventRendezvous` and an inaccurate cancel comment. The unpropagated cancel is acceptable for now without mitigation, because approvals and ask-user end the turn. Follow-ups: a test that a non-terminal event releases the poller, with a heartbeat fallback, and a watchdog bound that works out to 10 minutes rather than 1 hour. These are queued as a fourth small fix round and not yet applied.
- A local `.env` leaks values into `wrangler types` output when vars are strict, so `scripts/worker-types.mjs` pins an empty env file.
- Phase 4 was built in a worktree. `executeScheduleRun({ item, deps })` in `controller/scheduleRunExecution.ts` is shared by the Node route, run-now, and SchedulerDO. SchedulerDO is a singleton. `ensureAlarm` arms only when idle. The alarm runs `dispatchScheduledRuns` with a 14-minute abort, logs a failed pass, and always re-arms 60 s later in `finally`. A `*/5` cron calls `ensureAlarm`. Phase 4 also adds `createWorkersRuntimeDeps(env)`, a v2 migration, and 7 Workers tests. The local cron URL is `/cdn-cgi/local/scheduled`, and the minimum schedule interval is 3600 s. Smoke in `workers:dev`: a `stream:true` turn reached `turn.done`, a due run started exactly one turn, and pausing stopped pending rows.
- The Phase 4 review found no blockers. It flagged stale plan bullets (the orchestrator fixed them) and a Workers console logger that dropped Error message, stack, and cause (fixed with `extractErrorLogFields`, which guards against circular causes). The scheduler alarm tests ran real dispatch passes; they are now stubbed and pass under `--sequence.shuffle`. The smoke evidence was real but reported too strongly. "One turn despite four passes" was really three failed passes on a name collision the smoke setup caused, then a manual rename, then one success. Recorded but not implemented: a derived turn id to close the duplicate-turn window during deploys, a per-run timeout, and marking name-collision runs failed. The SDK client tree-shakes to 0 bytes in the bundle.
- Phase 4 landed on the branch as `0e28405a`, `715eaf21`, `70011af4`; landing verification was still finishing when this entry was written.
- Process gap: the orchestrator ran the progress skill before every docs commit in Cycles 1-6, but landing and fix agents committed code without it. From now on the orchestrator runs the progress skill before launching each landing or fix agent that commits.
- Correction to Cycle 6: its "avoid next time" note implied that the Phase 2b landing agent skipped the queued follow-up fixes. It did not. Follow-up commit `63a8e0a9` already contained them, and the check ran before that commit landed.
- Remaining work: the fourth Phase 3 fix round, and Phase 5 (static assets, final wrangler config, runtime selector docs, deploy guide). Phase 5 ends with a smoke on the final branch that re-checks `stream:true`, `stream:false` plus subscribe, and cancel. The CI backlog is deferred.

**Lessons learned:**

- A fix round can introduce new defects. The second Phase 3 review found a blocker that the first fix round created, so fix commits need their own review.
- Pin every tool version that feeds a committed generated file. Unpinned `bunx wrangler` made the type drift check machine-dependent.
- Kysely upserts bind the same value more than once, so size guards must count distinct bound values.
- The unpropagated RPC cancel only showed up because test hooks let us observe internal waiters.
- Read the saved smoke output yourself. Agent summaries of it can't be trusted.

**Avoid next time:**

- Don't let agents commit before the progress step when the user asked for it before every commit.
- Don't describe a smoke result more strongly than the saved outputs show.
- Don't trust a landing agent's report that the required suites ran. Check that `test:workers` and the other suites actually ran on the landed branch.

## Cycle 6 — Phase 2b: D1 dialect, atomic runner, persistence, and D1 contract tests (2026-09-15)

**Goal:** Run the SQLite stores on Cloudflare D1 through a Kysely dialect and batch-based atomic runner, with shared contract tests that cover both backends.

**What we did:**

- Built in a worktree and reviewed twice by Opus. It landed as `63ea82b7` (three worktree commits squashed) plus follow-up `63a8e0a9`.
- Wrote a custom Kysely dialect in `src/db/d1/client.ts` over a small structural `D1Queryable`, because kysely-d1 0.4.0 only accepts `D1Database` and not sessions. `D1AtomicRunner` runs each batch on the caller's own session (`instanceof D1Connection` check). `createD1Persistence({ database, mcpClientName })` returns `withTransaction` (a new first-primary session per call) and the store set from the shared `db/sqlite/stores.ts`, which `main.ts` also uses. `jsonColumns.ts` owns JSON columns. `errors.ts` owns `isUniqueViolation`, which now matches D1's "UNIQUE constraint failed" text. The store transaction type is widened to `Kysely<Database>`.
- Rewrote ten IN-list sites to `IN (SELECT value FROM json_each(?))` via `jsonListValues`. Tests assert at most 100 params for 500 ids on both backends. The review measured query plans on a 200k-row table and found them on par with literal lists.
- `scripts/dump-sqlite-schema.mjs` writes `migrations/d1/0001_init.sql` from Kysely-migrated SQLite. The output is deterministic and applies to local D1 (39 commands). The review diffed `sqlite_master`, `table_list`, foreign keys and AUTOINCREMENT between the Kysely-migrated and dump-applied databases: identical.
- D1 facts: it binds strings, numbers, null and `Uint8Array`, and booleans become 1/0. `Date`, bigint and `undefined` fail with `D1_TYPE_ERROR`. Raw JSONB columns come back as number arrays, so reads project `json(col)`. More than 100 params fails with "too many SQL variables". Local D1 (miniflare) accepted a 2.1 MB value, so it does not enforce the 2,000,000-byte cap. The workerd bundled with vitest-pool-workers supports compatibility dates only up to 2026-08-22, so D1 tests use 2026-08-15.
- Review 1 (no blockers): `BigInt(meta.changes/last_row_id)` was unguarded, the D1-specific tests had not been ported, and an esbuild check with `--packages=external` hid a core barrel reach (already fixed on main by Phase 1d). Review 2 (no blockers in the fix commit) found three problems. The merge would have silently dropped `a429f9e6`'s four multi-chunk tests in a whole-file conflict; they were moved into the shared `sessionStoreAtomicWritesSuite` during landing. `executeQuery` left `numAffectedRows` unset, so Kysely's builders read 0 after a committed write. The batch-metadata error was a plain `Error`.
- Fixes: all atomicWrites cases (11) and concurrentUpdate cases (4) now run on SQLite and D1 from shared suites with injected clocks. `D1WriteOutcomeUnknownError` is thrown when a write statement lacks a numeric `meta.changes` (single statements and batch statement 0); reads are unaffected. The chunking case now asserts the statement count, the harness takes env from `cloudflare:test`, and the factory is `createD1Db({ queryable })`. New rules in `src/db/sqlite/AGENTS.md`: D1 migrations are paired with SQLite ones, stores don't import `client.ts`, multi-write methods use `batchWrite` with the conditional chain, placeholder lists are never expanded, a context mapping stays in the same batch as its log insert, and values stay under 2 MB.
- Bundle reach: the D1 persistence bundle pulls in `node:crypto`, `node:path` (via `config.ts` from the MCP OAuth helpers) and cron-parser's `fs` (loaded lazily, only inside `parseFile`). It does not pull in `@vercel/oidc`, Daytona, axios, ws or dotenv. `app.ts` reaches `@vercel/oidc` through the AI SDK.
- Checks: typecheck green, `test:trueforge` 561, `test:trueforge-core` 440 (1 skipped), `test:store:sqlite` 192 (1 skipped), `test:store:d1` 202, then 204 after `63a8e0a9` (1 skipped), Postgres store suite passed, eslint 0 errors.
- Cleanup: the earlier Docker smoke run left a root-owned, gitignored `data/` directory (Postgres bind mount) that made plain `eslint .` fail with EACCES. Its timestamp confirmed the smoke run created it, and a throwaway container removed it.
- Carried to Phase 3: a domain size guard for turn input/state and for single rows over 2 MB. SessionDO must persist turn ids before `createTurn` and map `D1WriteOutcomeUnknownError` to a distinct 503 code. cron-parser and `@vercel/oidc` must load in workerd. The D1 query budget per invocation still needs measuring. The Workers entry must assert `RUNTIME === 'workers'`.

**Lessons learned:**

- If worktree commits aren't green one by one, squash them when landing.
- When a slice moves tests into shared suites, check every parallel slice that added cases to the old files before resolving conflicts.
- Local D1 does not enforce D1's limits reliably. Enforce and test size limits in application code.
- Kysely treats a missing `numAffectedRows` as 0, so a D1 dialect must throw instead of guessing.
- Bundle checks for Workers must include workspace packages. `--packages=external` hides reaches.
- Docker bind mounts from a smoke run leave root-owned files that break repo-wide tools.

**Avoid next time:**

- Don't run `pnpm smoke` in the main checkout without cleaning up `data/` afterwards.
- Don't accept "no separate fix commit was needed" from a landing agent without checking that the queued follow-up instructions were applied.

## Cycle 5 — Phase 1c landed, Phase 1d and 2a follow-ups landed; Phase 1 complete (2026-09-15)

**Goal:** Land the remaining Phase 1 slices (1c workers config, 1d deep imports) and the Phase 2a review follow-ups, then verify Phase 1 end to end on `feat/cloudflare-workers-port`.

**What we did:**

- Landed Phase 1d as `759e9fa5` and `295a8b5b` with no conflicts. Landed the Phase 2a follow-ups as `a429f9e6`: multi-chunk `addThreads`/`appendToEvents` tests with 600 KB rows, a corrected schedule guard comment, and a 10-50 ms jittered retry in `finishScheduledRun` that stops when the dispatch abort signal fires. An agent committed `a429f9e6` without running the progress step, so this entry covers it.
- The second Opus review of the 2a fixes found no blockers. It confirmed the B1 guard's JSONB equality byte for byte (SQLite 3.53 STRICT BLOB), the chunk mapping, and that the retry loop always awaits I/O. It also found nine SQLite store reads that build `IN (...)` lists from input and exceed D1's 100-parameter limit: `getOwnedIds` for sessions/agents/schedules (the permissions route fails at 99-100 ids), agent `getExternalIdsByIds`, `listSchedules` agent_names, `whereCreatedByOrAgentIds`, `listAgents` external_ids, `listServers` names, and token `getTokens`, plus a latent one in `listSkills` names. These went to Phase 2b with the `json_each` fix pattern.
- Phase 1c landed as `b48a6e32` plus reconcile commit `be033e7e`. It adds a `RUNTIME` discriminant (`standalone | distributed | workers`) set by `TRUEFORGE_RUNTIME`, which falls back to standalone. It also exports `parseServerConfiguration()`. The workers member requires OIDC and rejects TrueFoundry. PORT/HOST/SERVER_URL/TRUEFORGE_API_KEY/mTLS moved to `NodeSharedServerConfiguration`. Node path values moved to `nodeConfig.ts`, so `config.ts` imports only `node:path`. `packageVersion.ts` became a gitignored `packageVersion.gen.ts` generated in `build:gen`. `app.ts` mounts `/api/internal/schedules` and the API-key middleware only outside workers, and `main.ts`/`controller-main.ts` reject workers. EXECUTOR_ID and REDIS_REQUEST_REPLY_* stay on workers until the Phase 3 TurnExecutor port. `wrangler dev` returned 200 with runtime `workers` and the version.
- Dead end: the Node path module was first named `config.node.ts`. Node treats a `.node` specifier as a native addon, which gave `ERR_MODULE_NOT_FOUND` under tsx/tsup. Neither typecheck nor jest caught it.
- The 1c review found one blocker, and it only appeared at cherry-pick time. A new 1c test built `SqliteMcpServerStore`/`SqliteScheduleStore` with one argument, but Phase 2a had changed the constructors to `(db, atomic)`. Git merged cleanly and typecheck failed. `be033e7e` fixed it and added a positive control test for the API-key middleware mock. Should-fix S1 goes to Phase 3: with `TRUEFORGE_RUNTIME` unset, config falls back to standalone auth (everyone is admin), so the Workers entry must assert `RUNTIME === 'workers'`. Nits: `TRUEFORGE_RUNTIME` is undocumented (queued for Phase 5), env validation order changed when several vars are invalid (message text unchanged), and `build:gen:watch` does not watch `package.json`.
- Phase 1 checks: typecheck green, `test:trueforge` 561, `test:trueforge-core` 440 (1 skipped), `test:store:sqlite` 187 (1 skipped), Postgres store suite via Docker passed, eslint 0 errors. The `app.ts` esbuild graph contains no `node:fs`, `node:os`, `node:url`, env-paths, better-sqlite3, pg, undici, Postgres stores, local sandbox, http/tls, core barrels or `nodeConfig.ts`. The only Node built-ins left are crypto, events, path and timers/promises. The landing agent skipped `pnpm smoke` because `packages/trueforge/.env` is missing in the main checkout. The orchestrator then ran it with a temporary `.env` copied from `.env.example` (deleted afterwards): the from-source Docker image built, `/healthz` and the UI shell check passed ("healthz and UI OK"), and `pnpm smoke:down` removed the stack.
- Phase 2b (D1 dialect, `D1AtomicRunner`, schema dump migration, vitest-pool-workers harness, IN-list fixes) is still running in a worktree. Prompts for Phases 3, 4 and 5 are drafted.

**Lessons learned:**

- A clean git merge does not mean a clean integration. Tests that parallel slices add against old constructor signatures only fail at typecheck.
- Don't give a module a `.node` suffix. Node resolves it as a native addon, and typecheck and jest won't catch the problem.
- A config fallback that is safe on Node (default standalone) can be unsafe on a new public runtime.

**Avoid next time:**

- Don't skip typecheck and tests after a cherry-pick, even when the merge is clean.
- Don't let subagents commit without the progress step when the user asked for one before every commit.
- Don't run parallel slices that both add tests constructing classes whose constructors another slice changes.
- Don't let a new runtime entry rely on the config default. Have it assert its runtime explicitly.

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
