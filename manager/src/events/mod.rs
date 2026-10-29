//! The in-process pub/sub that backs every SSE stream (deployment logs, system
//! events, reconciler activity), and the Docker event reconciler.

mod reconciler;

pub use reconciler::Reconciler;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

/// One message delivered to subscribers of a topic.
#[derive(Clone, Debug, Serialize)]
pub struct Event {
	#[serde(skip)]
	pub topic: String,
	#[serde(rename = "type")]
	pub kind: String,
	pub data: Value,
}

/// Fans messages out to per-subscriber buffered channels. A slow consumer drops
/// messages instead of blocking the publisher: a stalled browser must never
/// stall a deployment.
#[derive(Default)]
pub struct Bus {
	inner: Mutex<Subscribers>,
}

#[derive(Default)]
struct Subscribers {
	topics: HashMap<String, HashMap<u64, mpsc::Sender<Event>>>,
	next: u64,
}

/// A live subscription; dropping it releases the slot.
pub struct Subscription {
	pub events: mpsc::Receiver<Event>,
	bus: Arc<Bus>,
	topic: String,
	id: u64,
}

impl Drop for Subscription {
	fn drop(&mut self) {
		let mut inner = self.bus.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		if let Some(subs) = inner.topics.get_mut(&self.topic) {
			subs.remove(&self.id);
			if subs.is_empty() {
				inner.topics.remove(&self.topic);
			}
		}
	}
}

impl Bus {
	pub fn new() -> Arc<Bus> {
		Arc::new(Bus::default())
	}

	pub fn subscribe(self: &Arc<Bus>, topic: &str) -> Subscription {
		let (tx, rx) = mpsc::channel(256);
		let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let id = inner.next;
		inner.next += 1;
		inner.topics.entry(topic.to_string()).or_default().insert(id, tx);
		Subscription { events: rx, bus: self.clone(), topic: topic.to_string(), id }
	}

	/// Delivers to every current subscriber of the topic.
	pub fn publish(&self, topic: &str, kind: &str, data: impl Serialize) {
		let data = serde_json::to_value(data).unwrap_or(Value::Null);
		let inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		if let Some(subs) = inner.topics.get(topic) {
			for tx in subs.values() {
				let _ = tx.try_send(Event { topic: topic.to_string(), kind: kind.to_string(), data: data.clone() });
			}
		}
	}
}

pub const TOPIC_SYSTEM: &str = "system";

/// The per-deployment log stream.
pub fn deployment_topic(deployment_id: &str) -> String {
	format!("deployment:{deployment_id}")
}
