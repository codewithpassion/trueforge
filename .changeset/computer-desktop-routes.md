---
'@truefoundry/trueforge': patch
---

Adds `/api/v1/computer-desktops/{computer_id}` routes so anyone who may use a desktop agent can watch its computer's desktop, take control, send input, share the clipboard, and hand control back or cancel a pending takeover. Browser writes must come from the server's own origin; another person's control answers `423` with code `human_in_control`.
