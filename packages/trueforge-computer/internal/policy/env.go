package policy

import (
	"sort"
	"strings"
)

// Variables the shell and the common interpreters treat as "run this code". A server that can
// set one of these can run whatever it likes through a command that the allow list permits,
// which would make the allow list decorative.
var alwaysRefusedPrefixes = []string{
	// The dynamic linker executes these before the program's own main.
	"LD_",
	"DYLD_",
}

// Refused whenever the operator has constrained this computer at all. They are not refused on
// an unconstrained computer, where the server can already run anything and a legitimate one
// may want to set PATH.
var restrictedNames = map[string]struct{}{
	// The shell reads and executes these.
	"BASH_ENV":       {},
	"ENV":            {},
	"SHELLOPTS":      {},
	"BASHOPTS":       {},
	"PS4":            {},
	"PROMPT_COMMAND": {},
	"IFS":            {},
	// PATH decides which binary a permitted command name resolves to.
	"PATH": {},
	// git runs each of these as a program.
	"GIT_SSH":           {},
	"GIT_SSH_COMMAND":   {},
	"GIT_EXTERNAL_DIFF": {},
	"GIT_PAGER":         {},
	"GIT_EDITOR":        {},
	"GIT_ASKPASS":       {},
	"GIT_EXEC_PATH":     {},
	"GIT_PROXY_COMMAND": {},
	// A pager or editor is spawned by many tools.
	"PAGER":  {},
	"EDITOR": {},
	"VISUAL": {},
	// Interpreters that load code named by the environment.
	"PYTHONSTARTUP": {},
	"PYTHONPATH":    {},
	"PYTHONHOME":    {},
	"NODE_OPTIONS":  {},
	"PERL5OPT":      {},
	"RUBYOPT":       {},
}

// GIT_CONFIG and its family redirect git's configuration, and configuration names programs.
var restrictedPrefixes = []string{"GIT_CONFIG"}

// FilterEnv splits the environment the server asked for into what may be passed through and
// what is refused. The caller refuses the whole request when anything comes back refused,
// rather than silently dropping a variable the command may depend on.
func (p *Policy) FilterEnv(overrides map[string]string) (accepted map[string]string, refused []string) {
	accepted = make(map[string]string, len(overrides))
	for name, value := range overrides {
		if p.envRefused(name) {
			refused = append(refused, name)
			continue
		}
		accepted[name] = value
	}
	sort.Strings(refused)
	return accepted, refused
}

func (p *Policy) envRefused(name string) bool {
	upper := strings.ToUpper(name)
	for _, prefix := range alwaysRefusedPrefixes {
		if strings.HasPrefix(upper, prefix) {
			// No escape hatch: the dynamic linker runs this before anything can check it.
			return true
		}
	}
	if !p.restricted {
		return false
	}
	if _, allowed := p.allowedEnv[name]; allowed {
		return false
	}
	if _, listed := restrictedNames[upper]; listed {
		return true
	}
	for _, prefix := range restrictedPrefixes {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	return false
}
