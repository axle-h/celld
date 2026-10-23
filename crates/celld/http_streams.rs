// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The HTTP stream registry: request and response bodies that cross the host
//! boundary by id rather than by value. Engine-neutral; `crate::js`
//! re-exports every item at its old path.
use crate::asyncrt;
use crate::engine_api::HttpChunkStream;
use crate::engine_api::HttpResponse;
use crate::engine_api::HttpResponseWebSocket;
use crate::engine_api::RequestBody;
use crate::ws_registry::WsOwner;
use anyhow::Result;
use futures_util::StreamExt as _;
use std::collections::HashMap;
use std::pin::Pin;
#[cfg(all(test, celld_internal_tests))]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

// Keep IDs process-global. A counter in each Domain could reuse an ID from a
// closed Domain, so a stale caller could read an unrelated new stream.
pub(crate) static NEXT_HTTP_STREAM_ID: AtomicU64 = AtomicU64::new(1);
/// What `__http_stream_read` resolves with at end of stream.
///
/// The reader identifies the end by type, not by value. A chunk always
/// resolves as a `Uint8Array`, therefore body bytes can never look like
/// this marker. The value stays distinctive, so a reader that does compare
/// the value cannot match a plausible body.
pub(crate) const HTTP_STREAM_DONE: &str = "__celld_http_stream_end__";
pub(crate) const HTTP_STREAM_IDLE_TIMEOUT_MS: u64 = 60_000;
pub(crate) const HTTP_STREAM_REGISTRATION_CLOSED: &str = "the HTTP stream service is closed";
pub(crate) const HTTP_TEE_BRANCH_CAPACITY: usize = 16;
const RESPONSE_STREAM_CONSUMER_CANCELED: &str = "response stream consumer canceled";
const RESPONSE_STREAM_CLOSE_IN_PROGRESS: &str = "response stream close is already in progress";
/// workerd's error for a body used by code other than the request or Durable
/// Object that owns it: worded for a Durable Object when one uses another's.
/// The harness refuses with it first; the host refuses with it too, for an id
/// that reaches an op some other way.
pub(crate) fn foreign_stream_error(object: bool) -> String {
    crate::ws_registry::foreign_io_error(object, "ReadableStreamSource")
}
pub(crate) enum HttpStreamSource {
    Response(reqwest::Response),
    Receiver(tokio::sync::mpsc::Receiver<Result<Vec<u8>, String>>),
    Stream(HttpChunkStream),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(crate) enum HttpStreamTerminationReason {
    Live = 0,
    Finished = 1,
    Cancelled = 2,
    Expired = 3,
}

impl HttpStreamTerminationReason {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Live,
            1 => Self::Finished,
            2 => Self::Cancelled,
            3 => Self::Expired,
            _ => unreachable!("invalid HTTP stream termination reason {value}"),
        }
    }
}

pub(crate) struct HttpStreamTermination {
    reason: AtomicU8,
    waiter: futures_util::task::AtomicWaker,
}

impl HttpStreamTermination {
    fn new() -> Self {
        Self {
            reason: AtomicU8::new(HttpStreamTerminationReason::Live as u8),
            waiter: futures_util::task::AtomicWaker::new(),
        }
    }

    pub(crate) fn reason(&self) -> HttpStreamTerminationReason {
        HttpStreamTerminationReason::from_u8(self.reason.load(Ordering::Acquire))
    }

    /// Commit the reason while the registry lock still linearizes removal.
    /// Waking is a separate operation because a waker can run arbitrary code.
    fn commit(&self, reason: HttpStreamTerminationReason) {
        let _ = self.reason.compare_exchange(
            HttpStreamTerminationReason::Live as u8,
            reason as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub(crate) fn poll_reason(
        &self,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<HttpStreamTerminationReason> {
        let reason = self.reason();
        if reason != HttpStreamTerminationReason::Live {
            return std::task::Poll::Ready(reason);
        }
        self.waiter.register(context.waker());
        let reason = self.reason();
        if reason == HttpStreamTerminationReason::Live {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(reason)
        }
    }

    fn take_waiter(&self) -> Option<std::task::Waker> {
        self.waiter.take()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HttpSourceLeaseMode {
    Pull,
    Transfer,
}

/// What the running code may do with a stream id.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HttpStreamAccess {
    /// The running code owns the stream.
    Owned,
    /// The id names no registered stream: it finished, expired or was
    /// never allocated. The ops answer it as they always have.
    Unknown,
    /// Another request or Durable Object owns the stream, or none does yet.
    /// `object` when a Durable Object owns it and one is asking.
    Other { object: bool },
}

impl HttpStreamAccess {
    /// workerd's error for a use the running code may not make.
    pub(crate) fn refusal(self) -> Option<String> {
        match self {
            Self::Other { object } => Some(foreign_stream_error(object)),
            Self::Owned | Self::Unknown => None,
        }
    }
}

enum HttpStreamSourceSlot {
    Available(HttpStreamSource),
    Leased {
        token: u64,
        mode: HttpSourceLeaseMode,
    },
}

pub(crate) struct HttpStreamEntry {
    generation: u64,
    deadline_ms: u64,
    source: HttpStreamSourceSlot,
    pub(crate) termination: Arc<HttpStreamTermination>,
    /// Request contexts that can still read this source. A dispatch guard can
    /// reclaim the entry only while this is zero.
    owners: usize,
    /// The request or Durable Object whose code may use this id, as for a
    /// socket (`WsOwner`). `None` until the host hands the id to one: an
    /// incoming body before its handler claims it, or a host-only stream.
    /// The ops refuse every other caller.
    owner: Option<WsOwner>,
    active_writes: usize,
    active_closes: usize,
    closing: bool,
}

pub(crate) struct ResponseStreamWriter {
    writer: tokio::sync::mpsc::Sender<Result<Vec<u8>, String>>,
    finished: tokio::sync::watch::Sender<bool>,
}

impl HttpStreamEntry {
    pub(crate) fn new(generation: u64, deadline_ms: u64, source: HttpStreamSource) -> Self {
        Self {
            generation,
            deadline_ms,
            source: HttpStreamSourceSlot::Available(source),
            termination: Arc::new(HttpStreamTermination::new()),
            owners: 0,
            owner: None,
            active_writes: 0,
            active_closes: 0,
            closing: false,
        }
    }

    fn is_expiry_eligible(&self) -> bool {
        matches!(self.source, HttpStreamSourceSlot::Available(_))
            && self.owners == 0
            && self.active_writes == 0
            && self.active_closes == 0
    }

    fn is_due(&self, now_ms: u64) -> bool {
        self.is_expiry_eligible() && now_ms >= self.deadline_ms
    }
}

impl ResponseStreamWriter {
    pub(crate) fn new(
        writer: tokio::sync::mpsc::Sender<Result<Vec<u8>, String>>,
        finished: tokio::sync::watch::Sender<bool>,
    ) -> Self {
        Self { writer, finished }
    }
}

type ResponseStreamCloseWatch = (
    tokio::sync::mpsc::Sender<Result<Vec<u8>, String>>,
    tokio::sync::watch::Receiver<bool>,
);

pub(crate) struct HttpStreamState {
    closed: bool,
    next_generation: u64,
    next_token: u64,
    sweeper_running: bool,
    pub(crate) sources: HashMap<u64, HttpStreamEntry>,
    pub(crate) response_writers: HashMap<u64, ResponseStreamWriter>,
    #[cfg(all(test, celld_internal_tests))]
    sweeper_starts: u64,
    #[cfg(all(test, celld_internal_tests))]
    sweeper_active: usize,
    #[cfg(all(test, celld_internal_tests))]
    sweeper_exit_gate: Option<Arc<HttpSweeperExitGate>>,
    #[cfg(all(test, celld_internal_tests))]
    pull_completion_gate: Option<HttpPullCompletionGate>,
}

pub(crate) struct HttpStreamService {
    pub(crate) state: std::sync::Mutex<HttpStreamState>,
    sweeper_notify: Arc<tokio::sync::Notify>,
    owner: OnceLock<asyncrt::DomainToken>,
    #[cfg(all(test, celld_internal_tests))]
    registration_clock_reads: AtomicU64,
}

#[cfg(all(test, celld_internal_tests))]
struct HttpPullCompletionGate {
    stream_id: u64,
    reached: std::sync::mpsc::SyncSender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(all(test, celld_internal_tests))]
impl HttpPullCompletionGate {
    fn pause(self) {
        if self.reached.send(()).is_ok() {
            let _ = self.release.recv();
        }
    }
}

#[cfg(all(test, celld_internal_tests))]
pub(crate) struct HttpSweeperExitGate {
    pub(crate) reached: AtomicBool,
    released: AtomicBool,
    waiter: futures_util::task::AtomicWaker,
}

#[cfg(all(test, celld_internal_tests))]
impl HttpSweeperExitGate {
    fn new() -> Self {
        Self {
            reached: AtomicBool::new(false),
            released: AtomicBool::new(false),
            waiter: futures_util::task::AtomicWaker::new(),
        }
    }

    async fn wait(self: Arc<Self>) {
        self.reached.store(true, Ordering::Release);
        futures_util::future::poll_fn(|context| {
            if self.released.load(Ordering::Acquire) {
                return std::task::Poll::Ready(());
            }
            self.waiter.register(context.waker());
            if self.released.load(Ordering::Acquire) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        })
        .await;
    }

    pub(crate) fn release(&self) {
        self.released.store(true, Ordering::Release);
        self.waiter.wake();
    }
}

#[cfg(all(test, celld_internal_tests))]
struct HttpSweeperRunGuard {
    service: Weak<HttpStreamService>,
}

struct HttpSweeperOwnerGuard {
    service: Weak<HttpStreamService>,
    armed: bool,
}

impl HttpSweeperOwnerGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for HttpSweeperOwnerGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(service) = self.service.upgrade() {
                service.owner_lost();
            }
        }
    }
}

#[cfg(all(test, celld_internal_tests))]
impl Drop for HttpSweeperRunGuard {
    fn drop(&mut self) {
        if let Some(service) = self.service.upgrade() {
            let mut state = service.state.lock().unwrap();
            state.sweeper_active = state.sweeper_active.saturating_sub(1);
        }
    }
}

#[derive(Default)]
struct HttpStreamDrain {
    sources: Vec<(u64, HttpStreamEntry)>,
    detached_sources: Vec<(u64, HttpStreamSource)>,
    response_writers: Vec<(u64, ResponseStreamWriter)>,
}

impl HttpStreamDrain {
    fn dispose(mut self, propagate_panic: bool) {
        // A source destructor can panic. HashMap drain order can change across
        // processes, so ID order makes wakes and the retained panic replayable.
        self.sources.sort_unstable_by_key(|(id, _)| *id);
        self.detached_sources.sort_unstable_by_key(|(id, _)| *id);
        self.response_writers.sort_unstable_by_key(|(id, _)| *id);
        let mut first_panic = None;
        for (_, source) in self.sources {
            if let Some(waiter) = source.termination.take_waiter() {
                let wake = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    waiter.wake_by_ref();
                }));
                if wake.is_err() {
                    // A waker destructor can also panic. Preserve the wake
                    // failure and leak this exceptional handle so cleanup can
                    // continue without a double panic.
                    std::mem::forget(waiter);
                } else {
                    let drop_waiter =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(waiter)));
                    retain_first_http_cleanup_panic(&mut first_panic, drop_waiter);
                }
                retain_first_http_cleanup_panic(&mut first_panic, wake);
            }
            let disposal = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(source)));
            retain_first_http_cleanup_panic(&mut first_panic, disposal);
        }
        for (_, source) in self.detached_sources {
            let disposal = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(source)));
            retain_first_http_cleanup_panic(&mut first_panic, disposal);
        }
        for (_, writer) in self.response_writers {
            let disposal = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(writer)));
            retain_first_http_cleanup_panic(&mut first_panic, disposal);
        }
        if let Some(payload) = first_panic {
            if propagate_panic {
                std::panic::resume_unwind(payload);
            }
            std::mem::forget(payload);
        }
    }

    fn dispose_propagating(self) {
        self.dispose(true);
    }

    fn dispose_suppressing(self) {
        self.dispose(false);
    }
}

pub(crate) fn retain_first_http_cleanup_panic(
    first: &mut Option<Box<dyn std::any::Any + Send>>,
    result: std::thread::Result<()>,
) {
    if let Err(payload) = result {
        if first.is_none() {
            *first = Some(payload);
        } else {
            // The payload is opaque, and its destructor can panic while the
            // first cleanup failure is already retained.
            std::mem::forget(payload);
        }
    }
}

fn dispose_http_waiter_suppressing(waiter: Option<std::task::Waker>) {
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(waiter))) {
        std::mem::forget(payload);
    }
}

fn run_http_cleanup_from_drop(cleanup: impl FnOnce()) {
    let already_panicking = std::thread::panicking();
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(cleanup)) {
        if already_panicking {
            // A cleanup panic cannot replace the panic that already owns this
            // unwind. The opaque payload is leaked because its destructor can
            // also panic.
            std::mem::forget(payload);
        } else {
            std::panic::resume_unwind(payload);
        }
    }
}

fn dispose_http_completion(waiter: Option<std::task::Waker>, drain: HttpStreamDrain) {
    let already_panicking = std::thread::panicking();
    let mut first_panic = None;
    retain_first_http_cleanup_panic(
        &mut first_panic,
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(waiter))),
    );
    retain_first_http_cleanup_panic(
        &mut first_panic,
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drain.dispose_propagating())),
    );
    if let Some(payload) = first_panic {
        if already_panicking {
            std::mem::forget(payload);
        } else {
            std::panic::resume_unwind(payload);
        }
    }
}

impl Default for HttpStreamState {
    fn default() -> Self {
        Self {
            closed: false,
            next_generation: 1,
            next_token: 1,
            sweeper_running: false,
            sources: HashMap::new(),
            response_writers: HashMap::new(),
            #[cfg(all(test, celld_internal_tests))]
            sweeper_starts: 0,
            #[cfg(all(test, celld_internal_tests))]
            sweeper_active: 0,
            #[cfg(all(test, celld_internal_tests))]
            sweeper_exit_gate: None,
            #[cfg(all(test, celld_internal_tests))]
            pull_completion_gate: None,
        }
    }
}

impl Default for HttpStreamService {
    fn default() -> Self {
        Self {
            state: std::sync::Mutex::new(HttpStreamState::default()),
            sweeper_notify: Arc::new(tokio::sync::Notify::new()),
            owner: OnceLock::new(),
            #[cfg(all(test, celld_internal_tests))]
            registration_clock_reads: AtomicU64::new(0),
        }
    }
}

enum HttpSweepWait {
    Deadline(u64),
    Notification,
    Exit,
}

impl HttpStreamService {
    pub(crate) fn bind_domain(&self, owner: asyncrt::DomainToken) {
        if let Err(candidate) = self.owner.set(owner) {
            assert!(
                self.owner
                    .get()
                    .is_some_and(|current| current.same_owner(&candidate)),
                "one HTTP stream service was bound to two execution Domains"
            );
        }
    }

    fn next_sequence(sequence: &mut u64) -> u64 {
        let value = *sequence;
        *sequence = sequence.wrapping_add(1).max(1);
        value
    }

    fn expired_error(stream_id: u64) -> String {
        format!(
            "HTTP stream {stream_id} expired after {} seconds of inactivity",
            HTTP_STREAM_IDLE_TIMEOUT_MS / 1_000
        )
    }

    fn unknown_error(stream_id: u64) -> String {
        format!("HTTP stream {stream_id} expired or is not registered")
    }

    fn termination_result(
        stream_id: u64,
        reason: HttpStreamTerminationReason,
    ) -> Result<Option<Vec<u8>>, String> {
        match reason {
            HttpStreamTerminationReason::Finished | HttpStreamTerminationReason::Cancelled => {
                Ok(None)
            }
            HttpStreamTerminationReason::Expired => Err(Self::expired_error(stream_id)),
            HttpStreamTerminationReason::Live => Err(Self::unknown_error(stream_id)),
        }
    }

    fn remove_locked(
        state: &mut HttpStreamState,
        stream_id: u64,
        reason: HttpStreamTerminationReason,
        drain: &mut HttpStreamDrain,
    ) -> bool {
        let Some(source) = state.sources.remove(&stream_id) else {
            return false;
        };
        source.termination.commit(reason);
        if let Some(writer) = state.response_writers.remove(&stream_id) {
            drain.response_writers.push((stream_id, writer));
        }
        drain.sources.push((stream_id, source));
        true
    }

    fn close_locked(state: &mut HttpStreamState, drain: &mut HttpStreamDrain) {
        state.closed = true;
        state.sweeper_running = false;
        let mut ids = state.sources.keys().copied().collect::<Vec<_>>();
        ids.sort_unstable();
        for id in ids {
            Self::remove_locked(state, id, HttpStreamTerminationReason::Cancelled, drain);
        }
        debug_assert!(state.response_writers.is_empty());
    }

    fn registration_clock(
        &self,
        state: &mut HttpStreamState,
        drain: &mut HttpStreamDrain,
    ) -> Option<(asyncrt::DomainToken, u64)> {
        #[cfg(all(test, celld_internal_tests))]
        self.registration_clock_reads.fetch_add(1, Ordering::SeqCst);
        let owner = self.owner.get()?.clone();
        match owner.mono_ms() {
            Ok(now_ms) => Some((owner, now_ms)),
            Err(_) => {
                Self::close_locked(state, drain);
                None
            }
        }
    }

    fn spawn_sweeper(self: &Arc<Self>, owner: &asyncrt::DomainToken) -> bool {
        let service = Arc::downgrade(self);
        #[cfg(all(test, celld_internal_tests))]
        let run_guard = {
            let mut state = self.state.lock().unwrap();
            state.sweeper_starts = state.sweeper_starts.saturating_add(1);
            state.sweeper_active = state.sweeper_active.saturating_add(1);
            HttpSweeperRunGuard {
                service: service.clone(),
            }
        };
        let owner_guard = HttpSweeperOwnerGuard {
            service: service.clone(),
            armed: true,
        };
        let notify = self.sweeper_notify.clone();
        let sweeper_owner = owner.clone();
        owner
            .spawn_detached("http-stream-idle-sweeper", async move {
                #[cfg(all(test, celld_internal_tests))]
                let _run_guard = run_guard;
                let mut owner_guard = owner_guard;
                http_stream_sweeper(service, notify, sweeper_owner, &mut owner_guard).await;
            })
            .is_ok()
    }

    fn owner_lost(self: &Arc<Self>) {
        let drain = {
            let mut state = self.state.lock().unwrap();
            let mut drain = HttpStreamDrain::default();
            // Simulation quarantine closes registration before it drops tasks.
            // Its explicit HTTP phase must remain the only place that drains
            // sources, so task and timer destructors always run first.
            if !state.closed {
                Self::close_locked(&mut state, &mut drain);
            }
            drain
        };
        self.sweeper_notify.notify_one();
        drain.dispose_suppressing();
    }

    #[must_use = "a rejected HTTP stream must not publish an ID"]
    pub(crate) fn register_source(self: &Arc<Self>, source: HttpStreamSource) -> Option<u64> {
        self.register_source_for(source, None)
    }

    /// Register `source` for `owner`, the code its id is handed to.
    #[must_use = "a rejected HTTP stream must not publish an ID"]
    pub(crate) fn register_source_for(
        self: &Arc<Self>,
        source: HttpStreamSource,
        owner: Option<WsOwner>,
    ) -> Option<u64> {
        let stream_id = NEXT_HTTP_STREAM_ID.fetch_add(1, Ordering::Relaxed);
        self.register(stream_id, source, None, owner)
            .then_some(stream_id)
    }

    #[must_use = "a rejected response stream must not publish an ID"]
    pub(crate) fn register_response_pair(
        self: &Arc<Self>,
        receiver: tokio::sync::mpsc::Receiver<Result<Vec<u8>, String>>,
        writer: ResponseStreamWriter,
        owner: Option<WsOwner>,
    ) -> Option<u64> {
        let stream_id = NEXT_HTTP_STREAM_ID.fetch_add(1, Ordering::Relaxed);
        self.register(
            stream_id,
            HttpStreamSource::Receiver(receiver),
            Some(writer),
            owner,
        )
        .then_some(stream_id)
    }

    pub(crate) fn register(
        self: &Arc<Self>,
        stream_id: u64,
        source: HttpStreamSource,
        writer: Option<ResponseStreamWriter>,
        mut stream_owner: Option<WsOwner>,
    ) -> bool {
        let mut candidate_source = Some(source);
        let mut candidate_writer = writer;
        let mut drain = HttpStreamDrain::default();
        let mut owner = None;
        let mut start_sweeper = false;
        let accepted = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                false
            } else if let Some((bound_owner, now_ms)) =
                self.registration_clock(&mut state, &mut drain)
            {
                Self::remove_locked(
                    &mut state,
                    stream_id,
                    HttpStreamTerminationReason::Cancelled,
                    &mut drain,
                );
                let generation = Self::next_sequence(&mut state.next_generation);
                let deadline_ms = now_ms.saturating_add(HTTP_STREAM_IDLE_TIMEOUT_MS);
                let mut entry =
                    HttpStreamEntry::new(generation, deadline_ms, candidate_source.take().unwrap());
                entry.owner = stream_owner.take();
                state.sources.insert(stream_id, entry);
                if let Some(writer) = candidate_writer.take() {
                    state.response_writers.insert(stream_id, writer);
                }
                if !state.sweeper_running {
                    state.sweeper_running = true;
                    start_sweeper = true;
                }
                owner = Some(bound_owner);
                true
            } else {
                false
            }
        };

        if !accepted {
            if let Some(source) = candidate_source.take() {
                let rejected = HttpStreamEntry::new(0, 0, source);
                rejected
                    .termination
                    .commit(HttpStreamTerminationReason::Cancelled);
                drain.sources.push((stream_id, rejected));
            }
            if let Some(writer) = candidate_writer.take() {
                drain.response_writers.push((stream_id, writer));
            }
        } else if start_sweeper {
            if !self.spawn_sweeper(owner.as_ref().unwrap()) {
                self.owner_lost();
                drain.dispose_suppressing();
                return false;
            }
        } else {
            self.sweeper_notify.notify_one();
        }
        drain.dispose_propagating();
        accepted
    }

    pub(crate) fn claim(self: &Arc<Self>, stream_id: u64) -> Option<HttpStreamClaim> {
        let mut drain = HttpStreamDrain::default();
        let mut generation = None;
        {
            let mut state = self.state.lock().unwrap();
            if !state.closed {
                let now_ms = self
                    .registration_clock(&mut state, &mut drain)
                    .map(|(_, now_ms)| now_ms);
                if let Some(now_ms) = now_ms {
                    if state
                        .sources
                        .get(&stream_id)
                        .is_some_and(|entry| entry.is_due(now_ms))
                    {
                        Self::remove_locked(
                            &mut state,
                            stream_id,
                            HttpStreamTerminationReason::Expired,
                            &mut drain,
                        );
                    } else if let Some(stream) = state.sources.get_mut(&stream_id) {
                        stream.owners = stream.owners.saturating_add(1);
                        generation = Some(stream.generation);
                    }
                }
            }
        }
        if !drain.sources.is_empty() || !drain.response_writers.is_empty() {
            self.sweeper_notify.notify_one();
        }
        drain.dispose_propagating();
        generation.map(|generation| HttpStreamClaim {
            service: self.clone(),
            stream_id,
            generation,
            armed: true,
        })
    }

    /// Claim an incoming body for `owner`, the handler it is delivered to,
    /// which from then on is the only code that may use its id.
    pub(crate) fn claim_for(
        self: &Arc<Self>,
        stream_id: u64,
        owner: WsOwner,
    ) -> Option<HttpStreamClaim> {
        let claim = self.claim(stream_id)?;
        if let Some(entry) = self
            .state
            .lock()
            .unwrap()
            .sources
            .get_mut(&stream_id)
            .filter(|entry| entry.generation == claim.generation)
        {
            entry.owner = Some(owner);
        }
        Some(claim)
    }

    /// Whether `owner` may use `stream_id`. An op checks before it acts on an
    /// id that JavaScript passed it.
    pub(crate) fn access(&self, stream_id: u64, owner: &WsOwner) -> HttpStreamAccess {
        match self.state.lock().unwrap().sources.get(&stream_id) {
            None => HttpStreamAccess::Unknown,
            Some(entry) if entry.owner.as_ref() == Some(owner) => HttpStreamAccess::Owned,
            Some(entry) => HttpStreamAccess::Other {
                object: matches!(owner, WsOwner::Cell(_))
                    && matches!(entry.owner, Some(WsOwner::Cell(_))),
            },
        }
    }

    fn release_claim(&self, stream_id: u64, generation: u64) {
        let mut drain = HttpStreamDrain::default();
        let mut notify = false;
        {
            let mut state = self.state.lock().unwrap();
            let mut remove = false;
            if let Some(stream) = state
                .sources
                .get_mut(&stream_id)
                .filter(|stream| stream.generation == generation)
            {
                stream.owners = stream.owners.saturating_sub(1);
                // Checkout consumes one claim before the asynchronous pull
                // completes. Keep every leased source registered so the pull
                // can publish its result. An abandoned lease removes itself,
                // and an available source with no owners can be reclaimed now.
                remove = stream.owners == 0
                    && matches!(stream.source, HttpStreamSourceSlot::Available(_));
                notify = true;
            }
            if remove {
                Self::remove_locked(
                    &mut state,
                    stream_id,
                    HttpStreamTerminationReason::Cancelled,
                    &mut drain,
                );
            }
        }
        if notify {
            self.sweeper_notify.notify_one();
        }
        drain.dispose_propagating();
    }

    pub(crate) fn checkout_source(
        self: &Arc<Self>,
        stream_id: u64,
    ) -> Result<(HttpSourceLease, HttpStreamSource), String> {
        self.checkout(stream_id, HttpSourceLeaseMode::Pull, None)
    }

    pub(crate) fn checkout_transfer(
        self: &Arc<Self>,
        stream_id: u64,
        claim_generation: Option<u64>,
    ) -> Result<HttpTransferredStream, String> {
        let (lease, source) =
            self.checkout(stream_id, HttpSourceLeaseMode::Transfer, claim_generation)?;
        Ok(HttpTransferredStream {
            inner: http_chunk_stream(source),
            lease: HttpTransferLease::new(lease),
            finished: false,
        })
    }

    fn checkout(
        self: &Arc<Self>,
        stream_id: u64,
        mode: HttpSourceLeaseMode,
        claim_generation: Option<u64>,
    ) -> Result<(HttpSourceLease, HttpStreamSource), String> {
        let mut drain = HttpStreamDrain::default();
        let mut checkout = None;
        let mut error = None;
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                error = Some(Self::unknown_error(stream_id));
            } else {
                let now_ms = self
                    .registration_clock(&mut state, &mut drain)
                    .map(|(_, now_ms)| now_ms);
                if let Some(now_ms) = now_ms {
                    if state
                        .sources
                        .get(&stream_id)
                        .is_some_and(|entry| entry.is_due(now_ms))
                    {
                        Self::remove_locked(
                            &mut state,
                            stream_id,
                            HttpStreamTerminationReason::Expired,
                            &mut drain,
                        );
                        error = Some(Self::expired_error(stream_id));
                    } else if !state.sources.contains_key(&stream_id) {
                        error = Some(Self::unknown_error(stream_id));
                    } else {
                        let token = Self::next_sequence(&mut state.next_token);
                        let entry = state.sources.get_mut(&stream_id).unwrap();
                        if claim_generation.is_some_and(|generation| {
                            generation != entry.generation || entry.owners == 0
                        }) {
                            error = Some(Self::unknown_error(stream_id));
                        } else {
                            let leased = HttpStreamSourceSlot::Leased { token, mode };
                            match std::mem::replace(&mut entry.source, leased) {
                                HttpStreamSourceSlot::Available(source) => {
                                    if claim_generation.is_some() {
                                        entry.owners = entry.owners.saturating_sub(1);
                                    }
                                    checkout = Some((
                                        entry.generation,
                                        token,
                                        entry.termination.clone(),
                                        source,
                                    ));
                                }
                                occupied @ HttpStreamSourceSlot::Leased { .. } => {
                                    entry.source = occupied;
                                    error = Some(format!(
                                        "HTTP stream {stream_id} source is checked out"
                                    ));
                                }
                            }
                        }
                    }
                } else {
                    error = Some(Self::unknown_error(stream_id));
                }
            }
        }
        self.sweeper_notify.notify_one();
        drain.dispose_propagating();
        if let Some((generation, token, termination, source)) = checkout {
            Ok((
                HttpSourceLease {
                    service: self.clone(),
                    stream_id,
                    generation,
                    token,
                    mode,
                    termination,
                    settled: false,
                },
                source,
            ))
        } else {
            Err(error.unwrap_or_else(|| Self::unknown_error(stream_id)))
        }
    }

    pub(crate) fn complete_pull(
        &self,
        lease: &HttpSourceLease,
        source: HttpStreamSource,
        result: Result<Option<Vec<u8>>, String>,
    ) -> Result<Option<Vec<u8>>, String> {
        let mut source = Some(source);
        let mut drain = HttpStreamDrain::default();
        #[cfg(all(test, celld_internal_tests))]
        let mut completion_gate = None;
        let (answer, waiter) = {
            let mut state = self.state.lock().unwrap();
            let reason = lease.termination.reason();
            let matches = state.sources.get(&lease.stream_id).is_some_and(|entry| {
                entry.generation == lease.generation
                    && matches!(
                        entry.source,
                        HttpStreamSourceSlot::Leased {
                            token,
                            mode: HttpSourceLeaseMode::Pull,
                        } if token == lease.token
                    )
            });
            let answer = if reason != HttpStreamTerminationReason::Live || !matches {
                Self::termination_result(lease.stream_id, reason)
            } else {
                match result {
                    Ok(Some(bytes)) => {
                        let now_ms = self.owner.get().and_then(|owner| owner.mono_ms().ok());
                        if let Some(now_ms) = now_ms {
                            let entry = state.sources.get_mut(&lease.stream_id).unwrap();
                            entry.source = HttpStreamSourceSlot::Available(source.take().unwrap());
                            entry.deadline_ms = now_ms.saturating_add(HTTP_STREAM_IDLE_TIMEOUT_MS);
                            Ok(Some(bytes))
                        } else {
                            Self::close_locked(&mut state, &mut drain);
                            Ok(None)
                        }
                    }
                    Ok(None) => {
                        Self::remove_locked(
                            &mut state,
                            lease.stream_id,
                            HttpStreamTerminationReason::Finished,
                            &mut drain,
                        );
                        Ok(None)
                    }
                    Err(error) => {
                        Self::remove_locked(
                            &mut state,
                            lease.stream_id,
                            HttpStreamTerminationReason::Finished,
                            &mut drain,
                        );
                        Err(error)
                    }
                }
            };
            // Restoring the source lets a successor lease register a waiter
            // as soon as this lock opens. Take only this lease's waiter while
            // the registry still prevents that successor checkout.
            let waiter = lease.termination.take_waiter();
            #[cfg(all(test, celld_internal_tests))]
            if state
                .pull_completion_gate
                .as_ref()
                .is_some_and(|candidate| candidate.stream_id == lease.stream_id)
            {
                completion_gate = state.pull_completion_gate.take();
            }
            (answer, waiter)
        };
        #[cfg(all(test, celld_internal_tests))]
        if let Some(gate) = completion_gate {
            gate.pause();
        }
        if let Some(source) = source {
            drain.detached_sources.push((lease.stream_id, source));
        }
        self.sweeper_notify.notify_one();
        // The waiter must be disposed before an arbitrary source destructor.
        // Both can panic, so catch both cleanups and retain only the first.
        dispose_http_completion(waiter, drain);
        answer
    }

    fn transferred_activity(
        &self,
        stream_id: u64,
        generation: u64,
        token: u64,
        termination: &HttpStreamTermination,
    ) -> Result<(), HttpStreamTerminationReason> {
        let mut state = self.state.lock().unwrap();
        let reason = termination.reason();
        if reason != HttpStreamTerminationReason::Live {
            return Err(reason);
        }
        let Some(entry) = state.sources.get_mut(&stream_id).filter(|entry| {
            entry.generation == generation
                && matches!(
                    entry.source,
                    HttpStreamSourceSlot::Leased {
                        token: current,
                        mode: HttpSourceLeaseMode::Transfer,
                    } if current == token
                )
        }) else {
            return Err(termination.reason());
        };
        let Some(now_ms) = self.owner.get().and_then(|owner| owner.mono_ms().ok()) else {
            return Err(HttpStreamTerminationReason::Cancelled);
        };
        entry.deadline_ms = now_ms.saturating_add(HTTP_STREAM_IDLE_TIMEOUT_MS);
        Ok(())
    }

    fn finish_lease(
        &self,
        stream_id: u64,
        generation: u64,
        token: u64,
        mode: HttpSourceLeaseMode,
        termination: &HttpStreamTermination,
        requested_reason: HttpStreamTerminationReason,
    ) -> HttpStreamTerminationReason {
        let mut drain = HttpStreamDrain::default();
        let winning_reason = {
            let mut state = self.state.lock().unwrap();
            let matches = state.sources.get(&stream_id).is_some_and(|entry| {
                entry.generation == generation
                    && matches!(
                        entry.source,
                        HttpStreamSourceSlot::Leased {
                            token: current,
                            mode: current_mode,
                        } if current == token && current_mode == mode
                    )
            });
            if matches {
                let committed_reason = termination.reason();
                let removal_reason = if committed_reason == HttpStreamTerminationReason::Live {
                    requested_reason
                } else {
                    committed_reason
                };
                Self::remove_locked(&mut state, stream_id, removal_reason, &mut drain);
            }
            let reason = termination.reason();
            if reason == HttpStreamTerminationReason::Live {
                HttpStreamTerminationReason::Cancelled
            } else {
                reason
            }
        };
        self.sweeper_notify.notify_one();
        drain.dispose_suppressing();
        winning_reason
    }

    fn cancel_lease(&self, lease: &HttpSourceLease) {
        self.finish_lease(
            lease.stream_id,
            lease.generation,
            lease.token,
            lease.mode,
            &lease.termination,
            HttpStreamTerminationReason::Cancelled,
        );
    }

    pub(crate) fn cancel_source(&self, stream_id: u64) {
        let mut drain = HttpStreamDrain::default();
        {
            let mut state = self.state.lock().unwrap();
            Self::remove_locked(
                &mut state,
                stream_id,
                HttpStreamTerminationReason::Cancelled,
                &mut drain,
            );
        }
        self.sweeper_notify.notify_one();
        drain.dispose_propagating();
    }

    pub(crate) fn begin_activity(
        self: &Arc<Self>,
        stream_id: u64,
        kind: HttpStreamActivityKind,
    ) -> Result<HttpStreamActivity, HttpStreamActivityError> {
        let mut drain = HttpStreamDrain::default();
        let mut acquired = None;
        let mut error = None;
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                error = Some(HttpStreamActivityError::Closed);
            } else {
                let now_ms = self
                    .registration_clock(&mut state, &mut drain)
                    .map(|(_, now_ms)| now_ms);
                if let Some(now_ms) = now_ms {
                    if state
                        .sources
                        .get(&stream_id)
                        .is_some_and(|entry| entry.is_due(now_ms))
                    {
                        Self::remove_locked(
                            &mut state,
                            stream_id,
                            HttpStreamTerminationReason::Expired,
                            &mut drain,
                        );
                        error = Some(HttpStreamActivityError::Gone);
                    } else {
                        let endpoints = state
                            .response_writers
                            .get(&stream_id)
                            .map(|writer| (writer.writer.clone(), writer.finished.clone()));
                        if let (Some(entry), Some((writer, finished))) =
                            (state.sources.get_mut(&stream_id), endpoints)
                        {
                            if entry.closing {
                                error = Some(HttpStreamActivityError::Closing);
                            } else {
                                match kind {
                                    HttpStreamActivityKind::Write => {
                                        entry.active_writes = entry.active_writes.saturating_add(1)
                                    }
                                    HttpStreamActivityKind::Close => {
                                        entry.active_closes = entry.active_closes.saturating_add(1);
                                        entry.closing = true;
                                    }
                                }
                                acquired = Some((writer, finished, entry.generation));
                            }
                        }
                    }
                } else if state.closed {
                    error = Some(HttpStreamActivityError::Closed);
                }
            }
        }
        self.sweeper_notify.notify_one();
        drain.dispose_propagating();
        let Some((writer, finished, generation)) = acquired else {
            return Err(error.unwrap_or(HttpStreamActivityError::Gone));
        };
        Ok(HttpStreamActivity {
            writer,
            finished,
            lease: HttpStreamActivityLease {
                service: self.clone(),
                stream_id,
                generation,
                kind,
                active: true,
            },
        })
    }

    fn finish_activity(
        &self,
        stream_id: u64,
        generation: u64,
        kind: HttpStreamActivityKind,
        remove_writer: bool,
    ) {
        let mut removed_writer = None;
        {
            let mut state = self.state.lock().unwrap();
            let now_ms = self.owner.get().and_then(|owner| owner.mono_ms().ok());
            if let Some(entry) = state
                .sources
                .get_mut(&stream_id)
                .filter(|entry| entry.generation == generation)
            {
                match kind {
                    HttpStreamActivityKind::Write => {
                        entry.active_writes = entry.active_writes.saturating_sub(1)
                    }
                    HttpStreamActivityKind::Close => {
                        entry.active_closes = entry.active_closes.saturating_sub(1);
                        entry.closing = false;
                    }
                }
                if let Some(now_ms) = now_ms {
                    entry.deadline_ms = now_ms.saturating_add(HTTP_STREAM_IDLE_TIMEOUT_MS);
                }
                if remove_writer {
                    removed_writer = state.response_writers.remove(&stream_id);
                }
            }
        }
        self.sweeper_notify.notify_one();
        drop(removed_writer);
    }

    fn abandon_activity(&self, stream_id: u64, generation: u64, kind: HttpStreamActivityKind) {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(entry) = state
                .sources
                .get_mut(&stream_id)
                .filter(|entry| entry.generation == generation)
            {
                match kind {
                    HttpStreamActivityKind::Write => {
                        entry.active_writes = entry.active_writes.saturating_sub(1)
                    }
                    HttpStreamActivityKind::Close => {
                        entry.active_closes = entry.active_closes.saturating_sub(1);
                        entry.closing = false;
                    }
                }
            }
        }
        // Drop does not read the clock or manufacture activity. It only makes
        // the previous successful-activity deadline eligible again.
        self.sweeper_notify.notify_one();
    }

    fn cancel_activity_pair(&self, stream_id: u64, generation: u64, kind: HttpStreamActivityKind) {
        let mut drain = HttpStreamDrain::default();
        {
            let mut state = self.state.lock().unwrap();
            let matches = state
                .sources
                .get(&stream_id)
                .is_some_and(|entry| entry.generation == generation);
            if matches {
                if let Some(entry) = state.sources.get_mut(&stream_id) {
                    match kind {
                        HttpStreamActivityKind::Write => {
                            entry.active_writes = entry.active_writes.saturating_sub(1)
                        }
                        HttpStreamActivityKind::Close => {
                            entry.active_closes = entry.active_closes.saturating_sub(1)
                        }
                    }
                }
                Self::remove_locked(
                    &mut state,
                    stream_id,
                    HttpStreamTerminationReason::Cancelled,
                    &mut drain,
                );
            }
        }
        self.sweeper_notify.notify_one();
        drain.dispose_propagating();
    }

    pub(crate) fn writer_close_watch(&self, stream_id: u64) -> Option<ResponseStreamCloseWatch> {
        let state = self.state.lock().unwrap();
        if state.closed {
            return None;
        }
        state
            .response_writers
            .get(&stream_id)
            .map(|stream| (stream.writer.clone(), stream.finished.subscribe()))
    }

    fn sweep_step(&self, owner: &asyncrt::DomainToken) -> (HttpSweepWait, HttpStreamDrain) {
        let mut drain = HttpStreamDrain::default();
        let wait = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                state.sweeper_running = false;
                HttpSweepWait::Exit
            } else if let Ok(now_ms) = owner.mono_ms() {
                let mut due = state
                    .sources
                    .iter()
                    .filter_map(|(id, entry)| entry.is_due(now_ms).then_some(*id))
                    .collect::<Vec<_>>();
                due.sort_unstable();
                for id in due {
                    Self::remove_locked(
                        &mut state,
                        id,
                        HttpStreamTerminationReason::Expired,
                        &mut drain,
                    );
                }
                if state.sources.is_empty() {
                    state.sweeper_running = false;
                    HttpSweepWait::Exit
                } else if let Some(deadline_ms) = state
                    .sources
                    .values()
                    .filter(|entry| entry.is_expiry_eligible())
                    .map(|entry| entry.deadline_ms)
                    .min()
                {
                    HttpSweepWait::Deadline(deadline_ms)
                } else {
                    HttpSweepWait::Notification
                }
            } else {
                Self::close_locked(&mut state, &mut drain);
                HttpSweepWait::Exit
            }
        };
        (wait, drain)
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn source_exists_for_test(&self, stream_id: u64) -> bool {
        self.state.lock().unwrap().sources.contains_key(&stream_id)
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn writer_exists_for_test(&self, stream_id: u64) -> bool {
        self.state
            .lock()
            .unwrap()
            .response_writers
            .contains_key(&stream_id)
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn termination_for_test(
        &self,
        stream_id: u64,
    ) -> Option<Arc<HttpStreamTermination>> {
        self.state
            .lock()
            .unwrap()
            .sources
            .get(&stream_id)
            .map(|entry| entry.termination.clone())
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn lock_is_available_for_test(&self) -> bool {
        self.state.try_lock().is_ok()
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn arm_sweeper_exit_for_test(&self) -> Arc<HttpSweeperExitGate> {
        let gate = Arc::new(HttpSweeperExitGate::new());
        let mut state = self.state.lock().unwrap();
        assert!(state.sweeper_exit_gate.replace(gate.clone()).is_none());
        gate
    }

    #[cfg(all(test, celld_internal_tests))]
    fn take_sweeper_exit_gate_for_test(&self) -> Option<Arc<HttpSweeperExitGate>> {
        self.state.lock().unwrap().sweeper_exit_gate.take()
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn sweeper_state_for_test(&self) -> (u64, usize, bool) {
        let state = self.state.lock().unwrap();
        (
            state.sweeper_starts,
            state.sweeper_active,
            state.sweeper_running,
        )
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn registration_clock_reads_for_test(&self) -> u64 {
        self.registration_clock_reads.load(Ordering::SeqCst)
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn arm_pull_completion_after_unlock_for_test(
        &self,
        stream_id: u64,
    ) -> (
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (reached_sender, reached_receiver) = std::sync::mpsc::sync_channel(1);
        let (release_sender, release_receiver) = std::sync::mpsc::sync_channel(1);
        let gate = HttpPullCompletionGate {
            stream_id,
            reached: reached_sender,
            release: release_receiver,
        };
        assert!(self
            .state
            .lock()
            .unwrap()
            .pull_completion_gate
            .replace(gate)
            .is_none());
        (reached_receiver, release_sender)
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn closing_for_test(&self, stream_id: u64) -> bool {
        self.state
            .lock()
            .unwrap()
            .sources
            .get(&stream_id)
            .is_some_and(|entry| entry.closing)
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn quarantine(&self) {
        self.state.lock().unwrap().closed = true;
        self.sweeper_notify.notify_one();
    }

    #[cfg(all(test, celld_internal_tests))]
    pub(crate) fn close(&self) {
        let drain = {
            let mut state = self.state.lock().unwrap();
            let mut drain = HttpStreamDrain::default();
            Self::close_locked(&mut state, &mut drain);
            drain
        };
        self.sweeper_notify.notify_one();
        drain.dispose_propagating();
    }
}

impl Drop for HttpStreamService {
    fn drop(&mut self) {
        // The final runtime anchor can disappear before an explicit Domain
        // close. Exclusive access still makes a poisoned registry safe to
        // drain, so commit every termination before arbitrary cleanup runs.
        let state = match self.state.get_mut() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut drain = HttpStreamDrain::default();
        Self::close_locked(state, &mut drain);
        drain.dispose_suppressing();
    }
}

async fn http_stream_sweeper(
    service: Weak<HttpStreamService>,
    notify: Arc<tokio::sync::Notify>,
    owner: asyncrt::DomainToken,
    owner_guard: &mut HttpSweeperOwnerGuard,
) {
    loop {
        // Create the notification future before the registry snapshot. A
        // registration between the snapshot and the await leaves a permit, so
        // the sole sweeper cannot sleep through an earlier deadline.
        let notified = notify.notified();
        let Some(service) = service.upgrade() else {
            return;
        };
        let (wait, drain) = service.sweep_step(&owner);
        #[cfg(all(test, celld_internal_tests))]
        let exit_gate = matches!(wait, HttpSweepWait::Exit)
            .then(|| service.take_sweeper_exit_gate_for_test())
            .flatten();
        drop(service);
        // An abandoned source can own a panicking destructor. The leak
        // backstop must still service later entries after that failure.
        drain.dispose_suppressing();
        match wait {
            HttpSweepWait::Exit => {
                #[cfg(all(test, celld_internal_tests))]
                if let Some(gate) = exit_gate {
                    gate.wait().await;
                }
                owner_guard.disarm();
                return;
            }
            HttpSweepWait::Notification => notified.await,
            HttpSweepWait::Deadline(deadline_ms) => {
                let Ok(sleep) = owner.sleep_until(deadline_ms) else {
                    return;
                };
                crate::asyncrt::select_biased! {
                    "a registry notification wins a deadline tie so the next sweep uses the refreshed deadline";
                    _ = notified => {}
                    _ = sleep => {}
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum HttpStreamActivityKind {
    Write,
    Close,
}

#[derive(Clone, Copy)]
pub(crate) enum HttpStreamActivityError {
    Closed,
    Gone,
    Closing,
}

impl HttpStreamActivityError {
    pub(crate) fn write_message(self) -> &'static str {
        match self {
            Self::Closed => HTTP_STREAM_REGISTRATION_CLOSED,
            Self::Gone | Self::Closing => RESPONSE_STREAM_CONSUMER_CANCELED,
        }
    }
}

struct HttpStreamActivityLease {
    service: Arc<HttpStreamService>,
    stream_id: u64,
    generation: u64,
    kind: HttpStreamActivityKind,
    active: bool,
}

pub(crate) struct HttpStreamActivity {
    writer: tokio::sync::mpsc::Sender<Result<Vec<u8>, String>>,
    finished: tokio::sync::watch::Sender<bool>,
    lease: HttpStreamActivityLease,
}

impl HttpStreamActivityLease {
    fn succeed(mut self, remove_writer: bool) {
        self.active = false;
        self.service
            .finish_activity(self.stream_id, self.generation, self.kind, remove_writer);
    }

    fn cancel_pair(mut self) {
        self.active = false;
        self.service
            .cancel_activity_pair(self.stream_id, self.generation, self.kind);
    }
}

impl Drop for HttpStreamActivityLease {
    fn drop(&mut self) {
        if self.active {
            self.service
                .abandon_activity(self.stream_id, self.generation, self.kind);
        }
    }
}

pub(crate) struct HttpSourceLease {
    service: Arc<HttpStreamService>,
    stream_id: u64,
    generation: u64,
    token: u64,
    mode: HttpSourceLeaseMode,
    pub(crate) termination: Arc<HttpStreamTermination>,
    pub(crate) settled: bool,
}

struct HttpPull {
    // Struct fields drop in declaration order. Registry removal therefore
    // commits before an arbitrary checked-out source destructor can re-enter
    // the service or panic when a pending read future is abandoned.
    lease: HttpSourceLease,
    source: HttpStreamSource,
}

impl Drop for HttpSourceLease {
    fn drop(&mut self) {
        // A settled path already took its waiter while it still owned the
        // registry slot. Taking again here could clear a successor's waiter.
        if self.settled {
            return;
        }
        let waiter = self.termination.take_waiter();
        self.service.cancel_lease(self);
        dispose_http_waiter_suppressing(waiter);
    }
}

struct HttpTransferLease {
    inner: Option<HttpSourceLease>,
}

impl HttpTransferLease {
    fn new(lease: HttpSourceLease) -> Self {
        debug_assert_eq!(lease.mode, HttpSourceLeaseMode::Transfer);
        Self { inner: Some(lease) }
    }

    fn termination(&self) -> &HttpStreamTermination {
        &self.inner.as_ref().unwrap().termination
    }

    fn stream_id(&self) -> u64 {
        self.inner.as_ref().unwrap().stream_id
    }

    fn successful_activity(&self) -> Result<(), HttpStreamTerminationReason> {
        let lease = self.inner.as_ref().unwrap();
        let result = lease.service.transferred_activity(
            lease.stream_id,
            lease.generation,
            lease.token,
            &lease.termination,
        );
        dispose_http_waiter_suppressing(lease.termination.take_waiter());
        result
    }

    fn finish(
        &mut self,
        requested_reason: HttpStreamTerminationReason,
    ) -> HttpStreamTerminationReason {
        let mut lease = self.inner.take().unwrap();
        lease.settled = true;
        let waiter = lease.termination.take_waiter();
        let winning_reason = lease.service.finish_lease(
            lease.stream_id,
            lease.generation,
            lease.token,
            lease.mode,
            &lease.termination,
            requested_reason,
        );
        dispose_http_waiter_suppressing(waiter);
        winning_reason
    }
}

pub(crate) struct HttpTransferredStream {
    // The lease drops first, so registry cancellation commits before an
    // arbitrary source destructor can re-enter the service or panic.
    lease: HttpTransferLease,
    inner: HttpChunkStream,
    finished: bool,
}

enum HttpTransferredEvent {
    Chunk(Vec<u8>),
    Error(String),
    End,
    Terminated(HttpStreamTerminationReason),
}

fn transferred_termination_poll(
    stream_id: u64,
    reason: HttpStreamTerminationReason,
) -> std::task::Poll<Option<Result<Vec<u8>, String>>> {
    match HttpStreamService::termination_result(stream_id, reason) {
        Ok(None) => std::task::Poll::Ready(None),
        Ok(Some(bytes)) => std::task::Poll::Ready(Some(Ok(bytes))),
        Err(error) => std::task::Poll::Ready(Some(Err(error))),
    }
}

impl HttpTransferredStream {
    fn termination_handle(&self) -> Arc<HttpStreamTermination> {
        self.lease.inner.as_ref().unwrap().termination.clone()
    }

    /// Poll the transferred source without committing a natural terminal
    /// event. A direct consumer commits immediately in `poll_next`. The tee
    /// pump keeps the lease live until it publishes an error to each live
    /// branch, so cancellation can interrupt a backpressured terminal send.
    fn poll_event(
        &mut self,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<HttpTransferredEvent> {
        debug_assert!(!self.finished);
        if let std::task::Poll::Ready(reason) = self.lease.termination().poll_reason(context) {
            return std::task::Poll::Ready(HttpTransferredEvent::Terminated(reason));
        }
        match self.inner.as_mut().poll_next(context) {
            std::task::Poll::Ready(Some(Ok(bytes))) => match self.lease.successful_activity() {
                Ok(()) => std::task::Poll::Ready(HttpTransferredEvent::Chunk(bytes)),
                Err(reason) => std::task::Poll::Ready(HttpTransferredEvent::Terminated(reason)),
            },
            std::task::Poll::Ready(Some(Err(error))) => {
                std::task::Poll::Ready(HttpTransferredEvent::Error(error))
            }
            std::task::Poll::Ready(None) => std::task::Poll::Ready(HttpTransferredEvent::End),
            std::task::Poll::Pending => match self.lease.termination().poll_reason(context) {
                std::task::Poll::Ready(reason) => {
                    std::task::Poll::Ready(HttpTransferredEvent::Terminated(reason))
                }
                std::task::Poll::Pending => std::task::Poll::Pending,
            },
        }
    }

    fn finish(
        &mut self,
        requested_reason: HttpStreamTerminationReason,
    ) -> HttpStreamTerminationReason {
        let winning_reason = self.lease.finish(requested_reason);
        self.finished = true;
        winning_reason
    }

    fn finish_poll(
        &mut self,
        requested_reason: HttpStreamTerminationReason,
    ) -> std::task::Poll<Option<Result<Vec<u8>, String>>> {
        let stream_id = self.lease.stream_id();
        let winning_reason = self.finish(requested_reason);
        transferred_termination_poll(stream_id, winning_reason)
    }
}

impl futures_util::Stream for HttpTransferredStream {
    type Item = Result<Vec<u8>, String>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.finished {
            return std::task::Poll::Ready(None);
        }
        let this = self.as_mut().get_mut();
        match this.poll_event(context) {
            std::task::Poll::Ready(HttpTransferredEvent::Chunk(bytes)) => {
                std::task::Poll::Ready(Some(Ok(bytes)))
            }
            std::task::Poll::Ready(HttpTransferredEvent::Error(error)) => {
                let stream_id = this.lease.stream_id();
                let winning_reason = this.finish(HttpStreamTerminationReason::Finished);
                if winning_reason == HttpStreamTerminationReason::Finished {
                    std::task::Poll::Ready(Some(Err(error)))
                } else {
                    transferred_termination_poll(stream_id, winning_reason)
                }
            }
            std::task::Poll::Ready(HttpTransferredEvent::End) => {
                this.finish_poll(HttpStreamTerminationReason::Finished)
            }
            std::task::Poll::Ready(HttpTransferredEvent::Terminated(reason)) => {
                this.finish_poll(reason)
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

pub(crate) struct HttpStreamClaim {
    pub(crate) service: Arc<HttpStreamService>,
    stream_id: u64,
    generation: u64,
    armed: bool,
}

impl HttpStreamClaim {
    fn take_source(mut self) -> Result<HttpChunkStream, String> {
        let source = self
            .service
            .checkout_transfer(self.stream_id, Some(self.generation));
        if source.is_ok() {
            self.armed = false;
        }
        source.map(|source| Box::pin(source) as HttpChunkStream)
    }
}

impl Drop for HttpStreamClaim {
    fn drop(&mut self) {
        if self.armed {
            self.armed = false;
            let service = self.service.clone();
            let stream_id = self.stream_id;
            let generation = self.generation;
            run_http_cleanup_from_drop(move || {
                service.release_claim(stream_id, generation);
            });
        }
    }
}

pub(crate) fn http_stream_service() -> Arc<HttpStreamService> {
    asyncrt::runtime_services().http_streams()
}

fn register_http_stream(source: HttpStreamSource) -> Option<u64> {
    http_stream_service().register_source(source)
}

pub(crate) fn claim_http_stream(stream_id: u64) -> Option<HttpStreamClaim> {
    http_stream_service().claim(stream_id)
}

/// Encode a host response for the JS side. A text body crosses as a
/// JS string (cheap, lossless), binary as a byte array, and a streaming body
/// by id — serializing a Vec<u8> as a JSON number array is the dominant cost
/// for real DO responses.
///
/// `ws_target` names the calling request and generation on the paths that can answer with a
/// WebSocket upgrade: a Durable Object or facet call, a service-binding call,
/// a Worker Loader entrypoint, and a `globalOutbound` Fetcher. A Durable
/// Object's socket crosses as its target. A stateless Worker's socket lives
/// in the isolate that answered, so it is parked for the calling request
/// under a token that only that request receives (`wsWorker`). Every other path has nowhere to put a
/// socket, so a response that carries one is an error rather than a socket
/// silently dropped.
///
/// A streamed body's id is registered for `stream_owner`, the code that made
/// the call: only it may read the body, or send it on.
pub(crate) fn encode_http_response(
    mut response: HttpResponse,
    ws_target: Option<crate::ws_registry::WsCaller>,
    stream_owner: Option<WsOwner>,
    stream_service: &Arc<HttpStreamService>,
) -> Result<String, String> {
    let mut obj = serde_json::json!({
        "status": response.status,
        "headers": response.headers,
    });
    match (ws_target, response.websocket.take()) {
        (Some(_), None) => obj["wsTarget"] = serde_json::Value::Null,
        (Some(caller), Some(HttpResponseWebSocket::Cell(target))) => {
            // The name reaches the caller's JavaScript, which can use it only
            // under this grant.
            crate::ws_registry::ws_grant(&target, caller.owner, &caller.retired)?;
            obj["wsTarget"] = serde_json::json!(target);
        }
        (Some(caller), Some(HttpResponseWebSocket::Worker(socket))) => {
            let token = crate::ws_registry::park_worker_handoff(socket, caller.issuer)?;
            obj["wsWorker"] = serde_json::Value::String(token.as_str().to_string());
        }
        (None, None) => {}
        // Dropping a Worker socket releases it. A Durable Object target has
        // no path here at all: no caller without a WebSocket route reaches a
        // Durable Object.
        (None, Some(_)) => {
            return Err("a WebSocket response reached a call that cannot carry one".into());
        }
    }
    if let Some(stream) = response.stream.take() {
        let Some(stream_id) =
            stream_service.register_source_for(HttpStreamSource::Stream(stream), stream_owner)
        else {
            return Err(HTTP_STREAM_REGISTRATION_CLOSED.into());
        };
        obj["streamId"] = serde_json::json!(stream_id);
    } else {
        match std::str::from_utf8(&response.body) {
            Ok(text) => obj["body"] = serde_json::Value::String(text.into()),
            Err(_) => obj["bodyBytes"] = serde_json::json!(response.body),
        }
    }
    Ok(obj.to_string())
}

/// Reclaims a streamed request body if a host dispatch fails before the
/// target installs a request context. A successful dispatch disarms this
/// fallback because the target context then owns the unread tail.
pub struct RequestBodyGuard(pub(crate) Option<HttpStreamClaim>);

impl RequestBodyGuard {
    pub fn of(body: &RequestBody) -> Self {
        Self(body.stream_id().and_then(claim_http_stream))
    }

    pub(crate) fn transferred(claim: HttpStreamClaim) -> Self {
        Self(Some(claim))
    }

    pub fn disarm(&mut self) {
        drop(self.0.take());
    }

    pub(crate) fn take_stream(&mut self, stream_id: u64) -> Result<HttpChunkStream, String> {
        let Some(claim) = self.0.take() else {
            return Err(format!("body stream {stream_id} is not registered"));
        };
        if claim.stream_id != stream_id {
            let claimed = claim.stream_id;
            self.0 = Some(claim);
            return Err(format!(
                "body stream {stream_id} does not match ownership claim {claimed}"
            ));
        }
        claim.take_source()
    }
}

impl Drop for RequestBodyGuard {
    fn drop(&mut self) {
        let claim = self.0.take();
        run_http_cleanup_from_drop(|| drop(claim));
    }
}

/// Take exclusive ownership of a registered request source.
///
/// The returned stream removes the registry hop, so its eventual consumer
/// supplies the backpressure and dropping that consumer cancels the source.
pub fn take_body_stream(stream_id: u64) -> Result<HttpChunkStream, String> {
    http_stream_service()
        .checkout_transfer(stream_id, None)
        .map(|source| Box::pin(source) as HttpChunkStream)
}

pub(crate) async fn next_http_stream_chunk(
    source: &mut HttpStreamSource,
) -> Result<Option<Vec<u8>>, String> {
    match source {
        HttpStreamSource::Response(response) => response
            .chunk()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|error| format!("response stream: {error}")),
        HttpStreamSource::Receiver(receiver) => match receiver.recv().await {
            Some(Ok(bytes)) => Ok(Some(bytes)),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        },
        HttpStreamSource::Stream(stream) => stream.next().await.transpose(),
    }
}

pub(crate) fn settle_http_stream_read(
    mut lease: HttpSourceLease,
    source: HttpStreamSource,
    next: Option<Result<Option<Vec<u8>>, String>>,
) -> Result<Option<Vec<u8>>, String> {
    lease.settled = true;
    let service = lease.service.clone();
    let result = next.unwrap_or_else(|| {
        HttpStreamService::termination_result(lease.stream_id, lease.termination.reason())
    });
    service.complete_pull(&lease, source, result)
}

/// Build the future used by the JavaScript read op.
///
/// Checkout stays synchronous because the op reserves the source before it
/// enqueues asynchronous work. Internal tests call this constructor so they
/// exercise the same checkout and completion transitions as the op.
pub(crate) fn http_stream_read(
    service: Arc<HttpStreamService>,
    stream_id: u64,
) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send + 'static {
    let checkout = service.checkout_source(stream_id);
    async move {
        let (lease, source) = checkout?;
        let mut pull = HttpPull { lease, source };
        let termination = pull.lease.termination.clone();
        let next = crate::asyncrt::select! {
            result = next_http_stream_chunk(&mut pull.source) => Some(result),
            _ = futures_util::future::poll_fn(|context| termination.poll_reason(context)) => None,
        };
        let HttpPull { lease, source } = pull;
        settle_http_stream_read(lease, source, next)
    }
}

#[cfg(all(test, celld_internal_tests))]
pub(crate) fn http_stream_read_source_first_for_test(
    service: Arc<HttpStreamService>,
    stream_id: u64,
) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send + 'static {
    let checkout = service.checkout_source(stream_id);
    async move {
        let (lease, source) = checkout?;
        let mut pull = HttpPull { lease, source };
        let termination = pull.lease.termination.clone();
        let next = crate::asyncrt::select_biased! {
            "the source-first test probe makes a ready source win a termination tie";
            result = next_http_stream_chunk(&mut pull.source) => Some(result),
            _ = futures_util::future::poll_fn(|context| termination.poll_reason(context)) => None,
        };
        let HttpPull { lease, source } = pull;
        settle_http_stream_read(lease, source, next)
    }
}

pub(crate) async fn response_stream_write(
    service: Arc<HttpStreamService>,
    stream_id: u64,
    bytes: Option<Vec<u8>>,
) -> Result<(), String> {
    let Some(bytes) = bytes else {
        return Err("response stream chunks must be ArrayBuffer views".into());
    };
    // Acquire on the first poll. Merely constructing and dropping this
    // future cannot read the Domain clock or create transient activity.
    let activity = service
        .begin_activity(stream_id, HttpStreamActivityKind::Write)
        .map_err(|error| error.write_message().to_string())?;
    if activity.writer.send(Ok(bytes)).await.is_err() {
        activity.lease.cancel_pair();
        return Err(RESPONSE_STREAM_CONSUMER_CANCELED.into());
    }
    activity.lease.succeed(false);
    Ok(())
}

pub(crate) async fn response_stream_close(
    service: Arc<HttpStreamService>,
    stream_id: u64,
    error: String,
) -> Result<(), String> {
    // Missing and expired writers preserve the producer harness's
    // idempotent close contract. A live close reservation is different: a
    // second terminal operation must not race the first one.
    let activity = match service.begin_activity(stream_id, HttpStreamActivityKind::Close) {
        Ok(activity) => activity,
        Err(HttpStreamActivityError::Closed) => return Err(HTTP_STREAM_REGISTRATION_CLOSED.into()),
        Err(HttpStreamActivityError::Gone) => return Ok(()),
        Err(HttpStreamActivityError::Closing) => {
            return Err(RESPONSE_STREAM_CLOSE_IN_PROGRESS.into())
        }
    };
    if error.is_empty() {
        let _ = activity.finished.send(true);
    } else {
        if activity.writer.send(Err(error)).await.is_err() {
            activity.lease.cancel_pair();
            return Ok(());
        }
        // A cancelled backpressured close must leave the producer watch
        // open. Publish completion only after the terminal item is queued.
        let _ = activity.finished.send(true);
    }
    activity.lease.succeed(true);
    Ok(())
}

/// Move a host response source into a directly-polled stream. No pump task is
/// needed: the eventual HTTP or JS consumer supplies the backpressure.
fn http_chunk_stream(source: HttpStreamSource) -> HttpChunkStream {
    match source {
        HttpStreamSource::Response(response) => Box::pin(response.bytes_stream().map(|chunk| {
            chunk
                .map(|bytes| bytes.to_vec())
                .map_err(|error| format!("response stream: {error}"))
        })),
        HttpStreamSource::Receiver(receiver) => {
            Box::pin(tokio_stream::wrappers::ReceiverStream::new(receiver))
        }
        HttpStreamSource::Stream(stream) => stream,
    }
}

/// Host-native tee for an outbound response. Both branches are represented by
/// stream IDs, so one can be returned through Axum while JS independently
/// scans the other for observability or usage accounting.
pub(crate) type HttpTeePump = Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// Charges the bytes a tee holds for its slower branch to the isolate whose
/// body it is, or refuses them. The guard gives them back when dropped.
pub(crate) type HttpTeeCharge = Box<dyn Fn(usize) -> Option<Box<dyn Send + Sync>> + Send + Sync>;

/// workerd's error once a tee's slower branch would hold more than the
/// buffering limit: kj's "tee buffer size limit exceeded" as `api/util.c++`
/// translates it. Both branches get it after what they already hold.
pub(crate) const HTTP_TEE_BUFFER_LIMIT: &str = "ReadableStream.tee() buffer limit exceeded. \
This error usually occurs when a Request or Response with a large body is cloned, then only \
one of the clones is read, forcing the Workers runtime to buffer the entire body in memory. \
To fix this issue, remove unnecessary calls to Request/Response.clone() and \
ReadableStream.tee(), and always read clones/tees in parallel.";

type HttpTeeItem = Result<Vec<u8>, String>;

/// One branch of a tee: its channel, and what the channel had no room for.
/// `sender` is `None` once the branch is done: its consumer went away, or it
/// has everything the source gave.
struct HttpTeeBranch {
    sender: Option<tokio::sync::mpsc::Sender<HttpTeeItem>>,
    held: std::collections::VecDeque<(HttpTeeItem, Option<Box<dyn Send + Sync>>)>,
}

impl HttpTeeBranch {
    /// Move held items into the channel while it has room.
    fn flush(&mut self) {
        // A consumer that went away is seen here even when the branch holds
        // nothing: its channel then still reports room, as a dropped
        // receiver gives its permits back.
        if self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.is_closed())
        {
            self.close();
        }
        while let Some(sender) = &self.sender {
            // The charge is given back as the item reaches the channel.
            let Some((item, charge)) = self.held.pop_front() else {
                return;
            };
            match sender.try_send(item) {
                Ok(()) => {}
                Err(tokio::sync::mpsc::error::TrySendError::Full(item)) => {
                    self.held.push_front((item, charge));
                    return;
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => self.close(),
            }
        }
    }

    fn close(&mut self) {
        self.sender = None;
        self.held.clear();
    }

    /// Whether the branch has room for the source's next item now.
    fn wants(&self) -> bool {
        self.held.is_empty() && self.sender.as_ref().is_some_and(|s| s.capacity() > 0)
    }

    async fn room(&self) {
        match &self.sender {
            Some(sender) => match sender.reserve().await {
                // The permit only shows there is room; the item goes in
                // through `flush`.
                Ok(permit) => drop(permit),
                Err(_) => std::future::pending().await,
            },
            None => std::future::pending().await,
        }
    }

    /// A live branch's consumer going away; never, for a done branch, which
    /// the loop has already dealt with.
    async fn closed(&self) {
        match &self.sender {
            Some(sender) => sender.closed().await,
            None => std::future::pending().await,
        }
    }

    /// The branch has no consumer: it went away, or the branch is done.
    async fn gone(&self) {
        if let Some(sender) = &self.sender {
            sender.closed().await;
        }
    }
}

/// Tee a host stream as workerd does (`kj::newTee`): the source is read as
/// fast as the faster branch reads, and the slower branch holds what it has
/// not read yet, so one branch can be read to its end before the other.
/// Each branch's channel holds `HTTP_TEE_BRANCH_CAPACITY` chunks; beyond that
/// the slower branch's chunks are charged with `charge`. A chunk the charge
/// refuses stops the tee as workerd's buffering limit does: both branches end
/// with `HTTP_TEE_BUFFER_LIMIT` after what they hold, and the source is
/// cancelled. The branches belong to `owner`, the code that teed.
pub(crate) fn prepare_http_stream_tee(
    service: &Arc<HttpStreamService>,
    source: HttpTransferredStream,
    charge: HttpTeeCharge,
    owner: Option<WsOwner>,
) -> Result<((u64, u64), HttpTeePump), &'static str> {
    let (tx1, rx1) = tokio::sync::mpsc::channel(HTTP_TEE_BRANCH_CAPACITY);
    let (tx2, rx2) = tokio::sync::mpsc::channel(HTTP_TEE_BRANCH_CAPACITY);
    let Some(id1) = service.register_source_for(HttpStreamSource::Receiver(rx1), owner.clone())
    else {
        return Err(HTTP_STREAM_REGISTRATION_CLOSED);
    };
    let Some(id2) = service.register_source_for(HttpStreamSource::Receiver(rx2), owner) else {
        service.cancel_source(id1);
        return Err(HTTP_STREAM_REGISTRATION_CLOSED);
    };
    let termination = source.termination_handle();
    let pump = Box::pin(async move {
        let branch = |sender| HttpTeeBranch {
            sender: Some(sender),
            held: Default::default(),
        };
        let mut branches = [branch(tx1), branch(tx2)];
        // Dropped once it has given its last item: its end, an error, or the
        // buffering limit's. The branches then only take what they hold.
        let mut source = Some(source);
        loop {
            let ended = source.is_none();
            for branch in &mut branches {
                branch.flush();
                if ended && branch.held.is_empty() {
                    branch.close();
                }
            }
            if branches.iter().all(|branch| branch.sender.is_none()) {
                break;
            }
            // A cancelled source ends the tee at once, as it did before
            // anything was held.
            if !ended && termination.reason() != HttpStreamTerminationReason::Live {
                break;
            }
            let [first, second] = &branches;
            if ended || !(first.wants() || second.wants()) {
                // Nothing can move until a branch reads or goes away, or the
                // source is cancelled.
                asyncrt::select_biased! {
                    "a cancelled source wins a tie so no item is handed on after it";
                    _ = futures_util::future::poll_fn(|context| termination.poll_reason(context)), if !ended => {},
                    _ = first.room() => {},
                    _ = second.room() => {},
                    _ = first.closed() => {},
                    _ = second.closed() => {},
                }
                continue;
            }
            let Some(stream) = source.as_mut() else {
                unreachable!("a tee with a source to read has not ended");
            };
            // A permanently pending source does not wake when its consumers
            // disappear. Observe both receivers in the same poll, and prefer
            // their committed closure when the source is also ready.
            let all_closed = async {
                first.gone().await;
                second.gone().await;
            };
            let event = asyncrt::select_biased! {
                "closed tee consumers win a tie so the pump cannot read another source item";
                _ = all_closed => None,
                event = futures_util::future::poll_fn(|context| stream.poll_event(context)) => Some(event),
            };
            let Some(event) = event else {
                continue;
            };
            let item = match event {
                HttpTransferredEvent::Chunk(bytes) => Ok(bytes),
                HttpTransferredEvent::Error(error) => Err(error),
                HttpTransferredEvent::End => {
                    stream.finish(HttpStreamTerminationReason::Finished);
                    source = None;
                    continue;
                }
                HttpTransferredEvent::Terminated(_) => break,
            };
            if item.is_err() {
                stream.finish(HttpStreamTerminationReason::Finished);
                source = None;
            }
            // The chunk goes straight into the channel of a branch that has
            // room, and is held, and charged, for one that has not.
            let mut held = [None, None];
            let mut refused = false;
            for (index, branch) in branches.iter().enumerate() {
                if branch.sender.is_none() || branch.wants() {
                    continue;
                }
                if let Ok(bytes) = &item {
                    match charge(bytes.len()) {
                        Some(guard) => held[index] = Some(guard),
                        None => refused = true,
                    }
                }
            }
            if refused {
                // The slower branch would pass the limit: the tee stops for
                // both, as kj's does.
                drop(held);
                if let Some(mut stream) = source.take() {
                    stream.finish(HttpStreamTerminationReason::Cancelled);
                }
                for branch in &mut branches {
                    if branch.sender.is_some() {
                        branch
                            .held
                            .push_back((Err(HTTP_TEE_BUFFER_LIMIT.to_string()), None));
                    }
                }
                continue;
            }
            for (branch, guard) in branches.iter_mut().zip(held) {
                if branch.sender.is_some() {
                    branch.held.push_back((item.clone(), guard));
                }
            }
        }
    });
    Ok(((id1, id2), pump))
}

/// Hand a request body to the isolate as a stream rather than as bytes.
/// The returned id names the stream for `__http_stream_read`, so the
/// Worker pulls each chunk off the socket as it asks for it and the host
/// never holds the whole body.
pub fn register_body_stream(stream: HttpChunkStream) -> Result<u64, String> {
    register_http_stream(HttpStreamSource::Stream(stream))
        .ok_or_else(|| HTTP_STREAM_REGISTRATION_CLOSED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws_registry::tests::worker_socket;

    fn upgrade(websocket: Option<HttpResponseWebSocket>) -> HttpResponse {
        HttpResponse {
            status: 101,
            body: Vec::new(),
            stream: None,
            headers: Vec::new(),
            websocket,
            write_position: None,
            observed_position: None,
        }
    }

    /// A tee of `chunks` chunks of `len` bytes, with a charge that admits at
    /// most `limit` bytes held at once, and the bytes it holds now.
    fn tee(
        chunks: usize,
        len: usize,
        limit: usize,
    ) -> ((u64, u64), Arc<std::sync::atomic::AtomicUsize>) {
        struct Held(Arc<std::sync::atomic::AtomicUsize>, usize);
        impl Drop for Held {
            fn drop(&mut self) {
                self.0.fetch_sub(self.1, Ordering::SeqCst);
            }
        }
        let service = http_stream_service();
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        crate::asyncrt::spawn(async move {
            for _ in 0..chunks {
                if tx.send(Ok(vec![7; len])).await.is_err() {
                    return;
                }
            }
        });
        let id = service
            .register_source(HttpStreamSource::Receiver(rx))
            .unwrap();
        let source = service.checkout_transfer(id, None).unwrap();
        let held = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = held.clone();
        let charge: HttpTeeCharge = Box::new(move |len| {
            let now = counter.fetch_add(len, Ordering::SeqCst) + len;
            if now > limit {
                counter.fetch_sub(len, Ordering::SeqCst);
                return None;
            }
            Some(Box::new(Held(counter.clone(), len)) as Box<dyn Send + Sync>)
        });
        let (ids, pump) = prepare_http_stream_tee(&service, source, charge, None).unwrap();
        crate::asyncrt::spawn(pump);
        (ids, held)
    }

    /// A pump that counts its polls and says when it has ended.
    struct Counted {
        pump: HttpTeePump,
        polls: Arc<std::sync::atomic::AtomicUsize>,
        ended: Arc<std::sync::atomic::AtomicBool>,
    }

    impl std::future::Future for Counted {
        type Output = ();
        fn poll(
            mut self: Pin<&mut Self>,
            context: &mut std::task::Context<'_>,
        ) -> std::task::Poll<()> {
            self.polls.fetch_add(1, Ordering::SeqCst);
            let poll = self.pump.as_mut().poll(context);
            if poll.is_ready() {
                self.ended.store(true, Ordering::SeqCst);
            }
            poll
        }
    }

    /// A tee of a source that sends `chunks` chunks and then idles, open:
    /// its ids, its pump's poll count, and whether the pump has ended.
    fn idle_tee(
        chunks: usize,
    ) -> (
        (u64, u64),
        Arc<std::sync::atomic::AtomicUsize>,
        Arc<std::sync::atomic::AtomicBool>,
    ) {
        let service = http_stream_service();
        let (tx, rx) = tokio::sync::mpsc::channel(chunks.max(1));
        for _ in 0..chunks {
            tx.try_send(Ok(vec![7; 16])).unwrap();
        }
        // The sender stays alive, so the source never ends.
        crate::asyncrt::spawn(async move {
            tx.closed().await;
        });
        let id = service
            .register_source(HttpStreamSource::Receiver(rx))
            .unwrap();
        let source = service.checkout_transfer(id, None).unwrap();
        let charge: HttpTeeCharge = Box::new(|_| Some(Box::new(()) as Box<dyn Send + Sync>));
        let (ids, pump) = prepare_http_stream_tee(&service, source, charge, None).unwrap();
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ended = Arc::new(std::sync::atomic::AtomicBool::new(false));
        crate::asyncrt::spawn(Counted {
            pump,
            polls: polls.clone(),
            ended: ended.clone(),
        });
        (ids, polls, ended)
    }

    /// Wait up to a second for the pump to end; its poll count then.
    async fn ends(
        polls: &std::sync::atomic::AtomicUsize,
        ended: &std::sync::atomic::AtomicBool,
    ) -> usize {
        for _ in 0..100 {
            if ended.load(Ordering::SeqCst) {
                return polls.load(Ordering::SeqCst);
            }
            crate::asyncrt::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!(
            "the tee pump did not end ({} polls)",
            polls.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn a_tee_whose_branches_are_both_cancelled_while_its_source_idles_ends() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let ((first, second), polls, ended) = idle_tee(2);
            crate::asyncrt::sleep(std::time::Duration::from_millis(20)).await;
            http_stream_service().cancel_source(first);
            http_stream_service().cancel_source(second);
            // A pump that spun would be polled without end.
            assert!(ends(&polls, &ended).await < 50);
        });
    }

    #[test]
    fn a_tee_whose_branches_are_cancelled_one_after_the_other_ends() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let ((first, second), polls, ended) = idle_tee(0);
            http_stream_service().cancel_source(first);
            crate::asyncrt::sleep(std::time::Duration::from_millis(20)).await;
            let before = polls.load(Ordering::SeqCst);
            crate::asyncrt::sleep(std::time::Duration::from_millis(50)).await;
            // With one branch left the pump waits on the source, not spinning.
            assert!(polls.load(Ordering::SeqCst) - before < 5);
            assert!(!ended.load(Ordering::SeqCst));
            http_stream_service().cancel_source(second);
            assert!(ends(&polls, &ended).await < 50);
        });
    }

    /// Read a stream to its end: the bytes read, and the error that ended it.
    async fn drain(id: u64) -> (usize, Option<String>) {
        let mut total = 0;
        loop {
            match http_stream_read(http_stream_service(), id).await {
                Ok(Some(bytes)) => total += bytes.len(),
                Ok(None) => return (total, None),
                Err(error) => return (total, Some(error)),
            }
        }
    }

    #[test]
    fn a_tee_branch_reads_to_its_end_before_the_other_is_read() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let chunks = HTTP_TEE_BRANCH_CAPACITY * 4;
            let ((first, second), held) = tee(chunks, 1024, usize::MAX);
            assert_eq!(drain(first).await, (chunks * 1024, None));
            // The second branch holds all but what its channel has room for.
            assert_eq!(
                held.load(Ordering::SeqCst),
                (chunks - HTTP_TEE_BRANCH_CAPACITY) * 1024
            );
            assert_eq!(drain(second).await, (chunks * 1024, None));
            assert_eq!(held.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn a_tee_past_its_limit_ends_both_branches_with_workerds_error() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let limit = 8 * 1024;
            let ((first, second), held) = tee(HTTP_TEE_BRANCH_CAPACITY * 4, 1024, limit);
            let (read, error) = drain(first).await;
            assert_eq!(error.as_deref(), Some(HTTP_TEE_BUFFER_LIMIT));
            // What the first branch read, the second still has, then the
            // same error.
            assert_eq!(read, (HTTP_TEE_BRANCH_CAPACITY + 8) * 1024);
            assert_eq!(
                drain(second).await,
                (read, Some(HTTP_TEE_BUFFER_LIMIT.to_string()))
            );
            assert_eq!(held.load(Ordering::SeqCst), 0);
        });
    }

    /// A stream id answers only the code it was handed to: the owner it was
    /// registered for, the handler that claimed an incoming body, and the
    /// code that teed it, for each branch.
    #[test]
    fn a_stream_answers_only_its_owner() {
        crate::asyncrt::test_host_runtime().block_on(async {
            use HttpStreamAccess::*;
            let service = http_stream_service();
            let request = WsOwner::Request(u64::MAX - 10);
            let other = WsOwner::Request(u64::MAX - 11);
            let cell = WsOwner::Cell("owned-a".into());
            let (_sender, receiver) = tokio::sync::mpsc::channel(1);
            let id = service
                .register_source_for(HttpStreamSource::Receiver(receiver), Some(request.clone()))
                .unwrap();
            assert_eq!(service.access(id, &request), Owned);
            assert_eq!(service.access(id, &other), Other { object: false });
            assert_eq!(service.access(id, &cell), Other { object: false });

            // An incoming body is no one's until its handler claims it.
            let (_sender, receiver) = tokio::sync::mpsc::channel(1);
            let incoming = service
                .register_source(HttpStreamSource::Receiver(receiver))
                .unwrap();
            assert_eq!(service.access(incoming, &cell), Other { object: false });
            let claim = service.claim_for(incoming, cell.clone()).unwrap();
            assert_eq!(service.access(incoming, &cell), Owned);
            assert_eq!(service.access(incoming, &request), Other { object: false });
            // Another Durable Object is told so in workerd's words for one.
            assert_eq!(
                service.access(incoming, &WsOwner::Cell("owned-b".into())),
                Other { object: true }
            );
            drop(claim);
            assert_eq!(service.access(incoming, &cell), Unknown);

            // A body sent on to another handler becomes that handler's when it
            // claims it: the sender no longer owns it.
            let (_sender, receiver) = tokio::sync::mpsc::channel(1);
            let sent = service
                .register_source_for(HttpStreamSource::Receiver(receiver), Some(request.clone()))
                .unwrap();
            let claim = service.claim_for(sent, cell.clone()).unwrap();
            assert_eq!(service.access(sent, &cell), Owned);
            assert_eq!(service.access(sent, &request), Other { object: false });
            drop(claim);

            // A facet is a Durable Object of its own, not its parent.
            let facet = WsOwner::Cell(crate::engine_api::facet_cell("owned-a", &["child".into()]));
            let (_sender, receiver) = tokio::sync::mpsc::channel(1);
            let parents = service
                .register_source_for(HttpStreamSource::Receiver(receiver), Some(cell.clone()))
                .unwrap();
            assert_eq!(service.access(parents, &facet), Other { object: true });
            service.cancel_source(parents);

            // A tee's branches belong to the code that teed.
            let source = service.checkout_transfer(id, None).unwrap();
            let charge: HttpTeeCharge = Box::new(|_| Some(Box::new(()) as Box<dyn Send + Sync>));
            let ((left, right), pump) =
                prepare_http_stream_tee(&service, source, charge, Some(request.clone())).unwrap();
            for branch in [left, right] {
                assert_eq!(service.access(branch, &request), Owned);
                assert_eq!(service.access(branch, &other), Other { object: false });
                service.cancel_source(branch);
                assert_eq!(service.access(branch, &request), Unknown);
            }
            drop(pump);
        });
    }

    #[test]
    fn encoding_a_worker_socket_parks_it_registered() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            let encoded = encode_http_response(
                upgrade(Some(HttpResponseWebSocket::Worker(socket))),
                Some(crate::ws_registry::WsCaller {
                    issuer: crate::ws_registry::WorkerHandoffIssuer {
                        generation: 1,
                        request: u64::MAX,
                    },
                    owner: crate::ws_registry::WsOwner::Request(u64::MAX),
                    retired: Default::default(),
                }),
                None,
                &http_stream_service(),
            )
            .unwrap();
            let encoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();
            assert!(encoded.get("wsTarget").is_none());
            let token = encoded["wsWorker"]
                .as_str()
                .expect("a handoff token")
                .to_string();
            // The server end can still send and receive while the socket waits
            // for its caller, and the caller's token names it.
            assert!(queue.registered());
            let token = crate::ws_registry::WorkerHandoffToken::from(token);
            let caller = crate::ws_registry::adopt_worker_handoff(
                &token,
                u64::MAX,
                crate::ws_registry::WsOwner::Request(u64::MAX),
            )
            .expect("parked");
            let (socket, taken_caller) =
                crate::ws_registry::take_worker_handoff(&token, u64::MAX).expect("adopted");
            assert_eq!(socket.id(), queue.0);
            assert_eq!(taken_caller, caller);
            assert_ne!(caller, queue.0);
        });
    }

    #[test]
    fn a_socket_on_a_call_without_a_websocket_route_is_an_error() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            let encoded = encode_http_response(
                upgrade(Some(HttpResponseWebSocket::Worker(socket))),
                None,
                None,
                &http_stream_service(),
            );
            assert_eq!(
                encoded.unwrap_err(),
                "a WebSocket response reached a call that cannot carry one"
            );
            // Released, not leaked: nothing can reach the socket any more.
            assert!(!queue.registered());
        });
    }
}
