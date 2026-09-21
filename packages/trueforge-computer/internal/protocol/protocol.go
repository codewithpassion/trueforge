// Package protocol is the frozen v1 wire contract between a computer and the TrueForge relay:
// one JSON text frame per message, snake_case fields. The golden fixtures under
// testdata/protocol are the shared reference for the server's schemas.
package protocol

import "encoding/json"

// Version rides on hello so a relay can refuse a client it cannot speak to.
const Version = 1

// Heartbeats are bare literals so the relay's auto-response can answer them without
// waking its Durable Object.
const (
	HeartbeatPing = "ping"
	HeartbeatPong = "pong"
)

// HeartbeatIntervalMS is how often the client pings. A socket that misses two answers is
// half-open, which no amount of TCP state will reveal.
const HeartbeatIntervalMS = 10_000

// Close codes. Each one means a different thing to the reconnect loop.
const (
	// CloseRevoked is terminal: the credential is gone and retrying only hammers the server.
	CloseRevoked = 4401
	// CloseStale means the relay stopped hearing heartbeats; reconnecting is correct.
	CloseStale = 4408
	// CloseReplaced means a newer connection took over. Two clients sharing one credential
	// evict each other forever unless the loser waits a long time.
	CloseReplaced = 4409
)

// Sizes. The platform closes the whole socket on an oversized frame rather than failing one
// request, so every write is guarded well below the ceiling.
const (
	// ChunkBytes is the raw payload per file chunk, before base64.
	ChunkBytes = 256 * 1024
	// PlatformMaxFrameBytes was measured at 33,554,432 bytes during the Phase 8a spike.
	PlatformMaxFrameBytes = 32 << 20
	// MaxFrameBytes is the client's own refusal point. JSON escaping can multiply a capped
	// 1 MiB of output several times over, so the guard sits far under the platform limit.
	MaxFrameBytes = 8 << 20
	// ExecOutputMaxBytes is the head-plus-tail budget across both streams of one command.
	ExecOutputMaxBytes = 1 << 20
)

// Ops the relay may send.
const (
	OpExec    = "exec"
	OpCancel  = "cancel"
	OpFilePut = "file_put"
	OpFileGet = "file_get"
)

// Error codes carried back in a reply. The relay forwards them verbatim.
const (
	ErrBadRequest     = "bad_request"
	ErrOpFailed       = "op_failed"
	ErrQueueFull      = "queue_full"
	ErrDenied         = "denied"
	ErrReadOnly       = "read_only"
	ErrFrameTooBig    = "frame_too_large"
	ErrUnknownOp      = "unknown_op"
	ErrNotFound       = "not_found"
	ErrIsADirectory   = "is_a_directory"
	ErrTooLarge       = "too_large"
	ErrNotRegularFile = "not_a_regular_file"
)

// Capabilities are the tools the server needs before it will mount skills.
type Capabilities struct {
	Python3 bool `json:"python3"`
	Git     bool `json:"git"`
}

// Hello is the first frame the client sends after the upgrade.
type Hello struct {
	Type            string       `json:"type"`
	ProtocolVersion int          `json:"protocol_version"`
	Hostname        string       `json:"hostname"`
	OS              string       `json:"os"`
	Arch            string       `json:"arch"`
	Version         string       `json:"version"`
	RunAsUser       string       `json:"run_as_user"`
	Capabilities    Capabilities `json:"capabilities"`
}

// Envelope is the common head of every server request; the op-specific fields are decoded
// from the same frame a second time.
type Envelope struct {
	ID string `json:"id"`
	Op string `json:"op"`
}

type ExecRequest struct {
	Command   string            `json:"command"`
	Cwd       *string           `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMS int64             `json:"timeout_ms"`
}

type CancelRequest struct {
	TargetID string `json:"target_id"`
}

type FilePutRequest struct {
	TransferID string `json:"transfer_id"`
	Path       string `json:"path"`
	Seq        int    `json:"seq"`
	DataB64    string `json:"data_b64"`
	Final      bool   `json:"final"`
	// SHA256 is the hex digest of the whole file, sent on the final chunk only.
	SHA256 *string `json:"sha256"`
}

type FileGetRequest struct {
	Path     string `json:"path"`
	Offset   int64  `json:"offset"`
	MaxBytes int    `json:"max_bytes"`
}

type ExecResult struct {
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	BytesTotal int64  `json:"bytes_total"`
	Truncated  bool   `json:"truncated"`
	DurationMS int64  `json:"duration_ms"`
}

type CancelResult struct {
	Cancelled bool `json:"cancelled"`
}

type FilePutResult struct {
	BytesWritten int64 `json:"bytes_written"`
	// SHA256 is present on the final chunk once the client has verified the whole-file digest.
	SHA256 *string `json:"sha256"`
}

type FileGetResult struct {
	DataB64 string `json:"data_b64"`
	EOF     bool   `json:"eof"`
	Size    int64  `json:"size"`
	// SHA256 is the whole-file digest, returned with the first window (offset 0) only.
	SHA256 *string `json:"sha256"`
}

type ReplyError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Reply carries exactly one of Result or Error.
type Reply struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *ReplyError     `json:"error,omitempty"`
}

// EncodeOK renders a successful reply. The result is marshalled first so a shape that cannot
// be encoded fails here rather than producing a half-written frame.
func EncodeOK(id string, result any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Reply{ID: id, Result: encoded})
}

// EncodeError renders a failure reply. It never returns an error, because the socket must stay
// answerable even when the caller is already handling one.
func EncodeError(id string, code string, message string) []byte {
	encoded, err := json.Marshal(Reply{ID: id, Error: &ReplyError{Code: code, Message: message}})
	if err != nil {
		fallback, fallbackErr := json.Marshal(Reply{ID: id, Error: &ReplyError{Code: ErrOpFailed, Message: "reply encoding failed"}})
		if fallbackErr != nil {
			return []byte(`{"id":"","error":{"code":"op_failed","message":"reply encoding failed"}}`)
		}
		return fallback
	}
	return encoded
}
