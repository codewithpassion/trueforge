---
'@truefoundry/trueforge': patch
'@truefoundry/trueforge-core': patch
---

Add a Cloudflare Computer sandbox backend for the Workers runtime, behind the new `TRUEFORGE_SANDBOX_BACKEND` deploy variable. Unset, the Workers runtime behaves exactly as before and reports code execution as unavailable. Set to `cloudflare-computer`, each session gets its own container-backed `/workspace`, and `SANDBOX_EXEC_TIMEOUT_SECONDS` caps a command that sets no timeout of its own. Skills stay unavailable for now. `SandboxNotAvailableError` accepts `{ cause }` so a provider can keep the transport failure it classified.
