package git

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
)

// The RS256 JWT is signed by hand rather than by a library, so this is the check
// that the token GitHub receives is actually a token GitHub accepts: three
// segments, the header and claims it expects, and a signature that verifies
// against the App's public key.
func TestAppJWTIsSignedRS256(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	token, err := appJWT("12345", string(pemKey))
	if err != nil {
		t.Fatalf("appJWT: %v", err)
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("want three segments, got %d", len(parts))
	}

	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decode header: %v", err)
	}
	if string(header) != `{"alg":"RS256","typ":"JWT"}` {
		t.Fatalf("header is %s", header)
	}

	var claims struct {
		Iat int64  `json:"iat"`
		Exp int64  `json:"exp"`
		Iss string `json:"iss"`
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode claims: %v", err)
	}
	if err := json.Unmarshal(body, &claims); err != nil {
		t.Fatalf("claims: %v", err)
	}
	if claims.Iss != "12345" {
		t.Fatalf("iss is %q", claims.Iss)
	}
	if claims.Exp-claims.Iat > 600 {
		t.Fatalf("token lives %ds, GitHub caps it at 600", claims.Exp-claims.Iat)
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
		t.Fatalf("signature does not verify: %v", err)
	}
}

// A push that starts a deployment is only as trustworthy as this comparison.
func TestWebhookSignature(t *testing.T) {
	body := []byte(`{"ref":"refs/heads/main"}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !VerifyWebhookSignature("secret", body, signature) {
		t.Fatal("a genuine delivery was rejected")
	}
	if VerifyWebhookSignature("secret", append(body, ' '), signature) {
		t.Fatal("a tampered body verified")
	}
	if VerifyWebhookSignature("other", body, signature) {
		t.Fatal("another App's secret verified")
	}
	if VerifyWebhookSignature("", body, "") {
		t.Fatal("an unsigned delivery verified")
	}
}
