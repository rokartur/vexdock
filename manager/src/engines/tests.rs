use std::collections::{HashMap, HashSet};

use super::*;

fn spec(engine: &str) -> Spec {
	Spec { engine: engine.into(), name: "db".into(), env_file: "/e.env".into(), ..Default::default() }
}

/// Proves every engine's fragment can start from the environment render seeds.
fn required_vars(engine: &Engine) -> HashSet<String> {
	let referenced = Regex::new(r"\$\$([A-Z0-9_]+)").unwrap();
	let mut out: HashSet<String> =
		[engine.database_var, engine.user_var, engine.password_var].into_iter().filter(|v| !v.is_empty()).map(String::from).collect();
	out.extend(referenced.captures_iter(engine.fragment).map(|c| c[1].to_string()));
	out
}

#[test]
fn render_seeds_every_required_variable() {
	for engine in CATALOG {
		let out = render(&Spec {
			engine: engine.slug.into(),
			name: "shop-db".into(),
			env_file: "/projects/01jabc/services/shop-db.env".into(),
			image: "clickhouse/clickhouse-server:24".into(),
			data_path: "/var/lib/clickhouse".into(),
			..Default::default()
		})
		.unwrap();
		let seeded: HashSet<String> = out.env.iter().map(|v| v.key.clone()).collect();
		for key in required_vars(engine) {
			assert!(seeded.contains(&key), "{}: requires {key} but render does not seed it", engine.slug);
		}
		// Namespaced by service, or a second database would mount the first one's data.
		assert_eq!(out.volume, "shop-db-data");
		assert!(out.fragment.contains("shop-db-data:"));
		assert!(out.fragment.contains(r#"env_file: ["/projects/01jabc/services/shop-db.env"]"#), "{}", engine.slug);
	}
}

#[test]
fn render_rejects_unsafe_input() {
	let cases = [
		("tag with a second image", Spec { tag: "17-alpine\n    command: rm -rf /".into(), ..spec("postgres") }),
		("database name with quote", Spec { database: "app\"".into(), ..spec("postgres") }),
		("database name led by a dash", Spec { database: "-app".into(), ..spec("postgres") }),
		("user with a dollar", Spec { user: "app$USER".into(), ..spec("postgres") }),
		("unknown engine", spec("cassandra")),
		("custom without data path", Spec { image: "redis:7".into(), ..spec(CUSTOM) }),
		("custom with bad image", Spec { image: "redis:7; rm -rf /".into(), data_path: "/data".into(), ..spec(CUSTOM) }),
		("no env file", Spec { env_file: String::new(), ..spec("postgres") }),
	];
	for (name, spec) in cases {
		assert!(render(&spec).is_err(), "{name}: expected the spec to be refused");
	}
}

/// Dokploy names a database and its user after the project, dashes included.
#[test]
fn render_accepts_dashed_names() {
	render(&Spec { database: "parafia-tapkowice".into(), user: "parafia-tapkowice".into(), ..spec("postgres") }).unwrap();
}

/// A curated engine builds its image from the catalog, never from user text.
#[test]
fn render_pins_the_curated_repository() {
	let out = render(&Spec { tag: "8-alpine".into(), name: "cache".into(), ..spec("valkey") }).unwrap();
	assert_eq!(out.image, "valkey/valkey:8-alpine");
	assert!(out.fragment.contains("image: valkey/valkey:8-alpine"));
}

/// Credentials reach the container through its env file, never compose interpolation.
#[test]
fn fragments_never_interpolate() {
	for engine in CATALOG {
		let out =
			render(&Spec { image: "clickhouse/clickhouse-server:24".into(), data_path: "/var/lib/clickhouse".into(), ..spec(engine.slug) })
				.unwrap();
		assert!(!out.fragment.replace("$$", "").contains('$'), "{}: fragment leaves a compose interpolation behind", engine.slug);
		assert!(!out.fragment.contains('{'), "{}: a placeholder survived rendering", engine.slug);
	}
}

#[test]
fn describe_builds_a_connection_url() {
	let env = HashMap::from([
		("POSTGRES_DB".to_string(), "shop".to_string()),
		("POSTGRES_USER".to_string(), "app".to_string()),
		("POSTGRES_PASSWORD".to_string(), "s3cret".to_string()),
	]);
	let got = describe(by_slug("postgres").unwrap(), "shop-db", "postgres:17-alpine", &env);
	assert_eq!(got.url, "postgresql://app:s3cret@shop-db:5432/shop");
}

/// Valkey has no user and no database; the URL must not invent either.
#[test]
fn describe_handles_an_engine_without_a_user() {
	let env = HashMap::from([("VALKEY_PASSWORD".to_string(), "pw".to_string())]);
	let got = describe(by_slug("valkey").unwrap(), "cache", "valkey/valkey:8-alpine", &env);
	assert_eq!(got.url, "redis://pw@cache:6379/");
}

/// Namespaces are a flag, and the credentials one encoded value the panel reads back.
#[test]
fn libsql() {
	let mut spec = Spec {
		name: "edge".into(),
		user: "reader".into(),
		password: "s3cret".into(),
		sqld: SqldSpec { node: SQLD_REPLICA.into(), primary_url: "http://primary:5001".into(), namespaces: true },
		..spec(LIBSQL)
	};
	let out = render(&spec).unwrap();
	assert!(out.fragment.contains(r#""--enable-namespaces", "--admin-listen-addr", "0.0.0.0:5000""#), "{}", out.fragment);
	let mut env: HashMap<String, String> = out.env.iter().map(|v| (v.key.clone(), v.value.clone())).collect();
	assert_eq!(env["SQLD_NODE"], SQLD_REPLICA);
	assert_eq!(env["SQLD_PRIMARY_URL"], "http://primary:5001");
	assert_eq!(env["SQLD_ENABLE_NAMESPACES"], "true");
	let engine = by_slug(LIBSQL).unwrap();
	let got = describe(engine, "edge", "libsql-server:v0.24.33", &env);
	assert_eq!((got.user.as_str(), got.password.as_str()), ("reader", "s3cret"));
	assert_eq!(got.node, SQLD_REPLICA);
	assert_eq!(got.replication_url, "");
	env.insert("SQLD_NODE".into(), SQLD_PRIMARY.into());
	assert_eq!(describe(engine, "edge", "libsql-server:v0.24.33", &env).replication_url, "http://edge:5001");
	spec.sqld.primary_url.clear();
	assert!(render(&spec).is_err(), "a replica without a primary would serve nothing");
	spec.sqld.namespaces = false;
	spec.sqld.node = SQLD_PRIMARY.into();
	let plain = render(&spec).unwrap();
	assert!(plain.fragment.contains("env_file: [\"/e.env\"]\n    volumes:"), "{}", plain.fragment);
}

/// The newest release is the first thing in the picker; Docker Hub orders by push date.
#[test]
fn newest_first_orders_by_version() {
	let mut tags: Vec<String> =
		["17-alpine", "bookworm", "18.6-alpine3.24", "19beta3", "18", "latest", "9.6"].iter().map(|s| s.to_string()).collect();
	newest_first(&mut tags);
	assert_eq!(tags.join(" "), "latest 18 18.6-alpine3.24 17-alpine 9.6 19beta3 bookworm");
}
