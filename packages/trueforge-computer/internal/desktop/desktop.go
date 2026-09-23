// Package desktop runs a virtual X display for agents and humans to drive: it supervises Xvfb and
// openbox, captures the screen in-process, and drives input and the clipboard through xdotool and
// xclip.
package desktop

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"trueforge.dev/computer/internal/protocol"
	"trueforge.dev/computer/internal/runner"
)

// DefaultDisplay is the X display number the desktop takes unless told otherwise.
const DefaultDisplay = 99

// DirName is the desktop's directory inside the state directory. The Xauthority file and the
// Chromium profile live there, so both are as private as the machine credential.
const DirName = "desktop"

// XauthorityFileName is passed to Xvfb with -auth and to every command as XAUTHORITY.
const XauthorityFileName = "Xauthority"

var (
	// ErrUnavailable means the desktop is not running, or its X server is not answering.
	ErrUnavailable = errors.New("the desktop is not running on this computer")
	// ErrBadRequest means a request broke one of the protocol's limits.
	ErrBadRequest = errors.New("bad desktop request")
	// ErrTooLarge means a result would be over the protocol's cap.
	ErrTooLarge = errors.New("desktop result too large")
)

// Timings. Readiness and the Chromium self-test run once, at startup, before hello is sent.
const (
	readyTimeout    = 15 * time.Second
	selfTestTimeout = 45 * time.Second
	restartMin      = time.Second
	restartMax      = 30 * time.Second
	// stableAfter is how long a process must run before its restart backoff resets.
	stableAfter = 30 * time.Second
	// stopGrace is how long a supervised process gets between SIGTERM and SIGKILL.
	stopGrace = 5 * time.Second
)

type Options struct {
	StateDir string
	Display  int
	Logger   *slog.Logger
}

// Desktop is a running display. Its methods are safe for concurrent use; input and clipboard
// writes are serialised, because two interleaved batches would type into each other.
type Desktop struct {
	display    int
	socket     string
	dir        string
	xauthority string
	cookieHex  string
	logger     *slog.Logger

	mu         sync.Mutex
	supervised sync.WaitGroup
}

// Start brings up Xvfb and openbox under supervision until ctx ends. An error means there is no
// desktop at all; a desktop that started may still fail Check.
func Start(ctx context.Context, options Options) (*Desktop, error) {
	if runtime.GOOS != "linux" {
		return nil, fmt.Errorf("the desktop is only supported on Linux, not %s", runtime.GOOS)
	}
	if options.Display <= 0 {
		options.Display = DefaultDisplay
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	for _, binary := range []string{"Xvfb", "openbox"} {
		if _, err := exec.LookPath(binary); err != nil {
			return nil, fmt.Errorf("%s is not installed; see install.sh --desktop for the packages the desktop needs", binary)
		}
	}
	dir := filepath.Join(options.StateDir, DirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("restrict %s: %w", dir, err)
	}

	// A fresh cookie per start: anything still holding the last one belongs to a dead server.
	cookie := make([]byte, cookieBytes)
	if _, err := rand.Read(cookie); err != nil {
		return nil, fmt.Errorf("generate the X cookie: %w", err)
	}
	displayNumber := strconv.Itoa(options.Display)
	xauthority := filepath.Join(dir, XauthorityFileName)
	if err := WriteXauthority(xauthority, displayNumber, cookie); err != nil {
		return nil, err
	}

	desktop := &Desktop{
		display:    options.Display,
		socket:     fmt.Sprintf("/tmp/.X11-unix/X%d", options.Display),
		dir:        dir,
		xauthority: xauthority,
		cookieHex:  hex.EncodeToString(cookie),
		logger:     options.Logger,
	}
	desktop.supervise(ctx, "Xvfb", []string{
		"Xvfb", ":" + displayNumber,
		"-screen", "0", fmt.Sprintf("%dx%dx24", protocol.DesktopWidth, protocol.DesktopHeight),
		"-nolisten", "tcp",
		"-auth", xauthority,
	}, nil)
	// openbox is started only once the display answers; when Xvfb restarts it loses its
	// connection, exits, and comes back through the same wait.
	desktop.supervise(ctx, "openbox", []string{"openbox"}, desktop.waitReady)
	return desktop, nil
}

// Env is what every command on this computer needs to reach the display.
func (d *Desktop) Env() map[string]string {
	return map[string]string{
		"DISPLAY":    ":" + strconv.Itoa(d.display),
		"XAUTHORITY": d.xauthority,
	}
}

// Wait returns once every supervised process has stopped, after the context given to Start ends.
func (d *Desktop) Wait() {
	d.supervised.Wait()
}

// Check reports whether the desktop is usable by an agent: the display answers, the input and
// clipboard tools resolve, and Chromium's sandbox starts. The error text is the reason hello
// carries.
func (d *Desktop) Check(ctx context.Context) error {
	readyCtx, cancel := context.WithTimeout(ctx, readyTimeout)
	defer cancel()
	if err := d.waitReady(readyCtx); err != nil {
		return fmt.Errorf("the X server did not answer on :%d within %s", d.display, readyTimeout)
	}
	for _, binary := range []string{"xdotool", "xclip", "chromium"} {
		if _, err := exec.LookPath(binary); err != nil {
			return fmt.Errorf("%s is not on PATH", binary)
		}
	}
	return d.chromiumSelfTest(ctx)
}

// waitReady polls until the display accepts a connection with the cookie.
func (d *Desktop) waitReady(ctx context.Context) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		conn, err := d.connect(time.Second)
		if err == nil {
			conn.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// commandEnv is the scrubbed environment every helper runs with, the same one exec'd commands get.
func (d *Desktop) commandEnv() []string {
	return runner.ScrubbedEnv(d.Env())
}

// Capability turns the outcome of Start and Check into hello's two desktop fields.
func Capability(err error) (bool, *string) {
	if err == nil {
		return true, nil
	}
	reason := []rune(err.Error())
	if len(reason) > protocol.DesktopReasonMaxChars {
		reason = reason[:protocol.DesktopReasonMaxChars]
	}
	text := string(reason)
	return false, &text
}
