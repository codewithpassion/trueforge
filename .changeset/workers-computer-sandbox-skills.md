---
'@truefoundry/trueforge': patch
---

On the Cloudflare Computer sandbox, a command that exits non-zero is reported as a command result with its exit code, the way the Daytona, TrueFoundry, and local providers already report it. Cloudflare Computer labels every non-zero exit `failed`, so an ordinary shell error such as `ls /nope` previously reached the agent as a broken sandbox with the exit code dropped. A command is now an infrastructure failure only when it never launched, was cancelled, or finished without its writes reaching the workspace store.

A turn that cannot get a sandbox because the deploy is already running its `max_instances` limit of containers now says so and asks the caller to retry, instead of surfacing a raw transport string that opens with a health-check timeout.

Skills now work on the Cloudflare Workers runtime whenever `TRUEFORGE_SANDBOX_BACKEND` is set. `GET /api/v1/capabilities` reports them enabled, an agent can attach catalog skills, and each turn's sandbox init downloads them into `/workspace/.trueforge/skills` and removes the ones the agent no longer asks for. A turn on an agent that has skills no longer answers 422 on this runtime.

The runtime sandbox port's `isLocalFallbackEnabled` is now `isSandboxUsableWithoutStoredRecord`, which is what it has always decided: whether a sandbox works without a row in the sandbox-provider table. Nothing about the behaviour changes; the old name described only the standalone Node case and read as false on a runtime whose sandbox comes from a deploy variable.
