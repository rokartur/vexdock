package projects

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// CreateEnvironment adds a deployable copy of a project. It gets a fresh id, so
// a directory and a docker namespace of its own, and starts with the compose
// file the default environment is running: a new environment that deploys
// nothing would be a form to fill in rather than a copy of the project.
//
// The services, variables and domains do not come with it. Those are what the
// environment exists to differ in, and copying secrets into a second place is
// not something to do behind the user's back.
func (s *Service) CreateEnvironment(ctx context.Context, p *database.Project, name, branch string) (*database.Environment, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("environment name is required")
	}
	slug := Slugify(name)
	if err := security.ValidateSlug(slug); err != nil {
		return nil, err
	}
	branch = strings.TrimSpace(branch)
	if branch != "" {
		if _, err := security.ValidateGitRef(branch); err != nil {
			return nil, err
		}
	}

	env := &database.Environment{
		ID:        database.NewID(),
		ProjectID: p.ID,
		Name:      name,
		Slug:      slug,
		Branch:    branch,
	}
	env.ComposeProjectName = ComposeProjectName(env.ID)

	if err := s.db.CreateEnvironment(ctx, env); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, fmt.Errorf("this project already has an environment named %q", name)
		}
		return nil, err
	}
	if err := s.prepareDirs(env); err != nil {
		_ = s.db.DeleteEnvironment(ctx, env.ID)
		return nil, err
	}
	if p.SourceType == database.SourceCompose {
		if err := s.seedComposeFile(ctx, p, env); err != nil {
			_ = s.db.DeleteEnvironment(ctx, env.ID)
			return nil, err
		}
	}
	return env, nil
}

// seedComposeFile copies the default environment's compose file into a new one.
// A project whose compose lives in git has nothing to copy: the deploy clones it.
func (s *Service) seedComposeFile(ctx context.Context, p *database.Project, env *database.Environment) error {
	source, err := s.db.DefaultEnvironment(ctx, p.ID)
	if err != nil {
		return err
	}
	content, err := s.ReadComposeFile(p, source)
	if err != nil {
		return err
	}
	if strings.TrimSpace(content) == "" {
		content = StarterCompose
	}
	return s.WriteComposeFile(p, env, content)
}

// UpdateEnvironment renames an environment or repoints its branch. The slug and
// the compose project name stay put: the namespace names running containers, so
// changing it would orphan every one of them.
func (s *Service) UpdateEnvironment(ctx context.Context, env *database.Environment, name, branch string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("environment name is required")
	}
	branch = strings.TrimSpace(branch)
	if branch != "" {
		if _, err := security.ValidateGitRef(branch); err != nil {
			return err
		}
	}
	env.Name, env.Branch = name, branch
	return s.db.UpdateEnvironment(ctx, env)
}

// DeleteEnvironment removes an environment's record and its directory. The
// caller stops the containers first: this only owns the state on disk and in
// the database.
//
// The default environment is refused. A project with no environment has nothing
// to deploy and no way back through the dashboard.
func (s *Service) DeleteEnvironment(ctx context.Context, env *database.Environment) error {
	if env.IsDefault {
		return fmt.Errorf("the default environment cannot be deleted")
	}
	if err := s.db.DeleteEnvironment(ctx, env.ID); err != nil {
		return err
	}
	return os.RemoveAll(s.cfg.ProjectDir(env.ID))
}
