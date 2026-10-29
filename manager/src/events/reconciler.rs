use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bollard::models::{EventMessage, EventMessageTypeEnum};
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep, sleep_until};

use super::{Bus, TOPIC_SYSTEM};
use crate::docker::Docker;
use crate::domains::Domains;

/// Keeps the running infrastructure in sync with the database. It reacts to
/// Docker events (a recreated container loses its proxy network attachment)
/// and sweeps on a timer, so a missed event self-heals.
pub struct Reconciler {
	docker: Arc<Docker>,
	domains: Arc<Domains>,
	bus: Arc<Bus>,
}

// Collapses a burst of events from one `compose up` into a single pass.
const DEBOUNCE: Duration = Duration::from_secs(2);
const SWEEP: Duration = Duration::from_secs(120);

impl Reconciler {
	pub fn new(docker: Arc<Docker>, domains: Arc<Domains>, bus: Arc<Bus>) -> Reconciler {
		Reconciler { docker, domains, bus }
	}

	/// Runs until the process stops.
	pub async fn run(self) {
		let (trigger, mut triggered) = mpsc::channel::<()>(1);
		tokio::spawn(watch_docker(self.docker.clone(), self.bus.clone(), trigger.clone()));
		tokio::spawn(tick(trigger));

		let mut fire: Option<Instant> = None;
		loop {
			let deadline = fire;
			tokio::select! {
				Some(()) = triggered.recv() => fire = Some(Instant::now() + DEBOUNCE),
				() = async { sleep_until(deadline.expect("guarded")).await }, if deadline.is_some() => {
					fire = None;
					if let Err(err) = self.domains.reconcile().await {
						tracing::error!(component = "reconciler", error = %format!("{err:#}"), "reconcile failed");
					}
				}
			}
		}
	}
}

async fn watch_docker(docker: Arc<Docker>, bus: Arc<Bus>, trigger: mpsc::Sender<()>) {
	loop {
		// Drains one subscription; returns when the stream breaks so this resubscribes.
		let mut events = docker.events();
		while let Some(message) = events.next().await {
			match message {
				Ok(message) => handle(&bus, &message, &trigger),
				Err(err) => {
					tracing::warn!(component = "reconciler", error = %err, "docker event stream ended, reconnecting");
					break;
				}
			}
		}
		sleep(Duration::from_secs(3)).await;
	}
}

/// Forwards interesting events to the UI and schedules a reconcile.
fn handle(bus: &Bus, message: &EventMessage, trigger: &mpsc::Sender<()>) {
	let action = message.action.as_deref().unwrap_or("");
	match message.typ {
		Some(EventMessageTypeEnum::CONTAINER) => {
			if matches!(action, "start" | "die" | "stop" | "destroy" | "health_status: healthy" | "health_status: unhealthy") {
				let actor = message.actor.clone().unwrap_or_default();
				let attributes = actor.attributes.unwrap_or_default();
				let attribute = |key: &str| attributes.get(key).cloned().unwrap_or_default();
				let data: HashMap<&str, String> = HashMap::from([
					("id", actor.id.unwrap_or_default()),
					("name", attribute("name")),
					("service", attribute("com.docker.compose.service")),
					("project", attribute("com.docker.compose.project")),
				]);
				bus.publish(TOPIC_SYSTEM, &format!("container.{action}"), data);
				let _ = trigger.try_send(());
			}
		}
		Some(EventMessageTypeEnum::NETWORK) if action == "connect" || action == "disconnect" => {
			let _ = trigger.try_send(());
		}
		_ => {}
	}
}

async fn tick(trigger: mpsc::Sender<()>) {
	let mut ticker = tokio::time::interval(SWEEP);
	loop {
		// The first tick completes at once: one pass on boot.
		ticker.tick().await;
		let _ = trigger.try_send(());
	}
}
