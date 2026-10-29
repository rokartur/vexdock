use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use x509_parser::prelude::{FromDer, GeneralName, X509Certificate};

use super::{CertResult, Issuer, asn1_time, write_pair};

/// Checks that a user-supplied certificate and key belong together and cover
/// the hostname, before anything touches disk. Nginx would refuse to start on
/// a mismatch, so this is the difference between a clear error in the form and
/// a proxy that will not reload.
pub fn validate(hostname: &str, cert_pem: &str, key_pem: &str) -> Result<CertResult> {
	let (cert_pem, key_pem) = (cert_pem.trim(), key_pem.trim());
	if cert_pem.is_empty() {
		bail!("the certificate is required");
	}
	if key_pem.is_empty() {
		bail!("the private key is required");
	}
	let leaf_der = key_pair_leaf(cert_pem, key_pem).map_err(|err| anyhow!("certificate and key do not form a valid pair: {err}"))?;
	let (_, leaf) = X509Certificate::from_der(&leaf_der).map_err(|err| anyhow!("parse certificate: {err}"))?;
	if !covers(&leaf, hostname) {
		bail!("this certificate is not valid for {hostname}: x509: certificate is not valid for {hostname}");
	}
	let not_before = asn1_time(leaf.validity().not_before);
	let not_after = asn1_time(leaf.validity().not_after);
	let now = Utc::now();
	if now < not_before {
		bail!("this certificate is not valid until {}", not_before.format("%Y-%m-%dT%H:%M:%SZ"));
	}
	if now > not_after {
		bail!("this certificate expired on {}", not_after.format("%Y-%m-%dT%H:%M:%SZ"));
	}
	Ok(CertResult { hostname: hostname.to_string(), issuer: issuer_name(&leaf), not_before, not_after })
}

/// Parses both halves and verifies the key matches the leaf certificate, the
/// way Go's tls.X509KeyPair does. Returns the leaf.
fn key_pair_leaf(cert_pem: &str, key_pem: &str) -> Result<Vec<u8>> {
	let leaf = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
		.next()
		.ok_or_else(|| anyhow!("failed to find any PEM data in certificate input"))??;
	let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).map_err(|_| anyhow!("failed to find any PEM data in key input"))?;
	let provider = Arc::new(rustls::crypto::ring::default_provider());
	let signing_key = provider.key_provider.load_private_key(key)?;
	let certified = rustls::sign::CertifiedKey::new(vec![leaf.clone()], signing_key);
	certified.keys_match().map_err(|_| anyhow!("private key does not match public key"))?;
	Ok(leaf.to_vec())
}

/// Go's VerifyHostname: DNS SANs only, a leftmost `*` covers exactly one label,
/// and a wildcard hostname matches only the same wildcard.
fn covers(leaf: &X509Certificate, hostname: &str) -> bool {
	let host = hostname.trim_end_matches('.').to_lowercase();
	let Ok(Some(san)) = leaf.subject_alternative_name() else { return false };
	san.value.general_names.iter().any(|name| {
		let GeneralName::DNSName(pattern) = name else { return false };
		let pattern = pattern.trim_end_matches('.').to_lowercase();
		if pattern == host {
			return true;
		}
		match (pattern.strip_prefix("*."), host.contains('*')) {
			(Some(rest), false) => host.split_once('.').is_some_and(|(first, tail)| !first.is_empty() && tail == rest),
			_ => false,
		}
	})
}

fn issuer_name(leaf: &X509Certificate) -> String {
	let issuer = leaf.issuer();
	if let Some(cn) = issuer.iter_common_name().next().and_then(|cn| cn.as_str().ok()) {
		return cn.to_string();
	}
	if let Some(org) = issuer.iter_organization().next().and_then(|o| o.as_str().ok()) {
		return org.to_string();
	}
	let text = issuer.to_string();
	if text.is_empty() { "unknown".into() } else { text }
}

impl Issuer {
	/// Validates a user-supplied pair and writes it where Nginx reads
	/// certificates, replacing whatever was there before.
	pub fn install_custom(&self, hostname: &str, cert_pem: &str, key_pem: &str) -> Result<CertResult> {
		let result = validate(hostname, cert_pem, key_pem)?;
		let dir = self.dir(hostname);
		std::fs::create_dir_all(&dir)?;
		write_pair(&dir, format!("{}\n", cert_pem.trim()).as_bytes(), format!("{}\n", key_pem.trim()).as_bytes())?;
		Ok(result)
	}

	/// Deletes the stored certificate for a hostname, used when a domain switches
	/// issuance source so a stale file cannot be served.
	pub fn remove(&self, hostname: &str) -> Result<()> {
		match std::fs::remove_dir_all(self.dir(hostname)) {
			Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
			_ => Ok(()),
		}
	}
}

#[cfg(test)]
mod tests {
	use std::os::unix::fs::PermissionsExt;

	use rcgen::{CertificateParams, DnType, IsCa, KeyPair};
	use time::{Duration, OffsetDateTime};

	use super::*;

	/// A leaf for hostname signed by a throwaway CA, as (cert PEM, key PEM).
	fn issued(hostname: &str, not_before: OffsetDateTime, not_after: OffsetDateTime) -> (String, String) {
		let ca_key = KeyPair::generate().unwrap();
		let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
		ca.is_ca = IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
		ca.distinguished_name.push(DnType::CommonName, "Test Issuing CA");
		ca.not_before = not_before - Duration::hours(1);
		ca.not_after = not_after + Duration::hours(1);
		let issuer = rcgen::Issuer::new(ca, ca_key);
		let key = KeyPair::generate().unwrap();
		let mut leaf = CertificateParams::new(vec![hostname.to_string()]).unwrap();
		leaf.distinguished_name.push(DnType::CommonName, hostname);
		leaf.not_before = not_before;
		leaf.not_after = not_after;
		let leaf = leaf.signed_by(&key, &issuer).unwrap();
		(leaf.pem(), key.serialize_pem())
	}

	fn now() -> OffsetDateTime {
		OffsetDateTime::now_utc()
	}

	#[test]
	fn accepts_matching_pair() {
		let (cert, key) = issued("app.example.com", now() - Duration::hours(1), now() + Duration::days(90));
		let result = validate("app.example.com", &cert, &key).unwrap();
		assert_eq!(result.hostname, "app.example.com");
		assert_eq!(result.issuer, "Test Issuing CA");
	}

	#[test]
	fn rejects_bad_input() {
		let (cert, key) = issued("app.example.com", now() - Duration::hours(1), now() + Duration::days(1));
		let (_, other_key) = issued("app.example.com", now() - Duration::hours(1), now() + Duration::days(1));
		let (expired_cert, expired_key) = issued("app.example.com", now() - Duration::hours(48), now() - Duration::hours(1));
		let (future_cert, future_key) = issued("app.example.com", now() + Duration::hours(24), now() + Duration::hours(48));
		let cases = [
			("empty certificate", "app.example.com", "", key.as_str(), "certificate is required"),
			("empty key", "app.example.com", cert.as_str(), "", "private key is required"),
			("garbage certificate", "app.example.com", "not a pem block", key.as_str(), "valid pair"),
			("key belongs to another certificate", "app.example.com", cert.as_str(), other_key.as_str(), "valid pair"),
			("wrong hostname", "other.example.com", cert.as_str(), key.as_str(), "not valid for other.example.com"),
			("expired", "app.example.com", expired_cert.as_str(), expired_key.as_str(), "expired"),
			("not yet valid", "app.example.com", future_cert.as_str(), future_key.as_str(), "not valid until"),
		];
		for (name, hostname, cert, key, wants) in cases {
			let err = validate(hostname, cert, key).expect_err(name);
			assert!(err.to_string().contains(wants), "{name}: {err} does not mention {wants:?}");
		}
	}

	#[test]
	fn install_custom_writes_where_nginx_reads() {
		let dir = tempfile::tempdir().unwrap();
		let base = dir.path().to_str().unwrap();
		let issuer = Issuer::new(base.into(), format!("{base}/challenge"), String::new(), String::new());
		let (cert, key) = issued("app.example.com", now() - Duration::hours(1), now() + Duration::days(1));
		issuer.install_custom("app.example.com", &cert, &key).unwrap();
		assert!(issuer.exists("app.example.com"));
		assert!(issuer.expiry("app.example.com").unwrap() > Utc::now());
		let mode = std::fs::metadata(format!("{}/privkey.pem", issuer.dir("app.example.com"))).unwrap().permissions().mode();
		assert_eq!(mode & 0o777, 0o600, "the private key must not be world readable");
		assert!(issuer.install_custom("app.example.com", "broken", &key).is_err());
		assert!(issuer.exists("app.example.com"), "a rejected upload removed the previous certificate");
		issuer.remove("app.example.com").unwrap();
		assert!(!issuer.exists("app.example.com"));
		issuer.remove("app.example.com").unwrap();
	}

	#[test]
	fn wildcard_san_covers_one_label() {
		let (cert, key) = issued("*.example.com", now() - Duration::hours(1), now() + Duration::days(1));
		assert!(validate("app.example.com", &cert, &key).is_ok());
		assert!(validate("*.example.com", &cert, &key).is_ok());
		assert!(validate("a.b.example.com", &cert, &key).is_err());
	}
}
