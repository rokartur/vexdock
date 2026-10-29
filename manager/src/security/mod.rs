//! What every privileged path in the manager depends on: secret encryption,
//! path confinement, input validation and webhook signature verification.

mod routing;
mod validate;

pub use routing::*;
pub use validate::*;

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Encrypts values at rest with AES-256-GCM. The key never lives in the
/// database it protects; it is a 0600 file under <root>/secrets.
pub struct Cipher {
	aead: Aes256Gcm,
}

const NONCE_SIZE: usize = 12;

impl Cipher {
	/// Reads the master key, generating one on first boot.
	pub fn load_or_create(key_path: &Path) -> Result<Cipher> {
		let key = match std::fs::read(key_path) {
			Ok(key) => key,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				let mut key = vec![0u8; 32];
				rand::thread_rng().fill_bytes(&mut key);
				if let Some(dir) = key_path.parent() {
					create_dir_mode(dir, 0o700)?;
				}
				write_file_mode(key_path, &key, 0o600).context("write master key")?;
				key
			}
			Err(err) => return Err(err).context("read master key"),
		};
		Cipher::new(&key)
	}

	pub fn new(key: &[u8]) -> Result<Cipher> {
		if key.len() != 32 {
			bail!("master key must be 32 bytes, got {}", key.len());
		}
		Ok(Cipher { aead: Aes256Gcm::new_from_slice(key)? })
	}

	/// Returns a base64 nonce||ciphertext blob safe to store in SQLite.
	pub fn encrypt(&self, plaintext: &str) -> Result<String> {
		let mut nonce = [0u8; NONCE_SIZE];
		rand::thread_rng().fill_bytes(&mut nonce);
		let sealed = self.aead.encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes()).map_err(|_| anyhow::anyhow!("encrypt secret"))?;
		let mut blob = nonce.to_vec();
		blob.extend_from_slice(&sealed);
		Ok(STANDARD.encode(blob))
	}

	pub fn decrypt(&self, encoded: &str) -> Result<String> {
		let raw = STANDARD.decode(encoded).context("decode secret")?;
		if raw.len() < NONCE_SIZE {
			bail!("secret payload truncated");
		}
		let (nonce, ciphertext) = raw.split_at(NONCE_SIZE);
		let plain = self.aead.decrypt(Nonce::from_slice(nonce), ciphertext).map_err(|_| anyhow::anyhow!("decrypt secret"))?;
		Ok(String::from_utf8(plain)?)
	}
}

/// What the dashboard shows in place of a secret. A variable written back as
/// exactly this means "unchanged".
pub const MASKED_VALUE: &str = "••••••••••••";

/// A URL-safe random token of n bytes of entropy.
pub fn random_token(n: usize) -> String {
	let mut buf = vec![0u8; n];
	rand::thread_rng().fill_bytes(&mut buf);
	URL_SAFE_NO_PAD.encode(buf)
}

/// The one-way transform for API tokens at rest.
pub fn hash_token(token: &str) -> String {
	hex::encode(Sha256::digest(token.as_bytes()))
}

/// Joins a user-supplied relative path onto base and guarantees the result
/// stays inside base. The single guard against path traversal for compose
/// file paths, backup names and project file access.
pub fn resolve_inside(base: &str, rel: &str) -> Result<String> {
	if rel.is_empty() {
		bail!("path is required");
	}
	if rel.starts_with('/') {
		bail!("absolute paths are not allowed: {rel:?}");
	}
	if rel.contains('\0') {
		bail!("path contains a null byte");
	}
	let clean_base = clean_path(base);
	let target = clean_path(&format!("{clean_base}/{rel}"));
	if target != clean_base && !target.starts_with(&format!("{clean_base}/")) {
		bail!("path escapes its project directory: {rel:?}");
	}
	Ok(target)
}

/// Lexical path cleaning with the rules of Go's path.Clean: collapse
/// separators, drop `.`, resolve `..` against the previous element.
pub fn clean_path(path: &str) -> String {
	if path.is_empty() {
		return ".".into();
	}
	let rooted = path.starts_with('/');
	let mut parts: Vec<&str> = Vec::new();
	for part in path.split('/') {
		match part {
			"" | "." => {}
			".." => {
				if parts.last().is_some_and(|last| *last != "..") {
					parts.pop();
				} else if !rooted {
					parts.push("..");
				}
			}
			part => parts.push(part),
		}
	}
	let joined = parts.join("/");
	match (rooted, joined.is_empty()) {
		(true, _) => format!("/{joined}"),
		(false, true) => ".".into(),
		(false, false) => joined,
	}
}

pub fn create_dir_mode(dir: &Path, mode: u32) -> std::io::Result<()> {
	use std::os::unix::fs::DirBuilderExt;
	std::fs::DirBuilder::new().recursive(true).mode(mode).create(dir)
}

pub fn write_file_mode(path: &Path, data: &[u8], mode: u32) -> std::io::Result<()> {
	use std::io::Write;
	use std::os::unix::fs::OpenOptionsExt;
	let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(path)?;
	file.write_all(data)
}

#[cfg(test)]
mod tests;
