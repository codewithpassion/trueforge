// Package agent turns a request frame into work: it applies the local policy, runs the op,
// records it, and renders the reply.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"trueforge.dev/computer/internal/audit"
	"trueforge.dev/computer/internal/files"
	"trueforge.dev/computer/internal/policy"
	"trueforge.dev/computer/internal/protocol"
	"trueforge.dev/computer/internal/runner"
)

type Agent struct {
	policy    *policy.Policy
	runner    *runner.Runner
	transfers *files.Transfers
	log       *audit.Log
	logger    *slog.Logger
}

func New(rules *policy.Policy, commands *runner.Runner, transfers *files.Transfers, log *audit.Log, logger *slog.Logger) *Agent {
	if logger == nil {
		logger = slog.Default()
	}
	return &Agent{policy: rules, runner: commands, transfers: transfers, log: log, logger: logger}
}

// OnDisconnect drops the uploads that were mid-flight. The server restarts a transfer from
// chunk zero after a reconnect, so a half-written file is only a leak.
func (a *Agent) OnDisconnect() {
	a.transfers.Abandon()
}

// Dispatch answers one request. It always returns a frame: a request the relay is waiting on
// must never be met with silence.
func (a *Agent) Dispatch(ctx context.Context, head protocol.Envelope, frame []byte) []byte {
	switch head.Op {
	case protocol.OpExec:
		return a.exec(ctx, head, frame)
	case protocol.OpCancel:
		return a.cancel(head, frame)
	case protocol.OpFilePut:
		return a.filePut(head, frame)
	case protocol.OpFileGet:
		return a.fileGet(head, frame)
	default:
		a.record(audit.Entry{Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError, Error: "unknown op"})
		return protocol.EncodeError(head.ID, protocol.ErrUnknownOp, fmt.Sprintf("this computer does not implement the op %q", head.Op))
	}
}

func (a *Agent) exec(ctx context.Context, head protocol.Envelope, frame []byte) []byte {
	var request protocol.ExecRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode exec: %w", err))
	}
	cwd := ""
	if request.Cwd != nil {
		cwd = *request.Cwd
	}
	if err := a.policy.CheckExec(request.Command); err != nil {
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeDenied,
			Command: request.Command, Cwd: cwd, Error: err.Error(),
		})
		a.logger.Warn("refused a command", "id", head.ID, "error", err.Error())
		return protocol.EncodeError(head.ID, protocol.ErrDenied, err.Error())
	}

	startedAt := time.Now()
	result, err := a.runner.Run(ctx, head.ID, request)
	if err != nil {
		code := protocol.ErrOpFailed
		if errors.Is(err, runner.ErrQueueFull) {
			code = protocol.ErrQueueFull
		}
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError,
			Command: request.Command, Cwd: cwd, Error: err.Error(),
			DurationMS: time.Since(startedAt).Milliseconds(),
		})
		return protocol.EncodeError(head.ID, code, err.Error())
	}

	exitCode := result.ExitCode
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Command: request.Command, Cwd: cwd, ExitCode: &exitCode,
		Bytes: result.BytesTotal, Truncated: result.Truncated, DurationMS: result.DurationMS,
	})
	return a.ok(head, result)
}

func (a *Agent) cancel(head protocol.Envelope, frame []byte) []byte {
	var request protocol.CancelRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode cancel: %w", err))
	}
	// The runner outlives any one socket, so a cancel that arrives on a reconnected socket
	// still reaches a command the previous connection started.
	cancelled := a.runner.Cancel(request.TargetID)
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Command: "cancel " + request.TargetID,
	})
	a.logger.Info("cancel", "id", head.ID, "target_id", request.TargetID, "cancelled", cancelled)
	return a.ok(head, protocol.CancelResult{Cancelled: cancelled})
}

func (a *Agent) filePut(head protocol.Envelope, frame []byte) []byte {
	var request protocol.FilePutRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode file_put: %w", err))
	}
	resolved, err := a.policy.CheckWrite(request.Path)
	if err != nil {
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeDenied,
			Path: request.Path, Error: err.Error(),
		})
		code := protocol.ErrDenied
		if a.policy.ReadOnly() {
			code = protocol.ErrReadOnly
		}
		return protocol.EncodeError(head.ID, code, err.Error())
	}
	result, err := a.transfers.Put(request, resolved)
	if err != nil {
		code := codeForFileError(err)
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError,
			Path: resolved, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, code, err.Error())
	}
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Path: resolved, Bytes: result.BytesWritten,
	})
	return a.ok(head, result)
}

func (a *Agent) fileGet(head protocol.Envelope, frame []byte) []byte {
	var request protocol.FileGetRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode file_get: %w", err))
	}
	resolved, err := a.policy.CheckRead(request.Path)
	if err != nil {
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeDenied,
			Path: request.Path, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, protocol.ErrDenied, err.Error())
	}
	result, err := files.Get(request, resolved)
	if err != nil {
		code := codeForFileError(err)
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError,
			Path: resolved, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, code, err.Error())
	}
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Path: resolved, Bytes: int64(len(result.DataB64)),
	})
	return a.ok(head, result)
}

// codeForFileError names the failure precisely enough that the server can map it to the
// right sandbox error rather than one opaque failure.
func codeForFileError(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return protocol.ErrNotFound
	case errors.Is(err, files.ErrIsDirectory):
		return protocol.ErrIsADirectory
	case errors.Is(err, files.ErrBadRequest):
		return protocol.ErrBadRequest
	default:
		return protocol.ErrOpFailed
	}
}

// OnReplyDropped records an answer that could not be written because its socket had closed.
// The server may reissue the request, so the outcome of the work already done is unknown.
func (a *Agent) OnReplyDropped(head protocol.Envelope, cause error) {
	a.logger.Warn("dropped a reply whose socket had closed", "id", head.ID, "op", head.Op, "error", cause.Error())
	a.record(audit.Entry{
		Op:        head.Op,
		RequestID: head.ID,
		Outcome:   audit.OutcomeReplyDropped,
		Error:     cause.Error(),
	})
}

func (a *Agent) ok(head protocol.Envelope, result any) []byte {
	encoded, err := protocol.EncodeOK(head.ID, result)
	if err != nil {
		return protocol.EncodeError(head.ID, protocol.ErrOpFailed, err.Error())
	}
	return encoded
}

func (a *Agent) fail(head protocol.Envelope, code string, err error) []byte {
	a.record(audit.Entry{Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError, Error: err.Error()})
	return protocol.EncodeError(head.ID, code, err.Error())
}

// record never fails an operation: a full disk should not stop the machine from working, only
// from proving what it did.
func (a *Agent) record(entry audit.Entry) {
	if a.log == nil {
		return
	}
	if err := a.log.Record(entry); err != nil {
		a.logger.Warn("could not write the audit log", "error", err.Error())
	}
}
