use super::*;

pub(crate) fn new_project(db: &Db, slug: &str) -> Project {
	let id = new_id();
	let mut p =
		Project { id: id.clone(), name: slug.into(), slug: slug.into(), compose_project_name: format!("p_{id}"), ..Default::default() };
	db.create_project(&mut p).unwrap();
	let mut env = Environment {
		id: p.id.clone(),
		project_id: p.id.clone(),
		name: "Production".into(),
		slug: "production".into(),
		compose_project_name: p.compose_project_name.clone(),
		is_default: true,
		..Default::default()
	};
	db.create_environment(&mut env).unwrap();
	p
}

#[test]
fn every_migration_file_is_embedded() {
	let mut on_disk: Vec<String> = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter(|name| name.ends_with(".sql"))
		.collect();
	on_disk.sort();
	let embedded: Vec<String> = MIGRATIONS.iter().map(|(name, _)| name.to_string()).collect();
	assert_eq!(embedded, on_disk, "MIGRATIONS must list every migrations/*.sql in filename order");
}

#[test]
fn migrations_are_idempotent() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("app.db");
	drop(Db::open(path.to_str().unwrap()).unwrap());
	// Reopening must not try to apply the same migrations again.
	let second = Db::open(path.to_str().unwrap()).unwrap();
	second.list_projects().unwrap();
}

#[test]
fn now_matches_go_rfc3339_nano() {
	let t = chrono::DateTime::parse_from_rfc3339("2026-01-02T03:04:05.120000000Z").unwrap().with_timezone(&chrono::Utc);
	assert_eq!(format_time(t), "2026-01-02T03:04:05.12Z");
	let whole = chrono::DateTime::parse_from_rfc3339("2026-01-02T03:04:05Z").unwrap().with_timezone(&chrono::Utc);
	assert_eq!(format_time(whole), "2026-01-02T03:04:05Z");
}

/// Numbers increase per service, and a restart never leaves a deployment stuck in running.
#[test]
fn deployment_numbering_and_recovery() {
	let (_dir, db) = Db::open_temp();
	let project = new_project(&db, "app");
	let other = new_project(&db, "other");
	let deployment = |project: &Project, service: &str, status: &str| Deployment {
		project_id: project.id.clone(),
		environment_id: project.id.clone(),
		service_name: service.into(),
		trigger: "manual".into(),
		status: status.into(),
		..Default::default()
	};
	let mut second = deployment(&other, "web", "");
	db.create_deployment(&mut second).unwrap();
	assert_eq!(second.number, 1, "per-project numbering leaked");
	for want in 1..=3 {
		let mut d = deployment(&project, "web", "");
		db.create_deployment(&mut d).unwrap();
		assert_eq!(d.number, want);
		assert_eq!(d.status, DEPLOYMENT_QUEUED);
	}
	let mut fresh = deployment(&project, "db", "");
	db.create_deployment(&mut fresh).unwrap();
	assert_eq!(fresh.number, 1, "numbering is not per service");

	let mut running = deployment(&project, "web", DEPLOYMENT_RUNNING);
	db.create_deployment(&mut running).unwrap();
	assert_eq!(db.unfinished_deployments().unwrap().len(), 6);

	running.status = DEPLOYMENT_SUCCESS.into();
	running.finished_at = now();
	db.update_deployment(&running).unwrap();
	assert_eq!(db.count_deployments_by_status(DEPLOYMENT_SUCCESS).unwrap(), 1);

	let env = db.default_environment(&project.id).unwrap();
	let list = db.list_deployments(&env.id, 10).unwrap();
	assert_eq!(list.len(), 5);
	assert_eq!(list[0].id, running.id, "history is not newest-first");
}

#[test]
fn not_found_is_typed() {
	let (_dir, db) = Db::open_temp();
	let err = db.project_by_id("missing").unwrap_err();
	assert!(is_not_found(&err));
}

#[test]
fn deleting_a_project_cascades() {
	let (_dir, db) = Db::open_temp();
	let project = new_project(&db, "app");
	let env = db.default_environment(&project.id).unwrap();
	let mut service = Service {
		id: new_id(),
		project_id: project.id.clone(),
		environment_id: env.id,
		compose_service_name: "web".into(),
		kind: SERVICE_APPLICATION.into(),
		provider: PROVIDER_IMAGE.into(),
		image: "nginx".into(),
		..Default::default()
	};
	db.create_service(&mut service).unwrap();
	let mut domain = Domain {
		id: new_id(),
		project_id: project.id.clone(),
		service_id: service.id.clone(),
		hostname: "a.example.com".into(),
		container_port: 3000,
		..Default::default()
	};
	db.create_domain(&mut domain).unwrap();
	db.upsert_secret(PROJECT_SCOPE, &project.id, "TOKEN", "sealed", true).unwrap();
	db.delete_project(&project.id).unwrap();
	assert!(db.list_domains().unwrap().is_empty(), "domains survived the project");
	assert!(db.list_secrets(PROJECT_SCOPE, &project.id).unwrap().is_empty(), "secrets survived the project");
}

/// Tags live in one comma-separated column, so the join on write and the split on read have to agree.
#[test]
fn project_tags_round_trip() {
	let (_dir, db) = Db::open_temp();
	let mut p = new_project(&db, "tagged");
	p.tags = vec!["prod".into(), "client-x".into()];
	db.update_project(&mut p).unwrap();
	assert_eq!(db.project_by_id(&p.id).unwrap().tags, vec!["prod", "client-x"]);
	let plain = new_project(&db, "plain");
	assert!(db.project_by_id(&plain.id).unwrap().tags.is_empty());
}

/// Two switches in one long column list: insert, update and scan must name them in the same order.
#[test]
fn service_switches_round_trip() {
	let (_dir, db) = Db::open_temp();
	let project = new_project(&db, "app");
	let mut s = Service {
		id: new_id(),
		project_id: project.id.clone(),
		environment_id: project.id.clone(),
		compose_service_name: "web".into(),
		kind: SERVICE_APPLICATION.into(),
		provider: PROVIDER_GITHUB.into(),
		auto_deploy: true,
		..Default::default()
	};
	db.create_service(&mut s).unwrap();
	let mut stored = db.service_by_id(&s.id).unwrap();
	assert!(stored.auto_deploy && !stored.prune_build_cache);
	stored.auto_deploy = false;
	stored.prune_build_cache = true;
	db.update_service(&mut stored).unwrap();
	let updated = db.service_by_id(&s.id).unwrap();
	assert!(!updated.auto_deploy && updated.prune_build_cache);
}

/// Applies migrations in order and stops after the named one: the schema an
/// existing install is upgrading from.
fn open_up_to(path: &std::path::Path, last: &str) -> Db {
	let conn = rusqlite::Connection::open(path).unwrap();
	conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
	let db = Db { conn: Mutex::new(conn) };
	db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)", []).unwrap();
	for (name, body) in MIGRATIONS {
		db.apply(name, body).unwrap();
		if name.starts_with(last) {
			return db;
		}
	}
	panic!("no migration named {last}");
}

fn integrity(db: &Db) -> String {
	db.conn().query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap()
}

/// 0010 rebuilds services; with foreign keys enforced the drop would take every
/// cascading child row with it. An install with data must come out whole.
#[test]
fn upgrading_to_environments_keeps_data() {
	let dir = tempfile::tempdir().unwrap();
	let db = open_up_to(&dir.path().join("app.db"), "0009");
	let project_id = new_id();
	let compose_name = format!("p_{project_id}");
	db.exec(
		"INSERT INTO projects (id, name, slug, source_type, compose_project_name, created_at, updated_at) VALUES (?, 'app', 'app', 'git', ?, ?, ?)",
		rusqlite::params![project_id, compose_name, now(), now()],
	)
	.unwrap();
	let service_id = new_id();
	db.exec(
		"INSERT INTO services (id, project_id, compose_service_name, created_at) VALUES (?, ?, 'web', ?)",
		rusqlite::params![service_id, project_id, now()],
	)
	.unwrap();
	db.upsert_secret(SERVICE_SCOPE, &service_id, "TOKEN", "sealed", true).unwrap();
	db.exec(
		"INSERT INTO domains (id, project_id, service_id, hostname, container_port, created_at, updated_at) VALUES (?, ?, ?, 'a.example.com', 3000, ?, ?)",
		rusqlite::params![new_id(), project_id, service_id, now(), now()],
	)
	.unwrap();

	db.migrate().unwrap();
	assert_eq!(integrity(&db), "ok");
	assert_eq!(db.list_secrets(SERVICE_SCOPE, &service_id).unwrap().len(), 1, "the rebuild cascaded into service_secrets");
	assert_eq!(db.list_domains().unwrap().len(), 1, "the rebuild cascaded into domains");
	let (id, name): (String, String) = db
		.conn()
		.query_row("SELECT id, compose_project_name FROM environments WHERE project_id = ? AND is_default = 1", [&project_id], |r| {
			Ok((r.get(0)?, r.get(1)?))
		})
		.unwrap();
	assert_eq!(id, project_id);
	assert_eq!(name, compose_name);
	db.exec(
		"INSERT INTO environments (id, project_id, name, slug, compose_project_name, created_at, updated_at) VALUES ('env-staging', ?, 'Staging', 'staging', 'p_staging', ?, ?)",
		rusqlite::params![project_id, now(), now()],
	)
	.unwrap();
	db.exec(
		"INSERT INTO services (id, project_id, environment_id, compose_service_name, created_at) VALUES (?, ?, 'env-staging', 'web', ?)",
		rusqlite::params![new_id(), project_id, now()],
	)
	.expect("staging cannot have its own web service");
}

/// 0017 drops git_accounts, which services point at. A service that used a
/// connection survives as a plain git service with everything else it owns.
#[test]
fn upgrading_to_git_providers_keeps_services() {
	let dir = tempfile::tempdir().unwrap();
	let db = open_up_to(&dir.path().join("app.db"), "0016");
	let project = new_project(&db, "app");
	let account_id = new_id();
	db.exec(
		"INSERT INTO git_accounts (id, provider, name, token_enc, created_at) VALUES (?, 'github', 'acme', 'sealed', ?)",
		rusqlite::params![account_id, now()],
	)
	.unwrap();
	let service_id = new_id();
	db.exec(
		"INSERT INTO services (id, project_id, environment_id, compose_service_name, provider, repository_url, branch, git_account_id, created_at)
		 VALUES (?, ?, ?, 'web', 'github', 'https://github.com/acme/web.git', 'main', ?, ?)",
		rusqlite::params![service_id, project.id, project.id, account_id, now()],
	)
	.unwrap();
	db.upsert_secret(SERVICE_SCOPE, &service_id, "TOKEN", "sealed", true).unwrap();
	db.migrate().unwrap();
	assert_eq!(integrity(&db), "ok");
	let service = db.service_by_id(&service_id).unwrap();
	assert_eq!(service.provider, PROVIDER_GIT);
	assert_eq!(service.repository_url, "https://github.com/acme/web.git");
	assert_eq!(db.list_secrets(SERVICE_SCOPE, &service_id).unwrap().len(), 1);
}

#[test]
fn task_runs_are_truncated_and_pruned() {
	let (_dir, db) = Db::open_temp();
	let project = new_project(&db, "tasks");
	let mut service = Service {
		id: new_id(),
		project_id: project.id.clone(),
		environment_id: project.id.clone(),
		compose_service_name: "app".into(),
		kind: SERVICE_APPLICATION.into(),
		provider: PROVIDER_GITHUB.into(),
		..Default::default()
	};
	db.create_service(&mut service).unwrap();
	let mut task = ScheduledTask {
		service_id: service.id.clone(),
		name: "backup".into(),
		schedule: "0 3 * * *".into(),
		command: "echo hi".into(),
		enabled: true,
		..Default::default()
	};
	db.create_scheduled_task(&mut task).unwrap();
	for i in 0..5 {
		let mut run = db.start_task_run(&task.id).unwrap();
		db.finish_task_run(&mut run, i, &"x".repeat((64 << 10) + 100)).unwrap();
	}
	let runs = db.task_runs(&task.id, 10).unwrap();
	assert_eq!(runs.len(), 5);
	assert_eq!(runs[0].exit_code, 4, "newest run first");
	assert!(runs[0].output.starts_with("[output truncated]") && runs[0].output.len() <= (64 << 10) + 32);
	db.prune_task_runs(2).unwrap();
	assert_eq!(db.task_runs(&task.id, 10).unwrap().len(), 2);
	let listed = db.all_scheduled_tasks().unwrap();
	assert_eq!(listed[0].last_run.as_ref().unwrap().exit_code, 4);
}
