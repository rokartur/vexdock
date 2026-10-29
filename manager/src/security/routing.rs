use std::sync::LazyLock;

use anyhow::{Result, bail};
use regex::Regex;

use super::validate_port;

// A capture reference in a redirect replacement, in nginx's $1 form or the
// ${1} form Traefik and Dokploy use.
static CAPTURE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{?([0-9])\}?").unwrap());

/// Checks a redirect before it is written into a quoted nginx string, and
/// returns the replacement with ${N} rewritten to nginx's $N. The regex must
/// compile and must not end the quoted string or turn into something else
/// through nginx's own \" \\ \t \r \n unescaping.
pub fn validate_redirect(regex: &str, replacement: &str) -> Result<String> {
	if regex.is_empty() || replacement.is_empty() {
		bail!("regex and replacement are required");
	}
	if regex.len() > 500 || replacement.len() > 500 {
		bail!("regex and replacement must be at most 500 characters");
	}
	if !quotable(regex) || !quotable(replacement) {
		bail!("regex and replacement must not contain quotes or control characters");
	}
	let bytes = regex.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'\\' {
			if i == bytes.len() - 1 || b"\\'trn".contains(&bytes[i + 1]) {
				bail!(r"regex must not end in \ or use \\, \', \t, \r or \n");
			}
			i += 1;
		}
		i += 1;
	}
	if let Err(err) = Regex::new(regex) {
		bail!("invalid regex: {err}");
	}
	if replacement.contains('\\') {
		bail!(r"replacement must not contain \");
	}
	let normalized = CAPTURE_REF.replace_all(replacement, "$$$1").into_owned();
	if normalized.matches('$').count() != CAPTURE_REF.find_iter(&normalized).count() {
		bail!("replacement may only use $ for a capture such as $1");
	}
	Ok(normalized)
}

/// A user for an htpasswd file, where a colon ends the name and a newline ends
/// the entry. The password is only ever hashed.
pub fn validate_basic_auth_user(username: &str, password: &str) -> Result<()> {
	if username.is_empty() || password.is_empty() {
		bail!("username and password are required");
	}
	if username.len() > 100 || password.len() > 200 {
		bail!("username must be at most 100 and password at most 200 characters");
	}
	if username.contains(':') || !quotable(username) {
		bail!("username must not contain a colon, quotes or control characters");
	}
	Ok(())
}

/// A host port mapping. 80 and 443 belong to nginx.
pub fn validate_published_port(published: i64, target: i64, protocol: &str) -> Result<()> {
	if let Err(err) = validate_port(published) {
		bail!("published {err}");
	}
	if let Err(err) = validate_port(target) {
		bail!("target {err}");
	}
	if published == 80 || published == 443 {
		bail!("ports 80 and 443 are used by the platform's proxy");
	}
	if protocol != "tcp" && protocol != "udp" {
		bail!("protocol must be tcp or udp");
	}
	Ok(())
}

fn quotable(s: &str) -> bool {
	!s.chars().any(|r| (r as u32) < 0x20 || r as u32 == 0x7f || r == '"')
}
