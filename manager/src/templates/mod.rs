//! The catalog of one-click applications: a curated stack of compose services,
//! the variables it needs seeded and where its domain points.
//!
//! A template renders into ordinary raw services, one row per compose service,
//! so nothing downstream knows a template existed. Its values are seeded as
//! environment variables and reached through ${VAR}, which compose interpolates
//! from the environment's .env file; that is what lets two services of one
//! template share a password the user can still edit.

mod catalog;

pub use catalog::CATALOG;

use anyhow::{Result, bail};
use serde::Serialize;

use crate::security;

/// The placeholders a variable's value may carry instead of a literal. HOSTNAME
/// becomes the domain the user typed; GENERATE a fresh random secret, the only
/// kind stored as one.
pub const HOSTNAME: &str = "{hostname}";
pub const GENERATE: &str = "{generate}";

/// One entry a template seeds into the environment, as the catalog declares it.
#[derive(Clone, Debug)]
pub struct Var {
	pub key: &'static str,
	pub value: &'static str,
}

/// One resolved entry. `secret` is decided by render: a generated value is a
/// credential, a literal or a hostname never is.
#[derive(Clone, Debug, Default)]
pub struct Variable {
	pub key: String,
	pub value: String,
	pub secret: bool,
}

/// One compose service of a template: its key in the generated file and the
/// body at zero indentation, the shape a pasted compose service has.
#[derive(Clone, Debug, Serialize)]
pub struct Service {
	pub name: &'static str,
	#[serde(skip)]
	pub fragment: &'static str,
}

/// The service and container port a hostname should reach. None for a template
/// nothing addresses from outside.
#[derive(Clone, Debug, Serialize)]
pub struct Domain {
	pub service: &'static str,
	pub port: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Template {
	pub slug: &'static str,
	pub name: &'static str,
	pub description: &'static str,
	pub tags: &'static [&'static str],
	pub services: &'static [Service],
	pub domain: Option<Domain>,
	/// Internal: values are generated per install, so there is nothing to show before one exists.
	#[serde(skip)]
	pub variables: &'static [Var],
}

/// One install of a template.
#[derive(Clone, Debug)]
pub struct Rendered {
	pub services: &'static [Service],
	pub variables: Vec<Variable>,
	pub domain: Option<Domain>,
}

pub fn by_slug(slug: &str) -> Option<&'static Template> {
	CATALOG.iter().find(|t| t.slug == slug)
}

/// Resolves a template's variables for one install. A template with a domain
/// needs the hostname up front: these apps bake their own URL into their
/// configuration on first boot.
pub fn render(slug: &str, hostname: &str) -> Result<Rendered> {
	let Some(t) = by_slug(slug) else {
		bail!("unknown template {slug:?}");
	};
	let host = if t.domain.is_some() { security::validate_hostname(hostname)? } else { String::new() };
	let variables = t
		.variables
		.iter()
		.map(|v| match v.value {
			HOSTNAME => Variable { key: v.key.into(), value: host.clone(), secret: false },
			GENERATE => Variable { key: v.key.into(), value: security::random_token(24), secret: true },
			literal => Variable { key: v.key.into(), value: literal.into(), secret: false },
		})
		.collect();
	Ok(Rendered { services: t.services, variables, domain: t.domain.clone() })
}

#[cfg(test)]
mod tests {
	use std::collections::{HashMap, HashSet};

	use regex::Regex;

	use super::*;

	/// The failure the catalog invites is a fragment referencing a variable
	/// nobody declares: compose interpolates it to "" and the stack comes up
	/// with a blank password instead of failing.
	#[test]
	fn catalog_is_consistent() {
		let interpolation = Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").unwrap();
		let mut slugs = HashSet::new();
		for entry in CATALOG {
			assert!(slugs.insert(entry.slug), "duplicate template slug {:?}", entry.slug);
			let declared: HashSet<&str> = entry.variables.iter().map(|v| v.key).collect();
			for v in entry.variables {
				security::validate_env_key(v.key).unwrap();
			}
			let mut names = HashSet::new();
			for svc in entry.services {
				security::validate_service_name(svc.name).unwrap();
				names.insert(svc.name);
				for m in interpolation.captures_iter(svc.fragment) {
					assert!(declared.contains(&m[1]), "{}: fragment {} references undeclared ${{{}}}", entry.slug, svc.name, &m[1]);
				}
			}
			if let Some(domain) = &entry.domain {
				assert!(names.contains(domain.service), "{}: domain points at unknown service", entry.slug);
				security::validate_port(domain.port).unwrap();
			}
		}
	}

	#[test]
	fn render_resolves_placeholders() {
		let rendered = render("ghost", "blog.example.com").unwrap();
		let values: HashMap<String, Variable> = rendered.variables.into_iter().map(|v| (v.key.clone(), v)).collect();
		let host = &values["GHOST_HOST"];
		assert!(host.value == "blog.example.com" && !host.secret);
		let (password, root) = (&values["GHOST_DB_PASSWORD"], &values["GHOST_DB_ROOT_PASSWORD"]);
		assert!(!password.value.is_empty() && password.secret);
		// Two generated values sharing a secret would hand the application the root credential.
		assert_ne!(password.value, root.value);
		let again = render("ghost", "blog.example.com").unwrap();
		assert!(again.variables.iter().all(|v| v.key != "GHOST_DB_PASSWORD" || v.value != password.value));
	}

	#[test]
	fn render_rejects() {
		assert!(render("not-a-template", "example.com").is_err());
		assert!(render("ghost", "").is_err(), "a template with a domain must require a hostname");
	}
}
