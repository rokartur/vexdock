//! Maps hostnames onto compose services: attaches the right container to the
//! shared proxy network under a stable alias, renders the Nginx configuration
//! and drives certificate issuance.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use tokio::sync::Mutex;

use crate::certificates::{self, CertResult, Issuer};
use crate::config::Config;
use crate::database::{self, Certificate, Db, Domain};
use crate::docker::Docker;
use crate::nginx::{self, Nginx};
use crate::security;

/// Stores the hostname the panel itself is served on.
pub const SETTING_DASHBOARD_DOMAIN: &str = "dashboard_domain";

/// Records whether the panel vhost should use TLS.
pub const SETTING_DASHBOARD_HTTPS: &str = "dashboard_https";

/// Bounds a single ACME exchange. The renewal sweep issues one hostname at a
/// time, so without it one unanswered authorization stalls every other
/// domain's renewal until restart. Generous enough for DNS-01 propagation.
const ISSUE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub struct Domains {
	db: Arc<Db>,
	cfg: Arc<Config>,
	docker: Arc<Docker>,
	nginx: Arc<Nginx>,
	certs: Arc<Issuer>,
	/// Two concurrent reconciles would race on the generated directory and on
	/// network attachments.
	reconcile_lock: Mutex<()>,
}

/// The Add Domain form.
#[derive(Clone, Debug, Default)]
pub struct CreateInput {
	pub project_id: String,
	/// Which copy of the project serves the hostname; empty is the default environment.
	pub environment_id: String,
	pub service_name: String,
	pub hostname: String,
	pub container_port: i64,
	pub https: bool,
	pub redirect_https: bool,
	/// CERT_LETS_ENCRYPT or CERT_CUSTOM.
	pub certificate_source: String,
	/// Only read for a custom source.
	pub certificate_pem: String,
	pub private_key_pem: String,
}

/// The optional new certificate material alongside a changed domain.
#[derive(Clone, Debug, Default)]
pub struct UpdateInput {
	pub certificate_pem: String,
	pub private_key_pem: String,
}

impl Domains {
	pub fn new(db: Arc<Db>, cfg: Arc<Config>, docker: Arc<Docker>, nginx: Arc<Nginx>, certs: Arc<Issuer>) -> Domains {
		Domains { db, cfg, docker, nginx, certs, reconcile_lock: Mutex::new(()) }
	}

	/// Validates and stores a domain, then reconciles the proxy so it starts
	/// serving immediately. A domain that was stored comes back with the error,
	/// so the caller can report a TLS problem without losing the mapping.
	pub async fn create(&self, input: &CreateInput) -> (Option<Domain>, Result<()>) {
		let mut d = match self.validate_new(input) {
			Ok(d) => d,
			Err(err) => return (None, Err(err)),
		};
		if let Err(err) = self.db.create_domain(&mut d) {
			return (None, Err(anyhow!("domain {} is already in use: {err:#}", d.hostname)));
		}
		let result = self.serve_new(&d, input).await;
		(Some(d), result)
	}

	fn validate_new(&self, input: &CreateInput) -> Result<Domain> {
		let host = security::validate_hostname(&input.hostname)?;
		security::validate_port(input.container_port)?;
		let project = self.db.project_by_id(&input.project_id)?;
		security::validate_service_name(&input.service_name)?;
		let env = self.db.environment_or_default(&project.id, &input.environment_id)?;
		let service = self
			.db
			.service_by_name(&env.id, &input.service_name)
			.map_err(|_| anyhow!("environment {} has no service named {:?}", env.slug, input.service_name))?;
		let source = normalize_source(&input.certificate_source)?;
		// A custom certificate is validated before the domain exists, so a bad
		// paste fails the form instead of leaving a domain that cannot serve TLS.
		if input.https && source == database::CERT_CUSTOM {
			certificates::validate(&host, &input.certificate_pem, &input.private_key_pem)?;
		}
		Ok(Domain {
			id: database::new_id(),
			project_id: project.id,
			environment_id: env.id,
			service_id: service.id,
			hostname: host,
			container_port: input.container_port,
			https_enabled: input.https,
			redirect_https: input.redirect_https,
			certificate_source: source,
			..Default::default()
		})
	}

	async fn serve_new(&self, d: &Domain, input: &CreateInput) -> Result<()> {
		if d.https_enabled && d.certificate_source == database::CERT_CUSTOM {
			return self.install_custom_certificate(d, &input.certificate_pem, &input.private_key_pem).await;
		}
		self.reconcile().await?;
		self.ensure_certificate(d).await
	}

	/// Stores a user-supplied pair and reloads the proxy.
	pub async fn install_custom_certificate(&self, d: &Domain, cert_pem: &str, key_pem: &str) -> Result<()> {
		let result = match self.certs.install_custom(&d.hostname, cert_pem, key_pem) {
			Ok(result) => result,
			Err(err) => {
				self.record_failure(d, &err, database::CERT_CUSTOM);
				return Err(err);
			}
		};
		self.db.upsert_certificate(&mut issued(d, &result, database::CERT_CUSTOM))?;
		tracing::info!(domain = %d.hostname, expires = %result.not_after, "custom certificate installed");
		self.reconcile_new_certificate().await
	}

	/// Reports whether the row was written. false with an error is a rejection
	/// that changed nothing; true with an error is a saved domain whose
	/// certificate or proxy reload still needs attention.
	pub async fn update(&self, d: &mut Domain, input: &UpdateInput) -> (bool, Result<()>) {
		let previous = match self.validate_update(d, input) {
			Ok(previous) => previous,
			Err(err) => return (false, Err(err)),
		};
		if let Err(err) = self.db.update_domain(d) {
			return (false, Err(err));
		}
		(true, self.serve_updated(d, &previous, input).await)
	}

	fn validate_update(&self, d: &mut Domain, input: &UpdateInput) -> Result<Domain> {
		let host = security::validate_hostname(&d.hostname)?;
		let previous = self.db.domain_by_id(&d.id)?;
		d.hostname = host;
		security::validate_port(d.container_port)?;
		d.certificate_source = normalize_source(&d.certificate_source)?;
		if d.https_enabled && d.certificate_source == database::CERT_CUSTOM && uploading(input) {
			certificates::validate(&d.hostname, &input.certificate_pem, &input.private_key_pem)?;
		}
		Ok(previous)
	}

	async fn serve_updated(&self, d: &Domain, previous: &Domain, input: &UpdateInput) -> Result<()> {
		// Switching source or hostname invalidates whatever is on disk. After the
		// write: hostname is UNIQUE, and a rejected rename must not take the old
		// domain's certificate with it.
		if (previous.certificate_source != d.certificate_source || previous.hostname != d.hostname)
			&& let Err(err) = self.certs.remove(&previous.hostname)
		{
			tracing::warn!(domain = %previous.hostname, error = %err, "remove previous certificate");
		}
		if d.https_enabled && d.certificate_source == database::CERT_CUSTOM {
			if uploading(input) {
				return self.install_custom_certificate(d, &input.certificate_pem, &input.private_key_pem).await;
			}
			if !self.certs.exists(&d.hostname) {
				self.reconcile().await?;
				bail!("upload a certificate for {} to enable HTTPS", d.hostname);
			}
		}
		self.reconcile().await?;
		self.ensure_certificate(d).await
	}

	pub async fn delete(&self, id: &str) -> Result<()> {
		let domain = self.db.domain_by_id(id)?;
		self.db.delete_domain(id)?;
		if let Err(err) = self.certs.remove(&domain.hostname) {
			tracing::warn!(domain = %domain.hostname, error = %err, "remove certificate for deleted domain");
		}
		self.reconcile().await
	}

	/// Makes the running proxy match the database: every domain's container
	/// joins the proxy network under its alias and the generated Nginx config is
	/// rewritten, validated and reloaded as one atomic set.
	pub async fn reconcile(&self) -> Result<()> {
		let _guard = self.reconcile_lock.lock().await;
		let domains = self.db.list_domains()?;
		self.docker.ensure_network(&self.cfg.proxy_network).await.map_err(|err| anyhow!("ensure proxy network: {err:#}"))?;

		let mut desired = nginx::FileSet::new();
		for d in domains {
			let Ok(service) = self.db.service_by_id(&d.service_id) else {
				tracing::warn!(domain = %d.hostname, "domain points at a missing service");
				continue;
			};
			let Ok(env) = self.db.environment_by_id(&service.environment_id) else {
				tracing::warn!(domain = %d.hostname, "domain points at a missing environment");
				continue;
			};
			let alias = nginx::alias(&env.id, &service.compose_service_name);

			// Attaching is best-effort: a stopped container must not block the
			// rest of the configuration from being written.
			match self.docker.service_container(&env.compose_project_name, &service.compose_service_name).await {
				Ok(container_id) => {
					if let Err(err) = self.docker.connect_with_alias(&self.cfg.proxy_network, &container_id, &alias).await {
						tracing::warn!(domain = %d.hostname, error = %err, "proxy attach failed");
					}
				}
				Err(_) => tracing::debug!(domain = %d.hostname, "no running container for domain yet"),
			}

			// A failed read must fail the reconcile: rendering without it would
			// silently drop the service's basic auth.
			let redirects = self.db.service_redirects(&service.id)?;
			let users = self.db.service_basic_auths(&service.id)?;
			let upstream = nginx::Upstream {
				hostname: d.hostname.clone(),
				alias,
				port: d.container_port,
				https: d.https_enabled && self.certs.exists(&d.hostname),
				redirect_https: d.redirect_https,
				cert_dir: format!("/certificates/{}", certificates::dir_name(&d.hostname)),
				redirects: redirects
					.into_iter()
					.map(|r| nginx::Redirect { regex: r.regex, replacement: r.replacement, permanent: r.permanent })
					.collect(),
				basic_auth: !users.is_empty(),
			};
			if upstream.basic_auth {
				let htpasswd: String = users.iter().map(|u| format!("{}:{}\n", u.username, u.password_hash)).collect();
				desired.insert(nginx::auth_file_name(&d.hostname), htpasswd);
			}
			desired.insert(nginx::file_name(&d.hostname), nginx::render(&upstream));
		}

		if let Some((name, vhost)) = self.dashboard_vhost() {
			desired.insert(name, vhost);
		}
		self.nginx.apply(&desired).await
	}

	/// Follows a reconcile with an unconditional reload. Nginx reads certificate
	/// files once at load and apply skips the reload when the vhost text is
	/// unchanged, which a renewal always is, so without this the proxy serves
	/// the old certificate until it expires.
	async fn reconcile_new_certificate(&self) -> Result<()> {
		self.reconcile().await?;
		self.nginx.reload().await
	}

	/// The panel's own vhost when the user assigned it a domain, as (file name, body).
	fn dashboard_vhost(&self) -> Option<(String, String)> {
		let host = self.setting(SETTING_DASHBOARD_DOMAIN).ok()?;
		if host.is_empty() {
			return None;
		}
		let host = security::validate_hostname(&host).ok()?;
		// The setting decides, not the certificate: a certificate outlives the
		// switch that asked for it, so reading the file alone would keep 443 up
		// after the operator turned HTTPS off.
		let wanted = self.setting(SETTING_DASHBOARD_HTTPS).ok()?;
		let https = wanted == "true" && self.certs.exists(&host);
		// dir_name, not the raw host: a wildcard lives under _wildcard.example.com,
		// and a literal * in ssl_certificate fails nginx -t and wedges every later apply.
		let cert_dir = format!("/certificates/{}", certificates::dir_name(&host));
		let body = nginx::render_dashboard(&host, nginx::MANAGER_UPSTREAM, "/usr/share/nginx/html", https, &cert_dir);
		Some((nginx::file_name(&host), body))
	}

	/// A setting that was never written reads as empty.
	fn setting(&self, key: &str) -> Result<String> {
		match self.db.setting(key) {
			Err(err) if database::is_not_found(&err) => Ok(String::new()),
			other => other,
		}
	}

	/// Issues a certificate when one is missing or near expiry and re-renders
	/// the configuration so Nginx starts serving HTTPS.
	pub async fn ensure_certificate(&self, d: &Domain) -> Result<()> {
		if !d.https_enabled {
			return Ok(());
		}
		if d.certificate_source == database::CERT_CUSTOM {
			// The user owns this certificate; the platform never replaces it.
			if !self.certs.exists(&d.hostname) {
				bail!("no certificate uploaded for {} yet", d.hostname);
			}
			return Ok(());
		}
		if self.fresh(&d.hostname) {
			return Ok(());
		}
		tracing::info!(domain = %d.hostname, "requesting certificate");
		let result = match self.issue(&d.hostname).await {
			Ok(result) => result,
			Err(err) => {
				self.record_failure(d, &err, "");
				return Err(anyhow!("certificate for {} failed: {err:#}", d.hostname));
			}
		};
		self.db.upsert_certificate(&mut issued(d, &result, ""))?;
		self.reconcile_new_certificate().await
	}

	/// Whether a certificate exists and stays valid past the renewal window.
	fn fresh(&self, hostname: &str) -> bool {
		self.certs.exists(hostname) && self.certs.expiry(hostname).is_ok_and(|expiry| expiry - Utc::now() > renew_before(&self.cfg))
	}

	async fn issue(&self, hostname: &str) -> Result<CertResult> {
		tokio::time::timeout(ISSUE_TIMEOUT, self.certs.issue(hostname)).await.map_err(|_| anyhow!("timed out after {ISSUE_TIMEOUT:?}"))?
	}

	fn record_failure(&self, d: &Domain, err: &anyhow::Error, source: &str) {
		let _ = self.db.upsert_certificate(&mut Certificate {
			domain_id: d.id.clone(),
			hostname: d.hostname.clone(),
			status: database::CERT_FAILED.into(),
			last_error: format!("{err:#}"),
			source: source.into(),
			..Default::default()
		});
	}

	/// The scheduler entry point: renews everything inside the renewal window.
	pub async fn renew_expiring(&self) {
		let domains = match self.db.list_domains() {
			Ok(domains) => domains,
			Err(err) => {
				tracing::error!(error = %err, "certificate renewal: list domains");
				return;
			}
		};
		for d in domains {
			if !d.https_enabled {
				continue;
			}
			if d.certificate_source == database::CERT_CUSTOM {
				// Nothing to renew, but an expiring upload is worth saying out loud.
				if let Ok(expiry) = self.certs.expiry(&d.hostname)
					&& expiry - Utc::now() < renew_before(&self.cfg)
				{
					tracing::warn!(domain = %d.hostname, expires = %expiry, "uploaded certificate is expiring");
				}
				continue;
			}
			if self.fresh(&d.hostname) {
				continue;
			}
			if let Err(err) = self.ensure_certificate(&d).await {
				tracing::error!(domain = %d.hostname, error = %err, "certificate renewal failed");
			}
		}
		self.renew_dashboard_certificate().await;
	}

	/// The panel's own hostname is a setting, not a row in domains, so the sweep
	/// above cannot see it and its certificate would expire.
	async fn renew_dashboard_certificate(&self) {
		let host = match self.setting(SETTING_DASHBOARD_DOMAIN) {
			Ok(host) => host,
			Err(err) => {
				tracing::error!(error = %err, "dashboard certificate renewal: read setting");
				return;
			}
		};
		if host.is_empty() || self.setting(SETTING_DASHBOARD_HTTPS).ok().as_deref() != Some("true") || self.fresh(&host) {
			return;
		}
		tracing::info!(domain = %host, "renewing dashboard certificate");
		if let Err(err) = self.issue(&host).await {
			tracing::error!(domain = %host, error = %err, "dashboard certificate renewal failed");
			return;
		}
		if let Err(err) = self.reconcile_new_certificate().await {
			tracing::error!(error = %err, "dashboard certificate renewal: reconcile");
		}
	}

	/// Publishes the panel on a hostname of the user's choosing.
	pub async fn set_dashboard_domain(&self, hostname: &str, https: bool) -> Result<()> {
		if hostname.is_empty() {
			self.db.set_setting(SETTING_DASHBOARD_DOMAIN, "")?;
			return self.reconcile().await;
		}
		let host = security::validate_hostname(hostname)?;
		self.db.set_setting(SETTING_DASHBOARD_DOMAIN, &host)?;
		self.db.set_setting(SETTING_DASHBOARD_HTTPS, if https { "true" } else { "false" })?;
		self.reconcile().await?;
		if https && !self.certs.exists(&host) {
			self.issue(&host).await.map_err(|err| anyhow!("certificate for {host} failed: {err:#}"))?;
			return self.reconcile_new_certificate().await;
		}
		Ok(())
	}
}

/// Defaults to Let's Encrypt and rejects anything unknown.
fn normalize_source(source: &str) -> Result<String> {
	match source {
		"" | database::CERT_LETS_ENCRYPT => Ok(database::CERT_LETS_ENCRYPT.into()),
		database::CERT_CUSTOM => Ok(database::CERT_CUSTOM.into()),
		other => bail!("unknown certificate source {other:?}"),
	}
}

fn uploading(input: &UpdateInput) -> bool {
	!input.certificate_pem.trim().is_empty() || !input.private_key_pem.trim().is_empty()
}

fn renew_before(cfg: &Config) -> chrono::TimeDelta {
	chrono::TimeDelta::from_std(cfg.acme_renew_before).unwrap_or(chrono::TimeDelta::MAX)
}

fn issued(d: &Domain, result: &CertResult, source: &str) -> Certificate {
	Certificate {
		domain_id: d.id.clone(),
		hostname: d.hostname.clone(),
		issuer: result.issuer.clone(),
		issued_at: result.not_before.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
		expires_at: result.not_after.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
		last_renewed_at: database::now(),
		status: database::CERT_ISSUED.into(),
		source: source.into(),
		..Default::default()
	}
}
