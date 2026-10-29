use super::*;
use crate::database::ServicePort;

fn database_input(engine: &str, version: &str, password: &str) -> Option<DatabaseInput> {
	Some(DatabaseInput {
		engine: engine.into(),
		version: version.into(),
		name: "app".into(),
		user: "app".into(),
		password: password.into(),
		..Default::default()
	})
}

fn database_service(name: &str, database: Option<DatabaseInput>) -> ServiceInput {
	ServiceInput { name: name.into(), provider: database::PROVIDER_IMAGE.into(), database, ..Default::default() }
}

fn assert_contains_all(text: &str, wants: &[&str]) {
	for want in wants {
		assert!(text.contains(want), "missing {want:?}:\n{text}");
	}
}

// The overlay is the only thing between a service row and docker, so a database
// comes out of it mounting its own volume and reading its own env file, with the
// credentials never inlined into the YAML.
#[test]
fn overlay_renders_a_database_service() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	let env = default_env(s, &p);
	let db = s.create_service(&env, &database_service("usagefleet-db", database_input("postgres", "17-alpine", "s3cret"))).unwrap();
	assert_eq!(db.kind, database::SERVICE_DATABASE);
	assert_eq!(db.image, "postgres:17-alpine");

	let path = s.write_overlay(&env).unwrap();
	let overlay = std::fs::read_to_string(&path).unwrap();
	assert_contains_all(
		&overlay,
		&[
			"  usagefleet-db:\n",
			"image: postgres:17-alpine",
			"usagefleet-db-data:/var/lib/postgresql/data",
			"PGDATA: /var/lib/postgresql/data",
			"\nvolumes:\n  usagefleet-db-data: {}\n",
		],
	);
	assert!(!overlay.contains("s3cret"), "the password was inlined into the compose file");

	let service_env = std::fs::read_to_string(s.service_env_file_path(&env, "usagefleet-db")).unwrap();
	assert!(service_env.contains("POSTGRES_PASSWORD=s3cret"), "{service_env}");

	// A project whose managed services are all gone must not keep a stale
	// overlay, or the next deploy resurrects the deleted container.
	s.delete_service(&db, &env).unwrap();
	assert_eq!(s.write_overlay(&env).unwrap(), "");
}

// A container's name is what someone reads in docker ps, so it follows the
// project, stays unique across the host and a taken name is refused up front.
#[test]
fn container_names() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "rokartur");
	let default = default_env(s, &p);
	let db = s.create_service(&default, &database_service("db", database_input("postgres", "", "s3cret"))).unwrap();
	assert_eq!(db.container_name, "rokartur-db");

	let staging = s.create_environment(&p, "staging", "main").unwrap();
	let copies = s.db.list_services(&staging.id).unwrap();
	assert_eq!(copies.len(), 1);
	assert_eq!(copies[0].container_name, "rokartur-staging-db");
	let taken = ServiceInput { container_name: "rokartur-db".into(), ..unconfigured("api") };
	assert!(s.create_service(&staging, &taken).is_err(), "two services took the same container name");

	let overlay = std::fs::read_to_string(s.write_overlay(&default).unwrap()).unwrap();
	assert!(overlay.contains("container_name: rokartur-db"), "{overlay}");
}

// Every overlay after the first is re-rendered from the stored row, so a
// version that is not the catalog default must not drift back to it, and a
// custom engine must still find its data path.
#[test]
fn overlay_re_renders_from_the_stored_row() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	let env = default_env(s, &p);
	s.create_service(&env, &database_service("pinned", database_input("postgres", "15-alpine", "s3cret"))).unwrap();
	let custom = DatabaseInput {
		engine: "custom".into(),
		image: "valkey/valkey:8".into(),
		data_path: "/data".into(),
		password: "s3cret".into(),
		..Default::default()
	};
	s.create_service(&env, &database_service("byo", Some(custom))).unwrap();

	let overlay = std::fs::read_to_string(s.write_overlay(&env).unwrap()).unwrap();
	// Every service key starts its own line: a fragment without a trailing
	// newline glues the next key onto its last line.
	assert_contains_all(
		&overlay,
		&["image: postgres:15-alpine", "image: valkey/valkey:8", "byo-data:/data", "\n  byo:\n", "\n  pinned:\n"],
	);
	assert!(!overlay.contains("postgres:17-alpine"), "the pinned version drifted to the catalog default:\n{overlay}");
}

// Two databases of the same engine in one project are the case the old
// project-level environment could not express.
#[test]
fn overlay_scopes_credentials_per_service() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "twin");
	let env = default_env(s, &p);
	for name in ["primary", "secondary"] {
		s.create_service(&env, &database_service(name, database_input("postgres", "17-alpine", &format!("{name}-pw")))).unwrap();
	}
	s.write_overlay(&env).unwrap();
	for name in ["primary", "secondary"] {
		let body = std::fs::read_to_string(s.service_env_file_path(&env, name)).unwrap();
		assert!(body.contains(&format!("POSTGRES_PASSWORD={name}-pw")), "{name}:\n{body}");
	}
}

// Named volumes of a fragment have to be declared at the top of the overlay or
// compose rejects the file, and env_file: .env lands on the project env file.
#[test]
fn overlay_renders_compose_fragment_volumes_and_env_file() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "vault");
	let env = default_env(s, &p);
	let fragment =
		"image: vaultwarden/server:1.37.1-alpine\nrestart: always\nenv_file:\n  - .env\nvolumes:\n  - vaultwarden:/data\nexpose:\n  - 80";
	let input = ServiceInput {
		name: "vaultwarden".into(),
		provider: database::PROVIDER_RAW.into(),
		compose_fragment: fragment.into(),
		..Default::default()
	};
	s.create_service(&env, &input).unwrap();

	let overlay = std::fs::read_to_string(s.write_overlay(&env).unwrap()).unwrap();
	let env_path = s.env_file_path(&env);
	assert_contains_all(
		&overlay,
		&[
			"image: vaultwarden/server:1.37.1-alpine",
			"vaultwarden:/data",
			"\nvolumes:\n  vaultwarden: {}\n",
			"expose:",
			"container_name: vault-vaultwarden",
			&env_path,
		],
	);
	assert!(!overlay.contains("- .env"), "env_file still points at a relative .env:\n{overlay}");
}

// A static build writes its Dockerfile into the overlay, so nginx's $uri has to
// reach Docker as a literal rather than as a compose variable.
#[test]
fn overlay_renders_build_types() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	let env = default_env(s, &p);
	for name in ["site", "api"] {
		let input = ServiceInput {
			name: name.into(),
			provider: database::PROVIDER_GIT.into(),
			repository_url: "https://example.com/app.git".into(),
			..Default::default()
		};
		s.create_service(&env, &input).unwrap();
	}
	let mut site = s.db.service_by_name(&env.id, "site").unwrap();
	site.build_type = database::BUILD_STATIC.into();
	site.output_dir = "web/dist".into();
	let mut api = s.db.service_by_name(&env.id, "api").unwrap();
	api.dockerfile = "docker/api.Dockerfile".into();
	api.build_target = "production".into();
	api.mounts = "push:/data".into();
	s.db.update_service(&mut site).unwrap();
	s.db.update_service(&mut api).unwrap();
	s.db.create_service_port(&mut ServicePort {
		service_id: api.id.clone(),
		published: 5353,
		target: 53,
		protocol: "udp".into(),
		..Default::default()
	})
	.unwrap();

	let overlay = std::fs::read_to_string(s.write_overlay(&env).unwrap()).unwrap();
	assert_contains_all(
		&overlay,
		&[
			"      dockerfile_inline: |\n        FROM node:lts-slim AS build\n",
			"bun run build",
			"      args:\n        OUTPUT_DIR: \"web/dist\"\n",
			"try_files $$uri $$uri/ /index.html;",
			"      dockerfile: \"docker/api.Dockerfile\"",
			"      target: \"production\"",
			"    image: usagefleet/production/api:latest\n    pull_policy: never\n    ports:\n      - \"5353:53/udp\"\n",
			"    volumes:\n      - push:/data\n",
			"\nvolumes:\n  push:",
		],
	);
}

#[test]
fn with_service_env_file_appends_the_service_file() {
	let svc_env = r#""/p/services/web.env""#;
	for (name, input, want) in [
		("none", "image: a\n".to_string(), format!("image: a\nenv_file: [{svc_env}]")),
		("scalar", "image: a\nenv_file: \"/p/.env\"\n".into(), format!("image: a\nenv_file: [\"/p/.env\", {svc_env}]")),
		("flow", "env_file: [a.env, b.env]\nimage: a".into(), format!("env_file: [a.env, b.env, {svc_env}]\nimage: a")),
		("block", "env_file:\n  - a.env\nimage: a".into(), format!("env_file:\n  - a.env\n  - {svc_env}\nimage: a")),
		(
			"nested key untouched",
			"image: a\nlabels:\n  env_file: x".into(),
			format!("image: a\nlabels:\n  env_file: x\nenv_file: [{svc_env}]"),
		),
	] {
		assert_eq!(super::super::overlay::with_service_env_file(&input, "/p/services/web.env"), want, "{name}");
	}
}
