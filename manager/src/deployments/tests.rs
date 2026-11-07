use super::*;
use crate::certificates::Issuer;
use crate::nginx::Nginx;
use crate::security::Cipher;

struct Fixture {
	_dir: tempfile::TempDir,
	engine: Arc<Engine>,
}

/// An engine over a temporary database holding project p1 and its default
/// environment. Nothing here reaches docker.
fn fixture() -> Fixture {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_str().unwrap();
	let db = Arc::new(Db::open(&format!("{root}/app.db")).unwrap());
	db.create_project(&mut Project {
		id: "p1".into(),
		name: "P".into(),
		slug: "p".into(),
		compose_project_name: "p_p1".into(),
		..Default::default()
	})
	.unwrap();
	db.create_environment(&mut Environment {
		id: "p1".into(),
		project_id: "p1".into(),
		name: "Production".into(),
		slug: "production".into(),
		compose_project_name: "p_p1".into(),
		is_default: true,
		..Default::default()
	})
	.unwrap();
	let cfg = Arc::new(Config::at(root));
	let docker = Arc::new(Docker::unreachable());
	let projects = Arc::new(Projects::new(Arc::clone(&db), Arc::clone(&cfg), Arc::new(Cipher::new(&[7u8; 32]).unwrap())));
	let nginx = Arc::new(Nginx::new(format!("{root}/nginx"), "vexdock-nginx".into(), Arc::clone(&docker)));
	let certs = Arc::new(Issuer::new(format!("{root}/certificates"), format!("{root}/challenge"), String::new(), String::new()));
	let domains = Arc::new(Domains::new(Arc::clone(&db), Arc::clone(&cfg), Arc::clone(&docker), nginx, certs));
	let engine = Engine::new(db, cfg, projects, domains, docker, Bus::new());
	Fixture { _dir: dir, engine }
}

fn queued(e: &Engine, service: &str) -> Deployment {
	let mut d = Deployment {
		project_id: "p1".into(),
		environment_id: "p1".into(),
		service_name: service.into(),
		trigger: TRIGGER_MANUAL.into(),
		..Default::default()
	};
	e.db.create_deployment(&mut d).unwrap();
	d
}

// finish is the one place a deployment leaves queued or running. It settles the
// row even when the pipeline never read it, which is what a cancel while
// queued looks like.
#[tokio::test]
async fn finish_settles_every_outcome() {
	let f = fixture();
	let e = &f.engine;
	for (name, outcome, status) in [
		("success", Ok(()), database::DEPLOYMENT_SUCCESS),
		("cancelled before it was read", Err(Cancelled.into()), database::DEPLOYMENT_CANCELLED),
		("failed", Err(anyhow!("compose config failed")), database::DEPLOYMENT_FAILED),
	] {
		let failed = outcome.is_err();
		let d = queued(e, "");
		Pipeline::new(e, &d.id, "").finish(outcome);
		let got = e.db.deployment_by_id(&d.id).unwrap();
		assert_eq!(got.status, status, "{name}");
		assert!(!got.finished_at.is_empty(), "{name}: finished_at was not recorded");
		assert!(!failed || !got.error.is_empty(), "{name}: a failed outcome recorded no error");
	}
}

// The step a cancel interrupts ends as cancelled, so the pipeline does not
// show a failure beside a canceled deployment; any other error fails it.
#[tokio::test]
async fn interrupted_step_ends_like_the_deployment() {
	let f = fixture();
	let e = &f.engine;
	for (outcome, status) in
		[(Err(Cancelled.into()), database::DEPLOYMENT_CANCELLED), (Err(anyhow!("timed out")), database::DEPLOYMENT_FAILED)]
	{
		let d = queued(e, "");
		let mut pipeline = Pipeline::new(e, &d.id, "");
		pipeline.begin(STEP_PULL);
		pipeline.finish(outcome);
		let steps = e.db.list_steps(&d.id).unwrap();
		assert_eq!(steps.last().unwrap().status, status);
	}
}

// A deployment waiting for a global slot is still cancelable: it leaves as
// cancelled, never as a row stuck in queued behind a slot it never got.
#[tokio::test]
async fn cancel_while_waiting_for_slot() {
	let f = fixture();
	let e = Arc::clone(&f.engine);
	// Every slot is taken by somebody else.
	let taken = e.slots.acquire_many(MAX_CONCURRENT as u32).await.unwrap();

	let d = queued(&e, "web");
	let run = tokio::spawn({
		let e = Arc::clone(&e);
		let id = d.id.clone();
		async move { e.run("p1", &id, "").await }
	});
	// cancel registers in run before the slot wait, so poll until it is there.
	while e.cancel(&d.id).is_err() {
		tokio::time::sleep(Duration::from_millis(5)).await;
	}
	tokio::time::timeout(Duration::from_secs(5), run).await.expect("run returned after cancel").unwrap();

	assert_eq!(e.db.deployment_by_id(&d.id).unwrap().status, database::DEPLOYMENT_CANCELLED);
	drop(taken);
	assert_eq!(e.slots.available_permits(), MAX_CONCURRENT, "a cancelled deployment released a slot it never held");
}

#[test]
fn tail_keeps_the_end() {
	assert_eq!(tail("abcdef", 10, false), "abcdef");
	assert_eq!(tail("abcdef", 3, false), "... truncated ...\ndef");
	assert_eq!(tail("abc", 10, true), "... truncated ...\nabc");
}

// A webhook burst or repeated clicks must not grow the shared queue: while one
// deployment of the same thing waits, a new trigger returns it.
#[tokio::test]
async fn trigger_joins_a_waiting_deployment() {
	let f = fixture();
	let e = &f.engine;
	let taken = e.slots.acquire_many(MAX_CONCURRENT as u32).await.unwrap();
	let project = e.db.project_by_id("p1").unwrap();
	let env = e.db.environment_by_id("p1").unwrap();
	let opts = |service: &str| Options { trigger: TRIGGER_MANUAL.into(), service_name: service.into(), ..Default::default() };
	let first = e.trigger(&project, &env, opts("web")).unwrap();
	let second = e.trigger(&project, &env, opts("web")).unwrap();
	let other = e.trigger(&project, &env, opts("api")).unwrap();
	assert_eq!(second.id, first.id, "a second deployment of the same service was queued");
	assert_ne!(other.id, first.id);
	for id in [&first.id, &other.id] {
		while e.cancel(id).is_err() {
			tokio::time::sleep(Duration::from_millis(5)).await;
		}
	}
	drop(taken);
}
