//! Durable Object instances, and the resets that broke them.
//!
//! In workerd a stub binds to the instance its first call reaches, and once
//! that instance is reset (`ctx.abort()`, a failed `blockConcurrencyWhile()`,
//! its isolate condemned) the stub stays broken: every later call throws the
//! reset's error, while a fresh stub reaches a new instance. celld's stubs
//! learn the token of the instance that served them, send it with each call,
//! and the object's isolate asks this registry whether that instance was
//! reset (`__do_instance_stale`).
//!
//! The registry is the node's and outlives the isolate, so a reset is still
//! known after its cell moved to another isolate, by eviction or by
//! condemnation: a condemned isolate runs no JavaScript again, so the host
//! records the reset of the instance it held when the cell leaves it
//! ([`release`]). A token is the counter of this process's instances behind a
//! per-process nonce, so a token from another node names nothing here, and
//! names no authority anywhere: it can only make its own caller's call fail.
//!
//! Bounds: the registry keeps the last [`MAX_RESETS_PER_SCRIPT`] resets of
//! each script, so one script's resets never push out another's, and each
//! error envelope within [`MAX_ENVELOPE`] bytes (`__resetEnvelope` keeps it
//! well under; a larger one is kept as a plain reset): at most 8 MiB a
//! script. A stub bound to a reset that fell out reaches the current
//! instance, as it does after its object moves to another node.

use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// The resets the registry keeps of one script.
const MAX_RESETS_PER_SCRIPT: usize = 1024;
/// The largest error envelope a reset keeps.
const MAX_ENVELOPE: usize = 8192;
/// What a reset whose envelope was over the bound throws.
const RESET_WITHOUT_ERROR: &str = "The Durable Object was reset.";

/// Why an instance went away.
#[derive(Clone, Debug, PartialEq)]
enum Reset {
    /// The reset's error, as the error envelope the object's isolate encoded.
    Thrown(Vec<u8>),
    /// A reset whose envelope was over [`MAX_ENVELOPE`].
    Unencoded,
    /// Its isolate reached the heap limit ([`MEMORY_EXCEEDED`]).
    Condemned,
    /// Its storage failed to commit a turn's writes, with the error the
    /// failure was reported with (`storage::failed_commit_error`).
    CommitFailed(String),
}

/// An object's instance resident on this node, the isolate it is in, and
/// its script.
#[derive(Clone, Debug, PartialEq)]
struct Current {
    token: u64,
    heap: Option<celld_logic::isolate::HeapId>,
    script: String,
}

#[derive(Default)]
struct Registry {
    current: HashMap<String, Current>,
    /// The resets kept, by token, with the object each instance was and its
    /// script.
    resets: HashMap<u64, (String, String, Reset)>,
    /// Each script's tokens in `resets`, oldest first.
    order: HashMap<String, VecDeque<u64>>,
}

impl Registry {
    fn begin(&mut self, scope: &str, current: Current) {
        self.current.insert(scope.to_string(), current);
    }

    fn reset(&mut self, script: &str, scope: &str, token: u64, reset: Reset) {
        if self
            .current
            .get(scope)
            .is_some_and(|current| current.token == token)
        {
            self.current.remove(scope);
        }
        // A second report of one reset keeps the first error.
        if self.resets.contains_key(&token) {
            return;
        }
        let order = self.order.entry(script.to_string()).or_default();
        if order.len() == MAX_RESETS_PER_SCRIPT {
            if let Some(oldest) = order.pop_front() {
                self.resets.remove(&oldest);
            }
        }
        order.push_back(token);
        self.resets
            .insert(token, (scope.to_string(), script.to_string(), reset));
    }

    /// The cell left the isolate `heap`. A condemned isolate broke the
    /// instance it held; any other give-back only ends it. An instance of
    /// another isolate is not this give-back's to end.
    fn release(
        &mut self,
        script: &str,
        scope: &str,
        heap: Option<celld_logic::isolate::HeapId>,
        condemned: bool,
    ) {
        let Some(current) = self.current.get(scope).filter(|c| c.heap == heap).cloned() else {
            return;
        };
        self.current.remove(scope);
        if condemned {
            self.reset(script, scope, current.token, Reset::Condemned);
        }
    }

    /// The current instance of `scope` broke without running JavaScript
    /// (its storage failed a commit).
    fn break_current(&mut self, scope: &str, error: &str) {
        if let Some(current) = self.current.get(scope).cloned() {
            let reset = Reset::CommitFailed(error.to_string());
            self.reset(&current.script, scope, current.token, reset);
        }
    }

    fn retain_scripts(&mut self, keep: impl Fn(&str) -> bool) {
        self.order.retain(|script, _| keep(script));
        self.resets.retain(|_, (_, script, _)| keep(script));
        self.current.retain(|_, current| keep(&current.script));
    }

    fn stale(&self, scope: &str, token: u64) -> Option<&Reset> {
        self.resets
            .get(&token)
            .filter(|(object, _, _)| object == scope)
            .map(|(_, _, reset)| reset)
    }
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// This process's token prefix.
fn nonce() -> u64 {
    static NONCE: OnceLock<u64> = OnceLock::new();
    *NONCE.get_or_init(|| {
        let mut bytes = [0_u8; 8];
        getrandom::fill(&mut bytes).expect("the OS random source is available");
        u64::from_le_bytes(bytes)
    })
}

/// The bytes of a token: the nonce, then the counter, little-endian.
const TOKEN_LEN: usize = 16;

fn token_bytes(counter: u64) -> [u8; TOKEN_LEN] {
    let mut token = [0_u8; TOKEN_LEN];
    token[..8].copy_from_slice(&nonce().to_le_bytes());
    token[8..].copy_from_slice(&counter.to_le_bytes());
    token
}

/// The counter a token names, when this process minted it.
fn token_counter(token: &[u8]) -> Option<u64> {
    let token: [u8; TOKEN_LEN] = token.try_into().ok()?;
    let [prefix, counter] =
        [0, 8].map(|at| u64::from_le_bytes(token[at..at + 8].try_into().expect("an 8-byte half")));
    (prefix == nonce()).then_some(counter)
}

/// The counter of the token a JavaScript argument carries.
fn token_arg(value: v8::Local<v8::Value>) -> Option<u64> {
    token_counter(&view_bytes(value)?)
}

/// The cell `scope`'s storage failed (a commit, or a critical SQL error),
/// which resets the object, as workerd's broken output gate does: its stubs
/// throw `error` from now on, and the isolate it runs in queues it for the
/// actor to move (`Slot::mark_broken`, `Event::CellBroken`), so the next event
/// builds a new instance on storage that never held the turn's writes. A
/// facet has no cell of its own to move; it fails closed until its root
/// moves (plan 1.59).
pub(crate) fn cell_broken(scope: &str, error: &str) {
    registry().lock().unwrap().break_current(scope, error);
    if crate::engine_api::is_facet_cell(scope) {
        return;
    }
    if let Some(slot) = crate::pool::current_slot() {
        slot.mark_broken(scope);
    }
}

/// Forget the resets of scripts no longer deployed on this node: their
/// stubs reach nothing to protect.
pub(crate) fn retain_scripts<V>(scripts: &HashMap<String, V>) {
    registry()
        .lock()
        .unwrap()
        .retain_scripts(|script| scripts.contains_key(script));
}

/// The isolate this thread's turn runs in.
fn current_heap() -> Option<celld_logic::isolate::HeapId> {
    crate::pool::current_slot().map(|slot| slot.heap_id())
}

/// The cell `scope` of `script` leaves the isolate this turn runs in
/// (`finish_cell_adoption`).
pub(super) fn release(script: &str, scope: &str, condemned: bool) {
    registry()
        .lock()
        .unwrap()
        .release(script, scope, current_heap(), condemned);
}

/// `__do_instance_begin(scope)` — a new instance of the object `scope`:
/// answers its token (16 bytes), which the registry now holds as the
/// scope's current instance.
pub(super) fn op_do_instance_begin(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let cell = args.get(0).to_rust_string_lossy(scope);
    let token = COUNTER.fetch_add(1, Ordering::Relaxed);
    let current = Current {
        token,
        heap: current_heap(),
        script: actor_runtime_state(scope).script_name.clone(),
    };
    registry().lock().unwrap().begin(&cell, current);
    rv.set(bytes_value(scope, token_bytes(token).to_vec()));
}

/// `__do_instance_reset(scope, token, envelope)` — the instance `token` of
/// `scope` was reset with the error `envelope` encodes. An envelope over the
/// bound is kept as a plain reset rather than refused: the reset must be
/// recorded whatever the error was.
pub(super) fn op_do_instance_reset(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let cell = args.get(0).to_rust_string_lossy(scope);
    let Some(token) = token_arg(args.get(1)) else {
        return;
    };
    let reset = match view_bytes(args.get(2)) {
        Some(envelope) if envelope.len() <= MAX_ENVELOPE => Reset::Thrown(envelope),
        _ => Reset::Unencoded,
    };
    let script = actor_runtime_state(scope).script_name.clone();
    registry()
        .lock()
        .unwrap()
        .reset(&script, &cell, token, reset);
}

/// `__do_instance_stale(scope, token)` — how the instance `token` of `scope`
/// was reset: its error envelope, a message for a reset with none, or
/// `undefined` for an instance that was not.
pub(super) fn op_do_instance_stale(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let cell = args.get(0).to_rust_string_lossy(scope);
    let Some(token) = token_arg(args.get(1)) else {
        return;
    };
    let reset = registry().lock().unwrap().stale(&cell, token).cloned();
    match reset {
        Some(Reset::Thrown(envelope)) => rv.set(bytes_value(scope, envelope)),
        Some(Reset::Unencoded) => {
            rv.set(v8::String::new(scope, RESET_WITHOUT_ERROR).unwrap().into())
        }
        Some(Reset::Condemned) => rv.set(v8::String::new(scope, MEMORY_EXCEEDED).unwrap().into()),
        Some(Reset::CommitFailed(error)) => rv.set(v8::String::new(scope, &error).unwrap().into()),
        None => {}
    }
}

/// Register a new instance of `scope`, as `__do_instance_begin` does.
#[cfg(test)]
pub(crate) fn begin_for_test(scope: &str) -> u64 {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 62);
    let token = COUNTER.fetch_add(1, Ordering::Relaxed);
    let current = Current {
        token,
        heap: None,
        script: "test".into(),
    };
    registry().lock().unwrap().begin(scope, current);
    token
}

/// Whether the instance `token` of `scope` was reset.
#[cfg(test)]
pub(crate) fn stale_for_test(scope: &str, token: u64) -> bool {
    registry().lock().unwrap().stale(scope, token).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thrown(byte: u8) -> Reset {
        Reset::Thrown(vec![0, byte])
    }

    fn current(token: u64) -> Current {
        Current {
            token,
            heap: None,
            script: "app".into(),
        }
    }

    #[test]
    fn a_reset_instance_stays_stale_and_its_successor_does_not() {
        let mut registry = Registry::default();
        registry.begin("A:1", current(1));
        registry.reset("app", "A:1", 1, thrown(7));
        registry.begin("A:1", current(2));
        assert_eq!(registry.stale("A:1", 1), Some(&thrown(7)));
        assert_eq!(registry.stale("A:1", 2), None);
        // A token names its own object's instance only.
        assert_eq!(registry.stale("A:2", 1), None);
        // A second report of the same reset keeps the first error.
        registry.reset("app", "A:1", 1, thrown(8));
        assert_eq!(registry.stale("A:1", 1), Some(&thrown(7)));
        assert_eq!(registry.current["A:1"], current(2));
    }

    #[test]
    fn a_give_back_ends_its_own_instance_and_a_condemned_one_resets_it() {
        let heap = |id| Some(celld_logic::isolate::HeapId::new(id));
        let mut registry = Registry::default();
        registry.begin("A:1", current(1));
        registry.release("app", "A:1", None, false);
        assert!(registry.current.is_empty() && registry.resets.is_empty());
        registry.begin(
            "A:1",
            Current {
                heap: heap(1),
                ..current(2)
            },
        );
        // Another isolate's give-back leaves this instance alone.
        registry.release("app", "A:1", heap(2), true);
        assert_eq!(registry.stale("A:1", 2), None);
        registry.release("app", "A:1", heap(1), true);
        assert_eq!(registry.stale("A:1", 2), Some(&Reset::Condemned));
        // A give-back with no instance resident changes nothing.
        registry.release("app", "A:1", heap(1), true);
        registry.release("app", "B:1", None, true);
        assert_eq!(registry.resets.len(), 1);
    }

    #[test]
    fn a_broken_instance_is_stale_with_its_commit_error() {
        let mut registry = Registry::default();
        registry.begin("A:1", current(1));
        registry.break_current("A:1", "internal error");
        assert_eq!(
            registry.stale("A:1", 1),
            Some(&Reset::CommitFailed("internal error".into()))
        );
        assert!(registry.current.is_empty());
        // An object with no instance resident has nothing to break.
        registry.break_current("A:2", "internal error");
        assert_eq!(registry.resets.len(), 1);
    }

    #[test]
    fn a_script_that_leaves_the_node_leaves_no_resets() {
        let mut registry = Registry::default();
        registry.reset("gone", "A:1", 1, thrown(0));
        registry.reset("app", "B:1", 2, thrown(0));
        registry.begin(
            "C:1",
            Current {
                script: "gone".into(),
                ..current(3)
            },
        );
        registry.retain_scripts(|script| script == "app");
        assert_eq!(registry.stale("A:1", 1), None);
        assert!(registry.stale("B:1", 2).is_some());
        assert!(registry.current.is_empty());
        assert!(!registry.order.contains_key("gone"));
    }

    #[test]
    fn each_script_keeps_its_own_resets() {
        let mut registry = Registry::default();
        registry.reset("other", "B:1", u64::MAX, thrown(1));
        registry.begin("A:0", current(1));
        for token in 0..(MAX_RESETS_PER_SCRIPT as u64 + 3) {
            registry.reset("app", &format!("A:{token}"), token, thrown(0));
        }
        assert_eq!(registry.order["app"].len(), MAX_RESETS_PER_SCRIPT);
        assert_eq!(registry.resets.len(), MAX_RESETS_PER_SCRIPT + 1);
        assert_eq!(
            registry.stale("A:2", 2),
            None,
            "the script's oldest fell out"
        );
        assert!(registry.stale("A:3", 3).is_some());
        // Another script's reset stays, and so does a resident instance.
        assert!(registry.stale("B:1", u64::MAX).is_some());
        assert_eq!(registry.current["A:0"], current(1));
    }

    #[test]
    fn only_this_process_tokens_name_an_instance() {
        assert_eq!(token_counter(&token_bytes(42)), Some(42));
        let mut other = token_bytes(42);
        other[0] ^= 1;
        assert_eq!(token_counter(&other), None);
        assert_eq!(token_counter(&[]), None);
        assert_eq!(token_counter(&token_bytes(42)[..15]), None);
    }
}
