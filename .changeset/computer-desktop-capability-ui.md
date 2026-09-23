---
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
---

Computer settings show whether a machine runs a desktop.

`@truefoundry/trueforge-assistant-ui-runtime`: `ComputerTools` gains `desktop` and `desktopUnavailableReason`; a host that builds `ComputerBase` itself must now set both.

`@truefoundry/trueforge-ui`: the computer list and details name the desktop beside python3 and the other detected tools, or say why it is not running when the machine reported a reason.
