package main

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// outputCapMaxBytes matches COMPUTER_EXEC_OUTPUT_MAX_BYTES: everything is counted, the head is kept.
const outputCapMaxBytes = 1 << 20

// exitTimedOut is the convention for a command killed at its deadline.
const exitTimedOut = 124

// killGraceAfterDeadline gives the group a moment to die before Wait stops waiting on inherited pipes.
const killGraceAfterDeadline = 2 * time.Second

// cappedBuffer counts every byte written and keeps the head up to the cap.
type cappedBuffer struct {
	mu    sync.Mutex
	head  bytes.Buffer
	total int64
	cap   int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.total += int64(len(p))
	if remaining := b.cap - b.head.Len(); remaining > 0 {
		if len(p) <= remaining {
			b.head.Write(p)
		} else {
			b.head.Write(p[:remaining])
		}
	}
	return len(p), nil
}

func (b *cappedBuffer) snapshot() (string, int64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.head.String(), b.total, b.total > int64(b.head.Len())
}

// runner owns the cancel funcs of the commands currently running, keyed by request id.
type runner struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func newRunner() *runner {
	return &runner{running: map[string]context.CancelFunc{}}
}

func (r *runner) cancel(id string) bool {
	r.mu.Lock()
	cancel, ok := r.running[id]
	r.mu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

func (r *runner) track(id string, cancel context.CancelFunc) {
	r.mu.Lock()
	r.running[id] = cancel
	r.mu.Unlock()
}

func (r *runner) forget(id string) {
	r.mu.Lock()
	delete(r.running, id)
	r.mu.Unlock()
}

// run executes the command under `sh -c` in its own process group, so the deadline or a cancel kills
// every descendant rather than only the shell.
func (r *runner) run(id string, request execRequest) execResult {
	startedAt := time.Now()
	timeout := time.Duration(request.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.track(id, cancel)
	defer r.forget(id)

	command := exec.Command("/bin/sh", "-c", request.Command)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if request.Cwd != nil && *request.Cwd != "" {
		command.Dir = *request.Cwd
	}
	command.Env = scrubbedEnv(request.Env)
	// Bounds Wait even when a grandchild escapes the group and holds the pipes open.
	command.WaitDelay = killGraceAfterDeadline

	stdout := &cappedBuffer{cap: outputCapMaxBytes / 2}
	stderr := &cappedBuffer{cap: outputCapMaxBytes / 2}
	command.Stdout = stdout
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return execResult{
			ExitCode:   127,
			Stderr:     err.Error(),
			DurationMS: time.Since(startedAt).Milliseconds(),
		}
	}
	pgid := command.Process.Pid

	timedOut := false
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()

	var waitErr error
	select {
	case waitErr = <-done:
	case <-deadline.C:
		timedOut = true
		killGroup(pgid)
		waitErr = <-done
	case <-ctx.Done():
		killGroup(pgid)
		waitErr = <-done
	}

	outText, outTotal, outTruncated := stdout.snapshot()
	errText, errTotal, errTruncated := stderr.snapshot()
	result := execResult{
		Stdout:     outText,
		Stderr:     errText,
		BytesTotal: outTotal + errTotal,
		Truncated:  outTruncated || errTruncated,
		DurationMS: time.Since(startedAt).Milliseconds(),
	}
	switch {
	case timedOut:
		result.ExitCode = exitTimedOut
	case waitErr == nil:
		result.ExitCode = 0
	default:
		result.ExitCode = exitCodeOf(waitErr)
	}
	return result
}

// exitCodeOf reports 128+signal for a signalled command, which `sh` and CI both expect.
func exitCodeOf(err error) int {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return 1
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok {
		return exitErr.ExitCode()
	}
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}

func killGroup(pgid int) {
	// Negative pid addresses the whole group, so orphaned children die with the shell.
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}
