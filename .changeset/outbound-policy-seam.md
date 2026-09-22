---
'@truefoundry/trueforge-core': patch
'@truefoundry/trueforge': patch
---

Model-provider, MCP and OAuth traffic goes through a runtime-neutral outbound policy. `configureOutboundUrlGuard` installs the SSRF-guarded fetch and URL check; a host that never calls it uses the platform `fetch` with no URL check.
