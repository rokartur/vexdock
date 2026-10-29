use std::pin::Pin;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use futures::{Stream, StreamExt};
use tokio::io::AsyncWrite;

use super::Docker;

/// The fallback chain used when attaching a terminal.
pub const SHELL_CANDIDATES: [&str; 2] = ["/bin/bash", "/bin/sh"];

/// Bounds what one exec can buffer. Scheduled tasks run commands nobody vetted,
/// and a job that floods stdout must not grow the manager's heap.
const MAX_EXEC_OUTPUT: usize = 1 << 20;

/// Keeps the last `limit` bytes written to it. The tail says why a command
/// failed, so the head is what gets dropped.
#[derive(Default)]
pub struct TailWriter {
	pub limit: usize,
	buf: Vec<u8>,
	truncated: bool,
}

impl TailWriter {
	pub fn new(limit: usize) -> TailWriter {
		TailWriter { limit, ..Default::default() }
	}

	fn limit(&self) -> usize {
		if self.limit == 0 { MAX_EXEC_OUTPUT } else { self.limit }
	}

	pub fn write(&mut self, p: &[u8]) {
		self.buf.extend_from_slice(p);
		// Trim at twice the cap so a chatty command reallocates rarely, not per write.
		let limit = self.limit();
		if self.buf.len() > 2 * limit {
			self.truncated = true;
			self.buf.drain(..self.buf.len() - limit);
		}
	}

	pub fn string(&self) -> String {
		let limit = self.limit();
		if self.buf.len() > limit {
			return format!("[output truncated]\n{}", String::from_utf8_lossy(&self.buf[self.buf.len() - limit..]));
		}
		if self.truncated {
			return format!("[output truncated]\n{}", String::from_utf8_lossy(&self.buf));
		}
		String::from_utf8_lossy(&self.buf).into_owned()
	}
}

/// An attached interactive exec instance.
pub struct ExecSession {
	pub id: String,
	pub output: Pin<Box<dyn Stream<Item = Result<LogOutput, bollard::errors::Error>> + Send>>,
	pub input: Pin<Box<dyn AsyncWrite + Send>>,
}

impl Docker {
	/// Runs a non-interactive command inside a container and returns its combined
	/// output and exit code. Used for `nginx -t`, `nginx -s reload` and scheduled
	/// tasks. A caller's deadline is a `tokio::time::timeout` around this future;
	/// dropping it closes the hijacked connection.
	pub async fn exec_output(&self, container_id: &str, argv: &[String]) -> Result<(String, i64)> {
		let created = self
			.api
			.create_exec(
				container_id,
				CreateExecOptions { attach_stdout: Some(true), attach_stderr: Some(true), cmd: Some(argv.to_vec()), ..Default::default() },
			)
			.await
			.context("exec create")?;
		let started = self.api.start_exec(&created.id, None::<StartExecOptions>).await.context("exec attach")?;
		let mut out = TailWriter::default();
		if let StartExecResults::Attached { mut output, .. } = started {
			while let Some(chunk) = output.next().await {
				match chunk {
					Ok(chunk) => out.write(&chunk.into_bytes()),
					Err(err) => return Err(anyhow!("exec read: {err}")),
				}
			}
		}
		let inspect = self.api.inspect_exec(&created.id).await.context("exec inspect")?;
		Ok((out.string(), inspect.exit_code.unwrap_or(-1)))
	}

	/// Starts an interactive TTY exec, trying bash then sh; `cmd` overrides the
	/// fallback chain when non-empty. Arguments travel as a list, never a shell string.
	pub async fn exec(&self, container_id: &str, cmd: &[String], cols: u16, rows: u16) -> Result<ExecSession> {
		let candidates: Vec<Vec<String>> =
			if cmd.is_empty() { SHELL_CANDIDATES.iter().map(|shell| vec![shell.to_string()]).collect() } else { vec![cmd.to_vec()] };
		let mut last_err = None;
		for argv in candidates {
			match self.try_exec(container_id, argv, cols, rows).await {
				Ok(session) => return Ok(session),
				Err(err) => last_err = Some(err),
			}
		}
		Err(last_err.unwrap_or_else(shell_unavailable))
	}

	async fn try_exec(&self, container_id: &str, argv: Vec<String>, cols: u16, rows: u16) -> Result<ExecSession> {
		let created = self
			.api
			.create_exec(
				container_id,
				CreateExecOptions {
					attach_stdin: Some(true),
					attach_stdout: Some(true),
					attach_stderr: Some(true),
					tty: Some(true),
					cmd: Some(argv),
					..Default::default()
				},
			)
			.await?;
		let started = self.api.start_exec(&created.id, Some(StartExecOptions { tty: true, ..Default::default() })).await?;
		let StartExecResults::Attached { output, input } = started else {
			return Err(shell_unavailable());
		};
		// A missing binary is only reported after the exec starts, so confirm a
		// process came up before handing the session over.
		self.wait_exec_started(&created.id).await?;
		if cols > 0 && rows > 0 {
			let _ = self.resize_exec(&created.id, cols, rows).await;
		}
		Ok(ExecSession { id: created.id, output, input })
	}

	pub async fn resize_exec(&self, exec_id: &str, cols: u16, rows: u16) -> Result<()> {
		Ok(self.api.resize_exec(exec_id, ResizeExecOptions { width: cols, height: rows }).await?)
	}

	/// The daemon reports a missing binary as Pid 0 followed by ExitCode 127, so
	/// a non-zero Pid is the only positive signal that the process is running.
	async fn wait_exec_started(&self, exec_id: &str) -> Result<()> {
		let deadline = Instant::now() + Duration::from_secs(2);
		loop {
			let inspect = self.api.inspect_exec(exec_id).await?;
			if inspect.pid.unwrap_or(0) != 0 {
				return Ok(());
			}
			if !inspect.running.unwrap_or(false) || Instant::now() > deadline {
				return Err(shell_unavailable());
			}
			tokio::time::sleep(Duration::from_millis(25)).await;
		}
	}
}

fn shell_unavailable() -> anyhow::Error {
	anyhow!("no usable shell found in container (tried bash and sh)")
}
