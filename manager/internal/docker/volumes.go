package docker

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/volume"
)

// SelfImage returns the image the manager itself runs from, the one image that
// is guaranteed to be on the host without a pull.
func (c *Client) SelfImage(ctx context.Context) (string, error) {
	// Inside a container the hostname is the container ID unless it was
	// overridden, which the platform's own compose file never does.
	host, err := os.Hostname()
	if err != nil {
		return "", err
	}
	self, err := c.Inspect(ctx, host)
	if err != nil {
		return "", fmt.Errorf("could not identify the manager container: %w", err)
	}
	return self.Image, nil
}

// ErrVolumeMissing separates "there was nothing to copy" from a copy that
// failed, so a caller can skip the first without skipping the second.
var ErrVolumeMissing = errors.New("source volume does not exist")

// CopyVolume duplicates a named volume's contents into a new one. Docker has no
// rename and a volume is only reachable through the daemon, so the copy runs in
// a throwaway container with both ends mounted.
//
// ponytail: the source is copied while whatever writes to it may still be
// running, so a database mid-write can arrive torn. Stop the container first.
func (c *Client) CopyVolume(ctx context.Context, from, to string) error {
	// Binding a volume that does not exist would create an empty one and report
	// a copy that copied nothing.
	if _, err := c.api.VolumeInspect(ctx, from); err != nil {
		return fmt.Errorf("source volume %s: %w: %w", from, ErrVolumeMissing, err)
	}
	image, err := c.SelfImage(ctx)
	if err != nil {
		return err
	}
	if _, err := c.api.VolumeCreate(ctx, volume.CreateOptions{Name: to}); err != nil {
		return err
	}
	created, err := c.api.ContainerCreate(ctx,
		&container.Config{Image: image, Entrypoint: []string{"cp", "-a", "/from/.", "/to/"}},
		&container.HostConfig{Binds: []string{from + ":/from:ro", to + ":/to"}},
		nil, nil, "")
	if err != nil {
		return err
	}
	defer func() { _ = c.Remove(context.WithoutCancel(ctx), created.ID, true) }()

	if err := c.Start(ctx, created.ID); err != nil {
		return err
	}
	statusCh, errCh := c.api.ContainerWait(ctx, created.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		return err
	case status := <-statusCh:
		if status.StatusCode != 0 {
			return fmt.Errorf("copy %s to %s exited with status %d", from, to, status.StatusCode)
		}
	}
	return nil
}
