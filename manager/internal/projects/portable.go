package projects

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/vexdock/platform/manager/internal/database"
)

// exportVersion is the shape of the blob, not the shape of vexdock. Bump it
// only when an older manager would misread a newer export.
const exportVersion = 1

// PortableService is one service stripped of everything that only means
// something in the project it came from: no ids, no timestamps, no container
// state. What is left is enough to recreate it somewhere else.
//
// Every field here has to be one the import can actually apply, or the blob
// promises something that is silently dropped. DisplayName is absent for that
// reason: creating a service takes no display name.
type PortableService struct {
	Name            string           `json:"name"`
	SourceType      string           `json:"source_type"`
	RepositoryURL   string           `json:"repository_url,omitempty"`
	Branch          string           `json:"branch,omitempty"`
	BuildPath       string           `json:"build_path,omitempty"`
	Image           string           `json:"image,omitempty"`
	Engine          string           `json:"engine,omitempty"`
	DataPath        string           `json:"data_path,omitempty"`
	ComposeFragment string           `json:"compose_fragment,omitempty"`
	Env             []PortableEnvVar `json:"env,omitempty"`
}

// PortableEnvVar drops UpdatedAt: the timestamp describes the row it came from,
// not the variable. A secret exported without its value keeps the key so the
// importing side knows what it still has to fill in.
type PortableEnvVar struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsSecret bool   `json:"is_secret"`
}

// Export is what a base64 blob decodes to.
type Export struct {
	Version  int               `json:"version"`
	Project  string            `json:"project"`
	Services []PortableService `json:"services"`
}

// ExportServices renders a project's manager-owned services as a base64 blob to
// paste into another project's import. Services derived from the project's own
// compose file are left out, because they already travel inside that file.
//
// With secrets=false every secret exports as its key and an empty value, so the
// import lands with the shape intact and the values to be refilled. Base64 is
// not encryption: with secrets=true the blob is as sensitive as the database.
func (s *Service) ExportServices(ctx context.Context, p *database.Project, secrets bool) (string, error) {
	all, err := s.db.ListServices(ctx, p.ID)
	if err != nil {
		return "", err
	}
	out := Export{Version: exportVersion, Project: p.Name, Services: []PortableService{}}
	for _, svc := range all {
		if !svc.Managed() {
			continue
		}
		env, err := s.ServiceEnvironment(ctx, svc.ID, false)
		if err != nil {
			return "", err
		}
		portable := make([]PortableEnvVar, 0, len(env))
		for _, v := range env {
			value := v.Value
			if v.IsSecret && !secrets {
				value = ""
			}
			portable = append(portable, PortableEnvVar{Key: v.Key, Value: value, IsSecret: v.IsSecret})
		}
		out.Services = append(out.Services, PortableService{
			Name:            svc.ComposeServiceName,
			SourceType:      svc.SourceType,
			RepositoryURL:   svc.RepositoryURL,
			Branch:          svc.Branch,
			BuildPath:       svc.BuildPath,
			Image:           svc.Image,
			Engine:          svc.Engine,
			DataPath:        svc.DataPath,
			ComposeFragment: svc.ComposeFragment,
			Env:             portable,
		})
	}
	body, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("encode export: %w", err)
	}
	return base64.StdEncoding.EncodeToString(body), nil
}
