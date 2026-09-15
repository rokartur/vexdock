// Package templates is the catalog of one-click applications: a curated stack
// of compose services, the variables it needs seeded and where its domain
// points.
//
// A template renders into ordinary raw services, one row per compose service,
// so nothing downstream knows a template existed. Its values are seeded as
// environment variables and reached through ${VAR}, which compose interpolates
// from the environment's .env file; that is what lets two services of one
// template share a password the user can still edit.
package templates

import (
	"fmt"

	"github.com/vexdock/platform/manager/internal/security"
)

// The two placeholders a variable's value may carry instead of a literal.
// Hostname becomes the domain the user typed; Generate becomes a fresh random
// secret, and is the only kind stored as one.
const (
	Hostname = "{hostname}"
	Generate = "{generate}"
)

// Variable is one entry a template seeds into the environment. Secret is set
// by Render rather than by the catalog: a generated value is a credential, a
// literal or a hostname never is.
type Variable struct {
	Key    string
	Value  string
	Secret bool
}

// Service is one compose service of a template: the key it takes in the
// generated file and the body underneath it.
type Service struct {
	Name string `json:"name"`
	// fragment is the service body at zero indentation, the same shape a
	// pasted compose service has.
	fragment string
}

// Domain names the service and container port a hostname should reach. Nil for
// a template nothing addresses from outside.
type Domain struct {
	Service string `json:"service"`
	Port    int    `json:"port"`
}

// Template is one entry of the catalog.
type Template struct {
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Tags        []string  `json:"tags"`
	Services    []Service `json:"services"`
	Domain      *Domain   `json:"domain"`
	// Variables are internal: their values are generated per install, so there
	// is nothing to show before one exists.
	Variables []Variable `json:"-"`
}

// Rendered is one install of a template.
type Rendered struct {
	Services  []Service
	Variables []Variable
	Domain    *Domain
}

// Fragment is the compose body of a rendered service.
func (s Service) Fragment() string { return s.fragment }

// BySlug looks a template up in the catalog.
func BySlug(slug string) (Template, bool) {
	for _, t := range Catalog {
		if t.Slug == slug {
			return t, true
		}
	}
	return Template{}, false
}

// Render resolves a template's variables for one install. A template that
// declares a domain needs the hostname up front: these apps bake their own URL
// into their configuration on first boot, so adding the domain afterwards
// leaves the app generating links to nothing.
func Render(slug, hostname string) (Rendered, error) {
	t, ok := BySlug(slug)
	if !ok {
		return Rendered{}, fmt.Errorf("unknown template %q", slug)
	}
	host := ""
	if t.Domain != nil {
		validated, err := security.ValidateHostname(hostname)
		if err != nil {
			return Rendered{}, err
		}
		host = validated
	}
	vars := make([]Variable, 0, len(t.Variables))
	for _, v := range t.Variables {
		switch v.Value {
		case Hostname:
			v.Value = host
		case Generate:
			v.Value, v.Secret = security.RandomToken(24), true
		}
		vars = append(vars, v)
	}
	return Rendered{Services: t.Services, Variables: vars, Domain: t.Domain}, nil
}
