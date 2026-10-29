// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Which Durable Object cells a Worker script may call.
//!
//! A cell scope is computable: its class is a public string and its id an
//! HMAC of public strings (`engine_api::durable_object_id_for_name`). So a
//! scope a Worker holds proves nothing, and the host decides from the
//! caller instead. A script reaches every object of the classes it declares
//! (its bindings' classes, its migrated classes, its workflow class: the
//! namespaces `ctx.exports` and `env` hand out), and of the fleet-shared
//! runtime classes only the exact cells its own KV, Queue and D1 bindings
//! name: holding one KV binding must not reach every namespace in the
//! fleet. A Dynamic Worker declares nothing, so it reaches no cell; its
//! facets are reached through the facet ops, which act on the running
//! object only.
//!
//! The shared runtime cells (KV, Queue and D1) run in an isolate of their
//! own, with no application code beside them (`WorkerConfig::runtime_cells`).
//! Its grant reaches only what their own events need: a Queue cell's event
//! reaches the deployment's other Queue cells, for dead-letter transfers and
//! redrives. A script reaches a runtime cell by RPC alone: their `fetch` is
//! the operator protocol, which only celld itself calls, from the
//! authenticated `/runtime/` route and Queue settlement.
//!
//! The grant is checked where a call leaves JavaScript (`op_do_call_impl`,
//! `op_rpc_call`), again where the host dispatches it, and on the owner node
//! for a call that crossed the peer tunnel, which carries the caller.

use std::collections::HashSet;
use std::sync::Arc;

/// The cells one Worker script may call.
#[derive(Debug, Default)]
pub struct ScopeGrant {
    script: String,
    /// Classes whose every object the script may reach. Never a shared
    /// runtime class, whose cells belong to other scripts too.
    classes: HashSet<String>,
    /// The exact cells of the shared runtime classes the script's own
    /// bindings name.
    scopes: HashSet<String>,
    /// The Queue cells a Queue cell's own event may reach: a dead-letter
    /// transfer moves messages to the queue's dead-letter queue, and a
    /// redrive moves them back to the queue they came from. Those are the
    /// consumed queues and their dead-letter queues of the deployment's
    /// consumer catalog. Only the runtime cells' grant has any, and it
    /// applies only while a Queue cell's event runs.
    queue_relay: HashSet<String>,
    /// The grant of the isolate the shared runtime cells run in, whose calls
    /// may use the cells' internal methods (`Caller::internal`).
    runtime: bool,
}

/// What a script's configuration declares, for [`ScopeGrant::new`].
pub struct GrantSource<'a> {
    pub script: &'a str,
    /// `do_classes`: the bindings' classes, the migrated classes and the
    /// runtime classes whose namespace keys the script's bindings need.
    pub do_classes: &'a [String],
    /// The identities of the script's KV namespaces.
    pub kv_namespaces: Vec<&'a str>,
    /// The queues the script produces to.
    pub queues: Vec<&'a str>,
    /// The identities of the script's D1 databases.
    pub d1_databases: Vec<&'a str>,
}

impl ScopeGrant {
    pub fn new(source: GrantSource) -> Self {
        let classes = source
            .do_classes
            .iter()
            .filter(|class| !crate::deploy::is_shared_reserved_class(class))
            .cloned()
            .collect();
        let scopes = source
            .kv_namespaces
            .iter()
            .map(|id| crate::engine_api::kv_cell_scope(id, 0))
            .chain(
                source
                    .queues
                    .iter()
                    .map(|queue| crate::engine_api::queue_cell_scope(queue)),
            )
            .chain(
                source
                    .d1_databases
                    .iter()
                    .map(|id| crate::engine_api::d1_cell_scope(id)),
            )
            .collect();
        Self {
            script: source.script.to_string(),
            classes,
            scopes,
            ..Self::default()
        }
    }

    /// The grant of the shared runtime cells' isolate: from a Queue cell's
    /// event, every consumed queue of the deployment and its dead-letter
    /// queue, and nothing else.
    pub fn runtime_cells<'a>(
        consumed_queues: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
    ) -> Self {
        Self {
            script: crate::deploy::RUNTIME_SCRIPT.to_string(),
            queue_relay: consumed_queues
                .into_iter()
                .flat_map(|(queue, dead_letter)| std::iter::once(queue).chain(dead_letter))
                .map(crate::engine_api::queue_cell_scope)
                .collect(),
            runtime: true,
            ..Self::default()
        }
    }

    /// A script that declares nothing reaches no cell: a Dynamic Worker, and
    /// a caller the owner node does not know.
    pub fn none(script: &str) -> Self {
        Self {
            script: script.to_string(),
            ..Self::default()
        }
    }

    pub fn script(&self) -> &str {
        &self.script
    }

    /// Whether this script's code, running in the event of `event` (if a
    /// cell event runs at all), may call `target`.
    pub fn admits(&self, event: Option<&str>, target: &str) -> bool {
        let Some(class) = class_of(target) else {
            return false;
        };
        if !crate::deploy::is_shared_reserved_class(class) {
            return self.classes.contains(class);
        }
        self.scopes.contains(target)
            || (class == crate::deploy::QUEUE_CLASS
                && event.and_then(class_of) == Some(crate::deploy::QUEUE_CLASS)
                && self.queue_relay.contains(target))
    }
}

/// The class a scope names: everything before its first `:`, as
/// `deploy::reserved_class_of` reads it. A scope without one names no cell.
fn class_of(scope: &str) -> Option<&str> {
    scope.split_once(':').map(|(class, _)| class)
}

/// Who asked the host for a Durable Object call.
#[derive(Clone, Debug)]
pub enum Caller {
    /// celld itself: ingress, the operator routes, Queue settlement and cron
    /// arming. No Worker code chose the cell.
    Host,
    /// A Worker script's code.
    Script(ScriptCaller),
}

#[derive(Clone, Debug)]
pub struct ScriptCaller {
    pub grant: Arc<ScopeGrant>,
    /// The cell whose event made the call, if one did. Only a Queue cell's
    /// event widens what the script may reach (see `queue_relay`).
    pub event: Option<String>,
}

impl Caller {
    /// Refuse an RPC to `target` that the caller holds no grant for.
    pub fn admit(&self, target: &str) -> anyhow::Result<()> {
        match self {
            Caller::Host => Ok(()),
            Caller::Script(caller) => {
                anyhow::ensure!(
                    caller.grant.admits(caller.event.as_deref(), target),
                    "{}",
                    refusal(caller.grant.script(), target)
                );
                Ok(())
            }
        }
    }

    /// Refuse a fetch (or WebSocket upgrade) to `target` as [`Caller::admit`]
    /// does, and a script's fetch to a shared runtime cell: that is the
    /// cell's operator protocol, which only celld calls.
    pub fn admit_fetch(&self, target: &str) -> anyhow::Result<()> {
        self.admit(target)?;
        if let Caller::Script(_) = self {
            anyhow::ensure!(
                class_of(target)
                    .is_none_or(|class| !crate::deploy::is_shared_reserved_class(class)),
                "{}",
                operator_refusal(target)
            );
        }
        Ok(())
    }

    /// Whether the call may use a runtime cell's internal methods: celld's
    /// own, or one the runtime cells' isolate makes. A binding's calls never
    /// may, whatever the script's grant.
    pub fn internal(&self) -> bool {
        match self {
            Caller::Host => true,
            Caller::Script(caller) => caller.grant.runtime,
        }
    }
}

/// The error a call to a cell outside the caller's grant fails with.
pub fn refusal(script: &str, target: &str) -> String {
    format!(
        "Durable Object {target} is not reachable from Worker \"{script}\": the Worker holds no \
         binding to its namespace"
    )
}

/// The error a script's fetch to a shared runtime cell fails with.
pub fn operator_refusal(target: &str) -> String {
    format!(
        "Durable Object {target} is a KV, Queue or D1 cell, which answers fetch() only on \
         celld's authenticated /runtime/ route"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> ScopeGrant {
        let do_classes = [
            "Own",
            "Migrated",
            crate::deploy::KV_CLASS,
            crate::deploy::QUEUE_CLASS,
            crate::deploy::D1_CLASS,
            "__Workflow.app",
        ]
        .map(String::from);
        ScopeGrant::new(GrantSource {
            script: "app",
            do_classes: &do_classes,
            kv_namespaces: vec!["kv-own"],
            queues: vec!["jobs"],
            d1_databases: vec!["db-own"],
        })
    }

    fn runtime_grant() -> ScopeGrant {
        ScopeGrant::runtime_cells([("jobs", Some("jobs-dlq")), ("other", None)])
    }

    fn scope(class: &str) -> String {
        format!("{class}:{}", "ab".repeat(32))
    }

    #[test]
    fn a_script_reaches_every_object_of_its_own_classes() {
        let grant = grant();
        for class in ["Own", "Migrated", "__Workflow.app"] {
            assert!(grant.admits(None, &scope(class)), "{class}");
        }
        for class in [
            "Other",
            "__Workflow.other",
            "Own2",
            celld_logic::cron::RESERVED_CLASS,
        ] {
            assert!(!grant.admits(None, &scope(class)), "{class}");
        }
        assert!(!grant.admits(None, "Own"));
    }

    /// A KV, Queue or D1 binding reaches its own cell and no other cell of
    /// the class, although the class itself is in `do_classes`.
    #[test]
    fn a_shared_runtime_class_is_reached_only_at_the_bindings_cells() {
        let grant = grant();
        let own = [
            crate::engine_api::kv_cell_scope("kv-own", 0),
            crate::engine_api::queue_cell_scope("jobs"),
            crate::engine_api::d1_cell_scope("db-own"),
        ];
        for target in &own {
            assert!(grant.admits(None, target), "{target}");
        }
        let foreign = [
            crate::engine_api::kv_cell_scope("kv-other", 0),
            crate::engine_api::kv_cell_scope("kv-own", 1),
            crate::engine_api::queue_cell_scope("jobs-dlq"),
            crate::engine_api::d1_cell_scope("db-other"),
            scope(crate::deploy::KV_CLASS),
        ];
        for target in &foreign {
            assert!(!grant.admits(None, target), "{target}");
        }
    }

    /// Only a Queue cell's event in the runtime cells' isolate reaches the
    /// catalog's other Queue cells, and only those: the relay is what
    /// dead-letter transfers and redrives need. A script's own code never
    /// runs in a Queue cell's event, so its grant has no relay.
    #[test]
    fn a_queue_cells_event_reaches_the_catalogs_queue_cells() {
        let grant = runtime_grant();
        let queue_event = crate::engine_api::queue_cell_scope("jobs");
        let dlq = crate::engine_api::queue_cell_scope("jobs-dlq");
        let consumed = crate::engine_api::queue_cell_scope("other");
        let unknown = crate::engine_api::queue_cell_scope("unknown");
        assert!(grant.admits(Some(&queue_event), &dlq));
        assert!(grant.admits(Some(&queue_event), &consumed));
        assert!(!grant.admits(Some(&queue_event), &unknown));
        assert!(!grant.admits(None, &dlq));
        assert!(!grant.admits(Some(&scope("Own")), &dlq));
        let kv_event = crate::engine_api::kv_cell_scope("kv-own", 0);
        assert!(!grant.admits(Some(&kv_event), &dlq));
        assert!(!grant.admits(
            Some(&queue_event),
            &crate::engine_api::kv_cell_scope("kv-other", 0)
        ));
        // The runtime cells reach no class, and no cell of a binding.
        assert!(!grant.admits(Some(&queue_event), &scope("Own")));
        assert!(!grant.admits(None, &crate::engine_api::kv_cell_scope("kv-own", 0)));
        assert!(!grant.admits(
            Some(&queue_event),
            &crate::engine_api::d1_cell_scope("db-own")
        ));
        // An application's grant has no relay, even from a Queue cell's event.
        assert!(!self::grant().admits(Some(&queue_event), &dlq));
    }

    /// A script reaches a runtime cell by RPC only; its fetch is the cell's
    /// operator protocol, which only the host calls. Other classes take a
    /// fetch as they take an RPC.
    #[test]
    fn a_script_cannot_fetch_a_runtime_cell() {
        let script = Caller::Script(ScriptCaller {
            grant: Arc::new(grant()),
            event: None,
        });
        let runtime = Caller::Script(ScriptCaller {
            grant: Arc::new(runtime_grant()),
            event: Some(crate::engine_api::queue_cell_scope("jobs")),
        });
        for target in [
            crate::engine_api::kv_cell_scope("kv-own", 0),
            crate::engine_api::queue_cell_scope("jobs"),
            crate::engine_api::d1_cell_scope("db-own"),
        ] {
            assert!(script.admit(&target).is_ok(), "{target}");
            assert_eq!(
                script.admit_fetch(&target).unwrap_err().to_string(),
                operator_refusal(&target)
            );
            assert!(Caller::Host.admit_fetch(&target).is_ok(), "{target}");
        }
        let dlq = crate::engine_api::queue_cell_scope("jobs-dlq");
        assert!(runtime.admit(&dlq).is_ok());
        assert!(runtime.admit_fetch(&dlq).is_err());
        assert!(script.admit_fetch(&scope("Own")).is_ok());
        assert!(script.admit_fetch(&scope("Other")).is_err());
    }

    /// Only celld and the runtime cells' isolate make internal calls.
    #[test]
    fn only_the_host_and_the_runtime_cells_call_internal_methods() {
        assert!(Caller::Host.internal());
        let caller = |grant| {
            Caller::Script(ScriptCaller {
                grant: Arc::new(grant),
                event: Some(crate::engine_api::queue_cell_scope("jobs")),
            })
        };
        assert!(caller(runtime_grant()).internal());
        assert!(!caller(grant()).internal());
        assert!(!caller(ScopeGrant::none(crate::deploy::RUNTIME_SCRIPT)).internal());
    }

    #[test]
    fn a_dynamic_worker_reaches_no_cell() {
        let grant = ScopeGrant::none("__loader:1");
        assert!(!grant.admits(None, &scope("Own")));
        assert!(!grant.admits(None, &crate::engine_api::queue_cell_scope("jobs")));
    }

    #[test]
    fn the_host_reaches_any_cell_and_a_script_only_its_grant() {
        let target = scope("Other");
        assert!(Caller::Host.admit(&target).is_ok());
        let caller = Caller::Script(ScriptCaller {
            grant: Arc::new(grant()),
            event: None,
        });
        assert!(caller.admit(&scope("Own")).is_ok());
        let error = caller.admit(&target).unwrap_err().to_string();
        assert_eq!(error, refusal("app", &target));
        assert!(error.contains("Worker \"app\""), "{error}");
    }
}
