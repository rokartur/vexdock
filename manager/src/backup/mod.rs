//! Snapshots the platform's own state: both databases, the generated proxy
//! configuration, the certificates and the master key. Application data in
//! named volumes is included on request, because archiving it is slow.
//!
//! A snapshot contains the key that decrypts every stored secret, so it is as
//! sensitive as the platform itself.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use tokio::process::Command;

use crate::config::Config;
use crate::database::Db;
use crate::docker::{self, Docker};
use crate::security;

pub struct Backup {
	cfg: Arc<Config>,
	db: Arc<Db>,
	docker: Arc<Docker>,
	/// create sweeps every .partial-* directory it finds, and cannot tell a
	/// crash leftover from a snapshot another call is still writing.
	creating: tokio::sync::Mutex<()>,
}

/// One backup directory.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
	pub name: String,
	pub path: String,
	pub created_at: String,
	pub size_bytes: u64,
	/// A full backup rather than a platform-state-only one.
	pub has_volumes: bool,
}

impl Backup {
	pub fn new(cfg: Arc<Config>, db: Arc<Db>, docker: Arc<Docker>) -> Backup {
		Backup { cfg, db, docker, creating: tokio::sync::Mutex::new(()) }
	}

	/// Writes a new snapshot. With include_volumes the archive also holds a
	/// tarball per managed named volume, a restorable backup of application
	/// data rather than of platform state alone.
	pub async fn create(&self, include_volumes: bool) -> Result<Snapshot> {
		let _creating = self.creating.lock().await;
		let name = chrono::Utc::now().format("%Y-%m-%dT%H%M%S").to_string();
		// Built under a dotted name and renamed into place at the end, so a
		// snapshot in backups_dir is complete by construction and prune never
		// counts a half-written one against the copies it keeps. list and prune
		// skip dotted entries, so a crash leftover is swept here or never.
		for entry in std::fs::read_dir(&self.cfg.backups_dir)? {
			let entry = entry?;
			if entry.file_name().to_string_lossy().starts_with(".partial-") {
				remove_all(&entry.path())?;
			}
		}
		let dir = format!("{}/.partial-{name}", self.cfg.backups_dir);
		security::create_dir_mode(Path::new(&dir), 0o700)?;
		let written = self.write_snapshot(&dir, include_volumes).await.and_then(|()| {
			let fin = format!("{}/{name}", self.cfg.backups_dir);
			let size = dir_size(Path::new(&dir));
			remove_all(Path::new(&fin))?;
			std::fs::rename(&dir, &fin)?;
			Ok((fin, size))
		});
		let (path, size_bytes) = match written {
			Ok(done) => done,
			Err(err) => {
				let _ = remove_all(Path::new(&dir));
				return Err(err);
			}
		};
		Ok(Snapshot {
			name,
			path,
			created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
			size_bytes,
			has_volumes: include_volumes,
		})
	}

	async fn write_snapshot(&self, dir: &str, include_volumes: bool) -> Result<()> {
		// VACUUM INTO produces a consistent copy while the database stays open.
		self.db.conn().execute("VACUUM INTO ?", [format!("{dir}/app.db")]).context("snapshot database")?;
		// Accounts and sessions live in a second database owned by the auth
		// service. Without it a restore comes back with nobody able to log in.
		snapshot_auth_database(&self.cfg.auth_database_path(), &format!("{dir}/auth.db"))?;
		// Every encrypted variable and credential in app.db is unreadable without
		// this key, so a snapshot without it does not restore.
		copy_file(Path::new(&self.cfg.master_key_path()), Path::new(&format!("{dir}/master.key"))).context("snapshot master key")?;
		copy_tree(Path::new(&self.cfg.nginx_dir), Path::new(&format!("{dir}/nginx")))?;
		copy_tree(Path::new(&self.cfg.certificates_dir), Path::new(&format!("{dir}/certificates")))?;
		// The system compose file and its .env define which images are running.
		for name in ["compose.yml", ".env"] {
			let src = format!("{}/{name}", self.cfg.root);
			if Path::new(&src).exists() {
				copy_file(Path::new(&src), Path::new(&format!("{dir}/config-{}", name.trim_start_matches('.'))))?;
			}
		}
		if include_volumes {
			self.backup_volumes(dir).await?;
		}
		Ok(())
	}

	/// Existing snapshots, newest first.
	pub fn list(&self) -> Result<Vec<Snapshot>> {
		let mut out = Vec::new();
		for entry in std::fs::read_dir(&self.cfg.backups_dir)? {
			let entry = entry?;
			let name = entry.file_name().to_string_lossy().into_owned();
			let Ok(meta) = entry.metadata() else { continue };
			if !meta.is_dir() || name.starts_with('.') {
				continue;
			}
			let path = entry.path();
			let modified: chrono::DateTime<chrono::Utc> = meta.modified()?.into();
			out.push(Snapshot {
				has_volumes: path.join("volumes").exists(),
				size_bytes: dir_size(&path),
				path: path.to_string_lossy().into_owned(),
				created_at: modified.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
				name,
			});
		}
		out.sort_by(|a, b| b.name.cmp(&a.name));
		Ok(out)
	}

	/// Removes one snapshot by name.
	pub fn delete(&self, name: &str) -> Result<()> {
		let dir = security::resolve_inside(&self.cfg.backups_dir, name)?;
		if !Path::new(&dir).is_dir() {
			bail!("backup {name:?} not found");
		}
		remove_all(Path::new(&dir))
	}

	/// Keeps the newest keep snapshots.
	pub fn prune(&self, keep: usize) -> Result<()> {
		for snap in self.list()?.into_iter().skip(keep) {
			remove_all(Path::new(&snap.path))?;
		}
		Ok(())
	}

	/// Writes <dir>/volumes/<name>.tar.gz for every named volume that belongs to
	/// a managed project.
	// ponytail: volumes are archived while their containers keep running, so a
	// database mid-write can end up torn. Stop the project first for a transactional snapshot.
	async fn backup_volumes(&self, dir: &str) -> Result<()> {
		let managed = self.db.compose_project_names()?;
		let list = self.docker.list_volumes().await?;
		let image = self.docker.self_image().await?;
		let out = format!("{dir}/volumes");
		security::create_dir_mode(Path::new(&out), 0o700)?;
		for v in list.volumes.unwrap_or_default() {
			if !v.labels.get(docker::COMPOSE_PROJECT_LABEL).is_some_and(|project| managed.contains(project)) {
				continue;
			}
			archive_volume(&image, &v.name, &out).await.map_err(|err| anyhow!("back up volume {}: {err:#}", v.name))?;
		}
		Ok(())
	}
}

/// Runs a throwaway container because a named volume is only reachable through
/// the daemon, never from the manager's own filesystem. out_dir is identical on
/// host and in container (see compose.yml).
async fn archive_volume(image: &str, volume: &str, out_dir: &str) -> Result<()> {
	let output = Command::new("docker")
		.args(["run", "--rm", "-v", &format!("{volume}:/src:ro"), "-v", &format!("{out_dir}:/out"), "--entrypoint", "tar", image])
		.args(["czf", &format!("/out/{volume}.tar.gz"), "-C", "/src", "."])
		.kill_on_drop(true)
		.output()
		.await?;
	if !output.status.success() {
		let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
		combined.push_str(&String::from_utf8_lossy(&output.stderr));
		bail!("{}: {}", crate::compose::exit_text(output.status), combined.trim());
	}
	Ok(())
}

/// Copies the better-auth database through its own connection: another process
/// writes it, so a file copy of its WAL is not guaranteed to be restorable.
fn snapshot_auth_database(src: &str, dst: &str) -> Result<()> {
	let snapshot = || -> Result<()> {
		std::fs::metadata(src)?;
		let conn = rusqlite::Connection::open(src)?;
		conn.busy_timeout(std::time::Duration::from_secs(5))?;
		conn.execute("VACUUM INTO ?", [dst])?;
		Ok(())
	};
	snapshot().context("snapshot auth database")
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
	security::create_dir_mode(dst, 0o700)?;
	for entry in std::fs::read_dir(src)? {
		let entry = entry?;
		let kind = entry.file_type()?;
		let target = dst.join(entry.file_name());
		if kind.is_dir() {
			copy_tree(&entry.path(), &target)?;
		} else if kind.is_file() {
			copy_file(&entry.path(), &target)?;
		}
	}
	Ok(())
}

fn copy_file(src: &Path, dst: &Path) -> Result<()> {
	if let Some(parent) = dst.parent() {
		security::create_dir_mode(parent, 0o700)?;
	}
	use std::os::unix::fs::OpenOptionsExt;
	let mut input = std::fs::File::open(src)?;
	let mut output = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(dst)?;
	std::io::copy(&mut input, &mut output)?;
	Ok(())
}

fn dir_size(path: &Path) -> u64 {
	let Ok(entries) = std::fs::read_dir(path) else { return 0 };
	let mut total = 0;
	for entry in entries.flatten() {
		match entry.file_type() {
			Ok(kind) if kind.is_dir() => total += dir_size(&entry.path()),
			Ok(kind) if kind.is_file() => total += entry.metadata().map_or(0, |m| m.len()),
			_ => {}
		}
	}
	total
}

fn remove_all(path: &Path) -> Result<()> {
	match std::fs::remove_dir_all(path) {
		Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
		_ => Ok(()),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// A snapshot lands complete under its final name, carries both databases and
	// the master key, and prune counts only finished snapshots.
	#[tokio::test]
	async fn create_list_prune() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_str().unwrap();
		let cfg = Config::at(root);
		for d in [&cfg.data_dir, &cfg.backups_dir, &cfg.nginx_dir, &cfg.certificates_dir, &cfg.secrets_dir] {
			std::fs::create_dir_all(d).unwrap();
		}
		std::fs::write(cfg.master_key_path(), "key").unwrap();
		std::fs::write(format!("{}/site.conf", cfg.nginx_dir), "server {}").unwrap();
		rusqlite::Connection::open(cfg.auth_database_path()).unwrap().execute_batch("CREATE TABLE user (id TEXT)").unwrap();
		std::fs::create_dir(format!("{}/.partial-crashed", cfg.backups_dir)).unwrap();
		let db = Arc::new(Db::open(&cfg.database_path()).unwrap());
		let backup = Backup::new(Arc::new(cfg.clone()), db, Arc::new(Docker::unreachable()));

		let snap = backup.create(false).await.unwrap();
		for file in ["app.db", "auth.db", "master.key", "nginx/site.conf"] {
			assert!(Path::new(&format!("{}/{file}", snap.path)).is_file(), "{file} missing from the snapshot");
		}
		assert!(!Path::new(&format!("{}/.partial-crashed", cfg.backups_dir)).exists(), "a crash leftover survived");
		let listed = backup.list().unwrap();
		assert_eq!(listed.len(), 1);
		assert_eq!(listed[0].name, snap.name);
		assert!(!listed[0].has_volumes);

		backup.prune(0).unwrap();
		assert!(backup.list().unwrap().is_empty());
		assert!(backup.delete("../data").is_err());
	}
}
