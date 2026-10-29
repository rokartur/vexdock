//! The platform manager: the only component with access to the Docker socket.
//! Nginx terminates traffic and proxies /api here.
//!
//! Copyright (C) 2026 Platform contributors.
//! Licensed under the GNU Affero General Public License v3.0 or later; see the
//! LICENSE file at the repository root.

use std::net::SocketAddr;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tokio::sync::watch;
use vexdock_manager::api::{self, Server};
use vexdock_manager::config::Config;
use vexdock_manager::database::Db;
use vexdock_manager::docker::Docker;
use vexdock_manager::events::Reconciler;
use vexdock_manager::security::{self, Cipher};
use vexdock_manager::{certificates, database, metrics};

const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);

#[tokio::main]
async fn main() -> ExitCode {
	if std::env::args().skip(1).any(|arg| arg == "-healthcheck" || arg == "--healthcheck") {
		return probe_health().await;
	}
	init_logging();
	match run().await {
		Ok(()) => ExitCode::SUCCESS,
		Err(err) => {
			tracing::error!(error = %format!("{err:#}"), "manager stopped");
			ExitCode::FAILURE
		}
	}
}

async fn run() -> Result<()> {
	let cfg = Arc::new(Config::load().context("configuration")?);
	tracing::info!(version = %cfg.version, root = %cfg.root, "starting manager");

	let db = Arc::new(Db::open(&cfg.database_path())?);
	let cipher = Arc::new(Cipher::load_or_create(Path::new(&cfg.master_key_path()))?);
	let docker = Arc::new(Docker::new()?);
	docker.ping().await.context("docker daemon unreachable")?;
	docker.ensure_network(&cfg.proxy_network).await.context("proxy network")?;

	let server = Server::new(Arc::clone(&cfg), Arc::clone(&db), Arc::clone(&docker), Arc::clone(&cipher));
	if let Err(err) = load_cloudflare_token(&server) {
		tracing::warn!(error = %format!("{err:#}"), "cloudflare token unavailable, falling back to http-01");
	}
	if let Err(err) = backfill_webhook_secrets(&db, &cipher) {
		tracing::warn!(error = %format!("{err:#}"), "webhook secret backfill incomplete, affected connections keep their old hook URL");
	}
	if let Err(err) = server.deployments.recover_interrupted() {
		tracing::warn!(error = %format!("{err:#}"), "recover interrupted deployments");
	}
	if let Err(err) = db.recover_interrupted_task_runs() {
		tracing::warn!(error = %format!("{err:#}"), "recover interrupted task runs");
	}

	tokio::spawn(Reconciler::new(Arc::clone(&docker), Arc::clone(&server.domains), Arc::clone(&server.bus)).run());
	tokio::spawn(scheduler(Arc::clone(&server)));
	tokio::spawn(metrics::Sampler::new(Arc::clone(&db), Arc::clone(&docker), cfg.root.clone()).run());
	tokio::spawn(Arc::clone(&server.tasks).run());

	// Dropping the sender is the shutdown signal every listener waits for.
	let (shutdown, stopped) = watch::channel(());
	let mut serving = tokio::task::JoinSet::new();
	for addr in listen_addrs(&cfg, &docker).await? {
		let listener = TcpListener::bind(&addr).await.with_context(|| format!("listen on {addr}"))?;
		tracing::info!(addr, "listening");
		let app = api::router(Arc::clone(&server)).into_make_service_with_connect_info::<SocketAddr>();
		let mut stopped = stopped.clone();
		serving.spawn(async move {
			axum::serve(listener, app).with_graceful_shutdown(async move { while stopped.changed().await.is_ok() {} }).await
		});
	}

	tokio::select! {
		Some(result) = serving.join_next() => {
			result??;
			anyhow::bail!("a listener stopped without an error");
		}
		() = terminated() => tracing::info!("shutting down"),
	}
	drop(shutdown);
	// SSE streams and terminals never finish on their own, so the grace period is a cap.
	let _ = tokio::time::timeout(SHUTDOWN_GRACE, async { while serving.join_next().await.is_some() {} }).await;
	Ok(())
}

async fn terminated() {
	let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("install SIGTERM handler");
	tokio::select! {
		_ = tokio::signal::ctrl_c() => {}
		_ = sigterm.recv() => {}
	}
}

/// Keeps the API off every network except the platform's own, so a user
/// network the manager joins for Studio cannot reach it. Loopback serves the
/// healthcheck.
async fn listen_addrs(cfg: &Config, docker: &Docker) -> Result<Vec<String>> {
	let (host, port) = cfg.listen_addr.rsplit_once(':').context("PLATFORM_LISTEN: missing port")?;
	if !host.is_empty() {
		return Ok(vec![cfg.listen_addr.clone()]);
	}
	let ip = docker
		.self_ip(&cfg.internal_network)
		.await
		.with_context(|| format!("binding the API to {} (set a host in PLATFORM_LISTEN outside a container)", cfg.internal_network))?;
	Ok(vec![format!("{ip}:{port}"), format!("127.0.0.1:{port}")])
}

/// Applies the stored DNS-01 credential to the issuer at boot. Without it the
/// issuer stays on HTTP-01, which cannot do wildcards.
fn load_cloudflare_token(server: &Server) -> Result<()> {
	let stored = server.db.setting(certificates::SETTING_CLOUDFLARE_TOKEN)?;
	if stored.is_empty() {
		return Ok(());
	}
	server.certs.set_cloudflare_token(&server.cipher.decrypt(&stored)?);
	Ok(())
}

/// Gives connections made before migration 0023 a token. Their old hook URL
/// stops deploying until the owner copies the new one out of the panel, which
/// is the point: it was accepting anyone's push.
fn backfill_webhook_secrets(db: &Db, cipher: &Cipher) -> Result<()> {
	for p in db.list_git_providers()? {
		if p.provider_type == database::PROVIDER_GITHUB || !p.webhook_secret_enc.is_empty() {
			continue;
		}
		db.set_webhook_secret(&p.id, &cipher.encrypt(&security::random_token(24))?)?;
	}
	Ok(())
}

/// The platform's periodic work: certificate renewal and the retention of
/// audit rows, metrics, task runs, deployments and backups. Checked a minute
/// after boot and then every six hours.
async fn scheduler(server: Arc<Server>) {
	tokio::time::sleep(Duration::from_secs(60)).await;
	let mut ticker = tokio::time::interval(Duration::from_secs(6 * 3600));
	loop {
		ticker.tick().await;
		server.domains.renew_expiring().await;
		let metrics_cutoff = chrono::Utc::now().timestamp() - metrics::RETENTION.as_secs() as i64;
		let retention = [
			("audit retention", server.db.prune_audit(5000)),
			("metrics retention", server.db.prune_metrics(metrics_cutoff)),
			("task run retention", server.db.prune_task_runs(20)),
			// Deployment steps hold the whole build log, the largest table on a
			// box that deploys often.
			("deployment retention", server.db.prune_deployments(50)),
			("backup retention", server.backups.prune(10)),
		];
		for (what, result) in retention {
			if let Err(err) = result {
				tracing::warn!(error = %format!("{err:#}"), "{what}");
			}
		}
	}
}

/// Used by the container HEALTHCHECK and by the updater, so the image needs no
/// curl or wget.
async fn probe_health() -> ExitCode {
	let addr = std::env::var("PLATFORM_LISTEN").unwrap_or_default();
	let port = addr.rsplit_once(':').map_or("8080", |(_, port)| port);
	let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("http client");
	match client.get(format!("http://127.0.0.1:{port}/api/health")).send().await {
		Ok(resp) if resp.status() == reqwest::StatusCode::OK => ExitCode::SUCCESS,
		Ok(resp) => {
			eprintln!("health returned {}", resp.status().as_u16());
			ExitCode::FAILURE
		}
		Err(err) => {
			eprintln!("{err}");
			ExitCode::FAILURE
		}
	}
}

/// JSON lines on stdout at PLATFORM_LOG_LEVEL (debug, info, warn, error).
fn init_logging() {
	let level = match std::env::var("PLATFORM_LOG_LEVEL").as_deref() {
		Ok("debug") => tracing::Level::DEBUG,
		Ok("warn") => tracing::Level::WARN,
		Ok("error") => tracing::Level::ERROR,
		_ => tracing::Level::INFO,
	};
	tracing_subscriber::fmt().json().flatten_event(true).with_max_level(level).with_target(false).init();
}
