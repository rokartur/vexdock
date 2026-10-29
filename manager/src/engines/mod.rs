//! The catalog of one-click databases: which image a service runs, which
//! versions it offers and how to connect to it once it is up.
//!
//! A database is one service among the others, so an engine renders a compose
//! service fragment rather than a file. Credentials reach the container through
//! that service's own env file instead of compose-level interpolation, which is
//! what lets two Postgres services in one project each have their own password.

mod tags;

pub use tags::*;

use std::sync::LazyLock;

use anyhow::{Result, bail};
use regex::Regex;
use serde::Serialize;

use crate::security;

/// The engine slug for "any other image". It has no curated template, so the
/// caller supplies both the image and the path its data lives on.
pub const CUSTOM: &str = "custom";

/// The one engine with options of its own.
pub const LIBSQL: &str = "libsql";

/// The kinds of node sqld runs as. A replica follows a primary over gRPC; a
/// standalone serves HTTP and replicates to nothing.
pub const SQLD_PRIMARY: &str = "primary";
pub const SQLD_REPLICA: &str = "replica";
pub const SQLD_STANDALONE: &str = "standalone";

/// Where a primary serves its replicas, opened by the image itself whenever
/// SQLD_NODE is primary.
const SQLD_GRPC_PORT: i64 = 5001;

/// One entry of the catalog.
#[derive(Clone, Debug, Serialize)]
pub struct Engine {
	pub slug: &'static str,
	pub name: &'static str,
	/// The image name without a tag: a constant of this catalog, never user
	/// input, which makes the Docker Hub tag lookup safe on the user's behalf.
	pub repository: &'static str,
	pub default_tag: &'static str,
	/// The offline fallback the version picker shows when Docker Hub is unreachable.
	pub versions: &'static [&'static str],
	/// Where the engine listens inside the container.
	pub port: i64,
	/// Prefixes the connection URL shown on the database page.
	pub scheme: &'static str,
	/// The variables holding the credentials, empty when the engine has no such
	/// concept: Valkey has neither a database nor a user, only a password.
	pub database_var: &'static str,
	pub user_var: &'static str,
	pub password_var: &'static str,
	/// The service body, indented under its own key, with {image}, {env_file},
	/// {volume}, {data_path} and (libSQL) {command} placeholders.
	#[serde(skip)]
	fragment: &'static str,
}

/// A validated request to create a database service.
#[derive(Clone, Debug, Default)]
pub struct Spec {
	pub engine: String,
	pub tag: String,
	pub database: String,
	pub user: String,
	pub password: String,
	/// When set, the reference to run, winning over tag for every engine: it
	/// carries the version already stored against the service. data_path is custom-only.
	pub image: String,
	pub data_path: String,
	/// The compose service name, also the volume prefix and the hostname on the
	/// project's default network.
	pub name: String,
	/// The absolute path of the file holding this service's environment.
	pub env_file: String,
	/// The libSQL-only part of the form.
	pub sqld: SqldSpec,
}

/// Configures a libSQL server. All but namespaces reaches sqld as an environment
/// variable; namespaces are a command-line flag, so they reach the fragment too.
#[derive(Clone, Debug, Default)]
pub struct SqldSpec {
	pub node: String,
	pub primary_url: String,
	pub namespaces: bool,
}

/// One seeded environment entry.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Variable {
	pub key: String,
	pub value: String,
	pub secret: bool,
}

/// Everything a new database service contributes to its project.
#[derive(Clone, Debug, Default)]
pub struct Rendered {
	/// The compose service body, indented four spaces.
	pub fragment: String,
	/// The named volume the fragment mounts, which the overlay declares at the top level.
	pub volume: String,
	/// The reference the service will run, resolved from the tag.
	pub image: String,
	pub env: Vec<Variable>,
}

/// The curated list, in the order the create form shows it.
pub static CATALOG: &[Engine] = &[
	Engine {
		slug: "postgres",
		name: "PostgreSQL",
		repository: "library/postgres",
		default_tag: "18-alpine",
		versions: &["18-alpine", "18", "17-alpine", "17", "16-alpine", "16"],
		port: 5432,
		scheme: "postgresql",
		database_var: "POSTGRES_DB",
		user_var: "POSTGRES_USER",
		password_var: "POSTGRES_PASSWORD",
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]
    # 18+ defaults PGDATA to /var/lib/postgresql/18/docker and refuses this mount unless PGDATA is set.
    environment:
      PGDATA: /var/lib/postgresql/data
    volumes:
      # 18+ also declares VOLUME /var/lib/postgresql, an empty anonymous volume per container without this.
      - type: tmpfs
        target: /var/lib/postgresql
      - {volume}:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 10s
      timeout: 5s
      retries: 5"#,
	},
	Engine {
		slug: "mysql",
		name: "MySQL",
		repository: "library/mysql",
		default_tag: "8",
		versions: &["9", "8", "8.4", "8.0"],
		port: 3306,
		scheme: "mysql",
		database_var: "MYSQL_DATABASE",
		user_var: "MYSQL_USER",
		password_var: "MYSQL_PASSWORD",
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]
    volumes:
      - {volume}:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      timeout: 5s
      retries: 10"#,
	},
	Engine {
		slug: "mariadb",
		name: "MariaDB",
		repository: "library/mariadb",
		default_tag: "11",
		versions: &["11", "11.4", "10.11"],
		port: 3306,
		scheme: "mysql",
		database_var: "MARIADB_DATABASE",
		user_var: "MARIADB_USER",
		password_var: "MARIADB_PASSWORD",
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]
    volumes:
      - {volume}:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10"#,
	},
	Engine {
		slug: "mongodb",
		name: "MongoDB",
		repository: "library/mongo",
		default_tag: "8",
		versions: &["8", "7", "6"],
		port: 27017,
		scheme: "mongodb",
		database_var: "MONGO_INITDB_DATABASE",
		user_var: "MONGO_INITDB_ROOT_USERNAME",
		password_var: "MONGO_INITDB_ROOT_PASSWORD",
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]
    volumes:
      - {volume}:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 10"#,
	},
	Engine {
		slug: "valkey",
		name: "Valkey",
		repository: "valkey/valkey",
		default_tag: "8-alpine",
		versions: &["8-alpine", "8", "7-alpine"],
		port: 6379,
		scheme: "redis",
		database_var: "",
		user_var: "",
		password_var: "VALKEY_PASSWORD",
		// The password reaches valkey through the shell rather than compose
		// interpolation: the env file is per service and compose only
		// interpolates from the project-wide one.
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]
    command: ["sh", "-c", "exec valkey-server --requirepass \"$$VALKEY_PASSWORD\" --appendonly yes"]
    volumes:
      - {volume}:/data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli --no-auth-warning -a \"$$VALKEY_PASSWORD\" ping"]
      interval: 10s
      timeout: 5s
      retries: 5"#,
	},
	Engine {
		slug: LIBSQL,
		name: "libSQL",
		repository: "ghcr.io/tursodatabase/libsql-server",
		default_tag: "latest",
		versions: &["latest", "v0.24.33", "v0.24.32", "v0.24.31"],
		port: 8080,
		scheme: "http",
		// sqld serves one SQLite file over HTTP: no database to name and no user or
		// password variable, because its basic auth is one encoded SQLD_HTTP_AUTH.
		// A namespace is created through the admin API, so the flag without its
		// listener would leave the switch inert.
		database_var: "",
		user_var: "",
		password_var: "",
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]{command}
    volumes:
      - {volume}:/var/lib/sqld"#,
	},
	Engine {
		slug: CUSTOM,
		name: "Other image",
		repository: "",
		default_tag: "",
		versions: &[],
		port: 0,
		scheme: "",
		database_var: "",
		user_var: "",
		password_var: "",
		fragment: r#"    image: {image}
    restart: unless-stopped
    env_file: ["{env_file}"]
    volumes:
      - {volume}:{data_path}"#,
	},
];

pub fn by_slug(slug: &str) -> Option<&'static Engine> {
	CATALOG.iter().find(|e| e.slug == slug)
}

const SQLD_NAMESPACES_COMMAND: &str = "\n    command: [\"/bin/sqld\", \"--enable-namespaces\", \"--admin-listen-addr\", \"0.0.0.0:5000\"]";

impl Engine {
	fn render_fragment(&self, image: &str, env_file: &str, volume: &str, data_path: &str, namespaces: bool) -> String {
		self.fragment
			.replace("{image}", image)
			.replace("{env_file}", env_file)
			.replace("{volume}", volume)
			.replace("{data_path}", data_path)
			.replace("{command}", if namespaces { SQLD_NAMESPACES_COMMAND } else { "" })
	}
}

macro_rules! pattern {
	($name:ident, $re:expr) => {
		static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($re).unwrap());
	};
}

// What Docker accepts after the colon; keeps a version from turning into a second image reference.
pattern!(TAG_PATTERN, r"^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$");
// A registry path plus an optional tag or digest, and no shell metacharacters
// or whitespace that could smuggle anything into the compose file.
pattern!(IMAGE_PATTERN, r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}(:[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$");
// Written straight into the compose file: a space or a '#' would silently
// remount the volume elsewhere and the database comes back empty.
pattern!(DATA_PATH_PATTERN, r"^/[a-zA-Z0-9._/-]{0,255}$");
// Database and user names end up in the compose file and a connection URL, so
// anything exotic is refused rather than escaped.
pattern!(IDENT_PATTERN, r"^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$");

/// Validates a spec and produces the compose fragment and the environment that
/// together define a database service.
pub fn render(spec: &Spec) -> Result<Rendered> {
	let Some(engine) = by_slug(&spec.engine) else {
		bail!("unknown database engine {:?}", spec.engine);
	};
	if spec.name.is_empty() || spec.env_file.is_empty() {
		bail!("name and env file are required");
	}
	let image = resolve_image(engine, spec)?;
	let data_path = spec.data_path.trim();
	// Without a volume the first redeploy silently discards the data, so a
	// custom image has to say where its data lives.
	if engine.slug == CUSTOM && !DATA_PATH_PATTERN.is_match(data_path) {
		bail!("a data path like /var/lib/data is required for a custom image");
	}

	let mut env = Vec::new();
	let password = if spec.password.is_empty() { security::random_token(24) } else { spec.password.clone() };
	if !engine.password_var.is_empty() {
		if password.contains([' ', '\t', '\n', '"', '\'']) {
			bail!("the password cannot contain whitespace or quotes");
		}
		env.push(Variable { key: engine.password_var.into(), value: password.clone(), secret: true });
		// MySQL and MariaDB refuse to start without a root password, which is not
		// the credential the application uses.
		if let Some(root) = root_password_var(engine) {
			env.push(Variable { key: root.into(), value: security::random_token(24), secret: true });
		}
	}
	if !engine.database_var.is_empty() {
		let name = defaulted(&spec.database, "app");
		if !IDENT_PATTERN.is_match(&name) {
			bail!("invalid database name {name:?}");
		}
		env.push(Variable { key: engine.database_var.into(), value: name, secret: false });
	}
	if !engine.user_var.is_empty() {
		let user = defaulted(&spec.user, "app");
		if !IDENT_PATTERN.is_match(&user) {
			bail!("invalid database user {user:?}");
		}
		env.push(Variable { key: engine.user_var.into(), value: user, secret: false });
	}
	if engine.slug == LIBSQL {
		env.extend(sqld_variables(spec, &password)?);
	}
	let volume = format!("{}-data", spec.name);
	let fragment = engine.render_fragment(&image, &spec.env_file, &volume, data_path, spec.sqld.namespaces);
	Ok(Rendered { fragment, volume, image, env })
}

/// The libSQL half of the create form, as the environment the container starts
/// with. SQLD_ENABLE_NAMESPACES is ignored by sqld itself (the option is only
/// the --enable-namespaces flag); the manager reads it back when it re-renders
/// the fragment, which keeps the switch editable beside the rest.
fn sqld_variables(spec: &Spec, password: &str) -> Result<Vec<Variable>> {
	let node = defaulted(&spec.sqld.node, SQLD_PRIMARY);
	if !matches!(node.as_str(), SQLD_PRIMARY | SQLD_REPLICA | SQLD_STANDALONE) {
		bail!("invalid sqld node {node:?}; expected primary, replica or standalone");
	}
	let user = defaulted(&spec.user, "libsql");
	if !IDENT_PATTERN.is_match(&user) {
		bail!("invalid database user {user:?}");
	}
	if password.contains([' ', '\t', '\n', '"', '\'']) {
		bail!("the password cannot contain whitespace or quotes");
	}
	let mut vars = vec![
		Variable { key: "SQLD_NODE".into(), value: node.clone(), secret: false },
		Variable { key: "SQLD_HTTP_AUTH".into(), value: encode_basic_auth(&user, password), secret: true },
		Variable { key: "SQLD_ENABLE_NAMESPACES".into(), value: spec.sqld.namespaces.to_string(), secret: false },
	];
	if node != SQLD_REPLICA {
		return Ok(vars);
	}
	// A replica with no primary starts and then serves nothing, so the URL is
	// part of choosing the node kind rather than an extra.
	let primary = spec.sqld.primary_url.trim();
	let valid =
		url::Url::parse(primary).is_ok_and(|u| u.host_str().is_some_and(|h| !h.is_empty()) && matches!(u.scheme(), "http" | "https"));
	if !valid {
		bail!("a replica needs the primary's gRPC URL, like http://primary:5001");
	}
	vars.push(Variable { key: "SQLD_PRIMARY_URL".into(), value: primary.into(), secret: false });
	Ok(vars)
}

/// The one value sqld understands as a credential: `basic:` and base64 of `user:password`.
fn encode_basic_auth(user: &str, password: &str) -> String {
	use base64::Engine;
	format!("basic:{}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")))
}

/// Reads SQLD_HTTP_AUTH back, so the connection panel shows the credentials the
/// container is actually running with.
fn decode_basic_auth(value: &str) -> (String, String) {
	use base64::Engine;
	let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(value.trim_start_matches("basic:")) else {
		return (String::new(), String::new());
	};
	let raw = String::from_utf8_lossy(&raw);
	let (user, password) = raw.split_once(':').unwrap_or((&raw, ""));
	(user.to_string(), password.to_string())
}

/// The reference the service will run. An explicit reference always wins: the
/// custom engine has nothing else, and for a curated one it is the stored image
/// carrying the version chosen at create time.
fn resolve_image(engine: &Engine, spec: &Spec) -> Result<String> {
	let mut image = spec.image.trim().to_string();
	if image.is_empty() && engine.slug != CUSTOM {
		let tag = defaulted(&spec.tag, engine.default_tag);
		if !TAG_PATTERN.is_match(&tag) {
			bail!("invalid version {tag:?}");
		}
		image = format!("{}:{tag}", engine.repository.trim_start_matches("library/"));
	}
	validate_image(&image)
}

/// The trimmed reference, rejecting anything that could not appear verbatim
/// after `image:` in a compose file: a newline would open sibling keys.
pub fn validate_image(image: &str) -> Result<String> {
	let image = image.trim();
	if !IMAGE_PATTERN.is_match(image) {
		bail!("invalid image reference {image:?}");
	}
	Ok(image.to_string())
}

/// The administrative password of the engines that demand one besides the
/// application credential.
fn root_password_var(engine: &Engine) -> Option<&'static str> {
	match engine.slug {
		"mysql" => Some("MYSQL_ROOT_PASSWORD"),
		"mariadb" => Some("MARIADB_ROOT_PASSWORD"),
		_ => None,
	}
}

fn defaulted(value: &str, fallback: &str) -> String {
	let v = value.trim();
	if v.is_empty() { fallback.to_string() } else { v.to_string() }
}

/// What the database page shows.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Connection {
	pub engine: String,
	pub image: String,
	pub host: String,
	pub port: i64,
	pub database: String,
	pub user: String,
	pub password: String,
	pub url: String,
	/// The libSQL node kind, empty for every other engine.
	pub node: String,
	/// What a libSQL replica is pointed at, set only on a primary. The gRPC
	/// listener has no auth of its own, so it carries no credentials.
	pub replication_url: String,
}

/// Reads a running database service back out of its image and environment.
/// The environment is the authority because it is what the container started
/// with, so an edited variable shows up here.
pub fn describe(engine: &Engine, alias: &str, image: &str, env: &std::collections::HashMap<String, String>) -> Connection {
	let var = |key: &str| if key.is_empty() { String::new() } else { env.get(key).cloned().unwrap_or_default() };
	let mut c = Connection {
		engine: engine.slug.into(),
		image: image.into(),
		host: alias.into(),
		port: engine.port,
		database: var(engine.database_var),
		user: var(engine.user_var),
		password: var(engine.password_var),
		..Default::default()
	};
	if engine.slug == LIBSQL {
		(c.user, c.password) = decode_basic_auth(&var("SQLD_HTTP_AUTH"));
		c.node = defaulted(&var("SQLD_NODE"), SQLD_PRIMARY);
		if c.node == SQLD_PRIMARY {
			c.replication_url = format!("http://{}:{SQLD_GRPC_PORT}", c.host);
		}
	}
	if engine.scheme.is_empty() || c.password.is_empty() {
		return c;
	}
	let auth = if c.user.is_empty() { c.password.clone() } else { format!("{}:{}", c.user, c.password) };
	c.url = format!("{}://{auth}@{}:{}/{}", engine.scheme, c.host, c.port, c.database);
	c
}

#[cfg(test)]
mod tests;
