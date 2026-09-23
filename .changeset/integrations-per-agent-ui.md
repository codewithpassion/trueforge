---
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge': patch
---

Connect an agent to Slack from its own page.

`@truefoundry/trueforge-assistant-ui-runtime`: add an optional `IntegrationServer` port on `AgentUIServerPort` as `integrations`, beside `schedules`, with its DTOs (`IntegrationBase`, `CreateIntegrationRequest`, `UpdateIntegrationRequest`, `IntegrationSetupManifest`, `IntegrationNotificationRule`, `ListIntegrationsParams`). An integration belongs to the agent it was created for.

`@truefoundry/trueforge-ui`: agent details gain an Integrations tab (`tab=integrations`), shown when the server supplies `integrations`. It renders the new `IntegrationsPage` slot, which lists and creates that agent's Slack integrations and walks the whole flow: name the bot, copy or download the generated Slack app manifest, open Slack, then paste the bot token and signing secret. Each integration also edits who may approve a tool call and which schedule results are posted where, with the schedule box suggesting that agent's schedules. Adding, saving and disconnecting need permission to manage the agent. New exports: `IntegrationsPage`, `IntegrationsPageProps`, `useIntegrationServer`, `useOptionalIntegrationServer`, `IntegrationServer`, `ListIntegrationsParams`. The built-in TrueForge adapter supplies `integrations` from `createIntegrationServer`.

`@truefoundry/trueforge`: the bundled UI manages Slack integrations from each agent's Integrations tab.
