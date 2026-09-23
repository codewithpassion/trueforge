---
'@truefoundry/trueforge': minor
'@truefoundry/trueforge-ui': patch
---

Agent descriptions are optional.

`@truefoundry/trueforge`: `POST /api/v1/agents` accepts a request without `description` and stores an empty one. Create, update, and agent responses allow an empty `description`; the 1024-character limit and trimming still apply. `PUT` without `description` keeps the stored value; `description: ""` clears it.

`@truefoundry/trueforge-ui`: the Save Agent and Clone forms label Description as optional and enable Save without one. The built-in adapter no longer sends the agent name as a stand-in description on create.
