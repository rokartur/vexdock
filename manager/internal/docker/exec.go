package docker

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
)

// ShellCandidates is the fallback chain used when attaching a terminal.
var ShellCandidates = []string{"/bin/bash", "/bin/sh"}

// ExecOutput runs a non-interactive command inside a container and returns its
// combined output plus exit code. Used for `nginx -t` and `nginx -s reload`.
func (c *Client) ExecOutput(ctx context.Context, containerID string, argv []string) (string, int, error) {
	created, err := c.api.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		AttachStdout: true,
		AttachStderr: true,
		Cmd:          argv,
	})
	if err != nil {
		return "", -1, fmt.Errorf("exec create: %w", err)
	}
	resp, err := c.api.ContainerExecAttach(ctx, created.ID, container.ExecAttachOptions{})
	if err != nil {
		return "", -1, fmt.Errorf("exec attach: %w", err)
	}
	defer resp.Close()

	var out strings.Builder
	if _, err := stdcopy.StdCopy(&out, &out, resp.Reader); err != nil {
		return out.String(), -1, fmt.Errorf("exec read: %w", err)
	}
	inspect, err := c.api.ContainerExecInspect(ctx, created.ID)
	if err != nil {
		return out.String(), -1, fmt.Errorf("exec inspect: %w", err)
	}
	return out.String(), inspect.ExitCode, nil
}

// ExecSession is an attached interactive exec instance.
type ExecSession struct {
	ID       string
	Response types.HijackedResponse
}

func (s *ExecSession) Close() { s.Response.Close() }

// Exec starts an interactive TTY exec, trying bash then sh. `cmd` overrides the
// fallback chain when non-empty. Arguments are passed as a slice, never
// concatenated into a shell string.
func (c *Client) Exec(ctx context.Context, containerID string, cmd []string, cols, rows uint) (*ExecSession, error) {
	candidates := [][]string{}
	if len(cmd) > 0 {
		candidates = append(candidates, cmd)
	} else {
		for _, shell := range ShellCandidates {
			candidates = append(candidates, []string{shell})
		}
	}

	var lastErr error
	for _, argv := range candidates {
		created, err := c.api.ContainerExecCreate(ctx, containerID, container.ExecOptions{
			AttachStdin:  true,
			AttachStdout: true,
			AttachStderr: true,
			Tty:          true,
			Cmd:          argv,
		})
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := c.api.ContainerExecAttach(ctx, created.ID, container.ExecAttachOptions{Tty: true})
		if err != nil {
			lastErr = err
			continue
		}
		// A missing binary is only reported after the exec starts, so confirm a
		// process actually came up before handing the session to the caller.
		if err := c.waitExecStarted(ctx, created.ID); err != nil {
			resp.Close()
			lastErr = err
			continue
		}
		if cols > 0 && rows > 0 {
			_ = c.ResizeExec(ctx, created.ID, cols, rows)
		}
		return &ExecSession{ID: created.ID, Response: resp}, nil
	}
	if lastErr == nil {
		lastErr = errShellUnavailable
	}
	return nil, lastErr
}

func (c *Client) ResizeExec(ctx context.Context, execID string, cols, rows uint) error {
	return c.api.ContainerExecResize(ctx, execID, container.ResizeOptions{Width: cols, Height: rows})
}

// waitExecStarted distinguishes a live shell from a failed start. The daemon
// reports a missing binary as Pid 0 followed by ExitCode 127, so a non-zero Pid
// is the only positive signal that the process is really running.
func (c *Client) waitExecStarted(ctx context.Context, execID string) error {
	deadline := time.Now().Add(2 * time.Second)
	for {
		inspect, err := c.api.ContainerExecInspect(ctx, execID)
		if err != nil {
			return err
		}
		if inspect.Pid != 0 {
			return nil
		}
		if !inspect.Running {
			return errShellUnavailable
		}
		if time.Now().After(deadline) {
			return errShellUnavailable
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

type shellError string

func (e shellError) Error() string { return string(e) }

const errShellUnavailable shellError = "no usable shell found in container (tried bash and sh)"
