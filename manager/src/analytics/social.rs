//! Mentions of a site on X and Reddit, polled by the scheduler and stored as
//! chart annotations. X needs the site owner's own API bearer token (the
//! recent-search endpoint is on X's paid tiers); Reddit's public search needs none.

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;

use super::truncate;
use crate::database::{ANNOTATION_REDDIT, ANNOTATION_X, Annotation, new_id};

const USER_AGENT: &str = "vexdock-analytics/1 (+https://github.com/rokartur/vexdock)";

pub fn client() -> reqwest::Client {
	reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent(USER_AGENT).build().expect("static client config")
}

/// Tweets from the last week that link to `hostname`.
pub async fn x_mentions(client: &reqwest::Client, token: &str, hostname: &str) -> Result<Vec<Annotation>> {
	let query = format!("url:\"{hostname}\" -is:retweet");
	let response = client
		.get("https://api.x.com/2/tweets/search/recent")
		.bearer_auth(token)
		.query(&[
			("query", query.as_str()),
			("max_results", "50"),
			("tweet.fields", "created_at,entities,author_id"),
			("expansions", "author_id"),
			("user.fields", "username"),
		])
		.send()
		.await
		.context("X search")?;
	let status = response.status();
	let body: Value = response.json().await.context("X search response")?;
	if !status.is_success() {
		anyhow::bail!("X search answered {status}: {}", body["title"].as_str().or(body["detail"].as_str()).unwrap_or("no detail"));
	}
	Ok(parse_x(&body))
}

pub fn parse_x(body: &Value) -> Vec<Annotation> {
	let mut usernames = std::collections::HashMap::new();
	for user in body["includes"]["users"].as_array().into_iter().flatten() {
		usernames.insert(user["id"].as_str().unwrap_or_default(), user["username"].as_str().unwrap_or_default());
	}
	let mut out = Vec::new();
	for tweet in body["data"].as_array().into_iter().flatten() {
		let (Some(id), Some(created)) = (tweet["id"].as_str(), tweet["created_at"].as_str()) else { continue };
		let Ok(at) = chrono::DateTime::parse_from_rfc3339(created) else { continue };
		let username = usernames.get(tweet["author_id"].as_str().unwrap_or_default()).copied().unwrap_or("i");
		let links = tweet["entities"]["urls"]
			.as_array()
			.into_iter()
			.flatten()
			.filter_map(|u| u["url"].as_str())
			.filter_map(|u| u.strip_prefix("https://"))
			.filter(|u| u.starts_with("t.co/"))
			.map(String::from)
			.collect();
		out.push(Annotation {
			id: new_id(),
			at: at.timestamp(),
			source: ANNOTATION_X.into(),
			text: truncate(tweet["text"].as_str().unwrap_or_default(), 500),
			url: format!("https://x.com/{username}/status/{id}"),
			author: format!("@{username}"),
			links,
			external_id: id.into(),
		});
	}
	out
}

/// Reddit posts that link to `hostname`, newest first.
pub async fn reddit_mentions(client: &reqwest::Client, hostname: &str) -> Result<Vec<Annotation>> {
	let query = format!("url:\"{hostname}\"");
	let response = client
		.get("https://www.reddit.com/search.json")
		.query(&[("q", query.as_str()), ("sort", "new"), ("limit", "50")])
		.send()
		.await
		.context("Reddit search")?
		.error_for_status()
		.context("Reddit search")?;
	Ok(parse_reddit(&response.json().await.context("Reddit search response")?))
}

pub fn parse_reddit(body: &Value) -> Vec<Annotation> {
	let mut out = Vec::new();
	for post in body["data"]["children"].as_array().into_iter().flatten() {
		let post = &post["data"];
		let (Some(id), Some(created), Some(permalink)) = (post["id"].as_str(), post["created_utc"].as_f64(), post["permalink"].as_str())
		else {
			continue;
		};
		out.push(Annotation {
			id: new_id(),
			at: created as i64,
			source: ANNOTATION_REDDIT.into(),
			text: truncate(post["title"].as_str().unwrap_or_default(), 500),
			url: format!("https://www.reddit.com{permalink}"),
			author: post["subreddit_name_prefixed"].as_str().unwrap_or_default().into(),
			links: Vec::new(),
			external_id: id.into(),
		});
	}
	out
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn x_mention_keeps_its_tco_links() {
		let body = json!({
			"data": [{"id": "1", "text": "Shipped!", "created_at": "2026-11-01T10:00:00.000Z", "author_id": "9",
				"entities": {"urls": [{"url": "https://t.co/AbC123", "expanded_url": "https://shop.example.com"}]}}],
			"includes": {"users": [{"id": "9", "username": "marc"}]}
		});
		let m = &parse_x(&body)[0];
		assert_eq!((m.author.as_str(), m.url.as_str()), ("@marc", "https://x.com/marc/status/1"));
		assert_eq!(m.links, vec!["t.co/AbC123".to_string()], "the form referrer_host stores");
	}

	#[test]
	fn reddit_post() {
		let body = json!({"data": {"children": [{"data": {"id": "abc", "title": "Look", "created_utc": 1_800_000_000.0,
			"permalink": "/r/rust/comments/abc/look/", "subreddit_name_prefixed": "r/rust"}}]}});
		let m = &parse_reddit(&body)[0];
		assert_eq!((m.at, m.author.as_str(), m.external_id.as_str()), (1_800_000_000, "r/rust", "abc"));
	}
}
