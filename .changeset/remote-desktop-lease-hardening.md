---
'@truefoundry/trueforge': minor
'@truefoundry/trueforge-assistant-ui-runtime': minor
---

Harden the remote desktop lease.

`@truefoundry/trueforge`: a turn releases the desktop lease on every computer it sent a desktop op to, including when it is cancelled or fails mid-op, and a late release from an earlier turn no longer drops the next turn's lease. While a person controls the desktop, every agent operation except `cancel` is refused, file transfers included. After a person's control ends, nobody can use the desktop until its clipboard is confirmed cleared; a read-only computer or a desktop that is down counts as cleared, and after three failed clears in a row agent commands and file transfers run again while desktop operations wait for a clear to succeed. Desktop tool calls run one at a time, and agent desktop operations are written to the computer audit log as `desktop` rows that name the operation and the number of input actions, never their contents. `ComputerAuditOp` gains `desktop`.

`@truefoundry/trueforge-assistant-ui-runtime`: `ComputerAuditOp` gains `desktop`.
