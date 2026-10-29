use anyhow::{Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::Projects;
use crate::database::{Environment, Project};

/// The shape of the blob, not the shape of vexdock. Bump it only when an older
/// manager would misread a newer export.
pub const EXPORT_VERSION: i64 = 2;

/// One service stripped of everything that only means something in the project
/// it came from: no ids, no timestamps, no container state. Every field has to
/// be one the import can apply; display_name is absent because create takes none.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PortableService {
	pub name: String,
	pub provider: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub repository_url: String,
	/// A connected service names its repository on a connection rather than by
	/// URL. The connection id only resolves on the server that exported it.
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub git_provider_id: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub owner: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub repository: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub branch: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub build_path: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub image: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub engine: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub data_path: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub compose_fragment: String,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub env: Vec<PortableEnvVar>,
}

/// Drops updated_at: the timestamp describes the row, not the variable. A
/// secret exported without its value keeps the key so the importing side knows
/// what it still has to fill in.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PortableEnvVar {
	pub key: String,
	pub value: String,
	#[serde(default)]
	pub is_secret: bool,
}

/// What a base64 blob decodes to.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Export {
	pub version: i64,
	pub project: String,
	#[serde(default)]
	pub services: Vec<PortableService>,
}

impl Projects {
	/// Renders one environment's services as a base64 blob to paste into another
	/// environment's import. With secrets=false every secret exports as its key
	/// and an empty value. Base64 is not encryption: with secrets=true the blob
	/// is as sensitive as the database.
	pub fn export_services(&self, p: &Project, env: &Environment, secrets: bool) -> Result<String> {
		let mut out = Export { version: EXPORT_VERSION, project: p.name.clone(), services: Vec::new() };
		for svc in self.db.list_services(&env.id)? {
			let env_vars = self
				.service_variables(&svc.id)?
				.into_iter()
				.map(|v| PortableEnvVar {
					value: if v.is_secret && !secrets { String::new() } else { v.value },
					key: v.key,
					is_secret: v.is_secret,
				})
				.collect();
			out.services.push(PortableService {
				name: svc.compose_service_name,
				provider: svc.provider,
				repository_url: svc.repository_url,
				git_provider_id: svc.git_provider_id,
				owner: svc.owner,
				repository: svc.repository,
				branch: svc.branch,
				build_path: svc.build_path,
				image: svc.image,
				engine: svc.engine,
				data_path: svc.data_path,
				compose_fragment: svc.compose_fragment,
				env: env_vars,
			});
		}
		let body = serde_json::to_vec(&out).context("encode export")?;
		Ok(base64::engine::general_purpose::STANDARD.encode(body))
	}
}
