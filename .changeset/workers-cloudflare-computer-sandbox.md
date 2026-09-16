---
'@truefoundry/trueforge': patch
'@truefoundry/trueforge-core': patch
---

Add a Cloudflare Computer sandbox backend for the Workers runtime, behind the new `TRUEFORGE_SANDBOX_BACKEND` deploy variable. With the variable unset the Workers runtime behaves as before and reports code execution as unavailable, but deploying still provisions Cloudflare Containers and pushes the sandbox image; removing the `containers` entry from `wrangler.jsonc` is what stops that. Set to `cloudflare-computer`, each session gets its own container-backed `/workspace`, and `SANDBOX_EXEC_TIMEOUT_SECONDS` caps a command that sets no timeout of its own (at most two thirds of the alarm pass holding the turn). Skills stay unavailable for now.

`SandboxProvider` gains `supportsCodeMode`. `Sandbox` now leaves Code Mode unconfigured when a provider reports `false`, instead of asking it for a transport; MCP tools stay available to the model directly. Daytona, TrueFoundry, and the local provider report `true`, so Node behaviour is unchanged. `SandboxNotAvailableError` accepts `{ cause }` so a provider can keep the transport failure it classified.
