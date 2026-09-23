---
'@truefoundry/trueforge': minor
---

Desktop agents can ask a person to take over the computer's desktop. The new `request_human_takeover({ reason })` client-side tool is offered beside the computer tools; a turn that ends on it leaves a pointer on the computer's relay, and the new takeover service lists pending requests and resumes the session when the person hands back or cancels (audited as `computer.desktop.hand_back` / `computer.desktop.cancel` with the acting user).

Creating a turn that answers a tool call the session already answered now returns `409` with code `already_answered` instead of forking the session. Slack posts a takeover request with its reason and a link to the agent's Screen page, and a reply typed while one is pending is told to use that page.
