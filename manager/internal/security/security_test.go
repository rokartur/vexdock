package security

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCipherRoundTrip(t *testing.T) {
	c, err := NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatalf("new cipher: %v", err)
	}
	secret := "postgres://user:p@ssw0rd@db:5432/app"
	sealed, err := c.Encrypt(secret)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if strings.Contains(sealed, "p@ssw0rd") {
		t.Fatal("ciphertext leaks the plaintext")
	}
	opened, err := c.Decrypt(sealed)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if opened != secret {
		t.Fatalf("round trip mismatch: %q", opened)
	}
	// A different nonce must be used every time, otherwise equal secrets are
	// linkable in the database.
	again, _ := c.Encrypt(secret)
	if again == sealed {
		t.Fatal("encryption is deterministic")
	}
	if _, err := c.Decrypt("not base64 $$"); err == nil {
		t.Fatal("expected an error for a corrupt payload")
	}
}

func TestResolveInsideBlocksTraversal(t *testing.T) {
	base := t.TempDir()
	ok, err := ResolveInside(base, "stack/compose.yml")
	if err != nil {
		t.Fatalf("valid path rejected: %v", err)
	}
	if ok != filepath.Join(base, "stack/compose.yml") {
		t.Fatalf("unexpected resolution %q", ok)
	}
	for _, bad := range []string{"../etc/passwd", "a/../../b", "/etc/passwd", "", "a/\x00b"} {
		if _, err := ResolveInside(base, bad); err == nil {
			t.Fatalf("path %q should have been rejected", bad)
		}
	}
}

func TestValidateHostname(t *testing.T) {
	got, err := ValidateHostname("  App.Example.COM. ")
	if err != nil {
		t.Fatalf("valid hostname rejected: %v", err)
	}
	if got != "app.example.com" {
		t.Fatalf("hostname not normalized: %q", got)
	}
	if got, err := ValidateHostname("*.Example.com"); err != nil || got != "*.example.com" {
		t.Fatalf("leftmost wildcard rejected: %q %v", got, err)
	}
	for _, bad := range []string{"", "localhost", "*.*.example.com", "a.*.example.com", "ex*ample.com",
		"-bad.example.com", "ex ample.com", "a..b.com"} {
		if _, err := ValidateHostname(bad); err == nil {
			t.Fatalf("hostname %q should have been rejected", bad)
		}
	}
}

func TestValidatePortAndEnvKey(t *testing.T) {
	if err := ValidatePort(3000); err != nil {
		t.Fatalf("valid port rejected: %v", err)
	}
	for _, bad := range []int{0, -1, 70000} {
		if err := ValidatePort(bad); err == nil {
			t.Fatalf("port %d should have been rejected", bad)
		}
	}
	if err := ValidateEnvKey("DATABASE_URL"); err != nil {
		t.Fatalf("valid env key rejected: %v", err)
	}
	for _, bad := range []string{"1BAD", "has-dash", "has space", ""} {
		if err := ValidateEnvKey(bad); err == nil {
			t.Fatalf("env key %q should have been rejected", bad)
		}
	}
}

func TestValidateMounts(t *testing.T) {
	got, err := ValidateMounts(" push:/data \n\nuploads:/srv/app/uploads\n")
	if err != nil || got != "push:/data\nuploads:/srv/app/uploads" {
		t.Fatalf("got %q, %v", got, err)
	}
	// A host path or a second colon would bind the host filesystem or set mount options.
	for _, bad := range []string{"/etc:/data", "push:data", "push:/../etc", "push:/data:ro", "push"} {
		if _, err := ValidateMounts(bad); err == nil {
			t.Fatalf("mount %q accepted", bad)
		}
	}
}

func TestValidateGitURL(t *testing.T) {
	for _, good := range []string{
		"https://github.com/user/app.git",
		"ssh://git@github.com/user/app.git",
		"git@github.com:user/app.git",
	} {
		if _, err := ValidateGitURL(good); err != nil {
			t.Fatalf("git url %q rejected: %v", good, err)
		}
	}
	// file:// and ext:: transports can read host files or run commands.
	for _, bad := range []string{
		"file:///etc/passwd",
		"ext::sh -c 'touch /tmp/pwned'",
		"--upload-pack=touch /tmp/pwned",
		"https://user:token@github.com/user/app.git",
		"https://github.com/user/app.git extra",
		"",
	} {
		if _, err := ValidateGitURL(bad); err == nil {
			t.Fatalf("git url %q should have been rejected", bad)
		}
	}
}

func TestValidateGitRef(t *testing.T) {
	if _, err := ValidateGitRef("main"); err != nil {
		t.Fatalf("valid ref rejected: %v", err)
	}
	for _, bad := range []string{"--exec=rm", "a b", "a..b", "ref^", "", "with\nnewline"} {
		if _, err := ValidateGitRef(bad); err == nil {
			t.Fatalf("ref %q should have been rejected", bad)
		}
	}
}

// The shell becomes /bin/<shell> in an argv, so anything but the two constants
// has to be refused rather than passed through.
func TestValidateTaskShell(t *testing.T) {
	for raw, want := range map[string]string{"sh": "sh", "bash": "bash", " bash ": "bash", "": "sh"} {
		switch shell, err := ValidateTaskShell(raw); {
		case err != nil:
			t.Fatalf("shell %q rejected: %v", raw, err)
		case shell != want:
			t.Fatalf("shell %q became %q, want %q", raw, shell, want)
		}
	}
	for _, bad := range []string{"zsh", "sh -c", "../../usr/bin/env", "sh;id", "SH"} {
		if _, err := ValidateTaskShell(bad); err == nil {
			t.Fatalf("shell %q should have been rejected", bad)
		}
	}
}

func TestRandomTokenIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		token := RandomToken(24)
		if seen[token] {
			t.Fatal("RandomToken repeated a value")
		}
		seen[token] = true
	}
	if HashToken("a") == HashToken("b") {
		t.Fatal("token hashing collides trivially")
	}
}

// A registry host and login name are handed to `docker login` as arguments.
// There is no shell to escape, but the command reads its own flags, so a value
// starting with a dash must never get that far.
func TestValidateCommandArgRejectsOptionLookalikes(t *testing.T) {
	got, err := ValidateCommandArg("url", "  ghcr.io ")
	if err != nil {
		t.Fatalf("a plain registry host was rejected: %v", err)
	}
	if got != "ghcr.io" {
		t.Fatalf("ValidateCommandArg = %q, want ghcr.io", got)
	}
	if _, err := ValidateCommandArg("url", "registry.example.com:5000"); err != nil {
		t.Fatalf("a host with a port was rejected: %v", err)
	}
	for _, bad := range []string{"", "   ", "--config=/tmp/x", "-v", "ghcr.io extra", "gh\tcr.io", "ghcr.io\n--help"} {
		if _, err := ValidateCommandArg("url", bad); err == nil {
			t.Fatalf("value %q should have been rejected", bad)
		}
	}
}

func TestValidateRedirect(t *testing.T) {
	got, err := ValidateRedirect(`^https?://(?:www\.)?(.+)`, "https://www.${1}")
	if err != nil || got != "https://www.$1" {
		t.Fatalf("www preset: got %q, %v", got, err)
	}
	for _, bad := range [][2]string{
		{`^http://(.*)"; }`, "https://$1"},
		{"^(.*)\n", "https://$1"},
		{`^(.*)\`, "https://$1"},
		{`^(.*)\n`, "https://$1"},
		{`^(.*`, "https://$1"},
		{`^(.*)`, "https://$host$1"},
		{`^(.*)`, `https://\$1`},
		{"", "https://x"},
	} {
		if _, err := ValidateRedirect(bad[0], bad[1]); err == nil {
			t.Errorf("accepted regex %q replacement %q", bad[0], bad[1])
		}
	}
}

func TestValidateBasicAuthAndPorts(t *testing.T) {
	if err := ValidateBasicAuthUser("admin", `p"a:ss`); err != nil {
		t.Fatalf("password is hashed, any character goes: %v", err)
	}
	for _, name := range []string{"", "a:b", "a\nb"} {
		if ValidateBasicAuthUser(name, "pw") == nil {
			t.Errorf("accepted username %q", name)
		}
	}
	if err := ValidatePublishedPort(8080, 80, "tcp"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct {
		published, target int
		protocol          string
	}{{443, 443, "tcp"}, {0, 80, "tcp"}, {8080, 70000, "tcp"}, {8080, 80, "sctp"}} {
		if ValidatePublishedPort(p.published, p.target, p.protocol) == nil {
			t.Errorf("accepted %v", p)
		}
	}
}
