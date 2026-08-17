// Package deployments runs the deploy pipeline: one project at a time, every
// step persisted, every line streamed to the browser over SSE.
package deployments

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
}

// Trigger enqueues a deployment and returns immediately; the pipeline runs in
// the background so the HTTP request is never held open by a build.
func (e *Engine) Trigger(ctx context.Context, project *database.Project, opts Options) (*database.Deployment, error) {
	ref := project.Branch
	if opts.CommitSHA != "" {
		ref = opts.CommitSHA
	}
	d := &database.Deployment{
		ProjectID: project.ID,
		Branch:    ref,
		Status:    database.DeploymentQueued,
		Trigger:   opts.Trigger,
		CreatedBy: opts.Actor,
	}
	if opts.CommitSHA != "" {
		d.CommitSHA = opts.CommitSHA
	}
	if err := e.db.CreateDeployment(ctx, d); err != nil {
		return nil, err
	}
	e.bus.Publish(events.TopicSystem, "deployment.queued", d)
	go e.run(project.ID, d.ID, ref)
	return d, nil
}

// Cancel stops a running deployment. The pipeline observes the cancelled
// context, so compose is killed rather than left orphaned.
func (e *Engine) Cancel(deploymentID string) error {
	e.mu.Lock()
	cancel, ok := e.cancels[deploymentID]
	e.mu.Unlock()
	if !ok {
		return errors.New("deployment is not running")
	}
	cancel()
	return nil
}

// lockFor returns the per-project mutex; the same project never deploys twice
// concurrently, a queued deployment simply waits here.
// ponytail: in-process lock, sufficient while the manager is a single process.
func (e *Engine) lockFor(projectID string) *sync.Mutex {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.locks[projectID] == nil {
		e.locks[projectID] = &sync.Mutex{}
	}
	return e.locks[projectID]
}

func (e *Engine) run(projectID, deploymentID, ref string) {
	lock := e.lockFor(projectID)
	lock.Lock()
	defer lock.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancels[deploymentID] = cancel
	e.mu.Unlock()
	defer func() {
		cancel()
		e.mu.Lock()
		delete(e.cancels, deploymentID)
		e.mu.Unlock()
	}()

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
	position     int
	current      *database.DeploymentStep
	buf          strings.Builder
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

	p.deployment.Status = database.DeploymentRunning
	p.deployment.StartedAt = database.Now()
	if err := p.e.db.UpdateDeployment(ctx, p.deployment); err != nil {
		return err
	}
	p.publish("deployment.started", p.deployment)

	if p.project.SourceType == database.SourceGit {
		if err := p.gitSteps(ctx); err != nil {
			return err
		}
	} else {
		p.begin(StepClone)
		p.printf("Using the compose file stored in the project")
		p.complete()
	}

	composeProject, err := p.e.projects.ComposeProject(ctx, p.project)
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
	p.printf("Compose is valid: %d service(s) - %s", len(names), strings.Join(names, ", "))
	for _, name := range names {
		if _, err := p.e.db.UpsertService(ctx, p.project.ID, name); err != nil {
			return p.fail(err)
		}
	}
	if err := p.e.db.PruneServices(ctx, p.project.ID, names); err != nil {
		return p.fail(err)
	}
	p.complete()

	p.begin(StepPull)
	if err := composeProject.Pull(ctx, p); err != nil {
		// A pull failure for a locally built image is not fatal; compose is told
		// to ignore pull failures and the build step decides.
		p.printf("pull reported: %v", err)
	}
	p.complete()

	p.begin(StepBuild)
	if hasBuild(cfg) {
		if err := composeProject.Build(ctx, p); err != nil {
			return p.fail(err)
		}
	} else {
		p.printf("No services declare a build context, skipping")
	}
	p.complete()

	p.begin(StepStart)
	if err := composeProject.Up(ctx, p); err != nil {
		return p.fail(err)
	}
	p.complete()

	p.begin(StepHealthcheck)
	if err := p.waitHealthy(ctx, composeProject); err != nil {
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

func (p *pipeline) gitSteps(ctx context.Context) error {
	p.begin(StepClone)
	cred, err := p.e.projects.Credential(p.project)
	if err != nil {
		return p.fail(err)
	}
	repo := git.Repo{
		URL:  p.project.RepositoryURL,
		Ref:  p.ref,
		Dir:  p.e.projects.RepositoryDir(p.project),
		Cred: cred,
	}
	p.printf("Fetching %s @ %s", p.project.RepositoryURL, p.ref)
	sha, err := repo.Sync(ctx, p)
	if err != nil {
		return p.fail(err)
	}
	p.complete()

	p.begin(StepCheckout)
	p.printf("Checked out %s", short(sha))
	p.deployment.CommitSHA = sha
	if err := p.e.db.UpdateDeployment(ctx, p.deployment); err != nil {
		return p.fail(err)
	}
	p.complete()
	return nil
}

// waitHealthy polls compose containers until they are running and, when a
// healthcheck is declared, until Docker reports them healthy.
func (p *pipeline) waitHealthy(ctx context.Context, _ compose.Project) error {
	deadline := time.Now().Add(healthTimeout)
	for {
		containers, err := p.e.docker.ListContainers(ctx, p.project.ComposeProjectName)
		if err != nil {
			return err
		}
		if len(containers) == 0 {
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
			p.printf("All services are healthy")
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
		return
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

func hasBuild(cfg *compose.Config) bool {
	for _, svc := range cfg.Services {
		if svc.Build != nil {
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
