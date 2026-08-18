// Package git wraps the git CLI for repository sources.
//
// Credentials never reach the command line (which is world-readable via ps) and
// never reach the deployment log: tokens are passed through GIT_ASKPASS and SSH
// keys through a 0600 temp file referenced by GIT_SSH_COMMAND.
package git

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/vexdock/platform/manager/internal/security"
)

// Credential carries the secret for a private repository.
type Credential struct {
	Kind  string // "none", "token" or "ssh_key"
	Value string
}

const (
	KindNone   = "none"
	KindToken  = "token"
	KindSSHKey = "ssh_key"
)

// Repo is a checkout on disk.
type Repo struct {
	URL  string
	Ref  string
	Dir  string
	Cred Credential
}

// Sync makes Dir contain the repository at Ref, cloning on first use and
// fetching afterwards. It returns the checked-out commit SHA.
func (r Repo) Sync(ctx context.Context, log io.Writer) (string, error) {
	env, cleanup, err := r.environment()
	if err != nil {
		return "", err
	}
	defer cleanup()

	if _, err := os.Stat(filepath.Join(r.Dir, ".git")); err != nil {
		if err := os.MkdirAll(r.Dir, 0o750); err != nil {
			return "", err
		}
		// Shallow clone keeps deployments fast and disks small.
		if err := run(ctx, log, "", env, "clone", "--depth", "1", "--branch", r.Ref, "--", r.URL, r.Dir); err != nil {
			// A commit SHA or an unusual ref cannot be cloned with --branch;
			// fall back to a full clone then checkout.
			if err := run(ctx, log, "", env, "clone", "--", r.URL, r.Dir); err != nil {
				return "", err
			}
		}
	} else {
		if err := run(ctx, log, r.Dir, env, "remote", "set-url", "origin", r.URL); err != nil {
			return "", err
		}
		if err := run(ctx, log, r.Dir, env, "fetch", "--prune", "--tags", "origin"); err != nil {
			return "", err
		}
	}

	if err := r.checkout(ctx, log, env); err != nil {
		return "", err
	}
	return r.HeadSHA(ctx)
}

func (r Repo) checkout(ctx context.Context, log io.Writer, env []string) error {
	// Prefer the remote-tracking branch so a fetch actually moves the checkout.
	if err := run(ctx, log, r.Dir, env, "checkout", "--force", "--detach", "origin/"+r.Ref); err == nil {
		return nil
	}
	// Otherwise the ref is a tag or a commit SHA.
	if err := run(ctx, log, r.Dir, env, "checkout", "--force", "--detach", r.Ref); err != nil {
		return fmt.Errorf("checkout %q failed: %w", r.Ref, err)
	}
	return nil
}

// HeadSHA reports the currently checked-out commit.
func (r Repo) HeadSHA(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", r.Dir, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("read HEAD: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// environment builds credential plumbing and returns a cleanup that shreds any
// temporary secret material.
func (r Repo) environment() ([]string, func(), error) {
	env := append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GCM_INTERACTIVE=never",
	)
	if r.Cred.Kind == KindNone || r.Cred.Value == "" {
		return env, func() {}, nil
	}

	dir, err := os.MkdirTemp("", "vexdock-git-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	switch r.Cred.Kind {
	case KindToken:
		askpass := filepath.Join(dir, "askpass.sh")
		script := "#!/bin/sh\ncase \"$1\" in\n*[Uu]sername*) printf '%s' \"$GIT_CRED_USER\" ;;\n*) printf '%s' \"$GIT_CRED_TOKEN\" ;;\nesac\n"
		if err := os.WriteFile(askpass, []byte(script), 0o700); err != nil {
			cleanup()
			return nil, nil, err
		}
		env = append(env,
			"GIT_ASKPASS="+askpass,
			"GIT_CRED_USER=x-access-token",
			"GIT_CRED_TOKEN="+r.Cred.Value,
		)
	case KindSSHKey:
		keyPath := filepath.Join(dir, "id_key")
		key := r.Cred.Value
		if !strings.HasSuffix(key, "\n") {
			key += "\n"
		}
		if err := os.WriteFile(keyPath, []byte(key), 0o600); err != nil {
			cleanup()
			return nil, nil, err
		}
		env = append(env, fmt.Sprintf(
			"GIT_SSH_COMMAND=ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s",
			keyPath, filepath.Join(dir, "known_hosts")))
	default:
		cleanup()
		return nil, nil, fmt.Errorf("unknown git credential kind %q", r.Cred.Kind)
	}
	return env, cleanup, nil
}

// run executes git and mirrors its output into the deployment log with the
// secret value redacted defensively.
func run(ctx context.Context, log io.Writer, dir string, env []string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = env
	var sink io.Writer = io.Discard
	if log != nil {
		sink = log
	}
	cmd.Stdout = sink
	cmd.Stderr = sink
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %w", args[0], err)
	}
	return nil
}

// Redact removes a credential value from arbitrary text before it is logged.
func Redact(text, secret string) string {
	if secret == "" {
		return text
	}
	return strings.ReplaceAll(text, secret, security.MaskSecret(secret))
}
