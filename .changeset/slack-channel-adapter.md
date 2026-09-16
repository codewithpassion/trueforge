---
'@truefoundry/trueforge': patch
---

Add the Slack channel adapter, so a connected Slack workspace can talk to an agent. Inbound requests are verified against the app's signing secret with a five-minute replay window, the subscription challenge is answered, and bot, self and edited messages are dropped along with payloads from another workspace or a channel that is not allowed. A thread is a session: the first mention opens it and later messages in it continue it, while a message that arrives during a running turn is told to wait instead of starting a second one. Replies are converted to Slack mrkdwn, split into messages Slack accepts, and posted in thread; a post that fails is retried with backoff until five attempts are spent, honouring `Retry-After`.
