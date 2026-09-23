---
'@truefoundry/trueforge-core': minor
'@truefoundry/trueforge': minor
---

Desktop screenshots reach the model as images.

`@truefoundry/trueforge-core`: `providerAcceptsToolImages(type)` from `core/llm/VercelAILLM` says whether a provider type is shown images in tool results.

`@truefoundry/trueforge`: the `computer_*` tools return each screenshot as an image tool result. On a provider type that is not shown images in tool results the model gets a text stub in its place, and the desktop instructions tell it to read the screen through exec and the clipboard instead.
