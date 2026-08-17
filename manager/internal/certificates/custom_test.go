package certificates

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// issued builds a leaf signed by a throwaway CA, which is the shape a user
// actually pastes in. The tests therefore need no fixture files.
func issued(t *testing.T, hostname string, notBefore, notAfter time.Time) (certPEM, keyPEM string) {
	t.Helper()

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ca key: %v", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Issuing CA"},
		NotBefore:             notBefore.Add(-time.Hour),
		NotAfter:              notAfter.Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create ca: %v", err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("parse ca: %v", err)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: hostname},
		DNSNames:     []string{hostname},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	// A real upload is the leaf followed by its chain.
	chain := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})) +
		string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
	return chain, string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
}

func TestValidateAcceptsMatchingPair(t *testing.T) {
	certPEM, keyPEM := issued(t, "app.example.com", time.Now().Add(-time.Hour), time.Now().Add(90*24*time.Hour))
	result, err := Validate("app.example.com", certPEM, keyPEM)
	if err != nil {
		t.Fatalf("valid pair rejected: %v", err)
	}
	if result.Hostname != "app.example.com" {
		t.Fatalf("unexpected hostname %q", result.Hostname)
	}
	if result.Issuer != "Test Issuing CA" {
		t.Fatalf("unexpected issuer %q", result.Issuer)
	}
	if result.NotAfter.Before(time.Now()) {
		t.Fatal("expiry was not read from the certificate")
	}
}

// Nginx refuses to start on any of these, so they must fail in the form.
func TestValidateRejectsBadInput(t *testing.T) {
	certPEM, keyPEM := issued(t, "app.example.com", time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))
	_, otherKey := issued(t, "app.example.com", time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))
	expiredCert, expiredKey := issued(t, "app.example.com", time.Now().Add(-48*time.Hour), time.Now().Add(-time.Hour))
	futureCert, futureKey := issued(t, "app.example.com", time.Now().Add(24*time.Hour), time.Now().Add(48*time.Hour))

	cases := []struct {
		name     string
		hostname string
		cert     string
		key      string
		wants    string
	}{
		{"empty certificate", "app.example.com", "", keyPEM, "certificate is required"},
		{"empty key", "app.example.com", certPEM, "", "private key is required"},
		{"garbage certificate", "app.example.com", "not a pem block", keyPEM, "valid pair"},
		{"key belongs to another certificate", "app.example.com", certPEM, otherKey, "valid pair"},
		{"wrong hostname", "other.example.com", certPEM, keyPEM, "not valid for other.example.com"},
		{"expired", "app.example.com", expiredCert, expiredKey, "expired"},
		{"not yet valid", "app.example.com", futureCert, futureKey, "not valid until"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Validate(tc.hostname, tc.cert, tc.key)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("error %q does not mention %q", err, tc.wants)
			}
		})
	}
}

func TestInstallCustomWritesWhereNginxReads(t *testing.T) {
	dir := t.TempDir()
	issuer := NewIssuer(dir, filepath.Join(dir, "challenge"), "", "")
	certPEM, keyPEM := issued(t, "app.example.com", time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))

	if _, err := issuer.InstallCustom("app.example.com", certPEM, keyPEM); err != nil {
		t.Fatalf("install: %v", err)
	}
	if !issuer.Exists("app.example.com") {
		t.Fatal("the proxy would not find the installed certificate")
	}
	expiry, err := issuer.Expiry("app.example.com")
	if err != nil {
		t.Fatalf("expiry: %v", err)
	}
	if time.Until(expiry) <= 0 {
		t.Fatal("stored certificate reads as already expired")
	}
	// The private key must not be world readable.
	info, err := os.Stat(filepath.Join(issuer.Dir("app.example.com"), "privkey.pem"))
	if err != nil {
		t.Fatalf("stat key: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("private key permissions are %o, want 600", perm)
	}

	// An invalid replacement must not destroy the working certificate.
	if _, err := issuer.InstallCustom("app.example.com", "broken", keyPEM); err == nil {
		t.Fatal("expected the invalid replacement to be rejected")
	}
	if !issuer.Exists("app.example.com") {
		t.Fatal("a rejected upload removed the previous certificate")
	}

	if err := issuer.Remove("app.example.com"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if issuer.Exists("app.example.com") {
		t.Fatal("Remove left the certificate in place")
	}
	// Removing again is not an error.
	if err := issuer.Remove("app.example.com"); err != nil {
		t.Fatalf("second remove: %v", err)
	}
}
