// Package engines is the catalog of one-click databases: which image a service
// runs, which versions it offers and how to connect to it once it is up.
//
// A database is one service among the others in a project, so what an engine
// renders is a compose service fragment rather than a file. Credentials reach
// the container through that service's own env file instead of compose-level
// interpolation, which is what lets two Postgres services in one project each
// have their own POSTGRES_PASSWORD.
package engines

import (
	"fmt"
	"regexp"
	"strings"
	"text/template"

	"github.com/vexdock/platform/manager/internal/security"
)

// Custom is the engine slug for "any other image". It has no curated template,
// so the caller must supply both the image and the path its data lives on.
const Custom = "custom"

// Engine is one entry of the catalog.
type Engine struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Repository is the image name without a tag. It is a constant of this
	// catalog and never comes from user input, which is what makes the Docker
	// Hub tag lookup safe to perform on the user's behalf.
	Repository string `json:"repository"`
	DefaultTag string `json:"default_tag"`
	// Versions is the offline fallback: what the version picker shows when
	// Docker Hub cannot be reached.
	Versions []string `json:"versions"`
	// Port is where the engine listens inside the container.
	Port int `json:"port"`
	// Scheme prefixes the connection URL shown on the database page.
	Scheme string `json:"scheme"`
	// The environment variables holding the credentials, empty when the engine
	// has no such concept. Valkey, for instance, has neither a database nor a
	// user, only a password.
	DatabaseVar string `json:"database_var"`
	UserVar     string `json:"user_var"`
	PasswordVar string `json:"password_var"`
	// fragment is the service body, indented to sit under its own key in a
	// compose file, as a text/template.
	fragment string
}

// Spec is a validated request to create a database service.
type Spec struct {
	Engine   string
	Tag      string
	Database string
	User     string
	Password string
	// Image, when set, is the reference to run and wins over Tag for every
	// engine: it carries the version already stored against the service, which
	// re-deriving from the catalog default would move. DataPath is custom-only.
	Image    string
	DataPath string
	// Name is the compose service name. It is also the volume prefix and the
	// hostname the service answers to on the project's default network.
	Name string
	// EnvFile is the absolute path of the file holding this service's
	// environment, which the fragment points compose at.
	EnvFile string
}

// Variable is one seeded environment entry.
type Variable struct {
	Key    string
	Value  string
	Secret bool
}

// Rendered is everything a new database service contributes to its project.
type Rendered struct {
	// Fragment is the compose service body, indented four spaces.
	Fragment string
	// Volume is the named volume the fragment mounts, which the overlay has to
	// declare at the top level.
	Volume string
	// Image is the reference the service will run, resolved from the tag.
	Image string
	Env   []Variable
}

// Catalog is the curated list, in the order the create form shows it.
var Catalog = []Engine{
	{
		Slug:        "postgres",
		Name:        "PostgreSQL",
		Repository:  "library/postgres",
		DefaultTag:  "17-alpine",
		Versions:    []string{"17-alpine", "17", "16-alpine", "16", "15-alpine", "15"},
		Port:        5432,
		Scheme:      "postgresql",
		DatabaseVar: "POSTGRES_DB",
		UserVar:     "POSTGRES_USER",
		PasswordVar: "POSTGRES_PASSWORD",
		fragment: `    image: {{ .Image }}
    restart: unless-stopped
    env_file: ["{{ .EnvFile }}"]
    volumes:
      - {{ .Volume }}:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 10s
      timeout: 5s
      retries: 5`,
	},
	{
		Slug:        "mysql",
		Name:        "MySQL",
		Repository:  "library/mysql",
		DefaultTag:  "8",
		Versions:    []string{"8", "8.4", "8.0", "9"},
		Port:        3306,
		Scheme:      "mysql",
		DatabaseVar: "MYSQL_DATABASE",
		UserVar:     "MYSQL_USER",
		PasswordVar: "MYSQL_PASSWORD",
		fragment: `    image: {{ .Image }}
    restart: unless-stopped
    env_file: ["{{ .EnvFile }}"]
    volumes:
      - {{ .Volume }}:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      timeout: 5s
      retries: 10`,
	},
	{
		Slug:        "mariadb",
		Name:        "MariaDB",
		Repository:  "library/mariadb",
		DefaultTag:  "11",
		Versions:    []string{"11", "11.4", "10.11"},
		Port:        3306,
		Scheme:      "mysql",
		DatabaseVar: "MARIADB_DATABASE",
		UserVar:     "MARIADB_USER",
		PasswordVar: "MARIADB_PASSWORD",
		fragment: `    image: {{ .Image }}
    restart: unless-stopped
    env_file: ["{{ .EnvFile }}"]
    volumes:
      - {{ .Volume }}:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10`,
	},
	{
		Slug:        "mongodb",
		Name:        "MongoDB",
		Repository:  "library/mongo",
		DefaultTag:  "8",
		Versions:    []string{"8", "7", "6"},
		Port:        27017,
		Scheme:      "mongodb",
		DatabaseVar: "MONGO_INITDB_DATABASE",
		UserVar:     "MONGO_INITDB_ROOT_USERNAME",
		PasswordVar: "MONGO_INITDB_ROOT_PASSWORD",
		fragment: `    image: {{ .Image }}
    restart: unless-stopped
    env_file: ["{{ .EnvFile }}"]
    volumes:
      - {{ .Volume }}:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 10`,
	},
	{
		Slug:        "valkey",
		Name:        "Valkey",
		Repository:  "valkey/valkey",
		DefaultTag:  "8-alpine",
		Versions:    []string{"8-alpine", "8", "7-alpine"},
		Port:        6379,
		Scheme:      "redis",
		PasswordVar: "VALKEY_PASSWORD",
		// The password reaches valkey through the shell rather than through
		// compose interpolation, because the env file is per service and compose
		// only interpolates from the project-wide one.
		fragment: `    image: {{ .Image }}
    restart: unless-stopped
    env_file: ["{{ .EnvFile }}"]
    command: ["sh", "-c", "exec valkey-server --requirepass \"$$VALKEY_PASSWORD\" --appendonly yes"]
    volumes:
      - {{ .Volume }}:/data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli --no-auth-warning -a \"$$VALKEY_PASSWORD\" ping"]
      interval: 10s
      timeout: 5s
      retries: 5`,
	},
	{
		Slug:        Custom,
		Name:        "Other image",
		DefaultTag:  "",
		Port:        0,
		Scheme:      "",
		PasswordVar: "",
		fragment: `    image: {{ .Image }}
    restart: unless-stopped
    env_file: ["{{ .EnvFile }}"]
    volumes:
      - {{ .Volume }}:{{ .DataPath }}`,
	},
}

// BySlug looks an engine up in the catalog.
func BySlug(slug string) (Engine, bool) {
	for _, e := range Catalog {
		if e.Slug == slug {
			return e, true
		}
	}
	return Engine{}, false
}

// tagPattern is what Docker accepts after the colon. Validating it here is what
// keeps a version string from turning into a second image reference.
var tagPattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$`)

// imagePattern is deliberately narrow: a registry path plus an optional tag or
// digest. It rejects the shell metacharacters and whitespace that would let a
// custom image smuggle anything into the compose file it is written into.
var imagePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}(:[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$`)

// dataPathPattern is the mount point of a custom image's volume. It is written
// straight into the compose file, so it is held to the same narrowness as an
// image reference: a space or a '#' there silently remounts the volume
// somewhere else, and the database comes back empty.
var dataPathPattern = regexp.MustCompile(`^/[a-zA-Z0-9._/-]{0,255}$`)

// identPattern covers database and user names. Both end up inside the generated
// compose file and inside a connection URL, so anything exotic is refused
// rather than escaped.
var identPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)

// Render validates a spec and produces the compose fragment and the
// environment that together define a database service.
func Render(spec Spec) (Rendered, error) {
	engine, ok := BySlug(spec.Engine)
	if !ok {
		return Rendered{}, fmt.Errorf("unknown database engine %q", spec.Engine)
	}
	if spec.Name == "" || spec.EnvFile == "" {
		return Rendered{}, fmt.Errorf("name and env file are required")
	}

	image, err := resolveImage(engine, spec)
	if err != nil {
		return Rendered{}, err
	}
	dataPath := strings.TrimSpace(spec.DataPath)
	if engine.Slug == Custom {
		// Without a volume the first redeploy silently discards the data, so a
		// custom image has to say where its data lives.
		if !dataPathPattern.MatchString(dataPath) {
			return Rendered{}, fmt.Errorf("a data path like /var/lib/data is required for a custom image")
		}
	}

	var env []Variable

	password := spec.Password
	if password == "" {
		password = security.RandomToken(24)
	}
	if engine.PasswordVar != "" {
		if strings.ContainsAny(password, " \t\n\"'") {
			return Rendered{}, fmt.Errorf("the password cannot contain whitespace or quotes")
		}
		env = append(env, Variable{Key: engine.PasswordVar, Value: password, Secret: true})
		// MySQL and MariaDB refuse to start without a root password, and it is
		// not the credential the application uses.
		if root := rootPasswordVar(engine); root != "" {
			env = append(env, Variable{Key: root, Value: security.RandomToken(24), Secret: true})
		}
	}
	if engine.DatabaseVar != "" {
		name := defaulted(spec.Database, "app")
		if !identPattern.MatchString(name) {
			return Rendered{}, fmt.Errorf("invalid database name %q", name)
		}
		env = append(env, Variable{Key: engine.DatabaseVar, Value: name})
	}
	if engine.UserVar != "" {
		user := defaulted(spec.User, "app")
		if !identPattern.MatchString(user) {
			return Rendered{}, fmt.Errorf("invalid database user %q", user)
		}
		env = append(env, Variable{Key: engine.UserVar, Value: user})
	}

	tmpl, err := template.New(engine.Slug).Parse(engine.fragment)
	if err != nil {
		return Rendered{}, err
	}
	volume := spec.Name + "-data"
	var out strings.Builder
	if err := tmpl.Execute(&out, map[string]string{
		"Image":    image,
		"Volume":   volume,
		"EnvFile":  spec.EnvFile,
		"DataPath": dataPath,
	}); err != nil {
		return Rendered{}, err
	}
	return Rendered{Fragment: out.String(), Volume: volume, Image: image, Env: env}, nil
}

// resolveImage turns a spec into the image reference the service will run. An
// explicit reference always wins: the custom engine has nothing else, and for a
// curated one it is an existing service's stored image, which already carries
// the version that was chosen at create time. Deriving from the tag instead
// would quietly move every database onto the catalog's current default.
func resolveImage(engine Engine, spec Spec) (string, error) {
	image := strings.TrimSpace(spec.Image)
	if image == "" && engine.Slug != Custom {
		tag := defaulted(spec.Tag, engine.DefaultTag)
		if !tagPattern.MatchString(tag) {
			return "", fmt.Errorf("invalid version %q", tag)
		}
		image = strings.TrimPrefix(engine.Repository, "library/") + ":" + tag
	}
	return ValidateImage(image)
}

// ValidateImage returns the trimmed reference, rejecting anything that could
// not appear verbatim after `image:` in a compose file. Every image reaching an
// overlay goes through here: the value is user-supplied and is written into
// YAML, so a newline in it would open sibling keys on the service.
func ValidateImage(image string) (string, error) {
	image = strings.TrimSpace(image)
	if !imagePattern.MatchString(image) {
		return "", fmt.Errorf("invalid image reference %q", image)
	}
	return image, nil
}

// rootPasswordVar names the administrative password of the engines that demand
// one in addition to the application credential.
func rootPasswordVar(engine Engine) string {
	switch engine.Slug {
	case "mysql":
		return "MYSQL_ROOT_PASSWORD"
	case "mariadb":
		return "MARIADB_ROOT_PASSWORD"
	default:
		return ""
	}
}

func defaulted(value, fallback string) string {
	if v := strings.TrimSpace(value); v != "" {
		return v
	}
	return fallback
}

// Connection is what the database page shows.
type Connection struct {
	Engine   string `json:"engine"`
	Image    string `json:"image"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	User     string `json:"user"`
	Password string `json:"password"`
	URL      string `json:"url"`
}

// Describe reads a running database service back out of its image and its
// environment. The environment is the authority precisely because it is what
// the container was started with, so an edited variable shows up here.
func Describe(engine Engine, alias, image string, env map[string]string) Connection {
	c := Connection{
		Engine:   engine.Slug,
		Image:    image,
		Host:     alias,
		Port:     engine.Port,
		Database: env[engine.DatabaseVar],
		User:     env[engine.UserVar],
		Password: env[engine.PasswordVar],
	}
	if engine.Scheme == "" || c.Password == "" {
		return c
	}
	auth := c.Password
	if c.User != "" {
		auth = c.User + ":" + c.Password
	}
	c.URL = fmt.Sprintf("%s://%s@%s:%d/%s", engine.Scheme, auth, c.Host, c.Port, c.Database)
	return c
}
