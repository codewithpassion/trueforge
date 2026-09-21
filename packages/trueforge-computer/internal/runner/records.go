package runner

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// recordsDirName holds one file per running process group. Killing the daemon leaves its
// commands alive and reparented to PID 1, so the next start has to find and reap them.
const recordsDirName = "running"

type groupRecord struct {
	PGID      int    `json:"pgid"`
	RequestID string `json:"request_id"`
	Command   string `json:"command"`
	StartedAt string `json:"started_at"`
	// StartTime is the kernel's start tick for the group leader, which distinguishes the
	// process we started from a later one that reused its pid. Zero where unavailable.
	StartTime uint64 `json:"start_time"`
}

type records struct {
	dir string
}

func newRecords(stateDir string) *records {
	return &records{dir: filepath.Join(stateDir, recordsDirName)}
}

func (r *records) add(pgid int, requestID string, command string) error {
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", r.dir, err)
	}
	startTime, _ := processStartTime(pgid)
	encoded, err := json.Marshal(groupRecord{
		PGID:      pgid,
		RequestID: requestID,
		Command:   truncate(command, 4096),
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		StartTime: startTime,
	})
	if err != nil {
		return fmt.Errorf("encode group record: %w", err)
	}
	return os.WriteFile(r.path(pgid), encoded, 0o600)
}

func (r *records) remove(pgid int) {
	_ = os.Remove(r.path(pgid))
}

func (r *records) path(pgid int) string {
	return filepath.Join(r.dir, strconv.Itoa(pgid)+".json")
}

// Sweep kills the process groups left behind by a previous run and clears their records. It
// returns how many groups it signalled.
func Sweep(stateDir string, logger *slog.Logger) int {
	store := newRecords(stateDir)
	entries, err := os.ReadDir(store.dir)
	if err != nil {
		return 0
	}
	killed := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(store.dir, entry.Name())
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		var record groupRecord
		if json.Unmarshal(raw, &record) != nil || record.PGID <= 1 {
			_ = os.Remove(path)
			continue
		}
		if !stillOurs(record) {
			_ = os.Remove(path)
			continue
		}
		killGroup(record.PGID)
		killed++
		logger.Warn("killed a command left behind by a previous run",
			"pgid", record.PGID, "request_id", record.RequestID, "command", record.Command)
		_ = os.Remove(path)
	}
	return killed
}

// stillOurs decides whether the recorded group is the one we started. Where the kernel's start
// tick is readable the check is exact; elsewhere it is existence only, which can in principle
// match a recycled pid.
func stillOurs(record groupRecord) bool {
	if syscall.Kill(-record.PGID, 0) != nil {
		return false
	}
	if record.StartTime == 0 {
		return true
	}
	current, ok := processStartTime(record.PGID)
	if !ok {
		return true
	}
	return current == record.StartTime
}

func killGroup(pgid int) {
	// A negative pid addresses the whole group, so descendants die with the shell.
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
