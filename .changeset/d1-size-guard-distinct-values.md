---
'@truefoundry/trueforge': patch
---

On Cloudflare D1, skill, model provider, and MCP server upserts and MCP server patches on a running turn no longer fail with `D1ValueTooLargeError` when their JSON document is between about 1 MB and 2 MB. The size check now counts a value bound twice in one statement once.
