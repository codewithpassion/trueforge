---
'@truefoundry/trueforge-core': patch
'@truefoundry/trueforge': patch
---

Model-provider, MCP and OAuth traffic goes through a runtime-neutral outbound policy. On Node, importing `@truefoundry/trueforge-core` installs the SSRF-guarded fetch and URL check by default (private, loopback and link-local targets refused). `configureOutboundUrlGuard` applies allow/block lists or disables the guard. A runtime that loads only deep paths without the guard, such as Workers, keeps the platform `fetch` with no URL check.
