package policy_test

import (
	"slices"
	"testing"

	"trueforge.dev/computer/internal/policy"
)

func refusedNames(t *testing.T, p *policy.Policy, names ...string) []string {
	t.Helper()
	overrides := make(map[string]string, len(names))
	for _, name := range names {
		overrides[name] = "value"
	}
	_, refused := p.FilterEnv(overrides)
	return refused
}

// The dynamic linker runs these before anything on this side can look at them, so there is no
// mode and no flag in which they are accepted.
func TestLoaderVariablesAreAlwaysRefused(t *testing.T) {
	loaders := []string{"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES"}
	for _, options := range []policy.Options{
		{},
		{Allow: []string{`.*`}},
		{AllowEnv: loaders},
	} {
		p := mustNew(t, options)
		refused := refusedNames(t, p, loaders...)
		if len(refused) != len(loaders) {
			t.Fatalf("with %+v the loader variables were accepted: refused %v", options, refused)
		}
	}
}

// The wider family is refused once the operator has constrained the computer. On an
// unconstrained one the server can already run anything, so refusing PATH would be theatre.
func TestInterpreterHooksAreRefusedOnlyWhenConstrained(t *testing.T) {
	hooks := []string{
		"BASH_ENV", "ENV", "PATH", "IFS", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND",
		"GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR",
		"GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND",
		"GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT",
		"PAGER", "EDITOR", "VISUAL",
		"PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "PERL5OPT", "RUBYOPT",
	}

	unconstrained := mustNew(t, policy.Options{})
	if refused := refusedNames(t, unconstrained, hooks...); len(refused) != 0 {
		t.Fatalf("an unconstrained computer refused %v", refused)
	}

	for _, options := range []policy.Options{
		{Allow: []string{`git .*`}},
		{Deny: []string{`rm`}},
		{ReadOnly: true},
	} {
		p := mustNew(t, options)
		refused := refusedNames(t, p, hooks...)
		if len(refused) != len(hooks) {
			missing := []string{}
			for _, hook := range hooks {
				if !slices.Contains(refused, hook) {
					missing = append(missing, hook)
				}
			}
			t.Fatalf("with %+v these were accepted: %v", options, missing)
		}
	}
}

// With an allow list of "^git ", an unfiltered GIT_SSH_COMMAND runs whatever it names.
func TestAllowEnvIsTheEscapeHatch(t *testing.T) {
	p := mustNew(t, policy.Options{
		Allow:    []string{`git .*`},
		AllowEnv: []string{"GIT_SSH_COMMAND", "PATH"},
	})
	if refused := refusedNames(t, p, "GIT_SSH_COMMAND", "PATH"); len(refused) != 0 {
		t.Fatalf("--allow-env was not honoured: %v", refused)
	}
	if refused := refusedNames(t, p, "GIT_ASKPASS"); len(refused) != 1 {
		t.Fatalf("--allow-env widened past what it named: %v", refused)
	}
}

// Ordinary variables are what the environment is for; the filter must not touch them.
func TestOrdinaryVariablesPassThrough(t *testing.T) {
	p := mustNew(t, policy.Options{Allow: []string{`.*`}})
	accepted, refused := p.FilterEnv(map[string]string{
		"TFY_SESSION_ID": "sess-1",
		"CI":             "true",
		"LD_PRELOAD":     "/tmp/evil.so",
	})
	if len(refused) != 1 || refused[0] != "LD_PRELOAD" {
		t.Fatalf("refused = %v", refused)
	}
	if accepted["TFY_SESSION_ID"] != "sess-1" || accepted["CI"] != "true" {
		t.Fatalf("accepted = %v", accepted)
	}
	if _, present := accepted["LD_PRELOAD"]; present {
		t.Fatal("a refused variable was also accepted")
	}
}

// Environment names are matched case-insensitively: on a case-insensitive lookup the shell
// would still find ld_preload, and matching only the upper case spelling invites the bypass.
func TestRefusalIgnoresCase(t *testing.T) {
	p := mustNew(t, policy.Options{Allow: []string{`.*`}})
	if refused := refusedNames(t, p, "ld_preload", "Git_Ssh_Command"); len(refused) != 2 {
		t.Fatalf("a differently cased name got through: %v", refused)
	}
}
