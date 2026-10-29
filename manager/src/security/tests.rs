use super::*;

#[test]
fn cipher_round_trip() {
	let c = Cipher::new(&[0u8; 32]).unwrap();
	let secret = "postgres://user:p@ssw0rd@db:5432/app";
	let sealed = c.encrypt(secret).unwrap();
	assert!(!sealed.contains("p@ssw0rd"), "ciphertext leaks the plaintext");
	assert_eq!(c.decrypt(&sealed).unwrap(), secret);
	// A fresh nonce every time, otherwise equal secrets are linkable in the database.
	assert_ne!(c.encrypt(secret).unwrap(), sealed, "encryption is deterministic");
	assert!(c.decrypt("not base64 $$").is_err());
}

#[test]
fn resolve_inside_blocks_traversal() {
	let base = tempfile::tempdir().unwrap();
	let base = base.path().to_str().unwrap();
	assert_eq!(resolve_inside(base, "stack/compose.yml").unwrap(), format!("{base}/stack/compose.yml"));
	for bad in ["../etc/passwd", "a/../../b", "/etc/passwd", "", "a/\0b"] {
		assert!(resolve_inside(base, bad).is_err(), "path {bad:?} should have been rejected");
	}
}

#[test]
fn clean_path_matches_go() {
	for (input, want) in [("a//b/./c/..", "a/b"), ("/../x", "/x"), ("../a", "../a"), ("", "."), ("a/..", "."), ("/", "/")] {
		assert_eq!(clean_path(input), want, "{input:?}");
	}
}

#[test]
fn hostname() {
	assert_eq!(validate_hostname("  App.Example.COM. ").unwrap(), "app.example.com");
	assert_eq!(validate_hostname("*.Example.com").unwrap(), "*.example.com");
	for bad in ["", "localhost", "*.*.example.com", "a.*.example.com", "ex*ample.com", "-bad.example.com", "ex ample.com", "a..b.com"] {
		assert!(validate_hostname(bad).is_err(), "hostname {bad:?} should have been rejected");
	}
}

#[test]
fn port_and_env_key() {
	assert!(validate_port(3000).is_ok());
	for bad in [0, -1, 70000] {
		assert!(validate_port(bad).is_err());
	}
	assert!(validate_env_key("DATABASE_URL").is_ok());
	for bad in ["1BAD", "has-dash", "has space", ""] {
		assert!(validate_env_key(bad).is_err());
	}
}

#[test]
fn mounts() {
	assert_eq!(validate_mounts(" push:/data \n\nuploads:/srv/app/uploads\n").unwrap(), "push:/data\nuploads:/srv/app/uploads");
	// A host path or a second colon would bind the host filesystem or set mount options.
	for bad in ["/etc:/data", "push:data", "push:/../etc", "push:/data:ro", "push"] {
		assert!(validate_mounts(bad).is_err(), "mount {bad:?} accepted");
	}
}

#[test]
fn git_url() {
	for good in ["https://github.com/user/app.git", "ssh://git@github.com/user/app.git", "git@github.com:user/app.git"] {
		assert!(validate_git_url(good).is_ok(), "{good}");
	}
	// file:// and ext:: transports can read host files or run commands.
	for bad in [
		"file:///etc/passwd",
		"ext::sh -c 'touch /tmp/pwned'",
		"--upload-pack=touch /tmp/pwned",
		"https://user:token@github.com/user/app.git",
		"https://github.com/user/app.git extra",
		"",
	] {
		assert!(validate_git_url(bad).is_err(), "git url {bad:?} should have been rejected");
	}
}

#[test]
fn git_ref() {
	assert!(validate_git_ref("main").is_ok());
	for bad in ["--exec=rm", "a b", "a..b", "ref^", "", "with\nnewline"] {
		assert!(validate_git_ref(bad).is_err(), "ref {bad:?}");
	}
}

#[test]
fn task_shell() {
	for (raw, want) in [("sh", "sh"), ("bash", "bash"), (" bash ", "bash"), ("", "sh")] {
		assert_eq!(validate_task_shell(raw).unwrap(), want);
	}
	for bad in ["zsh", "sh -c", "../../usr/bin/env", "sh;id", "SH"] {
		assert!(validate_task_shell(bad).is_err(), "{bad}");
	}
}

#[test]
fn random_token_is_unique() {
	let mut seen = std::collections::HashSet::new();
	for _ in 0..100 {
		assert!(seen.insert(random_token(24)), "random_token repeated a value");
	}
	assert_ne!(hash_token("a"), hash_token("b"));
}

#[test]
fn command_arg_rejects_option_lookalikes() {
	assert_eq!(validate_command_arg("url", "  ghcr.io ").unwrap(), "ghcr.io");
	assert!(validate_command_arg("url", "registry.example.com:5000").is_ok());
	for bad in ["", "   ", "--config=/tmp/x", "-v", "ghcr.io extra", "gh\tcr.io", "ghcr.io\n--help"] {
		assert!(validate_command_arg("url", bad).is_err(), "{bad:?}");
	}
}

#[test]
fn redirect() {
	assert_eq!(validate_redirect(r"^https?://(?:www\.)?(.+)", "https://www.${1}").unwrap(), "https://www.$1");
	for (regex, replacement) in [
		(r#"^http://(.*)"; }"#, "https://$1"),
		("^(.*)\n", "https://$1"),
		(r"^(.*)\", "https://$1"),
		(r"^(.*)\n", "https://$1"),
		("^(.*", "https://$1"),
		("^(.*)", "https://$host$1"),
		("^(.*)", r"https://\$1"),
		("", "https://x"),
	] {
		assert!(validate_redirect(regex, replacement).is_err(), "accepted {regex:?} {replacement:?}");
	}
}

#[test]
fn basic_auth_and_ports() {
	assert!(validate_basic_auth_user("admin", r#"p"a:ss"#).is_ok());
	for name in ["", "a:b", "a\nb"] {
		assert!(validate_basic_auth_user(name, "pw").is_err(), "{name:?}");
	}
	assert!(validate_published_port(8080, 80, "tcp").is_ok());
	for (published, target, protocol) in [(443, 443, "tcp"), (0, 80, "tcp"), (8080, 70000, "tcp"), (8080, 80, "sctp")] {
		assert!(validate_published_port(published, target, protocol).is_err());
	}
}

#[test]
fn sub_path() {
	assert_eq!(validate_sub_path("/apps/web/").unwrap(), "apps/web");
	assert_eq!(validate_sub_path("").unwrap(), "");
	for bad in ["..", "../x", "a/../b", "a//b", "a\\b"] {
		assert!(validate_sub_path(bad).is_err(), "{bad:?}");
	}
}
