//! GitHub connects as a GitHub App, never a personal access token: an App
//! reaches only the repositories its owner ticked, and the manifest flow hands
//! back the credentials so nobody pastes a private key.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use rustls::pki_types::PrivateKeyDer;
use rustls::pki_types::pem::PemObject;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;

use super::{PROVIDER_GITHUB, api_error, path_escape, provider_http, query_escape};

/// The App description posted to GitHub.
#[derive(Clone, Debug, Serialize)]
pub struct AppManifest {
	pub name: String,
	pub url: String,
	pub redirect_url: String,
	pub setup_url: String,
	/// Brings the owner back whenever they change which repositories the App
	/// reaches, so the stored installation stays truthful.
	pub setup_on_update: bool,
	pub hook_attributes: Value,
	pub public: bool,
	pub default_events: Vec<String>,
	pub default_permissions: HashMap<String, String>,
}

/// The App the manager wants. `public_url` decides both where GitHub returns
/// the owner and where it delivers pushes.
pub fn new_app_manifest(name: &str, public_url: &str) -> AppManifest {
	let base = public_url.trim_end_matches('/');
	AppManifest {
		name: name.to_string(),
		url: base.to_string(),
		redirect_url: format!("{base}/api/providers/github/callback"),
		setup_url: format!("{base}/api/providers/github/installed"),
		setup_on_update: true,
		hook_attributes: json!({"url": format!("{base}/api/deploy/github"), "active": true}),
		public: false,
		default_events: vec!["push".into()],
		// The least an App needs to clone a repository and follow its pushes. Nothing may write.
		default_permissions: HashMap::from([("contents".into(), "read".into()), ("metadata".into(), "read".into())]),
	}
}

/// What GitHub returns once a manifest becomes an App.
#[derive(Clone, Debug, Default)]
pub struct AppCredentials {
	pub app_id: String,
	pub slug: String,
	pub name: String,
	pub client_id: String,
	pub client_secret: String,
	pub private_key: String,
	pub webhook_secret: String,
}

/// Trades the one-time code GitHub sends to the manifest callback for the App's
/// credentials. The code is valid once and for an hour.
pub async fn exchange_app_manifest(host: &str, code: &str) -> Result<AppCredentials> {
	#[derive(Deserialize)]
	struct Payload {
		#[serde(default)]
		id: i64,
		#[serde(default)]
		slug: String,
		#[serde(default)]
		name: String,
		#[serde(default)]
		client_id: String,
		#[serde(default)]
		client_secret: String,
		#[serde(default)]
		pem: String,
		#[serde(default)]
		webhook_secret: Option<String>,
	}
	let endpoint = format!("{}/app-manifests/{}/conversions", api_root(host), path_escape(code));
	let payload: Payload = serde_json::from_value(github_call(reqwest::Method::POST, &endpoint, "").await?)?;
	if payload.id == 0 || payload.pem.is_empty() {
		bail!("github created the app without a key");
	}
	Ok(AppCredentials {
		app_id: payload.id.to_string(),
		slug: payload.slug,
		name: payload.name,
		client_id: payload.client_id,
		client_secret: payload.client_secret,
		private_key: payload.pem,
		webhook_secret: payload.webhook_secret.unwrap_or_default(),
	})
}

/// Where the owner picks which repositories the App may read. GitHub returns to
/// the setup URL with the installation id, the credential that actually clones.
pub fn install_url(host: &str, slug: &str, state: &str) -> String {
	format!("{}/apps/{}/installations/new?state={}", host.trim_end_matches('/'), path_escape(slug), query_escape(state))
}

/// A minted token kept for the hour it lives, keyed by installation: a deploy,
/// a repository listing and a branch listing in the same minute should not be
/// three round trips to GitHub.
static TOKEN_CACHE: LazyLock<Mutex<HashMap<String, CachedToken>>> = LazyLock::new(Default::default);

/// A token and when it stops working.
type CachedToken = (String, DateTime<Utc>);

/// The short-lived token an App installation clones and reads with, minting a
/// new one when the cached one is close to expiring.
pub async fn installation_token(host: &str, app_id: &str, private_key: &str, installation_id: &str) -> Result<String> {
	if app_id.is_empty() || private_key.is_empty() {
		bail!("the github app has not been created yet");
	}
	if installation_id.is_empty() {
		bail!("the github app is not installed on an account yet");
	}
	if let Some((token, expires)) = TOKEN_CACHE.lock().unwrap_or_else(|p| p.into_inner()).get(installation_id)
		&& Utc::now() < *expires
	{
		return Ok(token.clone());
	}
	#[derive(Deserialize)]
	struct Payload {
		#[serde(default)]
		token: String,
		expires_at: DateTime<Utc>,
	}
	let assertion = app_jwt(app_id, private_key)?;
	let endpoint = format!("{}/app/installations/{}/access_tokens", api_root(host), path_escape(installation_id));
	let payload: Payload = serde_json::from_value(github_call(reqwest::Method::POST, &endpoint, &assertion).await?)?;
	if payload.token.is_empty() {
		bail!("github returned no installation token");
	}
	// A minute of slack so a token cannot expire between being handed out and used.
	TOKEN_CACHE
		.lock()
		.unwrap_or_else(|p| p.into_inner())
		.insert(installation_id.to_string(), (payload.token.clone(), payload.expires_at - chrono::Duration::minutes(1)));
	Ok(payload.token)
}

/// Drops a cached token, so a disconnected account leaves nothing usable in memory.
pub fn forget_installation(installation_id: &str) {
	TOKEN_CACHE.lock().unwrap_or_else(|p| p.into_inner()).remove(installation_id);
}

/// `bearer` is an App JWT, an installation token, or empty for the
/// unauthenticated manifest exchange.
async fn github_call(method: reqwest::Method, endpoint: &str, bearer: &str) -> Result<Value> {
	let mut request = provider_http()
		.request(method, endpoint)
		.header("Accept", "application/vnd.github+json")
		.header("X-GitHub-Api-Version", "2022-11-28")
		.header("User-Agent", "vexdock");
	if !bearer.is_empty() {
		request = request.bearer_auth(bearer);
	}
	let response = request.send().await?;
	if !response.status().is_success() {
		return Err(api_error(PROVIDER_GITHUB, response).await);
	}
	Ok(response.json().await?)
}

/// The App's proof of identity: a ten minute RS256 token signed with the
/// private key, the only thing GitHub accepts for minting installation tokens.
fn app_jwt(app_id: &str, private_key: &str) -> Result<String> {
	let key = parse_private_key(private_key)?;
	// Backdated because GitHub rejects an iat even slightly in its future.
	let now = Utc::now().timestamp() - 30;
	let claims = json!({"iat": now, "exp": now + 9 * 60, "iss": app_id});
	let signing_input =
		format!("{}.{}", URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#), URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?));
	let mut signature = vec![0u8; key.public().modulus_len()];
	key.sign(&ring::signature::RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), signing_input.as_bytes(), &mut signature)
		.map_err(|_| anyhow!("sign the app token"))?;
	Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

/// Reads the PEM GitHub generated. It ships PKCS#1, but a key re-saved by
/// another tool comes back PKCS#8, and both are RSA.
fn parse_private_key(private_key: &str) -> Result<ring::rsa::KeyPair> {
	let der = PrivateKeyDer::from_pem_slice(private_key.trim().as_bytes()).map_err(|_| anyhow!("the app key is not a PEM private key"))?;
	match der {
		PrivateKeyDer::Pkcs1(key) => ring::rsa::KeyPair::from_der(key.secret_pkcs1_der()),
		PrivateKeyDer::Pkcs8(key) => ring::rsa::KeyPair::from_pkcs8(key.secret_pkcs8_der()),
		_ => return Err(anyhow!("the app key is not an RSA private key")),
	}
	.map_err(|_| anyhow!("the app key is not a usable private key"))
}

/// GitHub's API for a host: a separate domain on github.com, a path prefix on
/// Enterprise Server.
pub fn api_root(host: &str) -> String {
	let host = host.trim_end_matches('/');
	if host.is_empty() || host == "https://github.com" {
		return "https://api.github.com".into();
	}
	format!("{host}/api/v3")
}

/// Whether a delivery came from the App whose webhook secret this is. GitHub
/// signs the raw body, so this runs before any parsing, in constant time.
pub fn verify_webhook_signature(secret: &str, body: &[u8], signature: &str) -> bool {
	if secret.is_empty() || signature.is_empty() {
		return false;
	}
	let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac takes any key length");
	mac.update(body);
	let want = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
	subtle::ConstantTimeEq::ct_eq(want.as_bytes(), signature.as_bytes()).into()
}

#[cfg(test)]
mod tests {
	use rsa::pkcs1::EncodeRsaPrivateKey;
	use rsa::signature::Verifier;

	use super::*;

	/// The JWT is signed by hand, so check it is what GitHub accepts: three
	/// segments, the header and claims it expects, a signature that verifies.
	#[test]
	fn app_jwt_is_signed_rs256() {
		let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
		let pem = key.to_pkcs1_pem(rsa::pkcs8::LineEnding::LF).unwrap();
		let token = app_jwt("12345", &pem).unwrap();
		let parts: Vec<&str> = token.split('.').collect();
		assert_eq!(parts.len(), 3);
		assert_eq!(URL_SAFE_NO_PAD.decode(parts[0]).unwrap(), br#"{"alg":"RS256","typ":"JWT"}"#);
		let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
		assert_eq!(claims["iss"], "12345");
		assert!(claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap() <= 600, "GitHub caps a token at ten minutes");
		let verifying = rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(key.to_public_key());
		let signature = rsa::pkcs1v15::Signature::try_from(URL_SAFE_NO_PAD.decode(parts[2]).unwrap().as_slice()).unwrap();
		verifying.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).expect("signature verifies");
	}

	#[test]
	fn webhook_signature() {
		let body = br#"{"ref":"refs/heads/main"}"#;
		let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
		mac.update(body);
		let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
		assert!(verify_webhook_signature("secret", body, &signature));
		assert!(!verify_webhook_signature("secret", b"tampered", &signature));
		assert!(!verify_webhook_signature("other", body, &signature));
		assert!(!verify_webhook_signature("", body, &signature));
	}

	#[test]
	fn escapes_like_go() {
		assert_eq!(path_escape("a/b c"), "a%2Fb%20c");
		assert_eq!(query_escape("a b&c"), "a+b%26c");
	}
}
