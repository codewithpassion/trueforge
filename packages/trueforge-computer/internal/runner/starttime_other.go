//go:build !linux

package runner

// processStartTime has no portable equivalent outside Linux, so the startup sweep falls back
// to "does this group still exist", which can match a recycled pid.
func processStartTime(_ int) (uint64, bool) {
	return 0, false
}
