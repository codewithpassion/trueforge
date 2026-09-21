---
'@truefoundry/trueforge-ui': patch
---

Settings → Sandbox providers now shows the built-in sandbox of a Cloudflare Workers deploy. It enables in one click — no form and no API key — shows the same status line as a configured provider, and has a Disable action. Providers that need credentials keep the configure form and the Update action.

The settings sandbox port now wires `deleteSandboxProvider` to the new backend route, so the Remove action appears for a configured provider instead of being hidden.
