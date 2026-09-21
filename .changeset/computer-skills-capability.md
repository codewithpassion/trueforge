---
'@truefoundry/trueforge': patch
---

A remote computer now reports whether it can mount skills, and a machine that cannot is no longer stopped from running plain commands. `hello.capabilities` gains `skills`, which the client answers by testing `python3`, `git` and `python3 -c "import pydantic"`; `protocol_version` stays 1 and the field defaults to false. When it is false the server attaches no skill mounter and sends no downloader, and an agent that asks for a skill is refused — at spec validation and at turn time — with a message naming what is missing.
