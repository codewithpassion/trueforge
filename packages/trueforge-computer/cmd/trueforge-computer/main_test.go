package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"trueforge.dev/computer/internal/state"
)

func TestCommandExitCodes(t *testing.T) {
	empty := t.TempDir()
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"no arguments", nil, exitUsage},
		{"unknown command", []string{"teleport"}, exitUsage},
		{"version", []string{"version"}, exitOK},
		{"help", []string{"help"}, exitOK},
		{"install-service is deferred", []string{"install-service"}, exitNotReady},
		{"status without enrollment", []string{"status", "--state-dir", empty}, exitNotReady},
		{"enroll without a url or code", []string{"enroll", "--state-dir", empty}, exitUsage},
		{"run without enrollment", []string{"run", "--state-dir", empty, "--allow-root"}, exitUsage},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := run(testCase.args); got != testCase.want {
				t.Fatalf("run(%v) = %d, want %d", testCase.args, got, testCase.want)
			}
		})
	}
}

func TestStatusReportsAnEnrolledComputer(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc_secret"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if err := state.SaveConfig(dir, state.Config{URL: "https://example.com", ComputerID: "cmp_1", Name: "box"}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	if got := run([]string{"status", "--state-dir", dir, "--json"}); got != exitOK {
		t.Fatalf("status = %d, want %d", got, exitOK)
	}
}

func enrollServer(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		*calls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"computer_id":"cmp_1","machine_credential":"mc_from_server"}}`))
	}))
	t.Cleanup(server.Close)
	return server
}

// The container one-liner passes --code on every restart. The first start spends it; later
// ones must ignore it, because a single-use code cannot be spent twice.
func TestRunEnrollsOnceThenIgnoresTheCode(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	server := enrollServer(t, &calls)

	config, credential, err := ensureEnrolled(context.Background(), dir, server.URL, "code-1", "box", "text")
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	if credential != "mc_from_server" || config.ComputerID != "cmp_1" || config.URL != server.URL {
		t.Fatalf("config = %+v, credential = %q", config, credential)
	}
	if calls != 1 {
		t.Fatalf("the first start made %d enrollment calls", calls)
	}
	info, err := os.Stat(state.CredentialPath(dir))
	if err != nil {
		t.Fatalf("stat credential: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode is %v", info.Mode().Perm())
	}

	config, credential, err = ensureEnrolled(context.Background(), dir, server.URL, "code-1", "box", "text")
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if calls != 1 {
		t.Fatalf("the second start spent the code again (%d calls)", calls)
	}
	if credential != "mc_from_server" || config.ComputerID != "cmp_1" {
		t.Fatalf("second start returned %+v, %q", config, credential)
	}
}

func TestRunWithoutACredentialOrCodeIsNotEnrolled(t *testing.T) {
	_, _, err := ensureEnrolled(context.Background(), t.TempDir(), "https://example.com", "", "", "text")
	if !errors.Is(err, state.ErrNotEnrolled) {
		t.Fatalf("error = %v, want ErrNotEnrolled", err)
	}
}

// Moving a computer to another server is a flag, not a re-enrollment.
func TestStoredURLCanBeOverriddenAtRun(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if err := state.SaveConfig(dir, state.Config{URL: "https://old.example.com", ComputerID: "cmp_1"}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	config, _, err := ensureEnrolled(context.Background(), dir, "https://new.example.com/", "", "", "text")
	if err != nil {
		t.Fatalf("ensureEnrolled: %v", err)
	}
	if config.URL != "https://new.example.com" {
		t.Fatalf("url = %q", config.URL)
	}
}

func TestAnEnrolledComputerWithNoStoredURLNeedsTheFlag(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if _, _, err := ensureEnrolled(context.Background(), dir, "", "", "", "text"); err == nil {
		t.Fatal("a computer with no URL at all started anyway")
	}
}
