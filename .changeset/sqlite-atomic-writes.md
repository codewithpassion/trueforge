---
"@truefoundry/trueforge": patch
---

SQLite stores now write multi-statement changes as single guarded batches instead of interactive transactions, so the same SQL can run on Cloudflare D1. Updating a schedule that another request changed at the same moment now returns 409 instead of overwriting it.
