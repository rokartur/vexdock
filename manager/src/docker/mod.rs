//! Wraps the Docker Engine API. Nothing in the platform parses `docker ps` or
//! `docker inspect` output: every read goes through the Engine API.

mod exec;
mod stats;
mod volumes;

pub use exec::*;
pub use stats::*;
pub use volumes::*;

use std::collections::HashMap;

use anyhow::{Context, Result, anyhow, bail};
use bollard::errors::Error as DockerError;
use bollard::models::{
	ContainerInspectResponse, ContainerSummary, EndpointSettings, EventMessage, NetworkConnectRequest, NetworkCreateRequest,
	NetworkDisconnectRequest, SystemDataUsageResponse,
};
use bollard::query_parameters::{
	DataUsageOptions, EventsOptions, InspectNetworkOptions, ListContainersOptions, ListImagesOptions, ListNetworksOptions,
	ListVolumesOptions, LogsOptions, PruneBuildOptions, RemoveContainerOptions, RemoveImageOptions, RemoveVolumeOptions,
	RestartContainerOptions, StartContainerOptions, StopContainerOptions,
};
use futures::Stream;
use serde::Serialize;

/// Marks the proxy network as the platform's own.
pub const LABEL_MANAGED: &str = "platform.managed";
// Compose sets these itself; they map containers back to projects.
pub const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";
pub const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";
pub const COMPOSE_ONEOFF_LABEL: &str = "com.docker.compose.oneoff";

pub struct Docker {
	api: bollard::Docker,
}

/// Whether the daemon answered 404.
pub fn is_not_found(err: &anyhow::Error) -> bool {
	matches!(err.downcast_ref::<DockerError>(), Some(DockerError::DockerResponseServerError { status_code: 404, .. }))
}

impl Docker {
	/// Connects the way the CLI does: DOCKER_HOST, else the local socket.
	pub fn new() -> Result<Docker> {
		Ok(Docker { api: bollard::Docker::connect_with_defaults().context("connect to docker")? })
	}

	/// A client pointed at a port nothing listens on, for tests that build
	/// services needing one but never reach the daemon.
	#[cfg(test)]
	pub fn unreachable() -> Docker {
		Docker { api: bollard::Docker::connect_with_http("http://127.0.0.1:1", 1, bollard::API_DEFAULT_VERSION).unwrap() }
	}

	pub fn api(&self) -> &bollard::Docker {
		&self.api
	}

	pub async fn ping(&self) -> Result<()> {
		self.api.ping().await?;
		Ok(())
	}

	pub async fn info(&self) -> Result<bollard::models::SystemInfo> {
		Ok(self.api.info().await?)
	}

	/// Every container, or the service containers of one compose project,
	/// leaving out `compose run` one-offs.
	pub async fn list_containers(&self, compose_project: &str) -> Result<Vec<ContainerSummary>> {
		let filters = (!compose_project.is_empty()).then(|| {
			HashMap::from([(
				"label".to_string(),
				vec![format!("{COMPOSE_PROJECT_LABEL}={compose_project}"), format!("{COMPOSE_ONEOFF_LABEL}=False")],
			)])
		});
		Ok(self.api.list_containers(Some(ListContainersOptions { all: true, filters, ..Default::default() })).await?)
	}

	/// Maps a compose service to its container id, preferring a running one
	/// over a stopped leftover.
	pub async fn service_container(&self, compose_project: &str, compose_service: &str) -> Result<String> {
		let mut stopped = None;
		for ctr in self.list_containers(compose_project).await? {
			let labels = ctr.labels.unwrap_or_default();
			if labels.get(COMPOSE_SERVICE_LABEL).map(String::as_str) != Some(compose_service) {
				continue;
			}
			if ctr.state.map(|s| s.to_string()).as_deref() == Some("running") {
				return Ok(ctr.id.unwrap_or_default());
			}
			stopped = ctr.id;
		}
		stopped.ok_or_else(|| anyhow!("this service has no container yet - deploy it first"))
	}

	pub async fn inspect(&self, id: &str) -> Result<ContainerInspectResponse> {
		Ok(self.api.inspect_container(id, None::<bollard::query_parameters::InspectContainerOptions>).await?)
	}

	pub async fn start(&self, id: &str) -> Result<()> {
		Ok(self.api.start_container(id, None::<StartContainerOptions>).await?)
	}

	pub async fn stop(&self, id: &str) -> Result<()> {
		Ok(self.api.stop_container(id, None::<StopContainerOptions>).await?)
	}

	pub async fn restart(&self, id: &str) -> Result<()> {
		Ok(self.api.restart_container(id, None::<RestartContainerOptions>).await?)
	}

	pub async fn remove(&self, id: &str, force: bool) -> Result<()> {
		Ok(self.api.remove_container(id, Some(RemoveContainerOptions { force, ..Default::default() })).await?)
	}

	/// Streams container output, already demultiplexed by the client.
	pub fn logs(
		&self,
		id: &str,
		tail: &str,
		follow: bool,
		timestamps: bool,
	) -> impl Stream<Item = Result<bollard::container::LogOutput, DockerError>> + use<> {
		self.api
			.logs(id, Some(LogsOptions { stdout: true, stderr: true, follow, timestamps, tail: tail.to_string(), ..Default::default() }))
	}

	/// The daemon event stream the reconciler consumes.
	pub fn events(&self) -> impl Stream<Item = Result<EventMessage, DockerError>> + use<> {
		self.api.events(None::<EventsOptions>)
	}

	pub async fn list_images(&self) -> Result<Vec<bollard::models::ImageSummary>> {
		Ok(self.api.list_images(Some(ListImagesOptions { all: false, ..Default::default() })).await?)
	}

	/// Pulls an image, keeping the tail of the daemon's JSON progress stream.
	pub async fn pull_image(&self, reference: &str, out: &mut TailWriter) -> Result<()> {
		use futures::StreamExt;
		let options = bollard::query_parameters::CreateImageOptions { from_image: Some(reference.to_string()), ..Default::default() };
		let mut progress = self.api.create_image(Some(options), None, None);
		while let Some(info) = progress.next().await {
			let mut line = serde_json::to_vec(&info?)?;
			line.push(b'\n');
			out.write(&line);
		}
		Ok(())
	}

	pub async fn remove_image(&self, id: &str, force: bool) -> Result<()> {
		self.api.remove_image(id, Some(RemoveImageOptions { force, noprune: false }), None).await?;
		Ok(())
	}

	pub async fn list_volumes(&self) -> Result<bollard::models::VolumeListResponse> {
		Ok(self.api.list_volumes(None::<ListVolumesOptions>).await?)
	}

	/// Volumes with their size and reference count, which only the disk-usage
	/// endpoint fills in; the volume list leaves UsageData empty.
	pub async fn volume_usage(&self) -> Result<Vec<bollard::models::Volume>> {
		// bollard 0.19 cannot URL-encode DataUsageOptions' type list ("unsupported value"), so this
		// asks for every kind. shortcut: Docker also sizes images and build cache, drop it once bollard encodes lists.
		let usage = self.api.df(None::<DataUsageOptions>).await?;
		Ok(usage.volumes.unwrap_or_default())
	}

	pub async fn remove_volume(&self, name: &str, force: bool) -> Result<()> {
		Ok(self.api.remove_volume(name, Some(RemoveVolumeOptions { force })).await?)
	}

	pub async fn list_networks(&self) -> Result<Vec<bollard::models::Network>> {
		Ok(self.api.list_networks(None::<ListNetworksOptions>).await?)
	}

	pub async fn inspect_network(&self, id: &str) -> Result<bollard::models::Network> {
		Ok(self.api.inspect_network(id, None::<InspectNetworkOptions>).await?)
	}

	/// Creates the shared proxy network when it is missing.
	pub async fn ensure_network(&self, name: &str) -> Result<()> {
		match self.inspect_network(name).await {
			Ok(_) => return Ok(()),
			Err(err) if !is_not_found(&err) => return Err(err),
			Err(_) => {}
		}
		let created = self
			.api
			.create_network(NetworkCreateRequest {
				name: name.to_string(),
				driver: Some("bridge".into()),
				labels: Some(HashMap::from([(LABEL_MANAGED.to_string(), "true".to_string())])),
				..Default::default()
			})
			.await;
		match created {
			Err(err) if err.to_string().contains("already exists") => Ok(()),
			other => other.map(|_| ()).map_err(Into::into),
		}
	}

	/// Attaches a container to a network under a stable alias. Idempotent: an
	/// attachment with the right alias is left alone, a stale one is replaced.
	pub async fn connect_with_alias(&self, network: &str, container_id: &str, alias: &str) -> Result<()> {
		let info = self.inspect(container_id).await?;
		if let Some(endpoint) = networks(&info).get(network) {
			if endpoint.aliases.as_ref().is_some_and(|aliases| aliases.iter().any(|a| a == alias)) {
				return Ok(());
			}
			// Wrong alias: detach so the correct one can be applied.
			self.api
				.disconnect_network(network, NetworkDisconnectRequest { container: Some(container_id.to_string()), force: Some(true) })
				.await?;
		}
		self.api
			.connect_network(
				network,
				NetworkConnectRequest {
					container: Some(container_id.to_string()),
					endpoint_config: Some(EndpointSettings { aliases: Some(vec![alias.to_string()]), ..Default::default() }),
				},
			)
			.await?;
		Ok(())
	}

	/// The manager's own container. Inside a container the hostname is the
	/// container id, which the platform's compose file never overrides.
	async fn this_container(&self) -> Result<ContainerInspectResponse> {
		let host = hostname()?;
		self.inspect(&host).await.context("could not identify the manager container")
	}

	/// The manager's address on one of its networks.
	pub async fn self_ip(&self, network: &str) -> Result<String> {
		let info = self.this_container().await?;
		match networks(&info).get(network).and_then(|e| e.ip_address.clone()) {
			Some(ip) if !ip.is_empty() => Ok(ip),
			_ => bail!("the manager is not attached to network {network}"),
		}
	}

	/// Attaches the manager to one of the container's compose project networks
	/// (the kind leave_project_networks detaches before `down`) and returns the
	/// container's address there, read on every call because a redeploy
	/// recreates the container with a new one.
	pub async fn reach_container(&self, container_id: &str, compose_project: &str) -> Result<String> {
		let target = self.inspect(container_id).await?;
		for (name, endpoint) in networks(&target) {
			let Some(ip) = endpoint.ip_address.clone().filter(|ip| !ip.is_empty()) else { continue };
			let candidate = self.inspect_network(&name).await?;
			if candidate.labels.unwrap_or_default().get(COMPOSE_PROJECT_LABEL).map(String::as_str) != Some(compose_project) {
				continue;
			}
			self.join_network(&name).await?;
			return Ok(ip);
		}
		bail!("the container is on no network of compose project {compose_project}")
	}

	async fn join_network(&self, network: &str) -> Result<()> {
		let info = match self.this_container().await {
			// `make run` puts the manager on the host, which reaches bridge addresses on Linux as is.
			Err(err) if is_not_found(&err) => return Ok(()),
			other => other?,
		};
		if networks(&info).contains_key(network) {
			return Ok(());
		}
		let request = NetworkConnectRequest { container: info.id.clone(), endpoint_config: None };
		if let Err(err) = self.api.connect_network(network, request).await {
			// Two requests can race to connect; the loser still ends up attached.
			let attached = self.this_container().await.is_ok_and(|again| networks(&again).contains_key(network));
			if !attached {
				return Err(err.into());
			}
		}
		Ok(())
	}

	/// Detaches the manager from every network of a compose project so
	/// `compose down` can remove them; one it is still on has active endpoints.
	pub async fn leave_project_networks(&self, compose_project: &str) -> Result<()> {
		let info = match self.this_container().await {
			// `make run` puts the manager on the host, where it never joined anything.
			Err(err) if is_not_found(&err) => return Ok(()),
			other => other?,
		};
		let id = info.id.clone().unwrap_or_default();
		for name in networks(&info).keys() {
			let attached = self.inspect_network(name).await?;
			if attached.labels.unwrap_or_default().get(COMPOSE_PROJECT_LABEL).map(String::as_str) != Some(compose_project) {
				continue;
			}
			self.api.disconnect_network(name, NetworkDisconnectRequest { container: Some(id.clone()), force: Some(false) }).await?;
		}
		Ok(())
	}

	pub async fn disk_usage(&self) -> Result<SystemDataUsageResponse> {
		Ok(self.api.df(None::<DataUsageOptions>).await?)
	}

	/// One explicit cleanup. The platform never prunes on its own.
	pub async fn prune(&self, kind: &str) -> Result<PruneReport> {
		let report =
			|removed: usize, freed: Option<i64>| PruneReport { kind: kind.to_string(), removed, freed: freed.unwrap_or(0).max(0) as u64 };
		match kind {
			"containers" => {
				let r = self.api.prune_containers(None::<bollard::query_parameters::PruneContainersOptions>).await?;
				Ok(report(r.containers_deleted.unwrap_or_default().len(), r.space_reclaimed))
			}
			"images" => {
				let r = self.api.prune_images(None::<bollard::query_parameters::PruneImagesOptions>).await?;
				Ok(report(r.images_deleted.unwrap_or_default().len(), r.space_reclaimed))
			}
			"volumes" => {
				let r = self.api.prune_volumes(None::<bollard::query_parameters::PruneVolumesOptions>).await?;
				Ok(report(r.volumes_deleted.unwrap_or_default().len(), r.space_reclaimed))
			}
			"networks" => {
				let r = self.api.prune_networks(None::<bollard::query_parameters::PruneNetworksOptions>).await?;
				Ok(report(r.networks_deleted.unwrap_or_default().len(), None))
			}
			"build-cache" => self.prune_build_cache(true).await,
			other => bail!("unknown cleanup target {other:?}"),
		}
	}

	/// Drops the cache records no image needs any more and keeps the ones the
	/// next incremental build reuses: what a service sweeping after its own build wants.
	pub async fn prune_dangling_build_cache(&self) -> Result<PruneReport> {
		self.prune_build_cache(false).await
	}

	async fn prune_build_cache(&self, all: bool) -> Result<PruneReport> {
		let r = self.api.prune_build(Some(PruneBuildOptions { all: Some(all), ..Default::default() })).await?;
		Ok(PruneReport {
			kind: "build-cache".into(),
			removed: r.caches_deleted.unwrap_or_default().len(),
			freed: r.space_reclaimed.unwrap_or(0).max(0) as u64,
		})
	}
}

/// Summarises one cleanup action for the Docker Cleanup screen.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PruneReport {
	pub kind: String,
	pub removed: usize,
	#[serde(rename = "space_reclaimed")]
	pub freed: u64,
}

pub fn networks(info: &ContainerInspectResponse) -> HashMap<String, EndpointSettings> {
	info.network_settings.as_ref().and_then(|s| s.networks.clone()).unwrap_or_default()
}

fn hostname() -> Result<String> {
	if let Ok(name) = std::fs::read_to_string("/etc/hostname") {
		return Ok(name.trim().to_string());
	}
	let output = std::process::Command::new("hostname").output().context("read hostname")?;
	Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
