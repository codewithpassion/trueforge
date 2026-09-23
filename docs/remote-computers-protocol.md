# Remote computers: wire contract v1

Treat it as frozen. The server half lives in `packages/trueforge/src/computers/protocol.ts`, which is
the canonical owner of every constant, schema and close code below. The Go client in
`packages/trueforge-computer` builds against this document. `hello.workdir` was added while no client
had shipped; the next shape change breaks deployed clients and needs a new `protocol_version`. The one
exception is additive and capability-gated: a new op may join v1 when a new `hello.capabilities` field,
defaulting to false when absent, says the client implements it, and the server sends the op to no
client that did not say so. An old client never advertises it, and would answer `unknown_op` anyway.
The desktop ops (section 7) arrived this way.

## 1. Enrollment

`POST /api/v1/computers/enroll` — unauthenticated, JSON in, JSON out.

```json
{ "enrollment_code": "…", "hostname": "office-box", "os": "linux", "arch": "amd64", "version": "0.1.0" }
```

`200`:

```json
{ "data": { "computer_id": "…", "machine_credential": "…" } }
```

Any bad, expired or already-used code answers an identical `401`:

```json
{ "error": { "message": "Unauthorized" } }
```

A body that fails schema validation answers `400`; nothing about the code's validity is revealed by the
difference, because a syntactically valid body with a wrong code is always `401`.

Codes are 32 random bytes, stored as sha256, single use, with a 15-minute TTL. The machine credential is
32 random bytes, stored as sha256; the client keeps the plaintext at `0600` in its state directory and
presents it on every connect.

## 2. Connect

`GET /api/v1/computers/connect` — WebSocket upgrade. The `Upgrade` header is compared
case-insensitively.

```
Authorization: Bearer <machine_credential>
```

Every authentication failure — unknown credential, revoked computer, missing header, wrong scheme — is an
identical `401` with the body above. A non-upgrade request to this path is `426`.

The first frame the client sends after the socket opens is `hello`. Until a `hello` arrives the relay
still dispatches requests, but the server knows neither the machine's capabilities — so skills stay off
— nor where it keeps its sessions, so anything needing a session directory answers offline.

## 3. Framing

One JSON text frame per message. All field names are `snake_case`.

The platform closes the **whole socket** when a frame exceeds 33,554,432 bytes, killing every in-flight
request rather than failing one. Both sides therefore keep frames far below that: the server guards at
`MAX_FRAME_BYTES` = 4 MiB and moves file bytes in `FILE_CHUNK_BYTES` = 262,144-byte chunks.

### Heartbeats

The client sends the bare text frame `ping` every `HEARTBEAT_INTERVAL_MS` = 10,000 ms. The platform
answers the bare text frame `pong` through `setWebSocketAutoResponse`, without waking the relay. These
two frames are literals, not JSON.

The client must apply its own read deadline of about two intervals: without one a half-open socket looks
connected. The relay treats a socket whose last heartbeat is older than `STALE_AFTER_MS` = 25,000 ms as
gone and closes it with `4408`.

### Close codes

| Code | Meaning                               | Client behaviour                                          |
| ---- | ------------------------------------- | --------------------------------------------------------- |
| 4400 | The server could not read the `hello` | Retry in minutes; nothing changes until the `hello` does. |
| 4401 | Revoked                               | **Terminal.** Log once, exit; do not reconnect.           |
| 4409 | Replaced by a newer connection        | Reconnect with backoff.                                   |
| 4408 | No heartbeat for `STALE_AFTER_MS`     | Reconnect with backoff.                                   |

Reset the backoff step only after a connection has been stable, never on every open, or two clients
sharing one credential evict each other forever.

## 4. Messages

### `hello` (client → server, unsolicited)

```json
{
  "type": "hello",
  "protocol_version": 1,
  "hostname": "office-box",
  "os": "linux",
  "arch": "amd64",
  "version": "0.1.0",
  "run_as_user": "trueforge",
  "workdir": "/var/lib/trueforge-computer/sessions",
  "capabilities": {
    "python3": true,
    "git": true,
    "skills": true,
    "desktop": false,
    "desktop_unavailable_reason": null
  }
}
```

`protocol_version` must be exactly `1`. A hello the server cannot parse — including a version it does not
speak — is answered with close code `4400`: the machine has not said where it keeps its sessions, and a
server that filled that in itself would send commands naming directories that are not there.

`workdir` is required: the absolute path of the root the client keeps its per-session directories under
— its `--workdir`, defaulting to `<state-dir>/sessions`, already resolved. The server builds every
session directory as `<workdir>/<session_id>` and accepts nothing else: at most 1024 characters, a
leading `/`, at least one path segment, no `.` or `..` segment, no trailing slash, and none of NUL, a
control character, `'`, `"`, a backtick, `\` or `$`. `run_as_user` is reported for the UI and the
activity log; no path is built from it.

`capabilities.skills` is the client's own verdict on whether the server's skill downloader can run on
this machine: true only when `python3` and `git` are on `PATH` **and** `python3 -c "import pydantic"`
succeeds. The server mounts skills on a computer only when it is true, and sends no skill work at all
when it is false — an agent with no skills still runs its commands there. The server does not
re-derive the answer from `python3` and `git`: only the machine can import a package. The field
defaults to false when a client omits it, which is why it did not need a new `protocol_version`.

`capabilities.desktop` and `capabilities.desktop_unavailable_reason` belong to the desktop extension
(section 7). A client that omits them has no desktop.

### Requests (server → client)

Every request is a `hello`-free JSON object with a string `id` minted by the server and a string `op`.
The client answers exactly one reply per `id`.

`exec`:

```json
{
  "id": "…",
  "op": "exec",
  "command": "uname -a",
  "cwd": "/var/lib/trueforge-computer/sessions/s1",
  "env": {},
  "timeout_ms": 120000
}
```

`cwd` is `null` when the server has no preference; `cwd` and `sha256` are always present as explicit
`null` rather than omitted. The client settles the directory before it starts anything. A `null` `cwd`
means the workdir. A directory under the workdir that is not there yet is created, parents included, at
mode `0700`, with symlinks resolved first so a link inside the workdir cannot be used to build a tree
outside it. Anywhere else it must already exist and be a directory, or the request is answered
`bad_request` with `working directory does not exist: <path>`. The client then runs the command under
`sh -c` in its own process group with `setsid`. Exit codes: **124** at the deadline, **128 + signal**
when signalled (143 for SIGTERM), **137** for a cancel, and **127** when the shell could not start.

`cancel`:

```json
{ "id": "…", "op": "cancel", "target_id": "…" }
```

`file_put` — one frame per chunk, in order, all sharing one `transfer_id`:

```json
{
  "id": "…",
  "op": "file_put",
  "transfer_id": "…",
  "path": "/abs/path",
  "seq": 0,
  "data_b64": "…",
  "final": false,
  "sha256": null
}
```

`sha256` is the hex digest of the whole file and is sent on the final chunk only. `seq` starts at 0. A
`seq` of 0 truncates or creates the file; later chunks append.

Chunks may arrive out of order — the client waits for a predecessor rather than failing — so a small
window may be pipelined. A transfer may not open at a `seq` of 32 or more, a chunk whose predecessor never
arrives abandons the transfer after 60 s with `bad_request`, and a redelivered chunk is idempotent. A
socket drop discards open uploads and deletes their partial files, so a transfer restarts from `seq` 0
after a reconnect rather than resuming.

`file_get`:

```json
{ "id": "…", "op": "file_get", "path": "/abs/path", "offset": 0, "max_bytes": 262144 }
```

### Replies (client → server)

Success:

```json
{ "id": "…", "result": { … } }
```

Failure:

```json
{ "id": "…", "error": { "code": "not_found", "message": "…" } }
```

A reply carries `result` or `error`, never both. The relay forwards `result` verbatim; only the caller
narrows it.

| Op         | `result`                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `exec`     | `exit_code`, `stdout`, `stderr`, `bytes_total`, `truncated`, `duration_ms`   |
| `cancel`   | `cancelled`                                                                  |
| `file_put` | `bytes_written`, `sha256` (non-null on the final chunk only)                 |
| `file_get` | `data_b64`, `eof`, `size`, `sha256` (non-null on the `offset: 0` chunk only) |

Error codes: `denied`, `read_only`, `queue_full`, `bad_request`, `not_found`, `is_a_directory`,
`frame_too_large`, `unknown_op`, `op_failed`, and `desktop_unavailable` from the desktop extension. The server maps `not_found` and `is_a_directory` onto
distinct sandbox errors, so they must stay separate; anything else reaches the caller verbatim.

`cancel` is always answered, with `{"cancelled": false}` for an id the client does not know. The client's
exec registry outlives the socket, so a `cancel` sent after a reconnect still reaches a command the
previous connection started.

### Output truncation

`stdout` and `stderr` are already-truncated strings. The client counts every byte in `bytes_total`, sets
`truncated`, and keeps **head and tail** within 1 MiB across both streams, with a
`\n[... N bytes dropped ...]\n` marker between them — build and test failures are at the end. There is no
wire change for truncation; the marker lives inside the strings.

The client clamps `file_get`'s `max_bytes` to 256 KiB whatever the server asks for, and refuses to send a
frame over 8 MiB with `frame_too_large`, because the platform enforces its own 32 MiB limit by closing
the socket rather than failing one request. A reply whose socket has closed is dropped rather than
written to the next one, so the server never receives an answer it has no pending request for.

The server confines `file_get` and `file_put` to the session's own directory, but that check is
**lexical**: it resolves `.` and `..` and compares prefixes. A symlink inside the session directory
that points out of it is invisible to the server, so the client refuses its own state directory and
is the only side that can see where a path really leads.

## 5. Concurrency and timeouts

The relay runs at most `MAX_IN_FLIGHT_EXEC` = 4 execs per computer and queues up to `MAX_QUEUE_DEPTH` =
32 more; beyond that a caller is refused at once. Non-`exec` ops are not capped.

A request's relay deadline is its own `timeout_ms` plus `RELAY_GRACE_MS` = 10,000 ms, so the client's own
exit 124 wins the race. On its deadline the relay sends a `cancel` for the request and gives up. While a
request waits, the relay re-checks the socket's last heartbeat every `STALENESS_POLL_MS` = 2,000 ms.

The server never re-runs a command whose answer was lost. A dropped socket, a replaced connection, a
revoke or a stale heartbeat all report the outcome as unknown — saying the command may still be
running — and the relay sends a `cancel` for that request id on the socket that next connects. A
relay **reset** is the exception: the object dies with its pending map, so those ids are not
remembered and no cancel follows; the command runs until its own `timeout_ms` deadline, which the
client enforces with exit 124. Either way a retry is a new request with a new id, never a reissue.

If the relay object is reset mid-request (a deploy, an eviction) the command keeps running on the machine
with nobody to collect it. The client must record its process-group ids and sweep them on startup, and a
service unit should use `KillMode=control-group`.

## 6. Client commands

```
trueforge-computer enroll --url <base> --code <code>
trueforge-computer run
```

`enroll` exchanges the code once and writes the credential; `run` dials and serves. The installer
one-liner is served by the server at `GET /install.sh`.

## 7. Desktop extension

A Linux client started with `--desktop`, or enrolled with `enroll --desktop` (stored as
`"desktop": true` in its `config.json`), runs a virtual X display: `Xvfb :<n> -screen 0 1280x800x24
-nolisten tcp -auth <state-dir>/desktop/Xauthority` and `openbox`, each restarted with backoff. `<n>` is
`--desktop-display`, 99 by default. Every `exec` gets `DISPLAY=:<n>` and
`XAUTHORITY=<state-dir>/desktop/Xauthority` in its base environment; the server does not send them.

### Capability

`hello.capabilities.desktop` is `true` only once the display answers, `xdotool` and `xclip` resolve on
`PATH`, and a Chromium sandbox self-test passes. When the desktop was requested but a check failed it is
`false` and `desktop_unavailable_reason` (at most 256 characters) says why; otherwise the reason is
`null`. Both default to "no desktop" when absent. The server sends the four ops below **only** to a
computer whose hello said `desktop: true`. The capability is decided once, before `hello`; a display that
dies later answers `desktop_unavailable` until the client restarts it.

### Ops

| op                      | request fields                                                  | `result`                                                   |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| `desktop_screenshot`    | `quality`: 1–95, or `null` for 60                               | `data_b64`, `width`, `height`, `media_type` (`image/jpeg`) |
| `desktop_input`         | `actions`: 1–64 `DesktopAction`s, run in order                  | `ok: true`                                                 |
| `desktop_clipboard_get` | none                                                            | `text` (`""` when nobody owns CLIPBOARD)                   |
| `desktop_clipboard_set` | `text` (≤ 65,536 UTF-8 bytes), `selections`: 1–2 unique entries | `ok: true`                                                 |

```json
{ "id": "…", "op": "desktop_input", "actions": [{ "type": "click", "x": 640, "y": 400, "button": "left", "count": 1 }] }
```

`DesktopAction` is discriminated on `type`, and each carries only its own fields:

- `mouse_move {x, y}`; `mouse_down {button}` and `mouse_up {button}` at the current pointer position;
- `click {x, y, button, count}`, count 1–3;
- `scroll {x, y, dx, dy}` in wheel clicks, `dy > 0` down and `dx > 0` right, each within ±50;
- `key {keys}`, one xdotool chord such as `ctrl+l` or `Return`, 1–64 characters and no whitespace;
- `type {text}`, 1–512 characters, typed with `xdotool type --delay 2`.

`button` is `left`, `middle` or `right`; `x` is 0–1279 and `y` 0–799, the fixed display in its own
pixels. `selections` entries are `clipboard` and `primary`. The clipboard is read as CLIPBOARD only.

### Errors and limits

- Anything outside the limits above is `bad_request`.
- A desktop op on a client with no running desktop is `desktop_unavailable`.
- A screenshot over 3 MiB of base64 is `too_large`, and so is a clipboard over 64 KiB on read.
- A `--read-only` client refuses `desktop_input` and `desktop_clipboard_set` with `read_only`. It still
  serves `desktop_screenshot` and `desktop_clipboard_get`.
- The server's timeouts are 5,000 ms for a screenshot, 3,000 ms for either clipboard op, and 2,000 ms
  plus 5 ms per typed character for `desktop_input`. The client bounds its own work to the same budgets.
- The client's audit log records a batch's action types and the clipboard's size, never typed text,
  key names or clipboard contents.

The shared fixtures are `testdata/protocol/server_to_client_desktop_*.json`,
`client_to_server_reply_desktop_*.json` and `client_to_server_hello_desktop*.json`.
