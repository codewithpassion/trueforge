package desktop

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"trueforge.dev/computer/internal/protocol"
)

func intp(value int) *int       { return &value }
func strp(value string) *string { return &value }
func point(kind string, x, y int) protocol.DesktopAction {
	return protocol.DesktopAction{Type: kind, X: intp(x), Y: intp(y)}
}

// The file is what Xvfb, libXau and the in-process client all read, so its bytes are pinned.
func TestWriteXauthorityFormatAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Xauthority")
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cookie := bytes.Repeat([]byte{0xab}, cookieBytes)
	if err := WriteXauthority(path, "99", cookie); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var want bytes.Buffer
	_ = binary.Write(&want, binary.BigEndian, uint16(0xffff))
	for _, field := range []string{"", "99", "MIT-MAGIC-COOKIE-1", string(cookie)} {
		_ = binary.Write(&want, binary.BigEndian, uint16(len(field)))
		want.WriteString(field)
	}
	if !bytes.Equal(raw, want.Bytes()) {
		t.Fatalf("entry = %x\n want %x", raw, want.Bytes())
	}
}

func TestValidActionsPass(t *testing.T) {
	actions := []protocol.DesktopAction{
		point(protocol.ActionMouseMove, 0, 0),
		point(protocol.ActionMouseMove, protocol.DesktopWidth-1, protocol.DesktopHeight-1),
		{Type: protocol.ActionMouseDown, Button: strp("left")},
		{Type: protocol.ActionMouseUp, Button: strp("middle")},
		{Type: protocol.ActionClick, X: intp(1), Y: intp(2), Button: strp("right"), Count: intp(3)},
		{Type: protocol.ActionScroll, X: intp(1), Y: intp(2), DX: intp(-50), DY: intp(50)},
		{Type: protocol.ActionKey, Keys: strp("ctrl+shift+Tab")},
		{Type: protocol.ActionType, Text: strp(strings.Repeat("é", protocol.DesktopMaxTypeChars))},
	}
	if err := ValidateActions(actions); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

// Every limit in the contract is a bad_request, never something xdotool gets to interpret.
func TestInvalidActionsAreBadRequests(t *testing.T) {
	cases := map[string][]protocol.DesktopAction{
		"no actions":        {},
		"too many actions":  make([]protocol.DesktopAction, protocol.DesktopMaxActions+1),
		"unknown type":      {{Type: "drag"}},
		"x past the edge":   {point(protocol.ActionMouseMove, protocol.DesktopWidth, 0)},
		"negative y":        {point(protocol.ActionMouseMove, 0, -1)},
		"missing y":         {{Type: protocol.ActionMouseMove, X: intp(1)}},
		"missing button":    {{Type: protocol.ActionMouseDown}},
		"unknown button":    {{Type: protocol.ActionMouseUp, Button: strp("back")}},
		"click count zero":  {{Type: protocol.ActionClick, X: intp(1), Y: intp(1), Button: strp("left"), Count: intp(0)}},
		"click count four":  {{Type: protocol.ActionClick, X: intp(1), Y: intp(1), Button: strp("left"), Count: intp(4)}},
		"click no count":    {{Type: protocol.ActionClick, X: intp(1), Y: intp(1), Button: strp("left")}},
		"scroll too far":    {{Type: protocol.ActionScroll, X: intp(1), Y: intp(1), DX: intp(0), DY: intp(51)}},
		"scroll missing dx": {{Type: protocol.ActionScroll, X: intp(1), Y: intp(1), DY: intp(1)}},
		"empty keys":        {{Type: protocol.ActionKey, Keys: strp("")}},
		"keys too long":     {{Type: protocol.ActionKey, Keys: strp(strings.Repeat("a", protocol.DesktopMaxKeysChars+1))}},
		"two chords":        {{Type: protocol.ActionKey, Keys: strp("ctrl+l Return")}},
		"missing keys":      {{Type: protocol.ActionKey}},
		"empty text":        {{Type: protocol.ActionType, Text: strp("")}},
		"text too long":     {{Type: protocol.ActionType, Text: strp(strings.Repeat("a", protocol.DesktopMaxTypeChars+1))}},
		"missing text":      {{Type: protocol.ActionType}},
	}
	for name, actions := range cases {
		if err := ValidateActions(actions); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want a bad request", name, err)
		}
	}
}

// Typed text travels on stdin and keys after "--": neither can become an xdotool option, and
// typed text never shows in the process list.
func TestStepsForEachAction(t *testing.T) {
	cases := []struct {
		action protocol.DesktopAction
		want   []xdotoolStep
	}{
		{point(protocol.ActionMouseMove, 10, 20), []xdotoolStep{{args: []string{"mousemove", "10", "20"}}}},
		{protocol.DesktopAction{Type: protocol.ActionMouseDown, Button: strp("right")}, []xdotoolStep{{args: []string{"mousedown", "3"}}}},
		{protocol.DesktopAction{Type: protocol.ActionMouseUp, Button: strp("left")}, []xdotoolStep{{args: []string{"mouseup", "1"}}}},
		{
			protocol.DesktopAction{Type: protocol.ActionClick, X: intp(5), Y: intp(6), Button: strp("middle"), Count: intp(2)},
			[]xdotoolStep{{args: []string{"mousemove", "5", "6"}}, {args: []string{"click", "--repeat", "2", "2"}}},
		},
		{
			protocol.DesktopAction{Type: protocol.ActionScroll, X: intp(5), Y: intp(6), DX: intp(-2), DY: intp(3)},
			[]xdotoolStep{
				{args: []string{"mousemove", "5", "6"}},
				{args: []string{"click", "--repeat", "3", "--delay", "5", "5"}},
				{args: []string{"click", "--repeat", "2", "--delay", "5", "6"}},
			},
		},
		{
			protocol.DesktopAction{Type: protocol.ActionScroll, X: intp(5), Y: intp(6), DX: intp(1), DY: intp(-1)},
			[]xdotoolStep{
				{args: []string{"mousemove", "5", "6"}},
				{args: []string{"click", "--repeat", "1", "--delay", "5", "4"}},
				{args: []string{"click", "--repeat", "1", "--delay", "5", "7"}},
			},
		},
		{protocol.DesktopAction{Type: protocol.ActionKey, Keys: strp("-ctrl+l")}, []xdotoolStep{{args: []string{"key", "--", "-ctrl+l"}}}},
		{
			protocol.DesktopAction{Type: protocol.ActionType, Text: strp("--help me")},
			[]xdotoolStep{{args: []string{"type", "--delay", "2", "--file", "-"}, stdin: "--help me"}},
		},
	}
	for _, testCase := range cases {
		got := stepsFor(testCase.action)
		if !reflect.DeepEqual(got, testCase.want) {
			t.Errorf("%s: steps = %+v\n want %+v", testCase.action.Type, got, testCase.want)
		}
	}
}

func TestInputBudgetFollowsTheContract(t *testing.T) {
	actions := []protocol.DesktopAction{
		{Type: protocol.ActionType, Text: strp(strings.Repeat("a", 512))},
		{Type: protocol.ActionKey, Keys: strp("Return")},
	}
	if got := InputBudget(actions); got != 2*time.Second+512*5*time.Millisecond {
		t.Fatalf("budget = %s", got)
	}
}

func TestScreenshotQuality(t *testing.T) {
	if quality, err := ScreenshotQuality(nil); err != nil || quality != 60 {
		t.Fatalf("null quality = %d, %v", quality, err)
	}
	for _, good := range []int{1, 95} {
		if quality, err := ScreenshotQuality(intp(good)); err != nil || quality != good {
			t.Fatalf("quality %d = %d, %v", good, quality, err)
		}
	}
	for _, bad := range []int{0, 96, -1} {
		if _, err := ScreenshotQuality(intp(bad)); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("quality %d: err = %v", bad, err)
		}
	}
}

func TestClipboardSetLimits(t *testing.T) {
	good := protocol.DesktopClipboardSetRequest{Text: strings.Repeat("a", protocol.DesktopMaxClipboardBytes), Selections: []string{"primary", "clipboard"}}
	if err := ValidateClipboardSet(good); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := ValidateClipboardSet(protocol.DesktopClipboardSetRequest{Text: "", Selections: []string{"clipboard"}}); err != nil {
		t.Fatalf("an empty text clears the clipboard and is allowed: %v", err)
	}
	bad := map[string]protocol.DesktopClipboardSetRequest{
		"text over 64 KiB":  {Text: strings.Repeat("a", protocol.DesktopMaxClipboardBytes+1), Selections: []string{"clipboard"}},
		"no selections":     {Text: "a"},
		"three selections":  {Text: "a", Selections: []string{"clipboard", "primary", "clipboard"}},
		"repeated":          {Text: "a", Selections: []string{"primary", "primary"}},
		"unknown selection": {Text: "a", Selections: []string{"secondary"}},
	}
	for name, request := range bad {
		if err := ValidateClipboardSet(request); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestNoSelectionRecognisesXclip(t *testing.T) {
	if !noSelection("Error: target UTF8_STRING not available\n") {
		t.Fatal("xclip's no-owner message should read as an empty clipboard")
	}
	if noSelection("Error: Can't open display: :99\n") {
		t.Fatal("a display error is not an empty clipboard")
	}
}

func TestCapabilityReason(t *testing.T) {
	if ok, reason := Capability(nil); !ok || reason != nil {
		t.Fatalf("nil error = %v, %v", ok, reason)
	}
	ok, reason := Capability(errors.New(strings.Repeat("é", 300)))
	if ok || reason == nil || len([]rune(*reason)) != protocol.DesktopReasonMaxChars {
		t.Fatalf("long reason = %v, %v", ok, reason)
	}
}

// A little-endian BGRx pixel, which is what Xvfb serves at depth 24, becomes the right RGB.
func TestPixelLayoutDecode(t *testing.T) {
	layout := pixelLayout{bytesPerPixel: 4, order: binary.LittleEndian, red: 0xff0000, green: 0xff00, blue: 0xff}
	frame, err := layout.decode([]byte{0x10, 0x20, 0x30, 0x00, 0xff, 0x00, 0x00, 0x00}, 2, 1)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := frame.Pix[:8]; !bytes.Equal(got, []byte{0x30, 0x20, 0x10, 0xff, 0x00, 0x00, 0xff, 0xff}) {
		t.Fatalf("pixels = %x", got)
	}
	if _, err := layout.decode([]byte{0, 0, 0}, 2, 1); err == nil {
		t.Fatal("a short image should be refused")
	}
}

func TestSelfTestFailureNamesTheSandbox(t *testing.T) {
	stderr := "noise\n[9:9:0923/133226.005471:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If this is a Debian system...\n"
	if got := selfTestFailure(errors.New("exit status 1"), stderr); !strings.HasPrefix(got, "No usable sandbox!") {
		t.Fatalf("reason = %q", got)
	}
	if got := selfTestFailure(errors.New("exit status 1"), "noise"); got != "exit status 1" {
		t.Fatalf("reason = %q", got)
	}
}
