package events

import (
	"context"
	"log/slog"
	"time"

	dockerevents "github.com/docker/docker/api/types/events"

	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/domains"
)

// Reconciler keeps the running infrastructure in sync with the database.
//
// It reacts to Docker events (a recreated container loses its proxy network
// attachment) and additionally sweeps on a timer, so a missed event self-heals.
type Reconciler struct {
	docker  *docker.Client
	domains *domains.Service
	bus     *Bus
	log     *slog.Logger

	// debounce collapses a burst of events from one `compose up` into a single
	// reconcile pass.
	debounce time.Duration
	sweep    time.Duration
}

func NewReconciler(dockerClient *docker.Client, domainSvc *domains.Service, bus *Bus, log *slog.Logger) *Reconciler {
	return &Reconciler{
		docker:   dockerClient,
		domains:  domainSvc,
		bus:      bus,
		log:      log,
		debounce: 2 * time.Second,
		sweep:    2 * time.Minute,
	}
}

// Run blocks until ctx is cancelled.
func (r *Reconciler) Run(ctx context.Context) {
	trigger := make(chan struct{}, 1)
	go r.watchDocker(ctx, trigger)
	go r.tick(ctx, trigger)

	var timer *time.Timer
	var fire <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-trigger:
			if timer == nil {
				timer = time.NewTimer(r.debounce)
				fire = timer.C
			} else {
				timer.Reset(r.debounce)
			}
		case <-fire:
			timer, fire = nil, nil
			if err := r.domains.Reconcile(ctx); err != nil {
				r.log.Error("reconcile failed", "error", err)
			}
		}
	}
}

func (r *Reconciler) watchDocker(ctx context.Context, trigger chan<- struct{}) {
	for ctx.Err() == nil {
		r.consume(ctx, trigger)
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

// consume drains one event subscription; it returns when the stream breaks so
// the caller can resubscribe.
func (r *Reconciler) consume(ctx context.Context, trigger chan<- struct{}) {
	messages, errs := r.docker.Events(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-messages:
			r.handle(msg, trigger)
		case err := <-errs:
			if ctx.Err() == nil {
				r.log.Warn("docker event stream ended, reconnecting", "error", err)
			}
			return
		}
	}
}

// handle forwards interesting events to the UI and schedules a reconcile.
func (r *Reconciler) handle(msg dockerevents.Message, trigger chan<- struct{}) {
	switch msg.Type {
	case dockerevents.ContainerEventType:
		switch msg.Action {
		case "start", "die", "stop", "destroy", "health_status: healthy", "health_status: unhealthy":
			r.bus.Publish(TopicSystem, "container."+string(msg.Action), map[string]string{
				"id":      msg.Actor.ID,
				"name":    msg.Actor.Attributes["name"],
				"service": msg.Actor.Attributes["com.docker.compose.service"],
				"project": msg.Actor.Attributes["com.docker.compose.project"],
			})
			notify(trigger)
		}
	case dockerevents.NetworkEventType:
		if msg.Action == "connect" || msg.Action == "disconnect" {
			notify(trigger)
		}
	}
}

func (r *Reconciler) tick(ctx context.Context, trigger chan<- struct{}) {
	ticker := time.NewTicker(r.sweep)
	defer ticker.Stop()
	notify(trigger)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			notify(trigger)
		}
	}
}

func notify(trigger chan<- struct{}) {
	select {
	case trigger <- struct{}{}:
	default:
	}
}
