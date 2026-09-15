---
"@truefoundry/trueforge-core": patch
"@truefoundry/trueforge": patch
---

`@truefoundry/trueforge-core/core` now exports a structural `Logger` type, and core no longer depends on winston at runtime. `CodeModeLogger` is removed in favor of `Logger`. `SANDBOX_SCHEMA_INFER_TAG` and `createSandboxLargeToolResponseGuidance` moved from `core/sandbox/Sandbox` to `core/sandbox/largeToolResponseGuidance`.
