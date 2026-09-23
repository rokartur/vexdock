package projects

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// SetRegistryLogin stores the private registry an image-sourced service pulls
// from. An empty username clears the login; an empty password keeps the stored one.
func (s *Service) SetRegistryLogin(svc *database.Service, registryURL, username, password string) error {
	if strings.TrimSpace(username) == "" {
		svc.RegistryURL, svc.RegistryUsername, svc.RegistryPasswordEnc = "", "", ""
		return nil
	}
	user, err := security.ValidateCommandArg("registry username", username)
	if err != nil {
		return err
	}
	url := ""
	if strings.TrimSpace(registryURL) != "" {
		if url, err = security.ValidateCommandArg("registry url", registryURL); err != nil {
			return err
		}
	}
	if password == "" {
		if svc.RegistryPasswordEnc == "" {
			return fmt.Errorf("a registry password is required")
		}
		svc.RegistryURL, svc.RegistryUsername = url, user
		return nil
	}
	enc, err := s.cipher.Encrypt(password)
	if err != nil {
		return err
	}
	svc.RegistryURL, svc.RegistryUsername, svc.RegistryPasswordEnc = url, user, enc
	return nil
}

// RegistryLogin logs the daemon into the service's registry, if it has one.
func (s *Service) RegistryLogin(ctx context.Context, svc *database.Service) error {
	if svc.RegistryUsername == "" {
		return nil
	}
	password, err := s.cipher.Decrypt(svc.RegistryPasswordEnc)
	if err != nil {
		return err
	}
	return DockerLogin(ctx, svc.RegistryURL, svc.RegistryUsername, password)
}

// DockerLogin authenticates the daemon against a registry; an empty URL is
// Docker Hub. The password is piped on stdin so it never appears in the
// process arguments.
func DockerLogin(ctx context.Context, registryURL, username, password string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := []string{"login", "--username", username, "--password-stdin"}
	if registryURL != "" {
		args = append(args, registryURL)
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin = strings.NewReader(password)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("registry login failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
