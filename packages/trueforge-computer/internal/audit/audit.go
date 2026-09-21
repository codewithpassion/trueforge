// Package audit writes one JSON line per operation to a file the machine's owner controls,
// so what an agent did here is readable without the server's cooperation.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileName is the audit log inside the state directory.
const FileName = "audit.jsonl"

// commandLimit matches the server's own truncation of the recorded command.
const commandLimit = 4096

// Entry is one operation. Environment values are deliberately absent: they can carry the
// caller's secrets and the log is plain text on disk.
type Entry struct {
	Time       string `json:"time"`
	Op         string `json:"op"`
	RequestID  string `json:"request_id"`
	Outcome    string `json:"outcome"`
	Command    string `json:"command,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Path       string `json:"path,omitempty"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	Bytes      int64  `json:"bytes,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Outcomes an entry can record.
const (
	OutcomeOK           = "ok"
	OutcomeDenied       = "denied"
	OutcomeError        = "error"
	OutcomeReplyDropped = "reply_dropped"
)

type Log struct {
	mu   sync.Mutex
	file *os.File
}

// Open creates the log with owner-only permissions. A machine can be shared, and the command
// lines an agent ran are not for every local user to read.
func Open(stateDir string) (*Log, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", stateDir, err)
	}
	path := filepath.Join(stateDir, FileName)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	// An existing log may predate this rule, or have been created with a wider umask.
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("restrict %s: %w", path, err)
	}
	return &Log{file: file}, nil
}

func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.file.Close()
}

// Record appends one entry. A failure to write is not allowed to fail the operation, so it is
// reported and swallowed by the caller's logger instead.
func (l *Log) Record(entry Entry) error {
	if entry.Time == "" {
		entry.Time = time.Now().UTC().Format(time.RFC3339Nano)
	}
	entry.Command = truncate(entry.Command, commandLimit)
	encoded, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encode audit entry: %w", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, err := l.file.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("write audit entry: %w", err)
	}
	return nil
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
