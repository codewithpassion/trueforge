---
'@truefoundry/trueforge': patch
---

Give the integration outbox an explicit `next_attempt_at`, so a reply that is waiting on a backoff, a channel's `Retry-After`, or an in-flight post is read in due order rather than inferred from `updated_at`. Adds a migration on SQLite, Postgres and D1. Slack requests now carry a 30-second timeout and the caller's own deadline, so a hung connection cannot still be posting when the retry sweep takes the row.
