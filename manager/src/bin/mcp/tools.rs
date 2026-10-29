use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use anyhow::{Context, bail};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use vexdock_manager::git::path_escape;

use crate::Progress;
use crate::manager::{Manager, Query};

const DEPLOY_POLL: Duration = Duration::from_secs(2);
const DEPLOY_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const LOG_TAIL_LINES: usize = 50;

pub const INSTRUCTIONS: &str =
	"Call whoami first: it says whether this token is an administrator or which projects it reaches, at read or write.
deploy and rollback wait for the pipeline and answer each service's status with the tail of its log.";

/// One entry of tools/list. `run` below is the other half: a tool named here
/// and not there answers "unknown tool", which the test catches.
struct Tool {
	name: &'static str,
	description: &'static str,
	/// None: read-only. Some(destructive): changes state.
	changes: Option<bool>,
	input: Vec<Field>,
}

/// One argument: name, JSON schema, description, required.
type Field = (&'static str, Value, &'static str, bool);

fn string() -> Value {
	json!({"type": "string"})
}

fn integer() -> Value {
	json!({"type": "integer"})
}

fn boolean() -> Value {
	json!({"type": "boolean"})
}

/// A list a client may also send as null, which reads as empty.
fn strings() -> Value {
	json!({"type": ["null", "array"], "items": {"type": "string"}})
}

fn project_ref() -> Vec<Field> {
	vec![
		("project_id", string(), "the project id from list_projects", true),
		("environment_id", string(), "an environment id from get_project; the project's default environment when omitted", false),
	]
}

fn service_ref() -> Field {
	("service_id", string(), "the service id from get_project", true)
}

fn deployment_ref() -> Field {
	("deployment_id", string(), "the deployment id from deploy or list_deployments", true)
}

fn variables_ref() -> Vec<Field> {
	vec![
		("scope", string(), "project (every environment), environment (one environment) or service (one service)", true),
		("id", string(), "the id of the project, environment or service the scope names", true),
	]
}

fn catalog() -> Vec<Tool> {
	let read = |name, description, input| Tool { name, description, changes: None, input };
	let change = |name, description, destructive, input| Tool { name, description, changes: Some(destructive), input };
	vec![
		read("whoami", "The account behind this token and what it may do: admin, or a list of project ids with read or write.", vec![]),
		read("list_projects", "Every project this token can read, with its environments and container counts.", vec![]),
		read(
			"get_project",
			"One project in one environment: the project, its environments, services with their state, domains and the last ten deployments.",
			project_ref(),
		),
		read("get_service", "One service's configuration and its scheduled tasks.", vec![service_ref()]),
		read(
			"service_logs",
			"The last lines a service's container wrote. stderr lines are prefixed with [stderr].",
			vec![service_ref(), ("tail", integer(), "how many of the last lines to read; 200 when omitted", false)],
		),
		read("service_stats", "One live CPU, memory, network and disk sample of a running service's container.", vec![service_ref()]),
		read("list_deployments", "The last fifty deployments of one environment of a project, newest first.", project_ref()),
		read(
			"get_deployment",
			"One deployment and its pipeline steps, each step's output cut to its last fifty lines.",
			vec![deployment_ref()],
		),
		read(
			"list_templates",
			"The application templates add_service_from_template accepts: the services each adds and the one its domain reaches.",
			vec![],
		),
		change(
			"deploy",
			"Build and start the latest source of a project or one service, wait for the pipeline (up to 15 minutes) and answer each deployment's status and log tail.",
			false,
			vec![
				("project_id", string(), "deploy every service of this project's environment; give this or service_id", false),
				("service_id", string(), "deploy only this service; give this or project_id", false),
				("environment_id", string(), "with project_id: the environment to deploy; the default one when omitted", false),
			],
		),
		change("cancel_deployment", "Stop a queued or running deployment.", false, vec![deployment_ref()]),
		change(
			"rollback",
			"Redeploy the image a past successful deployment built, wait for it and answer its status.",
			false,
			vec![deployment_ref()],
		),
		change(
			"service_action",
			"Start, stop or restart a service's container without building anything.",
			false,
			vec![service_ref(), ("action", string(), "start, stop or restart", true)],
		),
		change(
			"service_exec",
			"Run a command in a service's running container and answer its exit code and output. Not interactive; abandoned after ten minutes.",
			true,
			vec![
				service_ref(),
				("command", string(), "the command line, run by the shell inside the running container", true),
				("shell", string(), "sh or bash; sh when omitted", false),
			],
		),
		read(
			"get_variables",
			"The variables of one layer, values in clear. A deploy merges project, then environment, then service, the narrowest winning.",
			variables_ref(),
		),
		change(
			"set_variables",
			"Add, change or remove variables of one layer, leaving every other key as it is. Takes effect on the next deploy.",
			true,
			{
				let mut input = variables_ref();
				input.push((
					"set",
					json!({"type": "object", "additionalProperties": {"type": "string"}}),
					"keys to add or change, with their values",
					false,
				));
				input.push((
					"secret_keys",
					strings(),
					"keys of set to store as secrets; a key already stored keeps its flag otherwise",
					false,
				));
				input.push(("remove", strings(), "keys to delete", false));
				input
			},
		),
		change(
			"add_service_from_template",
			"Add a template's services to a project environment with generated passwords. Deploy afterwards to start them.",
			false,
			{
				let mut input = project_ref();
				input.push(("slug", string(), "the template slug from list_templates", true));
				input.push(("hostname", string(), "a domain to route to the template's web service, when it has one", false));
				input
			},
		),
		change(
			"update_service",
			"Change a service's configuration. Takes effect on the next deploy. Where it comes from (provider, repository, git_provider_id, owner, credentials, image, compose_fragment, registry login) needs an admin token.",
			false,
			vec![
				service_ref(),
				(
					"fields",
					json!({"type": "object"}),
					"the fields to change, named as get_service answers them: display_name, branch, image, build_type, dockerfile, build_path, compose_fragment, auto_deploy, mounts and so on",
					true,
				),
			],
		),
		change(
			"add_domain",
			"Route a hostname to a service. With https_enabled a certificate is issued; a failed issuance still adds the domain and answers a warning.",
			false,
			{
				let mut input = project_ref();
				input.push(("service", string(), "the compose service name the domain routes to", true));
				input.push((
					"hostname",
					string(),
					"the fully qualified hostname; its DNS must already point at this server for HTTPS",
					true,
				));
				input.push(("container_port", integer(), "the port the service listens on inside its container", true));
				input.push(("https_enabled", boolean(), "issue a Let's Encrypt certificate", false));
				input.push(("redirect_https", boolean(), "redirect plain http to https", false));
				input
			},
		),
		change(
			"remove_domain",
			"Stop routing a hostname. The service keeps running.",
			true,
			vec![("domain_id", string(), "the domain id from get_project", true)],
		),
		change(
			"run_task",
			"Run a scheduled task now and answer the run with its output.",
			false,
			vec![("task_id", string(), "the task id from get_service", true)],
		),
		change(
			"query_database",
			"Run SQL against a database service through its own client and answer the rows.",
			true,
			vec![
				service_ref(),
				("query", string(), "one SQL statement; it runs as written, writes included", true),
				("schema", string(), "the schema or database to run it in, for engines that have several", false),
			],
		),
		change(
			"docker_cleanup",
			"Remove what no container uses: stopped containers, dangling images, unused networks or the build cache. Admin tokens only. Volumes are never pruned here; that is data.",
			true,
			vec![("kind", string(), "containers, images, networks or build-cache", true)],
		),
	]
}

/// The tools/list answer.
pub fn list() -> Vec<Value> {
	catalog()
		.into_iter()
		.map(|tool| {
			let mut properties = Map::new();
			let mut required = Vec::new();
			for (name, mut schema, description, is_required) in tool.input {
				schema["description"] = json!(description);
				properties.insert(name.to_string(), schema);
				if is_required {
					required.push(name);
				}
			}
			let annotations = match tool.changes {
				None => json!({"readOnlyHint": true, "idempotentHint": false}),
				Some(destructive) => json!({"readOnlyHint": false, "destructiveHint": destructive, "idempotentHint": false}),
			};
			json!({
				"name": tool.name,
				"description": tool.description,
				"inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": false},
				"annotations": annotations,
			})
		})
		.collect()
}

/// Runs one tool. The answer is JSON, or plain text when it is a string; an
/// error, the manager's included, is a tool error the agent can read.
pub async fn run(name: &str, args: Value, m: &Manager, progress: &Progress) -> anyhow::Result<Value> {
	match name {
		"whoami" => m.call(Method::GET, "/api/me", &[], None).await,
		"list_projects" => m.call(Method::GET, "/api/projects", &[], None).await,
		"get_project" => get_project(m, parse(args)?).await,
		"get_service" => {
			let ServiceRef { service_id } = parse(args)?;
			let base = format!("/api/services/{}", path_escape(&service_id));
			let service = m.call(Method::GET, &base, &[], None).await?;
			let tasks = m.call(Method::GET, &format!("{base}/tasks"), &[], None).await?;
			Ok(json!({"service": service, "tasks": tasks}))
		}
		"service_logs" => service_logs(m, parse(args)?).await,
		"service_stats" => {
			let ServiceRef { service_id } = parse(args)?;
			let samples = m.events(&format!("/api/services/{}/stats", path_escape(&service_id)), &[], "stats", 1).await?;
			samples.into_iter().next().context("the container sent no sample; is it running?")
		}
		"list_deployments" => {
			let ProjectRef { project_id, environment_id } = parse(args)?;
			m.call(Method::GET, &format!("/api/projects/{}/deployments", path_escape(&project_id)), &environment(environment_id), None)
				.await
		}
		"get_deployment" => {
			let DeploymentRef { deployment_id } = parse(args)?;
			Ok(serde_json::to_value(deployment_report(m, &deployment_id).await?)?)
		}
		"list_templates" => m.call(Method::GET, "/api/templates", &[], None).await,
		"deploy" => deploy(m, progress, parse(args)?).await,
		"cancel_deployment" => {
			let DeploymentRef { deployment_id } = parse(args)?;
			m.call(Method::POST, &format!("/api/deployments/{}/cancel", path_escape(&deployment_id)), &[], None).await
		}
		"rollback" => {
			let DeploymentRef { deployment_id } = parse(args)?;
			let queued: Queued =
				m.decode(Method::POST, &format!("/api/deployments/{}/rollback", path_escape(&deployment_id)), &[], None).await?;
			wait_for_deployments(m, progress, vec![queued.id]).await
		}
		"service_action" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				service_id: String,
				action: String,
			}
			let Input { service_id, action } = parse(args)?;
			if !matches!(action.as_str(), "start" | "stop" | "restart") {
				bail!("action must be start, stop or restart");
			}
			m.call(Method::POST, &format!("/api/services/{}/{action}", path_escape(&service_id)), &[], None).await
		}
		"service_exec" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				service_id: String,
				command: String,
				#[serde(default)]
				shell: String,
			}
			let Input { service_id, command, shell } = parse(args)?;
			let mut body = json!({"command": command});
			if !shell.is_empty() {
				body["shell"] = json!(shell);
			}
			m.call(Method::POST, &format!("/api/services/{}/exec", path_escape(&service_id)), &[], Some(&body)).await
		}
		"get_variables" => {
			let VariablesRef { scope, id } = parse(args)?;
			m.call(Method::GET, &variables_path(&scope, &id)?, &[], None).await
		}
		"set_variables" => merge_variables(m, parse(args)?).await,
		"add_service_from_template" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				project_id: String,
				#[serde(default)]
				environment_id: String,
				slug: String,
				#[serde(default)]
				hostname: String,
			}
			let Input { project_id, environment_id, slug, hostname } = parse(args)?;
			let mut body = json!({"slug": slug});
			if !hostname.is_empty() {
				body["hostname"] = json!(hostname);
			}
			let path = format!("/api/projects/{}/services/template", path_escape(&project_id));
			m.call(Method::POST, &path, &environment(environment_id), Some(&body)).await
		}
		"update_service" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				service_id: String,
				fields: Map<String, Value>,
			}
			let Input { service_id, fields } = parse(args)?;
			m.call(Method::PATCH, &format!("/api/services/{}", path_escape(&service_id)), &[], Some(&Value::Object(fields))).await
		}
		"add_domain" => {
			#[derive(Deserialize, Serialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				project_id: String,
				#[serde(default)]
				environment_id: String,
				service: String,
				hostname: String,
				container_port: i64,
				#[serde(default)]
				https_enabled: bool,
				#[serde(default)]
				redirect_https: bool,
			}
			let input: Input = parse(args)?;
			m.call(Method::POST, "/api/domains", &[], Some(&serde_json::to_value(input)?)).await
		}
		"remove_domain" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				domain_id: String,
			}
			let Input { domain_id } = parse(args)?;
			m.call(Method::DELETE, &format!("/api/domains/{}", path_escape(&domain_id)), &[], None).await
		}
		"run_task" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				task_id: String,
			}
			let Input { task_id } = parse(args)?;
			m.call(Method::POST, &format!("/api/tasks/{}/run", path_escape(&task_id)), &[], None).await
		}
		"query_database" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				service_id: String,
				query: String,
				#[serde(default)]
				schema: String,
			}
			let Input { service_id, query, schema } = parse(args)?;
			let body = json!({"query": query, "schema": schema});
			m.call(Method::POST, &format!("/api/services/{}/studio/query", path_escape(&service_id)), &[], Some(&body)).await
		}
		"docker_cleanup" => {
			#[derive(Deserialize)]
			#[serde(deny_unknown_fields)]
			struct Input {
				kind: String,
			}
			let Input { kind } = parse(args)?;
			if !matches!(kind.as_str(), "containers" | "images" | "networks" | "build-cache") {
				bail!("kind must be containers, images, networks or build-cache");
			}
			m.call(Method::POST, &format!("/api/docker/cleanup/{kind}"), &[], None).await
		}
		_ => bail!("unknown tool {name:?}"),
	}
}

/// Decodes a tool's arguments; a missing one is null, which an argument-free
/// tool accepts.
fn parse<T: DeserializeOwned>(args: Value) -> anyhow::Result<T> {
	let args = if args.is_null() { json!({}) } else { args };
	serde_json::from_value(args).context("invalid arguments")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectRef {
	project_id: String,
	#[serde(default)]
	environment_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceRef {
	service_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeploymentRef {
	deployment_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VariablesRef {
	scope: String,
	id: String,
}

#[derive(Deserialize)]
struct Queued {
	id: String,
}

fn environment(id: String) -> Vec<(&'static str, String)> {
	if id.is_empty() { Vec::new() } else { vec![("environment", id)] }
}

async fn get_project(m: &Manager, input: ProjectRef) -> anyhow::Result<Value> {
	let base = format!("/api/projects/{}", path_escape(&input.project_id));
	let env = environment(input.environment_id);
	let mut out = Map::new();
	for (key, path) in [("project", ""), ("environments", "/environments"), ("services", "/services"), ("domains", "/domains")] {
		out.insert(key.to_string(), m.call(Method::GET, &format!("{base}{path}"), &env, None).await?);
	}
	let mut deployments: Vec<Value> = m.decode(Method::GET, &format!("{base}/deployments"), &env, None).await?;
	deployments.truncate(10);
	out.insert("recent_deployments".to_string(), Value::Array(deployments));
	Ok(Value::Object(out))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LogsInput {
	service_id: String,
	#[serde(default)]
	tail: i64,
}

async fn service_logs(m: &Manager, LogsInput { service_id, tail }: LogsInput) -> anyhow::Result<Value> {
	let tail = if tail <= 0 { 200 } else { tail };
	let query: Query = &[("tail", tail.to_string()), ("follow", "false".to_string())];
	let lines = m.events(&format!("/api/services/{}/logs", path_escape(&service_id)), query, "log", 0).await?;
	#[derive(Deserialize)]
	struct Line {
		#[serde(default)]
		stream: String,
		#[serde(default)]
		text: String,
	}
	let mut out = String::new();
	for raw in lines {
		let line: Line = serde_json::from_value(raw)?;
		if line.stream == "stderr" {
			out.push_str("[stderr] ");
		}
		out.push_str(&line.text);
		out.push('\n');
	}
	Ok(Value::String(out))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeployInput {
	#[serde(default)]
	project_id: String,
	#[serde(default)]
	service_id: String,
	#[serde(default)]
	environment_id: String,
}

async fn deploy(m: &Manager, progress: &Progress, input: DeployInput) -> anyhow::Result<Value> {
	let ids = match (input.project_id.is_empty(), input.service_id.is_empty()) {
		(false, true) => {
			let path = format!("/api/projects/{}/deploy", path_escape(&input.project_id));
			let queued: Vec<Queued> = m.decode(Method::POST, &path, &environment(input.environment_id), None).await?;
			queued.into_iter().map(|d| d.id).collect()
		}
		(true, false) => {
			let queued: Queued =
				m.decode(Method::POST, &format!("/api/services/{}/deploy", path_escape(&input.service_id)), &[], None).await?;
			vec![queued.id]
		}
		_ => bail!("give exactly one of project_id and service_id"),
	};
	wait_for_deployments(m, progress, ids).await
}

fn variables_path(scope: &str, id: &str) -> anyhow::Result<String> {
	let collection = match scope {
		"project" => "projects",
		"environment" => "environments",
		"service" => "services",
		_ => bail!("scope must be project, environment or service"),
	};
	Ok(format!("/api/{collection}/{}/variables", path_escape(id)))
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EnvVar {
	pub key: String,
	pub value: String,
	#[serde(default)]
	pub is_secret: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetVariables {
	scope: String,
	id: String,
	#[serde(default)]
	set: BTreeMap<String, String>,
	#[serde(default, deserialize_with = "null_as_empty")]
	secret_keys: Vec<String>,
	#[serde(default, deserialize_with = "null_as_empty")]
	remove: Vec<String>,
}

fn null_as_empty<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
	Ok(Option::<Vec<String>>::deserialize(d)?.unwrap_or_default())
}

/// Turns a partial edit into the whole set the manager's PUT replaces, so keys
/// the agent did not mention survive.
async fn merge_variables(m: &Manager, input: SetVariables) -> anyhow::Result<Value> {
	let path = variables_path(&input.scope, &input.id)?;
	let current: Vec<EnvVar> = m.decode(Method::GET, &path, &[], None).await?;
	let removed: HashSet<&String> = input.remove.iter().collect();
	let secret: HashSet<&String> = input.secret_keys.iter().collect();
	let mut set = input.set.clone();
	let mut next = Vec::new();
	for mut v in current {
		if removed.contains(&v.key) {
			continue;
		}
		if let Some(value) = set.remove(&v.key) {
			v.value = value;
			v.is_secret = v.is_secret || secret.contains(&v.key);
		}
		next.push(v);
	}
	for (key, value) in set {
		let is_secret = secret.contains(&key);
		next.push(EnvVar { key, value, is_secret });
	}
	let saved: Vec<EnvVar> = m.decode(Method::PUT, &path, &[], Some(&json!({"variables": next}))).await?;
	Ok(json!({"keys": saved.into_iter().map(|v| v.key).collect::<Vec<_>>()}))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Step {
	#[serde(default)]
	name: String,
	#[serde(default)]
	status: String,
	#[serde(default)]
	output: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct DeploymentState {
	deployment: DeploymentSummary,
	#[serde(default)]
	steps: Vec<Step>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct DeploymentSummary {
	id: String,
	service_name: String,
	status: String,
	error: String,
}

async fn deployment_report(m: &Manager, id: &str) -> anyhow::Result<DeploymentState> {
	let mut state: DeploymentState = m.decode(Method::GET, &format!("/api/deployments/{}", path_escape(id)), &[], None).await?;
	for step in &mut state.steps {
		step.output = last_lines(&step.output, LOG_TAIL_LINES);
	}
	Ok(state)
}

fn finished(status: &str) -> bool {
	status != "queued" && status != "running"
}

/// Polls until every deployment has finished or the wait runs out, reporting
/// progress so the client does not time the call out.
async fn wait_for_deployments(m: &Manager, progress: &Progress, ids: Vec<String>) -> anyhow::Result<Value> {
	let mut reports: Vec<Option<DeploymentState>> = vec![None; ids.len()];
	let poll = async {
		for tick in 0.. {
			let mut lines = Vec::new();
			for (id, report) in ids.iter().zip(reports.iter_mut()) {
				if report.as_ref().is_some_and(|r| finished(&r.deployment.status)) {
					continue;
				}
				let fresh = deployment_report(m, id).await?;
				lines.push(format!("{}: {}", fresh.deployment.service_name, fresh.deployment.status));
				*report = Some(fresh);
			}
			if reports.iter().all(|r| r.as_ref().is_some_and(|r| finished(&r.deployment.status))) {
				return anyhow::Ok(());
			}
			progress.notify(tick, lines.join(", "));
			tokio::time::sleep(DEPLOY_POLL).await;
		}
		unreachable!("the tick counter does not run out")
	};
	if tokio::time::timeout(DEPLOY_TIMEOUT, poll).await.is_err() {
		return Ok(json!({"still_running": ids, "note": "the deployments are still going; follow them with get_deployment"}));
	}
	Ok(summarize(reports.into_iter().flatten()))
}

/// Keeps, per deployment, the output of the step that decided it: the failed
/// one, or the last one.
fn summarize(reports: impl Iterator<Item = DeploymentState>) -> Value {
	let mut out = Vec::new();
	for report in reports {
		let decisive = report.steps.iter().find(|s| s.status == "failed").or(report.steps.last()).cloned().unwrap_or_default();
		out.push(json!({
			"id": report.deployment.id, "service": report.deployment.service_name, "status": report.deployment.status,
			"error": report.deployment.error, "step": decisive.name, "log_tail": decisive.output,
		}));
	}
	Value::Array(out)
}

fn last_lines(text: &str, n: usize) -> String {
	let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
	if lines.len() <= n {
		return text.to_string();
	}
	lines[lines.len() - n..].join("\n")
}
