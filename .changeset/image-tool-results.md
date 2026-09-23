---
'@truefoundry/trueforge-core': minor
'@truefoundry/trueforge': minor
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
---

Tools can now return images, and models that accept images in tool results see them. **Breaking:** a `tool.response` event's `content`, and `LLMToolMessage.content`, is now an array of parts instead of a string: `{ type: 'text', text }` or `{ type: 'image', file_id, media_type, width, height }`. An image part points at a session file, served by `GET /api/v1/sessions/{session_id}/files/{file_id}`. Events and thread history stored as a string, including events replayed from a live turn stream, are read back as one text part, so no data migration is needed.

`@truefoundry/trueforge-core`: `ILLM.create` / `createNonStream` take the harness message type `LLMRequestMessage` instead of OpenAI's `ChatCompletionMessageParam`, and `PreLLMEphemeralAgentContextProcessor` works on the same type. `toolImageResultResponse({ data_b64, media_type, width?, height? })` builds an image tool result; the size is optional and advisory. `executeToolCalls` stores image bytes through the new session-scoped `SessionFiles` port (`scopeFileStore` adapts an `IFileStore`) after checking them: an image must be PNG, JPEG, GIF or WebP, match its declared media type, fit `ToolImageSettings.maxBytes`, and be at most 8000 px on each side; its size is read from the image header, which wins over the size a tool reports. An image that fails a check reaches the model as a text note, and images from tools that report no size are now kept. Text and image blocks keep their order, and images next to `structuredContent` are kept. `VercelAILLM` sends images to Anthropic, OpenAI and Google as `file` parts, replaces them with a text stub for the other provider types, whose adapters would turn them into base64 text, and reuses the previous request's image bytes instead of reading them again. One request carries at most 20 MiB of base64 image data: past that, the oldest images become text stubs. The context-size estimate counts each tool image. Oversized tool results offload their text only, and images stay attached.

`@truefoundry/trueforge`: once a model request would carry more than twice `TOOL_RESULT_IMAGES_KEEP` (default 5) tool images, the oldest become text stubs down to that many. Stubs are applied in batches so a cached prompt prefix stays valid, and stored history keeps every image. `TOOL_RESULT_IMAGE_MAX_BYTES` (default 3.75 MiB, which is 5 MiB as base64) caps one tool-result image.

`@truefoundry/trueforge-assistant-ui-runtime`: `ToolResponseEvent.content` is `ToolContentPart[]` (camelCase `fileId`, `mediaType`); tool cards show the text parts. `ToolContentPart`, `ToolTextContentPart` and `ToolImageContentPart` are exported from the package root and `/server`.

`@truefoundry/trueforge-ui`: re-exports `ToolContentPart`, `ToolTextContentPart` and `ToolImageContentPart` from its server types.
