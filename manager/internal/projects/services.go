package projects

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/engines"
	"github.com/vexdock/platform/manager/internal/security"
)

// applyGit validates and stores the repository fields of a git service. The
// four connected providers name a repository on a connection; the plain git
// provider carries its own URL and credential.
func (s *Service) applyGit(ctx context.Context, svc *database.Service, in ServiceInput) error {
	branch := in.Branch
	if branch == "" {
		branch = "main"
	}
	branch, err := security.ValidateGitRef(branch)
	if err != nil {
		return err
	}
	buildPath, err := security.ValidateSubPath(in.BuildPath)
	if err != nil {
		return err
	}
	svc.Branch, svc.BuildPath = branch, buildPath
	if database.ClonesFromConnection(svc.Provider) {
		return s.SetGitRepository(ctx, svc, in.GitProviderID, in.Owner, in.Repository)
	}
	url, err := security.ValidateGitURL(in.RepositoryURL)
	if err != nil {
		return err
	}
	svc.RepositoryURL = url
	return s.SetCredential(svc, in.CredentialKind, in.CredentialSecret)
}

// containerName settles what the service's container is called on the host.
// Without one compose falls back to the environment's opaque id, so the default
// is the project's slug and the service's name, the way a person would say it:
// "rokartur-db". A second environment puts its own name in between, because a
// container name is unique across the whole host, not within a project.
func (s *Service) containerName(ctx context.Context, env *database.Environment, service, override string) (string, error) {
	name := strings.TrimSpace(override)
	if name == "" {
		project, err := s.db.ProjectByID(ctx, env.ProjectID)
		if err != nil {
			return "", err
		}
		name = project.Slug + "-" + service
		if !env.IsDefault {
			name = project.Slug + "-" + env.Slug + "-" + service
		}
	}
	if err := security.ValidateContainerName(name); err != nil {
		return "", err
	}
	if taken, err := s.db.ServiceByContainerName(ctx, name); err == nil && taken != nil {
		return "", fmt.Errorf("another service already runs a container named %q", name)
	}
	return name, nil
}

// CreateService adds a service the manager owns to a project. A database is
// rendered from the catalog before the row is written, so an invalid engine or
// version fails without leaving a half-created service behind.
func (s *Service) CreateService(ctx context.Context, env *database.Environment, in ServiceInput) (*database.Service, error) {
	name := strings.TrimSpace(in.Name)
	if err := security.ValidateServiceName(name); err != nil {
		return nil, err
	}
	if existing, err := s.db.ServiceByName(ctx, env.ID, name); err == nil && existing != nil {
		return nil, fmt.Errorf("this environment already has a service named %q", name)
	}
	container, err := s.containerName(ctx, env, name, in.ContainerName)
	if err != nil {
		return nil, err
	}

	svc := &database.Service{
		ID:                 database.NewID(),
		ProjectID:          env.ProjectID,
		EnvironmentID:      env.ID,
		ComposeServiceName: name,
		ContainerName:      container,
		Type:               database.ServiceApplication,
		Provider:           in.Provider,
		CredentialKind:     database.GitCredentialNone,
		BuildType:          database.BuildDockerfile,
	}
	var seed []engines.Variable

	switch {
	case in.Provider == database.ProviderUnconfigured:
		// An application is created as a bare name. Where its image comes from
		// is answered later, in the service's own settings.
	case database.ClonesFromGit(in.Provider):
		if err := s.applyGit(ctx, svc, in); err != nil {
			return nil, err
		}
	case in.Provider == database.ProviderImage:
		if in.Database == nil {
			image, err := engines.ValidateImage(in.Image)
			if err != nil {
				return nil, err
			}
			svc.Image = image
			break
		}
		rendered, err := engines.Render(engines.Spec{
			Engine:   in.Database.Engine,
			Tag:      in.Database.Version,
			Database: in.Database.Name,
			User:     in.Database.User,
			Password: in.Database.Password,
			Image:    in.Database.Image,
			DataPath: in.Database.DataPath,
			Sqld:     in.Database.Sqld,
			Name:     name,
			// Only rendered to validate the spec here; the real file is written
			// by WriteOverlay once the row exists.
			EnvFile: s.ServiceEnvFilePath(env, name),
		})
		if err != nil {
			return nil, err
		}
		svc.Type = database.ServiceDatabase
		svc.Engine = in.Database.Engine
		svc.Image = rendered.Image
		// Re-rendering the overlay needs the same path back; the catalog only
		// knows it for curated engines.
		svc.DataPath = strings.TrimSpace(in.Database.DataPath)
		seed = rendered.Env
	case in.Provider == database.ProviderRaw:
		if strings.TrimSpace(in.ComposeFragment) == "" {
			return nil, fmt.Errorf("a compose fragment is required")
		}
		svc.ComposeFragment = in.ComposeFragment
	default:
		return nil, fmt.Errorf("unknown service provider %q", in.Provider)
	}

	if err := s.db.CreateService(ctx, svc); err != nil {
		return nil, err
	}
	if len(seed) > 0 {
		vars := make([]EnvVar, 0, len(seed))
		for _, v := range seed {
			vars = append(vars, EnvVar{Key: v.Key, Value: v.Value, IsSecret: v.Secret})
		}
		if err := s.SetServiceVariables(ctx, svc.ID, vars); err != nil {
			// A database without its credentials cannot start, and the row
			// would be a trap rather than a service.
			_ = s.db.DeleteService(ctx, svc.ID)
			return nil, fmt.Errorf("store database credentials: %w", err)
		}
	}
	if _, err := s.WriteOverlay(ctx, env); err != nil {
		_ = s.db.DeleteService(ctx, svc.ID)
		return nil, err
	}
	return svc, nil
}

// copyService writes src into an environment under a new name, with the
// variables it cannot start without. The git credential travels encrypted as
// it is, since the same manager holds the key.
func (s *Service) copyService(ctx context.Context, src database.Service, env *database.Environment, name string) (*database.Service, error) {
	name = strings.TrimSpace(name)
	if err := security.ValidateServiceName(name); err != nil {
		return nil, err
	}
	if existing, err := s.db.ServiceByName(ctx, env.ID, name); err == nil && existing != nil {
		return nil, fmt.Errorf("this environment already has a service named %q", name)
	}
	vars, err := s.ServiceVariables(ctx, src.ID)
	if err != nil {
		return nil, err
	}
	// The copy cannot answer to the container name the original already holds,
	// so it takes the one its own environment would have given it.
	container, err := s.containerName(ctx, env, name, "")
	if err != nil {
		return nil, err
	}

	copied := src
	copied.ID, copied.ProjectID, copied.EnvironmentID = database.NewID(), env.ProjectID, env.ID
	copied.ComposeServiceName, copied.ContainerName = name, container
	if err := s.db.CreateService(ctx, &copied); err != nil {
		return nil, err
	}
	if err := s.SetServiceVariables(ctx, copied.ID, vars); err != nil {
		_ = s.db.DeleteService(ctx, copied.ID)
		return nil, err
	}
	return &copied, nil
}

// DuplicateService copies a service under a new name, with its variables and
// its scheduled tasks. Not its volumes, so the copy starts on empty data, and
// not its domains, since a hostname answers in one place only.
func (s *Service) DuplicateService(ctx context.Context, src *database.Service, env *database.Environment, name string) (*database.Service, error) {
	copied, err := s.copyService(ctx, *src, env, name)
	if err != nil {
		return nil, err
	}
	tasks, err := s.db.ScheduledTasksByService(ctx, src.ID)
	if err != nil {
		_ = s.db.DeleteService(ctx, copied.ID)
		return nil, err
	}
	for _, task := range tasks {
		task.ServiceID = copied.ID
		if err := s.db.CreateScheduledTask(ctx, &task); err != nil {
			_ = s.db.DeleteService(ctx, copied.ID)
			return nil, err
		}
	}
	if _, err := s.WriteOverlay(ctx, env); err != nil {
		_ = s.db.DeleteService(ctx, copied.ID)
		return nil, err
	}
	return copied, nil
}

// CheckMoveService answers whether MoveService would be allowed, without
// touching anything, and returns the container name the service would take. The
// caller removes the old container before it can copy the volumes, so it has to
// be able to ask first: a move rejected after that point leaves the service
// down with nothing moved.
func (s *Service) CheckMoveService(ctx context.Context, svc *database.Service, from, to *database.Environment) (string, error) {
	if from.ID == to.ID {
		return "", fmt.Errorf("this service is already in that environment")
	}
	if existing, err := s.db.ServiceByName(ctx, to.ID, svc.ComposeServiceName); err == nil && existing != nil {
		return "", fmt.Errorf("the target environment already has a service named %q", svc.ComposeServiceName)
	}
	return s.containerName(ctx, to, svc.ComposeServiceName, "")
}

// MoveService hands a service to another environment: the row changes owner,
// the container takes the name that environment would give it, the git checkout
// follows on disk and both overlays are rewritten. Copying the volume data and
// removing the old container are the caller's job; both need docker. The
// container name comes from the CheckMoveService the caller already ran.
func (s *Service) MoveService(ctx context.Context, svc *database.Service, from, to *database.Environment, container string) error {
	if err := os.MkdirAll(filepath.Join(s.cfg.ProjectDir(to.ID), servicesDirName), 0o750); err != nil {
		return err
	}
	// The row moves before anything on disk does: a rename and a delete that ran
	// against a move the database then refused would leave the source
	// environment's overlay pointing at an env_file nothing can recreate.
	svc.ProjectID, svc.EnvironmentID, svc.ContainerName = to.ProjectID, to.ID, container
	if err := s.db.MoveService(ctx, svc); err != nil {
		return err
	}
	if err := os.Rename(s.ServiceDir(from, svc.ComposeServiceName), s.ServiceDir(to, svc.ComposeServiceName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Remove(s.ServiceEnvFilePath(from, svc.ComposeServiceName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err := s.WriteOverlay(ctx, from); err != nil {
		return err
	}
	_, err := s.WriteOverlay(ctx, to)
	return err
}

// ServiceVolumes names the volumes a service's compose body declares, before
// compose prefixes each of them with the environment's compose project name.
func (s *Service) ServiceVolumes(ctx context.Context, env *database.Environment, svc *database.Service) ([]string, error) {
	// A service nobody configured yet has no body to render.
	if svc.Provider == database.ProviderUnconfigured {
		return nil, nil
	}
	vars, err := s.ServiceVariables(ctx, svc.ID)
	if err != nil {
		return nil, err
	}
	_, volumes, err := s.renderService(env, *svc, vars)
	return volumes, err
}

// DeleteService drops a managed service and rewrites the overlay without it.
// Removing its container is the caller's job, since a deploy is scoped to one
// service and never prunes another. The named volume is deliberately left
// behind: deleting a database's data is a separate, explicit act.
//
// The row's secrets go with it though, so a generated password does not outlive
// the delete even though the data does. Read it from the database endpoint
// first if the volume is ever meant to be reattached.
func (s *Service) DeleteService(ctx context.Context, svc *database.Service, env *database.Environment) error {
	if err := s.db.DeleteService(ctx, svc.ID); err != nil {
		return err
	}
	if err := os.Remove(s.ServiceEnvFilePath(env, svc.ComposeServiceName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, err := s.WriteOverlay(ctx, env)
	return err
}
