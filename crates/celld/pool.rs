// Copyright 2026 Deno Land Inc. Apache-2.0 license.

// Isolate admission and deadlines are in the V8 arm outside the Actor execution
// domain.
#![allow(clippy::disallowed_methods)]

//! The isolate pool: the shell around `celld_logic::isolate`.
//!
//! One multi-threaded tokio runtime owns every socket and timer, and runs no
//! JavaScript: a turn runs on an isolate thread (`crate::isolate_threads`).
//! Isolates belong to no thread — `v8::Locker` installs the entering thread's
//! per-isolate state, so any isolate thread can take an isolate and run a
//! turn in it.
//! This module owns the isolates and the counters; every choice about which
//! isolate, when to grow, what to shed and what to retire is made by
//! `celld_logic::isolate` and merely performed here.
//!
//! **The turn queue exists so nothing blocks.** `SharedIsolate::lock()`
//! blocks until its holder releases. A turn waits in its slot's queue
//! without a thread, and one thread at a time runs a slot's queued turns, so
//! that blocking lock is uncontended by construction. A `lock()` reached
//! outside a turn would park a thread on V8, which is the one thing this
//! runtime refuses to do.
//!
//! **Stuck isolates.** An isolate condemned for its CPU limit while its turn
//! still runs (a builtin that does not stop for a termination) is *stuck*: it
//! holds an isolate thread and its heap until the call returns. They are
//! counted per script and node-wide ([`stuck_census`]). A script with
//! [`crate::turn_owner::STUCK_PER_OWNER`] of them has its further requests and
//! placements refused with the CPU limit's error, and at the node-wide cap
//! ([`stuck_node_cap`]) a script that has one grows no isolate, until one
//! returns (`crate::turn_owner`).

use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::RwLock;

use anyhow::Result;
use celld_logic::isolate::HeapId;
use celld_logic::isolate::IsolateId;
use celld_logic::isolate::IsolateLoad;
use celld_logic::isolate::Placement;
use celld_logic::isolate::PoolLimits;
use celld_logic::isolate::PoolLoad;
use celld_logic::isolate::Refusal;

use crate::js;

pub use crate::engine_api::AdmitError;
pub use crate::engine_api::PoolCensus;

/// Heap identity is process-wide because pressure policy compares cells from
/// every script pool and every draining generation. A counter inside `Pool`
/// would reproduce the collision this identity prevents. The core treats the
/// value as opaque, so its allocation order is not a deterministic decision.
static NEXT_HEAP_ID: AtomicU64 = AtomicU64::new(1);

fn next_heap_id() -> HeapId {
    // Rust 1.99 deprecates `fetch_update` as a rename of `try_update`,
    // which is stable only from 1.95; this crate's MSRV is 1.94.1.
    #[allow(deprecated)]
    let value = NEXT_HEAP_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .expect("V8 heap identity space exhausted");
    HeapId::new(value)
}

/// Bound the producer replies that can wait for one Queue's shared commit and
/// durability proof. Four 64-call groups can overlap, and a stopped bucket
/// still cannot retain an unbounded number of promises or copied bodies.
pub(crate) const MAX_QUEUE_PRODUCER_EVENTS_PER_CELL: usize = 256;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum TurnLane {
    Stateless,
    Cell(String),
}

/// One turn waiting for its isolate: it gets the isolate's worker, or `None`
/// once the isolate was freed.
type TurnJob = Box<dyn FnOnce(&mut Option<js::Worker>) + Send>;

/// The turns waiting for one isolate, and whether a thread runs them now.
///
/// Turns of one isolate run one at a time, in lanes: the stateless lane and
/// one per cell. A lane that has just run goes to the back when it has more
/// waiting, so a hot cell can keep its next place but cannot take it from a
/// cell that already waits on the same isolate.
///
/// Whichever thread runs the isolate's turns runs those that wait behind it
/// too, back to back ([`Slot::run_turns`]), for up to [`TURN_BATCH`]: a busy
/// Durable Object's turns follow each other on one thread, without a round
/// trip through Tokio between them.
#[derive(Default)]
struct TurnQueue {
    /// A thread runs this isolate's turns.
    running: bool,
    current: Option<TurnLane>,
    ready: std::collections::VecDeque<TurnLane>,
    /// Each lane's turns, each marked when it starts an event: only those
    /// wait for their owner's long turns (`Owner::must_wait`); a turn that
    /// continues, cancels or settles an event, or releases a cell, never does.
    waiting: std::collections::HashMap<TurnLane, std::collections::VecDeque<(bool, TurnJob)>>,
    /// A test holds the isolate (`Slot::hold_turn_for_test`): no turn runs.
    #[cfg(celld_internal_tests)]
    held: bool,
}

/// How a run of one isolate's turns goes ([`Slot::run_turns`]).
#[derive(Clone, Copy, PartialEq, Eq)]
enum RunMode {
    /// In a driver's poll: its own turn, then the rest go to a thread.
    Inline,
    /// A run of its own on an isolate thread, for up to [`TURN_BATCH`].
    Batch,
    /// No isolate threads: all of them, here.
    Drain,
}

/// How long one thread runs an isolate's waiting turns before it lets other
/// isolates have the thread.
const TURN_BATCH: std::time::Duration = std::time::Duration::from_millis(1);

impl TurnQueue {
    /// Queue `job`; true when no thread runs the isolate's turns, so the
    /// caller must start one.
    #[cfg(test)]
    fn push(&mut self, lane: TurnLane, job: TurnJob) -> bool {
        self.push_turn(lane, false, job)
    }

    /// [`push`](Self::push), for a turn that starts an event when `event`.
    fn push_turn(&mut self, lane: TurnLane, event: bool, job: TurnJob) -> bool {
        if !self.waiting.contains_key(&lane) && self.current.as_ref() != Some(&lane) {
            self.ready.push_back(lane.clone());
        }
        self.waiting
            .entry(lane)
            .or_default()
            .push_back((event, job));
        !std::mem::replace(&mut self.running, true)
    }

    /// Whether the turn [`next`](Self::next) would take starts an event.
    fn next_starts_event(&self) -> bool {
        let lane = self.ready.front().or_else(|| {
            self.current
                .as_ref()
                .filter(|lane| self.waiting.contains_key(*lane))
        });
        lane.and_then(|lane| self.waiting.get(lane))
            .and_then(|waiting| waiting.front())
            .is_some_and(|(event, _)| *event)
    }

    /// The next turn, round robin over the lanes; `None` ends the run.
    fn next(&mut self) -> Option<TurnJob> {
        #[cfg(celld_internal_tests)]
        if self.held {
            self.running = false;
            return None;
        }
        if let Some(current) = self.current.take() {
            if self
                .waiting
                .get(&current)
                .is_some_and(|waiting| !waiting.is_empty())
            {
                self.ready.push_back(current);
            }
        }
        while let Some(lane) = self.ready.pop_front() {
            let Some(waiting) = self.waiting.get_mut(&lane) else {
                continue;
            };
            let job = waiting.pop_front();
            if waiting.is_empty() {
                self.waiting.remove(&lane);
            }
            if let Some((_, job)) = job {
                self.current = Some(lane);
                return Some(job);
            }
        }
        self.running = false;
        None
    }

    /// [`next`](Self::next), but passing over turns that start an event,
    /// while their owner must wait for its long turns: the first turn that
    /// does not, in lane order, so a settlement queued behind a deferred
    /// event start runs at once. `None` when only event starts wait, which
    /// leaves the queue as it was, its run still marked.
    fn next_skipping_events(&mut self) -> Option<TurnJob> {
        #[cfg(celld_internal_tests)]
        if self.held {
            return None;
        }
        let mut order: Vec<TurnLane> = self.ready.iter().cloned().collect();
        if let Some(current) = &self.current {
            if self.waiting.contains_key(current) && !order.contains(current) {
                order.push(current.clone());
            }
        }
        for lane in order {
            let Some(waiting) = self.waiting.get_mut(&lane) else {
                continue;
            };
            let Some(index) = waiting.iter().position(|(event, _)| !*event) else {
                continue;
            };
            let (_, job) = waiting.remove(index).expect("found above");
            if waiting.is_empty() {
                self.waiting.remove(&lane);
            }
            // The lane that just ran goes behind the others, as in `next`.
            if let Some(current) = self.current.take() {
                if current != lane
                    && self.waiting.contains_key(&current)
                    && !self.ready.contains(&current)
                {
                    self.ready.push_back(current);
                }
            }
            self.ready.retain(|ready| *ready != lane);
            self.current = Some(lane);
            return Some(job);
        }
        None
    }

    /// End a run with turns still waiting, which another run takes.
    fn has_waiting(&self) -> bool {
        !self.ready.is_empty()
            || self
                .current
                .as_ref()
                .is_some_and(|lane| self.waiting.contains_key(lane))
    }
}

pub(crate) struct QueueProducerPermit {
    slot: Arc<Slot>,
    scope: String,
}

impl Drop for QueueProducerPermit {
    fn drop(&mut self) {
        self.slot.release_queue_producer(&self.scope);
    }
}

/// One isolate, and everything the decision core needs to know about it.
pub struct Slot {
    /// The index used only inside this pool's placement snapshot and slot
    /// vector. Distinct pools can use the same value.
    pub id: IsolateId,
    /// This slot, for an op of one of its turns to reach it: a facet of the
    /// script's own class runs in the isolate of the object that holds it.
    me: std::sync::Weak<Slot>,
    /// The identity reported to node-wide Actor and pressure policy.
    heap_id: HeapId,
    /// The isolate, which the thread running its turns holds
    /// ([`Slot::run_turns`]). Taking this is what makes the V8 `Locker`
    /// beneath it uncontended: only that thread waits for it, and only
    /// behind a census or a free, which `try_lock` it.
    ///
    /// `None` once the isolate has been retired and freed. Retirement only
    /// frees a slot that is drained — no turns, no affiliations — and a
    /// retiring slot is filtered out of every placement decision, so nothing
    /// can arrive afterwards. Entering one would be a bug in this module.
    worker: Mutex<Option<js::Worker>>,
    /// Whether a turn runs in this isolate now, and whether it is stuck.
    presence: Arc<Presence>,
    turn_queue: Mutex<TurnQueue>,
    /// The isolate thread that last ran its turns, plus one; 0 for none.
    last_thread: AtomicU64,
    queue_producers: Mutex<std::collections::HashMap<String, usize>>,
    turns: AtomicUsize,
    requests: AtomicUsize,
    /// Those of `requests` that only their open WebSockets keep, which
    /// admission does not count ([`Affiliation::hold_for_sockets`]).
    sockets: AtomicUsize,
    /// The node's count of them, and its bound ([`node_socket_requests`]).
    socket_requests: Arc<SocketRequests>,
    /// Whether the pool belongs to a superseded generation, shared with it.
    /// A Worker Loader's slot shares its loader's.
    generation: Arc<GenerationRetirement>,
    /// The pool's admission bell, cloned into every slot so an
    /// `Affiliation` drop can ring it without holding the pool.
    freed: Arc<tokio::sync::Notify>,
    /// The pool's reclaim bell, rung when a retiring isolate may have
    /// drained. `None` for a standalone slot: nothing frees or replaces it,
    /// so [`Slot::condemn`] cannot apply to it.
    reclaim: Option<Arc<tokio::sync::Notify>>,
    /// The slot holds a Worker Loader's Worker, so the facets it runs belong
    /// to the root that started them rather than to this isolate.
    loaded_worker: bool,
    /// Cells whose realm lives in this isolate. Not a count of live work: a
    /// cell stays until it is evicted or handed to another node, which is
    /// why `retire` refuses an isolate holding any.
    cells: AtomicUsize,
    // Reservations can adopt out of order; only completed adoptions count
    // toward the collection boundary. Residency drop retires both counts.
    adopted_cells: AtomicUsize,
    retiring: AtomicBool,
    /// The guest can no longer run here (see [`Slot::condemn`]). Unlike
    /// `retiring`, which an idle isolate also reaches, this says the cells
    /// it holds must move.
    /// Why the slot was condemned, the first reason only: [`NOT_CONDEMNED`],
    /// [`CONDEMNED`], or [`CONDEMNED_FOR_CPU`] for a turn that ran on past
    /// its CPU limit ([`condemn`](Self::condemn) with `js::CPU_EXCEEDED`).
    condemned: std::sync::atomic::AtomicU8,
    /// Run once when the slot is condemned, by the owner of a slot outside a
    /// pool (`on_condemn`).
    condemn_hook: OnceLock<CondemnHook>,
    /// Wakes the drivers of the events still in the isolate when it is
    /// condemned (`until_condemned`).
    condemned_wake: tokio::sync::Notify,
    /// Cells of this isolate whose storage failed a commit, for the Actor to
    /// move (`take_broken_cells`).
    broken_cells: std::sync::Mutex<Vec<(String, HeapId)>>,
    #[cfg(celld_internal_tests)]
    turn_observations: Mutex<Vec<String>>,
}

type CondemnHook = Box<dyn Fn(&Slot) + Send + Sync>;

/// How many isolates this process has condemned, so a watcher can tell that
/// one was without scanning every slot.
static CONDEMNATIONS: AtomicU64 = AtomicU64::new(0);

/// How many cells were ever marked broken (`Slot::mark_broken`), read as
/// `CONDEMNATIONS` is: a watcher that sees a new count finds the cell queued.
static BREAKS: AtomicU64 = AtomicU64::new(0);

/// The number of cells marked broken so far.
pub(crate) fn breaks() -> u64 {
    BREAKS.load(Ordering::Acquire)
}

/// The number of isolates condemned so far.
pub(crate) fn condemnations() -> u64 {
    // Pairs with the increment in `condemn`, so a watcher that sees the new
    // count also sees the slot's `condemned` flag.
    CONDEMNATIONS.load(Ordering::Acquire)
}

use crate::turn_owner::refusal_for;
pub use crate::turn_owner::stuck_census;
pub use crate::turn_owner::stuck_isolates;
pub use crate::turn_owner::stuck_node_cap;
use crate::turn_owner::Owner;
use crate::turn_owner::Presence;
pub use crate::turn_owner::StuckCensus;
pub use crate::turn_owner::StuckRefusal;

/// A new slot's presence, counted against `owner`.
fn presence_of(owner: Option<&Arc<Owner>>) -> Arc<Presence> {
    match owner {
        Some(owner) => owner.presence(),
        None => Arc::new(Presence::new(None)),
    }
}

thread_local! {
    static CURRENT_SLOT: std::cell::RefCell<Option<std::sync::Weak<Slot>>> =
        const { std::cell::RefCell::new(None) };
}

/// The slot whose turn this thread runs, for an op that must reach its own
/// isolate again after the turn.
const NOT_CONDEMNED: u8 = 0;
const CONDEMNED: u8 = 1;
const CONDEMNED_FOR_CPU: u8 = 2;

/// Building an isolate failed: its Worker did not load. Typed so a caller can
/// tell a startup error from a failure of placement itself.
#[derive(Debug)]
pub(crate) struct WorkerLoadFailed(pub(crate) anyhow::Error);

impl std::fmt::Display for WorkerLoadFailed {
    /// The load's own error, without the host's context below it.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// The host's context stays in the chain, for the node log.
impl std::error::Error for WorkerLoadFailed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source()
    }
}

/// The slot of the isolate this thread runs a turn of, without keeping it.
pub(crate) fn current_slot_weak() -> Option<std::sync::Weak<Slot>> {
    CURRENT_SLOT.with_borrow(Option::clone)
}

pub(crate) fn current_slot() -> Option<Arc<Slot>> {
    CURRENT_SLOT.with_borrow(|slot| slot.as_ref().and_then(std::sync::Weak::upgrade))
}

impl Slot {
    fn observe(&self) -> IsolateLoad {
        IsolateLoad {
            turns: self.turns.load(Ordering::Relaxed),
            requests: self.requests.load(Ordering::Relaxed),
            sockets: self.sockets.load(Ordering::Relaxed),
            cells: self.cells.load(Ordering::Relaxed),
            // A stuck turn holds the isolate: placement skips it until the
            // turn returns, before the grace condemns it.
            retiring: self.retiring.load(Ordering::Relaxed) || self.presence.is_stuck(),
        }
    }

    /// Enter the isolate for one turn and run `f` inside it, on an isolate
    /// thread (`crate::isolate_threads`), or on this one when the node has
    /// none.
    ///
    /// Only the gate is awaited; `f` is synchronous by type, so holding the
    /// isolate across an await is unwritable rather than a rule a comment
    /// asks callers to remember. `f` owns what it uses, since the turn can
    /// outlive a caller that stops waiting: dropping the future before the
    /// turn starts means it never runs, and after, it runs to its end and
    /// its result is dropped on the isolate thread.
    pub async fn turn<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut js::Worker) -> T + Send + 'static,
    ) -> T {
        self.turn_in(TurnLane::Stateless, false, f).await
    }

    /// [`turn`](Self::turn) for the turn that starts an event: it waits while
    /// its owner runs its share with a long turn (`Owner::must_wait`).
    pub(crate) async fn turn_event<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut js::Worker) -> T + Send + 'static,
    ) -> T {
        self.turn_in(TurnLane::Stateless, true, f).await
    }

    /// [`turn_cell`](Self::turn_cell) for the turn that starts a cell event.
    pub(crate) async fn turn_cell_event<T: Send + 'static>(
        &self,
        scope: &str,
        f: impl FnOnce(&mut js::Worker) -> T + Send + 'static,
    ) -> T {
        self.turn_in(TurnLane::Cell(scope.to_string()), true, f)
            .await
    }

    /// [`turn`](Self::turn) with `state`, which the turn borrows and hands
    /// back: an event's in-flight record, which lives between its turns.
    pub async fn turn_with<S: Send + 'static, T: Send + 'static>(
        &self,
        mut state: S,
        f: impl FnOnce(&mut js::Worker, &mut S) -> T + Send + 'static,
    ) -> (S, T) {
        self.turn(move |worker| {
            let result = f(worker, &mut state);
            (state, result)
        })
        .await
    }

    /// Enter one cell turn through a round-robin lane for that cell. A hot
    /// cell can retain its next place, but it cannot take the next place from
    /// another cell that already waits on the same isolate.
    pub async fn turn_cell<T: Send + 'static>(
        &self,
        scope: &str,
        f: impl FnOnce(&mut js::Worker) -> T + Send + 'static,
    ) -> T {
        self.turn_in(TurnLane::Cell(scope.to_string()), false, f)
            .await
    }

    async fn turn_in<T: Send + 'static>(
        &self,
        lane: TurnLane,
        event: bool,
        f: impl FnOnce(&mut js::Worker) -> T + Send + 'static,
    ) -> T {
        struct Counted<'a>(&'a Slot);
        impl Drop for Counted<'_> {
            fn drop(&mut self) {
                self.0.turns.fetch_sub(1, Ordering::Relaxed);
                // A stop's turn can give back a condemned isolate's last cell
                // while it still holds the isolate, so the bell the residency
                // rang found it busy. Ring again now that the turn is over.
                self.0.ring_if_condemned_and_empty();
            }
        }
        self.turns.fetch_add(1, Ordering::Relaxed);
        let _turn = Counted(self);
        let me = self
            .me
            .upgrade()
            .expect("a slot whose turn is awaited is alive");
        #[cfg(celld_internal_tests)]
        let observed = match &lane {
            TurnLane::Stateless => "stateless".to_string(),
            TurnLane::Cell(scope) => scope.clone(),
        };
        let (send, receive) = tokio::sync::oneshot::channel::<std::thread::Result<T>>();
        let slot = Arc::downgrade(&me);
        let job: TurnJob = Box::new(move |worker| {
            // The caller left before the turn began: it never runs. It is
            // alive otherwise, so its turn keeps the isolate from being
            // freed.
            if send.is_closed() {
                return;
            }
            let Some(me) = slot.upgrade() else {
                return;
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let worker = match worker.as_mut() {
                    Some(worker) => worker,
                    None => panic!("entered isolate {} after it was freed", me.id),
                };
                #[cfg(celld_internal_tests)]
                me.turn_observations.lock().unwrap().push(observed);
                me.run_one(worker, f)
            }));
            // A caller that left after the turn began drops its result
            // here, inside the catch: the run of this isolate's turns must go
            // on whatever the result's drop does. A panic is only logged.
            let unsent = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || match send
                .send(result)
            {
                Ok(()) => None,
                Err(Err(panic)) => Some(crate::isolate_threads::panic_text(&*panic)),
                Err(Ok(value)) => {
                    drop(value);
                    None
                }
            }));
            let panic = match unsent {
                Ok(panic) => panic,
                Err(panic) => Some(crate::isolate_threads::panic_text(&*panic)),
            };
            if let Some(panic) = panic {
                tracing::error!(
                    event = "isolate_turn_panicked",
                    isolate = %me.heap_id,
                    %panic,
                    "a turn whose caller left panicked"
                );
            }
        });
        let start = me
            .turn_queue
            .lock()
            .expect("turn queue poisoned")
            .push_turn(lane, event, job);
        if start {
            match crate::isolate_threads::installed() {
                // Already on an isolate thread, as an event's driver is
                // (`isolate_threads::spawn_near`): run this turn here, and only
                // this one, so the driver's reply waits for no other turn.
                Some(_) if crate::isolate_threads::current_thread().is_some() => {
                    me.run_turns(RunMode::Inline)
                }
                Some(threads) => {
                    let prefer = me.last_thread();
                    let owner = me.owner();
                    threads.submit_for(
                        Box::new(move || me.run_turns(RunMode::Batch)),
                        prefer,
                        owner.as_deref(),
                    );
                }
                None => me.run_turns(RunMode::Drain),
            }
        }
        match receive
            .await
            .expect("an isolate dropped a turn without running it")
        {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    /// The owner this isolate's turns count against.
    pub(crate) fn owner(&self) -> Option<Arc<Owner>> {
        self.presence.owner().cloned()
    }

    /// The isolate thread that last ran this isolate's turns.
    pub(crate) fn last_thread(&self) -> Option<u64> {
        self.last_thread.load(Ordering::Relaxed).checked_sub(1)
    }

    /// Run one turn in `worker`, marked as this slot's.
    fn run_one<T>(&self, worker: &mut js::Worker, f: impl FnOnce(&mut js::Worker) -> T) -> T {
        /// Undoes the slot mark, also when `f` panics.
        struct Current(Option<std::sync::Weak<Slot>>);
        impl Drop for Current {
            fn drop(&mut self) {
                CURRENT_SLOT.set(self.0.take());
            }
        }
        let _entered = self.presence.enter();
        let _current = Current(CURRENT_SLOT.replace(Some(self.me.clone())));
        let _turn = worker.watched_turn();
        f(worker)
    }

    /// Run this isolate's waiting turns, one after another: one, with
    /// [`RunMode::Inline`], handing the rest to an isolate thread; for up to
    /// [`TURN_BATCH`], with [`RunMode::Batch`]; or all, with
    /// [`RunMode::Drain`], where there are no isolate threads.
    ///
    /// While its owner has a long turn and runs its share, the run waits for
    /// one of the owner's turns to end ([`Owner::must_wait`]).
    fn run_turns(self: Arc<Self>, mode: RunMode) {
        /// Ends the run if it unwinds, so the slot's turns are not left
        /// waiting on a run that is gone.
        struct Running<'a>(&'a Arc<Slot>, bool);
        impl Drop for Running<'_> {
            fn drop(&mut self) {
                if self.1 {
                    // What unwound held these; the queue and the isolate
                    // stay consistent, so later runs and frees may use them.
                    self.0.worker.clear_poison();
                    self.0.turn_queue.clear_poison();
                    self.0.end_run();
                }
            }
        }
        let started = std::time::Instant::now();
        if let Some(thread) = crate::isolate_threads::current_thread() {
            self.last_thread.store(thread + 1, Ordering::Relaxed);
        }
        let pooled = crate::isolate_threads::installed().is_some();
        let mut running = Running(&self, true);
        loop {
            let event = self
                .turn_queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .next_starts_event();
            let wait =
                event && pooled && self.presence.owner().is_some_and(|owner| owner.must_wait());
            let next = {
                let mut queue = self
                    .turn_queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if wait {
                    queue.next_skipping_events()
                } else {
                    queue.next()
                }
            };
            // Only event starts wait, and their owner must wait: the run
            // resumes once one of the owner's turns ends.
            if next.is_none() && wait {
                running.1 = false;
                let slot = self.clone();
                if let Some(owner) = self.presence.owner() {
                    owner.defer(Box::new(move || slot.run_turns(RunMode::Batch)));
                }
                return;
            }
            let Some(job) = next else {
                running.1 = false;
                return;
            };
            {
                // A job catches its own panics; one that escapes poisons
                // nothing a later turn depends on.
                let mut worker = self
                    .worker
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                job(&mut worker);
            }
            let yields = match mode {
                RunMode::Inline => true,
                RunMode::Batch => started.elapsed() >= TURN_BATCH,
                RunMode::Drain => false,
            };
            if yields {
                running.1 = false;
                self.end_run();
                return;
            }
        }
    }

    /// End a run of this slot's turns: hand those still waiting to an
    /// isolate thread, or mark the slot idle.
    fn end_run(self: &Arc<Self>) {
        let more = {
            let mut queue = self
                .turn_queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let more = queue.has_waiting();
            if !more {
                queue.running = false;
            }
            more
        };
        if !more {
            return;
        }
        match crate::isolate_threads::installed() {
            Some(threads) => {
                let slot = self.clone();
                let owner = slot.owner();
                threads.submit_for(
                    Box::new(move || slot.run_turns(RunMode::Batch)),
                    None,
                    owner.as_deref(),
                );
            }
            // Nothing else runs them: the next turn's push starts a run.
            None => {
                self.turn_queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .running = false;
            }
        }
    }

    /// Reserve one event through its complete lifetime, including the reply
    /// gate. Releasing at the gate would let stalled storage retain unbounded
    /// promises and copied bodies. Cell turn fairness is enforced separately.
    pub(crate) fn queue_producer(self: &Arc<Self>, scope: &str) -> Option<QueueProducerPermit> {
        let mut producers = self
            .queue_producers
            .lock()
            .expect("Queue producer admission poisoned");
        let outstanding = producers.entry(scope.to_string()).or_default();
        if *outstanding >= MAX_QUEUE_PRODUCER_EVENTS_PER_CELL {
            return None;
        }
        *outstanding += 1;
        Some(QueueProducerPermit {
            slot: self.clone(),
            scope: scope.to_string(),
        })
    }

    fn release_queue_producer(&self, scope: &str) {
        let mut producers = self
            .queue_producers
            .lock()
            .expect("Queue producer admission poisoned");
        let outstanding = producers
            .get_mut(scope)
            .expect("a Queue producer permit has an admission");
        *outstanding -= 1;
        if *outstanding == 0 {
            producers.remove(scope);
        }
    }

    /// Mark a request as living in this isolate. Held for the request's whole
    /// life, including while it is suspended, because its promise stays in
    /// this heap and every later turn must come back here.
    pub fn affiliate(self: &Arc<Self>) -> Affiliation {
        self.requests.fetch_add(1, Ordering::Relaxed);
        Affiliation(self.clone(), AtomicBool::new(false))
    }

    /// A slot holding a Worker Loader's Worker, whose stuck isolates count
    /// toward `stuck`. `generation` is the loader's
    /// ([`Slot::generation`]): the loaded Worker lives as long as the
    /// loader's isolate holds it, so it retires with the loader's generation.
    pub(crate) fn loaded_worker(
        worker: js::Worker,
        owner: Arc<Owner>,
        generation: Arc<GenerationRetirement>,
    ) -> Arc<Self> {
        Self::outside_pool(worker, true, Some(owner), generation)
    }

    /// A slot holding a Worker outside a placement pool.
    ///
    /// A dynamic Worker owns exactly one isolate, so it needs no
    /// admission, growth, or retirement policy.
    fn outside_pool(
        worker: js::Worker,
        loaded_worker: bool,
        owner: Option<Arc<Owner>>,
        generation: Arc<GenerationRetirement>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Slot {
            me: me.clone(),
            id: 0,
            heap_id: next_heap_id(),
            worker: Mutex::new(Some(worker)),
            presence: presence_of(owner.as_ref()),
            turn_queue: Mutex::default(),
            last_thread: AtomicU64::new(0),
            queue_producers: Mutex::new(std::collections::HashMap::new()),
            turns: AtomicUsize::new(0),
            requests: AtomicUsize::new(0),
            sockets: AtomicUsize::new(0),
            socket_requests: node_socket_requests(),
            generation,
            freed: Arc::new(tokio::sync::Notify::new()),
            reclaim: None,
            loaded_worker,
            cells: AtomicUsize::new(0),
            adopted_cells: AtomicUsize::new(0),
            retiring: AtomicBool::new(false),
            condemned: std::sync::atomic::AtomicU8::new(NOT_CONDEMNED),
            condemn_hook: OnceLock::new(),
            condemned_wake: tokio::sync::Notify::new(),
            broken_cells: std::sync::Mutex::new(Vec::new()),
            #[cfg(celld_internal_tests)]
            turn_observations: Mutex::new(Vec::new()),
        })
    }

    /// Whether this slot holds a Worker Loader's Worker.
    pub(crate) fn is_loaded_worker(&self) -> bool {
        self.loaded_worker
    }

    #[cfg(any(test, celld_internal_tests))]
    pub fn for_test(worker: js::Worker) -> Arc<Self> {
        Self::outside_pool(worker, false, None, Arc::default())
    }

    #[cfg(test)]
    pub(crate) fn vacant_for_request_cancellation_test() -> Arc<Self> {
        Self::vacant_for_test(Arc::new(SocketRequests::new(usize::MAX)), Arc::default())
    }

    /// A slot with no worker that counts the requests only their sockets
    /// keep in `socket_requests`, and retires with `generation`.
    #[cfg(test)]
    fn vacant_for_test(
        socket_requests: Arc<SocketRequests>,
        generation: Arc<GenerationRetirement>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Slot {
            me: me.clone(),
            id: 0,
            heap_id: HeapId::new(0),
            worker: Mutex::new(None),
            presence: presence_of(None),
            turn_queue: Mutex::default(),
            last_thread: AtomicU64::new(0),
            queue_producers: Mutex::new(std::collections::HashMap::new()),
            turns: AtomicUsize::new(0),
            requests: AtomicUsize::new(0),
            sockets: AtomicUsize::new(0),
            socket_requests,
            generation,
            freed: Arc::new(tokio::sync::Notify::new()),
            reclaim: None,
            loaded_worker: false,
            cells: AtomicUsize::new(0),
            adopted_cells: AtomicUsize::new(0),
            retiring: AtomicBool::new(false),
            condemned: std::sync::atomic::AtomicU8::new(NOT_CONDEMNED),
            condemn_hook: OnceLock::new(),
            condemned_wake: tokio::sync::Notify::new(),
            broken_cells: std::sync::Mutex::new(Vec::new()),
            #[cfg(celld_internal_tests)]
            turn_observations: Mutex::new(Vec::new()),
        })
    }

    /// Hold the isolate as a turn would, once the turn running now ends: no
    /// turn runs until the guard drops, and those queued meanwhile then run.
    #[cfg(celld_internal_tests)]
    #[doc(hidden)]
    pub async fn hold_turn_for_test(&self) -> impl Drop + '_ {
        struct Held<'a>(&'a Slot);
        impl Drop for Held<'_> {
            fn drop(&mut self) {
                let start = {
                    let mut queue = self.0.turn_queue.lock().unwrap();
                    queue.held = false;
                    queue.has_waiting() && !std::mem::replace(&mut queue.running, true)
                };
                if let (true, Some(slot)) = (start, self.0.me.upgrade()) {
                    match crate::isolate_threads::installed() {
                        Some(threads) => threads.submit_for(
                            Box::new(move || slot.run_turns(RunMode::Batch)),
                            None,
                            None,
                        ),
                        None => slot.run_turns(RunMode::Drain),
                    }
                }
            }
        }
        self.turn_queue.lock().unwrap().held = true;
        while self.turn_queue.lock().unwrap().running {
            tokio::task::yield_now().await;
        }
        Held(self)
    }

    #[cfg(celld_internal_tests)]
    #[doc(hidden)]
    pub fn queued_turns_for_test(&self) -> usize {
        self.turns.load(Ordering::Relaxed)
    }

    #[cfg(celld_internal_tests)]
    #[doc(hidden)]
    pub fn reset_turn_observations_for_test(&self) {
        self.turn_observations.lock().unwrap().clear();
    }

    #[cfg(celld_internal_tests)]
    #[doc(hidden)]
    pub fn turn_observations_for_test(&self) -> Vec<String> {
        self.turn_observations.lock().unwrap().clone()
    }

    /// Give this isolate a cell's realm. Held for as long as the cell lives
    /// here, which is what stops the isolate being retired underneath it.
    fn house(self: &Arc<Self>, max_cells: usize) -> Residency {
        let cells = self.cells.fetch_add(1, Ordering::Relaxed) + 1;
        debug_assert!(cells <= max_cells);
        Residency {
            slot: self.clone(),
            max_cells,
            adopted: false,
        }
    }

    /// Whether placement may give this isolate new work: it is not
    /// retiring, and no turn of it is stuck.
    fn takes_work(&self) -> bool {
        !self.is_retiring() && !self.presence.is_stuck()
    }

    pub fn is_retiring(&self) -> bool {
        self.retiring.load(Ordering::Relaxed)
    }

    /// Retire this isolate because its guest can no longer run in it, and
    /// ask the pool to free it once it drains. Returns whether the slot
    /// belongs to a pool that can do both.
    ///
    /// Placement already skips a retiring slot, so the next request grows a
    /// fresh isolate instead. Leaving the dead isolate to placement is the
    /// failure this prevents: it fails each request in about a millisecond,
    /// so it carries the fewest turns and `place` hands it nearly every
    /// request. [`reap`](Self::reap) does not know it is dead, and on a
    /// four-isolate node it retired the three healthy isolates first, one
    /// per 30 s pass, so one fatal Python error failed that node's traffic
    /// for 94 s.
    ///
    /// The bell, not the 30 s reap, frees the heap: a guest that fails on
    /// every start would otherwise hold one dead heap per failure until the
    /// next tick, and a Python heap is tens of megabytes.
    ///
    /// A cell pool has no task on the bell. A condemned cell isolate takes
    /// no new cell, and frees when its cells leave, as retirement always
    /// has. The Actor moves them (`condemned_cell_isolates`).
    ///
    /// A Worker Loader's slot has no pool either: the loader replaces it at
    /// the next call (`loaded_worker_slot`).
    pub(crate) fn condemn(&self, reason: &str) -> bool {
        let condemned = if reason == crate::js::CPU_EXCEEDED {
            CONDEMNED_FOR_CPU
        } else {
            CONDEMNED
        };
        if self
            .condemned
            .compare_exchange(
                NOT_CONDEMNED,
                condemned,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .is_ok()
        {
            self.retiring.store(true, Ordering::Relaxed);
            CONDEMNATIONS.fetch_add(1, Ordering::Release);
            tracing::warn!(isolate = %self.heap_id, slot = self.id, reason, "isolate condemned");
            if let Some(hook) = self.condemn_hook.get() {
                hook(self);
            }
            self.condemned_wake.notify_waiters();
        }
        match &self.reclaim {
            Some(reclaim) => {
                reclaim.notify_one();
                true
            }
            None => self.loaded_worker,
        }
    }

    /// Have `hook` run when this slot is condemned. Set once, by the owner of
    /// a slot outside a pool, which no pool replaces.
    pub(crate) fn on_condemn(&self, hook: CondemnHook) {
        if self.condemn_hook.set(hook).is_err() {
            panic!("isolate {} already has a condemnation hook", self.heap_id);
        }
    }

    /// Ask the pool to free this isolate if it is condemned and holds no
    /// cell. Freeing waits for its turns and requests, so a busy one is
    /// asked again when they end.
    fn ring_if_condemned_and_empty(&self) {
        if self.is_condemned() && self.cells.load(Ordering::Relaxed) == 0 {
            if let Some(reclaim) = &self.reclaim {
                reclaim.notify_one();
            }
        }
    }

    /// Resolves once this slot is condemned, so the driver of an event that
    /// waits on something else, possibly for good, fails it at once and lets
    /// the isolate go.
    pub(crate) async fn until_condemned(&self) {
        let notified = self.condemned_wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_condemned() {
            return;
        }
        notified.await;
    }

    /// How long ago this slot's pool came to belong to a superseded
    /// generation ([`Pool::retire_all`]), so a request that only its
    /// WebSockets keep lets the isolate go rather than hold it while they
    /// stay open.
    pub(crate) fn generation_retired_for(&self) -> Option<std::time::Duration> {
        self.generation.retired_for()
    }

    /// The retirement this slot's pool shares, which a Worker it loads
    /// shares too ([`Slot::loaded_worker`]).
    pub(crate) fn generation(&self) -> Arc<GenerationRetirement> {
        self.generation.clone()
    }

    /// Resolves once [`generation_retired_for`](Self::generation_retired_for)
    /// has a value.
    pub(crate) async fn until_generation_retired(&self) {
        let notified = self.generation.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.generation.is_retired() {
            return;
        }
        notified.await;
    }

    /// The cell `scope` of this isolate failed a commit and must move to a
    /// new instance (`js::do_instances::cell_broken`).
    pub(crate) fn mark_broken(&self, scope: &str) {
        self.broken_cells
            .lock()
            .unwrap()
            .push((scope.to_string(), self.heap_id));
        BREAKS.fetch_add(1, Ordering::Release);
    }

    /// The cells marked broken since the last take, each with the heap it
    /// broke in.
    pub(crate) fn take_broken_cells(&self) -> Vec<(String, HeapId)> {
        std::mem::take(&mut *self.broken_cells.lock().unwrap())
    }

    /// Whether [`condemn`](Self::condemn) ran.
    pub(crate) fn is_condemned(&self) -> bool {
        self.condemned.load(Ordering::Relaxed) != NOT_CONDEMNED
    }

    /// What this slot's events fail with once it is condemned.
    pub(crate) fn condemned_text(&self) -> &'static str {
        if self.condemned.load(Ordering::Relaxed) == CONDEMNED_FOR_CPU {
            crate::js::CPU_EXCEEDED
        } else {
            crate::js::MEMORY_EXCEEDED
        }
    }

    /// The node-wide identity of this slot's currently installed V8 heap.
    pub fn heap_id(&self) -> HeapId {
        self.heap_id
    }

    fn is_reusable(&self) -> bool {
        let load = self.observe();
        if !celld_logic::isolate::may_free(&load) || load.cells != 0 {
            return false;
        }
        self.worker.try_lock().is_ok_and(|worker| worker.is_none())
    }
}

/// A request's claim on the isolate that ran its first turn.
pub struct Affiliation(Arc<Slot>, AtomicBool);

impl Affiliation {
    pub fn slot(&self) -> &Arc<Slot> {
        &self.0
    }

    /// The request has answered and only its open WebSockets keep it: give
    /// its admission slot back, and count it among the node's socket
    /// requests instead, while they have room. It still holds the isolate,
    /// whose heap keeps its events' state, until it ends. Past the bound it
    /// keeps its slot. Returns whether it holds none.
    pub fn hold_for_sockets(&self) -> bool {
        if self.1.load(Ordering::Relaxed) {
            return true;
        }
        if !self.0.socket_requests.reserve() {
            return false;
        }
        self.1.store(true, Ordering::Relaxed);
        self.0.sockets.fetch_add(1, Ordering::Relaxed);
        // The slot it gave back can take a waiting request.
        self.0.freed.notify_one();
        true
    }
}

impl Drop for Affiliation {
    fn drop(&mut self) {
        if self.1.load(Ordering::Relaxed) {
            self.0.sockets.fetch_sub(1, Ordering::Relaxed);
            self.0.socket_requests.release();
        }
        self.0.requests.fetch_sub(1, Ordering::Relaxed);
        // Exactly one admission waiter per freed slot: `notify_one` hands
        // the capacity to a single parked request, where waking them all
        // would stampede `admit` on every release.
        self.0.freed.notify_one();
        // The last request out of a retiring isolate is what lets it free.
        // Freeing here would drop a V8 isolate inside whatever turn dropped
        // this affiliation, so the pool's maintenance task does it.
        if self.0.is_retiring() {
            if let Some(reclaim) = &self.0.reclaim {
                reclaim.notify_one();
            }
        }
    }
}

/// A cell's claim on the isolate that holds its realm.
///
/// The counterpart of [`Affiliation`], and the difference between them is
/// the whole reason both exist: an affiliation lasts one request, a
/// residency lasts until the cell is evicted or moves node.
pub struct Residency {
    slot: Arc<Slot>,
    max_cells: usize,
    adopted: bool,
}

impl Residency {
    pub fn slot(&self) -> &Arc<Slot> {
        &self.slot
    }

    /// Open a reserved cell's storage and return its residency with its alarm snapshot.
    /// Collection follows the last completed adoption, because reservation
    /// order can differ from the order in which activation futures resume.
    pub(crate) async fn adopt(
        mut self,
        cell: &str,
        storage: js::CellStorage<'_>,
    ) -> Result<(Self, celld_logic::wake::AlarmSnapshot)> {
        anyhow::ensure!(!self.adopted, "cell residency already adopted");
        let slot = self.slot.clone();
        let cell = cell.to_string();
        let path = storage.path.to_string();
        let vfs = storage.vfs.map(str::to_string);
        let (epoch, replicated_wake) = (storage.epoch, storage.replicated_wake);
        // The residency goes into the turn and comes back: a caller that
        // stops waiting leaves it to the turn, which drops it with both its
        // counters once the adoption is accounted.
        slot.turn(
            move |worker| -> Result<(Self, celld_logic::wake::AlarmSnapshot)> {
                let storage = js::CellStorage {
                    path: &path,
                    epoch,
                    replicated_wake,
                    vfs: vfs.as_deref(),
                };
                let alarm = worker.own_cell(&cell, Some(storage))?;
                // There is no await between adoption and accounting. Cancellation
                // before this turn drops only the reservation; afterward the
                // residency owns both counters, including on an error unwind.
                self.adopted = true;
                let adopted = self.slot.adopted_cells.fetch_add(1, Ordering::Relaxed) + 1;
                debug_assert!(adopted <= self.max_cells);
                if adopted == self.max_cells {
                    worker.settle_heap();
                }
                Ok((self, alarm))
            },
        )
        .await
    }
}

impl Drop for Residency {
    fn drop(&mut self) {
        if self.adopted {
            self.slot.adopted_cells.fetch_sub(1, Ordering::Relaxed);
        }
        self.slot.cells.fetch_sub(1, Ordering::Relaxed);
        // The last cell out of a condemned isolate is what lets it free, as
        // the last request out of a retiring one does.
        self.slot.ring_if_condemned_and_empty();
    }
}

type Build = Arc<dyn Fn() -> Result<js::Worker> + Send + Sync>;

/// The node's requests that only their open WebSockets keep, and the most it
/// may hold outside admission (`CELLD_MAX_SOCKET_REQUESTS`).
struct SocketRequests {
    held: AtomicUsize,
    max: usize,
}

impl SocketRequests {
    fn new(max: usize) -> Self {
        Self {
            held: AtomicUsize::new(0),
            max,
        }
    }

    fn reserve(&self) -> bool {
        let mut held = self.held.load(Ordering::Relaxed);
        while held < self.max {
            match self.held.compare_exchange_weak(
                held,
                held + 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(now) => held = now,
            }
        }
        false
    }

    fn release(&self) {
        self.held.fetch_sub(1, Ordering::Relaxed);
    }
}

/// One count and bound for the whole node, across every pool, generation
/// and Worker Loader slot: what such a request holds is node memory
/// ([`crate::runtime::max_socket_requests`]), and a bound per pool would
/// multiply with the scripts and generations a node runs.
static NODE_SOCKET_REQUESTS: OnceLock<Arc<SocketRequests>> = OnceLock::new();

fn node_socket_requests() -> Arc<SocketRequests> {
    NODE_SOCKET_REQUESTS
        .get_or_init(|| Arc::new(SocketRequests::new(crate::runtime::max_socket_requests())))
        .clone()
}

/// Whether a pool belongs to a superseded generation, since when, and the
/// bell that tells its requests so.
#[derive(Default)]
pub(crate) struct GenerationRetirement {
    /// When the generation first retired.
    retired_at: OnceLock<std::time::Instant>,
    wake: tokio::sync::Notify,
}

impl GenerationRetirement {
    fn retire(&self) {
        let _ = self.retired_at.set(std::time::Instant::now());
        self.wake.notify_waiters();
    }

    fn retired_for(&self) -> Option<std::time::Duration> {
        self.retired_at.get().map(std::time::Instant::elapsed)
    }

    fn is_retired(&self) -> bool {
        self.retired_at.get().is_some()
    }
}

pub struct Pool {
    slots: RwLock<Vec<Arc<Slot>>>,
    limits: PoolLimits,
    build: Build,
    freed: Arc<tokio::sync::Notify>,
    /// Rung by a condemnation and by the last request out of a retiring
    /// isolate. See [`Pool::reclaim_bell`].
    reclaim: Arc<tokio::sync::Notify>,
    admission_wait: std::time::Duration,
    /// The whole pool belongs to a superseded generation. An isolate grown
    /// after this is set starts out retiring: a placement that snapshotted
    /// the old generation just before the flip can still land, but nothing
    /// it builds outlives the work it was built for.
    retired: Arc<GenerationRetirement>,
    /// The node's requests that only their open WebSockets keep, shared with
    /// its slots.
    socket_requests: Arc<SocketRequests>,
    /// Keeps admission and cell placement from racing isolate retirement.
    /// Stateless admission takes a shared guard, while maintenance and cell
    /// placement take the exclusive guard.
    maintenance: RwLock<()>,
    /// The owner of the script this pool serves (`for_script`).
    owner: Option<Arc<Owner>>,
}

impl Pool {
    pub fn new(
        limits: PoolLimits,
        admission_wait: std::time::Duration,
        build: impl Fn() -> Result<js::Worker> + Send + Sync + 'static,
    ) -> Self {
        Pool {
            slots: RwLock::new(Vec::new()),
            limits,
            build: Arc::new(build),
            freed: Arc::new(tokio::sync::Notify::new()),
            reclaim: Arc::new(tokio::sync::Notify::new()),
            admission_wait,
            retired: Arc::default(),
            socket_requests: node_socket_requests(),
            maintenance: RwLock::new(()),
            owner: None,
        }
    }

    /// Count this pool's stuck isolates as the script `script`'s, and refuse
    /// its placements at the caps.
    pub(crate) fn for_script(mut self, script: &str) -> Self {
        self.owner = Some(crate::turn_owner::owner(script));
        self
    }

    /// Share `reclaim` as this pool's reclaim bell, for an owner whose one
    /// task frees several pools.
    pub(crate) fn with_reclaim(mut self, reclaim: Arc<tokio::sync::Notify>) -> Self {
        self.reclaim = reclaim;
        self
    }

    fn load(&self) -> PoolLoad {
        let slots = self.slots.read().expect("pool poisoned");
        PoolLoad {
            isolates: slots.iter().map(|s| s.observe()).collect(),
            limits: self.limits,
        }
    }

    pub fn len(&self) -> usize {
        self.slots.read().expect("pool poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn get(&self, id: IsolateId) -> Arc<Slot> {
        self.slots.read().expect("pool poisoned")[id].clone()
    }

    /// Build an isolate and admit it to the pool.
    ///
    /// The isolate is constructed before the lock is taken: loading a script
    /// runs JS and can take milliseconds, and holding the pool lock across it
    /// would stall every other placement on the node.
    /// Build an isolate, unless a capped pool reached `cap` while this one
    /// was being built. Cell placement passes no cap because node memory is
    /// bounded before placement and its per-isolate limit must remain exact.
    ///
    /// `cap` is re-checked under the write lock because admission decides
    /// against a snapshot it does not hold. Without the re-check every
    /// request that saw the same pre-growth snapshot grows, so a cap of two
    /// produced sixteen isolates under load — the breach scaled with offered
    /// concurrency, and the configured limit was met only when serialised.
    fn grow(&self, cap: Option<usize>) -> Result<Arc<Slot>> {
        Ok(self.install(self.build_worker()?, cap))
    }

    /// Load the pool's Worker into a new isolate, outside any lock.
    fn build_worker(&self) -> Result<js::Worker> {
        (self.build)().map_err(|source| anyhow::Error::new(WorkerLoadFailed(source)))
    }

    /// Admit a built isolate to the pool, or, past `cap`, return a live one
    /// and drop it.
    fn install(&self, worker: js::Worker, cap: Option<usize>) -> Arc<Slot> {
        let mut slots = self.slots.write().expect("pool poisoned");
        // As placement counts them (`observe`): a stuck isolate is not live.
        let live = slots.iter().filter(|slot| slot.takes_work()).count();
        if cap.is_some_and(|cap| live >= cap) {
            if let Some(slot) = slots.iter().find(|slot| slot.takes_work()) {
                return slot.clone();
            }
        }
        // A freed slot has no worker, work, affiliations, or cells. Reuse its
        // stable index so placement scans scale with the current pool rather
        // than with every isolate created during the process lifetime.
        let reusable = slots.iter().position(|slot| slot.is_reusable());
        let id = reusable.unwrap_or(slots.len());
        let heap_id = next_heap_id();
        let slot = Arc::new_cyclic(|me| Slot {
            me: me.clone(),
            id,
            heap_id,
            worker: Mutex::new(Some(worker)),
            presence: presence_of(self.owner.as_ref()),
            turn_queue: Mutex::default(),
            last_thread: AtomicU64::new(0),
            queue_producers: Mutex::new(std::collections::HashMap::new()),
            turns: AtomicUsize::new(0),
            requests: AtomicUsize::new(0),
            sockets: AtomicUsize::new(0),
            socket_requests: self.socket_requests.clone(),
            generation: self.retired.clone(),
            freed: self.freed.clone(),
            reclaim: Some(self.reclaim.clone()),
            loaded_worker: false,
            cells: AtomicUsize::new(0),
            adopted_cells: AtomicUsize::new(0),
            retiring: AtomicBool::new(self.retired.is_retired()),
            condemned: std::sync::atomic::AtomicU8::new(NOT_CONDEMNED),
            condemn_hook: OnceLock::new(),
            condemned_wake: tokio::sync::Notify::new(),
            broken_cells: std::sync::Mutex::new(Vec::new()),
            #[cfg(celld_internal_tests)]
            turn_observations: Mutex::new(Vec::new()),
        });
        if let Some(id) = reusable {
            slots[id] = slot.clone();
        } else {
            slots.push(slot.clone());
        }
        tracing::info!(isolate = %heap_id, slot = id, total = slots.len(), "isolate started");
        slot
    }

    /// A live isolate to place on when the stuck caps refuse growth.
    fn any_live(&self) -> Option<Arc<Slot>> {
        self.slots
            .read()
            .expect("pool poisoned")
            .iter()
            .find(|slot| slot.takes_work())
            .cloned()
    }

    /// Build one isolate up front.
    ///
    /// The pool is otherwise lazy, and an idle node holding no isolates is the
    /// point. But the first isolate is built at startup for two reasons that
    /// laziness cannot serve: a node whose script does not load must fail
    /// *then*, not once per request forever after; and compiling the script
    /// inside the first request adds its whole cost to that request's latency,
    /// which a startup probe reads as a node that never came up.
    pub fn warm(&self) -> Result<()> {
        self.grow(Some(self.limits.max_stateless))?;
        Ok(())
    }

    /// Take a stateless request, or refuse it, building an isolate on this
    /// thread when it needs one.
    ///
    /// One call against one snapshot: admission and placement are the same
    /// decision, so the node cannot admit a request it then fails to place.
    pub fn admit(&self, shedding: bool) -> Result<Affiliation, AdmitError> {
        let mut grown = None;
        loop {
            if let Some(affiliation) = self.admit_guarded(shedding, &mut grown)? {
                return Ok(affiliation);
            }
            grown = Some(self.build_worker().map_err(AdmitError::Build)?);
        }
    }

    /// One admission decision under the maintenance guard. `None` asks the
    /// caller to build an isolate, outside the guard, and decide again with
    /// it in `grown`; a decision that no longer grows drops it.
    ///
    /// A configured request ceiling must remain exact under concurrent
    /// admission, so serialize the check and reservation only in that mode.
    /// The default unbounded path keeps concurrent shared access.
    fn admit_guarded(
        &self,
        shedding: bool,
        grown: &mut Option<js::Worker>,
    ) -> Result<Option<Affiliation>, AdmitError> {
        if self.limits.max_requests.is_some() {
            let _maintenance = self.maintenance.write().expect("pool poisoned");
            self.admit_locked(shedding, grown)
        } else {
            let _maintenance = self.maintenance.read().expect("pool poisoned");
            self.admit_locked(shedding, grown)
        }
    }

    fn admit_locked(
        &self,
        shedding: bool,
        grown: &mut Option<js::Worker>,
    ) -> Result<Option<Affiliation>, AdmitError> {
        // A script whose isolates are stuck runs nothing more until one
        // returns: each request would only take another thread.
        if let Some(refusal) = refusal_for(self.owner.as_deref(), false) {
            return Err(AdmitError::Stuck(refusal));
        }
        match celld_logic::isolate::admit(&self.load(), shedding)? {
            Placement::Existing(id) => Ok(Some(self.get(id).affiliate())),
            Placement::Grow => {
                if let Some(refusal) = refusal_for(self.owner.as_deref(), true) {
                    return match self.any_live() {
                        Some(slot) => Ok(Some(slot.affiliate())),
                        None => Err(AdmitError::Stuck(refusal)),
                    };
                }
                Ok(grown.take().map(|worker| {
                    self.install(worker, Some(self.limits.max_stateless))
                        .affiliate()
                }))
            }
        }
    }

    /// [`admit`](Self::admit), except that an isolate is built on an
    /// isolate thread, and a request that finds the node full waits —
    /// bounded — for a slot instead of being refused at once.
    ///
    /// The wait is the middle gear between "admit" and "refuse". At
    /// overload the parse-and-503 path costs about half a served request,
    /// so a node refusing 200k times a second spends its cores saying no.
    /// A parked waiter costs nothing until an `Affiliation` drop hands it
    /// the slot, and the excess load queues in kernel socket buffers
    /// behind connections nobody is reading. `NodePressured` still
    /// refuses at once: pressure means give resources back, not hold
    /// callers.
    pub async fn admit_or_wait(&self, shedding: bool) -> Result<Affiliation, AdmitError> {
        let deadline_ms =
            crate::asyncrt::mono_ms().saturating_add(self.admission_wait.as_millis() as u64);
        let mut grown = None;
        loop {
            // Armed before the check: a slot freed between a failed admit
            // and the park would otherwise be a lost wakeup.
            let freed = self.freed.notified();
            match self.admit_guarded(shedding, &mut grown) {
                Ok(Some(affiliation)) => return Ok(affiliation),
                Ok(None) => {
                    let build = self.build.clone();
                    let built = crate::isolate_threads::offload(move || build())
                        .await
                        .map_err(|error| AdmitError::Build(error.context("isolate build")))?;
                    grown = Some(built.map_err(|source| {
                        AdmitError::Build(anyhow::Error::new(WorkerLoadFailed(source)))
                    })?);
                }
                Err(AdmitError::Refused(Refusal::NodeFull)) => {
                    tokio::pin!(freed);
                    // A freed slot before the deadline: both arms end the
                    // wait, so declaring the order costs nothing and makes
                    // the branch replayable. Priority to the wakeup, because
                    // a slot that freed in the same instant the deadline
                    // expired is a slot the caller can have.
                    crate::asyncrt::select_biased! {
                        "a slot freed in the same instant as the deadline goes to the caller";
                        _ = &mut freed => {},
                        _ = crate::asyncrt::sleep_until(deadline_ms) => {
                            return Err(AdmitError::Refused(Refusal::NodeFull));
                        }
                    }
                }
                Err(other) => return Err(other),
            }
        }
    }

    /// Give a cell a home, building an isolate if every one is full.
    ///
    /// The counterpart of [`admit`](Self::admit) and deliberately the same
    /// shape: one call against one snapshot. It cannot refuse — by the time
    /// a cell needs a realm, ownership has already agreed the node serves
    /// it, so `celld_logic::isolate::place_cell` always answers.
    ///
    /// The stuck caps refuse it ([`StuckRefusal`]): a script at its own cap
    /// places no cell, and at the node-wide cap no cell grows an isolate.
    pub fn place_cell(&self) -> Result<Residency> {
        let _maintenance = self.maintenance.write().expect("pool poisoned");
        if let Some(refusal) = refusal_for(self.owner.as_deref(), false) {
            return Err(refusal.into());
        }
        let slot = match celld_logic::isolate::place_cell(&self.load()) {
            Placement::Existing(id) => self.get(id),
            Placement::Grow => {
                if let Some(refusal) = refusal_for(self.owner.as_deref(), true) {
                    return Err(refusal.into());
                }
                // Cell isolates have no arbitrary total cap. The resident-cell
                // and RSS limits bound node memory before placement. The lock
                // keeps this reservation exact and prevents maintenance from
                // retiring the slot.
                self.grow(None)?
            }
        };
        Ok(slot.house(self.limits.max_cells))
    }

    /// One maintenance pass: give back an isolate the pool no longer needs,
    /// and free whatever has finished draining.
    ///
    /// Without this the pool only grows. A burst takes it to `max_stateless`
    /// and every one of those V8 heaps is held for the life of the process,
    /// which is the whole reason `celld_logic::isolate::retire` exists —
    /// and, until this existed, the reason it was dead code hiding a leak.
    ///
    /// Retire at most one isolate. Stateless pools use this paced maintenance
    /// so a quiet interval does not discard every warm compiled Worker.
    pub fn reap(&self) {
        // Maintenance runs on a Tokio worker. Skip this pass when a blocking
        // cell start is compiling an isolate instead of blocking the worker.
        let Ok(_maintenance) = self.maintenance.try_write() else {
            return;
        };
        self.retire_one();
        self.free_retired();
    }

    /// The bell a maintenance task awaits to call
    /// [`free_drained`](Self::free_drained) between reap ticks.
    pub(crate) fn reclaim_bell(&self) -> Arc<tokio::sync::Notify> {
        self.reclaim.clone()
    }

    /// Free every retiring isolate that has drained, and retire nothing.
    /// Returns `false` when admission or cell placement holds the pool, so
    /// the caller retries rather than let the heap wait for the next reap.
    ///
    /// The guard is the one `reap` takes, for the same race: an admission
    /// that snapshotted this slot before it began retiring can still
    /// affiliate to it, and `may_free` only sees that request once the
    /// admission has released the guard.
    pub(crate) fn free_drained(&self) -> bool {
        let Ok(_maintenance) = self.maintenance.try_write() else {
            return false;
        };
        self.free_retired();
        true
    }

    /// Retire every empty isolate. Cell pools use this after eviction because
    /// an empty cell heap carries no warm request capacity worth preserving.
    pub fn reap_empty(&self) {
        let Ok(_maintenance) = self.maintenance.try_write() else {
            tracing::debug!(
                event = "isolate_reap_skipped",
                "a cell start holds the pool; empty isolates wait for the next pass"
            );
            return;
        };
        while self.retire_one() {}
        self.free_retired();
    }

    /// Retire every isolate, housed or not: the pool belongs to a superseded
    /// application generation and must take no new work. Stateless slots
    /// free as their affiliations drop; a slot hosting cells frees once the
    /// last of them has moved to a newer generation, which `may_free`
    /// enforces by refusing a housed isolate.
    pub fn retire_all(&self) {
        let _maintenance = self.maintenance.write().expect("pool poisoned");
        self.retired.retire();
        for slot in self.slots.read().expect("pool poisoned").iter() {
            if !slot.retiring.swap(true, Ordering::Relaxed) {
                tracing::info!(isolate = %slot.heap_id, slot = slot.id, "isolate retiring");
            }
        }
        self.free_retired();
    }

    /// Whether every isolate this pool ever built has been freed. True for a
    /// pool that never grew, so a generation whose scripts took no traffic
    /// drains at once.
    pub fn is_drained(&self) -> bool {
        self.slots
            .read()
            .expect("pool poisoned")
            .iter()
            .all(|slot| slot.worker.try_lock().is_ok_and(|worker| worker.is_none()))
    }

    fn retire_one(&self) -> bool {
        let Some(id) = celld_logic::isolate::retire(&self.load()) else {
            return false;
        };
        let slot = self.get(id);
        if !slot.retiring.swap(true, Ordering::Relaxed) {
            tracing::info!(isolate = %slot.heap_id, slot = id, "isolate retiring");
        }
        true
    }

    fn free_retired(&self) {
        // A retiring isolate takes no new work, so once its counters reach
        // zero nothing can enter it again and its heap can go. `try_lock`
        // rather than blocking: if a turn holds it, it is not drained and
        // this pass has nothing to do.
        for slot in self.slots.read().expect("pool poisoned").iter() {
            if !celld_logic::isolate::may_free(&slot.observe()) {
                continue;
            }
            let Ok(mut worker) = slot.worker.try_lock() else {
                continue;
            };
            if worker.take().is_some() {
                tracing::info!(isolate = %slot.heap_id, slot = slot.id, "isolate freed");
            }
        }
    }

    /// Return the current live-isolate count: those that take work, as
    /// placement and the census count them.
    pub fn live(&self) -> usize {
        self.slots
            .read()
            .expect("pool poisoned")
            .iter()
            .filter(|slot| slot.takes_work())
            .count()
    }

    /// What the pool holds right now, for `/state`.
    ///
    /// The count an operator of a hibernation-heavy node needs and could
    /// not get: a dormant cell keeps about 160 KB more than its own records
    /// explain (GCE, 2026-09-03), and the one O(cells) structure
    /// that fits is the isolate. `live_empty` is what `reap_empty` retires
    /// on its next pass and `retiring` is what `may_free` still refuses, so
    /// either staying positive across passes names the leak.
    pub fn census(&self) -> PoolCensus {
        let mut census = PoolCensus::default();
        for slot in self.slots.read().expect("pool poisoned").iter() {
            let load = slot.observe();
            census.cells += load.cells;
            census.requests += load.requests;
            census.turns += load.turns;
            // A heap is gone once its worker was taken. A worker a turn
            // holds right now is installed, so a failed `try_lock` counts
            // as a heap and never as freed; its size is unknown this pass.
            // Holding the guard is the permit a turn holds, which is what
            // makes the V8 lock inside `heap_bytes` uncontended.
            match slot.worker.try_lock() {
                Ok(worker) if worker.is_none() => {
                    census.freed += 1;
                    continue;
                }
                Ok(worker) => {
                    if let Some(heap) = worker.as_ref().and_then(js::Worker::heap_bytes) {
                        census.heap_bytes += heap.physical;
                        census.external_bytes += heap.external;
                    }
                }
                Err(_) => {}
            }
            if load.retiring {
                census.retiring += 1;
            } else {
                census.live += 1;
                if load.cells == 0 {
                    census.live_empty += 1;
                }
            }
        }
        census
    }
}

/// The property the whole design rests on: an isolate and everything hanging
/// off it can be reached from any thread, which is how a turn travels to an
/// isolate thread. This is what `v8::Locker` and
/// `Send` Globals buy (denoland/rusty_v8#2044, #2045); without them
/// `js::Worker` would not be `Send` and the pool could not exist.
///
/// A compile-time check rather than a comment, because losing it would show
/// up as a confusing error somewhere far away.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Pool>();
    assert_send_sync::<Slot>();
    assert_send_sync::<Affiliation>();
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Turns of one isolate take their lanes round robin: a lane that just
    /// ran goes behind one already waiting, and one run ends when none is.
    #[test]
    fn turns_take_their_lanes_round_robin() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let job = |name: &'static str| -> TurnJob {
            let order = order.clone();
            Box::new(move |_| order.lock().unwrap().push(name))
        };
        let cell = |name: &str| TurnLane::Cell(name.to_string());
        let mut queue = TurnQueue::default();
        assert!(
            queue.push(cell("a"), job("a1")),
            "the first turn starts a run"
        );
        assert!(!queue.push(cell("a"), job("a2")));
        assert!(!queue.push(cell("b"), job("b1")));
        assert!(!queue.push(TurnLane::Stateless, job("s1")));
        let mut worker = None;
        let mut ran = 0;
        while let Some(job) = queue.next() {
            job(&mut worker);
            ran += 1;
            if ran == 1 {
                // A hot lane keeps its place, but behind the waiting lanes.
                assert!(!queue.push(cell("a"), job_after("a3", &order)));
            }
        }
        assert_eq!(*order.lock().unwrap(), ["a1", "b1", "s1", "a2", "a3"]);
        assert!(!queue.has_waiting());
        assert!(
            queue.push(cell("b"), job("b2")),
            "an ended run starts again"
        );
    }

    /// A run that unwinds hands its slot's turns on rather than leaving them
    /// waiting on a run that is gone.
    #[test]
    fn a_run_that_unwinds_leaves_the_slot_usable() {
        let slot = Slot::vacant_for_request_cancellation_test();
        let ran = Arc::new(Mutex::new(Vec::new()));
        let job = |name: &'static str| -> TurnJob {
            let ran = ran.clone();
            Box::new(move |_| ran.lock().unwrap().push(name))
        };
        {
            let mut queue = slot.turn_queue.lock().unwrap();
            assert!(queue.push(TurnLane::Stateless, Box::new(|_| panic!("outside a catch"))));
            queue.push(TurnLane::Stateless, job("after"));
        }
        let run = slot.clone();
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            run.run_turns(RunMode::Drain)
        }));
        assert!(unwound.is_err());
        // No isolate threads: the run is over, and the next push starts one.
        assert!(!slot.worker.is_poisoned());
        assert!(!slot.turn_queue.lock().unwrap().running);
        assert!(slot
            .turn_queue
            .lock()
            .unwrap()
            .push(TurnLane::Stateless, job("next")));
        slot.clone().run_turns(RunMode::Drain);
        assert_eq!(*ran.lock().unwrap(), ["after", "next"]);
    }

    /// While event starts wait for their owner, the first turn that is not
    /// one runs: a settlement queued behind a deferred event start.
    #[test]
    fn a_settlement_passes_a_waiting_event_start() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let job = |name: &'static str| -> TurnJob {
            let order = order.clone();
            Box::new(move |_| order.lock().unwrap().push(name))
        };
        let cell = |name: &str| TurnLane::Cell(name.to_string());
        let mut queue = TurnQueue::default();
        queue.push_turn(cell("a"), true, job("a-start"));
        queue.push_turn(cell("a"), false, job("a-settle"));
        queue.push_turn(cell("b"), true, job("b-start"));
        queue.push_turn(TurnLane::Stateless, false, job("s-cancel"));
        assert!(queue.next_starts_event());
        let mut worker = None;
        queue.next_skipping_events().unwrap()(&mut worker);
        queue.next_skipping_events().unwrap()(&mut worker);
        // Only event starts are left: the queue keeps them, and its run.
        assert!(queue.next_skipping_events().is_none());
        assert!(queue.has_waiting());
        assert!(queue.running);
        // Once the owner may run them, they run round robin: `a` ran last.
        while let Some(job) = queue.next() {
            job(&mut worker);
        }
        assert_eq!(
            *order.lock().unwrap(),
            ["a-settle", "s-cancel", "b-start", "a-start"]
        );
    }

    /// A request that only its sockets keep gives its admission slot back
    /// while the node's bound has room, and keeps it past the bound. The
    /// bound is the node's: a slot of another pool, or a Worker Loader's,
    /// counts against the same one.
    #[test]
    fn a_request_its_sockets_keep_leaves_admission_within_the_bound() {
        let node = Arc::new(SocketRequests::new(2));
        let slot = Slot::vacant_for_test(node.clone(), Arc::default());
        let other = Slot::vacant_for_test(node.clone(), Arc::default());
        let held = |slot: &Slot| {
            let load = slot.observe();
            (load.requests, load.sockets)
        };
        let first = slot.affiliate();
        let second = slot.affiliate();
        let elsewhere = other.affiliate();
        assert!(first.hold_for_sockets());
        assert!(first.hold_for_sockets(), "a second call holds nothing more");
        assert!(elsewhere.hold_for_sockets());
        assert!(!second.hold_for_sockets(), "past the node's bound");
        assert_eq!(held(&slot), (2, 1));
        assert_eq!(held(&other), (1, 1));
        drop(elsewhere);
        assert!(second.hold_for_sockets(), "the bound has room again");
        assert_eq!(held(&slot), (2, 2));
        drop(first);
        drop(second);
        assert_eq!(held(&slot), (0, 0));
        assert_eq!(node.held.load(Ordering::Relaxed), 0);
    }

    /// A slot that shares another's generation, as a Worker Loader's shares
    /// its loader's, retires with it, at the instant the generation retired
    /// rather than when a request first looks.
    #[test]
    fn a_shared_generation_retires_at_its_own_instant() {
        let loader = Slot::vacant_for_request_cancellation_test();
        let loaded = Slot::vacant_for_test(Arc::new(SocketRequests::new(1)), loader.generation());
        assert_eq!(loaded.generation_retired_for(), None);
        loader.generation.retire();
        let wait = std::time::Duration::from_millis(20);
        std::thread::sleep(wait);
        loader.generation.retire();
        let retired_for = loaded.generation_retired_for().expect("retired");
        assert!(retired_for >= wait, "the first retirement counts");
    }

    /// Retiring a pool's generation wakes the requests its sockets keep.
    #[test]
    fn a_retired_generation_wakes_its_slots() {
        let slot = Slot::vacant_for_request_cancellation_test();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let retired = slot.until_generation_retired();
            tokio::pin!(retired);
            let wait = std::time::Duration::from_millis(10);
            assert!(tokio::time::timeout(wait, retired.as_mut()).await.is_err());
            assert_eq!(slot.generation_retired_for(), None);
            slot.generation.retire();
            retired.await;
            assert!(slot.generation_retired_for().is_some());
            // Once retired, it answers at once.
            slot.until_generation_retired().await;
        });
    }

    fn job_after(name: &'static str, order: &Arc<Mutex<Vec<&'static str>>>) -> TurnJob {
        let order = order.clone();
        Box::new(move |_| order.lock().unwrap().push(name))
    }

    /// A script at its cap is refused before placement looks at an isolate,
    /// with the CPU limit's error: a stateless request, and a cell.
    #[test]
    fn a_script_at_its_cap_is_refused_at_once() {
        let pool = Pool::new(
            crate::runtime::pool_limits(),
            std::time::Duration::from_millis(1),
            || anyhow::bail!("a capped script builds nothing"),
        )
        .for_script("a-script-at-its-cap");
        let owner = pool.owner.clone().unwrap();
        owner.set_stuck_for_test(crate::turn_owner::STUCK_PER_OWNER);
        match pool.admit(false) {
            Err(AdmitError::Stuck(StuckRefusal::Owner)) => {}
            other => panic!("admitted past the cap: {:?}", other.err()),
        }
        let refused = pool.place_cell().err().expect("a cell is refused");
        assert_eq!(
            refused.downcast_ref::<StuckRefusal>(),
            Some(&StuckRefusal::Owner)
        );
        assert_eq!(refused.to_string(), crate::js::CPU_EXCEEDED);
        assert!(pool.is_empty());
        // Another pool of the same script shares the count.
        let cells = Pool::new(
            crate::runtime::pool_limits(),
            std::time::Duration::from_millis(1),
            || anyhow::bail!("a capped script builds nothing"),
        )
        .for_script("a-script-at-its-cap");
        assert!(cells.place_cell().err().unwrap().is::<StuckRefusal>());
        owner.set_stuck_for_test(0);
        assert!(matches!(pool.admit(false), Err(AdmitError::Build(_))));
    }

    /// A Worker that does not load fails its placement with the load's own
    /// error, typed, so only that error reaches a caller as a startup error.
    #[test]
    fn a_failed_build_is_a_worker_load_failure() {
        let pool = Pool::new(
            crate::runtime::pool_limits(),
            std::time::Duration::from_millis(1),
            || Err(anyhow::anyhow!("internal detail").context("Uncaught Error: never starts")),
        );
        let error = pool.place_cell().err().expect("the build fails");
        let load = error
            .downcast_ref::<WorkerLoadFailed>()
            .expect("a load failure");
        assert_eq!(load.0.to_string(), "Uncaught Error: never starts");
        assert_eq!(error.to_string(), "Uncaught Error: never starts");
    }
}
