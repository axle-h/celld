// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The WebSocket registry: the sockets an instance holds, the frames waiting
//! to leave, and the isolate-polled input queues. Engine-neutral; the V8 ops
//! stay in `crate::js::websocket`, which re-exports every item at its old
//! path.
use crate::asyncrt;
use crate::engine_api::WsTarget;
use anyhow::Result;
use std::collections::{HashMap, HashSet};
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

impl WsOut {
    fn queue_bytes(&self) -> usize {
        let payload = match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
            Self::Close(_, reason) => reason.len(),
        };
        std::mem::size_of::<Self>().saturating_add(payload)
    }
}

/// The most bytes of outgoing frames that one socket holds for a peer that
/// reads more slowly than its application sends.
///
/// `send()` cannot wait, in workerd or here, so a Worker that sends faster
/// than its peer reads queues frames without limit there. This bound is
/// celld's: a socket over it is closed (see [`WS_OUT_OVERFLOW_CODE`]) rather
/// than allowed to hold the node's memory. One message admits into an empty
/// queue whatever its size, so a message up to Cloudflare's 32 MiB limit
/// always leaves. A socket keeps up to this much in flight as well as what
/// the kernel buffers, so ordinary traffic, a burst of a few megabytes to a
/// browser on a slow link included, never reaches it.
pub const WS_OUT_QUEUE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// The close code a peer receives when its socket's outgoing queue passed
/// [`WS_OUT_QUEUE_MAX_BYTES`]: an endpoint that cannot go on (RFC 6455
/// 7.4.1). The application sees its socket close abnormally (1006), with
/// [`WS_OUT_OVERFLOW_REASON`].
pub const WS_OUT_OVERFLOW_CODE: u16 = 1011;

/// The reason that goes with [`WS_OUT_OVERFLOW_CODE`], within a Close
/// frame's 123 bytes. workerd has no such limit, so the text is celld's.
pub const WS_OUT_OVERFLOW_REASON: &str =
    "celld closed this WebSocket: more than 32 MiB of sent messages waited for the peer to read them";

/// The reason that goes with [`WS_OUT_OVERFLOW_CODE`] when the isolate's
/// memory budget, rather than the socket's own bound, could not hold one
/// more message. The text is celld's.
pub const WS_OUT_BUDGET_REASON: &str =
    "celld closed this WebSocket: its isolate's memory limit could not hold more sent messages";

/// How much a socket's outgoing queue may hold, frames being written
/// included, before the host stops reading the socket for a reply it makes
/// itself to what the peer sent: an auto-response
/// (`setWebSocketAutoResponse`). workerd waits for each auto-response to be
/// written before it reads the next message, so a peer that sends requests
/// and never reads the replies gets no further than its own buffers. This
/// lets a burst of replies share the connection instead of waiting one by
/// one, and holds a peer that does not read to about 1 MiB.
pub const WS_REPLY_BACKLOG_MAX_BYTES: usize = 1024 * 1024;

/// How many hibernatable WebSockets one Durable Object may hold: Cloudflare's
/// documented limit of 32,768 per object. workerd has none, and each socket
/// pins host state that hibernation does not release.
pub const WS_HIBERNATABLE_PER_OBJECT: usize = 32_768;

/// workerd has no such limit, so the text is celld's.
pub(crate) const TOO_MANY_HIBERNATABLE: &str = "this Durable Object already holds 32768 \
     hibernatable WebSockets, the most one can; close one before accepting another";

/// The memory budget that a socket's waiting frames are charged to: the
/// backing-store budget of the isolate whose code sent them (plan 1.33).
/// Frames charge it as they queue and give it back as they leave or are
/// discarded, so every socket of an isolate together holds no more than its
/// budget allows, however many sockets it has.
pub(crate) trait WsBudget: Send + Sync {
    /// Charge `bytes`, or refuse them when the budget cannot hold them.
    fn charge(&self, bytes: usize) -> bool;
    fn release(&self, bytes: usize);
}

/// Why a socket's outgoing channel took no more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Overflow {
    /// The socket's frames passed [`WS_OUT_QUEUE_MAX_BYTES`].
    Queue = 1,
    /// The isolate's budget could not hold one more.
    Budget = 2,
}

impl Overflow {
    fn reason(self) -> &'static str {
        match self {
            Self::Queue => WS_OUT_OVERFLOW_REASON,
            Self::Budget => WS_OUT_BUDGET_REASON,
        }
    }
}

/// What one socket's outgoing channel holds, shared by both ends.
struct WsOutState {
    queued: std::sync::atomic::AtomicUsize,
    /// 0, or the `Overflow` that closed the channel.
    overflowed: std::sync::atomic::AtomicU8,
    overflow: tokio::sync::Notify,
    /// The live senders. The last one to go ends the owner's hold on the
    /// socket (`WsOutWatch::closed`).
    senders: std::sync::atomic::AtomicUsize,
    closed: tokio::sync::Notify,
    /// Wakes a reader waiting for the queue to drain (`ws_await_backlog`).
    drained: tokio::sync::Notify,
}

impl WsOutState {
    fn overflow(&self, why: Overflow) {
        let _ = self
            .overflowed
            .compare_exchange(0, why as u8, Ordering::AcqRel, Ordering::Acquire);
        self.overflow.notify_waiters();
    }

    fn overflowed(&self) -> Option<Overflow> {
        match self.overflowed.load(Ordering::Acquire) {
            0 => None,
            1 => Some(Overflow::Queue),
            _ => Some(Overflow::Budget),
        }
    }
}

/// One queued frame and what it holds of its socket's bound and of its
/// isolate's budget, which it gives back however it leaves the channel.
struct QueuedOut {
    out: Option<WsOut>,
    bytes: usize,
    budget: Option<Arc<dyn WsBudget>>,
    state: Arc<WsOutState>,
}

impl Drop for QueuedOut {
    fn drop(&mut self) {
        self.state.queued.fetch_sub(self.bytes, Ordering::AcqRel);
        self.state.drained.notify_waiters();
        if let Some(budget) = &self.budget {
            budget.release(self.bytes);
        }
    }
}

/// What a frame waiting in `WsMeta::pending` holds of its isolate's budget,
/// given back as it drops, or moved into the channel with the frame.
struct PendingCharge {
    bytes: usize,
    budget: Option<Arc<dyn WsBudget>>,
}

impl Drop for PendingCharge {
    fn drop(&mut self) {
        if let Some(budget) = self.budget.take() {
            budget.release(self.bytes);
        }
    }
}

/// What a frame taken from a socket's channel still holds of the socket's
/// bound and its isolate's budget. A writer keeps it until the frame is on
/// the connection, so a write that never finishes stays counted.
pub struct WsOutHeld {
    _charge: QueuedOut,
}

impl WsOutHeld {
    fn take(mut queued: QueuedOut) -> (WsOut, Self) {
        let out = queued.out.take().expect("a queued frame has its frame");
        (out, Self { _charge: queued })
    }
}

/// The sending end of a socket's outgoing frames, which the registry holds.
pub struct WsOutSender {
    tx: tokio::sync::mpsc::UnboundedSender<QueuedOut>,
    state: Arc<WsOutState>,
}

impl Clone for WsOutSender {
    fn clone(&self) -> Self {
        self.state.senders.fetch_add(1, Ordering::AcqRel);
        Self {
            tx: self.tx.clone(),
            state: self.state.clone(),
        }
    }
}

impl Drop for WsOutSender {
    fn drop(&mut self) {
        if self.state.senders.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.state.closed.notify_waiters();
        }
    }
}

/// Whether, and when, a socket's outgoing channel overflowed, and whether
/// its owner still holds it. Borrows nothing from the receiver.
#[derive(Clone)]
pub struct WsOutWatch(Arc<WsOutState>);

impl WsOutWatch {
    /// Whether the channel overflowed, so the socket is closing.
    pub fn overflowed(&self) -> bool {
        self.0.overflowed().is_some()
    }

    /// The reason the application and the peer see for the overflow, the
    /// socket's own bound's when it has not overflowed.
    pub fn reason(&self) -> &'static str {
        self.0.overflowed().unwrap_or(Overflow::Queue).reason()
    }

    /// Resolves once the queue overflows.
    pub async fn overflow(self) {
        loop {
            let overflow = self.0.overflow.notified();
            tokio::pin!(overflow);
            overflow.as_mut().enable();
            if self.overflowed() {
                return;
            }
            overflow.await;
        }
    }

    /// Resolves once no sender is left: the socket's owner unregistered it,
    /// or the request that held it ended, so nothing will send on it again.
    pub async fn closed(self) {
        loop {
            let closed = self.0.closed.notified();
            tokio::pin!(closed);
            closed.as_mut().enable();
            if self.0.senders.load(Ordering::Acquire) == 0 {
                return;
            }
            closed.await;
        }
    }
}

/// The receiving end, which the task that writes the socket's frames holds.
pub struct WsOutReceiver {
    rx: tokio::sync::mpsc::UnboundedReceiver<QueuedOut>,
    state: Arc<WsOutState>,
    /// The overflow's Close has been handed out, so nothing follows it.
    ended: bool,
}

/// What became of a frame offered to a socket's outgoing channel.
#[derive(Debug, PartialEq, Eq)]
pub enum WsOffered {
    Queued,
    /// This frame took the queue past [`WS_OUT_QUEUE_MAX_BYTES`], or past
    /// what its isolate's budget holds, so the socket closes, and the frame
    /// and every frame after it go nowhere.
    Overflowed,
    /// The socket's queue overflowed already, or its writer went away.
    Dropped,
}

/// A socket's outgoing channel, bounded to [`WS_OUT_QUEUE_MAX_BYTES`].
pub fn ws_out_channel() -> (WsOutSender, WsOutReceiver) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let state = Arc::new(WsOutState {
        queued: std::sync::atomic::AtomicUsize::new(0),
        overflowed: std::sync::atomic::AtomicU8::new(0),
        overflow: tokio::sync::Notify::new(),
        senders: std::sync::atomic::AtomicUsize::new(1),
        closed: tokio::sync::Notify::new(),
        drained: tokio::sync::Notify::new(),
    });
    (
        WsOutSender {
            tx,
            state: state.clone(),
        },
        WsOutReceiver {
            rx,
            state,
            ended: false,
        },
    )
}

impl WsOutSender {
    pub(crate) fn offer(&self, out: WsOut, budget: Option<&Arc<dyn WsBudget>>) -> WsOffered {
        self.offer_within(out, budget, WS_OUT_QUEUE_MAX_BYTES)
    }

    fn offer_within(
        &self,
        out: WsOut,
        budget: Option<&Arc<dyn WsBudget>>,
        bound: usize,
    ) -> WsOffered {
        if self.state.overflowed().is_some() {
            return WsOffered::Dropped;
        }
        // A Close is the last frame and small, so it never overflows.
        let close = matches!(out, WsOut::Close(..));
        let bytes = if close { 0 } else { out.queue_bytes() };
        let before = self.state.queued.fetch_add(bytes, Ordering::AcqRel);
        if !close && before > 0 && before.saturating_add(bytes) > bound {
            self.state.queued.fetch_sub(bytes, Ordering::AcqRel);
            self.state.overflow(Overflow::Queue);
            return WsOffered::Overflowed;
        }
        // Charged before it queues, so a frame its isolate cannot hold is
        // never held: the socket closes instead, and nothing condemns.
        let budget = budget.filter(|_| bytes > 0);
        if budget.is_some_and(|budget| !budget.charge(bytes)) {
            self.state.queued.fetch_sub(bytes, Ordering::AcqRel);
            self.state.overflow(Overflow::Budget);
            return WsOffered::Overflowed;
        }
        let queued = QueuedOut {
            out: Some(out),
            bytes,
            budget: budget.cloned(),
            state: self.state.clone(),
        };
        match self.tx.send(queued) {
            Ok(()) => WsOffered::Queued,
            Err(_) => WsOffered::Dropped,
        }
    }

    /// Queue a pending frame with the charge it took as it was buffered.
    fn enqueue_charged(&self, out: WsOut, mut charge: PendingCharge) {
        if self.state.overflowed().is_some() {
            return;
        }
        self.state.queued.fetch_add(charge.bytes, Ordering::AcqRel);
        let queued = QueuedOut {
            out: Some(out),
            bytes: charge.bytes,
            budget: charge.budget.take(),
            state: self.state.clone(),
        };
        // A writer that went away drops it, which gives the charge back.
        let _ = self.tx.send(queued);
    }

    /// Queue `out` uncharged, as a test's application does. Public for the
    /// socket tasks' tests, which live in the binary crate; nothing else
    /// sends but the registry, which charges the sender's budget.
    #[doc(hidden)]
    pub fn send(&self, out: WsOut) -> Result<(), WsOffered> {
        match self.offer(out, None) {
            WsOffered::Queued => Ok(()),
            refused => Err(refused),
        }
    }

    /// Close the socket as an overflow does, for a buffer that overflowed
    /// before this channel existed.
    fn overflow(&self, why: Overflow) {
        self.state.overflow(why);
    }
}

impl WsOutReceiver {
    /// The next frame to write. Once the queue overflows, that is a Close
    /// with [`WS_OUT_OVERFLOW_CODE`], in place of everything still queued,
    /// and then the end.
    pub async fn recv(&mut self) -> Option<WsOut> {
        self.recv_held().await.map(|(out, _held)| out)
    }

    /// [`recv`](Self::recv), with what the frame holds of its socket's
    /// bound and its isolate's budget, which stays held until the returned
    /// [`WsOutHeld`] goes: a writer keeps it until the frame is written.
    pub async fn recv_held(&mut self) -> Option<(WsOut, WsOutHeld)> {
        if self.ended {
            return None;
        }
        let next = {
            let overflow = self.state.overflow.notified();
            tokio::pin!(overflow);
            overflow.as_mut().enable();
            if self.state.overflowed().is_some() {
                None
            } else {
                crate::asyncrt::select_biased! {
                    "an overflow that ties a queued frame replaces it";
                    () = overflow => None,
                    next = self.rx.recv() => Some(next),
                }
            }
        };
        match next {
            Some(Some(queued)) if self.state.overflowed().is_none() => {
                Some(WsOutHeld::take(queued))
            }
            Some(None) => None,
            _ => Some(self.overflow_close()),
        }
    }

    /// The next frame, if one is queued now.
    pub fn try_recv(&mut self) -> Option<WsOut> {
        self.try_recv_held().map(|(out, _held)| out)
    }

    /// [`try_recv`](Self::try_recv), with what the frame holds.
    pub fn try_recv_held(&mut self) -> Option<(WsOut, WsOutHeld)> {
        if self.ended {
            return None;
        }
        if self.state.overflowed().is_some() {
            return Some(self.overflow_close());
        }
        Some(WsOutHeld::take(self.rx.try_recv().ok()?))
    }

    fn overflow_close(&mut self) -> (WsOut, WsOutHeld) {
        self.ended = true;
        self.rx.close();
        while self.rx.try_recv().is_ok() {}
        let reason = self.watch().reason();
        let held = WsOutHeld {
            _charge: QueuedOut {
                out: None,
                bytes: 0,
                budget: None,
                state: self.state.clone(),
            },
        };
        (WsOut::Close(WS_OUT_OVERFLOW_CODE, reason.to_string()), held)
    }

    /// Whether the queue overflowed, so the socket is closing.
    pub fn overflowed(&self) -> bool {
        self.state.overflowed().is_some()
    }

    /// A handle on this channel that borrows nothing from it.
    pub fn watch(&self) -> WsOutWatch {
        WsOutWatch(self.state.clone())
    }

    /// Take nothing more: the connection this channel wrote to is gone.
    /// What is still queued gives its charges back now.
    pub fn finish(&mut self) {
        self.ended = true;
        self.rx.close();
        while self.rx.try_recv().is_ok() {}
    }
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
    pub async fn drained(&self) {
        let tx = self.state.lock().unwrap().tx.clone();
        tx.closed().await;
    }
}

impl WsPullReceiver {
    pub async fn recv(&mut self) -> Option<WsPull> {
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
    /// A Close passed through.
    Closed,
    /// The sending side's queue overflowed while the receiving side's was
    /// full, and the receiving side got the overflow's Close.
    Overflowed,
    /// The sending side's registration went away without a Close.
    SourceGone,
    /// The receiving side stopped reading.
    DestinationGone,
}

/// Carry one direction of a bridge until a Close passes or a side goes away.
///
/// Each frame waits for room in the receiving queue, so that queue holds at
/// most its budget, and what the sending side sends meanwhile waits in its
/// own channel. That channel is bounded too: a receiving side that does not
/// read makes it overflow, which closes the sending side's socket as a TCP
/// peer that does not read would. The other direction runs separately and
/// is never held up by this one.
async fn carry_bridge_leg(from: &mut WsOutReceiver, to: &WsPullSender) -> BridgeLeg {
    let overflow = from.watch().overflow();
    tokio::pin!(overflow);
    loop {
        let frame = match from.recv().await {
            Some(WsOut::Text(text)) => WsPull::Text(text),
            Some(WsOut::Binary(bytes)) => WsPull::Binary(bytes),
            Some(WsOut::Close(code, reason)) => {
                let _ = to.send_close(code, reason, true);
                return if from.overflowed() {
                    BridgeLeg::Overflowed
                } else {
                    BridgeLeg::Closed
                };
            }
            None => return BridgeLeg::SourceGone,
        };
        crate::asyncrt::select_biased! {
            "an overflow ends the wait for room for a frame it discards";
            () = &mut overflow => {}
            sent = to.send(frame) => if sent.is_err() {
                return BridgeLeg::DestinationGone;
            },
        }
    }
}

/// The two ends a bridge joins: the socket the caller accepted, and the
/// handed-over server end in the isolate that answered the subrequest.
pub(crate) struct WorkerHandoffBridge {
    pub(crate) caller: u64,
    pub(crate) caller_pull: WsPullSender,
    pub(crate) from_caller: WsOutReceiver,
    pub(crate) target: WorkerWebSocket,
    pub(crate) from_target: WsOutReceiver,
}

/// Carry frames between a caller that accepted a handed-over Worker socket
/// and that socket's server end, which another isolate holds.
///
/// Both ends are isolate-polled, so each direction ends in a pull queue with
/// the usual 1 MiB budget, and each runs on its own. A side whose frames the
/// other does not read closes once its own channel overflows: the reader
/// gets the overflow's Close, and the sender closes abnormally.
///
/// A Close from either side reaches the other with the same code and reason.
/// A Close is a question that the other side answers, automatically or when
/// its Worker calls `close()`, so the bridge waits up to
/// [`WORKER_BRIDGE_CLOSE_TIMEOUT`] for that reply before it closes the side
/// that asked abnormally. A side that goes away without a Close closes the
/// other with 1006, which reports an error there.
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
    let (caller_watch, target_watch) = (from_caller.watch(), from_target.watch());
    {
        let to_target = carry_bridge_leg(&mut from_caller, &target_pull);
        let to_caller = carry_bridge_leg(&mut from_target, &caller_pull);
        tokio::pin!(to_target, to_caller);
        crate::asyncrt::select! {
            leg = &mut to_target => match leg {
                // The server end answers the caller's Close.
                BridgeLeg::Closed => {
                    let _ = asyncrt::timeout(close_timeout, &mut to_caller).await;
                }
                BridgeLeg::Overflowed => close_overflowed(&caller_pull, &caller_watch),
                BridgeLeg::SourceGone | BridgeLeg::DestinationGone => {}
            },
            leg = &mut to_caller => match leg {
                // The caller answers the server end's Close.
                BridgeLeg::Closed => {
                    let _ = asyncrt::timeout(close_timeout, &mut to_target).await;
                }
                BridgeLeg::Overflowed => close_overflowed(&target_pull, &target_watch),
                BridgeLeg::SourceGone | BridgeLeg::DestinationGone => {}
            },
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

/// Tell an isolate-polled socket whose outgoing queue overflowed that it
/// closed, abnormally, as a socket whose peer went away does.
pub fn close_overflowed(pull: &WsPullSender, overflow: &WsOutWatch) {
    let _ = pull.send_close(1006, overflow.reason().to_string(), false);
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

/// workerd's error for an I/O object (a socket, a body stream, a container)
/// used by code that does not own it. `object` is a Durable Object using
/// another one's object, which workerd words differently from every other
/// case. `kind` is workerd's I/O type.
pub(crate) fn foreign_io_error(object: bool, kind: &str) -> String {
    let text = if object {
        "Cannot perform I/O on behalf of a different Durable Object. I/O objects (such as \
         streams, request/response bodies, and others) created in the context of one Durable \
         Object cannot be accessed from a different Durable Object in the same isolate. This \
         is a limitation of Cloudflare Workers which allows us to improve overall performance."
    } else {
        "Cannot perform I/O on behalf of a different request. I/O objects (such as streams, \
         request/response bodies, and others) created in the context of one request handler \
         cannot be accessed from a different request's handler. This is a limitation of \
         Cloudflare Workers which allows us to improve overall performance."
    };
    format!("{text} (I/O type: {kind})")
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
    pub(crate) outputs: HashMap<u64, WsOutSender>,
    pub metadata: HashMap<u64, WsMeta>,
    /// The charge of each frame in a socket's `WsMeta::pending`, in order.
    /// [`WS_OUT_QUEUE_MAX_BYTES`] bounds their sum as it bounds a socket's
    /// channel, and each frame keeps its charge into the channel.
    pending_charges: HashMap<u64, Vec<PendingCharge>>,
    /// Sockets whose pending frames overflowed before any channel existed.
    /// The channel that registers for one closes at once.
    pending_overflowed: HashMap<u64, Overflow>,
    /// The budget that each socket's next frame is charged to: the isolate
    /// that last sent on it, which every sending op records again, so after
    /// an eviction, a generation swap or a redeploy the new isolate pays for
    /// what it sends. A frame keeps the budget it was charged to.
    budgets: HashMap<u64, Arc<dyn WsBudget>>,
    /// How many hibernatable sockets each Durable Object holds, against
    /// [`WS_HIBERNATABLE_PER_OBJECT`].
    pub(crate) hibernatable_counts: HashMap<String, usize>,
    /// The Durable Object each hibernatable socket counts against.
    pub(crate) hibernatable_objects: HashMap<u64, String>,
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
    /// Sockets whose peer's Close arrived, so the owner's only frame left to
    /// send is its reply. See [`ws_peer_closed`].
    pub(crate) peer_closed: HashSet<u64>,
    /// Returned Worker sockets whose request has ended, so nothing can send
    /// on them again. See [`ws_release_returned`].
    released: HashSet<u64>,
    /// Half-open sockets an isolate polls, each with the signal that ends
    /// its `__ws_half_open` op: dropped when the socket's Close is sent or
    /// the socket goes.
    pub(crate) half_open: HashMap<u64, tokio::sync::oneshot::Sender<()>>,
    /// Sockets that ended after their peer's Close, or whose outgoing queue
    /// overflowed, newest last. See [`ws_ended_after_peer_close`].
    ended_after_peer_close: EndedSockets,
}

/// The ids of sockets that ended after their peer's Close, so that a frame
/// their application sends late (a `close()` or `send()` on a half-open
/// socket after its peer left) is expected rather than a lost frame worth a
/// warning, and of sockets whose outgoing queue overflowed, whose
/// application goes on sending until its close event. Bounded: the oldest
/// ids go first, and a frame for one of them is reported as any other lost
/// frame is.
#[derive(Default)]
struct EndedSockets {
    ids: HashSet<u64>,
    order: std::collections::VecDeque<u64>,
}

impl EndedSockets {
    const LIMIT: usize = 4096;

    fn insert(&mut self, id: u64) {
        if !self.ids.insert(id) {
            return;
        }
        self.order.push_back(id);
        if self.order.len() > Self::LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
    }

    fn contains(&self, id: u64) -> bool {
        self.ids.contains(&id)
    }
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
    pub fn register(&mut self, id: u64, tx: WsOutSender) {
        let charges = self.pending_charges.remove(&id).unwrap_or_default();
        if let Some(why) = self.pending_overflowed.remove(&id) {
            tx.overflow(why);
        } else if let Some(meta) = self.metadata.get_mut(&id) {
            // Each frame moves into the channel with the charge it took,
            // within the bound, which bounded the buffer that held them.
            for (pending, charge) in meta.pending.drain(..).zip(charges) {
                tx.enqueue_charged(pending, charge);
            }
        }
        // The owner is gone: the receiver reads what it sent and then the
        // end of the channel.
        if self.released.contains(&id) {
            return;
        }
        self.outputs.insert(id, tx);
    }

    /// Discard socket `id`'s pending frames and give back their charge.
    fn clear_pending(&mut self, id: u64) {
        if let Some(meta) = self.metadata.get_mut(&id) {
            meta.pending.clear();
        }
        // Each charge goes back as it drops.
        self.pending_charges.remove(&id);
    }

    fn unregister(&mut self, id: u64) -> Option<WsMeta> {
        self.outputs.remove(&id);
        self.clear_pending(id);
        self.budgets.remove(&id);
        self.pending_overflowed.remove(&id);
        self.peer_closed.remove(&id);
        self.released.remove(&id);
        self.half_open.remove(&id);
        // A grant of this socket names nothing any more.
        self.grants.target_gone(id);
        if let Some(object) = self.hibernatable_objects.remove(&id) {
            self.uncount_hibernatable(&object);
        }
        self.metadata.remove(&id)
    }

    /// One fewer hibernatable socket for the Durable Object `scope`.
    fn uncount_hibernatable(&mut self, scope: &str) {
        if let Some(count) = self.hibernatable_counts.get_mut(scope) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.hibernatable_counts.remove(scope);
            }
        }
    }

    /// Record the budget that socket `id`'s next frames are charged to: the
    /// sending isolate's.
    pub(crate) fn charge_to(&mut self, id: u64, budget: &Arc<dyn WsBudget>) {
        self.budgets.insert(id, budget.clone());
    }

    #[doc(hidden)]
    pub fn emit(&mut self, id: u64, out: WsOut) {
        if matches!(out, WsOut::Close(..)) {
            self.half_open.remove(&id);
        }
        let budget = self.budgets.get(&id).cloned();
        if let Some(tx) = self.outputs.get(&id) {
            match tx.offer(out, budget.as_ref()) {
                WsOffered::Queued => tracing::debug!(ws_id = id, "queued outbound WebSocket frame"),
                WsOffered::Overflowed => {
                    self.ended_after_peer_close.insert(id);
                    log_overflow(id);
                }
                WsOffered::Dropped => {
                    tracing::debug!(ws_id = id, "dropped a frame for a closing WebSocket")
                }
            }
        } else if self.metadata.contains_key(&id) {
            if self.pending_overflowed.contains_key(&id) {
                tracing::debug!(ws_id = id, "dropped a frame for a closing WebSocket");
                return;
            }
            let close = matches!(out, WsOut::Close(..));
            let bytes = if close { 0 } else { out.queue_bytes() };
            let held: usize = self
                .pending_charges
                .get(&id)
                .map_or(0, |charges| charges.iter().map(|charge| charge.bytes).sum());
            let overflow =
                if !close && held > 0 && held.saturating_add(bytes) > WS_OUT_QUEUE_MAX_BYTES {
                    Some(Overflow::Queue)
                } else if budget
                    .as_ref()
                    .is_some_and(|budget| bytes > 0 && !budget.charge(bytes))
                {
                    Some(Overflow::Budget)
                } else {
                    None
                };
            if let Some(why) = overflow {
                self.clear_pending(id);
                self.pending_overflowed.insert(id, why);
                self.ended_after_peer_close.insert(id);
                log_overflow(id);
                return;
            }
            self.pending_charges
                .entry(id)
                .or_default()
                .push(PendingCharge {
                    bytes,
                    budget: budget.filter(|_| bytes > 0),
                });
            tracing::debug!(ws_id = id, "buffered pre-upgrade WebSocket frame");
            self.metadata.get_mut(&id).unwrap().pending.push(out);
        } else {
            log_dropped_frame(self, id);
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
pub fn ws_register_facet_for_test(id: u64, scope: &str, facet: FacetSocket, tx: WsOutSender) {
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
pub fn ws_register(id: u64, tx: WsOutSender) {
    ws_registry().lock().unwrap().register(id, tx);
}

/// Install one hibernatable socket through a cfg-gated execution backend.
#[cfg(celld_internal_tests)]
pub(crate) fn ws_register_hibernatable_for_test(id: u64, scope: &str, tx: WsOutSender) {
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
/// with a non-blocking drain, and a hibernatable socket whose handler sent
/// nothing ends without a reply -- so a close frame still behind the gate is
/// not merely late, it is lost, and the peer sees 1006. The wait is bounded by
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

/// Wait until socket `id`'s outgoing queue holds at most
/// [`WS_REPLY_BACKLOG_MAX_BYTES`], or until it overflowed or its owner let
/// go of it. The reader calls this after a reply the host made itself, so
/// that it reads no further than workerd does while the reply waits.
pub async fn ws_await_backlog(id: u64) {
    let Some(state) = ws_registry()
        .lock()
        .unwrap()
        .outputs
        .get(&id)
        .map(|sender| sender.state.clone())
    else {
        return;
    };
    loop {
        let drained = state.drained.notified();
        tokio::pin!(drained);
        drained.as_mut().enable();
        if state.queued.load(Ordering::Acquire) <= WS_REPLY_BACKLOG_MAX_BYTES
            || state.overflowed().is_some()
            || state.senders.load(Ordering::Acquire) == 0
        {
            return;
        }
        drained.await;
    }
}

/// Report a frame for socket `id` that has nowhere to go.
///
/// The socket is gone. Silence here is what made a held frame
/// indistinguishable from a sent one, so a drop is a warning, except for a
/// socket that ended after its peer's Close: its application may still
/// answer late, and that answer has no one left to reach. A socket whose
/// queue overflowed was reported once, as it closed.
pub(crate) fn log_dropped_frame(registry: &WsRegistry, id: u64) {
    if registry.ended_after_peer_close.contains(id) {
        tracing::debug!(
            ws_id = id,
            "dropped a frame for a socket that ended before its application stopped sending"
        );
    } else {
        tracing::warn!(ws_id = id, "dropped a frame for a closed WebSocket");
    }
}

/// Report the socket whose outgoing queue passed [`WS_OUT_QUEUE_MAX_BYTES`],
/// once: what its application sends from now on goes nowhere.
fn log_overflow(id: u64) {
    tracing::warn!(
        ws_id = id,
        limit = WS_OUT_QUEUE_MAX_BYTES,
        "closed a WebSocket whose sent messages waited past its limit or its isolate's memory limit"
    );
}

/// Socket `id`, whose peer sent its Close first, has ended: what its
/// application sends from now on is expected to go nowhere.
pub fn ws_ended_after_peer_close(id: u64) {
    ws_registry()
        .lock()
        .unwrap()
        .ended_after_peer_close
        .insert(id);
}

/// Whether `id` is a hibernatable socket, one `acceptWebSocket()` took.
pub fn ws_is_hibernatable(id: u64) -> bool {
    ws_registry()
        .lock()
        .unwrap()
        .metadata
        .get(&id)
        .is_some_and(|meta| meta.hibernatable)
}

/// The peer of socket `id` sent its Close, and the socket is waiting for its
/// owner's reply. A request that retires then ends the connection without a
/// Close of its own, as workerd drops the socket of an ended request.
pub fn ws_peer_closed(id: u64) {
    ws_registry().lock().unwrap().peer_closed.insert(id);
}

/// The request that returned these Worker sockets in its response has ended.
///
/// A returned socket outlives its request's retirement, because its pump
/// keeps the request's operations running until the peer closes. Once the
/// request is gone, nothing can send on the socket again, and a socket left
/// half-open by its peer's Close must end: its output channel ends, and a
/// connection task that registers it later finds it ended too.
pub(crate) fn ws_release_returned(ids: Vec<u64>) {
    if ids.is_empty() {
        return;
    }
    let registry = ws_registry();
    let mut registry = registry.lock().unwrap();
    for id in ids {
        // A socket that already went has no registration left to end.
        if registry.owners.contains_key(&id) {
            registry.outputs.remove(&id);
            registry.half_open.remove(&id);
            registry.released.insert(id);
        }
    }
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
        to_bridge_from_caller: WsOutSender,
        to_bridge_from_target: WsOutSender,
        target: WsPullReceiverHandle,
        done: asyncrt::TaskHandle<()>,
    }

    fn start_bridge(close_timeout: Duration) -> TestBridge {
        let (target, target_queue) = worker_socket();
        let (caller_pull, caller) = ws_pull_channel();
        let (to_bridge_from_caller, from_caller) = ws_out_channel();
        let (to_bridge_from_target, from_target) = ws_out_channel();
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
            // server end sees the caller's reply.
            bridge
                .to_bridge_from_target
                .send(WsOut::Close(4001, "bye".into()))
                .unwrap();
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((4001, "bye".into(), true))
            );
            bridge
                .to_bridge_from_caller
                .send(WsOut::Close(4002, "bye too".into()))
                .unwrap();
            assert_eq!(
                bridge.target.next_close().await,
                Some((4002, "bye too".into()))
            );
            bridge.done.await.unwrap();
        });
    }

    #[test]
    fn a_bridge_side_whose_frames_go_unread_closes_past_its_queue_limit() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_secs(5));
            // The caller never reads, so its 1 MiB queue fills and the
            // server end's frames wait in that end's own channel.
            let megabyte = || WsOut::Binary(vec![0; 1024 * 1024]);
            let mut refused = 0;
            for _ in 0..40 {
                if bridge.to_bridge_from_target.send(megabyte()).is_err() {
                    refused += 1;
                }
            }
            assert!(
                refused > 0,
                "the channel stops taking frames past its limit"
            );
            // The server end closes abnormally, with celld's reason.
            assert_eq!(
                bridge.target.next_close().await,
                Some((1006, WS_OUT_OVERFLOW_REASON.to_string()))
            );
            // The caller gets the overflow's Close after what reached it.
            let mut caller_close = None;
            while let Some(frame) = bridge.caller.recv().await {
                if let Some(close) = close_of(Some(frame)) {
                    caller_close = Some(close);
                }
            }
            assert_eq!(
                caller_close,
                Some((
                    WS_OUT_OVERFLOW_CODE,
                    WS_OUT_OVERFLOW_REASON.to_string(),
                    true
                ))
            );
            bridge.done.await.unwrap();
        });
    }

    #[test]
    fn an_outgoing_queue_closes_once_it_passes_its_budget() {
        asyncrt::test_host_runtime().block_on(async {
            let (sender, mut receiver) = ws_out_channel();
            let frame = |bytes| WsOut::Binary(vec![0; bytes]);
            // One message enters an empty queue whatever its size.
            assert_eq!(
                sender.offer_within(frame(4096), None, 1024),
                WsOffered::Queued
            );
            assert!(
                matches!(receiver.try_recv(), Some(WsOut::Binary(bytes)) if bytes.len() == 4096)
            );
            // Taking it returned its budget.
            assert_eq!(
                sender.offer_within(frame(600), None, 1024),
                WsOffered::Queued
            );
            assert_eq!(
                sender.offer_within(frame(600), None, 1024),
                WsOffered::Overflowed
            );
            assert!(receiver.overflowed());
            // Nothing more enters, a Close included.
            assert_eq!(
                sender.offer_within(frame(1), None, 1024),
                WsOffered::Dropped
            );
            assert_eq!(
                sender.offer_within(WsOut::Close(1000, String::new()), None, 1024),
                WsOffered::Dropped
            );
            // What was queued gives way to the overflow's Close, then the end.
            assert!(matches!(
                receiver.recv().await,
                Some(WsOut::Close(WS_OUT_OVERFLOW_CODE, reason)) if reason == WS_OUT_OVERFLOW_REASON
            ));
            assert!(receiver.recv().await.is_none());
            assert!(receiver.try_recv().is_none());
            assert!(
                WS_OUT_OVERFLOW_REASON.len() <= 123,
                "a Close reason fits its frame"
            );
        });
    }

    /// A budget of `limit` bytes that counts what it holds.
    struct TestBudget {
        limit: usize,
        used: std::sync::atomic::AtomicUsize,
    }

    impl WsBudget for TestBudget {
        fn charge(&self, bytes: usize) -> bool {
            let used = self.used.load(Ordering::Acquire);
            if used + bytes > self.limit {
                return false;
            }
            self.used.fetch_add(bytes, Ordering::AcqRel);
            true
        }

        fn release(&self, bytes: usize) {
            self.used.fetch_sub(bytes, Ordering::AcqRel);
        }
    }

    fn test_budget(limit: usize) -> (Arc<TestBudget>, Arc<dyn WsBudget>) {
        let budget = Arc::new(TestBudget {
            limit,
            used: std::sync::atomic::AtomicUsize::new(0),
        });
        (budget.clone(), budget)
    }

    #[test]
    fn queued_frames_are_charged_to_their_isolate_and_given_back() {
        let (counted, budget) = test_budget(10_000);
        let (sender, mut receiver) = ws_out_channel();
        assert_eq!(
            sender.offer(WsOut::Binary(vec![0; 4000]), Some(&budget)),
            WsOffered::Queued
        );
        assert_eq!(
            sender.offer(WsOut::Binary(vec![0; 4000]), Some(&budget)),
            WsOffered::Queued
        );
        let held = counted.used.load(Ordering::Acquire);
        assert!(held >= 8000);
        // Taking a frame gives its charge back.
        assert!(receiver.try_recv().is_some());
        assert!(counted.used.load(Ordering::Acquire) < held);
        // Past the budget the socket closes, with the budget's reason.
        assert_eq!(
            sender.offer(WsOut::Binary(vec![0; 8000]), Some(&budget)),
            WsOffered::Overflowed
        );
        assert!(matches!(
            receiver.try_recv(),
            Some(WsOut::Close(WS_OUT_OVERFLOW_CODE, reason)) if reason == WS_OUT_BUDGET_REASON
        ));
        // The discarded frame gave its charge back too.
        assert_eq!(counted.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_frame_stays_charged_until_its_writer_lets_it_go() {
        let (counted, budget) = test_budget(10_000);
        let (sender, mut receiver) = ws_out_channel();
        sender.offer(WsOut::Binary(vec![0; 4000]), Some(&budget));
        let (_frame, held) = receiver.try_recv_held().unwrap();
        assert!(
            counted.used.load(Ordering::Acquire) >= 4000,
            "a write under way stays charged"
        );
        drop(held);
        assert_eq!(counted.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn registering_moves_pending_charges_without_charging_again() {
        // The budget fits the pending frames once, not twice.
        let (counted, budget) = test_budget(5000);
        let registry = own_registry();
        let mut registry = registry.lock().unwrap();
        let id = 10;
        registry.metadata.insert(
            id,
            WsMeta {
                scope: String::new(),
                hibernatable: false,
                tags: Vec::new(),
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet: None,
            },
        );
        registry.charge_to(id, &budget);
        registry.emit(id, WsOut::Binary(vec![0; 2000]));
        registry.emit(id, WsOut::Binary(vec![0; 2000]));
        let charged = counted.used.load(Ordering::Acquire);
        let (sender, mut receiver) = ws_out_channel();
        registry.register(id, sender);
        assert_eq!(counted.used.load(Ordering::Acquire), charged);
        assert!(matches!(receiver.try_recv(), Some(WsOut::Binary(_))));
        assert!(matches!(receiver.try_recv(), Some(WsOut::Binary(_))));
        assert_eq!(counted.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn each_frame_is_charged_to_the_isolate_that_sent_it_last() {
        let (first, first_budget) = test_budget(10_000);
        let (second, second_budget) = test_budget(10_000);
        let registry = own_registry();
        let mut registry = registry.lock().unwrap();
        let id = 11;
        let (sender, mut receiver) = ws_out_channel();
        registry.register(id, sender);
        registry.charge_to(id, &first_budget);
        registry.emit(id, WsOut::Binary(vec![0; 1000]));
        // A new isolate, after a redeploy, sends on the same socket.
        registry.charge_to(id, &second_budget);
        registry.emit(id, WsOut::Binary(vec![0; 1000]));
        assert!(first.used.load(Ordering::Acquire) >= 1000);
        assert!(second.used.load(Ordering::Acquire) >= 1000);
        assert!(receiver.try_recv().is_some());
        assert_eq!(first.used.load(Ordering::Acquire), 0);
        assert!(receiver.try_recv().is_some());
        assert_eq!(second.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_receiver_that_goes_gives_its_frames_charges_back() {
        let (counted, budget) = test_budget(10_000);
        let (sender, receiver) = ws_out_channel();
        sender.offer(WsOut::Text("x".repeat(1000)), Some(&budget));
        assert!(counted.used.load(Ordering::Acquire) > 0);
        drop(receiver);
        assert_eq!(counted.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn pending_frames_are_charged_and_a_refused_one_closes_the_socket() {
        let (counted, budget) = test_budget(3000);
        let registry = own_registry();
        let mut registry = registry.lock().unwrap();
        let id = 9;
        registry.metadata.insert(
            id,
            WsMeta {
                scope: String::new(),
                hibernatable: false,
                tags: Vec::new(),
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet: None,
            },
        );
        registry.charge_to(id, &budget);
        registry.emit(id, WsOut::Binary(vec![0; 2000]));
        assert!(counted.used.load(Ordering::Acquire) >= 2000);
        registry.emit(id, WsOut::Binary(vec![0; 2000]));
        assert!(registry.metadata[&id].pending.is_empty());
        assert_eq!(counted.used.load(Ordering::Acquire), 0);
        let (sender, mut receiver) = ws_out_channel();
        registry.register(id, sender);
        assert!(matches!(
            receiver.try_recv(),
            Some(WsOut::Close(WS_OUT_OVERFLOW_CODE, reason)) if reason == WS_OUT_BUDGET_REASON
        ));
    }

    #[test]
    fn the_owner_going_closes_the_watch() {
        asyncrt::test_host_runtime().block_on(async {
            let (sender, receiver) = ws_out_channel();
            let copy = sender.clone();
            let closed = receiver.watch().closed();
            tokio::pin!(closed);
            drop(sender);
            assert!(
                asyncrt::timeout(Duration::from_millis(50), &mut closed)
                    .await
                    .is_err(),
                "a sender is left"
            );
            drop(copy);
            asyncrt::timeout(Duration::from_secs(1), closed)
                .await
                .expect("no sender is left");
        });
    }

    #[test]
    fn a_close_enters_a_full_queue() {
        let (sender, mut receiver) = ws_out_channel();
        assert_eq!(
            sender.offer_within(WsOut::Binary(vec![0; 2048]), None, 1024),
            WsOffered::Queued
        );
        assert_eq!(
            sender.offer_within(WsOut::Close(4000, "bye".into()), None, 1024),
            WsOffered::Queued
        );
        assert!(matches!(receiver.try_recv(), Some(WsOut::Binary(_))));
        assert!(matches!(receiver.try_recv(), Some(WsOut::Close(4000, _))));
    }

    #[test]
    fn frames_buffered_before_a_socket_registers_are_bounded() {
        let registry = own_registry();
        let mut registry = registry.lock().unwrap();
        let id = 7;
        registry.metadata.insert(
            id,
            WsMeta {
                scope: String::new(),
                hibernatable: false,
                tags: Vec::new(),
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet: None,
            },
        );
        let megabytes = WS_OUT_QUEUE_MAX_BYTES / (1024 * 1024);
        for _ in 0..megabytes - 1 {
            registry.emit(id, WsOut::Binary(vec![0; 1024 * 1024]));
        }
        assert_eq!(registry.metadata[&id].pending.len(), megabytes - 1);
        registry.emit(id, WsOut::Binary(vec![0; 2 * 1024 * 1024]));
        // Past the budget the buffer empties, and takes nothing more.
        assert!(registry.metadata[&id].pending.is_empty());
        registry.emit(id, WsOut::Text("late".into()));
        assert!(registry.metadata[&id].pending.is_empty());
        // The channel that registers for the socket closes at once.
        let (sender, mut receiver) = ws_out_channel();
        registry.register(id, sender);
        assert!(matches!(
            receiver.try_recv(),
            Some(WsOut::Close(WS_OUT_OVERFLOW_CODE, _))
        ));
        assert!(receiver.try_recv().is_none());
    }

    #[test]
    fn frames_buffered_within_the_budget_reach_the_channel() {
        let registry = own_registry();
        let mut registry = registry.lock().unwrap();
        let id = 8;
        registry.metadata.insert(
            id,
            WsMeta {
                scope: String::new(),
                hibernatable: false,
                tags: Vec::new(),
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet: None,
            },
        );
        registry.emit(id, WsOut::Text("first".into()));
        registry.emit(id, WsOut::Close(1000, String::new()));
        let (sender, mut receiver) = ws_out_channel();
        registry.register(id, sender);
        assert!(matches!(receiver.try_recv(), Some(WsOut::Text(text)) if text == "first"));
        assert!(matches!(receiver.try_recv(), Some(WsOut::Close(1000, _))));
    }

    #[test]
    fn ended_sockets_keep_the_newest_ids() {
        let mut ended = EndedSockets::default();
        for id in 0..=EndedSockets::LIMIT as u64 {
            ended.insert(id);
        }
        ended.insert(5);
        assert!(!ended.contains(0), "the oldest id goes");
        assert!(ended.contains(1) && ended.contains(EndedSockets::LIMIT as u64));
        assert_eq!(ended.order.len(), EndedSockets::LIMIT);
    }

    #[test]
    fn a_server_close_with_no_reply_ends_in_1006() {
        asyncrt::test_host_runtime().block_on(async {
            let mut bridge = start_bridge(Duration::from_millis(50));
            bridge
                .to_bridge_from_target
                .send(WsOut::Close(4001, "bye".into()))
                .unwrap();
            assert_eq!(
                close_of(bridge.caller.recv().await),
                Some((4001, "bye".into(), true))
            );
            // The caller never answers.
            assert_eq!(
                bridge.target.next_close().await,
                Some((1006, String::new()))
            );
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
