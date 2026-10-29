use std::collections::HashMap;

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use super::Db;

/// One bucket of host usage. `at` is unix seconds.
#[derive(Clone, Debug, Default, Serialize)]
pub struct HostPoint {
	pub at: i64,
	pub cpu_percent: f64,
	pub memory_used: u64,
	pub memory_total: u64,
	pub disk_used: u64,
	pub disk_total: u64,
}

/// One bucket of container usage. The byte counters are cumulative since
/// container start; the panel turns them into rates.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ContainerPoint {
	pub at: i64,
	pub cpu_percent: f64,
	pub memory_usage: u64,
	pub memory_limit: u64,
	pub network_rx: u64,
	pub network_tx: u64,
	pub block_read: u64,
	pub block_write: u64,
}

/// One container reading handed to record_container_metrics.
#[derive(Clone, Debug, Default)]
pub struct ContainerSample {
	pub container_id: String,
	pub service_id: String,
	pub cpu_percent: f64,
	pub memory_usage: u64,
	pub memory_limit: u64,
	pub network_rx: u64,
	pub network_tx: u64,
	pub block_read: u64,
	pub block_write: u64,
}

/// What one container's row on the containers list reads: the newest bucket,
/// plus every bucket in the window for the sparkline.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ContainerUsage {
	pub cpu_percent: f64,
	pub memory_usage: u64,
	pub memory_limit: u64,
	pub cpu_series: Vec<f64>,
}

impl Db {
	pub fn record_host_metric(&self, at: i64, p: &HostPoint) -> Result<()> {
		self.exec(
			"INSERT INTO host_metrics (at, cpu_percent, memory_used, memory_total, disk_used, disk_total) VALUES (?, ?, ?, ?, ?, ?)",
			params![at, p.cpu_percent, p.memory_used as i64, p.memory_total as i64, p.disk_used as i64, p.disk_total as i64],
		)?;
		Ok(())
	}

	/// One reading per container in a single transaction, so a tick lands whole or not at all.
	pub fn record_container_metrics(&self, at: i64, samples: &[ContainerSample]) -> Result<()> {
		if samples.is_empty() {
			return Ok(());
		}
		let mut conn = self.conn();
		let tx = conn.transaction()?;
		{
			let mut stmt = tx.prepare(
				"INSERT INTO container_metrics (at, container_id, service_id, cpu_percent, memory_usage,
				 memory_limit, network_rx, network_tx, block_read, block_write)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)?;
			for s in samples {
				stmt.execute(params![
					at,
					s.container_id,
					s.service_id,
					s.cpu_percent,
					s.memory_usage as i64,
					s.memory_limit as i64,
					s.network_rx as i64,
					s.network_tx as i64,
					s.block_read as i64,
					s.block_write as i64
				])?;
			}
		}
		tx.commit()?;
		Ok(())
	}

	/// Host usage since `since`, averaged into buckets of `bucket` seconds so a
	/// long window still yields a chart-sized series.
	pub fn host_metrics(&self, since: i64, bucket: i64) -> Result<Vec<HostPoint>> {
		let bucket = bucket.max(1);
		self.all(
			"SELECT (at / ?) * ? AS b, AVG(cpu_percent), AVG(memory_used), MAX(memory_total), AVG(disk_used), MAX(disk_total)
			 FROM host_metrics WHERE at >= ? GROUP BY b ORDER BY b",
			params![bucket, bucket, since],
			|r| {
				Ok(HostPoint {
					at: r.get(0)?,
					cpu_percent: r.get(1)?,
					memory_used: r.get::<_, f64>(2)? as u64,
					memory_total: r.get::<_, i64>(3)? as u64,
					disk_used: r.get::<_, f64>(4)? as u64,
					disk_total: r.get::<_, i64>(5)? as u64,
				})
			},
		)
	}

	/// One service's usage since `since`, bucketed like host_metrics. Cumulative
	/// counters take the bucket maximum, so consecutive buckets still differ by
	/// the bytes moved between them.
	pub fn service_metrics(&self, service_id: &str, since: i64, bucket: i64) -> Result<Vec<ContainerPoint>> {
		let bucket = bucket.max(1);
		self.all(
			"SELECT (at / ?) * ? AS b, AVG(cpu_percent), AVG(memory_usage), MAX(memory_limit),
			        MAX(network_rx), MAX(network_tx), MAX(block_read), MAX(block_write)
			 FROM container_metrics WHERE service_id = ? AND at >= ? GROUP BY b ORDER BY b",
			params![bucket, bucket, service_id, since],
			|r| {
				Ok(ContainerPoint {
					at: r.get(0)?,
					cpu_percent: r.get(1)?,
					memory_usage: r.get::<_, f64>(2)? as u64,
					memory_limit: r.get::<_, i64>(3)? as u64,
					network_rx: r.get::<_, i64>(4)? as u64,
					network_tx: r.get::<_, i64>(5)? as u64,
					block_read: r.get::<_, i64>(6)? as u64,
					block_write: r.get::<_, i64>(7)? as u64,
				})
			},
		)
	}

	/// The newest reading per service, ignoring anything before `since` so a
	/// service that stopped an hour ago reads as no reading at all. SQLite takes
	/// the bare columns from the same row as the MAX().
	pub fn latest_service_metrics(&self, since: i64) -> Result<HashMap<String, ContainerPoint>> {
		let rows = self.all(
			"SELECT service_id, MAX(at), cpu_percent, memory_usage, memory_limit
			 FROM container_metrics WHERE service_id != '' AND at >= ? GROUP BY service_id",
			[since],
			|r| {
				let point = ContainerPoint {
					at: r.get(1)?,
					cpu_percent: r.get(2)?,
					memory_usage: r.get::<_, i64>(3)? as u64,
					memory_limit: r.get::<_, i64>(4)? as u64,
					..Default::default()
				};
				Ok((r.get::<_, String>(0)?, point))
			},
		)?;
		Ok(rows.into_iter().collect())
	}

	/// Usage per container id since `since`, bucketed like host_metrics. Keyed
	/// by container id, so containers the platform does not manage are in it too.
	pub fn container_usage(&self, since: i64, bucket: i64) -> Result<HashMap<String, ContainerUsage>> {
		let rows = self.all(
			"SELECT container_id, AVG(cpu_percent), AVG(memory_usage), MAX(memory_limit)
			 FROM container_metrics WHERE at >= ?
			 GROUP BY container_id, at / ? ORDER BY container_id, MIN(at)",
			params![since, bucket.max(1)],
			|r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?, r.get::<_, i64>(3)?)),
		)?;
		let mut out: HashMap<String, ContainerUsage> = HashMap::new();
		for (id, cpu, memory_usage, memory_limit) in rows {
			// Ordered by bucket, so the last row for an id is the newest reading.
			let usage = out.entry(id).or_default();
			usage.cpu_percent = cpu;
			usage.memory_usage = memory_usage as u64;
			usage.memory_limit = memory_limit as u64;
			usage.cpu_series.push(cpu);
		}
		Ok(out)
	}

	/// Drops readings older than `before` (unix seconds), keeping both tables bounded.
	pub fn prune_metrics(&self, before: i64) -> Result<()> {
		self.exec("DELETE FROM host_metrics WHERE at < ?", [before])?;
		self.exec("DELETE FROM container_metrics WHERE at < ?", [before])?;
		Ok(())
	}
}
