package agent_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"trueforge.dev/computer/internal/agent"
	"trueforge.dev/computer/internal/audit"
	"trueforge.dev/computer/internal/files"
	"trueforge.dev/computer/internal/policy"
	"trueforge.dev/computer/internal/protocol"
	"trueforge.dev/computer/internal/runner"
)

type harness struct {
	agent    *agent.Agent
	stateDir string
	workdir  string
}

func newHarness(t *testing.T, options policy.Options) *harness {
	t.Helper()
	stateDir := t.TempDir()
	workdir := filepath.Join(stateDir, "sessions")
	if err := os.MkdirAll(workdir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if options.Workdir == "" {
		options.Workdir = workdir
	}
	rules, err := policy.New(options)
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	log, err := audit.Open(stateDir)
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	t.Cleanup(func() { _ = log.Close() })
	commands := runner.New(runner.Options{
		StateDir:   stateDir,
		DefaultCwd: workdir,
		Logger:     discardLogger(),
	})
	return &harness{
		agent:    agent.New(rules, commands, files.NewTransfers(), log, discardLogger()),
		stateDir: stateDir,
		workdir:  options.Workdir,
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (h *harness) dispatch(t *testing.T, id string, op string, body map[string]any) protocol.Reply {
	t.Helper()
	body["id"] = id
	body["op"] = op
	frame, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	answer := h.agent.Dispatch(context.Background(), protocol.Envelope{ID: id, Op: op}, frame)
	var reply protocol.Reply
	if err := json.Unmarshal(answer, &reply); err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	if reply.ID != id {
		t.Fatalf("reply id = %q, want %q", reply.ID, id)
	}
	return reply
}

func (h *harness) auditEntries(t *testing.T) []audit.Entry {
	t.Helper()
	file, err := os.Open(filepath.Join(h.stateDir, audit.FileName))
	if err != nil {
		t.Fatalf("open audit log: %v", err)
	}
	defer func() { _ = file.Close() }()
	var entries []audit.Entry
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var entry audit.Entry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("decode audit line: %v", err)
		}
		entries = append(entries, entry)
	}
	return entries
}

func execResultOf(t *testing.T, reply protocol.Reply) protocol.ExecResult {
	t.Helper()
	if reply.Error != nil {
		t.Fatalf("unexpected error reply: %+v", reply.Error)
	}
	var result protocol.ExecResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode exec result: %v", err)
	}
	return result
}

func TestExecRunsAndIsAudited(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "echo hello", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	result := execResultOf(t, reply)
	if strings.TrimSpace(result.Stdout) != "hello" || result.ExitCode != 0 {
		t.Fatalf("result = %+v", result)
	}
	entries := h.auditEntries(t)
	if len(entries) != 1 {
		t.Fatalf("wrote %d audit entries", len(entries))
	}
	if entries[0].Op != protocol.OpExec || entries[0].Outcome != audit.OutcomeOK || entries[0].Command != "echo hello" {
		t.Fatalf("audit entry = %+v", entries[0])
	}
}

// The deny list is enforced here, not asked of the server: a compromised relay cannot lift it.
func TestDeniedCommandIsRefusedAndAudited(t *testing.T) {
	h := newHarness(t, policy.Options{Deny: []string{`\brm\s+-rf\b`}})
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "rm -rf /", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
		t.Fatalf("reply = %+v", reply)
	}
	entries := h.auditEntries(t)
	if len(entries) != 1 || entries[0].Outcome != audit.OutcomeDenied {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestReadOnlyRefusesExecAndWrites(t *testing.T) {
	h := newHarness(t, policy.Options{ReadOnly: true})
	execReply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "echo hi", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if execReply.Error == nil || execReply.Error.Code != protocol.ErrDenied {
		t.Fatalf("exec reply = %+v", execReply)
	}
	putReply := h.dispatch(t, "r2", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": filepath.Join(h.workdir, "f"), "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString([]byte("x")), "final": true, "sha256": nil,
	})
	if putReply.Error == nil || putReply.Error.Code != protocol.ErrReadOnly {
		t.Fatalf("file_put reply = %+v", putReply)
	}

	// Reads still work, which is the point of read-only rather than disconnected.
	target := filepath.Join(h.workdir, "readable")
	if err := os.WriteFile(target, []byte("visible"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	getReply := h.dispatch(t, "r3", protocol.OpFileGet, map[string]any{
		"path": target, "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if getReply.Error != nil {
		t.Fatalf("file_get reply = %+v", getReply.Error)
	}
}

func TestWorkdirOnlyRefusesAPathOutside(t *testing.T) {
	h := newHarness(t, policy.Options{WorkdirOnly: true})
	reply := h.dispatch(t, "r1", protocol.OpFileGet, map[string]any{
		"path": "/etc/hosts", "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
		t.Fatalf("reply = %+v", reply)
	}
	if entries := h.auditEntries(t); len(entries) != 1 || entries[0].Outcome != audit.OutcomeDenied {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestFileRoundTripThroughTheAgent(t *testing.T) {
	h := newHarness(t, policy.Options{WorkdirOnly: true})
	payload := []byte("a small file that fits in one chunk")
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	target := filepath.Join(h.workdir, "s1", "uploads", "file.txt")

	putReply := h.dispatch(t, "r1", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": target, "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString(payload), "final": true, "sha256": digest,
	})
	if putReply.Error != nil {
		t.Fatalf("file_put = %+v", putReply.Error)
	}
	getReply := h.dispatch(t, "r2", protocol.OpFileGet, map[string]any{
		"path": target, "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if getReply.Error != nil {
		t.Fatalf("file_get = %+v", getReply.Error)
	}
	var result protocol.FileGetResult
	if err := json.Unmarshal(getReply.Result, &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.DataB64)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if string(decoded) != string(payload) {
		t.Fatalf("round trip differs: %q", decoded)
	}
	if result.SHA256 == nil || *result.SHA256 != digest {
		t.Fatalf("digest = %v", result.SHA256)
	}
}

func TestDigestMismatchComesBackAsBadRequest(t *testing.T) {
	h := newHarness(t, policy.Options{})
	wrong := strings.Repeat("0", 64)
	reply := h.dispatch(t, "r1", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": filepath.Join(h.workdir, "f"), "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString([]byte("x")), "final": true, "sha256": wrong,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
}

// A cancel arriving under a request id the runner never saw is answered, not dropped.
func TestCancelOfAnUnknownCommandIsAnswered(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", protocol.OpCancel, map[string]any{"target_id": "nothing"})
	if reply.Error != nil {
		t.Fatalf("reply = %+v", reply.Error)
	}
	var result protocol.CancelResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.Cancelled {
		t.Fatal("an unknown target reported as cancelled")
	}
}

func TestCancelStopsARunningCommand(t *testing.T) {
	h := newHarness(t, policy.Options{})
	done := make(chan protocol.Reply, 1)
	go func() {
		frame, _ := json.Marshal(map[string]any{
			"id": "slow", "op": protocol.OpExec, "command": "sleep 30",
			"cwd": nil, "env": map[string]string{}, "timeout_ms": 60000,
		})
		answer := h.agent.Dispatch(context.Background(), protocol.Envelope{ID: "slow", Op: protocol.OpExec}, frame)
		var reply protocol.Reply
		_ = json.Unmarshal(answer, &reply)
		done <- reply
	}()
	time.Sleep(500 * time.Millisecond)

	cancelReply := h.dispatch(t, "c1", protocol.OpCancel, map[string]any{"target_id": "slow"})
	var cancelled protocol.CancelResult
	if err := json.Unmarshal(cancelReply.Result, &cancelled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !cancelled.Cancelled {
		t.Fatal("the running command was not found")
	}
	select {
	case reply := <-done:
		result := execResultOf(t, reply)
		if result.ExitCode != runner.ExitKilled {
			t.Fatalf("exit code = %d", result.ExitCode)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the cancelled command never returned")
	}
}

func TestUnknownOpIsAnswered(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", "teleport", map[string]any{})
	if reply.Error == nil || reply.Error.Code != protocol.ErrUnknownOp {
		t.Fatalf("reply = %+v", reply)
	}
}

func TestMalformedBodyIsAnswered(t *testing.T) {
	h := newHarness(t, policy.Options{})
	answer := h.agent.Dispatch(context.Background(),
		protocol.Envelope{ID: "r1", Op: protocol.OpExec},
		[]byte(`{"id":"r1","op":"exec","timeout_ms":"not a number"}`))
	var reply protocol.Reply
	if err := json.Unmarshal(answer, &reply); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
}

// The audit log records what an agent did; environment values are not part of that, because
// they carry the caller's secrets.
func TestAuditNeverRecordsEnvironmentValues(t *testing.T) {
	h := newHarness(t, policy.Options{})
	h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "true", "cwd": nil,
		"env":        map[string]string{"SECRET_TOKEN": "sk-do-not-log-me"},
		"timeout_ms": 5000,
	})
	raw, err := os.ReadFile(filepath.Join(h.stateDir, audit.FileName))
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if strings.Contains(string(raw), "sk-do-not-log-me") {
		t.Fatalf("an environment value reached the audit log:\n%s", raw)
	}
}
