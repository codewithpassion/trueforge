// Package policy holds the limits an operator sets on a computer. Every one of them is
// enforced here, on the machine, so a compromised server cannot lift them by asking nicely.
package policy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrDenied is returned for anything the local policy refuses.
var ErrDenied = errors.New("refused by the local policy")

type Options struct {
	// ReadOnly refuses exec and every write; the computer can still be read from.
	ReadOnly bool
	// Allow, when non-empty, is the set a command must match at least one of.
	Allow []string
	// Deny is checked first and always wins.
	Deny []string
	// WorkdirOnly confines file operations to Workdir.
	WorkdirOnly bool
	Workdir     string
}

type Policy struct {
	readOnly    bool
	allow       []*regexp.Regexp
	deny        []*regexp.Regexp
	workdirOnly bool
	workdir     string
}

// New compiles the patterns once, so a bad expression fails at startup rather than on the
// first request that happens to hit it.
func New(options Options) (*Policy, error) {
	allow, err := compile(options.Allow, "allow")
	if err != nil {
		return nil, err
	}
	deny, err := compile(options.Deny, "deny")
	if err != nil {
		return nil, err
	}
	workdir := options.Workdir
	if workdir != "" {
		absolute, absErr := filepath.Abs(workdir)
		if absErr != nil {
			return nil, fmt.Errorf("resolve the working directory %s: %w", workdir, absErr)
		}
		workdir = resolveExisting(absolute)
	}
	if options.WorkdirOnly && workdir == "" {
		return nil, errors.New("--workdir-only needs a working directory")
	}
	return &Policy{
		readOnly:    options.ReadOnly,
		allow:       allow,
		deny:        deny,
		workdirOnly: options.WorkdirOnly,
		workdir:     workdir,
	}, nil
}

func compile(patterns []string, kind string) ([]*regexp.Regexp, error) {
	compiled := make([]*regexp.Regexp, 0, len(patterns))
	for _, pattern := range patterns {
		expression, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("compile %s pattern %q: %w", kind, pattern, err)
		}
		compiled = append(compiled, expression)
	}
	return compiled, nil
}

// ReadOnly reports whether writes are refused, for hello and status.
func (p *Policy) ReadOnly() bool {
	return p.readOnly
}

// Workdir is the resolved confinement root, empty when file operations are unconfined.
func (p *Policy) Workdir() string {
	return p.workdir
}

// CheckExec decides whether a command may run. Deny is evaluated before allow, so a deny
// pattern cannot be defeated by widening the allow list.
func (p *Policy) CheckExec(command string) error {
	if p.readOnly {
		return fmt.Errorf("%w: this computer runs in read-only mode", ErrDenied)
	}
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return fmt.Errorf("%w: empty command", ErrDenied)
	}
	for _, expression := range p.deny {
		if expression.MatchString(command) {
			return fmt.Errorf("%w: the command matches the deny pattern %s", ErrDenied, expression.String())
		}
	}
	if len(p.allow) == 0 {
		return nil
	}
	for _, expression := range p.allow {
		if expression.MatchString(command) {
			return nil
		}
	}
	return fmt.Errorf("%w: the command matches no allow pattern", ErrDenied)
}

// CheckRead resolves a path for reading and confines it when asked.
func (p *Policy) CheckRead(path string) (string, error) {
	return p.checkPath(path)
}

// CheckWrite resolves a path for writing, and refuses every write in read-only mode.
func (p *Policy) CheckWrite(path string) (string, error) {
	if p.readOnly {
		return "", fmt.Errorf("%w: this computer runs in read-only mode", ErrDenied)
	}
	return p.checkPath(path)
}

// checkPath resolves symlinks before comparing, because a prefix test on the literal string
// lets a symlink inside the working directory point anywhere on the machine.
func (p *Policy) checkPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%w: empty path", ErrDenied)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%w: resolve %s: %s", ErrDenied, path, err)
	}
	resolved := resolveExisting(absolute)
	if !p.workdirOnly {
		return resolved, nil
	}
	relative, err := filepath.Rel(p.workdir, resolved)
	if err != nil {
		return "", fmt.Errorf("%w: %s is outside the working directory", ErrDenied, path)
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %s is outside the working directory", ErrDenied, path)
	}
	return resolved, nil
}

// resolveExisting follows symlinks as far up the path as the filesystem goes, then re-attaches
// the components that do not exist yet — an upload names a file that is about to be created.
func resolveExisting(absolute string) string {
	remainder := ""
	current := absolute
	for {
		if evaluated, err := filepath.EvalSymlinks(current); err == nil {
			if remainder == "" {
				return evaluated
			}
			return filepath.Join(evaluated, remainder)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return absolute
		}
		remainder = filepath.Join(filepath.Base(current), remainder)
		current = parent
	}
}

// EnsureDirectory creates a directory the daemon owns, with permissions that keep other local
// users out of a machine that is shared.
func EnsureDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	return nil
}
