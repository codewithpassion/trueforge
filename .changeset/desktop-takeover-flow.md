---
'@truefoundry/trueforge': minor
---

Desktop agents can ask a person to take over the computer's desktop. The new `request_human_takeover({ reason })` client-side tool is offered to the root thread beside the computer tools; a turn that ends on it leaves a pointer on the computer the session's sandbox runs on (the agent's computer before it has one), and the new takeover service lists pending requests and resumes the session when the person hands back or cancels (audited as `computer.desktop.hand_back` / `computer.desktop.cancel` with the acting user). The tool response says whether the session's creator or another user answered. A resume that cannot start drops the request from the desktop and leaves the session waiting, to be answered in chat.

Creating a turn that answers a tool call the session already answered now returns `409` with code `already_answered` instead of forking the session, or `tip_running` while the session's latest turn is still running. Slack posts a takeover request with its reason and a link to the agent's Screen page, and a reply typed while one is pending is told to use that page.
