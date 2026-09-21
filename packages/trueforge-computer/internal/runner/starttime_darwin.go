//go:build darwin

package runner

import "golang.org/x/sys/unix"

// processStartTime asks the kernel when the process started, through kern.proc.pid. Without
// it the sweep could not tell our command from whatever later reused its pid, and on macOS
// there is no /proc to read.
func processStartTime(pid int) (uint64, bool) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || info == nil {
		return 0, false
	}
	started := info.Proc.P_starttime
	return uint64(started.Sec)*1_000_000 + uint64(started.Usec), true
}

// processCmdline has no cheap equivalent here; the start time alone identifies the process.
func processCmdline(_ int) (string, bool) {
	return "", false
}
