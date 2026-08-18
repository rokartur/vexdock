package certificates

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
)

const cloudflareAPI = "https://api.cloudflare.com/client/v4"

// SettingCloudflareToken is the system_settings key holding the encrypted
// Cloudflare API token. An empty value means HTTP-01.
const SettingCloudflareToken = "cloudflare_api_token"

// propagationTimeout bounds the wait for a freshly written TXT record to become
// visible. Cloudflare usually publishes within seconds; anything slower is a
// misconfigured zone rather than propagation.
const propagationTimeout = 2 * time.Minute

// SetCloudflareToken switches the issuer to the DNS-01 challenge. An empty
// token restores HTTP-01. Safe to call while a renewal is running.
func (i *Issuer) SetCloudflareToken(token string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.cloudflareToken = token
}

// DNS01Enabled reports whether wildcard hostnames can be issued.
func (i *Issuer) DNS01Enabled() bool {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.cloudflareToken != ""
}

func (i *Issuer) token() string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.cloudflareToken
}

// solveDNS01 publishes the challenge TXT record, waits for it to be visible and
// removes it again. It is the only path that can answer a wildcard order.
func (i *Issuer) solveDNS01(ctx context.Context, client *acme.Client, authz *acme.Authorization,
	challenge *acme.Challenge) error {
	value, err := client.DNS01ChallengeRecord(challenge.Token)
	if err != nil {
		return err
	}
	// For a wildcard order the identifier is already the bare domain, which is
	// exactly the name _acme-challenge hangs off.
	domain := strings.TrimPrefix(authz.Identifier.Value, "*.")
	record := "_acme-challenge." + domain

	cf := &cloudflare{token: i.token(), client: &http.Client{Timeout: 30 * time.Second}}
	zoneID, err := cf.zoneID(ctx, domain)
	if err != nil {
		return err
	}
	recordID, err := cf.createTXT(ctx, zoneID, record, value)
	if err != nil {
		return err
	}
	defer func() {
		// Cleanup must survive a cancelled order, otherwise stale challenge
		// records pile up in the zone.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := cf.deleteRecord(cleanupCtx, zoneID, recordID); err != nil {
			slog.Warn("could not remove acme challenge record", "record", record, "error", err)
		}
	}()

	if err := waitForTXT(ctx, record, value); err != nil {
		return err
	}
	if _, err := client.Accept(ctx, challenge); err != nil {
		return fmt.Errorf("acme accept challenge: %w", err)
	}
	if _, err := client.WaitAuthorization(ctx, authz.URI); err != nil {
		return fmt.Errorf("domain validation failed for %s: %w", authz.Identifier.Value, err)
	}
	return nil
}

// waitForTXT polls a public resolver until the record is visible. Let's Encrypt
// queries the authoritative servers, so waiting for a real answer here is a far
// better signal than trusting that the API write took effect.
//
// ponytail: 1.1.1.1 is hardcoded because it is Cloudflare's own resolver and
// therefore sees the zone first. Make it configurable only if a host turns out
// to block outbound DNS to it.
func waitForTXT(ctx context.Context, record, value string) error {
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, "1.1.1.1:53")
		},
	}
	deadline := time.Now().Add(propagationTimeout)
	for {
		if values, err := resolver.LookupTXT(ctx, record); err == nil && slices.Contains(values, value) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s did not become visible within %s", record, propagationTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

// cloudflare is the single supported DNS-01 provider. It needs an API token
// scoped to Zone:Read and DNS:Edit. Other providers are deliberately absent:
// one covers the wildcard case for most self-hosters without a plugin surface.
type cloudflare struct {
	token   string
	client  *http.Client
	baseURL string // empty means the real API; tests point it at a stub
}

// zoneID walks up the labels of name because the zone may be example.com while
// the record lives under a.b.example.com.
func (c *cloudflare) zoneID(ctx context.Context, name string) (string, error) {
	labels := strings.Split(strings.TrimSuffix(name, "."), ".")
	for i := 0; i+1 < len(labels); i++ {
		candidate := strings.Join(labels[i:], ".")
		raw, err := c.do(ctx, http.MethodGet, "/zones?name="+url.QueryEscape(candidate), nil)
		if err != nil {
			return "", err
		}
		var zones []struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &zones); err != nil {
			return "", fmt.Errorf("cloudflare zone list: %w", err)
		}
		if len(zones) > 0 {
			return zones[0].ID, nil
		}
	}
	return "", fmt.Errorf("no Cloudflare zone found for %s (is the token scoped to this zone?)", name)
}

func (c *cloudflare) createTXT(ctx context.Context, zoneID, name, value string) (string, error) {
	raw, err := c.do(ctx, http.MethodPost, "/zones/"+zoneID+"/dns_records", map[string]any{
		"type":    "TXT",
		"name":    name,
		"content": value,
		"ttl":     60,
	})
	if err != nil {
		return "", err
	}
	var record struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return "", fmt.Errorf("cloudflare record create: %w", err)
	}
	return record.ID, nil
}

func (c *cloudflare) deleteRecord(ctx context.Context, zoneID, recordID string) error {
	_, err := c.do(ctx, http.MethodDelete, "/zones/"+zoneID+"/dns_records/"+recordID, nil)
	return err
}

func (c *cloudflare) do(ctx context.Context, method, path string, in any) (json.RawMessage, error) {
	var payload []byte
	if in != nil {
		var err error
		if payload, err = json.Marshal(in); err != nil {
			return nil, err
		}
	}
	base := c.baseURL
	if base == "" {
		base = cloudflareAPI
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare api: %w", err)
	}
	defer resp.Body.Close()

	var envelope struct {
		Success bool `json:"success"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("cloudflare api returned %s", resp.Status)
	}
	if !envelope.Success {
		messages := make([]string, 0, len(envelope.Errors))
		for _, e := range envelope.Errors {
			messages = append(messages, e.Message)
		}
		if len(messages) == 0 {
			messages = append(messages, resp.Status)
		}
		return nil, fmt.Errorf("cloudflare api: %s", strings.Join(messages, "; "))
	}
	return envelope.Result, nil
}
