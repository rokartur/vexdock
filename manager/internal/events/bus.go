// Package events is the in-process pub/sub that backs every SSE stream:
// deployment logs, system events and reconciler activity.
package events

import (
	"sync"
)

// Event is one message delivered to subscribers of a topic.
type Event struct {
	Topic string `json:"-"`
	Type  string `json:"type"`
	Data  any    `json:"data"`
}

// Bus fans messages out to per-subscriber buffered channels. A slow consumer
// drops messages instead of blocking the publisher, because a stalled browser
// must never stall a deployment.
type Bus struct {
	mu   sync.RWMutex
	subs map[string]map[int]chan Event
	next int
}

func NewBus() *Bus {
	return &Bus{subs: map[string]map[int]chan Event{}}
}

// Subscribe returns a channel and the function that releases it.
func (b *Bus) Subscribe(topic string) (<-chan Event, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subs[topic] == nil {
		b.subs[topic] = map[int]chan Event{}
	}
	id := b.next
	b.next++
	ch := make(chan Event, 256)
	b.subs[topic][id] = ch
	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if subs, ok := b.subs[topic]; ok {
			if c, ok := subs[id]; ok {
				delete(subs, id)
				close(c)
			}
			if len(subs) == 0 {
				delete(b.subs, topic)
			}
		}
	}
}

// Publish delivers to every current subscriber of the topic.
func (b *Bus) Publish(topic, eventType string, data any) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.subs[topic] {
		select {
		case ch <- Event{Topic: topic, Type: eventType, Data: data}:
		default:
		}
	}
}

// Topics used across the manager.
const (
	TopicSystem = "system"
)

// DeploymentTopic is the per-deployment log stream.
func DeploymentTopic(deploymentID string) string { return "deployment:" + deploymentID }
