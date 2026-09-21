package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"trueforge.dev/computer/internal/enroll"
	"trueforge.dev/computer/internal/state"
)

type enrollFlags struct {
	url       string
	code      string
	name      string
	stateDir  string
	logFormat string
}

func bindEnrollFlags(set *flag.FlagSet) *enrollFlags {
	flags := &enrollFlags{}
	set.StringVar(&flags.url, "url", os.Getenv(state.EnvURL), "base URL of the TrueForge server, for example https://trueforge.example.com")
	set.StringVar(&flags.code, "code", os.Getenv(state.EnvEnrollCode), "single-use enrollment code from Settings → Computers")
	set.StringVar(&flags.name, "name", "", "hostname to report instead of this machine's own")
	set.StringVar(&flags.stateDir, "state-dir", state.DefaultDir(), "where the credential and config are kept")
	set.StringVar(&flags.logFormat, "log-format", "text", "json or text")
	return flags
}

func runEnroll(args []string) int {
	set := flag.NewFlagSet("enroll", flag.ContinueOnError)
	flags := bindEnrollFlags(set)
	if err := set.Parse(args); err != nil {
		return exitUsage
	}
	logger := newLogger(flags.logFormat)

	if strings.TrimSpace(flags.url) == "" || strings.TrimSpace(flags.code) == "" {
		fmt.Fprintf(os.Stderr, "both --url and --code are required (or %s and %s)\n", state.EnvURL, state.EnvEnrollCode)
		return exitUsage
	}

	ctx, stop := notifyContext()
	defer stop()

	result, err := performEnrollment(ctx, flags)
	if err != nil {
		if errors.Is(err, enroll.ErrCodeRejected) {
			fmt.Fprintln(os.Stderr, "The enrollment code was refused. Codes are single use and expire after 15 minutes; issue a new one from Settings → Computers.")
			return exitFailure
		}
		return fail(logger, "enrollment failed", err)
	}

	logger.Info("enrolled",
		"computer_id", result.ComputerID,
		"state_dir", flags.stateDir,
		"credential", state.CredentialPath(flags.stateDir))
	fmt.Printf("Enrolled as %s. Start the daemon with:\n  trueforge-computer run\n", result.ComputerID)
	return exitOK
}

// performEnrollment exchanges the code and stores what came back. It is also the path `run`
// takes when it is handed a code and has no credential yet, which is what makes the container
// one-liner work across a restart.
func performEnrollment(ctx context.Context, flags *enrollFlags) (enroll.Result, error) {
	hostname := state.Hostname(flags.name)
	client := &http.Client{Timeout: 30 * time.Second}
	result, err := enroll.Do(ctx, client, flags.url, enroll.Request{
		EnrollmentCode: strings.TrimSpace(flags.code),
		Hostname:       hostname,
		OS:             state.OS(),
		Arch:           state.Arch(),
		Version:        version,
	})
	if err != nil {
		return enroll.Result{}, err
	}
	if err := state.WriteCredential(flags.stateDir, result.MachineCredential); err != nil {
		return enroll.Result{}, fmt.Errorf("store the machine credential: %w", err)
	}
	config := state.Config{
		URL:        strings.TrimSuffix(strings.TrimSpace(flags.url), "/"),
		ComputerID: result.ComputerID,
		Name:       hostname,
	}
	if err := state.SaveConfig(flags.stateDir, config); err != nil {
		return enroll.Result{}, fmt.Errorf("store the config: %w", err)
	}
	return result, nil
}
