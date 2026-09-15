---
'@truefoundry/trueforge': patch
---

Keep non-streaming and scheduled turns running to completion on Cloudflare Workers, where they could stall or be frozen as abandoned after the start request returned.
