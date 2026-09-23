---
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge': patch
---

Watch and drive a remote computer's desktop from the web UI. Agents whose computer runs a desktop get a **Screen** tab (also reached at `/agents/<agent_id>/screen`), the owner of such a session gets a Screen panel beside the chat, and Settings → Computers → a computer → **Desktop** lets an admin log in to accounts ahead of time. The view polls live frames, lists the agents waiting for a person, and offers Take control, Hand back with a note, Cancel request, clipboard copy and paste, and a toolbar for keys the browser keeps.

While you are in control, input goes out one request at a time, so a slow connection does not build a backlog; Ctrl+Alt+Shift gives the keyboard back to the page; held mouse buttons are let go when the pointer is cancelled, the window loses focus or you hand back; and leaving the view hands the desktop back. On a Mac, Cmd+C/X/V/A/Z/L reach the desktop as the Ctrl chords and Option+letter types its character. The status line shows the last frame's age, and a stale frame stays on screen dimmed under an offline, not-running or clearing label.

Chat shows desktop tool calls with the action and a screenshot thumbnail (click to zoom), with typed text counted rather than shown, and any tool result with images gets thumbnails too. A `request_human_takeover` call shows the agent's reason with **Open screen**, and the composer lets the session owner answer it.

`AgentUIServer` gains an optional `computerDesktop` port (`ComputerDesktopServer`) and `AgentChatServer` an optional `getSessionFile`. Tool-call parts carry a result's images on `artifact`; read them with `getToolResultImages`, and fetch the bytes with `useTrueForgeSessionFile`. The built-in server config takes `desktop: true` to attach the desktop port; pass the server's `capabilities.desktop.enabled`.
