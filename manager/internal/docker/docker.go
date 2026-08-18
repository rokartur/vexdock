// Package docker wraps the Docker Engine SDK. Nothing in the platform parses
// `docker ps`/`docker inspect` output: every read goes through the Engine API.
package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/system"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
)

// Labels the platform stamps on everything it creates, so its own resources
// are always distinguishable from foreign stacks on the same host.
const (
	LabelManaged   = "platform.managed"
	LabelProjectID = "platform.project.id"
	LabelService   = "platform.service"

	// Compose sets these itself; they are how we map containers back to projects.
	ComposeProjectLabel = "com.docker.compose.project"
	ComposeServiceLabel = "com.docker.compose.service"
)

type Client struct {
	api *client.Client
}

func New() (*Client, error) {
	api, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("connect to docker: %w", err)
	}
	return &Client{api: api}, nil
}

func (c *Client) Close() error { return c.api.Close() }

func (c *Client) Ping(ctx context.Context) error {
	_, err := c.api.Ping(ctx)
	return err
}

func (c *Client) Info(ctx context.Context) (system.Info, error) { return c.api.Info(ctx) }

// ListContainers returns every container, or only those of one compose project.
func (c *Client) ListContainers(ctx context.Context, composeProject string) ([]container.Summary, error) {
	opts := container.ListOptions{All: true}
	if composeProject != "" {
		opts.Filters = filters.NewArgs(filters.Arg("label", ComposeProjectLabel+"="+composeProject))
	}
	return c.api.ContainerList(ctx, opts)
}

func (c *Client) Inspect(ctx context.Context, id string) (container.InspectResponse, error) {
	return c.api.ContainerInspect(ctx, id)
}

func (c *Client) Start(ctx context.Context, id string) error {
	return c.api.ContainerStart(ctx, id, container.StartOptions{})
}

func (c *Client) Stop(ctx context.Context, id string) error {
	return c.api.ContainerStop(ctx, id, container.StopOptions{})
}

func (c *Client) Restart(ctx context.Context, id string) error {
	return c.api.ContainerRestart(ctx, id, container.StopOptions{})
}

func (c *Client) Remove(ctx context.Context, id string, force bool) error {
	return c.api.ContainerRemove(ctx, id, container.RemoveOptions{Force: force})
}

// Logs streams container output. The reader is multiplexed unless the container
// has a TTY; DemuxLogs handles both cases.
func (c *Client) Logs(ctx context.Context, id string, tail string, follow, timestamps bool) (io.ReadCloser, bool, error) {
	info, err := c.api.ContainerInspect(ctx, id)
	if err != nil {
		return nil, false, err
	}
	rc, err := c.api.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     follow,
		Timestamps: timestamps,
		Tail:       tail,
	})
	return rc, info.Config != nil && info.Config.Tty, err
}

// Stats returns a stats reader for one container. Streaming keeps the
// connection open and lets the Engine fill in the previous CPU cycle.
func (c *Client) Stats(ctx context.Context, id string, stream bool) (container.StatsResponseReader, error) {
	return c.api.ContainerStats(ctx, id, stream)
}

// Events subscribes to the daemon event stream used by the reconciler.
func (c *Client) Events(ctx context.Context) (<-chan events.Message, <-chan error) {
	return c.api.Events(ctx, events.ListOptions{})
}

func (c *Client) ListImages(ctx context.Context) ([]image.Summary, error) {
	return c.api.ImageList(ctx, image.ListOptions{All: false})
}

func (c *Client) InspectImage(ctx context.Context, id string) (image.InspectResponse, error) {
	return c.api.ImageInspect(ctx, id)
}

// PullImage streams the pull progress; callers must drain and close the reader.
func (c *Client) PullImage(ctx context.Context, ref string) (io.ReadCloser, error) {
	return c.api.ImagePull(ctx, ref, image.PullOptions{})
}

func (c *Client) RemoveImage(ctx context.Context, id string, force bool) error {
	_, err := c.api.ImageRemove(ctx, id, image.RemoveOptions{Force: force, PruneChildren: true})
	return err
}

func (c *Client) ListVolumes(ctx context.Context) (volume.ListResponse, error) {
	return c.api.VolumeList(ctx, volume.ListOptions{})
}

func (c *Client) InspectVolume(ctx context.Context, name string) (volume.Volume, error) {
	return c.api.VolumeInspect(ctx, name)
}

func (c *Client) RemoveVolume(ctx context.Context, name string, force bool) error {
	return c.api.VolumeRemove(ctx, name, force)
}

func (c *Client) ListNetworks(ctx context.Context) ([]network.Summary, error) {
	return c.api.NetworkList(ctx, network.ListOptions{})
}

func (c *Client) InspectNetwork(ctx context.Context, id string) (network.Inspect, error) {
	return c.api.NetworkInspect(ctx, id, network.InspectOptions{})
}

// EnsureNetwork creates the shared proxy network when it is missing.
func (c *Client) EnsureNetwork(ctx context.Context, name string) error {
	_, err := c.api.NetworkInspect(ctx, name, network.InspectOptions{})
	if err == nil {
		return nil
	}
	if !client.IsErrNotFound(err) {
		return err
	}
	_, err = c.api.NetworkCreate(ctx, name, network.CreateOptions{
		Driver: "bridge",
		Labels: map[string]string{LabelManaged: "true"},
	})
	if err != nil && !errors.Is(err, context.Canceled) && strings.Contains(err.Error(), "already exists") {
		return nil
	}
	return err
}

// ConnectWithAlias attaches a container to the proxy network under a stable
// alias. It is idempotent: an already-attached container with the right alias
// is left alone, and a stale attachment is replaced.
func (c *Client) ConnectWithAlias(ctx context.Context, networkName, containerID, alias string) error {
	info, err := c.api.ContainerInspect(ctx, containerID)
	if err != nil {
		return err
	}
	if info.NetworkSettings != nil {
		if endpoint, ok := info.NetworkSettings.Networks[networkName]; ok {
			for _, a := range endpoint.Aliases {
				if a == alias {
					return nil
				}
			}
			// Wrong alias: detach so the correct one can be applied.
			if err := c.api.NetworkDisconnect(ctx, networkName, containerID, true); err != nil {
				return err
			}
		}
	}
	return c.api.NetworkConnect(ctx, networkName, containerID, &network.EndpointSettings{Aliases: []string{alias}})
}

func (c *Client) DiskUsage(ctx context.Context) (types.DiskUsage, error) {
	return c.api.DiskUsage(ctx, types.DiskUsageOptions{})
}

// PruneReport summarises one cleanup action for the Docker Cleanup screen.
type PruneReport struct {
	Kind    string `json:"kind"`
	Removed int    `json:"removed"`
	Freed   uint64 `json:"space_reclaimed"`
}

// Prune runs one explicit cleanup. The platform never prunes on its own.
func (c *Client) Prune(ctx context.Context, kind string) (PruneReport, error) {
	switch kind {
	case "containers":
		r, err := c.api.ContainersPrune(ctx, filters.NewArgs())
		return PruneReport{Kind: kind, Removed: len(r.ContainersDeleted), Freed: r.SpaceReclaimed}, err
	case "images":
		r, err := c.api.ImagesPrune(ctx, filters.NewArgs())
		return PruneReport{Kind: kind, Removed: len(r.ImagesDeleted), Freed: r.SpaceReclaimed}, err
	case "volumes":
		r, err := c.api.VolumesPrune(ctx, filters.NewArgs())
		return PruneReport{Kind: kind, Removed: len(r.VolumesDeleted), Freed: r.SpaceReclaimed}, err
	case "networks":
		r, err := c.api.NetworksPrune(ctx, filters.NewArgs())
		return PruneReport{Kind: kind, Removed: len(r.NetworksDeleted), Freed: 0}, err
	case "build-cache":
		r, err := c.api.BuildCachePrune(ctx, build.CachePruneOptions{All: true})
		if r == nil {
			return PruneReport{Kind: kind}, err
		}
		return PruneReport{Kind: kind, Removed: len(r.CachesDeleted), Freed: uint64(r.SpaceReclaimed)}, err
	default:
		return PruneReport{}, fmt.Errorf("unknown cleanup target %q", kind)
	}
}
