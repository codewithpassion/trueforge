---
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge': patch
---

Watch and drive a remote computer's desktop from the web UI. Agents whose computer runs a desktop get a **Screen** tab (also reached at `/agents/<agent_id>/screen`), the owner of such a session gets a Screen panel beside the chat, and Settings → Computers → a computer → **Desktop** lets an admin log in to accounts ahead of time. The view polls live frames, lists the agents waiting for a person, and offers Take control, Hand back with a note, Cancel request, clipboard copy and paste, and a toolbar for keys the browser keeps.

Chat shows desktop tool calls with the action and a screenshot thumbnail (click to zoom), and any tool result with images gets thumbnails too. A `request_human_takeover` call shows the agent's reason with **Open screen**, and the composer lets the session owner answer it.

`AgentUIServer` gains an optional `computerDesktop` port (`ComputerDesktopServer`) and `AgentChatServer` an optional `getSessionFile`. Tool-call parts carry a result's images on `artifact`; read them with `getToolResultImages`, and fetch the bytes with `useTrueForgeSessionFile`. The built-in server config takes `desktop: true` to attach the desktop port; pass the server's `capabilities.desktop.enabled`.
