package desktop

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// supervise keeps one process running until ctx ends, restarting it with backoff. before, when
// set, gates every start, so a client of the display waits for the display.
func (d *Desktop) supervise(ctx context.Context, name string, argv []string, before func(context.Context) error) {
	d.supervised.Add(1)
	go func() {
		defer d.supervised.Done()
		delay := restartMin
		for ctx.Err() == nil {
			if before != nil {
				if err := before(ctx); err != nil {
					return
				}
			}
			startedAt := time.Now()
			err := d.runOnce(ctx, argv)
			if ctx.Err() != nil {
				return
			}
			if time.Since(startedAt) >= stableAfter {
				delay = restartMin
			}
			d.logger.Warn("a desktop process exited; restarting it", "process", name, "error", errorText(err), "restart_in", delay.String())
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			delay = min(delay*2, restartMax)
		}
	}()
}

// runOnce runs the process in its own group, so stopping it also stops whatever it started.
func (d *Desktop) runOnce(ctx context.Context, argv []string) error {
	command := exec.CommandContext(ctx, argv[0], argv[1:]...)
	command.Env = d.commandEnv()
	command.Dir = d.dir
	command.SysProcAttr = processAttributes()
	command.Cancel = func() error {
		return syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	}
	command.WaitDelay = stopGrace
	return command.Run()
}

func errorText(err error) string {
	if err == nil {
		return "exited cleanly"
	}
	return err.Error()
}
