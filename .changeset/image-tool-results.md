---
'@truefoundry/trueforge-core': minor
'@truefoundry/trueforge': minor
'@truefoundry/trueforge-assistant-ui-runtime': minor
---

Tools can now return images, and models that accept images in tool results see them. **Breaking:** a `tool.response` event's `content`, and `LLMToolMessage.content`, is now an array of parts instead of a string: `{ type: 'text', text }` or `{ type: 'image', file_id, media_type, width, height }`. An image part points at a session file, served by `GET /api/v1/sessions/{session_id}/files/{file_id}`. Events and thread history stored as a string are read back as one text part, so no data migration is needed.

`@truefoundry/trueforge-core`: `ILLM.create` / `createNonStream` take the harness message type `LLMRequestMessage` instead of OpenAI's `ChatCompletionMessageParam`, and `PreLLMEphemeralAgentContextProcessor` works on the same type. `toolImageResultResponse({ data_b64, width, height, media_type })` builds an image tool result; `executeToolCalls` stores its bytes through the new session-scoped `SessionFiles` port (`scopeFileStore` adapts an `IFileStore`). `VercelAILLM` sends images to Anthropic, OpenAI and Google as `file` parts and replaces them with a text stub for the other provider types, whose adapters would turn them into base64 text; `providerAcceptsToolImages(providerType)` reports which is which. Oversized tool results offload their text only, and images stay attached.

`@truefoundry/trueforge`: once a model request would carry more than twice `TOOL_RESULT_IMAGES_KEEP` (default 5) tool images, the oldest become text stubs down to that many. Stubs are applied in batches so a cached prompt prefix stays valid, and stored history keeps every image.

`@truefoundry/trueforge-assistant-ui-runtime`: `ToolResponseEvent.content` is `ToolContentPart[]` (camelCase `fileId`, `mediaType`); tool cards show the text parts.
