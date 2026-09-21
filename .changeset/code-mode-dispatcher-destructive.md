---
'@truefoundry/trueforge-core': patch
---

Code Mode now refuses destructive MCP tools on the host as well as in the sandbox client. A request that skips the client can no longer run a tool marked destructive, or one that says it is not read-only, without the user approval flow. The call is refused as a caller error, the same way the client already refused it. A tool the server does not list is refused the same way.
