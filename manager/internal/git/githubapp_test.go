package git

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
)

// The JWT is the only thing GitHub accepts for minting installation tokens, and
// a token it refuses fails at deploy time rather than at connect time. So this
// verifies the signature the way GitHub would.
func TestAppJWTIsSignedAndReadable(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs1 := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	token, err := appJWT("12345", string(pkcs1))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("got %d JWT parts, want 3", len(parts))
	}

	digest := crypto.SHA256.New()
	digest.Write([]byte(parts[0] + "." + parts[1]))
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest.Sum(nil), signature); err != nil {
		t.Fatalf("github would reject this token: %v", err)
	}

	claims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Issuer string `json:"iss"`
		Issued int64  `json:"iat"`
		Expiry int64  `json:"exp"`
	}
	if err := json.Unmarshal(claims, &got); err != nil {
		t.Fatal(err)
	}
	if got.Issuer != "12345" {
		t.Errorf("issuer %q, want the app id", got.Issuer)
	}
	if got.Expiry-got.Issued > 600 {
		t.Errorf("token lives %ds, more than the ten minutes GitHub allows", got.Expiry-got.Issued)
	}
}

// A key re-saved by another tool comes back PKCS#8, which is the same RSA key
// in a different envelope.
func TestParsePrivateKeyAcceptsPKCS8(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if _, err := parsePrivateKey(string(encoded)); err != nil {
		t.Fatalf("PKCS#8 key rejected: %v", err)
	}
	if _, err := parsePrivateKey("not a key"); err == nil {
		t.Error("garbage accepted as a key")
	}
}

// The installation in a delivery is what picks the secret it is verified with,
// so a payload without one must not resolve to an account.
func TestInstallationFromWebhook(t *testing.T) {
	if got := InstallationFromWebhook([]byte(`{"installation":{"id":42},"ref":"refs/heads/main"}`)); got != "42" {
		t.Errorf("got %q, want 42", got)
	}
	for _, body := range []string{`{"ref":"refs/heads/main"}`, `not json`, ``} {
		if got := InstallationFromWebhook([]byte(body)); got != "" {
			t.Errorf("payload %q resolved to installation %q", body, got)
		}
	}
}
