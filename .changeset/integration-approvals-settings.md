---
'@truefoundry/trueforge-ui': patch
---

The Integrations section now edits who may approve a tool call and which schedule results are
posted where. The approver list is channel user ids; the rules editor is one row per rule —
schedule, channel id and an outcome filter — with the schedule box suggesting names from the
host's schedules port while still accepting one it cannot list.

The `integrationCatalog` port gains `approverUserIds` and `notificationRules` on the
integration and on both requests, a new `IntegrationNotificationRule`, and
`interactionsRequestUrl` on the setup manifest. These live in the same types-only
`pnpm patch` of `@truefoundry/assistant-ui-runtime` as the port itself, so
**this package still must not be published while that patch is in place.**
