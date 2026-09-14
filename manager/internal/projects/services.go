package projects

import (
	"context"
	"fmt"
	"os"
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

// DeleteService drops a managed service and rewrites the overlay so the next
// deploy removes its container. The named volume is deliberately left behind:
// deleting a database's data is a separate, explicit act.
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
