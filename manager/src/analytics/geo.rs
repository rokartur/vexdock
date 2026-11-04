//! Country, region and city from the visitor's address, read from the free
//! DB-IP Lite City database (CC BY 4.0, https://db-ip.com). The manager
//! downloads it on first boot and monthly after; until it is there, hits fall
//! back to Cloudflare's country or the browser's timezone. The address is only
//! looked up, never stored.

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use chrono::Datelike;
use maxminddb::{Mmap, Reader, geoip2};

use super::Place;

/// DB-IP publishes a new file at the start of each month.
const REFRESH_AFTER: Duration = Duration::from_secs(30 * 86_400);
const FILE_NAME: &str = "dbip-city-lite.mmdb";

pub struct Geo {
	path: PathBuf,
	reader: RwLock<Option<Arc<Reader<Mmap>>>>,
}

impl Geo {
	/// Opens the database in `dir` if an earlier boot downloaded it.
	pub fn new(dir: &str) -> Geo {
		let geo = Geo { path: PathBuf::from(dir).join(FILE_NAME), reader: RwLock::new(None) };
		if geo.path.exists()
			&& let Err(err) = geo.open()
		{
			tracing::warn!(error = %format!("{err:#}"), "geo database unreadable, waiting for the next download");
		}
		geo
	}

	/// An empty place for an address the database does not know, a private one,
	/// or while there is no database.
	pub fn lookup(&self, ip: &str) -> Place {
		let Ok(ip) = ip.trim().parse::<IpAddr>() else { return Place::default() };
		let Some(reader) = self.reader.read().unwrap_or_else(|p| p.into_inner()).clone() else { return Place::default() };
		let Ok(Some(city)) = reader.lookup(ip).and_then(|found| found.decode::<geoip2::City>()) else { return Place::default() };
		Place {
			country: city.country.iso_code.unwrap_or_default().into(),
			region: city.subdivisions.first().and_then(|s| s.names.english).unwrap_or_default().into(),
			city: city.city.names.english.unwrap_or_default().into(),
		}
	}

	/// Downloads this month's file when there is none or it is a month old.
	pub async fn refresh(&self) -> Result<()> {
		let age = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
		if age.is_some_and(|age| age < REFRESH_AFTER) {
			return Ok(());
		}
		let client = reqwest::Client::builder().timeout(Duration::from_secs(600)).build()?;
		let today = chrono::Utc::now().date_naive();
		let last_month = today - chrono::Months::new(1);
		let mut gz = None;
		// Early in a month this month's file may not be out yet.
		for month in [today, last_month] {
			let url = format!("https://download.db-ip.com/free/dbip-city-lite-{}-{:02}.mmdb.gz", month.year(), month.month());
			let response = client.get(&url).send().await.with_context(|| format!("download {url}"))?;
			if response.status().is_success() {
				gz = Some(response.bytes().await.context("read the geo database")?);
				break;
			}
		}
		let gz = gz.context("db-ip.com has no city lite file for this or last month")?;
		let path = self.path.clone();
		let reader = tokio::task::spawn_blocking(move || -> Result<Reader<Mmap>> {
			std::fs::create_dir_all(path.parent().expect("the file sits in a directory"))?;
			let partial = path.with_extension("partial");
			let mut file = std::fs::File::create(&partial)?;
			std::io::copy(&mut flate2::read::GzDecoder::new(&gz[..]), &mut file).context("unpack the geo database")?;
			// Opened before the rename, so a truncated download never replaces a good file.
			// SAFETY: the file is only ever replaced by a rename, never written in place.
			let reader = unsafe { Reader::open_mmap(&partial) }.context("the downloaded geo database does not open")?;
			// A rename keeps the old file's pages valid for the mapping still reading it.
			std::fs::rename(&partial, &path)?;
			Ok(reader)
		})
		.await??;
		*self.reader.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(reader));
		Ok(())
	}

	fn open(&self) -> Result<()> {
		// SAFETY: the file is only ever replaced by a rename, never written in place.
		let reader = unsafe { Reader::open_mmap(&self.path) }.context("open the geo database")?;
		*self.reader.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(reader));
		Ok(())
	}
}
