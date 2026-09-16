---
'@truefoundry/trueforge': patch
---

Add the integrations layer: an `integration` record per connected channel account with an inbound-event dedupe log and a delivery outbox, admin CRUD at `/api/v1/settings/integrations` with credentials redacted on read, and a signature-verified channel ingress at `POST /api/v1/integrations/{integration_id}/events`. Inbound events start a non-streaming turn as the admin who connected the integration, and the reply owed is posted once the turn's event drain settles. No channel adapter ships yet, so ingress answers `501`.
