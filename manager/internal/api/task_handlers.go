package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/schedule"
	"github.com/vexdock/platform/manager/internal/security"
)

// taskInput is the writable half of a scheduled task. Every field is a pointer
// so a PATCH that omits one leaves it alone; apply then validates the result,
// which makes create and update the same check.
type taskInput struct {
	Name     *string `json:"name"`
	Schedule *string `json:"schedule"`
	Command  *string `json:"command"`
	Enabled  *bool   `json:"enabled"`
}

func (in taskInput) apply(task *database.ScheduledTask) error {
	if in.Name != nil {
		task.Name = strings.TrimSpace(*in.Name)
	}
	if in.Schedule != nil {
		task.Schedule = strings.TrimSpace(*in.Schedule)
	}
	if in.Command != nil {
		task.Command = *in.Command
	}
	if in.Enabled != nil {
		task.Enabled = *in.Enabled
	}

	if task.Name == "" {
		return errors.New("name is required")
	}
	if _, err := schedule.Parse(task.Schedule); err != nil {
		return err
	}
	command, err := security.ValidateTaskCommand(task.Command)
	if err != nil {
		return err
	}
	task.Command = command
	return nil
}

func (s *Server) handleListServiceTasks(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ServiceByID(r.Context(), r.PathValue("id")); handleLookupError(w, err) {
		return
	}
	tasks, err := s.DB.ScheduledTasksByService(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) handleCreateServiceTask(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ServiceByID(r.Context(), r.PathValue("id")); handleLookupError(w, err) {
		return
	}
	var in taskInput
	if err := decode(r, &in); err != nil {
		badRequest(w, err)
		return
	}
	task := database.ScheduledTask{ServiceID: r.PathValue("id"), Enabled: true}
	if err := in.apply(&task); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.DB.CreateScheduledTask(r.Context(), &task); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, task)
}

func (s *Server) handleUpdateTask(w http.ResponseWriter, r *http.Request) {
	task, err := s.DB.ScheduledTaskByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	var in taskInput
	if err := decode(r, &in); err != nil {
		badRequest(w, err)
		return
	}
	if err := in.apply(task); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.DB.UpdateScheduledTask(r.Context(), task); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ScheduledTaskByID(r.Context(), r.PathValue("id")); handleLookupError(w, err) {
		return
	}
	if err := s.DB.DeleteScheduledTask(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// handleRunTask executes a task immediately. A non-zero exit is still a 200:
// the run happened, and its result is in the payload.
func (s *Server) handleRunTask(w http.ResponseWriter, r *http.Request) {
	task, err := s.DB.ScheduledTaskByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	run, err := s.Tasks.Execute(r.Context(), *task)
	if errors.Is(err, schedule.ErrAlreadyRunning) {
		writeError(w, http.StatusConflict, "TASK_RUNNING", err.Error(), nil)
		return
	}
	if err != nil && run == nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) handleTaskRuns(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ScheduledTaskByID(r.Context(), r.PathValue("id")); handleLookupError(w, err) {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	runs, err := s.DB.TaskRuns(r.Context(), r.PathValue("id"), limit)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, runs)
}
