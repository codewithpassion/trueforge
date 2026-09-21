# Remote computers: wire contract v1

Frozen. The server half lives in `packages/trueforge/src/computers/protocol.ts`, which is the canonical
owner of every constant, schema and close code below. The Go client in `packages/trueforge-computer`
builds against this document. Changing any shape here breaks deployed clients; add a new
`protocol_version` instead.

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
still dispatches requests, but the server does not know the machine's capabilities, so skills stay off.

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

| Code | Meaning                           | Client behaviour                                |
| ---- | --------------------------------- | ----------------------------------------------- |
| 4401 | Revoked                           | **Terminal.** Log once, exit; do not reconnect. |
| 4409 | Replaced by a newer connection    | Reconnect with backoff.                         |
| 4408 | No heartbeat for `STALE_AFTER_MS` | Reconnect with backoff.                         |

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
  "capabilities": { "python3": true, "git": true }
}
```

`protocol_version` must be exactly `1`. A hello the server cannot parse — including a version it does not
speak — is ignored; the socket stays open and no new close code is introduced. Skills are mounted on a
computer only when `capabilities.python3` and `capabilities.git` are both true.

### Requests (server → client)

Every request is a `hello`-free JSON object with a string `id` minted by the server and a string `op`.
The client answers exactly one reply per `id`.

`exec`:

```json
{
  "id": "…",
  "op": "exec",
  "command": "uname -a",
  "cwd": "/home/trueforge/.trueforge/sessions/s1",
  "env": {},
  "timeout_ms": 120000
}
```

`cwd` is `null` when the server has no preference. The client runs the command under `sh -c` in its own
process group with `setsid`, kills the group at the deadline and reports exit **124**, and reports the
real signal-derived code otherwise (`kill -TERM $$` is 143, not 1).

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

Error codes the server maps to sandbox errors: `not_found`, `is_directory`, `too_large`. Anything else is
reported to the caller verbatim.

### Output truncation

`stdout` and `stderr` are already-truncated strings. The client counts every byte in `bytes_total`, sets
`truncated`, and keeps **head and tail** with a visible elision marker between them — build and test
failures are at the end. There is no wire change for truncation; the marker lives inside the strings.

## 5. Concurrency and timeouts

The relay runs at most `MAX_IN_FLIGHT_EXEC` = 4 execs per computer and queues up to `MAX_QUEUE_DEPTH` =
32 more; beyond that a caller is refused at once. Non-`exec` ops are not capped.

A request's relay deadline is its own `timeout_ms` plus `RELAY_GRACE_MS` = 10,000 ms, so the client's own
exit 124 wins the race. On its deadline the relay sends a `cancel` for the request and gives up. While a
request waits, the relay re-checks the socket's last heartbeat every `STALENESS_POLL_MS` = 2,000 ms.

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
