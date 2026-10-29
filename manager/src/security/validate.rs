use std::sync::LazyLock;

use anyhow::{Result, bail};
use regex::Regex;

macro_rules! pattern {
	($name:ident, $re:expr) => {
		static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($re).unwrap());
	};
}

pattern!(HOSTNAME_LABEL, r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$");
pattern!(SLUG_PATTERN, r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$");
pattern!(ENV_KEY_PATTERN, r"^[A-Za-z_][A-Za-z0-9_]*$");
// Compose service names follow the same rules docker compose enforces.
pattern!(SERVICE_PATTERN, r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$");
pattern!(MOUNT_PATH_PATTERN, r"^/[a-zA-Z0-9._/-]{0,255}$");
// Docker's own rule for a container name: the compose one with a minimum of two characters.
pattern!(CONTAINER_PATTERN, r"^[a-zA-Z0-9][a-zA-Z0-9._-]+$");
pattern!(SSH_REPO_PATTERN, r"^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$");
// Interpolated into a clone URL and an API path: no query, fragment or other host.
pattern!(REPO_SEGMENT, r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$");
// A nested GitLab group clones as one path; traversal is what the slash must not buy.
pattern!(REPO_OWNER, r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$");

pub fn validate_repository_owner(owner: &str) -> Result<()> {
	if !REPO_OWNER.is_match(owner) || owner.contains("..") {
		bail!("invalid repository owner {owner:?}");
	}
	Ok(())
}

pub fn validate_repository_name(name: &str) -> Result<()> {
	if !REPO_SEGMENT.is_match(name) {
		bail!("invalid repository name {name:?}");
	}
	Ok(())
}

/// A DNS name usable as an Nginx server_name. A single leading "*." is allowed;
/// whether it can be issued is decided at certificate time (DNS-01 only).
pub fn validate_hostname(host: &str) -> Result<String> {
	let lowered = host.trim().to_lowercase();
	let h = lowered.strip_suffix('.').unwrap_or(&lowered);
	if h.is_empty() {
		bail!("domain is required");
	}
	if h.len() > 253 {
		bail!("domain is too long");
	}
	let bare = h.strip_prefix("*.").unwrap_or(h);
	if bare.contains('*') {
		bail!("a wildcard is only allowed as the leftmost label, as in *.example.com");
	}
	let labels: Vec<&str> = bare.split('.').collect();
	if labels.len() < 2 {
		bail!("domain must contain at least one dot");
	}
	for label in labels {
		if !HOSTNAME_LABEL.is_match(label) {
			bail!("invalid domain label {label:?}");
		}
	}
	Ok(h.to_string())
}

pub fn validate_port(port: i64) -> Result<()> {
	if !(1..=65535).contains(&port) {
		bail!("port must be between 1 and 65535");
	}
	Ok(())
}

pub fn validate_slug(slug: &str) -> Result<()> {
	if !SLUG_PATTERN.is_match(slug) {
		bail!("slug must be lowercase alphanumeric with dashes");
	}
	Ok(())
}

pub fn validate_service_name(name: &str) -> Result<()> {
	if !SERVICE_PATTERN.is_match(name) {
		bail!("invalid compose service name {name:?}");
	}
	Ok(())
}

/// A Dockerfile stage name; empty builds the last stage.
pub fn validate_build_target(raw: &str) -> Result<String> {
	let target = raw.trim();
	if !target.is_empty() && !SERVICE_PATTERN.is_match(target) {
		bail!("invalid build stage {raw:?}");
	}
	Ok(target.to_string())
}

/// Normalises one "volume:/path" per line. The path pattern keeps a ':' or a
/// space out, either of which would reshape the compose entry.
pub fn validate_mounts(raw: &str) -> Result<String> {
	let mut lines = Vec::new();
	for line in raw.lines() {
		let line = line.trim();
		if line.is_empty() {
			continue;
		}
		let valid = match line.split_once(':') {
			Some((volume, target)) => SERVICE_PATTERN.is_match(volume) && MOUNT_PATH_PATTERN.is_match(target) && !target.contains(".."),
			None => false,
		};
		if !valid {
			bail!("invalid mount {line:?}, expected volume:/absolute/path");
		}
		lines.push(line);
	}
	Ok(lines.join("\n"))
}

pub fn validate_container_name(name: &str) -> Result<()> {
	if name.len() > 63 || !CONTAINER_PATTERN.is_match(name) {
		bail!("invalid container name {name:?}");
	}
	Ok(())
}

pub fn validate_env_key(key: &str) -> Result<()> {
	if !ENV_KEY_PATTERN.is_match(key) {
		bail!("invalid environment variable name {key:?}");
	}
	Ok(())
}

fn has_whitespace(s: &str) -> bool {
	s.contains([' ', '\t', '\n', '\r'])
}

/// Accepts https/ssh git remotes only. Local file and ext:: transports would let
/// a repository URL read host files or execute commands during clone.
pub fn validate_git_url(raw: &str) -> Result<String> {
	let s = raw.trim();
	if s.is_empty() {
		bail!("repository URL is required");
	}
	if has_whitespace(s) {
		bail!("repository URL must not contain whitespace");
	}
	if s.starts_with('-') {
		bail!("repository URL must not start with a dash");
	}
	if SSH_REPO_PATTERN.is_match(s) {
		return Ok(s.to_string());
	}
	let u = url::Url::parse(s).map_err(|err| anyhow::anyhow!("invalid repository URL: {err}"))?;
	if !matches!(u.scheme(), "http" | "https" | "ssh") {
		bail!("unsupported git transport {:?}", u.scheme());
	}
	if u.host_str().unwrap_or("").is_empty() {
		bail!("repository URL is missing a host");
	}
	// ssh://git@host/... carries a login name, which is harmless. A secret in the
	// URL is not: it would be stored unencrypted and logged.
	let has_user = !u.username().is_empty() || u.password().is_some();
	if has_user && (u.password().is_some() || u.scheme() != "ssh") {
		bail!("store credentials in project settings, not in the URL");
	}
	Ok(s.to_string())
}

/// A value passed to a command as its own argument. There is no shell to
/// escape, but a leading dash would be read as an option. `kind` names the field.
pub fn validate_command_arg(kind: &str, value: &str) -> Result<String> {
	let v = value.trim();
	if v.is_empty() {
		bail!("{kind} is required");
	}
	if has_whitespace(v) {
		bail!("{kind} must not contain whitespace");
	}
	if v.starts_with('-') {
		bail!("{kind} must not start with a dash");
	}
	Ok(v.to_string())
}

/// A branch, tag or commit-ish; nothing that reads as a git option or shell metacharacter.
pub fn validate_git_ref(reference: &str) -> Result<String> {
	let r = reference.trim();
	if r.is_empty() {
		bail!("git ref is required");
	}
	if r.starts_with('-') || r.contains([' ', '\t', '\n', '\r', '~', '^', ':', '?', '*', '[', '\\']) || r.contains("..") {
		bail!("invalid git ref {reference:?}");
	}
	Ok(r.to_string())
}

/// A scheduled task's shell line, passed as one argv element to a shell inside
/// the user's own container: the reach the terminal already gives them.
pub fn validate_task_command(raw: &str) -> Result<String> {
	let cmd = raw.trim();
	if cmd.is_empty() {
		bail!("command is required");
	}
	if cmd.len() > 4096 {
		bail!("command is too long");
	}
	if cmd.contains('\0') {
		bail!("command must not contain null bytes");
	}
	Ok(cmd.to_string())
}

/// The interpreter a task's command is fed to: one of two constants, never user text.
pub fn validate_task_shell(raw: &str) -> Result<String> {
	match raw.trim() {
		"sh" | "bash" => Ok(raw.trim().to_string()),
		"" => Ok("sh".into()),
		_ => bail!("shell must be sh or bash"),
	}
}

/// A path that must stay inside the directory it is joined to, returned without
/// its leading slash. ".." is rejected rather than cleaned away: a build path
/// lands in a docker build context.
pub fn validate_sub_path(raw: &str) -> Result<String> {
	let p = raw.trim().trim_matches('/');
	if p.is_empty() {
		return Ok(String::new());
	}
	if p.contains(['\\', '\n', '\r', '\t']) || p == ".." || p.starts_with("../") || super::clean_path(p) != p {
		bail!("invalid path {raw:?}");
	}
	Ok(p.to_string())
}
