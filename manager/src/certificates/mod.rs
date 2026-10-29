//! Issues and renews Let's Encrypt certificates. The default challenge is
//! HTTP-01, served by the same Nginx that fronts every application. With a
//! Cloudflare API token the issuer switches to DNS-01, the only way to obtain a
//! wildcard certificate.

mod custom;
mod dns01;

pub use custom::*;
pub use dns01::SETTING_CLOUDFLARE_TOKEN;

use std::path::Path;
use std::sync::RwLock;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use instant_acme::{
	Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount, NewOrder, OrderStatus, RetryPolicy,
};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

/// Writes certificates to <certificates_dir>/<dir_name(hostname)>/ and challenge
/// tokens to <challenge_dir>/.well-known/acme-challenge/.
pub struct Issuer {
	certificates_dir: String,
	challenge_dir: String,
	directory_url: String,
	email: String,
	/// Loaded from settings and changeable while a renewal is in flight.
	cloudflare_token: RwLock<String>,
}

/// Describes an issued certificate.
#[derive(Clone, Debug)]
pub struct CertResult {
	pub hostname: String,
	pub issuer: String,
	pub not_before: DateTime<Utc>,
	pub not_after: DateTime<Utc>,
}

/// Maps a hostname to its certificate directory name. A wildcard becomes
/// "_wildcard.example.com" so no path on disk or in an Nginx config ever
/// contains a glob character.
pub fn dir_name(hostname: &str) -> String {
	hostname.replacen('*', "_wildcard", 1)
}

impl Issuer {
	pub fn new(certificates_dir: String, challenge_dir: String, directory_url: String, email: String) -> Issuer {
		Issuer { certificates_dir, challenge_dir, directory_url, email, cloudflare_token: RwLock::new(String::new()) }
	}

	/// Where Nginx reads fullchain.pem/privkey.pem for a hostname.
	pub fn dir(&self, hostname: &str) -> String {
		format!("{}/{}", self.certificates_dir, dir_name(hostname))
	}

	/// Whether a usable certificate is already on disk.
	pub fn exists(&self, hostname: &str) -> bool {
		["fullchain.pem", "privkey.pem"].iter().all(|f| Path::new(&format!("{}/{f}", self.dir(hostname))).exists())
	}

	/// NotAfter of the stored certificate.
	pub fn expiry(&self, hostname: &str) -> Result<DateTime<Utc>> {
		let raw = std::fs::read(format!("{}/fullchain.pem", self.dir(hostname)))?;
		let (_, pem) = x509_parser::pem::parse_x509_pem(&raw).map_err(|_| anyhow!("stored certificate is not valid PEM"))?;
		let cert = pem.parse_x509().map_err(|err| anyhow!("parse certificate: {err}"))?;
		Ok(asn1_time(cert.validity().not_after))
	}

	/// Runs a complete order for one hostname, which may be a wildcard when
	/// DNS-01 is configured.
	pub async fn issue(&self, hostname: &str) -> Result<CertResult> {
		if hostname.starts_with("*.") && !self.dns01_enabled() {
			bail!("wildcard certificates need the DNS-01 challenge: add a Cloudflare API token in system settings");
		}
		let account = self.account().await?;
		let identifiers = [Identifier::Dns(hostname.to_string())];
		let mut order = account.new_order(&NewOrder::new(&identifiers)).await.context("acme order")?;

		// Challenge files and records stay up until the whole order is validated.
		let mut cleanup = Cleanup::default();
		let solved = self.solve_all(&mut order, &mut cleanup).await;
		let ready = match solved {
			Ok(()) => order.poll_ready(&RetryPolicy::default()).await.map_err(anyhow::Error::from),
			Err(err) => Err(err),
		};
		cleanup.run(self).await;
		match ready? {
			OrderStatus::Ready => {}
			status => bail!("domain validation failed (is {hostname} pointing at this server?): order is {status:?}"),
		}
		let key_pem = order.finalize().await.context("acme finalize")?;
		let chain_pem = order.poll_certificate(&RetryPolicy::default()).await.context("acme fetch certificate")?;
		self.store(hostname, &chain_pem, &key_pem)
	}

	async fn solve_all(&self, order: &mut instant_acme::Order, cleanup: &mut Cleanup) -> Result<()> {
		let dns01 = self.dns01_enabled();
		let mut authorizations = order.authorizations();
		while let Some(authz) = authorizations.next().await {
			let mut authz = authz.context("acme authorization")?;
			if authz.status == AuthorizationStatus::Valid {
				continue;
			}
			let (wanted, name) = if dns01 { (ChallengeType::Dns01, "dns-01") } else { (ChallengeType::Http01, "http-01") };
			let identifier = match &authz.identifier().identifier {
				Identifier::Dns(name) => name.clone(),
				other => format!("{other:?}"),
			};
			let mut challenge = authz.challenge(wanted).ok_or_else(|| anyhow!("no {name} challenge offered for {identifier}"))?;
			let key_authorization = challenge.key_authorization();
			if dns01 {
				let record = dns01::publish(&self.token(), &identifier, &key_authorization.dns_value()).await?;
				cleanup.records.push(record);
			} else {
				let token_path = format!("{}/.well-known/acme-challenge/{}", self.challenge_dir, challenge.token);
				std::fs::create_dir_all(Path::new(&token_path).parent().expect("has a parent"))?;
				std::fs::write(&token_path, key_authorization.as_str())?;
				cleanup.files.push(token_path);
			}
			challenge.set_ready().await.context("acme accept challenge")?;
		}
		Ok(())
	}

	/// Writes the chain and key atomically; Nginx only ever sees a complete pair.
	fn store(&self, hostname: &str, chain_pem: &str, key_pem: &str) -> Result<CertResult> {
		let dir = self.dir(hostname);
		std::fs::create_dir_all(&dir)?;
		write_pair(&dir, chain_pem.as_bytes(), key_pem.as_bytes())?;
		let (_, pem) = x509_parser::pem::parse_x509_pem(chain_pem.as_bytes()).map_err(|_| anyhow!("issued chain is not valid PEM"))?;
		let leaf = pem.parse_x509().map_err(|err| anyhow!("parse certificate: {err}"))?;
		Ok(CertResult {
			hostname: hostname.to_string(),
			issuer: leaf.issuer().iter_common_name().next().and_then(|cn| cn.as_str().ok()).unwrap_or("").to_string(),
			not_before: asn1_time(leaf.validity().not_before),
			not_after: asn1_time(leaf.validity().not_after),
		})
	}

	/// The ACME account shared by all domains. Its key lives in account.key as SEC1
	/// "EC PRIVATE KEY", the form the Go manager wrote and still reads after a rollback.
	async fn account(&self) -> Result<Account> {
		let path = format!("{}/account.key", self.certificates_dir);
		match std::fs::read_to_string(&path) {
			Ok(pem) => {
				let pkcs8 = pkcs8_from_pem(&pem)?;
				let key = instant_acme::Key::from_pkcs8_der(PrivatePkcs8KeyDer::from(pkcs8.clone()))?;
				let (account, _) = Account::builder()?
					.create_from_key((key, PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8))), self.directory_url.clone())
					.await
					.context("acme register")?;
				Ok(account)
			}
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				let contact = (!self.email.is_empty()).then(|| format!("mailto:{}", self.email));
				let contacts: Vec<&str> = contact.iter().map(String::as_str).collect();
				let (account, credentials) = Account::builder()?
					.create(
						&NewAccount { contact: &contacts, terms_of_service_agreed: true, only_return_existing: false },
						self.directory_url.clone(),
						None,
					)
					.await
					.context("acme register")?;
				std::fs::create_dir_all(&self.certificates_dir)?;
				write_atomic(&path, credentials_key_pem(&credentials)?.as_bytes(), 0o600)?;
				Ok(account)
			}
			Err(err) => Err(err.into()),
		}
	}
}

#[derive(Default)]
struct Cleanup {
	files: Vec<String>,
	records: Vec<dns01::Record>,
}

impl Cleanup {
	async fn run(self, issuer: &Issuer) {
		for file in self.files {
			let _ = std::fs::remove_file(file);
		}
		for record in self.records {
			record.remove(&issuer.token()).await;
		}
	}
}

fn pkcs8_from_pem(pem: &str) -> Result<Vec<u8>> {
	if pem.contains("BEGIN EC PRIVATE KEY") {
		let key = p256::SecretKey::from_sec1_pem(pem).map_err(|_| anyhow!("acme account key is not valid PEM"))?;
		return Ok(key.to_pkcs8_der().map_err(|err| anyhow!("acme account key: {err}"))?.as_bytes().to_vec());
	}
	let key = p256::SecretKey::from_pkcs8_pem(pem).map_err(|_| anyhow!("acme account key is not valid PEM"))?;
	Ok(key.to_pkcs8_der().map_err(|err| anyhow!("acme account key: {err}"))?.as_bytes().to_vec())
}

/// The key inside freshly created credentials, as SEC1 PEM for account.key.
fn credentials_key_pem(credentials: &AccountCredentials) -> Result<String> {
	use base64::Engine;
	let json = serde_json::to_value(credentials)?;
	let encoded = json["key_pkcs8"].as_str().ok_or_else(|| anyhow!("acme credentials carry no key"))?;
	let der = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('='))?;
	let key = p256::SecretKey::from_pkcs8_der(&der).map_err(|err| anyhow!("acme account key: {err}"))?;
	Ok(key.to_sec1_pem(LineEnding::LF).map_err(|err| anyhow!("acme account key: {err}"))?.to_string())
}

fn asn1_time(t: x509_parser::time::ASN1Time) -> DateTime<Utc> {
	DateTime::from_timestamp(t.timestamp(), 0).unwrap_or_default()
}

fn write_atomic(path: &str, data: &[u8], mode: u32) -> Result<()> {
	let tmp = format!("{path}.tmp");
	crate::security::write_file_mode(Path::new(&tmp), data, mode)?;
	std::fs::rename(&tmp, path)?;
	Ok(())
}

/// Stages both files before renaming either, so a failed write never leaves a
/// new chain beside the previous key: `exists` only checks both files are
/// present, and a mismatched pair breaks TLS until someone reissues by hand.
fn write_pair(dir: &str, fullchain: &[u8], key: &[u8]) -> Result<()> {
	let chain_path = format!("{dir}/fullchain.pem");
	let key_path = format!("{dir}/privkey.pem");
	crate::security::write_file_mode(Path::new(&format!("{chain_path}.tmp")), fullchain, 0o644)?;
	if let Err(err) = crate::security::write_file_mode(Path::new(&format!("{key_path}.tmp")), key, 0o600) {
		let _ = std::fs::remove_file(format!("{chain_path}.tmp"));
		return Err(err.into());
	}
	std::fs::rename(format!("{chain_path}.tmp"), &chain_path)?;
	std::fs::rename(format!("{key_path}.tmp"), &key_path)?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use base64::Engine;

	#[test]
	fn account_key_is_written_as_sec1_and_read_back() {
		let der = p256::SecretKey::from_slice(&[7u8; 32]).unwrap().to_pkcs8_der().unwrap().as_bytes().to_vec();
		let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&der);
		let credentials: AccountCredentials = serde_json::from_value(
			serde_json::json!({"id": "https://acme.test/acct/1", "key_pkcs8": encoded, "directory": "https://acme.test/dir"}),
		)
		.unwrap();

		let pem = credentials_key_pem(&credentials).unwrap();

		assert!(pem.starts_with("-----BEGIN EC PRIVATE KEY-----"), "{pem}");
		assert_eq!(pkcs8_from_pem(&pem).unwrap(), der);
	}
}
