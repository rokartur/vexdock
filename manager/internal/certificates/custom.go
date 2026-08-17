package certificates

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Validate checks that a user-supplied certificate and key belong together and
// actually cover the hostname, before anything touches disk. Nginx would refuse
// to start on a mismatch, so this is the difference between a clear error in
// the form and a proxy that will not reload.
func Validate(hostname, certPEM, keyPEM string) (*Result, error) {
	certPEM = strings.TrimSpace(certPEM)
	keyPEM = strings.TrimSpace(keyPEM)
	if certPEM == "" {
		return nil, errors.New("the certificate is required")
	}
	if keyPEM == "" {
		return nil, errors.New("the private key is required")
	}

	// X509KeyPair parses both and verifies the key matches the certificate.
	pair, err := tls.X509KeyPair([]byte(certPEM+"\n"), []byte(keyPEM+"\n"))
	if err != nil {
		return nil, fmt.Errorf("certificate and key do not form a valid pair: %w", err)
	}
	if len(pair.Certificate) == 0 {
		return nil, errors.New("the certificate contains no PEM certificate block")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	if err := leaf.VerifyHostname(hostname); err != nil {
		return nil, fmt.Errorf("this certificate is not valid for %s: %w", hostname, err)
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) {
		return nil, fmt.Errorf("this certificate is not valid until %s", leaf.NotBefore.UTC().Format(time.RFC3339))
	}
	if now.After(leaf.NotAfter) {
		return nil, fmt.Errorf("this certificate expired on %s", leaf.NotAfter.UTC().Format(time.RFC3339))
	}

	return &Result{
		Hostname:  hostname,
		Issuer:    issuerName(leaf),
		NotBefore: leaf.NotBefore,
		NotAfter:  leaf.NotAfter,
	}, nil
}

// InstallCustom validates a user-supplied pair and writes it where Nginx reads
// certificates, replacing whatever was there before.
func (i *Issuer) InstallCustom(hostname, certPEM, keyPEM string) (*Result, error) {
	result, err := Validate(hostname, certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	dir := i.Dir(hostname)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := writeAtomic(filepath.Join(dir, "fullchain.pem"), []byte(strings.TrimSpace(certPEM)+"\n"), 0o644); err != nil {
		return nil, err
	}
	if err := writeAtomic(filepath.Join(dir, "privkey.pem"), []byte(strings.TrimSpace(keyPEM)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return result, nil
}

// Remove deletes the stored certificate for a hostname, used when a domain
// switches issuance source so a stale file cannot be served.
func (i *Issuer) Remove(hostname string) error {
	err := os.RemoveAll(i.Dir(hostname))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func issuerName(leaf *x509.Certificate) string {
	if leaf.Issuer.CommonName != "" {
		return leaf.Issuer.CommonName
	}
	if len(leaf.Issuer.Organization) > 0 {
		return leaf.Issuer.Organization[0]
	}
	if leaf.Issuer.String() != "" {
		return leaf.Issuer.String()
	}
	return "unknown"
}
