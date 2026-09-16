---
'@truefoundry/trueforge-core': minor
---

`SessionSource` is now a discriminated union on `type`: the existing `schedule` arm plus an `integration` arm carrying the integration id and the channel `conversation_key`. `SessionSourceType` gains `integration`.
