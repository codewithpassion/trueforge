// Package runner executes one shell command per request in its own session and process group,
// so a deadline or a cancel takes every descendant with it.
package runner

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"trueforge.dev/computer/internal/protocol"
)

const (
	// ExitTimedOut is the convention for a command killed at its deadline.
	ExitTimedOut = 124
	// ExitKilled is what a command killed by a cancel reports, the same 128+SIGKILL a shell
	// would show, so a cancel that arrived before the command started reads the same way.
	ExitKilled = 137
)

// ErrQueueFull means the waiting room is full; the caller answers the relay rather than
// letting a stalled machine grow an unbounded backlog.
var ErrQueueFull = errors.New("too many commands are already queued")

// ErrDuplicateID means the relay reused a request id that is still running.
var ErrDuplicateID = errors.New("a command with this request id is already running")

type Options struct {
	// MaxConcurrent mirrors the relay's own cap; the client enforces it too, because a
	// compromised server must not be able to lift it.
	MaxConcurrent int
	MaxQueue      int
	// DefaultTimeout applies when the relay sends no deadline.
	DefaultTimeout time.Duration
	// WaitDelay bounds Wait once the command has exited, so a grandchild that escaped the
	// group and still holds the pipes cannot hang the request forever.
	WaitDelay time.Duration
	// DefaultCwd is used when the request carries no cwd.
	DefaultCwd string
	// StateDir holds the process-group records the next start sweeps.
	StateDir string
	Logger   *slog.Logger
}

type Runner struct {
	options Options
	slots   chan struct{}
	records *records

	mu      sync.Mutex
	queued  int
	running map[string]context.CancelFunc
}

func New(options Options) *Runner {
	if options.MaxConcurrent <= 0 {
		options.MaxConcurrent = 4
	}
	if options.MaxQueue <= 0 {
		options.MaxQueue = 32
	}
	if options.DefaultTimeout <= 0 {
		options.DefaultTimeout = 30 * time.Second
	}
	if options.WaitDelay <= 0 {
		options.WaitDelay = 2 * time.Second
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Runner{
		options: options,
		slots:   make(chan struct{}, options.MaxConcurrent),
		records: newRecords(options.StateDir),
		running: map[string]context.CancelFunc{},
	}
}

// Cancel kills a running command, or aborts one that is still queued. It reports whether the
// id was known.
func (r *Runner) Cancel(id string) bool {
	r.mu.Lock()
	cancel, known := r.running[id]
	r.mu.Unlock()
	if !known {
		return false
	}
	cancel()
	return true
}

// Shutdown cancels everything in flight and then kills the recorded groups directly. The
// cancel alone is not enough: it only wakes the goroutine that would do the killing, and the
// process can exit before that goroutine is scheduled, leaving the commands reparented to
// PID 1 — which is exactly what the spike measured.
func (r *Runner) Shutdown() {
	r.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(r.running))
	for _, cancel := range r.running {
		cancels = append(cancels, cancel)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	Sweep(r.options.StateDir, r.options.Logger)
}

// InFlight reports how many commands hold a slot, for status output and tests.
func (r *Runner) InFlight() int {
	return len(r.slots)
}

// Queued reports how many commands are waiting for a slot.
func (r *Runner) Queued() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.queued
}

// Run executes one request. The only error it returns is a refusal to accept the work at all;
// everything that happens to the command itself comes back as a result.
func (r *Runner) Run(ctx context.Context, id string, request protocol.ExecRequest) (protocol.ExecResult, error) {
	startedAt := time.Now()

	commandCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	r.mu.Lock()
	if _, duplicate := r.running[id]; duplicate {
		r.mu.Unlock()
		return protocol.ExecResult{}, ErrDuplicateID
	}
	if r.queued >= r.options.MaxQueue {
		r.mu.Unlock()
		return protocol.ExecResult{}, ErrQueueFull
	}
	r.queued++
	r.running[id] = cancel
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		delete(r.running, id)
		r.mu.Unlock()
	}()

	// Registered before waiting for a slot, so a cancel that arrives while the command is
	// still queued removes it instead of being ignored.
	select {
	case r.slots <- struct{}{}:
		r.mu.Lock()
		r.queued--
		r.mu.Unlock()
		defer func() { <-r.slots }()
	case <-commandCtx.Done():
		r.mu.Lock()
		r.queued--
		r.mu.Unlock()
		return protocol.ExecResult{
			ExitCode:   ExitKilled,
			Stderr:     "cancelled while queued",
			DurationMS: time.Since(startedAt).Milliseconds(),
		}, nil
	}

	return r.execute(commandCtx, id, request, startedAt), nil
}

func (r *Runner) execute(ctx context.Context, id string, request protocol.ExecRequest, startedAt time.Time) protocol.ExecResult {
	timeout := time.Duration(request.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = r.options.DefaultTimeout
	}

	command := exec.Command("/bin/sh", "-c", request.Command)
	// Setsid puts the command in its own session and process group, so the group kill reaches
	// descendants that the shell itself backgrounded.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	command.Dir = r.workingDirectory(request)
	command.Env = ScrubbedEnv(request.Env)
	command.WaitDelay = r.options.WaitDelay

	stdout := newCapped(headCap, tailCap)
	stderr := newCapped(headCap, tailCap)
	command.Stdout = stdout
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return protocol.ExecResult{
			ExitCode:   127,
			Stderr:     err.Error(),
			DurationMS: time.Since(startedAt).Milliseconds(),
		}
	}
	pgid := command.Process.Pid
	if err := r.records.add(pgid, id, request.Command); err != nil {
		r.options.Logger.Warn("could not record the process group", "error", err.Error(), "pgid", pgid)
	}
	defer r.records.remove(pgid)

	done := make(chan error, 1)
	go func() { done <- command.Wait() }()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	timedOut := false
	select {
	case <-done:
	case <-deadline.C:
		timedOut = true
		killGroup(pgid)
		<-done
	case <-ctx.Done():
		killGroup(pgid)
		<-done
	}

	outText, outTotal, outTruncated := stdout.snapshot()
	errText, errTotal, errTruncated := stderr.snapshot()
	result := protocol.ExecResult{
		Stdout:     outText,
		Stderr:     errText,
		BytesTotal: outTotal + errTotal,
		Truncated:  outTruncated || errTruncated,
		DurationMS: time.Since(startedAt).Milliseconds(),
		ExitCode:   exitCodeOf(command),
	}
	if timedOut {
		result.ExitCode = ExitTimedOut
	}
	return result
}

// workingDirectory prefers the per-session directory the relay passes and falls back to the
// configured default, never to the daemon's own directory.
func (r *Runner) workingDirectory(request protocol.ExecRequest) string {
	if request.Cwd != nil && *request.Cwd != "" {
		return *request.Cwd
	}
	return r.options.DefaultCwd
}

// exitCodeOf reads the exit status from the process rather than from Wait's error, because
// WaitDelay reports a pipe that outlived the command as an error even on a clean exit. A
// signalled command reports 128+signal, which is what a shell and CI both expect.
func exitCodeOf(command *exec.Cmd) int {
	state := command.ProcessState
	if state == nil {
		return 1
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return state.ExitCode()
	}
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}

// ScrubbedEnv builds the command environment: a minimal base plus the request's overrides. The
// daemon's own environment, and with it the machine credential, is never inherited.
func ScrubbedEnv(overrides map[string]string) []string {
	base := map[string]string{
		"PATH": envOr("PATH", "/usr/local/bin:/usr/bin:/bin"),
		"HOME": envOr("HOME", "/tmp"),
		"LANG": envOr("LANG", "C.UTF-8"),
		"TERM": "dumb",
	}
	for key, value := range overrides {
		if key == "" || strings.ContainsAny(key, "=\x00") {
			continue
		}
		base[key] = value
	}
	out := make([]string, 0, len(base))
	for key, value := range base {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

func envOr(name string, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && value != "" {
		return value
	}
	return fallback
}
