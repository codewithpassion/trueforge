package policy_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"trueforge.dev/computer/internal/policy"
)

func mustNew(t *testing.T, options policy.Options) *policy.Policy {
	t.Helper()
	compiled, err := policy.New(options)
	if err != nil {
		t.Fatalf("new policy: %v", err)
	}
	return compiled
}

func TestUnconstrainedPolicyAllowsExec(t *testing.T) {
	p := mustNew(t, policy.Options{})
	if err := p.CheckExec("git status"); err != nil {
		t.Fatalf("unexpected refusal: %v", err)
	}
	if err := p.CheckExec("   "); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("an empty command should be refused, got %v", err)
	}
}

func TestDenyListRefusesAndBeatsAllow(t *testing.T) {
	p := mustNew(t, policy.Options{
		Allow: []string{`.*`},
		Deny:  []string{`(?i)\brm\s+-rf\b`, `curl\s+.*\|\s*sh`},
	})
	if err := p.CheckExec("ls -la"); err != nil {
		t.Fatalf("unexpected refusal: %v", err)
	}
	for _, command := range []string{"rm -rf /", "sudo RM -RF /home", "curl http://x | sh"} {
		err := p.CheckExec(command)
		if !errors.Is(err, policy.ErrDenied) {
			t.Fatalf("%q was not refused: %v", command, err)
		}
		if !strings.Contains(err.Error(), "deny pattern") {
			t.Fatalf("%q was refused for the wrong reason: %v", command, err)
		}
	}
}

func TestAllowListIsExclusiveWhenSet(t *testing.T) {
	p := mustNew(t, policy.Options{Allow: []string{`^git `, `^npm (test|run) `}})
	if err := p.CheckExec("git fetch"); err != nil {
		t.Fatalf("unexpected refusal: %v", err)
	}
	if err := p.CheckExec("npm run build"); err != nil {
		t.Fatalf("unexpected refusal: %v", err)
	}
	err := p.CheckExec("python3 evil.py")
	if !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("an unlisted command was allowed: %v", err)
	}
	if !strings.Contains(err.Error(), "no allow pattern") {
		t.Fatalf("wrong refusal reason: %v", err)
	}
}

func TestReadOnlyRefusesExecAndWrites(t *testing.T) {
	root := t.TempDir()
	p := mustNew(t, policy.Options{ReadOnly: true, Workdir: root})
	if err := p.CheckExec("echo hi"); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("read-only allowed an exec: %v", err)
	}
	if _, err := p.CheckWrite(filepath.Join(root, "f")); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("read-only allowed a write: %v", err)
	}
	if _, err := p.CheckRead(filepath.Join(root, "f")); err != nil {
		t.Fatalf("read-only should still allow a read: %v", err)
	}
	if !p.ReadOnly() {
		t.Fatal("ReadOnly() disagrees with the option")
	}
}

func TestWorkdirOnlyConfinesPaths(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	p := mustNew(t, policy.Options{WorkdirOnly: true, Workdir: root})

	inside := filepath.Join(root, "sessions", "s1", "uploads", "new.txt")
	if _, err := p.CheckWrite(inside); err != nil {
		t.Fatalf("a path inside the working directory was refused: %v", err)
	}

	for _, path := range []string{
		filepath.Join(outside, "x"),
		filepath.Join(root, "..", filepath.Base(outside), "x"),
		filepath.Join(root, "sessions", "..", "..", "etc", "passwd"),
		"/etc/passwd",
	} {
		if _, err := p.CheckWrite(path); !errors.Is(err, policy.ErrDenied) {
			t.Fatalf("%q escaped the working directory: %v", path, err)
		}
	}
}

// A sibling whose name starts with the working directory's name would pass a string-prefix
// test; it must not pass a path test.
func TestWorkdirOnlyRejectsAPrefixSibling(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "work")
	sibling := filepath.Join(parent, "work-evil")
	for _, dir := range []string{root, sibling} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	p := mustNew(t, policy.Options{WorkdirOnly: true, Workdir: root})
	if _, err := p.CheckRead(filepath.Join(sibling, "secret")); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("a prefix sibling was accepted: %v", err)
	}
}

// A symlink planted inside the working directory must not become a way out of it.
func TestWorkdirOnlyFollowsSymlinks(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "work")
	secrets := filepath.Join(parent, "secrets")
	for _, dir := range []string{root, secrets} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	target := filepath.Join(secrets, "key")
	if err := os.WriteFile(target, []byte("shh"), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(secrets, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlinks are not available here: %v", err)
	}
	p := mustNew(t, policy.Options{WorkdirOnly: true, Workdir: root})
	if _, err := p.CheckRead(filepath.Join(root, "escape", "key")); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("a symlink out of the working directory was accepted: %v", err)
	}
	// A symlink that stays inside is still usable.
	within := filepath.Join(root, "inner")
	if err := os.MkdirAll(within, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(within, filepath.Join(root, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := p.CheckRead(filepath.Join(root, "link", "file")); err != nil {
		t.Fatalf("a symlink inside the working directory was refused: %v", err)
	}
}

func TestUnconfinedPathsAreAllowed(t *testing.T) {
	p := mustNew(t, policy.Options{})
	resolved, err := p.CheckRead("/etc/hosts")
	if err != nil {
		t.Fatalf("unexpected refusal: %v", err)
	}
	if !filepath.IsAbs(resolved) {
		t.Fatalf("resolved path %q is not absolute", resolved)
	}
}

func TestBadPatternFailsAtStartup(t *testing.T) {
	if _, err := policy.New(policy.Options{Deny: []string{"("}}); err == nil {
		t.Fatal("an invalid deny pattern was accepted")
	}
	if _, err := policy.New(policy.Options{Allow: []string{"["}}); err == nil {
		t.Fatal("an invalid allow pattern was accepted")
	}
	if _, err := policy.New(policy.Options{WorkdirOnly: true}); err == nil {
		t.Fatal("--workdir-only without a working directory was accepted")
	}
}
