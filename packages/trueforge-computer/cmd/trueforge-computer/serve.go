package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"trueforge.dev/computer/internal/agent"
	"trueforge.dev/computer/internal/audit"
	"trueforge.dev/computer/internal/conn"
	"trueforge.dev/computer/internal/files"
	"trueforge.dev/computer/internal/policy"
	"trueforge.dev/computer/internal/protocol"
	"trueforge.dev/computer/internal/runner"
	"trueforge.dev/computer/internal/state"
)

// patternList collects a repeatable flag, because one regex per flag reads better in a unit
// file than one flag holding a delimiter that a regex may contain.
type patternList []string

func (p *patternList) String() string { return strings.Join(*p, ", ") }

func (p *patternList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("an empty pattern matches everything; remove the flag instead")
	}
	*p = append(*p, value)
	return nil
}

func runServe(args []string) int {
	set := flag.NewFlagSet("run", flag.ContinueOnError)
	url := set.String("url", os.Getenv(state.EnvURL), "base URL of the TrueForge server; defaults to the enrolled one")
	code := set.String("code", os.Getenv(state.EnvEnrollCode), "enrollment code to use when this computer is not enrolled yet")
	name := set.String("name", "", "hostname to report instead of this machine's own")
	stateDir := set.String("state-dir", state.DefaultDir(), "where the credential, config and audit log are kept")
	workdir := set.String("workdir", "", "root for the per-session directories; defaults to <state-dir>/sessions")
	allowRoot := set.Bool("allow-root", false, "run as root anyway")
	readOnly := set.Bool("read-only", false, "refuse every exec and every write")
	workdirOnly := set.Bool("workdir-only", false, "refuse file operations outside the working directory")
	maxConcurrent := set.Int("max-concurrent", 4, "how many commands may run at once")
	maxQueue := set.Int("max-queue", 32, "how many commands may wait for a slot")
	logFormat := set.String("log-format", "json", "json or text")
	var allow, deny patternList
	set.Var(&allow, "allow", "regular expression a command must match; repeatable, and an empty list allows everything")
	set.Var(&deny, "deny", "regular expression a command must not match; repeatable, and checked before --allow")

	if err := set.Parse(args); err != nil {
		return exitUsage
	}
	logger := newLogger(*logFormat)

	if err := state.CheckRoot(os.Getuid(), *allowRoot); err != nil {
		logger.Error(err.Error())
		return exitUsage
	}
	if err := state.Ensure(*stateDir); err != nil {
		return fail(logger, "could not prepare the state directory", err)
	}

	ctx, stop := notifyContext()
	defer stop()

	config, credential, err := ensureEnrolled(ctx, *stateDir, *url, *code, *name, *logFormat)
	if err != nil {
		if errors.Is(err, state.ErrNotEnrolled) {
			logger.Error(errNotEnrolled.Error())
			return exitUsage
		}
		if errors.Is(err, conn.ErrRevoked) {
			return exitRevoked
		}
		return fail(logger, "could not start", err)
	}

	sessions := *workdir
	if sessions == "" {
		sessions = state.SessionsDir(*stateDir)
	}
	if err := policy.EnsureDirectory(sessions); err != nil {
		return fail(logger, "could not prepare the working directory", err)
	}

	rules, err := policy.New(policy.Options{
		ReadOnly:    *readOnly,
		Allow:       allow,
		Deny:        deny,
		WorkdirOnly: *workdirOnly,
		Workdir:     sessions,
	})
	if err != nil {
		return fail(logger, "the local policy is not usable", err)
	}

	log, err := audit.Open(*stateDir)
	if err != nil {
		return fail(logger, "could not open the audit log", err)
	}
	defer func() { _ = log.Close() }()

	// Commands started by a previous run survive a kill, reparented to PID 1, so they are
	// reaped before this one accepts anything new.
	if reaped := runner.Sweep(*stateDir, logger); reaped > 0 {
		logger.Warn("reaped commands left behind by a previous run", "count", reaped)
	}

	commands := runner.New(runner.Options{
		MaxConcurrent: *maxConcurrent,
		MaxQueue:      *maxQueue,
		DefaultCwd:    sessions,
		StateDir:      *stateDir,
		Logger:        logger,
	})
	defer commands.Shutdown()

	worker := agent.New(rules, commands, files.NewTransfers(), log, logger)
	hello := protocol.Hello{
		Type:            "hello",
		ProtocolVersion: protocol.Version,
		Hostname:        state.Hostname(firstNonEmpty(*name, config.Name)),
		OS:              state.OS(),
		Arch:            state.Arch(),
		Version:         version,
		RunAsUser:       state.RunAsUser(),
		Capabilities:    state.DetectCapabilities(),
	}

	client, err := conn.New(conn.Options{
		BaseURL:      config.URL,
		Credential:   credential,
		Hello:        hello,
		Dispatch:     worker.Dispatch,
		OnDisconnect: worker.OnDisconnect,
		Logger:       logger,
	})
	if err != nil {
		return fail(logger, "could not prepare the connection", err)
	}

	logger.Info("starting",
		"computer_id", config.ComputerID,
		"url", config.URL,
		"version", version,
		"run_as", hello.RunAsUser,
		"state_dir", *stateDir,
		"workdir", sessions,
		"read_only", *readOnly,
		"workdir_only", *workdirOnly,
		"allow_patterns", len(allow),
		"deny_patterns", len(deny),
		"capabilities", hello.Capabilities)

	err = client.Run(ctx)
	// Shutdown runs through the deferred call above, so nothing this daemon started outlives
	// it on purpose.
	switch {
	case errors.Is(err, conn.ErrRevoked):
		return exitRevoked
	case errors.Is(err, context.Canceled), err == nil:
		logger.Info("stopped")
		return exitOK
	default:
		return fail(logger, "stopped", err)
	}
}

// ensureEnrolled loads the stored credential, or exchanges a code for one. The container
// one-liner passes the same code on every restart, so a code presented by an already-enrolled
// computer is ignored rather than spent.
func ensureEnrolled(ctx context.Context, stateDir string, url string, code string, name string, logFormat string) (state.Config, string, error) {
	credential, err := state.ReadCredential(stateDir)
	if err == nil {
		config, configErr := state.LoadConfig(stateDir)
		if configErr != nil && !errors.Is(configErr, state.ErrNotEnrolled) {
			return state.Config{}, "", configErr
		}
		if override := strings.TrimSuffix(strings.TrimSpace(url), "/"); override != "" {
			config.URL = override
		}
		if config.URL == "" {
			return state.Config{}, "", errors.New("no server URL is stored and none was given; pass --url")
		}
		return config, credential, nil
	}
	if !errors.Is(err, state.ErrNotEnrolled) {
		return state.Config{}, "", err
	}
	if strings.TrimSpace(code) == "" {
		return state.Config{}, "", state.ErrNotEnrolled
	}

	enrollCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	result, err := performEnrollment(enrollCtx, &enrollFlags{
		url:       url,
		code:      code,
		name:      name,
		stateDir:  stateDir,
		logFormat: logFormat,
	})
	if err != nil {
		return state.Config{}, "", fmt.Errorf("enroll: %w", err)
	}
	config, err := state.LoadConfig(stateDir)
	if err != nil {
		return state.Config{}, "", err
	}
	return config, result.MachineCredential, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
