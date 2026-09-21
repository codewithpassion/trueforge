package runner_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"trueforge.dev/computer/internal/protocol"
	"trueforge.dev/computer/internal/runner"
)

func newTestRunner(t *testing.T, options runner.Options) *runner.Runner {
	t.Helper()
	if options.StateDir == "" {
		options.StateDir = t.TempDir()
	}
	if options.DefaultCwd == "" {
		options.DefaultCwd = t.TempDir()
	}
	return runner.New(options)
}

// run reports a refusal with Errorf rather than Fatalf, because several tests call it from a
// goroutine where Fatalf is not allowed.
func run(t *testing.T, r *runner.Runner, id string, command string, timeout time.Duration) protocol.ExecResult {
	t.Helper()
	result, err := r.Run(context.Background(), id, protocol.ExecRequest{
		Command:   command,
		TimeoutMS: timeout.Milliseconds(),
	})
	if err != nil {
		t.Errorf("run %s: %v", id, err)
	}
	return result
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestExitCodeAndStreamsAreSeparate(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	result := run(t, r, "a", "echo out; echo err 1>&2; exit 7", 5*time.Second)
	if result.ExitCode != 7 {
		t.Fatalf("exit code = %d, want 7", result.ExitCode)
	}
	if strings.TrimSpace(result.Stdout) != "out" || strings.TrimSpace(result.Stderr) != "err" {
		t.Fatalf("streams crossed: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	if result.Truncated {
		t.Fatal("a short command should not report truncation")
	}
}

func TestDeadlineReports124AndKillsTheGroup(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	marker := filepath.Join(t.TempDir(), "survivor")
	// The backgrounded child would create the marker a second later if it outlived the group.
	command := "(sleep 2; touch " + marker + ") & sleep 30"
	started := time.Now()
	result := run(t, r, "a", command, 500*time.Millisecond)
	if result.ExitCode != runner.ExitTimedOut {
		t.Fatalf("exit code = %d, want %d", result.ExitCode, runner.ExitTimedOut)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the deadline took %s to bite", elapsed)
	}
	time.Sleep(3 * time.Second)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a backgrounded child outlived the process group")
	}
}

// End to end: three megabytes of output is counted in full, capped, and keeps both ends.
func TestLargeOutputIsCountedAndTruncatedAtBothEnds(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	command := "echo FIRSTLINE; head -c 3000000 /dev/zero | tr '\\0' 'x'; echo; echo LASTLINE"
	result := run(t, r, "a", command, 60*time.Second)
	if !result.Truncated {
		t.Fatal("three megabytes should have been truncated")
	}
	if result.BytesTotal < 3_000_000 {
		t.Fatalf("bytes_total = %d, want every byte counted", result.BytesTotal)
	}
	if !strings.HasPrefix(result.Stdout, "FIRSTLINE") {
		t.Fatalf("the head was lost: %.40q", result.Stdout)
	}
	if !strings.HasSuffix(strings.TrimSpace(result.Stdout), "LASTLINE") {
		t.Fatalf("the tail was lost: %.40q", result.Stdout[len(result.Stdout)-40:])
	}
	if !strings.Contains(result.Stdout, "bytes dropped") {
		t.Fatal("the elision is not marked")
	}
	if len(result.Stdout) > protocol.ExecOutputMaxBytes {
		t.Fatalf("kept %d bytes, over the %d budget", len(result.Stdout), protocol.ExecOutputMaxBytes)
	}
}

func TestSignalledCommandReports128PlusSignal(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	result := run(t, r, "a", "kill -TERM $$", 5*time.Second)
	if result.ExitCode != 143 {
		t.Fatalf("exit code = %d, want 143", result.ExitCode)
	}
}

// A grandchild in its own session escapes the group kill and keeps the inherited pipes open.
// WaitDelay is what stops that from hanging the request forever.
func TestEscapedGrandchildCannotHangTheCall(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid is not available")
	}
	r := newTestRunner(t, runner.Options{WaitDelay: time.Second})
	started := time.Now()
	result := run(t, r, "a", "setsid sleep 30 & exit 0", 20*time.Second)
	elapsed := time.Since(started)
	if elapsed > 10*time.Second {
		t.Fatalf("the call took %s; WaitDelay did not bound it", elapsed)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0 — the shell itself exited cleanly", result.ExitCode)
	}
}

func TestCancelKillsTheGroup(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	done := make(chan protocol.ExecResult, 1)
	go func() {
		result, err := r.Run(context.Background(), "slow", protocol.ExecRequest{
			Command:   "sleep 60",
			TimeoutMS: 60_000,
		})
		if err != nil {
			t.Errorf("run: %v", err)
		}
		done <- result
	}()

	waitFor(t, 3*time.Second, func() bool { return r.InFlight() == 1 })
	if !r.Cancel("slow") {
		t.Fatal("cancel did not find the running command")
	}
	select {
	case result := <-done:
		if result.ExitCode != runner.ExitKilled {
			t.Fatalf("exit code = %d, want %d", result.ExitCode, runner.ExitKilled)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the cancelled command never returned")
	}
	if r.Cancel("slow") {
		t.Fatal("cancel found a command that had already finished")
	}
}

func TestFourRunInParallelAndTheFifthWaits(t *testing.T) {
	r := newTestRunner(t, runner.Options{MaxConcurrent: 4, MaxQueue: 32})
	var group sync.WaitGroup
	for index := range 4 {
		group.Add(1)
		go func() {
			defer group.Done()
			run(t, r, "slot-"+string(rune('a'+index)), "sleep 2", 20*time.Second)
		}()
	}
	waitFor(t, 5*time.Second, func() bool { return r.InFlight() == 4 })

	fifth := make(chan protocol.ExecResult, 1)
	go func() {
		fifth <- run(t, r, "fifth", "echo queued", 20*time.Second)
	}()
	waitFor(t, 5*time.Second, func() bool { return r.Queued() == 1 })

	select {
	case <-fifth:
		t.Fatal("the fifth command ran while four slots were busy")
	case <-time.After(300 * time.Millisecond):
	}

	group.Wait()
	select {
	case result := <-fifth:
		if strings.TrimSpace(result.Stdout) != "queued" {
			t.Fatalf("the fifth command produced %q", result.Stdout)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the fifth command never got a slot")
	}
}

func TestQueueFullIsRefused(t *testing.T) {
	r := newTestRunner(t, runner.Options{MaxConcurrent: 1, MaxQueue: 1})
	blocker := make(chan struct{})
	go func() {
		run(t, r, "blocker", "sleep 5", 20*time.Second)
		close(blocker)
	}()
	waitFor(t, 5*time.Second, func() bool { return r.InFlight() == 1 })

	go func() { run(t, r, "waiting", "true", 20*time.Second) }()
	waitFor(t, 5*time.Second, func() bool { return r.Queued() == 1 })

	_, err := r.Run(context.Background(), "overflow", protocol.ExecRequest{Command: "true", TimeoutMS: 1000})
	if !errors.Is(err, runner.ErrQueueFull) {
		t.Fatalf("error = %v, want ErrQueueFull", err)
	}

	r.Cancel("blocker")
	<-blocker
}

// A cancel that lands while the command is still queued has to remove it, not be ignored
// because nothing is running under that id yet.
func TestCancelWhileQueued(t *testing.T) {
	r := newTestRunner(t, runner.Options{MaxConcurrent: 1, MaxQueue: 4})
	go func() { run(t, r, "blocker", "sleep 5", 20*time.Second) }()
	waitFor(t, 5*time.Second, func() bool { return r.InFlight() == 1 })

	queued := make(chan protocol.ExecResult, 1)
	go func() { queued <- run(t, r, "waiting", "sleep 5", 20*time.Second) }()
	waitFor(t, 5*time.Second, func() bool { return r.Queued() == 1 })

	if !r.Cancel("waiting") {
		t.Fatal("cancel did not find the queued command")
	}
	select {
	case result := <-queued:
		if result.ExitCode != runner.ExitKilled {
			t.Fatalf("exit code = %d, want %d", result.ExitCode, runner.ExitKilled)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the queued command was not released")
	}
	r.Cancel("blocker")
}

func TestDuplicateRequestIDIsRefused(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	go func() { run(t, r, "same", "sleep 3", 20*time.Second) }()
	waitFor(t, 5*time.Second, func() bool { return r.InFlight() == 1 })

	_, err := r.Run(context.Background(), "same", protocol.ExecRequest{Command: "true", TimeoutMS: 1000})
	if !errors.Is(err, runner.ErrDuplicateID) {
		t.Fatalf("error = %v, want ErrDuplicateID", err)
	}
	r.Cancel("same")
}

func TestRequestCwdAndDefaultCwd(t *testing.T) {
	fallback := t.TempDir()
	r := newTestRunner(t, runner.Options{DefaultCwd: fallback})
	if got := strings.TrimSpace(run(t, r, "a", "pwd", 5*time.Second).Stdout); got != resolved(t, fallback) {
		t.Fatalf("default cwd = %q, want %q", got, resolved(t, fallback))
	}
	elsewhere := t.TempDir()
	result, err := r.Run(context.Background(), "b", protocol.ExecRequest{
		Command:   "pwd",
		Cwd:       &elsewhere,
		TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := strings.TrimSpace(result.Stdout); got != resolved(t, elsewhere) {
		t.Fatalf("request cwd = %q, want %q", got, resolved(t, elsewhere))
	}
}

// The command's environment is built from scratch, so nothing the daemon holds — least of all
// the machine credential — can be read back out of a command.
func TestEnvironmentIsScrubbed(t *testing.T) {
	t.Setenv("TRUEFORGE_MACHINE_CREDENTIAL", "super-secret")
	r := newTestRunner(t, runner.Options{})
	result, err := r.Run(context.Background(), "a", protocol.ExecRequest{
		Command:   "env",
		Env:       map[string]string{"FROM_REQUEST": "yes", "BAD=KEY": "dropped"},
		TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.Contains(result.Stdout, "super-secret") {
		t.Fatalf("the daemon's environment leaked into the command:\n%s", result.Stdout)
	}
	if !strings.Contains(result.Stdout, "FROM_REQUEST=yes") {
		t.Fatalf("the request's own variable is missing:\n%s", result.Stdout)
	}
	if strings.Contains(result.Stdout, "BAD=KEY") {
		t.Fatalf("a malformed variable name was accepted:\n%s", result.Stdout)
	}
}

func TestScrubbedEnvIsSortedAndMinimal(t *testing.T) {
	env := runner.ScrubbedEnv(nil)
	if len(env) != 4 {
		t.Fatalf("base environment = %v", env)
	}
	for index := 1; index < len(env); index++ {
		if env[index-1] > env[index] {
			t.Fatalf("environment is not sorted: %v", env)
		}
	}
}

// Killing the daemon leaves its commands running and reparented; the next start has to find
// and reap them from the records it wrote.
func TestSweepKillsGroupsLeftBehind(t *testing.T) {
	stateDir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "survivor")
	r := newTestRunner(t, runner.Options{StateDir: stateDir})
	go func() {
		run(t, r, "orphan", "sleep 1; touch "+marker, 30*time.Second)
	}()
	waitFor(t, 5*time.Second, func() bool { return countRecords(t, stateDir) == 1 })

	// Sweeping while our own command is running is exactly the startup case: the record names
	// a live group, so it is killed.
	if killed := runner.Sweep(stateDir, discardLogger()); killed != 1 {
		t.Fatalf("swept %d groups, want 1", killed)
	}
	time.Sleep(2 * time.Second)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the swept command kept running")
	}
	if countRecords(t, stateDir) != 0 {
		t.Fatal("the record outlived the sweep")
	}
}

func TestSweepIgnoresRecordsWhoseProcessIsGone(t *testing.T) {
	stateDir := t.TempDir()
	r := newTestRunner(t, runner.Options{StateDir: stateDir})
	run(t, r, "quick", "true", 5*time.Second)
	if countRecords(t, stateDir) != 0 {
		t.Fatal("a finished command left a record behind")
	}
	if killed := runner.Sweep(stateDir, discardLogger()); killed != 0 {
		t.Fatalf("swept %d groups, want 0", killed)
	}
}

func TestShutdownCancelsEverythingInFlight(t *testing.T) {
	r := newTestRunner(t, runner.Options{})
	done := make(chan protocol.ExecResult, 1)
	go func() { done <- run(t, r, "long", "sleep 60", 120*time.Second) }()
	waitFor(t, 5*time.Second, func() bool { return r.InFlight() == 1 })

	r.Shutdown()
	select {
	case result := <-done:
		if result.ExitCode != runner.ExitKilled {
			t.Fatalf("exit code = %d, want %d", result.ExitCode, runner.ExitKilled)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown left a command running")
	}
}

func waitFor(t *testing.T, limit time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition was not met within %s", limit)
}

func countRecords(t *testing.T, stateDir string) int {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(stateDir, "running"))
	if err != nil {
		return 0
	}
	return len(entries)
}

// resolved follows symlinks, because macOS puts temp dirs behind /var -> /private/var and pwd
// reports the resolved path.
func resolved(t *testing.T, path string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return real
}
