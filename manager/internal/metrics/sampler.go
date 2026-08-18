package metrics

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/docker"
)

// Interval between readings, and the resolution every chart is drawn at: the
// API refuses to bucket finer than this. A minute keeps a week of history at
// ten thousand host rows and matches how fast these numbers are read.
const Interval = time.Minute

// Retention is how far back readings are kept; the scheduler prunes the rest.
const Retention = 7 * 24 * time.Hour

// parallelSamples bounds concurrent Docker stats calls. Each one blocks for a
// CPU cycle, so they run together, but not unbounded on a busy host.
const parallelSamples = 8

// Sampler writes host and container readings to the database on a fixed tick.
// Without it nothing is recorded: the SSE endpoints only sample while a browser
// is watching.
type Sampler struct {
	db     *database.DB
	docker *docker.Client
	root   string
	log    *slog.Logger
}

func NewSampler(db *database.DB, dockerClient *docker.Client, root string, log *slog.Logger) *Sampler {
	return &Sampler{db: db, docker: dockerClient, root: root, log: log}
}

// Run samples until ctx is cancelled.
func (s *Sampler) Run(ctx context.Context) {
	ticker := time.NewTicker(Interval)
	defer ticker.Stop()
	for {
		s.sample(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Sampler) sample(ctx context.Context) {
	at := time.Now()
	host := Read(s.root)
	err := s.db.RecordHostMetric(ctx, at, database.HostPoint{
		CPUPercent:  host.CPUPercent,
		MemoryUsed:  host.MemoryUsed,
		MemoryTotal: host.MemoryTotal,
		DiskUsed:    host.DiskUsed,
		DiskTotal:   host.DiskTotal,
	})
	if err != nil && ctx.Err() == nil {
		s.log.Warn("record host metrics", "error", err)
	}

	samples, err := s.containers(ctx)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("sample containers", "error", err)
		}
		return
	}
	if err := s.db.RecordContainerMetrics(ctx, at, samples); err != nil && ctx.Err() == nil {
		s.log.Warn("record container metrics", "error", err)
	}
}

// containers reads every running container, tagging each one with the service
// it belongs to when the platform manages it.
func (s *Sampler) containers(ctx context.Context) ([]database.ContainerSample, error) {
	running, err := s.docker.ListContainers(ctx, "")
	if err != nil {
		return nil, err
	}
	services, err := s.serviceIDs(ctx)
	if err != nil {
		return nil, err
	}

	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		slots   = make(chan struct{}, parallelSamples)
		samples = []database.ContainerSample{}
	)
	for _, summary := range running {
		if summary.State != "running" {
			continue
		}
		wg.Add(1)
		go func(summary container.Summary) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()

			sample, err := s.docker.Sample(ctx, summary.ID)
			if err != nil {
				// A container that stopped mid-tick is normal, not worth a log line.
				return
			}
			mu.Lock()
			defer mu.Unlock()
			samples = append(samples, database.ContainerSample{
				ContainerID: summary.ID,
				ServiceID:   services[serviceKey(summary.Labels)],
				CPUPercent:  sample.CPUPercent,
				MemoryUsage: sample.MemoryUsage,
				MemoryLimit: sample.MemoryLimit,
				NetworkRX:   sample.NetworkRX,
				NetworkTX:   sample.NetworkTX,
				BlockRead:   sample.BlockRead,
				BlockWrite:  sample.BlockWrite,
			})
		}(summary)
	}
	wg.Wait()
	return samples, nil
}

// serviceIDs maps compose project and service labels to platform service ids.
func (s *Sampler) serviceIDs(ctx context.Context) (map[string]string, error) {
	projects, err := s.db.ListProjects(ctx)
	if err != nil {
		return nil, err
	}
	ids := map[string]string{}
	for _, project := range projects {
		services, err := s.db.ListServices(ctx, project.ID)
		if err != nil {
			return nil, err
		}
		for _, service := range services {
			ids[project.ComposeProjectName+"/"+service.ComposeServiceName] = service.ID
		}
	}
	return ids, nil
}

func serviceKey(labels map[string]string) string {
	return labels[docker.ComposeProjectLabel] + "/" + labels[docker.ComposeServiceLabel]
}
