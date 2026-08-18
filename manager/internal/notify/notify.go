// Package notify posts deployment outcomes to one outgoing webhook so an
// operator learns about a failed deploy without watching the dashboard.
//
// One URL, no per-provider plugin surface: Discord and Slack get the body
// shape they require, everything else gets the raw event as JSON.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/events"
)

// SettingWebhookURL is the system_settings key holding the target URL.
// An empty value disables notifications.
const SettingWebhookURL = "notify_webhook_url"

// Notifier watches the system topic and forwards finished deployments.
type Notifier struct {
	db     *database.DB
	bus    *events.Bus
	log    *slog.Logger
	client *http.Client
}

func New(db *database.DB, bus *events.Bus, log *slog.Logger) *Notifier {
	return &Notifier{
		db:     db,
		bus:    bus,
		log:    log,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// ValidateURL rejects anything the sender would not be able to post to.
// Callers use it to fail a settings save instead of a later silent no-op.
func ValidateURL(raw string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid webhook url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("webhook url must be http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("webhook url must include a host")
	}
	return nil
}

// Run consumes system events until ctx is cancelled.
func (n *Notifier) Run(ctx context.Context) {
	ch, cancel := n.bus.Subscribe(events.TopicSystem)
	defer cancel()

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			n.handle(ctx, ev)
		}
	}
}

func (n *Notifier) handle(ctx context.Context, ev events.Event) {
	if ev.Type != "deployment.success" && ev.Type != "deployment.failed" {
		return
	}
	d, ok := ev.Data.(*database.Deployment)
	if !ok {
		return
	}
	target, err := n.db.Setting(ctx, SettingWebhookURL)
	if err != nil || target == "" {
		return
	}

	project := d.ProjectID
	if p, err := n.db.ProjectByID(ctx, d.ProjectID); err == nil && p != nil {
		project = p.Name
	}
	if err := n.post(ctx, target, message(project, d), d); err != nil {
		n.log.Warn("notification failed", "deployment", d.ID, "error", err)
	}
}

func message(project string, d *database.Deployment) string {
	verb := "succeeded"
	if d.Status == database.DeploymentFailed {
		verb = "failed"
	}
	text := fmt.Sprintf("Deployment #%d of %s %s", d.Number, project, verb)
	if d.Branch != "" {
		text += " on " + d.Branch
	}
	if d.Error != "" {
		text += ": " + d.Error
	}
	return text
}

// body shapes the payload for the few chat services that demand a specific
// key, and passes the whole event through for generic receivers.
func body(target, text string, d *database.Deployment) any {
	host := ""
	if u, err := url.Parse(target); err == nil {
		host = strings.ToLower(u.Host)
	}
	switch {
	case strings.HasSuffix(host, "discord.com"), strings.HasSuffix(host, "discordapp.com"):
		return map[string]string{"content": text}
	case strings.HasSuffix(host, "slack.com"):
		return map[string]string{"text": text}
	default:
		return map[string]any{"text": text, "deployment": d}
	}
}

func (n *Notifier) post(ctx context.Context, target, text string, d *database.Deployment) error {
	payload, err := json.Marshal(body(target, text, d))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook responded %s", resp.Status)
	}
	return nil
}
