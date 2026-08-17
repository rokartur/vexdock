package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
)

// hmacHex reproduces the signature GitHub sends, independently of the
// implementation under test.
func hmacHex(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

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
		t.Fatalf("hostname not normalised: %q", got)
	}
	for _, bad := range []string{"", "localhost", "*.example.com", "-bad.example.com", "ex ample.com", "a..b.com"} {
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

func TestVerifyGitHubSignature(t *testing.T) {
	body := []byte(`{"ref":"refs/heads/main"}`)
	const secret = "s3cret"
	// Signature produced by GitHub for this body and secret.
	mac := "sha256=" + hmacHex(secret, body)
	if !VerifyGitHubSignature(secret, body, mac) {
		t.Fatal("valid signature rejected")
	}
	if VerifyGitHubSignature(secret, body, "sha256=deadbeef") {
		t.Fatal("forged signature accepted")
	}
	if VerifyGitHubSignature(secret, []byte(`{"ref":"refs/heads/evil"}`), mac) {
		t.Fatal("signature accepted for a different body")
	}
	if VerifyGitHubSignature("", body, mac) {
		t.Fatal("empty secret must never validate")
	}
	if VerifyGitHubSignature(secret, body, "") {
		t.Fatal("missing header must never validate")
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
