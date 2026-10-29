use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Result, bail};
use regex::Regex;
use serde::Deserialize;

use super::{Engine, TAG_PATTERN};

/// Keeps the version picker responsive: a slow Docker Hub degrades to the
/// offline list, never hangs the dashboard.
const TAG_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Docker Hub returns hundreds of tags for a popular image and none of the tail
/// is a version anyone deliberately picks.
const MAX_TAGS: usize = 60;

/// An engine's tags newest first: the curated list merged with what Docker Hub
/// knows, ordered by version rather than push date. On error the caller falls
/// back to the curated list. The repository comes from the catalog, never the
/// caller, so this cannot be pointed at an arbitrary host.
pub async fn versions(engine: &Engine) -> Result<Vec<String>> {
	if engine.repository.is_empty() {
		bail!("engine {:?} has no curated repository", engine.slug);
	}
	let curated: Vec<String> = engine.versions.iter().map(|v| v.to_string()).collect();
	// A repository qualified with its own registry host is not on Docker Hub.
	if engine.repository.split('/').next().unwrap_or("").contains('.') {
		return Ok(curated);
	}
	#[derive(Deserialize)]
	struct Tag {
		name: String,
	}
	#[derive(Deserialize)]
	struct Body {
		#[serde(default)]
		results: Vec<Tag>,
	}
	let endpoint = format!("https://hub.docker.com/v2/repositories/{}/tags?page_size=100&ordering=last_updated", engine.repository);
	let response = reqwest::Client::builder().timeout(TAG_LOOKUP_TIMEOUT).build()?.get(endpoint).send().await?;
	if response.status() != reqwest::StatusCode::OK {
		bail!("docker hub returned {}", response.status());
	}
	let bytes = response.bytes().await?;
	if bytes.len() > 1 << 20 {
		bail!("docker hub answered more than 1 MiB");
	}
	let body: Body = serde_json::from_slice(&bytes)?;
	let mut out = curated;
	let mut seen: HashSet<String> = out.iter().cloned().collect();
	for tag in body.results {
		// A tag from the network ends up in an image reference, so it is held to
		// the same pattern as one typed by a user.
		if !TAG_PATTERN.is_match(&tag.name) || !seen.insert(tag.name.clone()) {
			continue;
		}
		out.push(tag.name);
	}
	newest_first(&mut out);
	out.truncate(MAX_TAGS);
	Ok(out)
}

// The version a tag starts with: 18 in "18-alpine3.24", 0.24.33 in "v0.24.33", nothing in "bookworm".
static LEADING_VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^v?(\d+(?:\.\d+)*)").unwrap());
// Keeps a beta of the next major from outranking the current one.
static PRERELEASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)alpha|beta|rc|nightly|unstable|preview").unwrap());

/// Sorts tags by the version they start with, descending. "latest" leads,
/// prereleases sink below released versions, a tag with no version keeps its
/// Docker Hub order at the bottom. On a shared prefix the shorter tag wins, so
/// the floating "18" sits above "18.6-alpine3.24".
pub fn newest_first(tags: &mut [String]) {
	tags.sort_by(|a, b| {
		let (na, nb) = (version_numbers(a), version_numbers(b));
		tag_group(a, &na).cmp(&tag_group(b, &nb)).then_with(|| {
			for (x, y) in na.iter().zip(&nb) {
				if x != y {
					return y.cmp(x);
				}
			}
			na.len().cmp(&nb.len())
		})
	});
}

fn version_numbers(tag: &str) -> Vec<u64> {
	let Some(captures) = LEADING_VERSION.captures(tag) else { return Vec::new() };
	let mut out = Vec::new();
	for part in captures[1].split('.') {
		match part.parse() {
			Ok(n) => out.push(n),
			Err(_) => return out,
		}
	}
	out
}

fn tag_group(tag: &str, numbers: &[u64]) -> u8 {
	if tag == "latest" {
		0
	} else if numbers.is_empty() {
		3
	} else if PRERELEASE.is_match(tag) {
		2
	} else {
		1
	}
}
