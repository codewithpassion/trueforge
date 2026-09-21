---
'@truefoundry/trueforge-core': patch
---

An agent spec can now name a remote computer to run on: `config.sandbox.computer_id` selects a machine the tenant has enrolled instead of the tenant's sandbox provider. A new `SandboxOfflineError` reports a machine that is temporarily unreachable, which callers must not answer by recreating the sandbox the way they answer `SandboxNotAvailableError`.
