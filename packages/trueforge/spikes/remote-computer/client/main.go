// Phase 8a spike client: dials the relay, answers ops, reconnects forever. Throwaway code.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
)

const clientVersion = "0.0.1-spike"

// envDefault keeps flags and environment in one place; the real binary adds config.toml.
func envDefault(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// scrubbedEnv builds the command environment: a minimal base plus the caller's overrides, never the
// daemon's own credential.
func scrubbedEnv(overrides map[string]string) []string {
	base := map[string]string{
		"PATH": envDefault("PATH", "/usr/local/bin:/usr/bin:/bin"),
		"HOME": envDefault("HOME", "/tmp"),
		"LANG": envDefault("LANG", "C.UTF-8"),
		"TERM": "dumb",
	}
	for key, value := range overrides {
		if key == "" || strings.ContainsAny(key, "=\x00") {
			continue
		}
		base[key] = value
	}
	out := make([]string, 0, len(base))
	for key, value := range base {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

func main() {
	url := flag.String("url", envDefault("TRUEFORGE_URL", ""), "base URL of the relay, for example wss://host")
	computer := flag.String("computer-id", envDefault("TRUEFORGE_COMPUTER_ID", "spike"), "computer id this client serves")
	token := flag.String("token", envDefault("TRUEFORGE_TOKEN", ""), "bearer credential")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if *url == "" || *token == "" {
		logger.Error("both --url and --token are required")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	agent := &client{
		url:       *url,
		computer:  *computer,
		token:     *token,
		version:   clientVersion,
		runner:    newRunner(),
		transfers: newTransfers(),
		logger:    logger,
	}
	err := agent.runForever(ctx)
	switch {
	case errors.Is(err, errRevoked):
		os.Exit(3)
	case errors.Is(err, context.Canceled):
		logger.Info("stopped")
	default:
		logger.Error("stopped", "error", err.Error())
		os.Exit(1)
	}
}
