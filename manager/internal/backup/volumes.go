package backup

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/vexdock/platform/manager/internal/docker"
)

// backupVolumes writes <dir>/volumes/<name>.tar.gz for every named volume that
// belongs to a managed project.
//
// ponytail: volumes are archived while their containers keep running, so a
// database that is mid-write can end up torn. Stop the project first if the
// snapshot has to be transactional.
func (s *Service) backupVolumes(ctx context.Context, dir string) error {
	projects, err := s.db.ListProjects(ctx)
	if err != nil {
		return err
	}
	managed := make(map[string]bool, len(projects))
	for _, p := range projects {
		managed[p.ComposeProjectName] = true
	}

	list, err := s.docker.ListVolumes(ctx)
	if err != nil {
		return err
	}
	image, err := s.selfImage(ctx)
	if err != nil {
		return err
	}
	out := filepath.Join(dir, "volumes")
	if err := os.MkdirAll(out, 0o700); err != nil {
		return err
	}
	for _, v := range list.Volumes {
		if v == nil || !managed[v.Labels[docker.ComposeProjectLabel]] {
			continue
		}
		if err := archiveVolume(ctx, image, v.Name, out); err != nil {
			return fmt.Errorf("back up volume %s: %w", v.Name, err)
		}
	}
	return nil
}

// selfImage returns the image this manager runs from, so the tar helper reuses
// an image that is guaranteed to be present instead of pulling one.
func (s *Service) selfImage(ctx context.Context) (string, error) {
	// Inside a container the hostname is the container ID unless it was
	// overridden, which the platform's own compose file never does.
	host, err := os.Hostname()
	if err != nil {
		return "", err
	}
	self, err := s.docker.Inspect(ctx, host)
	if err != nil {
		return "", fmt.Errorf("could not identify the manager container: %w", err)
	}
	return self.Image, nil
}

// archiveVolume runs a throwaway container because a named volume is only
// reachable through the Docker daemon, never from the manager's own filesystem.
// outDir is identical on host and in container (see compose.yml).
func archiveVolume(ctx context.Context, image, volume, outDir string) error {
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", volume+":/src:ro",
		"-v", outDir+":/out",
		"--entrypoint", "tar", image,
		"czf", "/out/"+volume+".tar.gz", "-C", "/src", ".")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
