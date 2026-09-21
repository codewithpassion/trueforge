---
'@truefoundry/trueforge-ui': patch
'@truefoundry/trueforge': patch
---

Move connecting a channel into Settings. `CatalogServer` gains an optional `integrationCatalog` slot — added to `@truefoundry/assistant-ui-runtime` through a types-only patch, since its slots are fixed and a parallel port is not allowed — and trueforge-ui re-exports the new `IntegrationCatalogServer` port and its DTOs. The new Integrations section is built from the same atoms as Connectors and appears only when the host supplies the port, which the built-in TrueForge adapter does from the generated SDK. It walks the whole flow: name the bot, copy or download the generated Slack app manifest, open Slack, then paste the bot token and signing secret. The separate `/integrations` host page, its route helper and its nav override are gone.
