---
'@truefoundry/trueforge': patch
---

On the Cloudflare Computer sandbox, a command that exits non-zero is reported as a command result with its exit code, the way the Daytona, TrueFoundry, and local providers already report it. Cloudflare Computer labels every non-zero exit `failed`, so an ordinary shell error such as `ls /nope` previously reached the agent as a broken sandbox with the exit code dropped. A command is now an infrastructure failure only when it never launched, was cancelled, or finished without its writes reaching the workspace store.

A turn that cannot get a sandbox because the deploy is already running its `max_instances` limit of containers now says so and asks the caller to retry, instead of surfacing a raw transport string that opens with a health-check timeout.
