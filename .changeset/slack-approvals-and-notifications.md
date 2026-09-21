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
changes. A plain reply in the thread answers a pending question in free text; a thread held on
an approval is pointed back at the buttons instead.

Manifest-level `notification_rules` post a finished schedule run to a channel, filtered by
outcome, through the same claim-first outbox and retry sweep on both runtimes. A rule posts at
the top of the channel and never carries buttons: a click there could not name the run's own
session, so a held run is reported as waiting rather than offered a dead Approve. The generated
Slack app manifest now carries the `interactivity` block, so **an app created from an earlier
manifest must be updated from the regenerated one** before any button works.

One decision settles the whole turn: core refuses a resume that leaves any held tool call
unresolved, so several gated calls get one **Approve all** / **Deny all** pair, and a set one
interaction cannot settle — an approval plus a question, say — is not offered buttons at all.
Everything a model produced is escaped before it reaches a block, argument summaries redact
credentials recursively and by value shape, and non-JSON arguments are never shown.

Who approved or denied is recorded in a new `integration_decision` table, one row per held turn,
readable through `GET /api/v1/settings/integrations/{integration_id}/decisions`. It is its own
table because the dedupe log is pruned at 24 hours, and it is not session metadata because any
tenant user can rewrite that. Answers to questions are not recorded: anyone in the thread may
give one.

Schema: `integration_delivery` is now unique on `(integration_id, turn_id, conversation_key)`
rather than `turn_id`, so one turn can owe a message to several channels and two integrations
can each owe the same one, and it carries `session_external_id` because a rule's channel no
longer names the session. Migration paired on SQLite, Postgres and D1
(`0004_delivery_notification_target.sql`).
