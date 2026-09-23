---
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge': patch
---

Integrations move from Settings to the agent page.

`@truefoundry/trueforge-assistant-ui-runtime`: `IntegrationCatalogServer` and the `integrationCatalog` slot on `CatalogServer` are replaced by an `IntegrationServer` on `AgentUIServerPort` as `integrations`, beside `schedules`. `listIntegrations` takes `{ agentNames }` (`ListIntegrationsParams`). `IntegrationBase` and `CreateIntegrationRequest` carry `agentName` in place of `defaultAgentName`, and `UpdateIntegrationRequest` no longer has an agent: an integration stays with the agent it was created for.

`@truefoundry/trueforge-ui`: agent details gain an Integrations tab (`tab=integrations`), shown when the server supplies `integrations`. It renders the new `IntegrationsPage` slot, which lists and creates the Slack integrations of that one agent and offers only that agent's schedules for notification rules. The Settings Integrations section is removed. New exports: `IntegrationsPage`, `IntegrationsPageProps`, `useIntegrationServer`, `useOptionalIntegrationServer`, `IntegrationServer`, `ListIntegrationsParams`; `IntegrationCatalogServer` is gone. The built-in TrueForge adapter supplies `integrations` from `createIntegrationServer`, which replaces `createIntegrationCatalog` and targets `/api/v1/integrations`.

`@truefoundry/trueforge`: the bundled UI manages Slack integrations from each agent's Integrations tab.
