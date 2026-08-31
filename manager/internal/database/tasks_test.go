package database

import (
	"context"
	"strings"
	"testing"
)

func newTask(t *testing.T, db *DB, serviceID string) *ScheduledTask {
	t.Helper()
	task := &ScheduledTask{ServiceID: serviceID, Name: "backup", Schedule: "0 3 * * *", Command: "echo hi", Enabled: true}
	if err := db.CreateScheduledTask(context.Background(), task); err != nil {
		t.Fatalf("create task: %v", err)
	}
	return task
}

func taskService(t *testing.T, db *DB, slug string) *Service {
	t.Helper()
	project := newProject(t, db, slug)
	env := defaultEnv(t, db, project.ID)
	service := &Service{
		ID: NewID(), ProjectID: project.ID, EnvironmentID: env.ID,
		ComposeServiceName: "app", DisplayName: "App", Type: "application", Provider: ProviderGitHub,
	}
	if err := db.CreateService(context.Background(), service); err != nil {
		t.Fatalf("create service: %v", err)
	}
	return service
}

func TestTaskRunsAreTruncatedAndPruned(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	task := newTask(t, db, taskService(t, db, "tasks").ID)

	for i := range 5 {
		run, err := db.StartTaskRun(ctx, task.ID)
		if err != nil {
			t.Fatalf("start run: %v", err)
		}
		if err := db.FinishTaskRun(ctx, run, i, strings.Repeat("x", maxRunOutput+100)); err != nil {
			t.Fatalf("finish run: %v", err)
		}
	}

	runs, err := db.TaskRuns(ctx, task.ID, 10)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 5 {
		t.Fatalf("got %d runs, want 5", len(runs))
	}
	if runs[0].ExitCode != 4 {
		t.Errorf("newest run first: got exit code %d, want 4", runs[0].ExitCode)
	}
	if !strings.HasPrefix(runs[0].Output, "[output truncated]") || len(runs[0].Output) > maxRunOutput+32 {
		t.Errorf("output not truncated: %d bytes", len(runs[0].Output))
	}

	if err := db.PruneTaskRuns(ctx, 2); err != nil {
		t.Fatalf("prune: %v", err)
	}
	runs, err = db.TaskRuns(ctx, task.ID, 10)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 2 || runs[0].ExitCode != 4 || runs[1].ExitCode != 3 {
		t.Fatalf("prune kept the wrong runs: %+v", runs)
	}
}

// A run in flight when the manager dies must not stay "running" forever.
func TestInterruptedRunsAreClosedOnBoot(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	service := taskService(t, db, "tasks")
	task := newTask(t, db, service.ID)
	if _, err := db.StartTaskRun(ctx, task.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}

	if err := db.RecoverInterruptedTaskRuns(ctx); err != nil {
		t.Fatalf("recover: %v", err)
	}

	tasks, err := db.ScheduledTasksByService(ctx, service.ID)
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	last := tasks[0].LastRun
	if last == nil || last.FinishedAt == "" {
		t.Fatalf("run left unfinished: %+v", last)
	}
	if last.ExitCode == 0 {
		t.Error("an interrupted run should not look successful")
	}
}

// The cross-project list and the per-service list share one query, so the
// filter has to be the only thing that differs between them.
func TestAllScheduledTasksSpansServicesAndKeepsLastRuns(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	first := taskService(t, db, "first")
	second := taskService(t, db, "second")
	taskOnFirst := newTask(t, db, first.ID)
	newTask(t, db, second.ID)
	run, err := db.StartTaskRun(ctx, taskOnFirst.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	if err := db.FinishTaskRun(ctx, run, 0, "done"); err != nil {
		t.Fatalf("finish run: %v", err)
	}

	all, err := db.AllScheduledTasks(ctx)
	if err != nil {
		t.Fatalf("list all tasks: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("got %d tasks across two services, want 2", len(all))
	}
	for _, task := range all {
		switch {
		case task.ID == taskOnFirst.ID && task.LastRun == nil:
			t.Error("the task that ran lost its last run")
		case task.ID != taskOnFirst.ID && task.LastRun != nil:
			t.Error("a task that never ran picked up someone else's run")
		}
	}

	mine, err := db.ScheduledTasksByService(ctx, second.ID)
	if err != nil {
		t.Fatalf("list service tasks: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("got %d tasks on one service, want 1", len(mine))
	}
}

func TestDeletingATaskDeletesItsRuns(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	task := newTask(t, db, taskService(t, db, "tasks").ID)
	if _, err := db.StartTaskRun(ctx, task.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if err := db.DeleteScheduledTask(ctx, task.ID); err != nil {
		t.Fatalf("delete task: %v", err)
	}

	var runs int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM scheduled_task_runs`).Scan(&runs); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runs != 0 {
		t.Errorf("got %d orphaned runs, want 0", runs)
	}
}
