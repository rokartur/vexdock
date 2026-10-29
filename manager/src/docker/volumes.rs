use anyhow::{Result, anyhow, bail};
use bollard::models::{ContainerCreateBody, HostConfig, VolumeCreateOptions};
use bollard::query_parameters::{CreateContainerOptions, WaitContainerOptions};
use futures::StreamExt;

use super::Docker;

/// Separates "there was nothing to copy" from a copy that failed, so a caller
/// can skip the first without skipping the second.
#[derive(Debug, thiserror::Error)]
#[error("source volume does not exist")]
pub struct VolumeMissing;

impl Docker {
	/// The image the manager itself runs from, the one image guaranteed to be on
	/// the host without a pull.
	pub async fn self_image(&self) -> Result<String> {
		Ok(self.this_container().await?.image.unwrap_or_default())
	}

	/// Duplicates a named volume's contents into a new one. Docker has no rename
	/// and a volume is only reachable through the daemon, so the copy runs in a
	/// throwaway container with both ends mounted.
	///
	/// ponytail: the source is copied while whatever writes to it may still be
	/// running, so a database mid-write can arrive torn. Stop the container first.
	pub async fn copy_volume(&self, from: &str, to: &str) -> Result<()> {
		// Binding a volume that does not exist would create an empty one and
		// report a copy that copied nothing.
		if let Err(err) = self.api.inspect_volume(from).await {
			return Err(anyhow::Error::new(VolumeMissing).context(format!("source volume {from}: {err}")));
		}
		let image = self.self_image().await?;
		self.api.create_volume(VolumeCreateOptions { name: Some(to.to_string()), ..Default::default() }).await?;
		let created = self
			.api
			.create_container(
				None::<CreateContainerOptions>,
				ContainerCreateBody {
					image: Some(image),
					entrypoint: Some(vec!["cp".into(), "-a".into(), "/from/.".into(), "/to/".into()]),
					host_config: Some(HostConfig {
						binds: Some(vec![format!("{from}:/from:ro"), format!("{to}:/to")]),
						..Default::default()
					}),
					..Default::default()
				},
			)
			.await?;
		let result = self.run_to_completion(&created.id).await;
		let _ = self.remove(&created.id, true).await;
		match result? {
			0 => Ok(()),
			code => bail!("copy {from} to {to} exited with status {code}"),
		}
	}

	async fn run_to_completion(&self, id: &str) -> Result<i64> {
		self.start(id).await?;
		let mut wait = self.api.wait_container(id, Some(WaitContainerOptions { condition: "not-running".into() }));
		match wait.next().await {
			Some(Ok(status)) => Ok(status.status_code),
			// bollard reports a non-zero exit as an error carrying the code.
			Some(Err(bollard::errors::Error::DockerContainerWaitError { code, .. })) => Ok(code),
			Some(Err(err)) => Err(err.into()),
			None => Err(anyhow!("container {id} vanished while copying")),
		}
	}
}
