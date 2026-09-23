---
'@truefoundry/trueforge-sdk': major
---

**Breaking:** `ToolResponseEvent.content` is now `ToolContentPart[]` instead of a string. A part is `ChatCompletionContentPartText` (`{ type: 'text', text }`) or the new `ToolImageContentPart` (`{ type: 'image', fileId, mediaType, width, height }`); fetch an image's bytes with `client.sessions.getFile(sessionId, fileId)`. To get the old string, join the text parts. The Python SDK (`trueforge-sdk` on PyPI) changes the same way: `ToolResponseEvent.content` is a `List[ToolContentPart]`, with `ToolImageContentPart` carrying `file_id`, `media_type`, `width` and `height`.
