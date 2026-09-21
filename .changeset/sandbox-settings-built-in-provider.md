---
'@truefoundry/trueforge-ui': patch
---

Settings → Sandbox providers now shows the built-in sandbox of a Cloudflare Workers deploy. It enables in one click — no form and no API key — shows the same status line as a configured provider, and has a Disable action. Providers that need credentials keep the configure form and the Update action.

Removing or disabling a provider now asks for confirmation first, and says what it does: for a credentialed provider, that the stored API key is deleted and sandboxes already running are left to the provider's own auto-delete; for the built-in one, that agents lose the sandbox until it is enabled again.

The settings sandbox port now wires `deleteSandboxProvider` to the new backend route, so the Remove action appears for a configured provider instead of being hidden.
