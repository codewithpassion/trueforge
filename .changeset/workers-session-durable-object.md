---
'@truefoundry/trueforge': patch
---

Route turn start, streaming, subscribe, and cancel through a `TurnExecutor` port and add the Cloudflare Workers entry with a per-session Durable Object. On Node, the internal `POST /api/internal/schedules/runs/execute` route now answers 400, 404, or 422 when a turn cannot start because of invalid input, a missing session, or the agent's configuration (for example a sandbox with no provider), where it answered 500.
