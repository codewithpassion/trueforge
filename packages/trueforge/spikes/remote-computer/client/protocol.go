package main

import "encoding/json"

// Heartbeats are bare literals so the relay's setWebSocketAutoResponse can answer them
// without waking the Durable Object.
const (
	heartbeatPing = "ping"
	heartbeatPong = "pong"
)

// closeRevoked is terminal: the credential is gone and retrying only hammers the server.
const (
	closeRevoked  = 4401
	closeReplaced = 4409
)

type helloMessage struct {
	Type         string       `json:"type"`
	Hostname     string       `json:"hostname"`
	OS           string       `json:"os"`
	Arch         string       `json:"arch"`
	Version      string       `json:"version"`
	RunAsUser    string       `json:"run_as_user"`
	Capabilities capabilities `json:"capabilities"`
}

type capabilities struct {
	Python3 bool `json:"python3"`
	Git     bool `json:"git"`
}

// envelope is the common head of every server request; the op-specific fields are
// decoded from the same frame a second time.
type envelope struct {
	ID string `json:"id"`
	Op string `json:"op"`
}

type execRequest struct {
	Command   string            `json:"command"`
	Cwd       *string           `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMS int64             `json:"timeout_ms"`
}

type cancelRequest struct {
	TargetID string `json:"target_id"`
}

type filePutRequest struct {
	TransferID string  `json:"transfer_id"`
	Path       string  `json:"path"`
	Seq        int     `json:"seq"`
	DataB64    string  `json:"data_b64"`
	Final      bool    `json:"final"`
	SHA256     *string `json:"sha256"`
}

type fileGetRequest struct {
	Path     string `json:"path"`
	Offset   int64  `json:"offset"`
	MaxBytes int    `json:"max_bytes"`
}

type probeRequest struct {
	PayloadB64 string `json:"payload_b64"`
	EchoBytes  int    `json:"echo_bytes"`
}

type execResult struct {
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	BytesTotal int64  `json:"bytes_total"`
	Truncated  bool   `json:"truncated"`
	DurationMS int64  `json:"duration_ms"`
}

type cancelResult struct {
	Cancelled bool `json:"cancelled"`
}

type filePutResult struct {
	BytesWritten int64   `json:"bytes_written"`
	SHA256       *string `json:"sha256"`
}

type fileGetResult struct {
	DataB64 string  `json:"data_b64"`
	EOF     bool    `json:"eof"`
	Size    int64   `json:"size"`
	SHA256  *string `json:"sha256"`
}

type probeResult struct {
	ReceivedBytes int    `json:"received_bytes"`
	EchoB64       string `json:"echo_b64"`
}

type replyError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type reply struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *replyError     `json:"error,omitempty"`
}

func okReply(id string, result any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(reply{ID: id, Result: encoded})
}

func errorReply(id string, code string, message string) []byte {
	encoded, err := json.Marshal(reply{ID: id, Error: &replyError{Code: code, Message: message}})
	if err != nil {
		// A marshal failure of a two-string struct cannot happen; keep the socket answerable anyway.
		return []byte(`{"id":"` + id + `","error":{"code":"internal","message":"reply encoding failed"}}`)
	}
	return encoded
}
