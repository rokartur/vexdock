// Package certificates issues and renews Let's Encrypt certificates over the
// HTTP-01 challenge, using the same Nginx that fronts every application.
package certificates

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/crypto/acme"
)

// Issuer writes certificates to <certificatesDir>/<hostname>/ and challenge
// tokens to <challengeDir>/.well-known/acme-challenge/.
type Issuer struct {
	certificatesDir string
	challengeDir    string
	directoryURL    string
	email           string
}

func NewIssuer(certificatesDir, challengeDir, directoryURL, email string) *Issuer {
	return &Issuer{
		certificatesDir: certificatesDir,
		challengeDir:    challengeDir,
		directoryURL:    directoryURL,
		email:           email,
	}
}

// Result describes an issued certificate.
type Result struct {
	Hostname  string
	Issuer    string
	NotBefore time.Time
	NotAfter  time.Time
}

// Dir is where Nginx reads fullchain.pem/privkey.pem for a hostname.
func (i *Issuer) Dir(hostname string) string { return filepath.Join(i.certificatesDir, hostname) }

// Exists reports whether a usable certificate is already on disk.
func (i *Issuer) Exists(hostname string) bool {
	for _, f := range []string{"fullchain.pem", "privkey.pem"} {
		if _, err := os.Stat(filepath.Join(i.Dir(hostname), f)); err != nil {
			return false
		}
	}
	return true
}

// Expiry reads NotAfter from the stored certificate.
func (i *Issuer) Expiry(hostname string) (time.Time, error) {
	raw, err := os.ReadFile(filepath.Join(i.Dir(hostname), "fullchain.pem"))
	if err != nil {
		return time.Time{}, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return time.Time{}, errors.New("stored certificate is not valid PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return time.Time{}, err
	}
	return cert.NotAfter, nil
}

// Issue runs a complete HTTP-01 order for one hostname. reload is invoked after
// the challenge file is written so a brand-new vhost can serve it.
func (i *Issuer) Issue(ctx context.Context, hostname string) (*Result, error) {
	accountKey, err := i.accountKey()
	if err != nil {
		return nil, err
	}
	client := &acme.Client{Key: accountKey, DirectoryURL: i.directoryURL}

	contact := []string{}
	if i.email != "" {
		contact = append(contact, "mailto:"+i.email)
	}
	if _, err := client.Register(ctx, &acme.Account{Contact: contact}, acme.AcceptTOS); err != nil &&
		!errors.Is(err, acme.ErrAccountAlreadyExists) {
		return nil, fmt.Errorf("acme register: %w", err)
	}

	order, err := client.AuthorizeOrder(ctx, acme.DomainIDs(hostname))
	if err != nil {
		return nil, fmt.Errorf("acme order: %w", err)
	}

	for _, authzURL := range order.AuthzURLs {
		if err := i.solve(ctx, client, authzURL); err != nil {
			return nil, err
		}
	}

	order, err = client.WaitOrder(ctx, order.URI)
	if err != nil {
		return nil, fmt.Errorf("acme order not ready: %w", err)
	}

	certKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: hostname},
		DNSNames: []string{hostname},
	}, certKey)
	if err != nil {
		return nil, err
	}
	chain, _, err := client.CreateOrderCert(ctx, order.FinalizeURL, csr, true)
	if err != nil {
		return nil, fmt.Errorf("acme finalize: %w", err)
	}
	return i.store(hostname, chain, certKey)
}

func (i *Issuer) solve(ctx context.Context, client *acme.Client, authzURL string) error {
	authz, err := client.GetAuthorization(ctx, authzURL)
	if err != nil {
		return fmt.Errorf("acme authorization: %w", err)
	}
	if authz.Status == acme.StatusValid {
		return nil
	}
	var challenge *acme.Challenge
	for _, c := range authz.Challenges {
		if c.Type == "http-01" {
			challenge = c
			break
		}
	}
	if challenge == nil {
		return errors.New("no http-01 challenge offered for this domain")
	}
	body, err := client.HTTP01ChallengeResponse(challenge.Token)
	if err != nil {
		return err
	}
	tokenPath := filepath.Join(i.challengeDir, ".well-known", "acme-challenge", challenge.Token)
	if err := os.MkdirAll(filepath.Dir(tokenPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tokenPath, []byte(body), 0o644); err != nil {
		return err
	}
	defer os.Remove(tokenPath)

	if _, err := client.Accept(ctx, challenge); err != nil {
		return fmt.Errorf("acme accept challenge: %w", err)
	}
	if _, err := client.WaitAuthorization(ctx, authz.URI); err != nil {
		return fmt.Errorf("domain validation failed (is %s pointing at this server?): %w", authz.Identifier.Value, err)
	}
	return nil
}

// store writes the chain and key atomically; Nginx only ever sees a complete pair.
func (i *Issuer) store(hostname string, chain [][]byte, key *ecdsa.PrivateKey) (*Result, error) {
	dir := i.Dir(hostname)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	var fullchain []byte
	for _, der := range chain {
		fullchain = append(fullchain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := writeAtomic(filepath.Join(dir, "fullchain.pem"), fullchain, 0o644); err != nil {
		return nil, err
	}
	if err := writeAtomic(filepath.Join(dir, "privkey.pem"), keyPEM, 0o600); err != nil {
		return nil, err
	}

	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return nil, err
	}
	return &Result{
		Hostname:  hostname,
		Issuer:    leaf.Issuer.CommonName,
		NotBefore: leaf.NotBefore,
		NotAfter:  leaf.NotAfter,
	}, nil
}

// accountKey loads (or creates) the ACME account key shared by all domains.
func (i *Issuer) accountKey() (*ecdsa.PrivateKey, error) {
	path := filepath.Join(i.certificatesDir, "account.key")
	raw, err := os.ReadFile(path)
	if err == nil {
		block, _ := pem.Decode(raw)
		if block == nil {
			return nil, errors.New("acme account key is not valid PEM")
		}
		return x509.ParseECPrivateKey(block.Bytes)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(i.certificatesDir, 0o755); err != nil {
		return nil, err
	}
	if err := writeAtomic(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func writeAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
