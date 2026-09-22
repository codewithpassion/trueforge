---
"@truefoundry/trueforge": patch
---

Stop a replaced Durable Object instance from finishing a turn it no longer owns. A session's holding alarm now checks that it still owns the object while it waits, ends the turns it holds as `abandoned` when it does not, and leaves the alarm to the instance that took over — so a long command no longer ends the turn as `client-cancelled` with nobody having cancelled it.
