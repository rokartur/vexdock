package schedule

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/docker"
)

// Runner ticks once a minute and execs every task whose schedule matches that
// minute. Ticks missed while the manager was down are not replayed.
type Runner struct {
	db     *database.DB
	docker *docker.Client
	log    *slog.Logger

	mu      sync.Mutex
	running map[string]bool
}

func NewRunner(db *database.DB, dockerClient *docker.Client, log *slog.Logger) *Runner {
	return &Runner{db: db, docker: dockerClient, log: log, running: map[string]bool{}}
}

// taskTimeout bounds a single execution so a hung command cannot hold its task
// forever. ponytail: one global limit, make it per-task if a job needs longer.
const taskTimeout = 30 * time.Minute

func (r *Runner) Run(ctx context.Context) {
	// Align to the wall clock minute so tasks fire on :00, not on boot offset.
	timer := time.NewTimer(time.Until(time.Now().Truncate(time.Minute).Add(time.Minute)))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-timer.C:
			timer.Reset(time.Until(now.Truncate(time.Minute).Add(time.Minute)))
			r.tick(ctx, now)
		}
	}
}

func (r *Runner) tick(ctx context.Context, now time.Time) {
	tasks, err := r.db.EnabledScheduledTasks(ctx)
	if err != nil {
		r.log.Error("scheduled tasks: load failed", "error", err)
		return
	}
	for _, task := range tasks {
		if !r.due(task, now) {
			continue
		}
		go func(task database.ScheduledTask) {
			switch _, err := r.Execute(ctx, task); {
			case errors.Is(err, ErrAlreadyRunning):
				r.log.Warn("scheduled task skipped, previous run still going", "task", task.ID, "name", task.Name)
			case err != nil:
				r.log.Error("scheduled task failed", "task", task.ID, "name", task.Name, "error", err)
			}
		}(task)
	}
}

// due reports whether a task fires at this instant. Each task reads the same
// instant against its own wall clock, which is what makes "0 3 * * *" mean 3am
// where the user lives. A task the manager cannot make sense of is loud and
// skipped, never guessed at.
func (r *Runner) due(task database.ScheduledTask, now time.Time) bool {
	parsed, err := Parse(task.Schedule)
	if err != nil {
		r.log.Warn("scheduled task has an invalid schedule", "task", task.ID, "schedule", task.Schedule, "error", err)
		return false
	}
	loc, err := Location(task.Timezone)
	if err != nil {
		r.log.Warn("scheduled task has an unknown timezone", "task", task.ID, "timezone", task.Timezone, "error", err)
		return false
	}
	return parsed.Match(now.In(loc))
}

// ErrAlreadyRunning is returned when a task's previous run has not finished.
// A slow job must not pile up on itself, from the tick or from "run now".
var ErrAlreadyRunning = errors.New("this task is already running")

// Execute runs one task now and records the result. Shared with the manual
// "run now" endpoint, which is how a task gets tested before its first tick.
//
// The run outlives whatever ctx it was started from: a browser that walks away
// from "run now" must not kill a half-finished command.
func (r *Runner) Execute(ctx context.Context, task database.ScheduledTask) (*database.TaskRun, error) {
	if !r.claim(task.ID) {
		return nil, ErrAlreadyRunning
	}
	defer r.release(task.ID)
	ctx = context.WithoutCancel(ctx)

	run, err := r.db.StartTaskRun(ctx, task.ID)
	if err != nil {
		return nil, err
	}
	execCtx, cancel := context.WithTimeout(ctx, taskTimeout)
	defer cancel()
	// A container that is missing or refuses exec is a failed run, not a lost
	// one: it lands in the history with the reason as its output.
	output, exitCode, execErr := r.exec(execCtx, task)
	if execErr != nil {
		output, exitCode = execErr.Error(), -1
	}
	// Recorded on ctx rather than execCtx, so a run that hits the deadline still
	// writes its outcome instead of staying a phantom until the next restart.
	if err := r.db.FinishTaskRun(ctx, run, exitCode, output); err != nil {
		return nil, err
	}
	return run, execErr
}

func (r *Runner) exec(ctx context.Context, task database.ScheduledTask) (string, int, error) {
	service, err := r.db.ServiceByID(ctx, task.ServiceID)
	if err != nil {
		return "", -1, err
	}
	env, err := r.db.EnvironmentByID(ctx, service.EnvironmentID)
	if err != nil {
		return "", -1, err
	}
	containerID, err := r.docker.ServiceContainer(ctx, env.ComposeProjectName, service.ComposeServiceName)
	if err != nil {
		return "", -1, err
	}
	shell := task.Shell
	if shell == "" {
		shell = "sh"
	}
	// The command is the user's own shell line, run inside their own container,
	// which is exactly the reach the built-in terminal already gives them. The
	// shell name is one of two constants, checked when the task was saved.
	return r.docker.ExecOutput(ctx, containerID, []string{"/bin/" + shell, "-c", task.Command})
}

func (r *Runner) claim(taskID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running[taskID] {
		return false
	}
	r.running[taskID] = true
	return true
}

func (r *Runner) release(taskID string) {
	r.mu.Lock()
	delete(r.running, taskID)
	r.mu.Unlock()
}
