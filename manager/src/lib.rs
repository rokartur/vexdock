//! Vexdock's manager: the only component with access to the Docker socket.
//! Nginx terminates traffic and proxies /api here.
//!
//! Copyright (C) 2026 Platform contributors.
//! Licensed under the GNU Affero General Public License v3.0 or later; see the
//! LICENSE file at the repository root.

pub mod api;
pub mod auth;
pub mod backup;
pub mod certificates;
pub mod compose;
pub mod config;
pub mod database;
pub mod deployments;
pub mod docker;
pub mod domains;
pub mod engines;
pub mod events;
pub mod git;
pub mod metrics;
pub mod nginx;
pub mod projects;
pub mod schedule;
pub mod security;
pub mod studio;
pub mod templates;
pub mod updater;
