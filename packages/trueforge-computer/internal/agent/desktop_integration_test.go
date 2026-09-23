//go:build desktop_integration

// These run inside the desktop image, against a real Xvfb, xdotool, xclip and Chromium:
// `pnpm --filter @truefoundry/trueforge-computer test:desktop-image`.
package agent_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"trueforge.dev/computer/internal/agent"
	"trueforge.dev/computer/internal/audit"
	"trueforge.dev/computer/internal/desktop"
	"trueforge.dev/computer/internal/files"
	"trueforge.dev/computer/internal/policy"
	"trueforge.dev/computer/internal/protocol"
	"trueforge.dev/computer/internal/runner"
)

// startDesktop brings a desktop up in a fresh state directory and returns the result of Check,
// which is what the daemon puts in hello.
func startDesktop(t *testing.T) (*desktop.Desktop, string, error) {
	t.Helper()
	stateDir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	screen, err := desktop.Start(ctx, desktop.Options{StateDir: stateDir, Logger: discardLogger()})
	if err != nil {
		cancel()
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		cancel()
		screen.Wait()
	})
	return screen, stateDir, screen.Check(ctx)
}

func newDesktopHarness(t *testing.T, screen *desktop.Desktop, stateDir string) *harness {
	t.Helper()
	workdir := filepath.Join(stateDir, "sessions")
	if err := os.MkdirAll(workdir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	rules, err := policy.New(policy.Options{Workdir: workdir, StateDir: stateDir, SessionsDir: workdir})
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	log, err := audit.Open(stateDir, audit.Options{})
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	t.Cleanup(func() { _ = log.Close() })
	commands := runner.New(runner.Options{StateDir: stateDir, DefaultCwd: workdir, BaseEnv: screen.Env(), Logger: discardLogger()})
	t.Cleanup(commands.Shutdown)
	return &harness{
		agent:    agent.New(rules, commands, files.NewTransfers(files.Options{ResolveWrite: rules.CheckWrite}), screen, log, discardLogger()),
		commands: commands,
		stateDir: stateDir,
		workdir:  workdir,
	}
}

func (h *harness) exec(t *testing.T, id string, command string) protocol.ExecResult {
	t.Helper()
	return execResultOf(t, h.dispatch(t, id, protocol.OpExec, map[string]any{
		"command": command, "cwd": nil, "env": map[string]string{}, "timeout_ms": 10_000,
	}))
}

func (h *harness) screenshot(t *testing.T) image.Image {
	t.Helper()
	reply := h.dispatch(t, "shot-"+time.Now().Format("150405.000000"), protocol.OpDesktopScreenshot, map[string]any{"quality": nil})
	if reply.Error != nil {
		t.Fatalf("screenshot: %+v", reply.Error)
	}
	var result protocol.DesktopScreenshotResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(result.DataB64)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	frame, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode jpeg: %v", err)
	}
	if result.MediaType != "image/jpeg" || result.Width != 1280 || result.Height != 800 {
		t.Fatalf("result = %d x %d %s", result.Width, result.Height, result.MediaType)
	}
	if bounds := frame.Bounds(); bounds.Dx() != 1280 || bounds.Dy() != 800 {
		t.Fatalf("decoded to %v", bounds)
	}
	return frame
}

func (h *harness) input(t *testing.T, actions ...map[string]any) {
	t.Helper()
	list := make([]any, 0, len(actions))
	for _, action := range actions {
		list = append(list, action)
	}
	reply := h.dispatch(t, "input-"+time.Now().Format("150405.000000"), protocol.OpDesktopInput, map[string]any{"actions": list})
	if reply.Error != nil {
		t.Fatalf("input: %+v", reply.Error)
	}
}

func (h *harness) clipboard(t *testing.T) string {
	t.Helper()
	reply := h.dispatch(t, "get-"+time.Now().Format("150405.000000"), protocol.OpDesktopClipboardGet, map[string]any{})
	if reply.Error != nil {
		t.Fatalf("clipboard_get: %+v", reply.Error)
	}
	var result protocol.DesktopClipboardGetResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return result.Text
}

// changedPixels counts pixels that differ by more than JPEG noise.
func changedPixels(a image.Image, b image.Image) int {
	changed := 0
	bounds := a.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			ar, ag, ab, _ := a.At(x, y).RGBA()
			br, bg, bb, _ := b.At(x, y).RGBA()
			if distance(ar, br)+distance(ag, bg)+distance(ab, bb) > 3*0x2000 {
				changed++
			}
		}
	}
	return changed
}

func distance(a uint32, b uint32) uint32 {
	if a > b {
		return a - b
	}
	return b - a
}

func waitUntil(t *testing.T, what string, timeout time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestDesktopEndToEnd(t *testing.T) {
	if os.Getenv("TRUEFORGE_DESKTOP_EXPECT_SANDBOX") == "refused" {
		t.Skip("this run checks the refusal only")
	}
	screen, stateDir, err := startDesktop(t)
	// Check covers the X server answering, xdotool and xclip resolving, and Chromium's sandbox
	// self-test: this is the capability the daemon reports.
	if ok, reason := desktop.Capability(err); !ok {
		t.Fatalf("the desktop is not available: %s", *reason)
	}
	h := newDesktopHarness(t, screen, stateDir)
	xauthority := screen.Env()["XAUTHORITY"]

	t.Run("Xvfb runs with -auth and without TCP", func(t *testing.T) {
		result := h.exec(t, "ps", "ps -eo args | grep '^Xvfb'")
		want := "Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -auth " + xauthority
		if !strings.Contains(result.Stdout, want) {
			t.Fatalf("Xvfb command line = %q, want %q", result.Stdout, want)
		}
		info, err := os.Stat(xauthority)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("Xauthority = %v, %v", info, err)
		}
		// Without the cookie the display refuses the client.
		refused := h.exec(t, "nocookie", "XAUTHORITY=/dev/null xdotool getmouselocation")
		if refused.ExitCode == 0 {
			t.Fatalf("a client without the cookie reached the display: %+v", refused)
		}
		allowed := h.exec(t, "cookie", "xdotool getmouselocation")
		if allowed.ExitCode != 0 {
			t.Fatalf("a client with the cookie was refused: %+v", allowed)
		}
	})

	t.Run("clipboard_get on an empty clipboard is empty", func(t *testing.T) {
		if text := h.clipboard(t); text != "" {
			t.Fatalf("clipboard = %q, want empty", text)
		}
	})

	t.Run("typing into xterm shows on screen", func(t *testing.T) {
		h.exec(t, "xterm", "xterm &")
		waitUntil(t, "an xterm window", 10*time.Second, func() bool {
			return h.exec(t, "search", "xdotool search --onlyvisible --class xterm").ExitCode == 0
		})
		// Let the shell inside xterm draw its prompt before the "before" frame.
		time.Sleep(time.Second)
		before := h.screenshot(t)
		proof := filepath.Join(h.workdir, "typed-proof")
		// openbox centres a new window, so the middle of the screen is inside the xterm.
		h.input(t,
			map[string]any{"type": "click", "x": 640, "y": 400, "button": "left", "count": 1},
			map[string]any{"type": "type", "text": "echo typed-into-xterm > " + proof},
			map[string]any{"type": "key", "keys": "Return"},
		)
		waitUntil(t, "the typed command to run", 5*time.Second, func() bool {
			raw, err := os.ReadFile(proof)
			return err == nil && strings.TrimSpace(string(raw)) == "typed-into-xterm"
		})
		after := h.screenshot(t)
		if changed := changedPixels(before, after); changed < 200 {
			t.Fatalf("only %d pixels changed after typing", changed)
		}
	})

	t.Run("clipboard set and get round trip", func(t *testing.T) {
		text := "héllo ✓ from the clipboard\nline two"
		reply := h.dispatch(t, "set", protocol.OpDesktopClipboardSet, map[string]any{"text": text, "selections": []string{"clipboard", "primary"}})
		if reply.Error != nil {
			t.Fatalf("clipboard_set: %+v", reply.Error)
		}
		if got := h.clipboard(t); got != text {
			t.Fatalf("clipboard = %q, want %q", got, text)
		}
		primary := h.exec(t, "primary", "xclip -selection primary -o")
		if primary.Stdout != text {
			t.Fatalf("primary = %q", primary.Stdout)
		}
		// An empty set is how the server clears both selections at hand-back.
		reply = h.dispatch(t, "clear", protocol.OpDesktopClipboardSet, map[string]any{"text": "", "selections": []string{"clipboard", "primary"}})
		if reply.Error != nil {
			t.Fatalf("clear: %+v", reply.Error)
		}
		if got := h.clipboard(t); got != "" {
			t.Fatalf("clipboard after clear = %q", got)
		}
	})

	t.Run("chromium started with exec keeps running", func(t *testing.T) {
		result := h.exec(t, "chromium", "chromium about:blank &")
		if result.ExitCode != 0 || result.DurationMS >= 3000 {
			t.Fatalf("exec = exit %d after %d ms", result.ExitCode, result.DurationMS)
		}
		t.Logf("exec of chromium returned exit %d after %d ms", result.ExitCode, result.DurationMS)
		profile := filepath.Join(stateDir, desktop.DirName, "chromium-profile")
		waitUntil(t, "a chromium window", 20*time.Second, func() bool {
			return h.exec(t, "chromium-window", "xdotool search --onlyvisible --class chromium").ExitCode == 0
		})
		time.Sleep(2 * time.Second)
		running := h.exec(t, "pgrep", "pgrep -f -- '--user-data-dir="+profile+"'")
		if running.ExitCode != 0 {
			t.Fatalf("chromium is not running with the pinned profile: %+v", running)
		}
		if _, err := os.Stat(profile); err != nil {
			t.Fatalf("the profile was not created: %v", err)
		}
		// Its renderers run in their own user namespace: the sandbox is on, not bypassed.
		sandboxed := h.exec(t, "sandboxed", `self=$(readlink /proc/self/ns/user); for pid in $(pgrep -f -- '--type=renderer'); do [ "$(readlink /proc/$pid/ns/user)" != "$self" ] && echo sandboxed; done`)
		if !strings.Contains(sandboxed.Stdout, "sandboxed") {
			t.Fatalf("no chromium renderer runs in its own user namespace: %+v", sandboxed)
		}
	})

	// Last, because it takes every window down with the X server.
	t.Run("a crashed X server is restarted", func(t *testing.T) {
		h.exec(t, "kill-x", "pkill -KILL -x Xvfb")
		waitUntil(t, "the screenshot to report the desktop unavailable", 3*time.Second, func() bool {
			reply := h.dispatch(t, "down", protocol.OpDesktopScreenshot, map[string]any{"quality": 10})
			return reply.Error != nil && reply.Error.Code == protocol.ErrDesktopUnavailable
		})
		waitUntil(t, "Xvfb to come back", 15*time.Second, func() bool {
			reply := h.dispatch(t, "up", protocol.OpDesktopScreenshot, map[string]any{"quality": 10})
			return reply.Error == nil
		})
		waitUntil(t, "openbox to come back", 15*time.Second, func() bool {
			return h.exec(t, "openbox", "pgrep -x openbox").ExitCode == 0
		})
	})
}

// Under Docker's default seccomp profile Chromium's sandbox cannot start, and the desktop must
// say so rather than fall back to --no-sandbox.
func TestDesktopSandboxRefusedByDefaultProfile(t *testing.T) {
	if os.Getenv("TRUEFORGE_DESKTOP_EXPECT_SANDBOX") != "refused" {
		t.Skip("set TRUEFORGE_DESKTOP_EXPECT_SANDBOX=refused and run without the desktop seccomp profile")
	}
	_, _, err := startDesktop(t)
	ok, reason := desktop.Capability(err)
	if ok || reason == nil || !strings.Contains(*reason, "sandbox") {
		t.Fatalf("capability = %v, reason %v", ok, reason)
	}
	t.Logf("reported reason: %s", *reason)
}
