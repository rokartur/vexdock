// Package deployments runs the deploy pipeline: one project at a time, every
// step persisted, every line streamed to the browser over SSE.
package deployments

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vexdock/platform/manager/internal/compose"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/domains"
	"github.com/vexdock/platform/manager/internal/events"
	"github.com/vexdock/platform/manager/internal/git"
	"github.com/vexdock/platform/manager/internal/projects"
)

// Step names, in pipeline order.
const (
	// Only emitted when the environment has services cloned from a repository.
	StepClone       = "clone"
	StepCheckout    = "checkout"
	StepValidate    = "validate"
	StepPull        = "pull"
	StepBuild       = "build"
	StepStart       = "start"
	StepHealthcheck = "healthcheck"
	StepProxy       = "proxy"
	StepFinish      = "finish"
)

// Triggers recorded on a deployment.
const (
	TriggerManual   = "manual"
	TriggerWebhook  = "webhook"
	TriggerRollback = "rollback"
)

// healthTimeout bounds how long the pipeline waits for containers to settle.
const healthTimeout = 3 * time.Minute

// deployTimeout bounds a whole deployment. A large image build is slow but not
// this slow, so anything that reaches it is stuck rather than working.
const deployTimeout = 45 * time.Minute

type Engine struct {
	db       *database.DB
	cfg      *config.Config
	projects *projects.Service
	domains  *domains.Service
	docker   *docker.Client
	bus      *events.Bus
	log      *slog.Logger

	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewEngine(db *database.DB, cfg *config.Config, projectSvc *projects.Service, domainSvc *domains.Service,
	dockerClient *docker.Client, bus *events.Bus, log *slog.Logger) *Engine {
	return &Engine{
		db: db, cfg: cfg, projects: projectSvc, domains: domainSvc, docker: dockerClient,
		bus: bus, log: log,
		locks:   map[string]*sync.Mutex{},
		cancels: map[string]context.CancelFunc{},
	}
}

// RecoverInterrupted marks deployments that were in flight when the manager
// stopped as failed, so the UI never shows a pipeline that nothing is running.
func (e *Engine) RecoverInterrupted(ctx context.Context) error {
	stuck, err := e.db.UnfinishedDeployments(ctx)
	if err != nil {
		return err
	}
	for i := range stuck {
		d := &stuck[i]
		d.Status = database.DeploymentFailed
		d.Error = "interrupted by a manager restart"
		d.FinishedAt = database.Now()
		if err := e.db.UpdateDeployment(ctx, d); err != nil {
			return err
		}
	}
	return nil
}

// Options describe one deployment request.
type Options struct {
	Trigger string
	Actor   string
	// CommitSHA pins the checkout, used by rollback. Empty means the branch head.
	CommitSHA string
	// ServiceName scopes pull/build/up/health to one compose service. Empty means the whole project.
	ServiceName string
}

// Trigger enqueues a deployment and returns immediately; the pipeline runs in
// the background so the HTTP request is never held open by a build.
func (e *Engine) Trigger(ctx context.Context, project *database.Project, env *database.Environment, opts Options) (*database.Deployment, error) {
	// An environment can pin a branch of its own, overriding what each service
	// asks for; staging deploying main is the default, not a rule.
	ref := env.Branch
	if opts.CommitSHA != "" {
		ref = opts.CommitSHA
	}
	d := &database.Deployment{
		ProjectID:     project.ID,
		EnvironmentID: env.ID,
		ServiceName:   opts.ServiceName,
		Branch:        ref,
		Status:        database.DeploymentQueued,
		Trigger:       opts.Trigger,
		CreatedBy:     opts.Actor,
	}
	if opts.CommitSHA != "" {
		d.CommitSHA = opts.CommitSHA
	}
	if err := e.db.CreateDeployment(ctx, d); err != nil {
		return nil, err
	}
	e.bus.Publish(events.TopicSystem, "deployment.queued", d)
	go e.run(env.ID, d.ID, ref)
	return d, nil
}

// Cancel stops a queued or running deployment. The pipeline observes the
// cancelled context, so compose is killed rather than left orphaned.
func (e *Engine) Cancel(deploymentID string) error {
	e.mu.Lock()
	cancel, ok := e.cancels[deploymentID]
	e.mu.Unlock()
	if !ok {
		return errors.New("deployment is not queued or running")
	}
	cancel()
	return nil
}

// lockFor returns the per-environment mutex; the same environment never deploys
// twice concurrently, a queued deployment simply waits here. Production and
// staging own separate directories and separate containers, so they are free to
// deploy at the same time.
// ponytail: in-process lock, sufficient while the manager is a single process.
func (e *Engine) lockFor(environmentID string) *sync.Mutex {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.locks[environmentID] == nil {
		e.locks[environmentID] = &sync.Mutex{}
	}
	return e.locks[environmentID]
}

func (e *Engine) run(environmentID, deploymentID, ref string) {
	// Cancellable from the moment it is queued, so a deployment waiting on the
	// lock can be withdrawn instead of running once the lock frees up.
	queued, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancels[deploymentID] = cancel
	e.mu.Unlock()
	defer func() {
		cancel()
		e.mu.Lock()
		delete(e.cancels, deploymentID)
		e.mu.Unlock()
	}()

	lock := e.lockFor(environmentID)
	lock.Lock()
	defer lock.Unlock()

	// The clock starts once the pipeline owns the lock, not while it queues. A
	// wedged git clone or registry pull would otherwise hold the environment
	// lock forever and leave the deployment reading "running" with nothing running.
	ctx, expire := context.WithTimeout(queued, deployTimeout)
	defer expire()

	p := newPipeline(e, deploymentID, ref)
	err := p.execute(ctx)
	p.finish(err)
}

// pipeline holds the state of one running deployment.
type pipeline struct {
	e            *Engine
	deploymentID string
	ref          string
	deployment   *database.Deployment
	project      *database.Project
	environment  *database.Environment
	// target is the compose service this deploy is limited to, or empty for all.
	target   string
	position int
	current  *database.DeploymentStep
	buf      strings.Builder
}

func newPipeline(e *Engine, deploymentID, ref string) *pipeline {
	return &pipeline{e: e, deploymentID: deploymentID, ref: ref}
}

func (p *pipeline) execute(ctx context.Context) error {
	var err error
	p.deployment, err = p.e.db.DeploymentByID(ctx, p.deploymentID)
	if err != nil {
		return err
	}
	p.project, err = p.e.db.ProjectByID(ctx, p.deployment.ProjectID)
	if err != nil {
		return err
	}
	p.environment, err = p.e.db.EnvironmentByID(ctx, p.deployment.EnvironmentID)
	if err != nil {
		return err
	}
	p.target = p.deployment.ServiceName

	p.deployment.Status = database.DeploymentRunning
	p.deployment.StartedAt = database.Now()
	if err := p.e.db.UpdateDeployment(ctx, p.deployment); err != nil {
		return err
	}
	p.publish("deployment.started", p.deployment)

	// Each service can build from its own repository, so the checkouts have to
	// exist before compose resolves the build contexts the compose file points at.
	if err := p.serviceCheckouts(ctx); err != nil {
		return err
	}

	composeProject, err := p.e.projects.ComposeProject(ctx, p.project, p.environment)
	if err != nil {
		p.begin(StepValidate)
		return p.fail(err)
	}

	p.begin(StepValidate)
	cfg, err := composeProject.Validate(ctx)
	if err != nil {
		return p.fail(err)
	}
	names := cfg.ServiceNames()
	if p.target != "" {
		if _, ok := cfg.Services[p.target]; !ok {
			return p.fail(fmt.Errorf("compose has no service %q", p.target))
		}
		p.printf("Compose is valid; deploying service %s", p.target)
	} else {
		p.printf("Compose is valid: %d service(s) - %s", len(names), strings.Join(names, ", "))
	}
	p.complete()

	scope := p.serviceArgs()

	p.begin(StepPull)
	if err := composeProject.Pull(ctx, p, scope...); err != nil {
		// A pull failure for a locally built image is not fatal; compose is told
		// to ignore pull failures and the build step decides.
		p.printf("pull reported: %v", err)
	}
	p.complete()

	p.begin(StepBuild)
	if hasBuild(cfg, scope...) {
		if err := composeProject.Build(ctx, p, scope...); err != nil {
			return p.fail(err)
		}
	} else {
		p.printf("No services declare a build context, skipping")
	}
	p.complete()

	p.begin(StepStart)
	if err := composeProject.Up(ctx, p, scope...); err != nil {
		return p.fail(err)
	}
	p.complete()

	p.begin(StepHealthcheck)
	if err := p.waitHealthy(ctx); err != nil {
		return p.fail(err)
	}
	p.complete()

	p.begin(StepProxy)
	if err := p.e.domains.Reconcile(ctx); err != nil {
		return p.fail(err)
	}
	p.printf("Proxy configuration reconciled")
	p.complete()

	return nil
}

// serviceArgs is the compose service list for scoped steps, or nil for all.
func (p *pipeline) serviceArgs() []string {
	if p.target == "" {
		return nil
	}
	return []string{p.target}
}

// serviceCheckouts syncs the repository of every git service in scope, each
// with its own credential. The steps are skipped entirely when nothing in the
// environment comes from a repository.
//
// The commit is recorded on the deployment only when exactly one repository was
// fetched. Two services from two repositories have no single commit between
// them, and picking one of them would be a lie on the deployment page.
func (p *pipeline) serviceCheckouts(ctx context.Context) error {
	services, err := p.e.db.ListServices(ctx, p.environment.ID)
	if err != nil {
		p.begin(StepClone)
		return p.fail(err)
	}
	sourced := make([]database.Service, 0, len(services))
	for _, svc := range services {
		if !database.GitProvider(svc.Provider) {
			continue
		}
		if p.target != "" && svc.ComposeServiceName != p.target {
			continue
		}
		sourced = append(sourced, svc)
	}
	if len(sourced) == 0 {
		return nil
	}

	p.begin(StepClone)
	shas := make([]string, 0, len(sourced))
	for _, svc := range sourced {
		cred, err := p.e.projects.Credential(ctx, &svc)
		if err != nil {
			return p.fail(err)
		}
		ref := svc.Branch
		if p.ref != "" {
			ref = p.ref
		}
		repo := git.Repo{
			URL:        svc.RepositoryURL,
			Ref:        ref,
			Dir:        filepath.Join(p.e.projects.ServiceDir(p.environment, svc.ComposeServiceName), "repository"),
			Cred:       cred,
			KnownHosts: filepath.Join(p.e.cfg.SecretsDir, "known_hosts"),
		}
		p.printf("Fetching %s @ %s for service %s", svc.RepositoryURL, ref, svc.ComposeServiceName)
		sha, err := repo.Sync(ctx, p)
		if err != nil {
			return p.fail(err)
		}
		shas = append(shas, sha)
	}
	p.complete()

	p.begin(StepCheckout)
	for i, svc := range sourced {
		p.printf("%s checked out at %s", svc.ComposeServiceName, short(shas[i]))
	}
	if len(shas) == 1 {
		p.deployment.CommitSHA = shas[0]
		if err := p.e.db.UpdateDeployment(ctx, p.deployment); err != nil {
			return p.fail(err)
		}
	}
	p.complete()
	return nil
}

// waitHealthy polls compose containers until they are running and, when a
// healthcheck is declared, until Docker reports them healthy. A scoped deploy
// only waits on its target service.
func (p *pipeline) waitHealthy(ctx context.Context) error {
	deadline := time.Now().Add(healthTimeout)
	for {
		containers, err := p.e.docker.ListContainers(ctx, p.environment.ComposeProjectName)
		if err != nil {
			return err
		}
		if p.target != "" {
			filtered := containers[:0]
			for _, c := range containers {
				if c.Labels[docker.ComposeServiceLabel] == p.target {
					filtered = append(filtered, c)
				}
			}
			containers = filtered
		}
		if len(containers) == 0 {
			if p.target != "" {
				return fmt.Errorf("compose started no container for service %s", p.target)
			}
			return errors.New("compose started no containers")
		}
		pending := []string{}
		for _, c := range containers {
			name := c.Labels[docker.ComposeServiceLabel]
			info, err := p.e.docker.Inspect(ctx, c.ID)
			if err != nil {
				pending = append(pending, name)
				continue
			}
			switch {
			case info.State == nil:
				pending = append(pending, name)
			case info.State.Health != nil:
				switch info.State.Health.Status {
				case "healthy":
				case "unhealthy":
					return fmt.Errorf("service %s is unhealthy", name)
				default:
					pending = append(pending, name+" (health: "+info.State.Health.Status+")")
				}
			case info.State.Running:
			case info.State.Restarting:
				pending = append(pending, name+" (restarting)")
			case info.State.ExitCode != 0:
				return fmt.Errorf("service %s exited with code %d", name, info.State.ExitCode)
			default:
				// One-shot containers that exited cleanly are acceptable.
			}
		}
		if len(pending) == 0 {
			if p.target != "" {
				p.printf("Service %s is healthy", p.target)
			} else {
				p.printf("All services are healthy")
			}
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for: %s", strings.Join(pending, ", "))
		}
		p.printf("Waiting for %s", strings.Join(pending, ", "))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func (p *pipeline) finish(err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if p.deployment == nil {
		// execute failed, or was cancelled, before it read the row. Without this
		// the deployment stays "queued" until the next restart marks it failed.
		loaded, lerr := p.e.db.DeploymentByID(ctx, p.deploymentID)
		if lerr != nil {
			p.e.log.Error("finish deployment", "deployment", p.deploymentID, "error", lerr)
			return
		}
		p.deployment = loaded
	}
	p.deployment.FinishedAt = database.Now()
	switch {
	case err == nil:
		p.deployment.Status = database.DeploymentSuccess
		p.begin(StepFinish)
		p.printf("Deployment completed")
		p.complete()
	case errors.Is(err, context.Canceled):
		p.deployment.Status = database.DeploymentCancelled
		p.deployment.Error = "cancelled"
	default:
		p.deployment.Status = database.DeploymentFailed
		p.deployment.Error = err.Error()
	}
	if uerr := p.e.db.UpdateDeployment(ctx, p.deployment); uerr != nil {
		p.e.log.Error("persist deployment result", "error", uerr)
	}
	p.publish("deployment."+p.deployment.Status, p.deployment)
	p.e.bus.Publish(events.TopicSystem, "deployment."+p.deployment.Status, p.deployment)
	p.publish("deployment.closed", nil)
}

// begin opens a new step, persisting it so a reloaded page shows history.
func (p *pipeline) begin(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p.position++
	p.buf.Reset()
	step := &database.DeploymentStep{
		DeploymentID: p.deploymentID,
		Position:     p.position,
		Name:         name,
		Status:       database.DeploymentRunning,
		StartedAt:    database.Now(),
	}
	if err := p.e.db.CreateStep(ctx, step); err != nil {
		p.e.log.Error("create deployment step", "error", err)
	}
	p.current = step
	p.publish("step.started", step)
}

func (p *pipeline) complete() { p.closeStep(database.DeploymentSuccess) }

func (p *pipeline) fail(err error) error {
	if p.current != nil {
		p.printf("ERROR: %v", err)
	}
	p.closeStep(database.DeploymentFailed)
	return err
}

func (p *pipeline) closeStep(status string) {
	if p.current == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p.current.Status = status
	p.current.FinishedAt = database.Now()
	p.current.Output = tail(p.buf.String(), 64*1024)
	if err := p.e.db.UpdateStep(ctx, p.current); err != nil {
		p.e.log.Error("update deployment step", "error", err)
	}
	p.publish("step."+status, p.current)
	p.current = nil
}

// Write makes the pipeline an io.Writer, so compose and git output streams
// straight into the deployment log.
func (p *pipeline) Write(b []byte) (int, error) {
	text := string(b)
	p.buf.WriteString(text)
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		p.publish("log", logLine{Step: p.stepName(), Text: line, At: time.Now().UTC().Format(time.RFC3339)})
	}
	return len(b), nil
}

func (p *pipeline) printf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	p.buf.WriteString(line + "\n")
	p.publish("log", logLine{Step: p.stepName(), Text: line, At: time.Now().UTC().Format(time.RFC3339)})
}

func (p *pipeline) stepName() string {
	if p.current == nil {
		return ""
	}
	return p.current.Name
}

func (p *pipeline) publish(eventType string, data any) {
	p.e.bus.Publish(events.DeploymentTopic(p.deploymentID), eventType, data)
}

type logLine struct {
	Step string `json:"step"`
	Text string `json:"text"`
	At   string `json:"at"`
}

// hasBuild reports whether any of the named services (or all, when none named)
// declare a build context.
func hasBuild(cfg *compose.Config, services ...string) bool {
	if len(services) == 0 {
		for _, svc := range cfg.Services {
			if svc.Build != nil {
				return true
			}
		}
		return false
	}
	for _, name := range services {
		if svc, ok := cfg.Services[name]; ok && svc.Build != nil {
			return true
		}
	}
	return false
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// tail keeps the last n bytes of step output so a chatty build cannot bloat the
// database.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "... truncated ...\n" + s[len(s)-n:]
}
