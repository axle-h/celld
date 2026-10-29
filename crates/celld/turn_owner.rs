// Copyright 2026 Deno Land Inc. Apache-2.0 license.

// Turn accounting is in the V8 arm outside the Actor execution domain: it
// reads the monotonic clock to tell a long turn from a short one.
#![allow(clippy::disallowed_methods)]

//! Who a turn belongs to, and what that owner may still start (plan 1.61).
//!
//! An **owner** is a script: its stateless and cell pools, across
//! generations, and every Dynamic Worker it loads. A Dynamic Worker counts
//! against the script that loaded it, since that script chose its code and
//! its ids.
//!
//! A turn is **stuck** once the CPU watchdog has asked it to stop and it has
//! not, a retry later ([`TurnMark::fired`]): it runs on in something that
//! does not stop for a termination, holding an isolate thread and its heap.
//! This is counted when the watchdog first finds the turn still running past
//! its limit, not at the condemnation grace, so a long `cpu_ms` cannot hide
//! one for minutes.
//!
//! - An owner with [`STUCK_PER_OWNER`] stuck turns starts no new event: its
//!   requests, Dynamic Worker calls and Durable Object events fail at once
//!   with the CPU limit's error, and none of its isolates grows or is placed.
//! - At the node-wide count ([`stuck_node_cap`]), an owner that already has a
//!   stuck turn grows no isolate. Owners with none grow as before: the node
//!   cap bounds the threads and heaps stuck turns hold, not other tenants.
//!   `crate::isolate_threads` also has a hard ceiling on its threads.
//! - **Long turns**: while an owner has a turn that has run for
//!   [`crate::isolate_threads::LONG_TURN`], it runs at most [`long_share`]
//!   turns at once; the rest wait behind its own, so a tenant with long turns
//!   cannot take every isolate thread from the others.

use std::collections::VecDeque;
use std::sync::atomic::AtomicIsize;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::time::Instant;

/// The stuck turns one owner may have before it starts no new event.
pub(crate) const STUCK_PER_OWNER: usize = 2;

/// Stuck turns node-wide. Signed: a turn can return between the watchdog's
/// mark and its count, so a count can be -1 for an instant, which reads as 0.
static STUCK_TOTAL: AtomicIsize = AtomicIsize::new(0);

/// Every owner, by script. Weak, so a script whose pools and slots are gone
/// leaves no entry once the next one is made.
static OWNERS: OnceLock<Mutex<std::collections::HashMap<Arc<str>, Weak<Owner>>>> = OnceLock::new();

/// When this process started, the clock turn start times are read against.
fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

fn now_us() -> u64 {
    epoch().elapsed().as_micros() as u64
}

/// One script's turns, shared by its pools, slots and Dynamic Workers.
pub(crate) struct Owner {
    script: Arc<str>,
    stuck: AtomicIsize,
    /// Its turns running now.
    running: AtomicUsize,
    /// The presences of its slots, to find a long turn among them.
    presences: Mutex<Vec<Weak<Presence>>>,
    /// Runs of its slots' turns that wait for its long turns
    /// ([`Owner::must_wait`]).
    deferred: Mutex<VecDeque<Box<dyn FnOnce() + Send>>>,
    deferred_len: AtomicUsize,
    /// The node-wide count: [`STUCK_TOTAL`], or a test's own.
    total: &'static AtomicIsize,
}

impl std::fmt::Debug for Owner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Owner")
            .field("script", &self.script)
            .field("stuck", &self.stuck_turns())
            .finish_non_exhaustive()
    }
}

/// The owner `script`, made on first use.
pub(crate) fn owner(script: &str) -> Arc<Owner> {
    let mut owners = OWNERS
        .get_or_init(Default::default)
        .lock()
        .expect("owner registry poisoned");
    if let Some(owner) = owners.get(script).and_then(Weak::upgrade) {
        return owner;
    }
    owners.retain(|_, owner| owner.strong_count() > 0);
    let owner = Arc::new(Owner::new(Arc::from(script), &STUCK_TOTAL));
    owners.insert(owner.script.clone(), Arc::downgrade(&owner));
    owner
}

impl Owner {
    fn new(script: Arc<str>, total: &'static AtomicIsize) -> Self {
        Self {
            script,
            stuck: AtomicIsize::new(0),
            running: AtomicUsize::new(0),
            presences: Mutex::new(Vec::new()),
            deferred: Mutex::new(VecDeque::new()),
            deferred_len: AtomicUsize::new(0),
            total,
        }
    }

    #[cfg(test)]
    pub(crate) fn set_stuck_for_test(&self, stuck: usize) {
        self.stuck.store(stuck as isize, Ordering::SeqCst);
    }

    pub(crate) fn stuck_turns(&self) -> usize {
        self.stuck.load(Ordering::SeqCst).max(0) as usize
    }

    /// The presence of a new slot of this owner.
    pub(crate) fn presence(self: &Arc<Self>) -> Arc<Presence> {
        let presence = Arc::new(Presence::new(Some(self.clone())));
        let mut presences = self.presences.lock().expect("owner poisoned");
        presences.retain(|presence| presence.strong_count() > 0);
        presences.push(Arc::downgrade(&presence));
        presence
    }

    /// Whether a new event of this owner waits: it runs [`long_share`] turns
    /// already, one of them long. Stuck turns count for neither: their
    /// threads are the stuck caps' business, and an owner at its cap must
    /// reach the refusal at once rather than wait.
    pub(crate) fn must_wait(&self) -> bool {
        let stuck = self.stuck_turns();
        if stuck >= STUCK_PER_OWNER {
            return false;
        }
        if self.running.load(Ordering::SeqCst).saturating_sub(stuck) < long_share() {
            return false;
        }
        self.has_long_turn()
    }

    /// Whether a turn of this owner, not stuck, has run for
    /// [`crate::isolate_threads::LONG_TURN`].
    fn has_long_turn(&self) -> bool {
        let now = now_us();
        let long = crate::isolate_threads::LONG_TURN.as_micros() as u64;
        self.presences
            .lock()
            .expect("owner poisoned")
            .iter()
            .filter_map(Weak::upgrade)
            .any(|presence| {
                presence.turn.load(Ordering::SeqCst) != 0
                    && !presence.is_stuck()
                    && now.saturating_sub(presence.started_us.load(Ordering::SeqCst)) >= long
            })
    }

    /// Whether this owner has no stuck or long turn: it may use the isolate
    /// threads kept for such owners (`crate::isolate_threads`).
    pub(crate) fn is_clean(&self) -> bool {
        self.stuck_turns() == 0 && !self.has_long_turn()
    }

    /// Hold `resume`, a run of a slot's turns, until one of this owner's
    /// turns ends. Runs it at once if it need not wait after all.
    pub(crate) fn defer(&self, resume: Box<dyn FnOnce() + Send>) {
        self.deferred
            .lock()
            .expect("owner poisoned")
            .push_back(resume);
        self.deferred_len.fetch_add(1, Ordering::SeqCst);
        // A turn that ended between the check and the push saw nothing to
        // resume; look again now that it is queued.
        self.resume_one();
    }

    /// Start one deferred run, if any waits and this owner may run it.
    fn resume_one(&self) {
        if self.deferred_len.load(Ordering::SeqCst) == 0 || self.must_wait() {
            return;
        }
        let resume = {
            let mut deferred = self.deferred.lock().expect("owner poisoned");
            let resume = deferred.pop_front();
            if resume.is_some() {
                self.deferred_len.fetch_sub(1, Ordering::SeqCst);
            }
            resume
        };
        if let (Some(resume), Some(threads)) = (resume, crate::isolate_threads::installed()) {
            threads.submit_for(resume, None, Some(self));
        }
    }

    fn count_stuck(&self, stuck: bool) {
        for counter in [self.total, &self.stuck] {
            if stuck {
                counter.fetch_add(1, Ordering::SeqCst);
            } else {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

/// At most this many turns of one owner run at once while one of them is
/// long: half the isolate threads, and at least 1.
pub(crate) fn long_share() -> usize {
    (core() / 2).max(1)
}

fn core() -> usize {
    crate::isolate_threads::installed()
        .map(crate::isolate_threads::IsolateThreads::core)
        .unwrap_or_else(crate::isolate_threads::default_core)
}

/// Stuck turns on the node now.
pub fn stuck_isolates() -> usize {
    STUCK_TOTAL.load(Ordering::SeqCst).max(0) as usize
}

/// The node-wide count of stuck turns past which an owner that already has
/// one grows no isolate: half the isolate threads, and at least
/// [`STUCK_PER_OWNER`] + 1, so that one owner at its own cap never reaches it.
pub fn stuck_node_cap() -> usize {
    (core() / 2).max(STUCK_PER_OWNER + 1)
}

/// Why an owner was refused because of stuck turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StuckRefusal {
    /// The owner has [`STUCK_PER_OWNER`] stuck turns: its events fail with
    /// the CPU limit's error.
    Owner,
    /// The node has [`stuck_node_cap`] of them, this owner among them: it
    /// grows no isolate.
    Node(usize),
}

impl std::fmt::Display for StuckRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StuckRefusal::Owner => formatter.write_str(crate::js::CPU_EXCEEDED),
            StuckRefusal::Node(count) => write!(
                formatter,
                "node has {count} isolates stuck past their CPU limit, this Worker's among them, \
                 and starts no more for it"
            ),
        }
    }
}

impl std::error::Error for StuckRefusal {}

/// The refusal for an owner with `stuck` stuck turns, before an event
/// starts (`growing` false) or before an isolate grows (`growing` true).
pub(crate) fn stuck_refusal(
    stuck: usize,
    growing: bool,
    total: usize,
    node_cap: usize,
) -> Option<StuckRefusal> {
    if stuck >= STUCK_PER_OWNER {
        return Some(StuckRefusal::Owner);
    }
    (growing && stuck > 0 && total >= node_cap).then_some(StuckRefusal::Node(total))
}

/// The refusal `owner` gets now, if any.
pub(crate) fn refusal_for(owner: Option<&Owner>, growing: bool) -> Option<StuckRefusal> {
    let owner = owner?;
    stuck_refusal(
        owner.stuck_turns(),
        growing,
        stuck_isolates(),
        stuck_node_cap(),
    )
}

/// The stuck turns, for `/state`.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StuckCensus {
    pub total: usize,
    pub node_cap: usize,
    pub owner_cap: usize,
    /// The most turns an owner runs at once while one is long.
    pub long_share: usize,
    /// The owners with stuck turns, and how many each has.
    pub owners: std::collections::BTreeMap<String, usize>,
}

pub fn stuck_census() -> StuckCensus {
    let owners = OWNERS
        .get()
        .map(|owners| {
            owners
                .lock()
                .expect("owner registry poisoned")
                .values()
                .filter_map(Weak::upgrade)
                .map(|owner| (owner.script.to_string(), owner.stuck_turns()))
                .filter(|(_, count)| *count > 0)
                .collect()
        })
        .unwrap_or_default();
    StuckCensus {
        total: stuck_isolates(),
        node_cap: stuck_node_cap(),
        owner_cap: STUCK_PER_OWNER,
        long_share: long_share(),
        owners,
    }
}

/// One slot's turns: which runs now, since when, and which is stuck.
#[derive(Debug)]
pub(crate) struct Presence {
    /// The running turn's sequence number, 0 between turns.
    turn: AtomicU64,
    /// The turn counted stuck, 0 for none.
    stuck: AtomicU64,
    /// The last turn's number, so a watchdog's mark names one turn of this
    /// slot (one runs at a time).
    turns: AtomicU64,
    started_us: AtomicU64,
    owner: Option<Arc<Owner>>,
}

thread_local! {
    /// The turn this thread runs, for the CPU watchdog to mark.
    static CURRENT_TURN: std::cell::RefCell<Option<TurnMark>> =
        const { std::cell::RefCell::new(None) };
}

/// A turn as the watchdog holds it: its slot's presence and its number.
#[derive(Clone, Debug)]
pub(crate) struct TurnMark {
    presence: Arc<Presence>,
    turn: u64,
    /// Its owner was at its cap when the turn began: it starts no event.
    refused: bool,
}

/// The turn this thread runs now, if any.
pub(crate) fn current_turn() -> Option<TurnMark> {
    CURRENT_TURN.with_borrow(Clone::clone)
}

/// Whether the turn this thread runs must start no new event: its owner has
/// [`STUCK_PER_OWNER`] stuck turns. The event fails with the CPU limit's
/// error instead; events already running go on.
pub(crate) fn turn_refused() -> bool {
    CURRENT_TURN.with_borrow(|turn| turn.as_ref().is_some_and(|turn| turn.refused))
}

/// A running turn; dropping it ends the turn.
pub(crate) struct Entered {
    presence: Arc<Presence>,
    previous: Option<TurnMark>,
}

impl Drop for Entered {
    fn drop(&mut self) {
        CURRENT_TURN.set(self.previous.take());
        self.presence.leave();
    }
}

impl Presence {
    pub(crate) fn new(owner: Option<Arc<Owner>>) -> Self {
        Self {
            turn: AtomicU64::new(0),
            stuck: AtomicU64::new(0),
            turns: AtomicU64::new(0),
            started_us: AtomicU64::new(0),
            owner,
        }
    }

    /// Whether the running turn is stuck.
    pub(crate) fn is_stuck(&self) -> bool {
        self.stuck.load(Ordering::SeqCst) != 0
    }

    pub(crate) fn owner(&self) -> Option<&Arc<Owner>> {
        self.owner.as_ref()
    }

    /// Start a turn, marked for the watchdog until the guard drops.
    pub(crate) fn enter(self: &Arc<Self>) -> Entered {
        // One turn of a slot runs at a time, so this needs no read-modify-write
        // shared with other slots.
        let turn = self.turns.load(Ordering::Relaxed) + 1;
        self.turns.store(turn, Ordering::Relaxed);
        self.started_us.store(now_us(), Ordering::SeqCst);
        self.turn.store(turn, Ordering::SeqCst);
        if let Some(owner) = &self.owner {
            owner.running.fetch_add(1, Ordering::SeqCst);
        }
        let refused = self
            .owner
            .as_ref()
            .is_some_and(|owner| owner.stuck_turns() >= STUCK_PER_OWNER);
        let previous = CURRENT_TURN.replace(Some(TurnMark {
            presence: self.clone(),
            turn,
            refused,
        }));
        Entered {
            presence: self.clone(),
            previous,
        }
    }

    fn leave(&self) {
        self.turn.store(0, Ordering::SeqCst);
        if self.stuck.swap(0, Ordering::SeqCst) != 0 {
            if let Some(owner) = &self.owner {
                owner.count_stuck(false);
            }
        }
        if let Some(owner) = &self.owner {
            owner.running.fetch_sub(1, Ordering::SeqCst);
            owner.resume_one();
        }
    }
}

impl TurnMark {
    /// The watchdog asked this turn to stop a retry ago, and it still runs:
    /// count it stuck until it returns. Called on the watchdog's thread;
    /// idempotent, and nothing if the turn has returned.
    pub(crate) fn fired(&self) {
        let presence = &self.presence;
        let Some(owner) = &presence.owner else {
            return;
        };
        if presence.turn.load(Ordering::SeqCst) != self.turn {
            return;
        }
        if presence
            .stuck
            .compare_exchange(0, self.turn, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        owner.count_stuck(true);
        // The turn returned between the check and the mark, and its `leave`
        // saw nothing to count down: take the mark back, unless a `leave`
        // already did.
        if presence.turn.load(Ordering::SeqCst) != self.turn
            && presence
                .stuck
                .compare_exchange(self.turn, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            owner.count_stuck(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_owner(total: &'static AtomicIsize) -> Arc<Owner> {
        Arc::new(Owner::new(Arc::from("test-owner"), total))
    }

    #[test]
    fn the_caps_refuse_an_owner_then_only_its_growth() {
        assert_eq!(stuck_refusal(0, true, 1, 3), None);
        assert_eq!(stuck_refusal(1, false, 3, 3), None);
        assert_eq!(stuck_refusal(2, false, 0, 3), Some(StuckRefusal::Owner));
        assert_eq!(stuck_refusal(2, true, 0, 3), Some(StuckRefusal::Owner));
        // At the node's cap only an owner with a stuck turn stops growing.
        assert_eq!(stuck_refusal(1, true, 3, 3), Some(StuckRefusal::Node(3)));
        assert_eq!(stuck_refusal(0, true, 30, 3), None);
        // One owner at its own cap never reaches the node's.
        assert!(stuck_node_cap() > STUCK_PER_OWNER);
        assert_eq!(StuckRefusal::Owner.to_string(), crate::js::CPU_EXCEEDED);
        assert!(long_share() >= 1);
    }

    /// A turn counts stuck from the watchdog's mark until it returns, once,
    /// and a mark for a turn that has returned counts nothing.
    #[test]
    fn a_marked_turn_counts_until_it_returns() {
        static TOTAL: AtomicIsize = AtomicIsize::new(0);
        let owner = test_owner(&TOTAL);
        let presence = owner.presence();
        let entered = presence.enter();
        let mark = current_turn().expect("a turn is running");
        assert_eq!(owner.running.load(Ordering::SeqCst), 1);
        mark.fired();
        mark.fired();
        assert_eq!((owner.stuck_turns(), TOTAL.load(Ordering::SeqCst)), (1, 1));
        drop(entered);
        assert!(current_turn().is_none());
        assert_eq!((owner.stuck_turns(), TOTAL.load(Ordering::SeqCst)), (0, 0));
        assert_eq!(owner.running.load(Ordering::SeqCst), 0);
        // A late mark for the turn that returned, or one for an earlier
        // turn once the next has begun, counts nothing.
        mark.fired();
        let next = presence.enter();
        mark.fired();
        assert_eq!(owner.stuck_turns(), 0);
        drop(next);
        assert_eq!(TOTAL.load(Ordering::SeqCst), 0);
    }

    /// Marks and returns racing on many threads leave every count at zero.
    #[test]
    fn racing_marks_balance() {
        static TOTAL: AtomicIsize = AtomicIsize::new(0);
        let owner = test_owner(&TOTAL);
        let presence = owner.presence();
        let marks = Arc::new(Mutex::new(Vec::<TurnMark>::new()));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let marker = {
            let (marks, stop) = (marks.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let latest = marks.lock().unwrap().last().cloned();
                    if let Some(mark) = latest {
                        mark.fired();
                    }
                }
            })
        };
        for _ in 0..20_000 {
            let entered = presence.enter();
            marks.lock().unwrap().push(current_turn().unwrap());
            drop(entered);
            marks.lock().unwrap().clear();
        }
        stop.store(true, Ordering::SeqCst);
        marker.join().unwrap();
        assert_eq!(owner.stuck_turns(), 0);
        assert_eq!(TOTAL.load(Ordering::SeqCst), 0);
    }

    /// While one of its turns is long, an owner past its share waits.
    #[test]
    fn an_owner_with_a_long_turn_waits_past_its_share() {
        static TOTAL: AtomicIsize = AtomicIsize::new(0);
        let owner = test_owner(&TOTAL);
        let share = long_share();
        let presences: Vec<_> = (0..share).map(|_| owner.presence()).collect();
        let entered: Vec<_> = presences.iter().map(|presence| presence.enter()).collect();
        assert!(!owner.must_wait(), "no turn is long yet");
        presences[0].started_us.store(0, Ordering::SeqCst);
        std::thread::sleep(crate::isolate_threads::LONG_TURN);
        assert!(owner.must_wait());
        drop(entered);
        assert!(!owner.must_wait());
    }

    /// Stuck turns count neither as running nor as long for the share, and
    /// an owner at its cap never waits: its events must reach the refusal.
    #[test]
    fn stuck_turns_take_no_share() {
        static TOTAL: AtomicIsize = AtomicIsize::new(0);
        let owner = test_owner(&TOTAL);
        let share = long_share();
        let presences: Vec<_> = (0..share).map(|_| owner.presence()).collect();
        let entered: Vec<_> = presences.iter().map(|presence| presence.enter()).collect();
        for presence in &presences {
            presence.started_us.store(0, Ordering::SeqCst);
        }
        std::thread::sleep(crate::isolate_threads::LONG_TURN);
        assert!(owner.must_wait());
        // The long turn is stuck: it holds no share.
        CURRENT_TURN
            .with_borrow(|turn| turn.clone())
            .unwrap()
            .fired();
        assert_eq!(owner.stuck_turns(), 1);
        assert!(!owner.must_wait());
        // At the cap the owner never waits.
        owner.set_stuck_for_test(STUCK_PER_OWNER);
        assert!(!owner.must_wait());
        owner.set_stuck_for_test(1);
        drop(entered);
        assert_eq!(TOTAL.load(Ordering::SeqCst), 0);
        assert_eq!(owner.stuck_turns(), 0);
        assert!(owner.is_clean());
    }
}
