use base64::Engine as _;

use super::*;

fn postgres(name: &str) -> ServiceInput {
	ServiceInput {
		name: name.into(),
		provider: database::PROVIDER_IMAGE.into(),
		database: Some(DatabaseInput {
			engine: "postgres".into(),
			version: "17-alpine".into(),
			name: "app".into(),
			user: "app".into(),
			password: "s3cret".into(),
			..Default::default()
		}),
		..Default::default()
	}
}

// An application created as a bare name has nothing to render, and the overlay
// is shared by every service in the project: an empty body for it would fail
// the whole deploy, siblings included.
#[test]
fn overlay_skips_an_unconfigured_application() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	let env = default_env(s, &p);
	s.create_service(&env, &unconfigured("web")).unwrap();
	s.create_service(&env, &postgres("db")).unwrap();

	let overlay = std::fs::read_to_string(s.write_overlay(&env).unwrap()).unwrap();
	assert!(!overlay.contains("web:"), "an unconfigured application reached the overlay:\n{overlay}");
	assert!(overlay.contains("image: postgres:17-alpine"), "its sibling was dropped with it:\n{overlay}");
}

// An export exists to be imported: it carries every field the create form would
// have asked for, and a secret only leaves with its value when asked explicitly.
#[test]
fn export_services_withholds_secrets_unless_asked() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	s.create_service(&default_env(s, &p), &postgres("db")).unwrap();

	let withheld = decode_export(s, &p, false);
	assert_eq!(withheld.services.len(), 1);
	let db = &withheld.services[0];
	assert_eq!(db.image, "postgres:17-alpine");
	assert_eq!(db.engine, "postgres", "the import cannot tell this is a database");
	for v in &db.env {
		assert!(!(v.is_secret && !v.value.is_empty()), "{} left with its value", v.key);
		assert!(!(!v.is_secret && v.value.is_empty()), "{} lost its value, which was never a secret", v.key);
	}

	let included = decode_export(s, &p, true);
	assert!(included.services[0].env.iter().any(|v| v.is_secret && v.value == "s3cret"), "{:?}", included.services[0].env);
}

fn decode_export(s: &Projects, p: &Project, secrets: bool) -> Export {
	let payload = s.export_services(p, &default_env(s, p), secrets).unwrap();
	let raw = base64::engine::general_purpose::STANDARD.decode(payload).expect("export is base64");
	let out: Export = serde_json::from_slice(&raw).expect("export is JSON");
	assert_eq!(out.version, EXPORT_VERSION);
	out
}
