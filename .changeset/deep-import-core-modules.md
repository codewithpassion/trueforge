---
"@truefoundry/trueforge": patch
---

The server imports `@truefoundry/trueforge-core` modules directly instead of the `core` barrel, so bundles no longer include sandbox providers they do not use.
