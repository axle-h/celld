// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The WebSocket registry: the sockets an instance holds, the frames waiting
//! to leave, and the isolate-polled input queues. Engine-neutral; the V8 ops
//! stay in `crate::js::websocket`, which re-exports every item at its old
//! path.
use crate::asyncrt;
use crate::engine_api::WsTarget;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub struct OutboundWsReq {
    pub scope: String,
    pub id: u64,
    pub url: String,
    pub protocols: Vec<String>,
    /// Present for an isolate-polled (Worker) socket. Created and registered
    /// on the JS thread before the request is sent, so `__ws_next` can never
    /// run ahead of its own queue.
    pub pull: Option<WsPullSender>,
    /// Extra request headers, for the `fetch()` upgrade form.
    pub headers: Vec<(String, String)>,
    /// A `fetch()` upgrade wants the whole handshake outcome, including the
    /// ordinary response a server that declines to upgrade sent instead.
    pub want_response: bool,
    /// A socket already upgraded in this process, which this request joins
    /// instead of dialing `url`. It is the cell end of a Durable Object
    /// subrequest whose caller kept the client end, so there is no handshake
    /// to run and no connection to open: the host only has to carry frames
    /// between two isolates.
    pub target: Option<WsTarget>,
    /// The facet that dialed, when `scope` names a Durable Object facet. The
    /// op derives it from the running event, so the socket routes through
    /// the facet's root and never names the facet as a cell.
    pub facet: Option<FacetSocket>,
    /// The container address a `getTcpPort()` upgrade may reach past the
    /// egress policy, looked up by the host. `None` for any other socket.
    pub exempt: Option<std::net::SocketAddr>,
    pub reply: tokio::sync::oneshot::Sender<Result<OutboundWsOpen>>,
    /// Releases what the op registered for `id` unless the connector takes
    /// the socket over and disarms it. It travels with the request, so a
    /// request that no task ever runs releases the socket as it drops.
    pub release: WsDialGuard,
}

/// The ordinary HTTP response a server sent instead of upgrading. `fetch()`
/// returns it verbatim rather than turning it into a connection error.
pub struct DeclinedUpgrade {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// What an outbound handshake produced.
pub struct OutboundWsOpen {
    pub protocol: Option<String>,
    pub declined: Option<DeclinedUpgrade>,
}

/// Outbound WebSocket traffic from a DO's `ws.send`/`ws.close`. The host holds
/// the socket in a task decoupled from the isolate (so the cell can hibernate
/// while the socket lives); `ws.send` routes here by wsId.
pub enum WsOut {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

/// Outbound frames together with any positions already reserved in their sockets.
/// Captured sends reserve positions inside the isolate, before a later RPC can
/// send. The reservation travels through the handler and Actor gate with the
/// batch; reconstructing a plain vector at either handoff loses send order.
pub struct WsBatch(WsBatchState);

enum WsBatchState {
    Frames(Vec<(u64, WsOut)>),
    Captured(CapturedWsBatch),
}

struct CapturedWsBatch {
    registry: Arc<std::sync::Mutex<WsRegistry>>,
    state: Arc<WsFlushState>,
    /// The one flush that owns every segment this batch reserved. `None`
    /// only until the first frame, since a guard must name a segment.
    flush: Option<WsFlushGuard>,
    /// The newest segment `flush` holds on each socket, by token. A map, so a
    /// broadcast to many sockets does not scan every earlier segment per frame.
    tails: HashMap<u64, u64>,
    frames: usize,
}

impl Default for WsBatch {
    fn default() -> Self {
        Self(WsBatchState::Frames(Vec::new()))
    }
}

impl WsBatch {
    pub fn len(&self) -> usize {
        match &self.0 {
            WsBatchState::Frames(frames) => frames.len(),
            WsBatchState::Captured(batch) => batch.frames,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(crate) fn capture(&mut self, id: u64, out: WsOut) {
        if let WsBatchState::Frames(frames) = &self.0 {
            assert!(frames.is_empty(), "capture starts with an empty batch");
            self.0 = WsBatchState::Captured(CapturedWsBatch {
                registry: ws_registry(),
                state: ws_flush_state(),
                flush: None,
                tails: HashMap::new(),
                frames: 0,
            });
        }
        let WsBatchState::Captured(batch) = &mut self.0 else {
            unreachable!("capture installs its ordered batch");
        };
        batch
            .state
            .capture(&mut batch.flush, &mut batch.tails, id, out);
        batch.frames += 1;
    }

    pub(crate) fn release(self, verdict: Result<(), String>) {
        match self.0 {
            WsBatchState::Captured(mut batch) => {
                if let Some(flush) = batch.flush.take() {
                    flush.release(&batch.registry, verdict);
                }
            }
            WsBatchState::Frames(frames) if verdict.is_ok() && !frames.is_empty() => {
                let flushing = ws_flush_state().emit_or_defer(&ws_registry(), frames, false);
                debug_assert!(flushing.is_none(), "a released batch opens no flush");
            }
            WsBatchState::Frames(_) => {}
        }
    }

    /// A rejected handler never published these frames. Remove its reservations
    /// without cancelling independent events queued behind them.
    pub(crate) fn discard(self) {
        if let WsBatchState::Captured(mut batch) = self.0 {
            if let Some(flush) = batch.flush.take() {
                flush.discard(&batch.registry);
            }
        }
    }
}

impl From<Vec<(u64, WsOut)>> for WsBatch {
    fn from(frames: Vec<(u64, WsOut)>) -> Self {
        Self(WsBatchState::Frames(frames))
    }
}

impl Drop for CapturedWsBatch {
    fn drop(&mut self) {
        // A lost dispatch or cancelled flush has no successful gate verdict.
        // Refuse its reservations so successors cannot hang or cross the gap.
        if let Some(flush) = self.flush.take() {
            flush.release(&self.registry, Err("WebSocket batch abandoned".into()));
        }
    }
}

/// The result of delivering one `webSocketMessage`. `frames` are the outbound
/// frames of the turn the handler answered in, captured by the output gate; a
/// turn the handler suspended in released its own frames as it ended, so those
/// are already gone. `write_position` is the cell's committed-write count
/// after the handler when it advanced past where it stood before — i.e. the
/// handler wrote, and its frames must be held until that position is durable.
/// `None` means no write: flush the frames.
pub struct WsDispatch {
    pub frames: WsBatch,
    pub write_position: Option<u64>,
    /// As on `HttpResponse`: what a handler that wrote nothing observed above
    /// the cell's published baseline, for the gate to hold its frames behind
    /// the proof of another handler's commit.
    pub observed_position: Option<u64>,
}

/// One inbound event on a socket the ISOLATE polls, rather than one the host
/// pushes into a cell.
///
/// A Durable Object socket must survive between events and wake a hibernated
/// cell, so its frames arrive as `CellJob`s. A Worker socket cannot work that
/// way: the stateless pool has no addressable isolate to push into. That is
/// not a limitation to route around — it is exactly the lifetime Cloudflare
/// gives a Worker socket, which lives and dies with its `IoContext`, and
/// `IoContext::close_sockets` is what enforces it here. So the isolate pulls,
/// the same way it already pulls a streamed response body.
pub enum WsPull {
    Open(String),
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String, bool),
}

/// Maximum charged bytes for non-terminal frames in one isolate-polled
/// WebSocket input queue.
pub(crate) const WS_PULL_QUEUE_MAX_BYTES: usize = 1024 * 1024;

/// Tags for the byte frame `__ws_next` resolves with. A tagged buffer keeps a
/// binary message on its fast path instead of base64 through a JSON envelope.
const WS_PULL_TAG_TEXT: u8 = 0;
const WS_PULL_TAG_BINARY: u8 = 1;
const WS_PULL_TAG_OPEN: u8 = 2;
const WS_PULL_TAG_CLOSE: u8 = 3;

impl WsPull {
    pub(crate) fn encode(self) -> Vec<u8> {
        let (tag, mut body) = match self {
            WsPull::Text(text) => (WS_PULL_TAG_TEXT, text.into_bytes()),
            WsPull::Binary(bytes) => (WS_PULL_TAG_BINARY, bytes),
            WsPull::Open(protocol) => (WS_PULL_TAG_OPEN, protocol.into_bytes()),
            WsPull::Close(code, reason, was_clean) => (
                WS_PULL_TAG_CLOSE,
                serde_json::json!({
                    "code": code,
                    "reason": reason,
                    "wasClean": was_clean,
                })
                .to_string()
                .into_bytes(),
            ),
        };
        let mut framed = Vec::with_capacity(body.len() + 1);
        framed.push(tag);
        framed.append(&mut body);
        framed
    }
}

struct WsPullCharge {
    #[cfg(all(test, celld_internal_tests))]
    bytes: usize,
    #[cfg(all(test, celld_internal_tests))]
    queued_bytes: Arc<std::sync::atomic::AtomicUsize>,
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

#[cfg(all(test, celld_internal_tests))]
impl Drop for WsPullCharge {
    fn drop(&mut self) {
        self.queued_bytes
            .fetch_sub(self.bytes, std::sync::atomic::Ordering::Relaxed);
    }
}

struct QueuedWsPull {
    frame: WsPull,
    // Capacity and each non-terminal frame move through the channel together.
    // Every path that consumes or drops that frame therefore returns its queue
    // budget. One terminal frame has no permit because it must release a full
    // queue, but the test observer still measures its retained bytes.
    _charge: WsPullCharge,
}

struct WsPullSendState {
    tx: tokio::sync::mpsc::UnboundedSender<QueuedWsPull>,
    terminal_sent: bool,
}

#[derive(Clone)]
pub struct WsPullSender {
    state: Arc<std::sync::Mutex<WsPullSendState>>,
    #[cfg(all(test, celld_internal_tests))]
    queued_bytes: Arc<std::sync::atomic::AtomicUsize>,
    capacity: Arc<tokio::sync::Semaphore>,
}

pub struct WsPullReceiver {
    rx: tokio::sync::mpsc::UnboundedReceiver<QueuedWsPull>,
    #[cfg(all(test, celld_internal_tests))]
    queued_bytes: Arc<std::sync::atomic::AtomicUsize>,
}

pub fn ws_pull_channel() -> (WsPullSender, WsPullReceiver) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    #[cfg(all(test, celld_internal_tests))]
    let queued_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let capacity = Arc::new(tokio::sync::Semaphore::new(WS_PULL_QUEUE_MAX_BYTES));
    (
        WsPullSender {
            state: Arc::new(std::sync::Mutex::new(WsPullSendState {
                tx,
                terminal_sent: false,
            })),
            #[cfg(all(test, celld_internal_tests))]
            queued_bytes: queued_bytes.clone(),
            capacity,
        },
        WsPullReceiver {
            rx,
            #[cfg(all(test, celld_internal_tests))]
            queued_bytes,
        },
    )
}

impl WsPull {
    fn queue_bytes(&self) -> usize {
        let payload = match self {
            Self::Open(protocol) | Self::Text(protocol) => protocol.len(),
            Self::Binary(bytes) => bytes.len(),
            Self::Close(_, reason, _) => reason.len(),
        };
        std::mem::size_of::<Self>().saturating_add(payload)
    }
}

impl WsPullSender {
    pub fn is_closed(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.terminal_sent || state.tx.is_closed()
    }

    pub async fn send(&self, frame: WsPull) -> Result<(), WsPull> {
        let frame = match frame {
            WsPull::Close(code, reason, was_clean) => {
                return self.send_close(code, reason, was_clean);
            }
            frame => frame,
        };
        let bytes = frame.queue_bytes();
        // One message can exceed this queue limit until the separate incoming
        // message limit rejects it. Reserving the complete budget admits that
        // message only into an empty queue and prevents a second message from
        // increasing its retained peak.
        let permit_bytes = bytes.min(WS_PULL_QUEUE_MAX_BYTES) as u32;
        let permit = match self.capacity.clone().acquire_many_owned(permit_bytes).await {
            Ok(permit) => permit,
            Err(_) => return Err(frame),
        };
        // The terminal sender closes the semaphore before it queues the close.
        // A data sender can already own a permit at that point, so this lock
        // either orders that data before the close or rejects it after the
        // close. Without the shared order, a data frame could enter behind the
        // only terminal frame and keep the receiver open.
        let state = self.state.lock().unwrap();
        if state.terminal_sent {
            return Err(frame);
        }
        #[cfg(all(test, celld_internal_tests))]
        self.queued_bytes
            .fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
        state
            .tx
            .send(QueuedWsPull {
                frame,
                _charge: WsPullCharge {
                    #[cfg(all(test, celld_internal_tests))]
                    bytes,
                    #[cfg(all(test, celld_internal_tests))]
                    queued_bytes: self.queued_bytes.clone(),
                    _permit: Some(permit),
                },
            })
            .map_err(|error| error.0.frame)
    }

    /// Queue the one terminal event without waiting for data capacity.
    ///
    /// The shared state orders the close against a data sender that already
    /// owns capacity. Closing the semaphore wakes every sender that still waits
    /// for capacity, so a stopped isolate cannot keep a host socket task alive.
    pub fn send_close(&self, code: u16, reason: String, was_clean: bool) -> Result<(), WsPull> {
        let frame = WsPull::Close(code, reason, was_clean);
        #[cfg(all(test, celld_internal_tests))]
        let bytes = frame.queue_bytes();
        let mut state = self.state.lock().unwrap();
        if state.terminal_sent {
            return Err(frame);
        }
        state.terminal_sent = true;
        self.capacity.close();
        #[cfg(all(test, celld_internal_tests))]
        self.queued_bytes
            .fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
        state
            .tx
            .send(QueuedWsPull {
                frame,
                _charge: WsPullCharge {
                    #[cfg(all(test, celld_internal_tests))]
                    bytes,
                    #[cfg(all(test, celld_internal_tests))]
                    queued_bytes: self.queued_bytes.clone(),
                    _permit: None,
                },
            })
            .map_err(|error| error.0.frame)
    }
}

impl WsPullSender {
    /// Wait until the reader has taken the terminal frame, or has gone away.
    ///
    /// A reader looks its queue up by socket id for each pull, so removing
    /// the registration while frames wait in it loses them. A sender that
    /// ends a socket waits here first.
    pub(crate) async fn drained(&self) {
        let tx = self.state.lock().unwrap().tx.clone();
        tx.closed().await;
    }
}

impl WsPullReceiver {
    pub(crate) async fn recv(&mut self) -> Option<WsPull> {
        let queued = self.rx.recv().await?;
        let QueuedWsPull { frame, _charge } = queued;
        if matches!(&frame, WsPull::Close(..)) {
            // The sender state prevents a frame from entering behind this one.
            // Close the receiver as part of consuming the terminal event, so a
            // later pull observes the end instead of waiting for sender drops.
            self.rx.close();
        }
        drop(_charge);
        Some(frame)
    }

    #[cfg(all(test, celld_internal_tests))]
    fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(all(test, celld_internal_tests))]
mod input_queue_private {
    include!(env!("CELLD_INTERNAL_WEBSOCKET_TESTS"));
}

/// One socket's inbound queue. Shared so an op can await it without holding
/// the registry lock; one isolate polls a given socket serially.
pub(crate) type WsPullQueue = Arc<tokio::sync::Mutex<WsPullReceiver>>;
type WsPullRegistry = std::sync::Mutex<HashMap<u64, WsPullQueue>>;

/// Inbound queues for isolate-polled sockets, keyed by wsId.
pub(crate) fn ws_pull() -> Arc<WsPullRegistry> {
    asyncrt::services().websockets().pull.clone()
}

pub fn ws_pull_register(id: u64, rx: WsPullReceiver) {
    ws_pull()
        .lock()
        .unwrap()
        .insert(id, Arc::new(tokio::sync::Mutex::new(rx)));
}

pub fn ws_pull_unregister(id: u64) {
    ws_pull().lock().unwrap().remove(&id);
    // The owner goes with the last registration. A socket whose output side
    // is still registered keeps it, so its own code can still close it.
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    if !registry.outputs.contains_key(&id)
        && !registry.metadata.contains_key(&id)
        && !registry.worker_handoffs.contains_key(&id)
    {
        registry.owners.remove(&id);
    }
}

/// The frame channel that a top-level Worker transfers with its 101 response.
///
/// The channel and the socket id move together. Dropping the response before
/// the HTTP upgrade, or ending the upgrade task, therefore removes every host
/// registration instead of leaving a socket that no isolate can reach.
pub struct WorkerWebSocket {
    id: u64,
    inbound: WsPullSender,
}

impl WorkerWebSocket {
    pub(crate) fn new(id: u64, inbound: WsPullSender) -> Self {
        Self { id, inbound }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn inbound(&self) -> WsPullSender {
        self.inbound.clone()
    }
}

impl Drop for WorkerWebSocket {
    fn drop(&mut self) {
        ws_pull_unregister(self.id);
        ws_unregister(self.id);
    }
}

/// How long a parked Worker socket waits for the caller that received its
/// 101 to adopt it.
///
/// Adoption normally follows the response within one isolate turn. A caller
/// that never runs again, because its request was cancelled or its isolate
/// stopped, leaves the target's socket and its event pinned, so the sweep
/// closes it with [`WORKER_HANDOFF_UNADOPTED_CODE`].
pub const WORKER_HANDOFF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How often the sweep looks for parked sockets past
/// [`WORKER_HANDOFF_TIMEOUT`]. A socket can wait this much longer than the
/// timeout before it closes.
pub const WORKER_HANDOFF_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// How long a parked socket of a retiring generation still waits for its
/// caller. Callers of that generation finish their requests, and one that
/// is still running adopts its socket within a turn.
pub const WORKER_HANDOFF_RETIRE_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// The close code a parked socket's server end receives when no caller
/// adopted it, or when its generation retired first.
pub const WORKER_HANDOFF_UNADOPTED_CODE: u16 = 1011;

/// How long a bridge waits for the reply to a Close it carried before it
/// closes the side that sent the Close abnormally.
pub const WORKER_BRIDGE_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How many handed-over sockets one request can hold at once, parked for it
/// or adopted by it but not yet returned or accepted.
///
/// Each one pins the event of the isolate that answered, its input queue,
/// and whatever that server end sends before the caller accepts it. A
/// router passes one socket on per request, and Cloudflare lets a request
/// hold six connections open at once; 64 leaves a fan-out relay ten times
/// that, while one request cannot pin an unbounded number of other events.
pub const WORKER_HANDOFFS_PER_REQUEST: usize = 64;

/// The request a parked socket belongs to: the generation that made the
/// call, and the engine's id for the event that made it. Only that event can
/// adopt the socket, and only that event can then take it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkerHandoffIssuer {
    pub generation: u64,
    pub request: u64,
}

/// The caller a subrequest's response returns to: the request a Worker
/// socket it carries is parked for, and the owner that a Durable Object
/// socket it carries is granted to.
#[derive(Clone, Debug)]
pub(crate) struct WsCaller {
    pub(crate) issuer: WorkerHandoffIssuer,
    pub(crate) owner: WsOwner,
    pub(crate) retired: WsCallerRetired,
}

/// A random name for a parked Worker socket.
///
/// Not the socket id: ids are a per-instance counter, and an application can
/// read and set the id on its own socket objects. The name alone grants
/// nothing: the host also requires the request that made the call.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkerHandoffToken(String);

impl WorkerHandoffToken {
    fn random() -> Self {
        let mut bytes = [0u8; 16];
        rand::RngCore::fill_bytes(&mut asyncrt::rng("worker_handoff"), &mut bytes);
        Self(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for WorkerHandoffToken {
    fn from(token: String) -> Self {
        Self(token)
    }
}

/// Why a handed-over socket could not be parked, adopted or taken.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WorkerHandoffRefusal {
    /// The token names no socket in that state: the sweep or a retirement
    /// closed it, or it was used already.
    Gone,
    /// The socket belongs to another request.
    OtherRequest,
}

/// Who holds a handed-over socket between the response that carried it and
/// the caller's `accept()` or own response.
enum WorkerHandoffHolder {
    /// Parked by the host at this monotonic time. The sweep closes it if
    /// its request does not adopt it.
    Parked { since_ms: u64 },
    /// Adopted by its request, which releases it when it retires. The host
    /// chose `caller`, the id of the caller's own end, at adoption, so an
    /// `accept()` registers under that id and no value the application can
    /// write.
    Adopted { caller: u64 },
}

struct WorkerHandoff {
    socket: WorkerWebSocket,
    issuer: WorkerHandoffIssuer,
    holder: WorkerHandoffHolder,
}

/// When the sweep runs and what it closes. Only tests change it.
#[derive(Clone, Copy)]
struct SweepTiming {
    interval: std::time::Duration,
    timeout: std::time::Duration,
}

const SWEEP_TIMING: SweepTiming = SweepTiming {
    interval: WORKER_HANDOFF_SWEEP_INTERVAL,
    timeout: WORKER_HANDOFF_TIMEOUT,
};

/// Worker sockets that crossed a service binding, a Worker Loader entrypoint
/// or a Durable Object call, by token.
///
/// Each entry owns the socket: dropping it releases the registrations, so
/// every path out of this map either hands the socket to a new owner or
/// closes it.
#[derive(Default)]
pub(crate) struct WorkerHandoffs {
    entries: HashMap<WorkerHandoffToken, WorkerHandoff>,
    /// Whether a sweep task is running for this map.
    sweeping: bool,
}

impl WorkerHandoffs {
    /// Park `socket` for its issuer, or give it back when the issuing request
    /// holds [`WORKER_HANDOFFS_PER_REQUEST`] already.
    fn park(
        &mut self,
        socket: WorkerWebSocket,
        now_ms: u64,
        issuer: WorkerHandoffIssuer,
    ) -> Result<WorkerHandoffToken, WorkerWebSocket> {
        let held = self
            .entries
            .values()
            .filter(|handoff| handoff.issuer.request == issuer.request)
            .count();
        if held >= WORKER_HANDOFFS_PER_REQUEST {
            return Err(socket);
        }
        let token = WorkerHandoffToken::random();
        let replaced = self.entries.insert(
            token.clone(),
            WorkerHandoff {
                socket,
                issuer,
                holder: WorkerHandoffHolder::Parked { since_ms: now_ms },
            },
        );
        assert!(replaced.is_none(), "a 128-bit handoff token repeated");
        Ok(token)
    }

    /// Move a parked socket to the request that made the call. A token
    /// adopts once, and only for that request.
    fn adopt(
        &mut self,
        token: &WorkerHandoffToken,
        request: u64,
        caller: u64,
    ) -> Result<(), WorkerHandoffRefusal> {
        let handoff = self
            .entries
            .get_mut(token)
            .filter(|handoff| matches!(handoff.holder, WorkerHandoffHolder::Parked { .. }))
            .ok_or(WorkerHandoffRefusal::Gone)?;
        if handoff.issuer.request != request {
            return Err(WorkerHandoffRefusal::OtherRequest);
        }
        handoff.holder = WorkerHandoffHolder::Adopted { caller };
        Ok(())
    }

    /// Take an adopted socket out for its new owner, a response or an
    /// `accept()` bridge, with the caller id chosen at adoption.
    fn take_adopted(
        &mut self,
        token: &WorkerHandoffToken,
        request: u64,
    ) -> Result<(WorkerWebSocket, u64), WorkerHandoffRefusal> {
        let handoff = self.entries.get(token).ok_or(WorkerHandoffRefusal::Gone)?;
        if handoff.issuer.request != request {
            return Err(WorkerHandoffRefusal::OtherRequest);
        }
        let WorkerHandoffHolder::Adopted { caller } = handoff.holder else {
            return Err(WorkerHandoffRefusal::Gone);
        };
        let handoff = self.entries.remove(token).expect("the entry was just read");
        Ok((handoff.socket, caller))
    }

    /// Remove every parked socket that waited `timeout` or longer, or that
    /// belongs to the retired generation and waited its grace or longer.
    fn take_unadopted(
        &mut self,
        now_ms: u64,
        timeout: std::time::Duration,
        retired: Option<(u64, std::time::Duration)>,
    ) -> Vec<WorkerWebSocket> {
        let expired: Vec<WorkerHandoffToken> = self
            .entries
            .iter()
            .filter(|(_, handoff)| {
                let WorkerHandoffHolder::Parked { since_ms } = handoff.holder else {
                    return false;
                };
                let waited = now_ms.saturating_sub(since_ms);
                waited >= timeout.as_millis() as u64
                    || retired.is_some_and(|(generation, grace)| {
                        handoff.issuer.generation == generation
                            && waited >= grace.as_millis() as u64
                    })
            })
            .map(|(token, _)| token.clone())
            .collect();
        expired
            .iter()
            .filter_map(|token| self.entries.remove(token))
            .map(|handoff| handoff.socket)
            .collect()
    }

    fn has_parked(&self) -> bool {
        self.entries
            .values()
            .any(|handoff| matches!(handoff.holder, WorkerHandoffHolder::Parked { .. }))
    }
}

/// Close a handed-over socket that no caller uses, then release it once its
/// server end has read the Close: the server end looks its queue up by id
/// for each pull, so releasing at once could replace the Close with 1006.
pub(crate) fn close_handed_over(socket: WorkerWebSocket, code: u16, reason: &str, was_clean: bool) {
    let inbound = socket.inbound();
    let _ = inbound.send_close(code, reason.to_string(), was_clean);
    asyncrt::spawn(async move {
        let _ = asyncrt::timeout(WORKER_BRIDGE_CLOSE_TIMEOUT, inbound.drained()).await;
        drop(socket);
    });
}

fn close_unadopted(socket: WorkerWebSocket, reason: &str) {
    close_handed_over(socket, WORKER_HANDOFF_UNADOPTED_CODE, reason, false);
}

/// workerd has no such limit, so the text is celld's.
pub(crate) const TOO_MANY_WORKER_HANDOFFS: &str =
    "this request holds too many WebSockets that subrequests returned and that it has not \
     returned or accepted yet";

/// Park a Worker socket that a subrequest's 101 carries back to its caller,
/// and name it for that caller.
///
/// The socket keeps its frame channel and its id: the server end in the
/// target's isolate goes on sending to the same registration, and frames it
/// sends before anyone adopts the socket wait in its pre-upgrade buffer. A
/// request over its limit gets an error, and the socket closes with 1011.
pub(crate) fn park_worker_handoff(
    socket: WorkerWebSocket,
    issuer: WorkerHandoffIssuer,
) -> Result<WorkerHandoffToken, String> {
    park_worker_handoff_in(&ws_registry(), socket, issuer, SWEEP_TIMING)
}

fn park_worker_handoff_in(
    registry: &Arc<std::sync::Mutex<WsRegistry>>,
    socket: WorkerWebSocket,
    issuer: WorkerHandoffIssuer,
    timing: SweepTiming,
) -> Result<WorkerHandoffToken, String> {
    let parked = {
        let mut registry = registry.lock().unwrap();
        registry
            .worker_handoff_parks
            .park(socket, asyncrt::mono_ms(), issuer)
            .map(|token| {
                let start_sweep =
                    !std::mem::replace(&mut registry.worker_handoff_parks.sweeping, true);
                (token, start_sweep)
            })
    };
    match parked {
        Ok((token, start_sweep)) => {
            if start_sweep {
                asyncrt::spawn(sweep_worker_handoffs(registry.clone(), timing));
            }
            Ok(token)
        }
        Err(socket) => {
            close_handed_over(
                socket,
                WORKER_HANDOFF_UNADOPTED_CODE,
                "the caller holds too many WebSockets",
                false,
            );
            Err(format!(
                "{TOO_MANY_WORKER_HANDOFFS} (at most {WORKER_HANDOFFS_PER_REQUEST})"
            ))
        }
    }
}

/// Close every parked socket that waited longer than the timeout, until
/// none is parked. A later park starts a new sweep.
///
/// Holds this instance's registry rather than resolving it, for the reason a
/// flush does: the task runs on a runtime with no services of its own.
async fn sweep_worker_handoffs(registry: Arc<std::sync::Mutex<WsRegistry>>, timing: SweepTiming) {
    loop {
        asyncrt::sleep(timing.interval).await;
        let expired = {
            let mut registry = registry.lock().unwrap();
            let expired = registry.worker_handoff_parks.take_unadopted(
                asyncrt::mono_ms(),
                timing.timeout,
                None,
            );
            if expired.is_empty() && !registry.worker_handoff_parks.has_parked() {
                registry.worker_handoff_parks.sweeping = false;
                return;
            }
            expired
        };
        for socket in expired {
            tracing::warn!(
                ws_id = socket.id(),
                "closed a WebSocket handoff that no caller adopted"
            );
            close_unadopted(socket, "no caller adopted this WebSocket");
        }
    }
}

/// Close the parked sockets of a generation that stopped taking work.
///
/// Its callers can still be running, and one that is adopts its socket
/// within a turn, so a socket parked moments ago waits
/// [`WORKER_HANDOFF_RETIRE_GRACE`]. A second pass at the end of the grace
/// closes what was parked before the retirement and is still unadopted.
pub(crate) fn close_generation_worker_handoffs(generation: u64) {
    close_generation_worker_handoffs_in(ws_registry(), generation, WORKER_HANDOFF_RETIRE_GRACE);
}

fn close_generation_worker_handoffs_in(
    registry: Arc<std::sync::Mutex<WsRegistry>>,
    generation: u64,
    grace: std::time::Duration,
) {
    let pass = move |registry: &std::sync::Mutex<WsRegistry>| {
        let expired = registry
            .lock()
            .unwrap()
            .worker_handoff_parks
            .take_unadopted(
                asyncrt::mono_ms(),
                WORKER_HANDOFF_TIMEOUT,
                Some((generation, grace)),
            );
        for socket in expired {
            close_unadopted(socket, "the deployment that made this WebSocket retired");
        }
    };
    pass(&registry);
    asyncrt::spawn(async move {
        asyncrt::sleep(grace).await;
        pass(&registry);
    });
}

/// Give a parked socket to the request that made the call, and choose the
/// id of the caller's own end, which `owner` (the code running that request)
/// owns from here on.
pub(crate) fn adopt_worker_handoff(
    token: &WorkerHandoffToken,
    request: u64,
    owner: WsOwner,
) -> Result<u64, WorkerHandoffRefusal> {
    let caller = ws_next_id();
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    registry
        .worker_handoff_parks
        .adopt(token, request, caller)?;
    registry.owners.insert(caller, owner);
    Ok(caller)
}

/// Take an adopted socket, with its caller's id, for the caller's response
/// or its `accept()`.
pub(crate) fn take_worker_handoff(
    token: &WorkerHandoffToken,
    request: u64,
) -> Result<(WorkerWebSocket, u64), WorkerHandoffRefusal> {
    ws_registry()
        .lock()
        .unwrap()
        .worker_handoff_parks
        .take_adopted(token, request)
}

/// How one direction of a bridge ended.
enum BridgeLeg {
    /// A Close passed through, with its code.
    Closed(u16, String),
    /// The sending side's registration went away without a Close.
    SourceGone,
    /// The receiving side stopped reading.
    DestinationGone,
}

/// Carry one direction of a bridge until a Close passes or a side goes away.
///
/// Each frame waits for room in the receiving queue, so that queue holds at
/// most its budget. The other direction runs separately and is never held
/// up by this one.
async fn carry_bridge_leg(
    from: &mut tokio::sync::mpsc::UnboundedReceiver<WsOut>,
    to: &WsPullSender,
) -> BridgeLeg {
    loop {
        let frame = match from.recv().await {
            Some(WsOut::Text(text)) => WsPull::Text(text),
            Some(WsOut::Binary(bytes)) => WsPull::Binary(bytes),
            Some(WsOut::Close(code, reason)) => {
                let _ = to.send_close(code, reason.clone(), true);
                return BridgeLeg::Closed(code, reason);
            }
            None => return BridgeLeg::SourceGone,
        };
        if to.send(frame).await.is_err() {
            return BridgeLeg::DestinationGone;
        }
    }
}

/// The two ends a bridge joins: the socket the caller accepted, and the
/// handed-over server end in the isolate that answered the subrequest.
pub(crate) struct WorkerHandoffBridge {
    pub(crate) caller: u64,
    pub(crate) caller_pull: WsPullSender,
    pub(crate) from_caller: tokio::sync::mpsc::UnboundedReceiver<WsOut>,
    pub(crate) target: WorkerWebSocket,
    pub(crate) from_target: tokio::sync::mpsc::UnboundedReceiver<WsOut>,
}

/// Carry frames between a caller that accepted a handed-over Worker socket
/// and that socket's server end, which another isolate holds.
///
/// Both ends are isolate-polled, so each direction ends in a pull queue with
/// the usual 1 MiB budget, and each runs on its own.
///
/// A Close from either side reaches the other with the same code and reason.
/// The caller's Close is a question that the server end answers, so the
/// bridge waits up to [`WORKER_BRIDGE_CLOSE_TIMEOUT`] for that reply before
/// it closes the caller abnormally. The server end that closes first cannot
/// observe a reply: celld marks a server socket closed as it sends its Close
/// (plan item 1.17), and a caller's socket ignores `close()` once it is
/// closed. So the bridge ends the server end's queue at once. A side that
/// goes away without a Close closes the other with 1006, which reports an
/// error there.
///
/// Ends with both queues terminated and both sockets unregistered.
pub(crate) async fn bridge_worker_handoff(bridge: WorkerHandoffBridge) {
    bridge_worker_handoff_within(bridge, WORKER_BRIDGE_CLOSE_TIMEOUT).await;
}

async fn bridge_worker_handoff_within(
    bridge: WorkerHandoffBridge,
    close_timeout: std::time::Duration,
) {
    let WorkerHandoffBridge {
        caller,
        caller_pull,
        mut from_caller,
        target,
        mut from_target,
    } = bridge;
    let target_pull = target.inbound();
    {
        let to_target = carry_bridge_leg(&mut from_caller, &target_pull);
        let to_caller = carry_bridge_leg(&mut from_target, &caller_pull);
        tokio::pin!(to_target, to_caller);
        crate::asyncrt::select! {
            leg = &mut to_target => {
                if let BridgeLeg::Closed(..) = leg {
                    // The server end answers the caller's Close. Its handler
                    // chooses the reason, so wait for it.
                    let _ = asyncrt::timeout(close_timeout, &mut to_caller).await;
                }
            }
            leg = &mut to_caller => {
                if let BridgeLeg::Closed(code, reason) = leg {
                    let _ = target_pull.send_close(code, reason, true);
                }
            }
        }
    }
    // Whatever is still open closes abnormally. A queue that already holds
    // its Close refuses a second one.
    let _ = caller_pull.send_close(1006, String::new(), false);
    let _ = target_pull.send_close(1006, String::new(), false);
    // Each side reads what is still queued, its Close last, before its
    // registration goes. A side that stopped reading is not waited for long.
    let _ = asyncrt::timeout(close_timeout, async {
        tokio::join!(caller_pull.drained(), target_pull.drained());
    })
    .await;
    ws_pull_unregister(caller);
    ws_unregister(caller);
    drop(target);
}

/// Release a socket that its request adopted and neither returned nor
/// accepted. The server end sees the close a retiring request gives its own
/// sockets.
pub(crate) fn release_worker_handoff(token: &WorkerHandoffToken, request: u64) {
    let released = ws_registry()
        .lock()
        .unwrap()
        .worker_handoff_parks
        .take_adopted(token, request);
    if let Ok((socket, caller)) = released {
        // Nothing registered the caller's end, which never left this request.
        ws_unregister(caller);
        close_handed_over(socket, 1001, "request ended", true);
    }
}

/// Whether the host still holds an inbound queue for `id`.
///
/// A leak here is invisible from outside the process: the queue holds the
/// receiver whose survival keeps a connector task — and its TCP connection —
/// alive, and a request that dies before its socket is ever registered for
/// output leaves nothing else to observe.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn ws_pull_registered(id: u64) -> bool {
    ws_pull().lock().unwrap().contains_key(&id)
}

pub enum WsIn {
    Text(String),
    Binary(Vec<u8>),
}

impl From<WsIn> for WsPull {
    fn from(frame: WsIn) -> Self {
        match frame {
            WsIn::Text(text) => Self::Text(text),
            WsIn::Binary(bytes) => Self::Binary(bytes),
        }
    }
}

#[doc(hidden)]
pub struct WsMeta {
    pub scope: String,
    pub hibernatable: bool,
    pub tags: Vec<String>,
    /// Structured-clone bytes, not JSON: `serializeAttachment` accepts
    /// anything cloneable, so Date, Map and Set must survive a round trip.
    pub attachment: Option<Vec<u8>>,
    pub pending: Vec<WsOut>,
    /// When the shell last answered this socket with the cell's auto-response,
    /// unix ms. Lives here rather than in the isolate because the reply is
    /// sent while the cell may not be resident at all.
    pub auto_response_at: Option<f64>,
    /// The root cell and facet stream behind a socket that a Durable Object
    /// facet accepted, dialed, or bound. `None` for a socket of an ordinary
    /// cell. `scope` then names the facet.
    pub facet: Option<FacetSocket>,
}

/// Where the events of a facet's socket go, and what proves their output.
///
/// A facet is not a cell: no Worker exports its class under the facet's
/// scope, so routing an event by that scope activated a cell that cannot
/// start (denoland/celld#252). The root cell owns the facet, its residency,
/// and its gate, so the socket routes and registers under `root`. The facet's
/// own writes are proved on `stream` at `epoch`.
///
/// Recorded by the host, never read from a `WsTarget`. A target crosses
/// application JavaScript, which could otherwise name another root.
#[derive(Clone, Debug)]
pub struct FacetSocket {
    pub root: String,
    pub stream: String,
    pub epoch: u64,
    /// The opening of the facet that holds the socket. An event reaches
    /// that opening only, never a later one at the same scope.
    pub opening: u64,
}
/// Who may act on a socket through the ops that JavaScript calls.
///
/// An id is a counter that application code can read, write and guess, so
/// the id alone grants nothing: each op asks whether the code running now
/// owns the socket. The owner is taken from the running event when an op
/// allocates the id, never from a value JavaScript passes.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum WsOwner {
    /// A stateless request, by its `IoContext::handoff_request`. Its sockets
    /// live and die with it, as on Cloudflare.
    Request(u64),
    /// A Durable Object, or a facet, by the scope its events store under.
    /// Every event of that object is the owner, as workerd's actor-wide
    /// IoContext is, so a hibernatable socket answers in later events.
    Cell(String),
}

/// What the running code may do with a socket id.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WsAccess {
    /// The running code owns the socket.
    Owned,
    /// The id names no open socket: it was closed, or was never allocated.
    Unknown,
    /// Another request or Durable Object owns the socket.
    Other,
}

#[derive(Default)]
#[doc(hidden)]
pub struct WsRegistry {
    pub(crate) outputs: HashMap<u64, tokio::sync::mpsc::UnboundedSender<WsOut>>,
    pub metadata: HashMap<u64, WsMeta>,
    pub(crate) worker_handoffs: HashMap<u64, WsPullSender>,
    /// Worker sockets on their way to the caller of a subrequest.
    worker_handoff_parks: WorkerHandoffs,
    /// The owner of each socket that JavaScript can act on. Written only by
    /// the ops that allocate an id, and removed with the socket's last
    /// registration. A socket the host made for itself has none, so no op
    /// reaches it.
    pub(crate) owners: HashMap<u64, WsOwner>,
    /// Durable Object sockets that a response handed to a caller. See
    /// [`ws_grant`].
    grants: WsGrants,
}

/// How long a Durable Object socket that a 101 handed to a caller stays
/// usable by it. A caller takes the socket within a turn of the response,
/// to `accept()` it or to return it, as it adopts a handed-over Worker
/// socket within [`WORKER_HANDOFF_TIMEOUT`].
pub const WS_GRANT_TIMEOUT: std::time::Duration = WORKER_HANDOFF_TIMEOUT;

/// How many such sockets one owner can hold at once, for the reason
/// [`WORKER_HANDOFFS_PER_REQUEST`] bounds handed-over Worker sockets.
pub const WS_GRANTS_PER_OWNER: usize = WORKER_HANDOFFS_PER_REQUEST;

/// workerd has no such limit, so the text is celld's.
pub(crate) const TOO_MANY_WS_GRANTS: &str =
    "this request or Durable Object holds too many WebSockets that subrequests returned and \
     that it has not accepted or returned yet";

/// A Durable Object socket that a subrequest's 101 handed to an owner.
///
/// The target crosses JavaScript as `{id, scope, tunnel}`, which names
/// another object's socket. The grant is what lets the caller use that name,
/// once: to `accept()` the socket, or to return it in its own response.
struct WsGrant {
    target: WsTarget,
    since_ms: u64,
}

/// The grants, by owner, with the owners that hold a grant of each target
/// socket id, so a release or a closing socket does not scan them all.
#[derive(Default)]
struct WsGrants {
    by_owner: HashMap<WsOwner, Vec<WsGrant>>,
    by_target: HashMap<u64, Vec<WsOwner>>,
    /// Whether a sweep task is running for these grants.
    sweeping: bool,
}

impl WsGrants {
    fn grant(&mut self, target: &WsTarget, owner: WsOwner, now_ms: u64) -> Result<(), String> {
        let held = self.by_owner.entry(owner.clone()).or_default();
        if held.len() >= WS_GRANTS_PER_OWNER {
            return Err(format!(
                "{TOO_MANY_WS_GRANTS} (at most {WS_GRANTS_PER_OWNER})"
            ));
        }
        held.push(WsGrant {
            target: target.clone(),
            since_ms: now_ms,
        });
        self.by_target.entry(target.id).or_default().push(owner);
        Ok(())
    }

    /// Remove one index entry of `owner` under `id`.
    fn unindex(&mut self, id: u64, owner: &WsOwner) {
        if let Some(owners) = self.by_target.get_mut(&id) {
            if let Some(index) = owners.iter().position(|held| held == owner) {
                owners.swap_remove(index);
            }
            if owners.is_empty() {
                self.by_target.remove(&id);
            }
        }
    }

    fn take(&mut self, target: &WsTarget, owner: &WsOwner) -> bool {
        let Some(held) = self.by_owner.get_mut(owner) else {
            return false;
        };
        let Some(index) = held.iter().position(|grant| grant.target == *target) else {
            return false;
        };
        held.swap_remove(index);
        if held.is_empty() {
            self.by_owner.remove(owner);
        }
        self.unindex(target.id, owner);
        true
    }

    fn held_elsewhere(&self, target: &WsTarget, owner: &WsOwner) -> bool {
        self.by_target.get(&target.id).is_some_and(|owners| {
            owners.iter().filter(|held| *held != owner).any(|held| {
                self.by_owner
                    .get(held)
                    .is_some_and(|grants| grants.iter().any(|grant| grant.target == *target))
            })
        })
    }

    fn release(&mut self, owner: &WsOwner) {
        for grant in self.by_owner.remove(owner).unwrap_or_default() {
            self.unindex(grant.target.id, owner);
        }
    }

    /// The local socket `id` closed. A target on another node keeps its
    /// grants: its id is that process's, and only release or the sweep
    /// removes them.
    fn target_gone(&mut self, id: u64) {
        let Some(owners) = self.by_target.remove(&id) else {
            return;
        };
        let mut kept = Vec::new();
        for owner in owners {
            let Some(held) = self.by_owner.get_mut(&owner) else {
                continue;
            };
            if let Some(index) = held
                .iter()
                .position(|grant| grant.target.id == id && grant.target.tunnel.is_none())
            {
                held.swap_remove(index);
                if held.is_empty() {
                    self.by_owner.remove(&owner);
                }
            } else {
                kept.push(owner);
            }
        }
        if !kept.is_empty() {
            self.by_target.insert(id, kept);
        }
    }

    /// Remove every grant held `timeout` or longer.
    fn expire(&mut self, now_ms: u64, timeout: std::time::Duration) {
        let timeout = timeout.as_millis() as u64;
        let mut expired = Vec::new();
        self.by_owner.retain(|owner, held| {
            held.retain(|grant| {
                let keep = now_ms.saturating_sub(grant.since_ms) < timeout;
                if !keep {
                    expired.push((grant.target.id, owner.clone()));
                }
                keep
            });
            !held.is_empty()
        });
        for (id, owner) in expired {
            self.unindex(id, &owner);
        }
    }

    fn is_empty(&self) -> bool {
        self.by_owner.is_empty()
    }
}
impl WsRegistry {
    #[doc(hidden)]
    pub fn register(&mut self, id: u64, tx: tokio::sync::mpsc::UnboundedSender<WsOut>) {
        if let Some(meta) = self.metadata.get_mut(&id) {
            for pending in meta.pending.drain(..) {
                let _ = tx.send(pending);
            }
        }
        self.outputs.insert(id, tx);
    }

    fn unregister(&mut self, id: u64) -> Option<WsMeta> {
        self.outputs.remove(&id);
        // A grant of this socket names nothing any more.
        self.grants.target_gone(id);
        self.metadata.remove(&id)
    }

    #[doc(hidden)]
    pub fn emit(&mut self, id: u64, out: WsOut) {
        if let Some(tx) = self.outputs.get(&id) {
            tracing::debug!(ws_id = id, "queued outbound WebSocket frame");
            let _ = tx.send(out);
        } else if let Some(meta) = self.metadata.get_mut(&id) {
            tracing::debug!(ws_id = id, "buffered pre-upgrade WebSocket frame");
            meta.pending.push(out);
        } else {
            // The socket is gone and the frame has nowhere to go. Silence here
            // is what made a held frame indistinguishable from a sent one.
            tracing::warn!(ws_id = id, "dropped a frame for a closed WebSocket");
        }
    }
}
/// Every piece of one instance's WebSocket state.
///
/// A socket's id is allocated by `next_id` here, so an id identifies a socket
/// only within one instance. Each map a socket reaches must therefore belong
/// to the same instance: a map that stayed process-wide would be shared by
/// the sockets that two instances both numbered, and a second instance is not
/// hypothetical: a test can run multiple instances, and a per-isolate or
/// per-generation instance in production would inherit the
/// collision.
pub(crate) struct WebSocketService {
    registry: Arc<std::sync::Mutex<WsRegistry>>,
    regular_counts: Arc<std::sync::Mutex<HashMap<String, usize>>>,
    next_id: AtomicU64,
    auto_responses: Arc<std::sync::Mutex<HashMap<String, (String, String)>>>,
    pull: Arc<WsPullRegistry>,
    flush: Arc<WsFlushState>,
}

impl Default for WebSocketService {
    fn default() -> Self {
        Self {
            registry: Arc::new(std::sync::Mutex::new(WsRegistry::default())),
            regular_counts: Arc::new(std::sync::Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            auto_responses: Arc::new(std::sync::Mutex::new(HashMap::new())),
            pull: Arc::new(std::sync::Mutex::new(HashMap::new())),
            flush: Arc::new(WsFlushState::default()),
        }
    }
}

pub(crate) fn ws_registry() -> Arc<std::sync::Mutex<WsRegistry>> {
    asyncrt::services().websockets().registry.clone()
}

fn regular_ws_counts() -> Arc<std::sync::Mutex<HashMap<String, usize>>> {
    asyncrt::services().websockets().regular_counts.clone()
}
pub(crate) fn increment_regular_ws(scope: &str) {
    *regular_ws_counts()
        .lock()
        .unwrap()
        .entry(scope.to_string())
        .or_default() += 1;
}
pub(crate) fn decrement_regular_ws(scope: &str) {
    let counts = regular_ws_counts();
    let mut counts = counts.lock().unwrap();
    let Some(count) = counts.get_mut(scope) else {
        return;
    };
    *count = count.saturating_sub(1);
    if *count == 0 {
        counts.remove(scope);
    }
}
pub fn has_regular_websocket(scope: &str) -> bool {
    regular_ws_counts()
        .lock()
        .unwrap()
        .get(scope)
        .is_some_and(|count| *count > 0)
}
/// The auto-response pair per cell scope, set by
/// `state.setWebSocketAutoResponse`. Shell state, like the socket registry:
/// the whole point of the feature is answering a matched message while the
/// cell is not resident, so the isolate cannot hold it.
pub(crate) fn ws_auto_responses() -> Arc<std::sync::Mutex<HashMap<String, (String, String)>>> {
    asyncrt::services().websockets().auto_responses.clone()
}

/// The shell's read path asks here before dispatching a text frame. A match
/// returns the response to send on the same socket and stamps the socket's
/// timestamp; the frame then never reaches the cell — no dispatch, no wake.
/// Only hibernatable sockets participate, as in workerd, where matching
/// lives in the hibernation manager's read loop.
pub fn ws_auto_response(scope: &str, id: u64, text: &str) -> Option<String> {
    let response = {
        let pairs = ws_auto_responses();
        let pairs = pairs.lock().unwrap();
        let (request, response) = pairs.get(scope)?;
        if request != text {
            return None;
        }
        response.clone()
    };
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    let meta = registry.metadata.get_mut(&id)?;
    if !meta.hibernatable {
        return None;
    }
    meta.auto_response_at = Some(unix_ms());
    Some(response)
}

fn unix_ms() -> f64 {
    asyncrt::wall_ms() as f64
}

/// Mark a socket as accepted by the facet `scope`, so its events reach the
/// facet through `facet.root`. A socket that `scope` did not accept keeps its
/// own route: a facet can return a socket that another cell accepted.
pub(crate) fn ws_attach_facet(id: u64, scope: &str, facet: FacetSocket) {
    if let Some(meta) = ws_registry().lock().unwrap().metadata.get_mut(&id) {
        if meta.scope == scope {
            meta.facet = Some(facet);
        }
    }
}

/// The facet route of a socket, when a facet accepted it.
pub fn ws_facet(id: u64) -> Option<FacetSocket> {
    ws_registry()
        .lock()
        .unwrap()
        .metadata
        .get(&id)
        .and_then(|meta| meta.facet.clone())
}

/// The cell the core holds `target` under, and whether that registration can
/// hibernate.
///
/// A facet's socket registers under its root, as a socket that cannot
/// hibernate. A root that hibernated would close its facets, and nothing can
/// restart a facet without the root's code: the class came from the root's
/// startup callback. The socket therefore keeps the root resident, as a
/// regular socket does.
pub fn ws_core_registration(target: &WsTarget) -> (String, bool) {
    let registry = ws_registry();
    let registry = registry.lock().unwrap();
    match registry.metadata.get(&target.id) {
        Some(WsMeta {
            facet: Some(facet), ..
        }) => (facet.root.clone(), false),
        meta => (
            target.scope.clone(),
            meta.is_some_and(|meta| meta.hibernatable),
        ),
    }
}

/// Remove the registration of a socket that the facet `scope` accepted for a
/// response that never left. No socket task exists for it, so nothing else
/// would remove it.
pub(crate) fn ws_release_unanswered(id: u64, scope: &str) {
    let accepted = ws_registry()
        .lock()
        .unwrap()
        .metadata
        .get(&id)
        .is_some_and(|meta| meta.scope == scope);
    if accepted {
        ws_unregister(id);
    }
}

/// Register a socket that a facet accepted, through a cfg-gated execution
/// backend that has no facet call to record it.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn ws_register_facet_for_test(
    id: u64,
    scope: &str,
    facet: FacetSocket,
    tx: tokio::sync::mpsc::UnboundedSender<WsOut>,
) {
    ws_register_hibernatable_for_test(id, scope, tx);
    ws_attach_facet(id, scope, facet);
}

pub fn ws_next_id() -> u64 {
    asyncrt::services()
        .websockets()
        .next_id
        .fetch_add(1, Ordering::Relaxed)
}

/// Allocate a socket id that `owner` owns. Only the ops that register a
/// socket call this, so every id JavaScript holds has an owner.
pub(crate) fn ws_allocate(owner: WsOwner) -> u64 {
    let id = ws_next_id();
    ws_registry().lock().unwrap().owners.insert(id, owner);
    id
}

/// Whether `owner` may act on socket `id`.
pub(crate) fn ws_access(id: u64, owner: &WsOwner) -> WsAccess {
    match ws_registry().lock().unwrap().owners.get(&id) {
        Some(recorded) if recorded == owner => WsAccess::Owned,
        Some(_) => WsAccess::Other,
        None => WsAccess::Unknown,
    }
}

/// Whether a caller can still receive what a subrequest's response hands
/// it. Set, under the registry lock, by the caller's retirement, which
/// releases its grants in the same step, so a response that arrives after it
/// grants nothing that no release would remove.
#[derive(Clone, Debug, Default)]
pub(crate) struct WsCallerRetired(Arc<std::sync::atomic::AtomicBool>);

/// Grant `target`, a Durable Object socket that a response hands to the
/// caller, to `owner`, the code running that caller. A caller that retired
/// already gets no grant. An owner over its limit gets an error.
pub(crate) fn ws_grant(
    target: &WsTarget,
    owner: WsOwner,
    retired: &WsCallerRetired,
) -> Result<(), String> {
    ws_grant_in(&ws_registry(), target, owner, retired, SWEEP_TIMING_GRANTS)
}

const SWEEP_TIMING_GRANTS: SweepTiming = SweepTiming {
    interval: WORKER_HANDOFF_SWEEP_INTERVAL,
    timeout: WS_GRANT_TIMEOUT,
};

fn ws_grant_in(
    registry: &Arc<std::sync::Mutex<WsRegistry>>,
    target: &WsTarget,
    owner: WsOwner,
    retired: &WsCallerRetired,
    timing: SweepTiming,
) -> Result<(), String> {
    let start_sweep = {
        let mut registry = registry.lock().unwrap();
        if retired.0.load(Ordering::Relaxed) {
            return Ok(());
        }
        registry.grants.grant(target, owner, asyncrt::mono_ms())?;
        !std::mem::replace(&mut registry.grants.sweeping, true)
    };
    if start_sweep {
        asyncrt::spawn(sweep_ws_grants(registry.clone(), timing));
    }
    Ok(())
}

/// Remove grants that their holders did not use in time, until none is
/// left. A later grant starts a new sweep. Holds this instance's registry,
/// for the reason `sweep_worker_handoffs` does.
async fn sweep_ws_grants(registry: Arc<std::sync::Mutex<WsRegistry>>, timing: SweepTiming) {
    loop {
        asyncrt::sleep(timing.interval).await;
        let mut registry = registry.lock().unwrap();
        registry.grants.expire(asyncrt::mono_ms(), timing.timeout);
        if registry.grants.is_empty() {
            registry.grants.sweeping = false;
            return;
        }
    }
}

/// Retire a caller: no response that arrives later grants it anything, and
/// the grants it holds as a request go.
pub(crate) fn ws_retire_caller(retired: &WsCallerRetired, owner: Option<&WsOwner>) {
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    retired.0.store(true, Ordering::Relaxed);
    if let Some(owner) = owner {
        registry.grants.release(owner);
    }
}

/// Take `owner`'s grant of exactly `target`, if it holds one.
pub(crate) fn ws_take_grant(target: &WsTarget, owner: &WsOwner) -> bool {
    ws_registry().lock().unwrap().grants.take(target, owner)
}

/// Whether an owner other than `owner` holds a grant of `target`.
pub(crate) fn ws_granted_elsewhere(target: &WsTarget, owner: &WsOwner) -> bool {
    ws_registry()
        .lock()
        .unwrap()
        .grants
        .held_elsewhere(target, owner)
}

/// Drop every grant `owner` holds: its Durable Object stopped, and nothing
/// it held can use them.
pub fn ws_release_grants(owner: &WsOwner) {
    ws_registry().lock().unwrap().grants.release(owner);
}

/// How many grants `owner` holds.
#[cfg(test)]
pub(crate) fn ws_grants_held(owner: &WsOwner) -> usize {
    ws_registry()
        .lock()
        .unwrap()
        .grants
        .by_owner
        .get(owner)
        .map_or(0, Vec::len)
}

/// The recorded owner of socket `id`.
#[cfg(test)]
pub(crate) fn ws_owner(id: u64) -> Option<WsOwner> {
    ws_registry().lock().unwrap().owners.get(&id).cloned()
}
pub fn ws_register(id: u64, tx: tokio::sync::mpsc::UnboundedSender<WsOut>) {
    ws_registry().lock().unwrap().register(id, tx);
}

/// Install one hibernatable socket through a cfg-gated execution backend.
#[cfg(celld_internal_tests)]
pub(crate) fn ws_register_hibernatable_for_test(
    id: u64,
    scope: &str,
    tx: tokio::sync::mpsc::UnboundedSender<WsOut>,
) {
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    registry.register(id, tx);
    registry.owners.insert(id, WsOwner::Cell(scope.to_string()));
    registry.metadata.insert(
        id,
        WsMeta {
            scope: scope.to_string(),
            hibernatable: true,
            tags: Vec::new(),
            attachment: None,
            pending: Vec::new(),
            auto_response_at: None,
            facet: None,
        },
    );
}
/// Register an outbound socket of `scope`. A socket that a facet opened
/// takes its facet record in the same insertion, so no event, close, or
/// `ws_close_facet` can find the entry without it.
pub fn ws_register_outbound(id: u64, scope: &str, facet: Option<FacetSocket>) {
    let inserted = {
        let registry = ws_registry();
        let mut registry = registry.lock().unwrap();
        if let std::collections::hash_map::Entry::Vacant(entry) = registry.metadata.entry(id) {
            entry.insert(WsMeta {
                scope: scope.to_string(),
                hibernatable: false,
                tags: Vec::new(),
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet,
            });
            true
        } else {
            false
        }
    };
    if inserted {
        increment_regular_ws(scope);
    }
}
/// Remove a socket's output registration and metadata. Its owner goes too,
/// unless its input queue is still registered: the request that polls the
/// socket must still be able to read the close waiting there, and
/// `ws_pull_unregister` removes the owner with the queue.
pub fn ws_unregister(id: u64) {
    let meta = ws_registry().lock().unwrap().unregister(id);
    // Neither this nor `ws_pull_unregister` holds both locks at once. Each
    // removes its own registration before it looks at the other's, so
    // whichever runs second removes the owner.
    if !ws_pull().lock().unwrap().contains_key(&id) {
        ws_registry().lock().unwrap().owners.remove(&id);
    }
    if let Some(meta) = meta.filter(|meta| !meta.hibernatable) {
        decrement_regular_ws(&meta.scope);
    }
}

/// Releases a dialed or bound socket that never opened.
///
/// The op that started the dial allocated the id and registered what the
/// isolate needs before the handshake: its owner, a Worker socket's input
/// queue, and a bound socket's output registration. A dial that fails, or
/// that no connector task ever runs, must take those back, or a Durable
/// Object's failed dials would leave owners behind for as long as the
/// instance runs. The op creates it before it sends the request, and the
/// task disarms it once the socket is registered; from there the task's own
/// exits unregister it.
pub struct WsDialGuard {
    id: u64,
    armed: bool,
}

impl WsDialGuard {
    pub fn new(id: u64) -> Self {
        Self { id, armed: true }
    }

    pub fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for WsDialGuard {
    fn drop(&mut self) {
        if self.armed {
            ws_pull_unregister(self.id);
            ws_unregister(self.id);
        }
    }
}

/// Which channel a frame on this socket leaves by.
///
/// A hibernatable transport is `WsHibernatable`: the host pushes its messages
/// into the cell and captures what the handler emits. A turn the handler
/// suspends in releases its own batch on a ticket of its own, and the turn the
/// handler answers in releases its batch from the cell's barrier queue.
///
/// A socket the isolate opened and polls itself is `WsSelf`, and the two are
/// separate channels in the model for a concrete reason. That handler runs
/// inside the isolate's event loop, and that loop is what a captured frame
/// would be waiting on: the reply to a frame the gate is withholding never
/// arrives, so the loop never finishes, so the frame is never released. It
/// takes a durability ticket on the host runtime instead, which is a different
/// way of being held rather than not being held at all.
pub(crate) fn ws_channel(id: u64) -> celld_logic::Channel {
    let registry = ws_registry();
    let registry = registry.lock().unwrap();
    if registry
        .metadata
        .get(&id)
        .is_some_and(|meta| meta.hibernatable)
    {
        celld_logic::Channel::WsHibernatable
    } else {
        celld_logic::Channel::WsSelf
    }
}

/// The frames of one flush inside a socket's ordered queue.
///
/// A segment rather than a flat list of frames, because every flush holds a
/// gate ticket of its own. A later flush's frames can trail a write that an
/// earlier flush's ticket does not cover, so releasing a socket's whole queue
/// on the earlier verdict would send them before their own proof arrived. The
/// queue therefore drains its settled prefix and stops.
struct WsSegment {
    /// Names this segment to the flush that owns it. The position in the
    /// queue cannot: an earlier segment can drain first and move it.
    token: u64,
    frames: Vec<WsOut>,
    /// What the gate answered for this segment, once its flush has an answer.
    /// A segment with no owning flush carries `Ok` from the start: the frames
    /// are already released and only wait for the order in front of them.
    settled: Option<Result<(), String>>,
}

/// The frames one instance holds behind its output gates, and the flushes
/// that own them.
///
/// The fields are one invariant, so they are one value: a socket has a queue
/// exactly while the flushes counted in `flushes` will drain it, and a count
/// that falls must notify `done`. Held together, no caller can take the queue
/// of one instance of the services and the count of another.
#[derive(Default)]
pub(crate) struct WsFlushState {
    /// Frames held back because the handler that produced them has written
    /// something not yet durable, one queue of segments per socket.
    ///
    /// Every later frame for a socket that already holds frames joins the
    /// queue rather than overtaking it: a socket's frames must arrive in the
    /// order the script sent them. Ordering is a property of one socket,
    /// which is what the key says.
    ///
    /// Owned by the services, not by a thread. It is filled inside the
    /// isolate and drained by an op, and an op runs on the host runtime — so
    /// a thread-local queue was filled on one thread and taken, empty, on
    /// another. The frames never left the process, and because the queue
    /// stayed non-empty every later frame joined them.
    deferred: std::sync::Mutex<HashMap<u64, std::collections::VecDeque<WsSegment>>>,
    /// How many flushes still hold frames for a socket. A count, not a flag:
    /// one flush can finish and drain its segment while a later frame starts
    /// another.
    flushes: std::sync::Mutex<HashMap<u64, usize>>,
    /// Names the next segment. Monotonic within one instance's services, so
    /// a token identifies a segment for as long as any flush can name it.
    next_token: AtomicU64,
    done: tokio::sync::Notify,
}

impl WsFlushState {
    /// Send `frames` on their sockets, or hold each behind its socket's gate.
    ///
    /// One call is one flush: every socket the batch touches takes at most
    /// one segment, so a broadcast that one gate ticket covers costs one
    /// ticket rather than one for each client.
    ///
    /// `gated` is the core's answer for this batch's event. A socket that
    /// already holds frames joins them whatever that answer is, so a later
    /// frame cannot overtake an earlier one. An ungated batch therefore joins
    /// as a segment that is settled from the start, and a gated one joins as
    /// a segment this flush must release.
    ///
    /// Returns the guard for the flush this batch started, and only then, so
    /// the caller cannot leave a held segment with no flush behind it and
    /// cannot await a gate that holds nothing. The counts are taken while the
    /// queue lock is held: a teardown that reads them must not observe a
    /// queued frame with no flush behind it.
    pub(crate) fn emit_or_defer(
        self: &Arc<Self>,
        registry: &std::sync::Mutex<WsRegistry>,
        frames: impl IntoIterator<Item = (u64, WsOut)>,
        gated: bool,
    ) -> Option<WsFlushGuard> {
        // Held until every frame is either queued or sent. A flush runs on
        // another thread, so releasing between the check and the send would
        // let it drain its queue in between, putting a later frame ahead of
        // an earlier one.
        let mut deferred = self.deferred.lock().unwrap();
        let mut direct = Vec::new();
        let mut mine = std::collections::HashSet::new();
        let mut segments = Vec::new();
        for (id, out) in frames {
            if mine.contains(&id) {
                deferred
                    .get_mut(&id)
                    .and_then(std::collections::VecDeque::back_mut)
                    .expect("a socket this batch queued still holds its segment")
                    .frames
                    .push(out);
                continue;
            }
            let token = self.next_token.fetch_add(1, Ordering::Relaxed);
            match deferred.entry(id) {
                std::collections::hash_map::Entry::Vacant(_) if !gated => direct.push((id, out)),
                entry => {
                    entry.or_default().push_back(WsSegment {
                        token,
                        frames: vec![out],
                        settled: (!gated).then_some(Ok(())),
                    });
                    mine.insert(id);
                    if gated {
                        segments.push((id, token));
                    }
                }
            }
        }
        let flushing = (!segments.is_empty()).then(|| {
            let mut flushes = self.flushes.lock().unwrap();
            for (id, _) in &segments {
                *flushes.entry(*id).or_default() += 1;
            }
            drop(flushes);
            WsFlushGuard {
                state: self.clone(),
                segments,
            }
        });
        // Still under the queue lock: a frame this batch sends directly has
        // no queue on its socket, and a flush that acquired the lock first
        // cannot install one between the check above and this send.
        emit_frames(registry, direct);
        flushing
    }

    /// Reserve one captured frame's place in its socket's queue, inside the
    /// batch's single flush.
    ///
    /// The frame joins the flush's own segment while that segment is still
    /// the socket's tail, so a handler that sends many frames, or broadcasts
    /// one frame to many sockets, holds one segment per socket, as a batch
    /// through `emit_or_defer` does. A segment for each frame would cost a
    /// queue lock, a count, and a waiter wake-up for each frame at release.
    /// A frame that another event queued in between ends that segment, and
    /// this frame opens a new one behind it, so send order still holds.
    fn capture(
        self: &Arc<Self>,
        flush: &mut Option<WsFlushGuard>,
        tails: &mut HashMap<u64, u64>,
        id: u64,
        out: WsOut,
    ) {
        // One queue lock covers the tail check and the count, as in
        // `emit_or_defer`: a teardown must not observe a queued frame with no
        // flush behind it.
        let mut deferred = self.deferred.lock().unwrap();
        let queue = deferred.entry(id).or_default();
        let own_tail = tails
            .get(&id)
            .and_then(|token| queue.back_mut().filter(|segment| segment.token == *token));
        if let Some(segment) = own_tail {
            segment.frames.push(out);
            return;
        }
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        queue.push_back(WsSegment {
            token,
            frames: vec![out],
            settled: None,
        });
        *self.flushes.lock().unwrap().entry(id).or_default() += 1;
        tails.insert(id, token);
        flush
            .get_or_insert_with(|| WsFlushGuard {
                state: self.clone(),
                segments: Vec::new(),
            })
            .segments
            .push((id, token));
    }

    /// Wait until no flush holds frames for `id` any more.
    async fn await_flushes(&self, id: u64) {
        loop {
            // Registered before the count is read. A flush that finishes in
            // between must find a waiter to wake, or this parks forever on a
            // notification that already happened.
            let notified = self.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.flushes.lock().unwrap().contains_key(&id) {
                return;
            }
            notified.await;
        }
    }

    /// Wait until no flush of this instance still owns deferred frames.
    async fn await_all_flushes(&self) {
        loop {
            // Register before observing the map, exactly as the per-socket
            // wait does. The final guard can otherwise notify between the
            // empty check and waiter registration, leaving shutdown parked
            // forever.
            let notified = self.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.flushes.lock().unwrap().is_empty() {
                return;
            }
            notified.await;
        }
    }
}

/// The flush state of the services the caller runs under.
///
/// A flush task outlives the dispatch that spawned it and runs on a runtime
/// with no services of its own, so every caller that hands work to one
/// resolves the state here first and moves it in. Resolving inside the task
/// would answer from whichever instance that runtime reaches, which is the
/// process-wide sharing this state exists to end.
pub(crate) fn ws_flush_state() -> Arc<WsFlushState> {
    asyncrt::services().websockets().flush.clone()
}

/// One held segment and the flush that owns it, for a test that stands in for
/// the durability ticket. Holding the guard is what keeps the socket's
/// teardown wait honest while the queue exists.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub struct WsHeldFlush(WsFlushGuard);

/// Hold `out` behind `id`'s gate exactly as a gated frame does, and return
/// the flush that holds it.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn ws_defer_frame(id: u64, out: WsOut) -> WsHeldFlush {
    let flush = ws_flush_state();
    let registry = ws_registry();
    WsHeldFlush(
        flush
            .emit_or_defer(&registry, std::iter::once((id, out)), true)
            .expect("a gated frame always opens a segment of its own"),
    )
}

/// How many frames this instance holds for `id`.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn ws_deferred_count(id: u64) -> usize {
    ws_flush_state()
        .deferred
        .lock()
        .unwrap()
        .get(&id)
        .map_or(0, |queue| {
            queue.iter().map(|segment| segment.frames.len()).sum()
        })
}

/// Release a held flush as a settled durability ticket does, then count it
/// out. Consuming the guard is what makes the two happen together.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn ws_release_flush(held: WsHeldFlush) {
    let registry = ws_registry();
    held.0.release(&registry, Ok(()));
}

/// Answer a held flush as a refused durability ticket does.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn ws_refuse_flush(held: WsHeldFlush) {
    let registry = ws_registry();
    held.0
        .release(&registry, Err("refused for a test".to_string()));
}

/// The segments one flush holds, and the counts that name it to a teardown.
///
/// The two travel together because either alone is wrong: a segment with no
/// count lets a socket tear down over frames that have not left, and a count
/// with no segment parks that teardown forever.
///
/// The guard counts itself out on every exit path, including the ones that
/// run no code: a flush spawned onto a runtime that is already shutting down
/// is dropped unpolled, and a panic unwinds through it. It cannot help a
/// flush that is merely parked -- nothing drops, so nothing runs -- which is
/// what the teardown wait is bounded for.
///
/// It carries the state rather than resolving it on drop, because the drop
/// can run on a runtime that answers with another instance, or with none.
pub(crate) struct WsFlushGuard {
    state: Arc<WsFlushState>,
    /// The segment this flush owns on each socket the batch reached, as
    /// (socket, token).
    segments: Vec<(u64, u64)>,
}

impl WsFlushGuard {
    fn discard(self, registry: &std::sync::Mutex<WsRegistry>) {
        {
            let mut deferred = self.state.deferred.lock().unwrap();
            for (id, token) in &self.segments {
                if let Some(segment) = deferred
                    .get_mut(id)
                    .and_then(|queue| queue.iter_mut().find(|segment| segment.token == *token))
                {
                    segment.frames.clear();
                }
            }
        }
        self.release(registry, Ok(()));
    }

    /// Give the gate's verdict to every segment this flush holds, then
    /// deliver what each socket can now release.
    ///
    /// `held` is what the gate answered. `Err` means the frames describe a
    /// write the fleet may never have, so they must not be delivered.
    /// Dropping them and leaving the socket open is not an option -- a
    /// WebSocket is an ordered stream, and a peer cannot see a hole in one.
    /// It would read the frames on either side of the gap as consecutive.
    ///
    /// Close instead. A truncated stream is something the peer can detect and
    /// resynchronise from; a silently incomplete one is not. The cell is
    /// reset underneath this as well, but that is a separate path and this
    /// must not depend on its timing.
    ///
    /// Takes the guard by value, so the count this flush holds falls once its
    /// frames have left and never before.
    pub(crate) fn release(self, registry: &std::sync::Mutex<WsRegistry>, held: Result<(), String>) {
        // Keep the lock from the verdict through the registry send. Once a
        // queue is drained away, another release would otherwise look direct
        // and overtake these frames.
        let mut deferred = self.state.deferred.lock().unwrap();
        let mut sending = Vec::new();
        for (id, token) in &self.segments {
            if let Some(segment) = deferred
                .get_mut(id)
                .and_then(|queue| queue.iter_mut().find(|segment| segment.token == *token))
            {
                segment.settled = Some(held.clone());
            }
            drain_settled(&mut deferred, *id, &mut sending);
        }
        emit_frames(registry, sending);
    }
}

/// Take the frames a socket's queue can release: every segment up to the
/// first one whose gate has not answered.
///
/// A segment the gate refused ends the socket instead. Everything queued
/// behind it trails the same unproven write, so it is dropped with the
/// segment rather than sent as though the gap were not there.
fn drain_settled(
    deferred: &mut HashMap<u64, std::collections::VecDeque<WsSegment>>,
    id: u64,
    sending: &mut Vec<(u64, WsOut)>,
) {
    let Some(queue) = deferred.get_mut(&id) else {
        return;
    };
    let mut refused = false;
    while let Some(segment) = queue.front() {
        match &segment.settled {
            None => break,
            Some(Err(_)) => {
                refused = true;
                break;
            }
            Some(Ok(())) => {
                let segment = queue.pop_front().expect("the front segment is present");
                sending.extend(segment.frames.into_iter().map(|frame| (id, frame)));
            }
        }
    }
    if refused {
        deferred.remove(&id);
        sending.push((
            id,
            WsOut::Close(
                1011,
                "celld could not prove the write behind this message durable".to_string(),
            ),
        ));
    } else if queue.is_empty() {
        deferred.remove(&id);
    }
}

impl Drop for WsFlushGuard {
    fn drop(&mut self) {
        {
            let mut flushes = self.state.flushes.lock().unwrap();
            for (id, _) in &self.segments {
                let Some(count) = flushes.get_mut(id) else {
                    continue;
                };
                *count -= 1;
                if *count == 0 {
                    flushes.remove(id);
                }
            }
        }
        self.state.done.notify_waiters();
    }
}

/// Wait until no flush holds frames for `id` any more.
///
/// The socket's own teardown calls this. Closing reads the handler's output
/// with a non-blocking drain and, finding none, answers the peer with the
/// protocol echo of the close the peer itself sent -- so a close frame still
/// behind the gate is not merely late, it is replaced. The wait is bounded by
/// the gate: a cell with no barrier answers at once, a barrier settles when
/// its proof does, and an unprovable one still resolves the flush through its
/// fail-closed arm.
pub async fn ws_await_flushes(id: u64) {
    ws_flush_state().await_flushes(id).await;
}

/// Wait until no WebSocket flush of these services still owns deferred
/// frames.
///
/// Shutdown calls this after the cell handoff has settled every output gate
/// and before connection tasks can unregister their sockets. Waiting per
/// socket cannot enforce that ordering because socket teardown deliberately
/// skips its gate wait once the node is draining.
#[doc(hidden)]
pub async fn ws_await_all_flushes() {
    ws_flush_state().await_all_flushes().await;
}

/// Hand frames that cross no queue to the registry, under one lock.
///
/// The registry is a parameter rather than a lookup: a flush runs on a
/// runtime with no services of its own, so it must send to the instance that
/// owns the socket instead of to whichever instance that runtime reaches.
fn emit_frames(
    registry: &std::sync::Mutex<WsRegistry>,
    frames: impl IntoIterator<Item = (u64, WsOut)>,
) {
    let mut frames = frames.into_iter().peekable();
    if frames.peek().is_none() {
        return;
    }
    let mut registry = registry.lock().unwrap();
    for (id, out) in frames {
        registry.emit(id, out);
    }
}

/// Release a batch into each socket's ordered stream. A socket whose
/// durability-ticket queue is still present joins that queue, so an Actor
/// barrier release cannot overtake an earlier frame on the same socket.
pub fn ws_emit_batch(frames: impl Into<WsBatch>) {
    frames.into().release(Ok(()));
}

/// Close one socket. A forced generation swap closes the regular and
/// outbound sockets that pin a cell to its old isolate and nothing else: the
/// cell stays on this node, so its hibernatable sockets and auto-response
/// pair survive, which `ws_close_scope` would take with it.
pub fn ws_close(id: u64, code: u16, reason: &str) {
    ws_registry()
        .lock()
        .unwrap()
        .emit(id, WsOut::Close(code, reason.to_string()));
}

/// Break a cell's sockets: the output gate could not prove a write durable, so
/// close every socket the cell owns rather than let a client keep a connection
/// whose acknowledged effects may not have persisted (a reset DO).
///
/// The sockets of the cell's facets close too. A facet's writes trail the
/// root cell's gate, and the facet does not outlive its root.
pub fn ws_close_scope(scope: &str, code: u16, reason: &str) {
    let mut scopes = vec![scope.to_string()];
    {
        let registry = ws_registry();
        let mut registry = registry.lock().unwrap();
        let ids: Vec<u64> = registry
            .metadata
            .iter()
            .filter(|(_, meta)| {
                let facet_of_scope = meta.facet.as_ref().is_some_and(|facet| facet.root == scope);
                if facet_of_scope && !scopes.contains(&meta.scope) {
                    scopes.push(meta.scope.clone());
                }
                meta.scope == scope || facet_of_scope
            })
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            registry.emit(id, WsOut::Close(code, reason.to_string()));
        }
    }
    // A reset cell is a new actor; workerd's hibernation manager dies with
    // the old one and takes the auto-response pair with it.
    let pairs = ws_auto_responses();
    let mut pairs = pairs.lock().unwrap();
    for scope in &scopes {
        pairs.remove(scope);
    }
}

/// Close the sockets of a facet that stopped: an abort, a delete, or its
/// root's give-back.
///
/// No later event can reach the facet, and a facet restarted under the same
/// name is a new actor that never accepted these sockets. Leaving them open
/// would accept frames that no handler can receive. 1001 is the code for an
/// endpoint that is going away.
pub(crate) fn ws_close_facet(scope: &str, reason: &str) {
    ws_auto_responses().lock().unwrap().remove(scope);
    ws_release_grants(&WsOwner::Cell(scope.to_string()));
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    let ids: Vec<u64> = registry
        .metadata
        .iter()
        .filter(|(_, meta)| meta.scope == scope && meta.facet.is_some())
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        registry.emit(id, WsOut::Close(1001, reason.to_string()));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::time::Duration;

    /// A Worker socket registered as `__readResponse` registers one: an
    /// input queue the server end reads and an output registration with no
    /// sink yet, which buffers what the server end sends.
    pub(crate) fn worker_socket() -> (WorkerWebSocket, WsPullReceiverHandle) {
        let id = ws_next_id();
        let (inbound, queue) = ws_pull_channel();
        ws_pull_register(id, queue);
        ws_register_outbound(id, "", None);
        let queue = ws_pull().lock().unwrap().get(&id).cloned().unwrap();
        (
            WorkerWebSocket::new(id, inbound),
            WsPullReceiverHandle(id, queue),
        )
    }

    /// The server end's input queue, held as a pending `__ws_next` holds it.
    pub(crate) struct WsPullReceiverHandle(pub(crate) u64, WsPullQueue);

    impl WsPullReceiverHandle {
        pub(crate) fn registered(&self) -> bool {
            ws_pull().lock().unwrap().contains_key(&self.0)
                && ws_registry().lock().unwrap().metadata.contains_key(&self.0)
        }

        /// The close the server end reads next, as (code, reason).
        pub(crate) async fn next_close(&self) -> Option<(u16, String)> {
            let mut queue = self.1.lock().await;
            match asyncrt::timeout(Duration::from_secs(1), queue.recv()).await {
                Ok(Some(WsPull::Close(code, reason, _))) => Some((code, reason)),
                _ => None,
            }
        }
    }

    /// Wait for a spawned release to drop its socket.
    pub(crate) async fn released(queue: &WsPullReceiverHandle) -> bool {
        for _ in 0..100 {
            if !queue.registered() {
                return true;
            }
            asyncrt::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    fn issuer(request: u64) -> WorkerHandoffIssuer {
        WorkerHandoffIssuer {
            generation: 7,
            request,
        }
    }

    /// A registry of its own, so a test's sweep and retirement see only
    /// that test's sockets.
    fn own_registry() -> Arc<std::sync::Mutex<WsRegistry>> {
        Arc::new(std::sync::Mutex::new(WsRegistry::default()))
    }

    #[test]
    fn grants_expire_and_their_index_follows() {
        assert_eq!(WS_GRANT_TIMEOUT, Duration::from_secs(30));
        let target = |id, tunnel| WsTarget {
            id,
            scope: "sweep".into(),
            tunnel,
        };
        let early = WsOwner::Request(1);
        let late = WsOwner::Request(2);
        let mut grants = WsGrants::default();
        grants
            .grant(&target(5, None), early.clone(), 1_000)
            .unwrap();
        grants
            .grant(&target(5, Some(9)), early.clone(), 1_000)
            .unwrap();
        grants
            .grant(&target(5, None), late.clone(), 20_000)
            .unwrap();
        let timeout = WS_GRANT_TIMEOUT.as_millis() as u64;
        grants.expire(1_000 + timeout - 1, WS_GRANT_TIMEOUT);
        assert_eq!(grants.by_owner[&early].len(), 2);
        grants.expire(1_000 + timeout, WS_GRANT_TIMEOUT);
        assert!(!grants.by_owner.contains_key(&early));
        assert_eq!(grants.by_target[&5], std::slice::from_ref(&late));
        assert!(grants.held_elsewhere(&target(5, None), &early));
        // The local socket closes: its grants go, a remote one would stay.
        grants
            .grant(&target(5, Some(9)), early.clone(), 30_000)
            .unwrap();
        grants.target_gone(5);
        assert!(!grants.by_owner.contains_key(&late));
        assert_eq!(grants.by_target[&5], std::slice::from_ref(&early));
        grants.release(&early);
        assert!(grants.is_empty() && grants.by_target.is_empty());
    }

    #[test]
    fn the_sweep_closes_unadopted_handoffs_after_thirty_seconds() {
        assert_eq!(WORKER_HANDOFF_TIMEOUT, Duration::from_secs(30));
        assert_eq!(WORKER_HANDOFF_SWEEP_INTERVAL, Duration::from_secs(5));
        assert!(WORKER_HANDOFF_SWEEP_INTERVAL < WORKER_HANDOFF_TIMEOUT);
        assert!(WORKER_HANDOFF_RETIRE_GRACE < WORKER_HANDOFF_TIMEOUT);
        assert_eq!(WORKER_HANDOFF_UNADOPTED_CODE, 1011);

        let mut parks = WorkerHandoffs::default();
        let (waiting, waiting_queue) = worker_socket();
        let (adopted, _) = worker_socket();
        let (other, other_queue) = worker_socket();
        parks.park(waiting, 1_000, issuer(1)).ok().unwrap();
        let adopted = parks.park(adopted, 1_000, issuer(1)).ok().unwrap();
        parks.adopt(&adopted, 1, 99).unwrap();
        let mut later_generation = issuer(2);
        later_generation.generation = 8;
        parks.park(other, 1_000, later_generation).ok().unwrap();

        let timeout = WORKER_HANDOFF_TIMEOUT.as_millis() as u64;
        let grace = Duration::from_millis(500);
        assert!(parks
            .take_unadopted(1_000 + timeout - 1, WORKER_HANDOFF_TIMEOUT, None)
            .is_empty());
        // A retired generation's caller may still be about to adopt.
        assert!(parks
            .take_unadopted(1_499, WORKER_HANDOFF_TIMEOUT, Some((7, grace)))
            .is_empty());
        // After the grace, the retirement takes its own parked socket only.
        let retired = parks.take_unadopted(1_500, WORKER_HANDOFF_TIMEOUT, Some((7, grace)));
        assert_eq!(
            retired.iter().map(WorkerWebSocket::id).collect::<Vec<_>>(),
            [waiting_queue.0]
        );
        drop(retired);
        assert!(!waiting_queue.registered());
        // An adopted socket belongs to its caller's event, never the sweep.
        let expired = parks.take_unadopted(1_000 + timeout, WORKER_HANDOFF_TIMEOUT, None);
        assert_eq!(
            expired.iter().map(WorkerWebSocket::id).collect::<Vec<_>>(),
            [other_queue.0]
        );
        assert!(!parks.has_parked());
        assert_eq!(
            parks.take_adopted(&adopted, 1).map(|(_, caller)| caller),
            Ok(99)
        );
    }

    #[test]
    fn only_the_issuing_request_adopts_and_takes_once() {
        let mut parks = WorkerHandoffs::default();
        let (socket, queue) = worker_socket();
        let token = parks.park(socket, 0, issuer(1)).ok().unwrap();
        assert_eq!(token.as_str().len(), 32);
        // Not adopted yet: not even its request can take it.
        assert_eq!(
            parks.take_adopted(&token, 1).err(),
            Some(WorkerHandoffRefusal::Gone)
        );
        // Another request knowing the token cannot adopt it, and the socket
        // stays parked for its own request.
        assert_eq!(
            parks.adopt(&token, 2, 5),
            Err(WorkerHandoffRefusal::OtherRequest)
        );
        assert!(parks.has_parked());
        parks.adopt(&token, 1, 5).unwrap();
        assert_eq!(parks.adopt(&token, 1, 6), Err(WorkerHandoffRefusal::Gone));
        assert_eq!(
            parks.adopt(&WorkerHandoffToken::from(queue.0.to_string()), 1, 7),
            Err(WorkerHandoffRefusal::Gone)
        );
        // Nor can another request take it once adopted.
        assert_eq!(
            parks.take_adopted(&token, 2).err(),
            Some(WorkerHandoffRefusal::OtherRequest)
        );
        let (socket, caller) = parks.take_adopted(&token, 1).expect("adopted");
        assert_eq!(caller, 5);
        assert_eq!(
            parks.take_adopted(&token, 1).err(),
            Some(WorkerHandoffRefusal::Gone)
        );
        assert!(queue.registered());
        drop(socket);
        assert!(!queue.registered());
    }

    #[test]
    fn a_request_holds_at_most_its_limit() {
        let mut parks = WorkerHandoffs::default();
        let mut queues = Vec::new();
        let mut tokens = Vec::new();
        for _ in 0..WORKER_HANDOFFS_PER_REQUEST {
            let (socket, queue) = worker_socket();
            tokens.push(parks.park(socket, 0, issuer(1)).ok().unwrap());
            queues.push(queue);
        }
        let (socket, queue) = worker_socket();
        let refused = parks
            .park(socket, 0, issuer(1))
            .expect_err("over the limit");
        assert_eq!(refused.id(), queue.0);
        // Another request has its own allowance.
        let (socket, _) = worker_socket();
        assert!(parks.park(socket, 0, issuer(2)).is_ok());
        // Adopted sockets count until the request takes them.
        let token = &tokens[0];
        let request = parks.entries[token].issuer.request;
        parks.adopt(token, request, 1).unwrap();
        let (socket, _) = worker_socket();
        let socket = parks.park(socket, 0, issuer(1)).expect_err("still full");
        drop(parks.take_adopted(token, request).unwrap());
        assert!(parks.park(socket, 0, issuer(1)).is_ok());
    }

    #[test]
    fn a_request_over_its_limit_gets_an_error_and_the_socket_closes() {
        asyncrt::test_host_runtime().block_on(async {
            let registry = own_registry();
            let timing = SweepTiming {
                interval: Duration::from_secs(60),
                timeout: WORKER_HANDOFF_TIMEOUT,
            };
            for _ in 0..WORKER_HANDOFFS_PER_REQUEST {
                let (socket, _) = worker_socket();
                park_worker_handoff_in(&registry, socket, issuer(3), timing).unwrap();
            }
            let (socket, queue) = worker_socket();
            let error = park_worker_handoff_in(&registry, socket, issuer(3), timing).unwrap_err();
            assert!(error.starts_with(TOO_MANY_WORKER_HANDOFFS), "{error}");
            assert_eq!(
                queue.next_close().await,
                Some((1011, "the caller holds too many WebSockets".into())),
            );
            assert!(released(&queue).await);
        });
    }

    #[test]
    fn an_unadopted_socket_closes_with_1011_before_its_release() {
        asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            close_unadopted(socket, "no caller adopted this WebSocket");
            // Still registered until the server end has read its Close.
            assert!(queue.registered());
            assert_eq!(
                queue.next_close().await,
                Some((1011, "no caller adopted this WebSocket".into())),
            );
            assert!(released(&queue).await);
        });
    }

    #[test]
    fn the_sweep_task_closes_parked_sockets_and_stops_until_the_next_park() {
        asyncrt::test_host_runtime().block_on(async {
            let registry = own_registry();
            let timing = SweepTiming {
                interval: Duration::from_millis(10),
                timeout: Duration::from_millis(30),
            };
            let sweeping = || registry.lock().unwrap().worker_handoff_parks.sweeping;
            for _ in 0..2 {
                let (socket, queue) = worker_socket();
                park_worker_handoff_in(&registry, socket, issuer(4), timing).unwrap();
                assert!(sweeping());
                assert_eq!(
                    queue.next_close().await,
                    Some((1011, "no caller adopted this WebSocket".into())),
                );
                assert!(released(&queue).await);
                // With nothing parked, the sweep ends, and the next park
                // starts another.
                for _ in 0..100 {
                    if !sweeping() {
                        break;
                    }
                    asyncrt::sleep(Duration::from_millis(10)).await;
                }
                assert!(!sweeping());
            }
        });
    }

    #[test]
    fn a_retired_generation_closes_its_parked_sockets_after_the_grace() {
        asyncrt::test_host_runtime().block_on(async {
            let registry = own_registry();
            let timing = SweepTiming {
                interval: Duration::from_secs(60),
                timeout: WORKER_HANDOFF_TIMEOUT,
            };
            let (socket, queue) = worker_socket();
            let (kept, kept_queue) = worker_socket();
            park_worker_handoff_in(&registry, socket, issuer(5), timing).unwrap();
            let mut other = issuer(5);
            other.generation = 8;
            park_worker_handoff_in(&registry, kept, other, timing).unwrap();
            close_generation_worker_handoffs_in(registry.clone(), 7, Duration::from_millis(100));
            // Parked moments ago: its caller may still adopt it.
            assert!(queue.registered());
            // The second pass, at the end of the grace, closes it.
            assert_eq!(
                queue.next_close().await,
                Some((
                    1011,
                    "the deployment that made this WebSocket retired".into()
                )),
            );
            assert!(released(&queue).await);
            assert!(kept_queue.registered());
        });
    }

    /// A bridge between a caller end the test reads and a server end, with
    /// the senders of both sides' frames.
    struct TestBridge {
        caller: WsPullReceiver,
        to_bridge_from_caller: tokio::sync::mpsc::UnboundedSender<WsOut>,
        to_bridge_from_target: tokio::sync::mpsc::UnboundedSender<WsOut>,
        target: WsPullReceiverHandle,
        done: asyncrt::TaskHandle<()>,
    }

    fn start_bridge(close_timeout: Duration) -> TestBridge {
        let (target, target_queue) = worker_socket();
        let (caller_pull, caller) = ws_pull_channel();
        let (to_bridge_from_caller, from_caller) = tokio::sync::mpsc::unbounded_channel();
        let (to_bridge_from_target, from_target) = tokio::sync::mpsc::unbounded_channel();
        let bridge = WorkerHandoffBridge {
            caller: ws_next_id(),
            caller_pull,
            from_caller,
            target,
            from_target,
        };
        TestBridge {
            caller,
            to_bridge_from_caller,
            to_bridge_from_target,
            target: target_queue,
            done: asyncrt::spawn(bridge_worker_handoff_within(bridge, close_timeout)),
        }
    }

    fn close_of(frame: Option<WsPull>) -> Option<(u16, String, bool)> {
        match frame {
            Some(WsPull::Close(code, reason, clean)) => Some((code, reason, clean)),
            _ => None,
        }
    }

    #[test]
    fn a_bridge_carries_frames_both_ways_and_the_target_close() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_secs(5));
            bridge
                .to_bridge_from_caller
                .send(WsOut::Text("up".into()))
                .unwrap();
            let up = bridge.target.1.lock().await.recv().await;
            assert!(matches!(up, Some(WsPull::Text(text)) if text == "up"));
            bridge
                .to_bridge_from_target
                .send(WsOut::Binary(vec![1, 2]))
                .unwrap();
            assert!(
                matches!(bridge.caller.recv().await, Some(WsPull::Binary(bytes)) if bytes == [1, 2])
            );
            // The server end closes first: the caller sees its code, and the
            // server end's queue ends with the same Close.
            bridge
                .to_bridge_from_target
                .send(WsOut::Close(4001, "bye".into()))
                .unwrap();
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((4001, "bye".into(), true))
            );
            assert_eq!(bridge.target.next_close().await, Some((4001, "bye".into())));
            bridge.done.await.unwrap();
        });
    }

    #[test]
    fn a_caller_close_with_no_reply_ends_in_1006() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_millis(50));
            bridge
                .to_bridge_from_caller
                .send(WsOut::Close(4000, "done".into()))
                .unwrap();
            assert_eq!(
                bridge.target.next_close().await,
                Some((4000, "done".into()))
            );
            // The server end never answers.
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((1006, String::new(), false))
            );
            bridge.done.await.unwrap();
        });
    }

    #[test]
    fn a_caller_close_carries_the_server_reply() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_secs(5));
            bridge
                .to_bridge_from_caller
                .send(WsOut::Close(4000, "done".into()))
                .unwrap();
            assert_eq!(
                bridge.target.next_close().await,
                Some((4000, "done".into()))
            );
            bridge
                .to_bridge_from_target
                .send(WsOut::Close(4000, "saw it".into()))
                .unwrap();
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((4000, "saw it".into(), true))
            );
            bridge.done.await.unwrap();
        });
    }

    #[test]
    fn a_side_that_goes_away_closes_the_other_with_1006() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_millis(50));
            drop(bridge.to_bridge_from_caller);
            assert_eq!(
                bridge.target.next_close().await,
                Some((1006, String::new()))
            );
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((1006, String::new(), false))
            );
            bridge.done.await.unwrap();
        });
    }

    #[test]
    fn a_side_that_stops_reading_closes_the_other_with_1006() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_millis(50));
            // The server end's isolate is gone: nothing holds its queue.
            let target = bridge.target.0;
            drop(bridge.target);
            ws_pull_unregister(target);
            bridge
                .to_bridge_from_caller
                .send(WsOut::Text("lost".into()))
                .unwrap();
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((1006, String::new(), false))
            );
            bridge.done.await.unwrap();
        });
    }
}
