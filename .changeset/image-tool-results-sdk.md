---
'@truefoundry/trueforge-sdk': major
---

**Breaking:** `ToolResponseEvent.content` is now `ToolContentPart[]` instead of a string. A part is `ChatCompletionContentPartText` (`{ type: 'text', text }`) or the new `ToolImageContentPart` (`{ type: 'image', fileId, mediaType, width, height }`); fetch an image's bytes with `client.sessions.getFile(sessionId, fileId)`. To get the old string, join the text parts. The Python SDK (`trueforge-sdk` on PyPI) changes the same way: `ToolResponseEvent.content` is a `List[ToolContentPart]`, with `ToolImageContentPart` carrying `file_id`, `media_type`, `width` and `height`.

Also new, not breaking: `SandboxConfig.desktop` lets an agent see and drive its remote computer's desktop; `ComputerTools` gains `desktop` and `desktopUnavailableReason`; `ComputerAuditOp` gains `desktop`; and `CapabilitiesData.desktop` (`DesktopCapability`) says whether desktops are available. The Python SDK gains the same fields in snake_case.

Also new: `client.computerDesktops` (`get`, `getScreenshot`, `sendInput`, `getClipboard`, `setClipboard`, `takeControl`, `handBack`, `cancelTakeover`) to watch and drive an agent's remote desktop; a person-controlled desktop answers `LockedError` (423). `handBack` and `cancelTakeover` return `DesktopTakeoverAnswerResponse` (`{ data: { status, takeover } }`, where `takeover` is null or a `DesktopTakeoverAnswer` whose `result` is a `DesktopTakeoverResult`: `resumed` | `already_answered` | `not_pending` | `resume_failed`) rather than a desktop status alone. Creating a turn that answers an already answered tool call now throws `ConflictError` (409) with code `already_answered` instead of forking the session, or code `tip_running` while the session's latest turn is still running. The Python SDK changes the same way.
