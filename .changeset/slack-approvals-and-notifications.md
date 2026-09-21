---
'@truefoundry/trueforge': patch
---

Slack approvals, questions and schedule notifications.

A Slack-originated turn that stops on a tool approval or an `ask_user_question` now posts a
Block Kit message in its thread instead of "waiting for input it cannot ask for here":
approve/deny buttons carrying the tool name and a redacted, truncated argument line, or the
question with its options. Deciding goes to the new signature-verified
`POST /api/v1/integrations/{integration_id}/interactions`, which acknowledges inside Slack's
three seconds and resumes the turn afterwards. Only Slack users on the manifest's
`approver_slack_user_ids` may approve; anyone else gets an ephemeral refusal and nothing
changes. A plain reply in the thread answers a pending question in free text.

Manifest-level `notification_rules` post a finished schedule run to a channel, filtered by
outcome, through the same claim-first outbox and retry sweep on both runtimes. The generated
Slack app manifest now carries the `interactivity` block, so **an app created from an earlier
manifest must be updated from the regenerated one** before any button works.

Schema: `integration_delivery` is now unique on `(turn_id, conversation_key)` rather than
`turn_id`, so one turn can owe a message to several channels, and carries `session_external_id`
because a rule's channel no longer names the session. Migration paired on SQLite, Postgres and
D1 (`0004_delivery_notification_target.sql`).
