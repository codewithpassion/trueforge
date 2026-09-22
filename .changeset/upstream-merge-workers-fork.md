---
'@truefoundry/trueforge': patch
---

Bring upstream's web search, turn ownership, outbound URL guard, inline MCP/skill headers, caller `x-tfy-metadata` and MCP response cap to all three runtimes.

- Node installs the SSRF-guarded fetch at startup. `NETWORK_POLICY_ENABLED` defaults to true, so model, MCP and OAuth calls to private or loopback addresses are refused unless it is set to false or the host is in `OUTBOUND_URL_ALLOWED_HOSTS`. Workers uses the platform `fetch` and ignores `OUTBOUND_URL_ALLOWED_HOSTS` / `OUTBOUND_URL_BLOCKED_HOSTS`.
- Workers turns record `active_executor_id` = `session-do`. D1 databases need migrations `0006_agent_web_search` and `0007_turn_active_executor_id`.
- SQLite and Postgres migrations `20260916_000001_integration` and `20260917_000001_delivery_next_attempt` are renamed to `20260918_000002_integration` and `20260918_000003_delivery_next_attempt` so they sort after upstream's. A database that already ran the old names must be recreated.
