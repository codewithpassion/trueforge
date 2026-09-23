---
'@truefoundry/trueforge': patch
---

Adds `/api/v1/computer-desktops/{computer_id}` routes so anyone who may use a desktop agent can watch its computer's desktop, take control, send input, share the clipboard, and hand control back or cancel a pending takeover. Browser writes must come from the server's own origin; another person's control answers `423` with code `human_in_control`. Taking control and handing it back are audited as `computer.desktop.take_control` / `computer.desktop.hand_back` with the acting user. A hand-back refused with `409` still carries the desktop status in `data`, so the caller sees whether control was released. A desktop tool refused because a person is in control tells sub-agents to stop and tell the user; only the root thread is told to call `request_human_takeover`.
