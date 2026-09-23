---
'@truefoundry/trueforge-sdk': minor
---

Breaking: integrations moved from `client.settings.integrations` to `client.integrations`, and
belong to an agent.

`client.integrations.create` now requires `agent_name` beside `manifest`, `list` accepts an
`agent_names` filter, every `Integration` carries `agent_name`, and `IntegrationManifest` no
longer has `default_agent_name`. Replace `client.settings.integrations.<method>` with
`client.integrations.<method>` and pass the agent on create.
