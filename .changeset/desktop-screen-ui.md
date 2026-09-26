---
'@truefoundry/trueforge-assistant-ui-runtime': minor
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge': patch
---

Watch and drive a remote computer's desktop from the web UI. Agents whose computer runs a desktop get a **Screen** tab (also reached at `/agents/<agent_id>/screen`), the owner of such a session gets a Screen panel beside the chat, and Settings → Computers → a computer → **Desktop** lets an admin log in to accounts ahead of time. The view polls live frames, lists the agents waiting for a person, and offers Take control, Hand back with a note, Cancel request, clipboard copy and paste, and a toolbar for keys the browser keeps.

While you are in control, input goes out one request at a time, so a slow connection does not build a backlog; Ctrl+Alt+Shift gives the keyboard back to the page, and Tab then moves through the page's controls; held mouse buttons are let go when the pointer is cancelled, the window loses focus or you hand back; and leaving the view hands the desktop back, in every view of it you have open. While another person is in control the view stops asking for frames and checks every 2 s for them to finish; below the md breakpoint the session's Screen panel is hidden and stops polling, keeping control rather than handing it back. On a Mac, Cmd+C/X/V/A/Z/L reach the desktop as the Ctrl chords and Option+letter types its character. The status line shows the last frame's age, and a stale frame stays on screen dimmed under an offline, not-running or clearing label.

Chat shows desktop tool calls with the action and a screenshot thumbnail (click to zoom), with typed text counted rather than shown, and any tool result with images gets thumbnails too. A `request_human_takeover` call shows the agent's reason with **Open screen**, and the composer lets the session owner answer it; if the request was already answered or the agent is still busy, it says so instead of showing an error, and a failed answer keeps the typed note.

`AgentUIServer` gains an optional `computerDesktop` port (`ComputerDesktopServer`) and `AgentChatServer` an optional `getSessionFile`. `respondToToolResponse` takes an optional `{ onSendError }` that sees a failed send before `onError` and returns true once it has handled it. Tool-call parts carry a result's images on `artifact`; read them with `getToolResultImages`, and fetch the bytes with `useTrueForgeSessionFile`. The built-in server config takes `desktop: true` to attach the desktop port; pass the server's `capabilities.desktop.enabled`.
