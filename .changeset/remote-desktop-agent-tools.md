---
'@truefoundry/trueforge-core': minor
'@truefoundry/trueforge': minor
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': patch
---

Agents can see and drive the desktop of a remote computer.

`@truefoundry/trueforge-core`: the agent spec gains `config.sandbox.desktop` (default `false`). `Sandbox` takes an optional `providerTools` option: tools a provider adds beside `exec`, with their prompt text. Each call creates the sandbox first and reports it the way `exec` does.

`@truefoundry/trueforge`: a computer's `hello.capabilities` gains `desktop` and `desktop_unavailable_reason`, and the computer response's `tools` reports both. `GET /capabilities` gains `desktop.enabled`. An agent with `sandbox.desktop` on a computer whose desktop runs gets `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_clipboard_read` and `computer_clipboard_write`. A computer that requires approval offers only the screenshot and clipboard-read tools. One session at a time holds the desktop, and it lets go when its turn ends. Saving an agent with `sandbox.desktop` is refused on a computer that reported no desktop, or with no `computer_id`. On Node, streaming turns now run the same post-turn work as non-streaming ones.

`@truefoundry/trueforge-assistant-ui-runtime`: `AgentSandboxConfig.desktop` and `AgentBuilderCapabilitiesResponse.data.desktop`.

`@truefoundry/trueforge-ui`: cloning an agent drops `sandbox.desktop` along with the computer.
