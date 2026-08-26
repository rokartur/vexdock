package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/schedule"
	"github.com/vexdock/platform/manager/internal/security"
)

// taskInput is the writable half of a scheduled task. Every field is a pointer
// so a PATCH that omits one leaves it alone; apply then validates the result,
// which makes create and update the same check.
type taskInput struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Schedule    *string `json:"schedule"`
	Timezone    *string `json:"timezone"`
	Command     *string `json:"command"`
	Shell       *string `json:"shell"`
	Enabled     *bool   `json:"enabled"`
}

func (in taskInput) apply(task *database.ScheduledTask) error {
	if in.Name != nil {
		task.Name = strings.TrimSpace(*in.Name)
	}
	if in.Description != nil {
		task.Description = strings.TrimSpace(*in.Description)
	}
	if in.Schedule != nil {
		task.Schedule = strings.TrimSpace(*in.Schedule)
	}
	if in.Timezone != nil {
		task.Timezone = strings.TrimSpace(*in.Timezone)
	}
	if in.Command != nil {
		task.Command = *in.Command
	}
	if in.Shell != nil {
		task.Shell = *in.Shell
	}
	if in.Enabled != nil {
		task.Enabled = *in.Enabled
	}

	if task.Name == "" {
		return errors.New("name is required")
	}
	// Free text goes to a list cell and to the error below, so it is bounded here
	// rather than left to whatever the request body limit happens to be.
	if len(task.Name) > 200 {
		return errors.New("name is too long")
	}
	if len(task.Description) > 500 {
		return errors.New("description is too long")
	}
	if len(task.Timezone) > 64 {
		return errors.New("timezone is too long")
	}
	if _, err := schedule.Parse(task.Schedule); err != nil {
		return err
	}
	if _, err := schedule.Location(task.Timezone); err != nil {
		return errors.New("unknown timezone " + task.Timezone)
	}
	shell, err := security.ValidateTaskShell(task.Shell)
	if err != nil {
		return err
	}
	task.Shell = shell
	command, err := security.ValidateTaskCommand(task.Command)
	if err != nil {
		return err
	}
	task.Command = command
	return nil
}

// setNextRun fills in when a task fires next, the readout that tells a user
// their expression means what they meant. A disabled task fires never, and an
// expression the calendar never reaches leaves the field out.
func setNextRun(task *database.ScheduledTask, now time.Time) {
	task.NextRun = ""
	if !task.Enabled {
		return
	}
	parsed, err := schedule.Parse(task.Schedule)
	if err != nil {
		return
	}
	loc, err := schedule.Location(task.Timezone)
	if err != nil {
		return
	}
	// UTC to match every other timestamp the API hands out; the browser renders
	// it in local time either way.
	if next, ok := parsed.Next(now.In(loc)); ok {
		task.NextRun = next.UTC().Format(time.RFC3339Nano)
	}
}

// taskWithOwner is a task as the cross-project list needs it: the service and
// project a row belongs to, so the page can name it and link to it without a
// request per row. Both task lists answer this shape, which is what lets one
// table serve the service tab and the cross-project page.
type taskWithOwner struct {
	database.ScheduledTask
	ServiceName string `json:"service_name"`
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
}

func withOwners(tasks []database.ScheduledTask, services map[string]database.Service, projects map[string]database.Project) []taskWithOwner {
	now := time.Now()
	out := make([]taskWithOwner, 0, len(tasks))
	for i := range tasks {
		setNextRun(&tasks[i], now)
		service := services[tasks[i].ServiceID]
		out = append(out, taskWithOwner{
			ScheduledTask: tasks[i],
			ServiceName:   service.ComposeServiceName,
			ProjectID:     service.ProjectID,
			ProjectName:   projects[service.ProjectID].Name,
		})
	}
	return out
}

func (s *Server) handleListAllTasks(w http.ResponseWriter, r *http.Request) {
	tasks, err := s.DB.AllScheduledTasks(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	services, err := s.DB.AllServices(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	projects, err := s.DB.ListProjects(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	serviceByID := map[string]database.Service{}
	for _, service := range services {
		serviceByID[service.ID] = service
	}
	projectByID := map[string]database.Project{}
	for _, project := range projects {
		projectByID[project.ID] = project
	}
	writeJSON(w, http.StatusOK, withOwners(tasks, serviceByID, projectByID))
}

func (s *Server) handleListServiceTasks(w http.ResponseWriter, r *http.Request) {
	service, err := s.DB.ServiceByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	tasks, err := s.DB.ScheduledTasksByService(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	project, err := s.DB.ProjectByID(r.Context(), service.ProjectID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, withOwners(tasks,
		map[string]database.Service{service.ID: *service},
		map[string]database.Project{project.ID: *project}))
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
	setNextRun(&task, time.Now())
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
	setNextRun(task, time.Now())
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
