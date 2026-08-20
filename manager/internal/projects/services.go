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

	svc := &database.Service{
		ID:                 database.NewID(),
		ProjectID:          env.ProjectID,
		EnvironmentID:      env.ID,
		ComposeServiceName: name,
		Type:               database.ServiceApplication,
		SourceType:         in.SourceType,
	}
	var seed []engines.Variable

	switch in.SourceType {
	case database.ServiceUnconfigured:
		// An application is created as a bare name. Where its image comes from
		// is answered later, in the service's own settings.
	case database.ServiceGit:
		url, err := security.ValidateGitURL(in.RepositoryURL)
		if err != nil {
			return nil, err
		}
		branch := in.Branch
		if branch == "" {
			branch = "main"
		}
		if branch, err = security.ValidateGitRef(branch); err != nil {
			return nil, err
		}
		svc.RepositoryURL, svc.Branch = url, branch
		if svc.BuildPath, err = security.ValidateSubPath(in.BuildPath); err != nil {
			return nil, err
		}
	case database.ServiceImage:
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
	case database.ServiceCompose:
		if strings.TrimSpace(in.ComposeFragment) == "" {
			return nil, fmt.Errorf("a compose fragment is required")
		}
		svc.ComposeFragment = in.ComposeFragment
	default:
		return nil, fmt.Errorf("unknown service source %q", in.SourceType)
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
	if !svc.Managed() {
		return fmt.Errorf("this service is declared by the project's own compose file; remove it there")
	}
	if err := s.db.DeleteService(ctx, svc.ID); err != nil {
		return err
	}
	if err := os.Remove(s.ServiceEnvFilePath(env, svc.ComposeServiceName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, err := s.WriteOverlay(ctx, env)
	return err
}
