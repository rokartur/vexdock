package security

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

var (
	hostnameLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	slugPattern   = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// Compose service names follow the same rules docker compose enforces.
	servicePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
	sshRepoPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$`)
)

// ValidateHostname accepts a DNS name usable as an Nginx server_name. A single
// leading "*." is allowed; whether it can actually be issued is decided at
// certificate time, since only the DNS-01 challenge can validate a wildcard.
func ValidateHostname(host string) (string, error) {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return "", fmt.Errorf("domain is required")
	}
	if len(h) > 253 {
		return "", fmt.Errorf("domain is too long")
	}
	labels := strings.Split(strings.TrimPrefix(h, "*."), ".")
	if strings.Contains(strings.TrimPrefix(h, "*."), "*") {
		return "", fmt.Errorf("a wildcard is only allowed as the leftmost label, as in *.example.com")
	}
	if len(labels) < 2 {
		return "", fmt.Errorf("domain must contain at least one dot")
	}
	for _, label := range labels {
		if !hostnameLabel.MatchString(label) {
			return "", fmt.Errorf("invalid domain label %q", label)
		}
	}
	return h, nil
}

// ValidatePort bounds a container port.
func ValidatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	return nil
}

// ValidateSlug checks a URL-safe project identifier.
func ValidateSlug(slug string) error {
	if !slugPattern.MatchString(slug) {
		return fmt.Errorf("slug must be lowercase alphanumeric with dashes")
	}
	return nil
}

// ValidateServiceName checks a compose service name.
func ValidateServiceName(name string) error {
	if !servicePattern.MatchString(name) {
		return fmt.Errorf("invalid compose service name %q", name)
	}
	return nil
}

// ValidateEnvKey checks an environment variable name.
func ValidateEnvKey(key string) error {
	if !envKeyPattern.MatchString(key) {
		return fmt.Errorf("invalid environment variable name %q", key)
	}
	return nil
}

// ValidateGitURL accepts https/ssh git remotes only. It blocks local file and
// ext:// transports, which would otherwise let a repository URL read host files
// or execute commands during clone.
func ValidateGitURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("repository URL is required")
	}
	if strings.ContainsAny(s, " \t\n\r") {
		return "", fmt.Errorf("repository URL must not contain whitespace")
	}
	if strings.HasPrefix(s, "-") {
		return "", fmt.Errorf("repository URL must not start with a dash")
	}
	if sshRepoPattern.MatchString(s) {
		return s, nil
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("invalid repository URL: %w", err)
	}
	switch u.Scheme {
	case "http", "https", "ssh":
	default:
		return "", fmt.Errorf("unsupported git transport %q", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("repository URL is missing a host")
	}
	// ssh://git@host/... carries a login name, which is normal and harmless.
	// A secret in the URL is not: it would be stored unencrypted and logged.
	if u.User != nil {
		if _, hasPassword := u.User.Password(); hasPassword || u.Scheme != "ssh" {
			return "", fmt.Errorf("store credentials in project settings, not in the URL")
		}
	}
	return s, nil
}

// ValidateGitRef accepts a branch, tag or commit-ish. It rejects anything that
// could be read as a git option or shell metacharacter.
func ValidateGitRef(ref string) (string, error) {
	r := strings.TrimSpace(ref)
	if r == "" {
		return "", fmt.Errorf("git ref is required")
	}
	if strings.HasPrefix(r, "-") || strings.ContainsAny(r, " \t\n\r~^:?*[\\") || strings.Contains(r, "..") {
		return "", fmt.Errorf("invalid git ref %q", ref)
	}
	return r, nil
}

// ValidateSubPath accepts a path that must stay inside the directory it will be
// joined to, and returns it without its leading slash. Empty means the root of
// that directory. ".." is rejected rather than cleaned away: a build path lands
// in a docker build context, so escaping the checkout would hand the daemon an
// arbitrary host directory.
func ValidateSubPath(raw string) (string, error) {
	p := strings.Trim(strings.TrimSpace(raw), "/")
	if p == "" {
		return "", nil
	}
	if strings.ContainsAny(p, "\\\n\r\t") || p == ".." || strings.HasPrefix(p, "../") || path.Clean(p) != p {
		return "", fmt.Errorf("invalid path %q", raw)
	}
	return p, nil
}
