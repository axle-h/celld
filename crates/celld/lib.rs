// Copyright 2026 Deno Land Inc. Apache-2.0 license.

#![warn(clippy::disallowed_methods, clippy::disallowed_types)]

//! Effect adapters for the clean-sheet core.
//!
//! The executable owns one serial actor which is the only caller of
//! `celld_logic::on_event`. Adapter futures never borrow core state; they send
//! versioned completion events back through its mailbox.

mod tokio_select;
#[doc(hidden)]
pub use tokio_select::__asyncrt_select_support;

pub mod actor;
#[cfg(all(test, celld_internal_tests))]
mod conformance_core_loop_tests {
    include!(env!("CELLD_CONFORMANCE_CORE_LOOP_TESTS"));
}
#[cfg(all(test, celld_internal_tests))]
mod conformance_facet_failure_tests {
    include!(env!("CELLD_CONFORMANCE_FACET_FAILURE_TESTS"));
}
pub mod assets;
#[cfg(not(celld_internal_tests))]
pub mod asyncrt;
// The internal test flag alone selects the simulated asyncrt, so an external
// test harness built with the flag sees the same simulated world the
// in-crate suites see. `test` must not be part of the gate:
// a dependency never has it, and the harness binary builds unflagged,
// so the shipped and harness builds keep the real asyncrt.
#[cfg(celld_internal_tests)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types)]
pub mod asyncrt {
    include!(env!("CELLD_INTERNAL_ASYNCRT"));
}
#[cfg(all(test, celld_internal_tests))]
mod asyncrt_contract_tests {
    include!(env!("CELLD_INTERNAL_ASYNCRT_TESTS"));
}
pub mod bucket;
pub mod cell_cli;
pub mod cell_dispatch;
mod cell_host;
pub mod cell_runtime;
pub mod clean_reload;
pub mod cli_options;
pub mod cli_output;
pub mod compat_flags;
pub mod container;
pub mod control_plane;
pub mod d1_cli;
pub mod dead_node_gc;
pub mod deploy;
pub mod dev;
pub mod docker;
pub mod drain_token;
pub mod engine_api;
pub mod env_vars;
#[cfg(celld_internal_tests)]
#[allow(clippy::disallowed_methods)]
#[doc(hidden)]
pub mod fault {
    include!(env!("CELLD_INTERNAL_SQLITE_FAULT"));
}
pub(crate) mod facet_streams;
pub mod fleet;
pub mod generation;
pub mod host_channels;
pub mod host_services;
pub mod http_streams;
pub mod js;
pub mod kv_blob;
pub mod kv_cli;
pub(crate) mod local_store;
pub mod ltx_repl;
pub mod ltx_replication;
pub mod machine;
pub mod memory;
pub mod node_log;
pub(crate) mod operator_cell;
#[doc(hidden)]
pub mod otlp;
pub mod ownership_store;
pub mod peer_auth;
pub mod peer_probe;
pub mod pool;
pub mod protocol;
pub mod public_egress;
pub(crate) mod queue_batching;
pub mod queue_cli;
pub mod queue_policy;
pub mod r2_cli;
pub(crate) mod r2_store;
pub mod replication;
pub mod runtime;
pub mod startup;
pub mod storage;
pub mod telemetry;
pub mod user_spans;
pub mod wake;
pub mod wake_entry;
pub mod wake_format;
pub mod ws_client;
pub mod ws_registry;

#[cfg(all(test, celld_internal_tests))]
mod composed_simulation {
    include!(env!("CELLD_INTERNAL_COMPOSED_SIMULATION"));
}

#[cfg(all(test, celld_internal_tests))]
mod simulation_reproduction {
    include!(env!("CELLD_INTERNAL_SIMULATION_REPRODUCTION"));
}

#[cfg(all(test, celld_internal_tests))]
mod token_lifecycle_tests {
    include!(env!("CELLD_INTERNAL_TOKEN_PROBE"));
}

#[cfg(all(test, celld_internal_tests))]
mod conformance_world_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
mod conformance_world_s2_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_S2_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
mod conformance_o3_oracle {
    include!(env!("CELLD_CONFORMANCE_O3_ORACLE_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
mod conformance_world_s5a_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_S5A_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
mod conformance_world_s5c_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_S5C_TESTS"));
}

#[cfg(celld_internal_tests)]
#[allow(clippy::disallowed_methods)]
#[doc(hidden)]
pub mod conformance_sim_store {
    include!(env!("CELLD_CONFORMANCE_SIM_STORE_TESTS"));
}

#[cfg(celld_internal_tests)]
#[allow(clippy::disallowed_methods)]
#[doc(hidden)]
pub mod conformance_sim_cell_host {
    include!(env!("CELLD_CONFORMANCE_SIM_CELL_HOST_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
pub(crate) mod conformance_world_s1_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_S1_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
pub(crate) mod conformance_world_coverage {
    include!(env!("CELLD_CONFORMANCE_WORLD_COVERAGE_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
mod conformance_world_s3_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_S3_TESTS"));
}

#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods)]
mod conformance_world_s5b_tests {
    include!(env!("CELLD_CONFORMANCE_WORLD_S5B_TESTS"));
}

/// Completion token for a resident-isolate reservation made by the decision
/// core. Dropping the queued/running job reports that the cell is idle again;
/// the token contains no selection or lifecycle policy of its own.
pub struct CellActivityGuard {
    finish: Option<Box<dyn FnOnce() + Send>>,
}

impl CellActivityGuard {
    pub fn new(finish: impl FnOnce() + Send + 'static) -> Self {
        Self {
            finish: Some(Box::new(finish)),
        }
    }
}

impl Drop for CellActivityGuard {
    fn drop(&mut self) {
        if let Some(finish) = self.finish.take() {
            finish();
        }
    }
}

/// A stateless entrypoint selected for one fetch request.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkerFetchEntrypoint {
    pub name: String,
    /// The caller's `ctx.props` as V8 structured-clone bytes. An empty vector
    /// represents an omitted or `undefined` props value.
    pub props: Vec<u8>,
}

/// Resource limits selected by a Worker Loader stub for one invocation.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerInvocationLimits {
    pub cpu_ms: Option<u32>,
    pub sub_requests: Option<u32>,
}

/// One operation on a Worker entrypoint. A property read has no arguments,
/// while a call owns its complete receiver path and structured-clone payload.
pub enum WorkerRpcOperation {
    Get { path: Vec<String> },
    Call { path: Vec<String>, args: Vec<u8> },
}

pub enum WorkerJob {
    Fetch {
        queued_at: std::time::Instant,
        /// An entrypoint dispatcher target, or the direct default export when
        /// absent.
        entrypoint: Option<WorkerFetchEntrypoint>,
        invocation_limits: Option<WorkerInvocationLimits>,
        url: String,
        method: String,
        body: js::RequestBody,
        headers: Vec<(String, String)>,
        request_id: Option<js::RequestId>,
        /// Receives one completed invocation report for Dynamic Worker tails.
        /// Ordinary fetches leave this empty.
        tail_report: Option<tokio::sync::oneshot::Sender<String>>,
        reply: tokio::sync::oneshot::Sender<anyhow::Result<js::HttpResponse>>,
    },
    Rpc {
        entrypoint: String,
        operation: WorkerRpcOperation,
        /// The caller's `ctx.props` as V8 structured-clone bytes, the same
        /// encoding as `args`. It is empty when the caller sent none, which no
        /// encoded value can be. A Worker Loader entrypoint or a transferred
        /// Service Binding can set it.
        props: Vec<u8>,
        invocation_limits: Option<WorkerInvocationLimits>,
        reply: tokio::sync::oneshot::Sender<anyhow::Result<Vec<u8>>>,
    },
    Queue {
        queued_at: std::time::Instant,
        batch: js::QueueBatch,
        reply: tokio::sync::oneshot::Sender<anyhow::Result<js::QueueDispatchResult>>,
    },
}

impl WorkerJob {
    /// Fail this event without running it.
    pub(crate) fn fail(self, error: anyhow::Error) {
        match self {
            WorkerJob::Fetch { reply, .. } => drop(reply.send(Err(error))),
            WorkerJob::Rpc { reply, .. } => drop(reply.send(Err(error))),
            WorkerJob::Queue { reply, .. } => drop(reply.send(Err(error))),
        }
    }
}

/// Temporary host seam required by the verbatim JS adapter. The runtime
/// adapter will construct the real shared Worker queue; lifecycle policy does
/// not move into this type.
/// The compatibility switches of a deployed Worker, from its manifest's
/// compatibility date and flags. `celld deploy` refused what celld cannot
/// run, so a name this celld does not know has no effect here.
pub fn worker_compat(metadata: &serde_json::Value) -> js::Compat {
    let flags: Vec<&str> = metadata
        .get("compatibility_flags")
        .and_then(serde_json::Value::as_array)
        .map(|flags| flags.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();
    let date = metadata
        .get("compatibility_date")
        .and_then(serde_json::Value::as_str);
    js::Compat::from_flags(compat_flags::compile_lenient(date, &flags))
}

#[cfg(test)]
mod tests {
    use super::worker_compat;

    fn rpc_params_dup_stubs(date: &str, flags: &[&str]) -> bool {
        worker_compat(&serde_json::json!({
            "compatibility_date": date,
            "compatibility_flags": flags,
        }))
        .rpc_params_dup_stubs
    }

    #[test]
    fn rpc_params_dup_stubs_follows_its_date_and_flags() {
        assert!(!rpc_params_dup_stubs("2026-01-19", &[]));
        assert!(rpc_params_dup_stubs("2026-01-20", &[]));
        assert!(rpc_params_dup_stubs(
            "2026-01-01",
            &["rpc_params_dup_stubs"]
        ));
        assert!(!rpc_params_dup_stubs(
            "2026-09-01",
            &["rpc_params_transfer_stubs"]
        ));
        assert!(!worker_compat(&serde_json::json!({})).rpc_params_dup_stubs);
    }

    /// (`nodejs_compat`, `nodejs_compat_populate_process_env`) as workerd
    /// computes them for a date and flags.
    fn process_env(date: &str, flags: &[&str]) -> (bool, bool) {
        let compat = worker_compat(&serde_json::json!({
            "compatibility_date": date,
            "compatibility_flags": flags,
        }));
        (compat.nodejs_compat, compat.populate_process_env)
    }

    #[test]
    fn process_env_follows_nodejs_compat_its_date_and_flags() {
        assert_eq!(process_env("2025-03-31", &["nodejs_compat"]), (true, false));
        assert_eq!(process_env("2025-04-01", &["nodejs_compat"]), (true, true));
        assert_eq!(
            process_env(
                "2025-03-31",
                &["nodejs_compat", "nodejs_compat_populate_process_env"]
            ),
            (true, true)
        );
        assert_eq!(
            process_env(
                "2025-04-01",
                &["nodejs_compat", "nodejs_compat_do_not_populate_process_env"]
            ),
            (true, false)
        );
        // Without Node.js compatibility the flag can be on, but workerd has
        // no `process` to fill.
        assert_eq!(process_env("2025-04-01", &[]), (false, false));
        assert_eq!(
            process_env("2025-04-01", &["nodejs_compat_populate_process_env"]),
            (false, true)
        );
        // `nodejs_compat_v2` alone gives a `process`, but the date implies
        // the flag only through `nodejs_compat`.
        assert_eq!(
            process_env("2025-04-01", &["nodejs_compat_v2"]),
            (true, false)
        );
        assert_eq!(
            process_env(
                "2025-04-01",
                &["nodejs_compat_v2", "nodejs_compat_populate_process_env"]
            ),
            (true, true)
        );
        // From 2026-08-04 `nodejs_compat` and `nodejs_compat_v2` are on by
        // date. `no_nodejs_compat` turns off the first, and with it the
        // flag, but not the second.
        assert_eq!(process_env("2026-08-03", &[]), (false, false));
        assert_eq!(process_env("2026-08-04", &[]), (true, true));
        assert_eq!(
            process_env("2026-08-04", &["no_nodejs_compat"]),
            (true, false)
        );
        assert_eq!(
            process_env("2026-08-04", &["no_nodejs_compat", "no_nodejs_compat_v2"]),
            (false, false)
        );
        // `nodejs_compat` before 2024-09-23 still offers `node:process`.
        assert_eq!(process_env("2024-09-22", &["nodejs_compat"]), (true, false));
    }
}
