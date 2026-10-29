use std::sync::Arc;

use super::*;
use crate::database::{Domain, Environment, GitLabProvider, GitProvider, ScheduledTask, Service};

struct Fixture {
	_dir: tempfile::TempDir,
	projects: Projects,
}

fn test_projects() -> Fixture {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_str().unwrap();
	let db = Db::open(&format!("{root}/app.db")).unwrap();
	let cipher = Cipher::new(&[7u8; 32]).unwrap();
	let projects = Projects::new(Arc::new(db), Arc::new(Config::at(root)), Arc::new(cipher));
	Fixture { _dir: dir, projects }
}

/// The environment create makes alongside a project. Every path and compose
/// call hangs off it, so the tests reach for it the way the handlers do.
fn default_env(s: &Projects, p: &Project) -> Environment {
	s.db.default_environment(&p.id).unwrap()
}

fn create(s: &Projects, name: &str) -> Project {
	s.create(&CreateInput { name: name.into(), ..Default::default() }).unwrap()
}

fn unconfigured(name: &str) -> ServiceInput {
	ServiceInput { name: name.into(), provider: database::PROVIDER_UNCONFIGURED.into(), ..Default::default() }
}

#[test]
fn normalize_tags_slugifies_and_dedupes() {
	let got = normalize_tags(&[" Client X ", "client-x", "", "  ", "Prod,staging"].map(String::from));
	assert_eq!(got, ["client-x", "prod-staging"]);
}

// Tags share one comma-separated column, so a comma in a tag would split it in
// two on the way back out.
#[test]
fn normalize_tags_never_contains_separator() {
	for tag in normalize_tags(&["a,b", "c, d"].map(String::from)) {
		assert!(!tag.contains(','), "tag {tag:?} still contains the separator");
	}
}

#[test]
fn normalize_tags_caps() {
	let many: Vec<String> = (0..MAX_TAGS + 5).map(|i| char::from(b'a' + (i % 26) as u8).to_string()).collect();
	assert!(normalize_tags(&many).len() <= MAX_TAGS);
}

// Compose interpolates inside a double-quoted env value, so a dollar has to
// survive that second pass: unescaped, p$ssw0rd reaches the container as p.
#[test]
fn escape_env_value_cases() {
	for (name, value, want) in [
		("dollar", "p$ssw0rd", r#""p$$ssw0rd""#),
		("dollar braces", "${HOME}", r#""$${HOME}""#),
		("empty", "", r#""""#),
		("plain", "simple", "simple"),
		("space", "two words", r#""two words""#),
		("quote", r#"say "hi""#, r#""say \"hi\"""#),
		("newline", "a\nb", r#""a\nb""#),
		("backslash left bare when nothing forces quoting", r"C:\tmp", r"C:\tmp"),
		("backslash doubled once quoted", r"C:\tmp dir", r#""C:\\tmp dir""#),
	] {
		assert_eq!(escape_env_value(value), want, "{name}");
	}
}

// A project is a grouping, so creating one takes nothing but a name: where code
// comes from belongs to its services.
#[test]
fn create_takes_nothing_but_a_name() {
	let f = test_projects();
	let s = &f.projects;
	let p = s.create(&CreateInput { name: "My App".into(), tags: vec!["Staging".into()] }).unwrap();
	assert_eq!(p.slug, "my-app");
	assert_eq!(p.tags, ["staging"]);
	std::fs::read_dir(s.repository_dir(&default_env(s, &p).id)).expect("checkout directory");
}

// A connection is what makes a picked repository clonable: the service stores
// no URL and no credential of its own, so both have to come from the provider.
#[tokio::test]
async fn git_source_comes_from_connection() {
	let f = test_projects();
	let s = &f.projects;
	let mut provider = GitProvider {
		name: "acme".into(),
		provider_type: database::PROVIDER_GITLAB.into(),
		gitlab: Some(GitLabProvider {
			url: "https://gitlab.com".into(),
			access_token_enc: s.cipher.encrypt("glpat_secret").unwrap(),
			// Far enough out that the account is used as stored rather than
			// refreshed over the network.
			expires_at: chrono::Utc::now().timestamp() + 3600,
			..Default::default()
		}),
		..Default::default()
	};
	s.db.create_git_provider(&mut provider).unwrap();

	let mut service =
		Service { provider: database::PROVIDER_GITLAB.into(), credential_kind: database::GIT_CREDENTIAL_NONE.into(), ..Default::default() };
	s.set_git_repository(&mut service, &provider.id, "acme", "web").unwrap();
	let source = s.git_source_for(&service).await.unwrap();
	assert_eq!(source.url, "https://gitlab.com/acme/web.git");
	assert_eq!(source.cred.kind, crate::git::KIND_TOKEN);
	assert_eq!(source.cred.value, "glpat_secret");

	// A service can only borrow a connection of its own provider; anything else
	// would authenticate against the wrong host.
	service.provider = database::PROVIDER_GITHUB.into();
	assert!(s.git_source_for(&service).await.is_err());
}

// Two environments of one project must not meet: separate compose namespaces,
// directories and services, or a staging deploy could stop production.
#[test]
fn environments_are_isolated() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	let production = default_env(s, &p);
	let staging = s.create_environment(&p, "Staging", "develop").unwrap();

	assert_ne!(staging.compose_project_name, production.compose_project_name);
	assert_ne!(s.repository_dir(&staging.id), s.repository_dir(&production.id));
	// The default environment keeps the project's own id, which makes the
	// upgrade from a pre-environment install a no-op on disk.
	assert_eq!(production.id, p.id);

	for env in [&production, &staging] {
		s.create_service(env, &unconfigured("web")).unwrap();
	}
	assert!(s.create_service(&staging, &unconfigured("web")).is_err(), "the same name was accepted twice in one environment");

	// A new environment starts from the default one's services, so it has
	// something to deploy the moment it exists.
	let preview = s.create_environment(&p, "Preview", "").unwrap();
	let copied = s.db.list_services(&preview.id).unwrap();
	assert_eq!(copied.len(), 1);
	assert_eq!(copied[0].compose_service_name, "web");
}

// Project variables are shared; an environment's own override them. The .env
// compose reads is where the two meet, so that is where it is checked.
#[test]
fn environment_variables_override_shared_ones() {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "usagefleet");
	let staging = s.create_environment(&p, "Staging", "").unwrap();
	let var = |key: &str, value: &str| EnvVar { key: key.into(), value: value.into(), ..Default::default() };

	s.set_project_variables(&p.id, &[var("SHARED", "everywhere"), var("TIER", "production")]).unwrap();
	s.set_environment_variables(&staging.id, &[var("TIER", "staging")]).unwrap();

	let path = s.write_env_file(&p, &staging).unwrap();
	let rendered = std::fs::read_to_string(path).unwrap();
	assert!(rendered.contains("SHARED=everywhere"), "{rendered}");
	assert!(rendered.contains("TIER=staging") && !rendered.contains("TIER=production"), "{rendered}");
}

/// A project with a staging environment and one service in production, the
/// shape both transfers start from.
fn transfer_fixture() -> (Fixture, Project, Environment, Environment, Service) {
	let f = test_projects();
	let s = &f.projects;
	let p = create(s, "acme");
	let production = default_env(s, &p);
	// Created before the service: a new environment is seeded from the default
	// one, so a later staging would already hold a copy of it.
	let staging = s.create_environment(&p, "Staging", "").unwrap();
	let web = s
		.create_service(
			&production,
			&ServiceInput {
				name: "web".into(),
				provider: database::PROVIDER_IMAGE.into(),
				image: "nginx:1.27".into(),
				..Default::default()
			},
		)
		.unwrap();
	s.set_service_variables(&web.id, &[EnvVar { key: "TOKEN".into(), value: "t0".into(), is_secret: true, ..Default::default() }]).unwrap();
	s.db.create_scheduled_task(&mut ScheduledTask {
		service_id: web.id.clone(),
		name: "nightly".into(),
		schedule: "0 3 * * *".into(),
		command: "echo hi".into(),
		shell: "sh".into(),
		enabled: true,
		..Default::default()
	})
	.unwrap();
	(f, p, production, staging, web)
}

#[test]
fn duplicate_service_copies_variables_and_tasks() {
	let (f, _, production, _, web) = transfer_fixture();
	let s = &f.projects;
	let copied = s.duplicate_service(&web, &production, "web-copy").unwrap();
	assert_ne!(copied.id, web.id);
	assert_ne!(copied.container_name, web.container_name);
	let vars = s.service_variables(&copied.id).unwrap();
	assert_eq!(vars.len(), 1);
	assert_eq!((vars[0].key.as_str(), vars[0].value.as_str()), ("TOKEN", "t0"));
	let tasks = s.db.scheduled_tasks_by_service(&copied.id).unwrap();
	assert_eq!(tasks.len(), 1);
	assert_eq!(tasks[0].name, "nightly");
	assert!(s.duplicate_service(&web, &production, "web").is_err(), "a duplicate took the original's own name");
}

#[test]
fn move_service_takes_its_domain_along() {
	let (f, p, production, staging, mut web) = transfer_fixture();
	let s = &f.projects;
	s.db.create_domain(&mut Domain {
		id: database::new_id(),
		project_id: p.id.clone(),
		environment_id: production.id.clone(),
		service_id: web.id.clone(),
		hostname: "acme.test".into(),
		container_port: 80,
		..Default::default()
	})
	.unwrap();

	let container = s.check_move_service(&web, &production, &staging).unwrap();
	s.move_service(&mut web, &production, &staging, &container).unwrap();

	let moved = s.db.service_by_id(&web.id).unwrap();
	assert_eq!(moved.environment_id, staging.id);
	assert_eq!(moved.container_name, "acme-staging-web");
	let domains = s.db.list_project_domains(&p.id).unwrap();
	assert_eq!(domains.len(), 1);
	assert_eq!(domains[0].environment_id, staging.id);
	assert_eq!(s.db.scheduled_tasks_by_service(&web.id).unwrap().len(), 1);

	// The overlay is what docker reads: production must stop rendering the
	// service and staging must start.
	assert!(!std::path::Path::new(&format!("{}/managed.yml", s.cfg.project_dir(&production.id))).exists());
	let body = std::fs::read_to_string(format!("{}/managed.yml", s.cfg.project_dir(&staging.id))).unwrap();
	assert!(body.contains("acme-staging-web"), "{body}");
}

mod overlay;
mod portable;
