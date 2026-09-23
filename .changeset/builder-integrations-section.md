---
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge': patch
---

Manage an agent's Slack integrations from the agent builder.

`@truefoundry/trueforge-ui`: the agent config panel gains an Integrations section after Runtime Config, rendered by the new `AgentIntegrationsSection` slot and shown when the server supplies `integrations` and `sessions`. For a saved agent it lists each integration's bot name and status; **Manage integrations** (which needs permission to manage the agent) opens the `IntegrationsPage` slot in a drawer, a row opens it on that integration's setup, and the list reloads when the drawer closes. A draft shows that it has to be saved first. `IntegrationsPage` takes an optional `embedded` prop that drops its page heading and background inside another surface's chrome and an optional `initialIntegrationId` that opens that integration once the list loads, and `AgentConfigSection` takes an optional `action` node for a custom header control. New export: `AgentIntegrationsSection`.

`@truefoundry/trueforge`: the bundled agent builder shows the Integrations section; the agent page's Integrations tab stays.
