package deployments

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"

	"github.com/vexdock/platform/manager/internal/compose"
	"github.com/vexdock/platform/manager/internal/nginx"
)

// startStandby runs the new build as a one-off beside the container compose is
// about to recreate, and waits until Nginx reaches it, so the site keeps
// answering while compose stops the old one. It returns no standby when nothing
// is serving yet or no domain points at the service. The name comes back even
// on failure, so the caller can remove what was started.
func (p *pipeline) startStandby(ctx context.Context, project compose.Project, service compose.ConfigService) (string, []int, error) {
	// Two containers writing one volume is how a database file gets corrupted.
	if len(service.Volumes) > 0 {
		return "", nil, nil
	}
	ports, err := p.proxiedPorts(ctx)
	if err != nil {
		return "", nil, err
	}
	containers, err := p.targetContainers(ctx)
	if err != nil {
		return "", nil, err
	}
	running := slices.ContainsFunc(containers, func(c container.Summary) bool { return c.State == "running" })
	if len(ports) == 0 || !running {
		return "", nil, nil
	}

	name := p.environment.ComposeProjectName + "-" + p.target + "-standby"
	// A manager restart mid-deploy leaves the last one behind.
	if err := p.e.docker.RemoveIfPresent(ctx, name); err != nil {
		return "", nil, err
	}
	p.printf("Starting %s so %s keeps serving until the new container is ready", name, p.target)
	if err := project.Standby(ctx, p, p.target, name); err != nil {
		return name, nil, err
	}
	if err := p.e.docker.ConnectWithAlias(ctx, p.e.cfg.ProxyNetwork, name, nginx.Alias(p.environment.ID, p.target)); err != nil {
		return name, nil, err
	}
	if err := p.waitServing(ctx, name, ports); err != nil {
		return name, nil, err
	}
	p.printf("%s is serving", name)
	return name, ports, p.waitResolver(ctx)
}

// handOver waits until Nginx reaches the recreated service and has resolved
// it, so stopping the standby afterwards drops no request.
func (p *pipeline) handOver(ctx context.Context, ports []int) error {
	id, err := p.e.docker.ServiceContainer(ctx, p.environment.ComposeProjectName, p.target)
	if err != nil {
		return err
	}
	if err := p.waitServing(ctx, id, ports); err != nil {
		return err
	}
	return p.waitResolver(ctx)
}

// removeStandby stops the standby with its grace period, so requests in flight
// on it finish, then removes it.
func (p *pipeline) removeStandby(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := p.e.docker.Stop(ctx, name); err != nil {
		p.e.log.Warn("stop standby", "container", name, "error", err)
	}
	if err := p.e.docker.RemoveIfPresent(ctx, name); err != nil {
		p.e.log.Error("remove standby", "container", name, "error", err)
	}
}

// proxiedPorts are the container ports this service's domains send traffic to.
func (p *pipeline) proxiedPorts(ctx context.Context) ([]int, error) {
	svc, err := p.e.db.ServiceByName(ctx, p.environment.ID, p.target)
	if err != nil {
		return nil, err
	}
	domains, err := p.e.db.ListProjectDomains(ctx, p.project.ID)
	if err != nil {
		return nil, err
	}
	ports := []int{}
	for _, d := range domains {
		if d.ServiceID == svc.ID && !slices.Contains(ports, d.ContainerPort) {
			ports = append(ports, d.ContainerPort)
		}
	}
	return ports, nil
}

// waitServing polls one container until Nginx can open every proxied port on
// it and, when a healthcheck is declared, Docker reports it healthy.
func (p *pipeline) waitServing(ctx context.Context, id string, ports []int) error {
	deadline := time.Now().Add(healthTimeout)
	for {
		waiting, err := p.serving(ctx, id, ports)
		if err != nil || waiting == "" {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for %s", waiting)
		}
		p.printf("Waiting for %s", waiting)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// serving names what the container is still waiting for, empty once it serves.
// The probe runs inside the Nginx container, so it takes the proxy's own path.
func (p *pipeline) serving(ctx context.Context, id string, ports []int) (string, error) {
	info, err := p.e.docker.Inspect(ctx, id)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(info.Name, "/")
	if !info.State.Running {
		return "", fmt.Errorf("%s exited with code %d", name, info.State.ExitCode)
	}
	if health := info.State.Health; health != nil && health.Status != "healthy" {
		if health.Status == "unhealthy" {
			return "", fmt.Errorf("%s is unhealthy", name)
		}
		return name + " (health: " + health.Status + ")", nil
	}
	endpoint, ok := info.NetworkSettings.Networks[p.e.cfg.ProxyNetwork]
	if !ok {
		return "", fmt.Errorf("%s is not attached to %s", name, p.e.cfg.ProxyNetwork)
	}
	for _, port := range ports {
		probe := []string{"nc", "-z", "-w", "2", endpoint.IPAddress, strconv.Itoa(port)}
		_, code, err := p.e.docker.ExecOutput(ctx, p.e.cfg.NginxContainer, probe)
		if err != nil {
			return "", err
		}
		if code != 0 {
			return fmt.Sprintf("%s to accept connections on port %d", name, port), nil
		}
	}
	return "", nil
}

// waitResolver outlasts Nginx's cache of the alias, so the next request
// resolves the container that was just attached.
func (p *pipeline) waitResolver(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(2 * nginx.ResolverValid):
		return nil
	}
}
