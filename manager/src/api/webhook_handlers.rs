use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::json;
use subtle::ConstantTimeEq;

use super::Server;
use super::respond::{ApiError, ApiResult, json};
use crate::database::{self, Db, GitProvider, Service};
use crate::deployments::{self, Options};
use crate::git;
use crate::security::Cipher;

/// Where a push from a connected provider lands. One URL serves every
/// repository the connection can see, so the payload's owner and repository
/// select the services to deploy. Events it ignores (nothing tracks the
/// repository, a ping) answer 202 so the provider does not disable the hook.
pub async fn provider_webhook(
	State(s): State<Arc<Server>>,
	Path(provider_type): Path<String>,
	Query(q): Query<TokenQuery>,
	headers: HeaderMap,
	body: Bytes,
) -> ApiResult {
	if !git::is_provider_type(&provider_type) {
		return Err(ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Unknown webhook"));
	}
	// Read up to 1 MiB; a longer delivery fails the signature or the parse.
	let body = &body[..body.len().min(1 << 20)];
	let push = parse_push(body);
	let signature = headers.get("X-Hub-Signature-256").and_then(|v| v.to_str().ok()).unwrap_or_default();
	let provider = webhook_provider(&s.db, &s.cipher, &provider_type, &q.token, signature, body, &push)
		.map_err(|err| ApiError::new(StatusCode::UNAUTHORIZED, "SIGNATURE_INVALID", err.to_string()))?;
	if headers.get("X-GitHub-Event").is_some_and(|v| v == "ping") {
		return Ok(json(StatusCode::ACCEPTED, &json!({"status": "pong"})));
	}
	if push.owner.is_empty() || push.repository.is_empty() {
		return Ok(json(StatusCode::ACCEPTED, &json!({"status": "ignored", "reason": "no repository in payload"})));
	}
	let services = s.db.services_for_repository(&provider.id, &push.owner, &push.repository, push.branch())?;
	let queued = s.queue_services(&services)?;
	if queued.is_empty() {
		let reason = format!("nothing tracks {}/{}@{}", push.owner, push.repository, push.branch());
		return Ok(json(StatusCode::ACCEPTED, &json!({"status": "ignored", "reason": reason})));
	}
	Ok(json(StatusCode::ACCEPTED, &json!({"status": "queued", "deployment_ids": queued})))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct TokenQuery {
	token: String,
}

#[derive(Debug, thiserror::Error)]
enum WebhookError {
	#[error("Unknown webhook")]
	Unknown,
	#[error("Webhook signature mismatch")]
	SignatureMismatch,
	#[error(transparent)]
	Internal(#[from] anyhow::Error),
}

/// Identifies and authenticates the delivery. GitHub signs its payload with
/// the secret the manifest generated, the strongest check available and the
/// only one that tells connections apart when a server holds several. The
/// other three hosts do not sign App-style deliveries, so their hook URL
/// carries a per-connection token: Bitbucket Cloud has no secret field, and a
/// query parameter is the one transport all three can carry.
fn webhook_provider(
	db: &Db,
	cipher: &Cipher,
	provider_type: &str,
	token: &str,
	signature: &str,
	body: &[u8],
	push: &PushPayload,
) -> Result<GitProvider, WebhookError> {
	if provider_type == database::PROVIDER_GITHUB {
		let provider = db.git_provider_by_installation(&push.installation_id).map_err(|_| WebhookError::Unknown)?;
		let secret = provider.github.as_ref().and_then(|gh| cipher.decrypt(&gh.webhook_secret_enc).ok()).unwrap_or_default();
		if secret.is_empty() || !git::verify_webhook_signature(&secret, body, signature) {
			return Err(WebhookError::SignatureMismatch);
		}
		return Ok(provider);
	}
	if token.is_empty() {
		return Err(WebhookError::SignatureMismatch);
	}
	for provider in db.list_git_providers()? {
		if provider.provider_type != provider_type || !provider.connected {
			continue;
		}
		let Ok(secret) = cipher.decrypt(&provider.webhook_secret_enc) else {
			continue;
		};
		if bool::from(token.as_bytes().ct_eq(secret.as_bytes())) {
			return Ok(provider);
		}
	}
	Err(WebhookError::SignatureMismatch)
}

impl Server {
	/// Deploys every matched service. Two services of one environment tracking
	/// the same repository is a monorepo, and each deploys on its own.
	fn queue_services(&self, services: &[Service]) -> anyhow::Result<Vec<String>> {
		let mut queued = Vec::new();
		for svc in services {
			if !svc.auto_deploy {
				continue;
			}
			let project = self.db.project_by_id(&svc.project_id)?;
			let env = self.db.environment_by_id(&svc.environment_id)?;
			let options = Options {
				trigger: deployments::TRIGGER_WEBHOOK.to_string(),
				actor: "webhook".to_string(),
				service_name: svc.compose_service_name.clone(),
				..Default::default()
			};
			queued.push(self.deployments.trigger(&project, &env, options)?.id);
		}
		Ok(queued)
	}
}

/// The union of what the four hosts say about a push. GitHub, Gitea and GitLab
/// give an "owner/name" full name, Bitbucket a workspace and a slug, and only
/// Bitbucket puts the branch in a changes array rather than in a ref.
#[derive(Debug, Default)]
struct PushPayload {
	ref_name: String,
	owner: String,
	repository: String,
	bitbucket_ref: String,
	installation_id: String,
}

impl PushPayload {
	/// The pushed branch without the ref prefix, or "" when the payload named none.
	fn branch(&self) -> &str {
		if self.ref_name.is_empty() {
			return &self.bitbucket_ref;
		}
		self.ref_name.strip_prefix("refs/heads/").unwrap_or(&self.ref_name)
	}
}

fn parse_push(body: &[u8]) -> PushPayload {
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct Raw {
		#[serde(rename = "ref")]
		ref_name: String,
		repository: RawRepository,
		/// GitLab calls the repository a project and gives the pair split apart.
		project: RawProject,
		push: RawPush,
		installation: RawInstallation,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawRepository {
		full_name: String,
		/// Bitbucket's full_name is workspace/slug too, but its workspace
		/// object is what survives a repository rename.
		workspace: RawSlug,
		slug: String,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawSlug {
		slug: String,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawProject {
		path_with_namespace: String,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawPush {
		changes: Vec<RawChange>,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawChange {
		new: RawRef,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawRef {
		name: String,
		#[serde(rename = "type")]
		kind: String,
	}
	#[derive(Deserialize, Default)]
	#[serde(default)]
	struct RawInstallation {
		id: Option<serde_json::Number>,
	}

	let Ok(raw) = serde_json::from_slice::<Raw>(body) else {
		return PushPayload::default();
	};
	let mut out = PushPayload {
		ref_name: raw.ref_name,
		installation_id: raw.installation.id.map(|id| id.to_string()).unwrap_or_default(),
		..Default::default()
	};
	let full_name = if raw.repository.full_name.is_empty() { raw.project.path_with_namespace } else { raw.repository.full_name };
	// The last segment is the repository; everything before it the owner,
	// which on GitLab can be nested group segments deep.
	if let Some((owner, repository)) = full_name.rsplit_once('/').filter(|(owner, _)| !owner.is_empty()) {
		out.owner = owner.to_string();
		out.repository = repository.to_string();
	}
	if !raw.repository.workspace.slug.is_empty() {
		out.owner = raw.repository.workspace.slug;
		if !raw.repository.slug.is_empty() {
			out.repository = raw.repository.slug;
		}
	}
	if let Some(change) = raw.push.changes.into_iter().find(|c| c.new.kind == "branch") {
		out.bitbucket_ref = change.new.name;
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::database::GitLabProvider;

	/// GitLab, Gitea and Bitbucket do not sign their deliveries, so the token in
	/// the hook URL is the only thing between a push and a deployment.
	#[test]
	fn webhook_provider_requires_the_token() {
		let (_dir, db) = Db::open_temp();
		let cipher = Cipher::new(&[7; 32]).unwrap();
		let mut provider = GitProvider {
			name: "acme".into(),
			provider_type: database::PROVIDER_GITLAB.into(),
			webhook_secret_enc: cipher.encrypt("s3cret").unwrap(),
			gitlab: Some(GitLabProvider {
				url: "https://gitlab.com".into(),
				application_id: "a".into(),
				access_token_enc: "t".into(),
				..Default::default()
			}),
			..Default::default()
		};
		db.create_git_provider(&mut provider).unwrap();
		for (token, want) in [("", false), ("wrong", false), ("s3cret", true)] {
			let got = webhook_provider(&db, &cipher, database::PROVIDER_GITLAB, token, "", b"", &PushPayload::default());
			assert_eq!(got.is_ok(), want, "{token:?}: {got:?}");
			if want {
				assert_eq!(got.unwrap().id, provider.id);
			}
		}
	}

	/// Services are selected by owner and repository, so each host's way of
	/// naming the pair has to come out the same.
	#[test]
	fn parse_push_names_the_repository() {
		let cases = [
			(
				r#"{"ref":"refs/heads/main","repository":{"full_name":"acme/app"},"installation":{"id":4213}}"#,
				"acme",
				"app",
				"main",
				"4213",
			),
			(r#"{"ref":"refs/heads/release","project":{"path_with_namespace":"acme/group/app"}}"#, "acme/group", "app", "release", ""),
			(
				r#"{"repository":{"workspace":{"slug":"acme"},"slug":"app"},"push":{"changes":[{"new":{"name":"main","type":"branch"}}]}}"#,
				"acme",
				"app",
				"main",
				"",
			),
		];
		for (body, owner, repo, branch, installation) in cases {
			let got = parse_push(body.as_bytes());
			assert_eq!((got.owner.as_str(), got.repository.as_str()), (owner, repo), "{body}");
			assert_eq!(got.branch(), branch, "{body}");
			assert_eq!(got.installation_id, installation, "{body}");
		}
	}
}
