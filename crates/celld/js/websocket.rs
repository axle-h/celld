// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! WebSockets inside the isolate: the registry, the ops JS calls, and the
//! frames waiting to leave.
//!
//! A socket outlives the event that created it, so the registry is what
//! connects the two — JS holds an id, and this module knows what that id
//! is attached to. Frames emitted inside an output-gate region are held
//! until the gate opens, which is why emitting is not simply a send.
use super::*;
pub use crate::ws_registry::*;

#[derive(Default)]
pub(super) struct WsCapture {
    frames: WsBatch,
    /// The handler whose outcome authorizes an incremental flush. This is
    /// installed after the synchronous dispatch returns its promise; until
    /// then no turn-end flush can run.
    promise: Option<v8::Global<v8::Promise>>,
}

/// workerd's text for an I/O object used from a request other than the one
/// that created it.
const CROSS_REQUEST_IO: &str = "Cannot perform I/O on behalf of a different request. I/O \
     objects (such as streams, request/response bodies, and others) created in the context \
     of one request handler cannot be accessed from a different request's handler. This is \
     a limitation of Cloudflare Workers which allows us to improve overall performance. \
     (I/O type: WebSocket)";

/// The refusal for a non-zero id that names no socket the running code
/// could register again: it closed, or it was never allocated.
const NOT_VALID: &str = "WebSocket is not valid";

/// The owner of the sockets that code running in `context` allocates, and
/// the only owner whose sockets it may use: the Durable Object or facet of
/// the running cell event, or else the request.
pub(super) fn owner_of(context: &IoContext) -> WsOwner {
    match current_cell_event(context) {
        Some(frame) => WsOwner::Cell(frame.storage),
        None => WsOwner::Request(context.handoff_request),
    }
}

/// The scope of the running cell event, for the ops that act on a Durable
/// Object's own sockets. JavaScript never names the cell: a scope it passed
/// would reach another object's sockets.
fn running_cell(context: &IoContext) -> Result<String, String> {
    current_cell_event(context)
        .map(|frame| frame.storage)
        .ok_or_else(|| {
            "Durable Object WebSocket state is available only while one of that Durable \
             Object's own events runs"
                .to_string()
        })
}

fn throw_type_error(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::type_error(scope, message);
    scope.throw_exception(exception);
}

/// Whether `owner` may act on socket `id`. `Ok(false)` for an id that names
/// no open socket, which the op treats as it treats a closed socket.
/// Another owner's socket is refused with workerd's cross-request error.
fn may_use(owner: &WsOwner, id: u64) -> Result<bool, String> {
    match ws_access(id, owner) {
        WsAccess::Owned => Ok(true),
        WsAccess::Unknown => Ok(false),
        WsAccess::Other => Err(CROSS_REQUEST_IO.to_string()),
    }
}

/// The id an op registers a socket under: a new id that `owner` owns for 0,
/// or `id` itself when `owner` owns it already.
fn claim(owner: &WsOwner, id: u64) -> Result<u64, String> {
    if id == 0 {
        return Ok(ws_allocate(owner.clone()));
    }
    match ws_access(id, owner) {
        WsAccess::Owned => Ok(id),
        WsAccess::Unknown => Err(NOT_VALID.to_string()),
        WsAccess::Other => Err(CROSS_REQUEST_IO.to_string()),
    }
}

/// Admit a Durable Object socket target that JavaScript names, for the
/// `accept()` that binds it or the response that returns it.
///
/// A target is `{id, scope, tunnel}`, which JavaScript carries and so could
/// copy from another request's socket. The code running in `context` may use
/// it only if a subrequest's response granted it exactly that target, which
/// this use consumes, or if the target is that Durable Object's own socket
/// under its own scope.
pub(super) fn admit_target(context: &IoContext, target: &WsTarget) -> Result<(), String> {
    let owner = owner_of(context);
    if ws_take_grant(target, &owner) {
        return Ok(());
    }
    let own = match &owner {
        WsOwner::Cell(cell) => {
            target.tunnel.is_none()
                && *cell == target.scope
                && ws_access(target.id, &owner) == WsAccess::Owned
        }
        WsOwner::Request(_) => false,
    };
    if own {
        return Ok(());
    }
    if ws_granted_elsewhere(target, &owner) || ws_access(target.id, &owner) == WsAccess::Other {
        return Err(CROSS_REQUEST_IO.to_string());
    }
    Err(NOT_VALID.to_string())
}

/// The token `__ws_owner` answers for `owner`: an even number for a request,
/// an odd one for a Durable Object, so the harness can choose workerd's text.
///
/// A request's is its unique number. An object's comes from a keyed hash of
/// its scope, in 52 bits so it stays exact as a JavaScript number: two
/// objects in one isolate share one only by a collision of that hash. The
/// token is workerd's I/O check, which fails early with workerd's text. The
/// host's own owner check, on full owners, is what refuses the socket.
fn owner_token(owner: &WsOwner) -> f64 {
    const BITS: u64 = (1 << 52) - 1;
    match owner {
        WsOwner::Request(request) => ((request & BITS) << 1) as f64,
        WsOwner::Cell(cell) => {
            static KEYS: std::sync::OnceLock<std::collections::hash_map::RandomState> =
                std::sync::OnceLock::new();
            let hash = std::hash::BuildHasher::hash_one(KEYS.get_or_init(Default::default), cell);
            (((hash & BITS) << 1) | 1) as f64
        }
    }
}

/// `__ws_owner()`: the token of the owner of the running code. A socket
/// object keeps the token of the code that made it and compares, so a
/// socket used from another request or Durable Object fails before its own
/// state is consulted, as workerd's I/O ownership check does.
pub(super) fn op_ws_owner(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let context = event_context(scope);
    // The running event's frame is in place before any of its code runs,
    // and stays for the context's life, so the owner never changes.
    let token = *context
        .ws_owner_token
        .get_or_init(|| owner_token(&owner_of(&context)));
    rv.set(v8::Number::new(scope, token).into());
}

fn id_arg(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, index: i32) -> u64 {
    args.get(index)
        .to_integer(scope)
        .map(|n| n.value() as u64)
        .unwrap_or(0)
}

/// Register the server end of a pair that a Worker returns in a 101, which
/// the host carries to the client. Returns its id.
fn prepare_worker_websocket_handoff(context: &IoContext, id: u64) -> Result<u64, String> {
    let id = claim(&owner_of(context), id)?;
    let (inbound, receiver) = ws_pull_channel();
    ws_pull_register(id, receiver);
    ws_register_outbound(id, "", None);
    ws_track_request_socket(context, id);
    let registry = ws_registry();
    let replaced = registry.lock().unwrap().worker_handoffs.insert(id, inbound);
    drop(replaced);
    Ok(id)
}

/// Take the frame channel of the socket `id` that `__readResponse` prepared,
/// for the response that carries it. `Ok(None)` when there is none.
pub(super) fn transfer_worker_websocket_handoff(
    context: &IoContext,
    id: u64,
) -> Result<Option<WorkerWebSocket>, String> {
    if !may_use(&owner_of(context), id)? {
        return Ok(None);
    }
    let Some(inbound) = ws_registry().lock().unwrap().worker_handoffs.remove(&id) else {
        return Ok(None);
    };
    // The response now owns cleanup. Transfer the frame channel and request
    // ownership together so request retirement cannot close a returned socket.
    context
        .sockets
        .lock()
        .unwrap()
        .retain(|opened| *opened != id);
    Ok(Some(WorkerWebSocket::new(id, inbound)))
}

/// The message for a handed-over socket that cannot be used.
fn handoff_refusal(refusal: WorkerHandoffRefusal) -> String {
    match refusal {
        WorkerHandoffRefusal::OtherRequest => CROSS_REQUEST_IO.to_string(),
        WorkerHandoffRefusal::Gone => {
            "The WebSocket that the subrequest returned is no longer open".to_string()
        }
    }
}

/// Take a handed-over socket that `context`'s request adopted, for its
/// response or its `accept()`, with the caller id the host chose.
///
/// The host parked the socket for the request that made the call and lets
/// only that request adopt and take it, so a socket object that reached
/// another request's hands, or a token another request learned, moves
/// nothing.
fn take_request_worker_handoff(
    context: &IoContext,
    token: &WorkerHandoffToken,
) -> std::result::Result<(WorkerWebSocket, u64), String> {
    let taken = take_worker_handoff(token, context.handoff_request).map_err(handoff_refusal)?;
    context
        .worker_handoffs
        .lock()
        .unwrap()
        .retain(|owned| owned != token);
    Ok(taken)
}

/// Take a handed-over socket that `context`'s request adopted and now
/// returns in its response. The caller's end the host chose at adoption was
/// never registered, so its owner goes.
pub(super) fn take_response_worker_handoff(
    context: &IoContext,
    token: &WorkerHandoffToken,
) -> std::result::Result<WorkerWebSocket, String> {
    let (socket, caller) = take_request_worker_handoff(context, token)?;
    ws_unregister(caller);
    Ok(socket)
}

/// `__ws_adopt_worker_handoff(token)`: give a socket that a subrequest's 101
/// carried to the request whose continuation is running, which must be the
/// request that made the call. That request releases the socket when it
/// retires unless it returns or accepts it first. Returns the id of the
/// caller's own end, which the host chooses.
pub(super) fn op_ws_adopt_worker_handoff(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let token = WorkerHandoffToken::from(args.get(0).to_rust_string_lossy(scope));
    let context = event_context(scope);
    let caller =
        match adopt_worker_handoff(&token, context.handoff_request, owner_of(&context)) {
            Ok(caller) => caller,
            Err(WorkerHandoffRefusal::Gone) => return loader_throw(
                scope,
                "The WebSocket that the subrequest returned closed before its caller could take it",
            ),
            Err(refusal) => return loader_throw(scope, &handoff_refusal(refusal)),
        };
    context.worker_handoffs.lock().unwrap().push(token);
    rv.set(v8::Number::new(scope, caller as f64).into());
}

/// Take the handed-over socket that `accept()` binds to the caller's end
/// `id`. The caller's end registers under the id the host chose at
/// adoption, never one that application code wrote on the socket object: a
/// different id closes the server end with 1011 and fails the `accept()`.
fn take_for_accept(
    context: &IoContext,
    token: &WorkerHandoffToken,
    id: u64,
) -> std::result::Result<WorkerWebSocket, String> {
    let (target, caller) = take_request_worker_handoff(context, token)?;
    if caller != id {
        // Nothing registered the caller's end, and nothing will.
        ws_unregister(caller);
        close_handed_over(target, 1011, NOT_VALID, false);
        return Err(NOT_VALID.to_string());
    }
    Ok(target)
}

/// The handed-over socket that `accept()` on the caller's end `id` bridges
/// to, when the running code owns `id`.
fn take_for_bind(
    context: &IoContext,
    token: &WorkerHandoffToken,
    id: u64,
) -> std::result::Result<WorkerWebSocket, String> {
    // An id that names no socket fails as one the host did not choose.
    may_use(&owner_of(context), id)?;
    take_for_accept(context, token, id)
}

/// `__ws_bind_worker_handoff(id, token)`: `accept()` on a socket that a
/// subrequest's 101 handed to this request. The server end lives in another
/// isolate, so the host carries both directions between it and this
/// isolate's socket `id`.
pub(super) fn op_ws_bind_worker_handoff(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let token = WorkerHandoffToken::from(args.get(1).to_rust_string_lossy(scope));
    let context = event_context(scope);
    // The caller's own route, empty for a Worker.
    let (cell, facet) = match dialing_route(&context) {
        Ok(route) => route,
        Err(error) => return loader_throw(scope, &error),
    };
    let target = match take_for_bind(&context, &token, id) {
        Ok(target) => target,
        Err(error) => return loader_throw(scope, &error),
    };
    // Every registration happens here, on the JS thread, before the bridge
    // task exists: a frame either side sends from now on has a channel, and
    // the frames the server end sent before this point flush from its
    // pre-upgrade buffer into the bridge.
    let (caller_pull, caller_queue) = ws_pull_channel();
    ws_pull_register(id, caller_queue);
    if cell.is_empty() {
        ws_track_request_socket(&context, id);
    }
    ws_register_outbound(id, &cell, facet);
    let (caller_tx, from_caller) = tokio::sync::mpsc::unbounded_channel();
    ws_register(id, caller_tx);
    let (target_tx, from_target) = tokio::sync::mpsc::unbounded_channel();
    ws_register(target.id(), target_tx);
    asyncrt::op_handle().spawn(bridge_worker_handoff(WorkerHandoffBridge {
        caller: id,
        caller_pull,
        from_caller,
        target,
        from_target,
    }));
}

/// Close every isolate-polled socket a finished request opened.
///
/// The close frame is what actually ends the connection: the connector task
/// writes it to the wire and stops pumping, and only then does it drop the
/// `WsPull` sender that this socket's `__ws_next` is waiting on. Unregistering
/// first would strand the task instead — it detects a dead isolate by the
/// send failing, and nothing else tells it to go.
pub(super) fn ws_close_request_sockets(opened: Vec<u64>) {
    for id in opened {
        let registry = ws_registry();
        let handoff = registry.lock().unwrap().worker_handoffs.remove(&id);
        drop(handoff);
        // A socket whose remote already hung up has no output sender left,
        // and that is the ordinary case rather than an error. `ws_emit` logs
        // a dropped frame for an unknown id, so ask before sending.
        let open = ws_registry().lock().unwrap().outputs.contains_key(&id);
        if open {
            // The event's own end, run by its turn: the owner is the context.
            ws_emit(
                &current_context(),
                id,
                WsOut::Close(1001, "request ended".into()),
            );
        }
        ws_pull_unregister(id);
        ws_unregister(id);
    }
}

/// Account a Worker socket to the request that opened it, the request that
/// owns it.
fn ws_track_request_socket(context: &IoContext, id: u64) {
    context.sockets.lock().unwrap().push(id);
}

pub(super) fn ws_capture_begin() {
    current_context()
        .ws_capture
        .lock()
        .unwrap()
        .push(WsCapture::default());
}

pub(super) fn ws_capture_set_promise(context: &IoContext, promise: v8::Global<v8::Promise>) {
    context
        .ws_capture
        .lock()
        .unwrap()
        .last_mut()
        .expect("a WebSocket handler has an active capture")
        .promise = Some(promise);
}

pub(super) fn ws_capture_take() -> WsBatch {
    current_context()
        .ws_capture
        .lock()
        .unwrap()
        .pop()
        .unwrap_or_default()
        .frames
}

pub(super) fn ws_capture_discard(context: &IoContext) {
    if let Some(capture) = context.ws_capture.lock().unwrap().pop() {
        capture.frames.discard();
    }
}

/// Release what a running `webSocketMessage` handler has sent so far.
///
/// Called at the end of every turn, so a handler that suspends delivers the
/// frames it has already sent instead of holding them until it returns. An
/// AI chat agent streams its answer through this path: it sends a chunk, it
/// awaits the next one, and a client that receives the whole answer in one
/// burst at the end has lost the streaming the application was written for
/// (denoland/celld#229).
///
/// One ticket covers the turn rather than one for each frame, because a
/// broadcast sends the same chunk to every client in one turn and a ticket
/// for each of them would cost a core round trip for each of them.
///
/// The capture stays in place, so the frames of a later turn are held and
/// released the same way. A handler that never suspends captures its frames
/// in one turn and answers in it, so `ws_capture_take` finds them first and
/// this releases nothing: that handler still leaves through the cell's
/// barrier queue, exactly as before.
fn ws_capture_flush(tc: &mut v8::PinScope, context: &IoContext) {
    let frames = {
        let mut capture = context.ws_capture.lock().unwrap();
        let Some(pending) = capture.last() else {
            return;
        };
        let Some(promise) = pending.promise.as_ref() else {
            return;
        };
        match v8::Local::new(tc, promise).state() {
            v8::PromiseState::Pending => {}
            // The event's own settlement takes a fulfilled capture with its
            // dispatch. Flushing it here would split the established batch.
            v8::PromiseState::Fulfilled => return,
            // A foreign handler can reject wholly inside this turn's
            // checkpoint, before its own driver gets a turn in which to run
            // `settle`. Drop its frames now instead of publishing output
            // from a failed dispatch.
            v8::PromiseState::Rejected => {
                std::mem::take(&mut capture.last_mut().unwrap().frames).discard();
                return;
            }
        }
        let pending = capture.last_mut().unwrap();
        if pending.frames.is_empty() {
            return;
        }
        std::mem::take(&mut pending.frames)
    };
    // Every captured frame belongs to a hibernatable socket, because that is
    // what `ws_emit` captures, so one channel names the whole batch.
    let gate = egress_gate_request(context, celld_logic::Channel::WsHibernatable);
    // On the HOST runtime, for the reason `ws_emit` spawns there: this flush
    // must outlive the turn that produced the frames, and the ticket it waits
    // for resolves with no isolate involvement.
    asyncrt::op_handle().spawn(async move {
        let held = await_egress_gate(gate).await;
        frames.release(held);
    });
}

/// Flush every capture that received a frame during this isolate turn.
///
/// Weak references make this list bookkeeping rather than event ownership.
/// A context that retires before the turn ends therefore disappears instead
/// of being kept alive only to flush output that its dispatch cannot return.
pub(super) fn ws_capture_flush_touched(tc: &mut v8::PinScope, runtime_state: &ActorRuntimeState) {
    let touched = std::mem::take(&mut *runtime_state.ws_capture_touched.lock().unwrap());
    for context in touched.into_iter().filter_map(|context| context.upgrade()) {
        ws_capture_flush(tc, &context);
    }
}

/// Send or hold one frame. `context` is the event the sending JavaScript
/// belongs to: the continuation's own for a V8 entry point, so a reaction of
/// cell A that runs inside another event's checkpoint is captured by and
/// gated against A, not the checkpoint's owner.
fn ws_emit(context: &Arc<IoContext>, id: u64, out: WsOut) {
    let mut capture = context.ws_capture.lock().unwrap();
    if !capture.is_empty() && ws_channel(id) == celld_logic::Channel::WsHibernatable {
        capture.last_mut().unwrap().frames.capture(id, out);
        let runtime_state = context
            .continuation
            .as_ref()
            .and_then(|(_, runtime_state)| runtime_state.upgrade())
            .expect("a WebSocket capture belongs to a live tracked context");
        let mut touched = runtime_state.ws_capture_touched.lock().unwrap();
        if !touched.iter().any(|candidate| {
            candidate
                .upgrade()
                .is_some_and(|candidate| Arc::ptr_eq(&candidate, context))
        }) {
            touched.push(Arc::downgrade(context));
        }
        return;
    }
    drop(capture);
    // A socket the isolate opened itself, which the capture above deliberately
    // will not hold: releasing captured frames waits for the handler to
    // return, and this handler may be awaiting a reply to the very frame being
    // held. Waiting on the DURABILITY ticket instead has no such cycle -- it
    // is resolved by the replicator, which does not need this event loop -- so
    // the frame can be held without deadlocking the script that sent it.
    let gate = egress_gate_request(context, ws_channel(id));
    // Resolved here, on the thread the frame was sent from; the registry is
    // moved into the flush below. The flush runs on a runtime that has no
    // services of its own, so a lookup inside it would answer with whichever
    // instance that runtime reaches — the socket's frames and the socket's
    // registry could then come from two different instances.
    let flush = ws_flush_state();
    let registry = ws_registry();
    // Gated for a read-only frame as well, and deliberately: the frame reveals
    // what the cell holds, so it has to ask the core whether a barrier is open
    // rather than assume its own event opened one. A cell with nothing
    // outstanding answers at once and the queue flushes on the same tick.
    let Some(flushing) =
        flush.emit_or_defer(&registry, std::iter::once((id, out)), gate.is_gated())
    else {
        return;
    };
    // Detached onto the HOST runtime (`op_handle`) deliberately: this flush
    // exists precisely to outlive the dispatch that produced the frames — a
    // writing connect handler's ready frame, an alarm broadcast — and it
    // awaits a durability ticket that resolves with no isolate involvement.
    // Both region-owned homes silently kill it: `asyncrt::enqueue`'s future is
    // aborted when the dispatch region closes, and the isolate thread's local
    // request driver stops polling its operation future the moment the
    // dispatch returns. Either way the frames never left the process.
    asyncrt::op_handle().spawn(async move {
        let held = await_egress_gate(gate).await;
        flushing.release(&registry, held);
    });
}

/// Send or hold one frame on a socket that the code running in `context`
/// owns. A socket that is not open drops the frame, as a closed one did.
fn emit_as(context: &Arc<IoContext>, id: u64, out: WsOut) -> Result<(), String> {
    if may_use(&owner_of(context), id)? {
        ws_emit(context, id, out);
    } else {
        tracing::warn!(ws_id = id, "dropped a frame for a closed WebSocket");
    }
    Ok(())
}

fn emit_checked(scope: &mut v8::PinScope, id: u64, out: WsOut) {
    if let Err(error) = emit_as(&event_context(scope), id, out) {
        loader_throw(scope, &error);
    }
}

pub(super) fn op_ws_send(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let data = args.get(1).to_rust_string_lossy(scope);
    emit_checked(scope, id, WsOut::Text(data));
}
pub(super) fn op_ws_send_binary(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let data = view_bytes(args.get(1)).unwrap_or_default();
    emit_checked(scope, id, WsOut::Binary(data));
}
pub(super) fn op_ws_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let code = args.get(1).uint32_value(scope).unwrap_or(1000) as u16;
    let reason = args.get(2).to_rust_string_lossy(scope);
    emit_checked(scope, id, WsOut::Close(code, reason));
}

/// `__ws_prepare_worker_handoff(id)`: register the server end of a pair that
/// a Worker returns in a 101. An id of 0 allocates one. Returns the id.
pub(super) fn op_ws_prepare_worker_handoff(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    match prepare_worker_websocket_handoff(&event_context(scope), id) {
        Ok(id) => rv.set(v8::Number::new(scope, id as f64).into()),
        Err(error) => loader_throw(scope, &error),
    }
}

/// The route of a socket that the running code opens or binds: the scope of
/// the running cell event, empty for a Worker, and the facet record when
/// that cell is a Durable Object facet.
///
/// A facet is not a cell. A socket that names the facet's scope as its cell
/// starts an activation of a class that no Worker exports, so the upgrade
/// fails with `RuntimeFailed`. The socket must route, register, and gate
/// through the facet's root instead. Both come from the frame that the host
/// installed when the event started, never from JavaScript.
fn dialing_route(context: &IoContext) -> Result<(String, Option<FacetSocket>), String> {
    let Some(EgressFrame { storage, root, .. }) = current_cell_event(context) else {
        return Ok((String::new(), None));
    };
    let Some(root) = root else {
        return Ok((storage, None));
    };
    let opening = storage::facet_opening(&storage).ok_or(
        "websocket: the Durable Object facet that opened this socket is no longer running",
    )?;
    let facet = FacetSocket {
        root: root.cell,
        stream: root.stream,
        epoch: root.epoch,
        opening,
    };
    Ok((storage, Some(facet)))
}

/// What a dial asks the connector for, apart from the route and the id.
struct Dial {
    url: String,
    protocols: Vec<String>,
    headers: Vec<(String, String)>,
    want_response: bool,
    target: Option<WsTarget>,
    exempt: Option<std::net::SocketAddr>,
}

type DialReply = tokio::sync::oneshot::Receiver<anyhow::Result<OutboundWsOpen>>;

/// Allocate and register a socket that the code running in `context` opens,
/// or binds to a Durable Object's socket, and hand it to the connector.
///
/// Returns the id, and the connector's answer unless no connector runs. In
/// that case nothing stays registered for the id.
fn start_dial(
    context: &IoContext,
    cell: String,
    facet: Option<FacetSocket>,
    dial: Dial,
) -> (u64, Option<DialReply>) {
    let id = ws_allocate(owner_of(context));
    let bound = dial.target.is_some();
    // A Worker socket, and every bound socket: the isolate polls it, so the
    // queue registers here on the JS thread, before the first `__ws_next`.
    let pull = (cell.is_empty() || bound).then(|| {
        let (pull_tx, pull_rx) = ws_pull_channel();
        ws_pull_register(id, pull_rx);
        if cell.is_empty() {
            ws_track_request_socket(context, id);
        }
        pull_tx
    });
    if bound {
        // Registered here, on the JS thread, so a frame sent between this op
        // and the pipe task buffers as a pending frame instead of being
        // dropped for a socket the registry has never heard of. `accept()`
        // opens the socket synchronously, so that window is reachable by an
        // ordinary `send()`.
        //
        // The caller end's frames reach this isolate through its pull
        // queue, so they never route by `cell`. The record still matters: a
        // facet that stops closes its sockets by it, and this end would
        // otherwise keep the other Durable Object's socket open after the
        // facet is gone.
        ws_register_outbound(id, &cell, facet.clone());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let request = match dial.target {
        // `scope` names the target, which keeps its own route.
        Some(target) => OutboundWsReq {
            scope: target.scope.clone(),
            id,
            url: String::new(),
            protocols: Vec::new(),
            pull,
            headers: Vec::new(),
            want_response: false,
            target: Some(target),
            facet: None,
            exempt: None,
            reply: tx,
            release: WsDialGuard::new(id),
        },
        None => OutboundWsReq {
            scope: cell,
            id,
            url: dial.url,
            protocols: dial.protocols,
            pull,
            headers: dial.headers,
            want_response: dial.want_response,
            target: None,
            facet,
            exempt: dial.exempt,
            reply: tx,
            release: WsDialGuard::new(id),
        },
    };
    // A request that is never sent, or never run, drops its guard, which
    // releases everything registered above.
    let sent = outbound_ws_tx().is_some_and(|sender| sender.send(request).is_ok());
    if !sent {
        return (id, None);
    }
    (id, Some(rx))
}

/// `{ id, ready }` for a dial: the id the host chose, and its outcome.
fn dialed<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    id: u64,
    ready: v8::Local<'s, v8::Value>,
) -> v8::Local<'s, v8::Value> {
    let object = v8::Object::new(scope);
    let id_key = v8::String::new(scope, "id").unwrap();
    let id_value = v8::Number::new(scope, id as f64);
    // Own data properties, so a setter on `Object.prototype` sees neither.
    object.create_data_property(scope, id_key.into(), id_value.into());
    let ready_key = v8::String::new(scope, "ready").unwrap();
    object.create_data_property(scope, ready_key.into(), ready);
    object.into()
}

fn egress_refusal(scope: &mut v8::PinScope) -> Option<&'static str> {
    match &actor_runtime_state(scope).egress {
        EgressPolicy::Allow => None,
        EgressPolicy::Deny => {
            Some("This worker is not permitted to access the internet via global functions.")
        }
        EgressPolicy::Broker(_) => {
            Some("A globalOutbound Fetcher cannot broker WebSockets in celld.")
        }
    }
}

/// `__ws_upgrade(url, headers, container)`: `fetch(url, { headers: { Upgrade:
/// "websocket" } })`. Returns `{ id, ready }`, where `ready` resolves with a
/// JSON envelope: an upgraded socket, the ordinary response a server sent
/// instead, which the caller returns unchanged, or the egress policy's
/// refusal. `container` is the `[scope, port]` of a container's `getTcpPort()`
/// upgrade, whose address the host lets past the policy.
pub(super) fn op_ws_upgrade(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if let Some(refusal) = egress_refusal(scope) {
        return loader_throw(scope, refusal);
    }
    let context = event_context(scope);
    let (cell, facet) = match dialing_route(&context) {
        Ok(route) => route,
        Err(error) => return loader_throw(scope, &error),
    };
    let url = args.get(0).to_rust_string_lossy(scope);
    // The subprotocol list is read back out of these headers, so a silent
    // default opened the socket with no headers and no subprotocol at all.
    let headers: Vec<(String, String)> =
        match serde_json::from_str(&args.get(1).to_rust_string_lossy(scope)) {
            Ok(headers) => headers,
            Err(error) => {
                return loader_throw(
                    scope,
                    &format!("websocket: the upgrade headers are not a name/value list: {error}"),
                )
            }
        };
    let protocols: Vec<String> = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-protocol"))
        .map(|(_, value)| value.split(',').map(|p| p.trim().to_string()).collect())
        .unwrap_or_default();
    let exempt = match super::container::port_address_arg(scope, args.get(2)) {
        Ok(exempt) => exempt,
        Err(error) => return loader_throw(scope, &error),
    };
    let (id, rx) = start_dial(
        &context,
        cell,
        facet,
        Dial {
            url,
            protocols,
            headers,
            want_response: true,
            target: None,
            exempt,
        },
    );
    let async_id = asyncrt::enqueue(async move {
        let Some(rx) = rx else {
            return Err("no outbound WebSocket channel".into());
        };
        let open = match rx.await {
            Ok(Ok(open)) => open,
            Ok(Err(error)) => {
                return match error.downcast_ref::<crate::public_egress::Refused>() {
                    Some(refused) => {
                        Ok(serde_json::json!({ "refused": refused.to_string() }).to_string())
                    }
                    None => Err(format!("WebSocket upgrade failed: {error}")),
                }
            }
            Err(error) => return Err(format!("WebSocket connector dropped: {error}")),
        };
        Ok(match open.declined {
            Some(declined) => serde_json::json!({
                "upgraded": false,
                "status": declined.status,
                "headers": declined.headers,
                "body": declined.body,
            })
            .to_string(),
            None => serde_json::json!({
                "upgraded": true,
                "protocol": open.protocol.unwrap_or_default(),
            })
            .to_string(),
        })
    });
    let ready = promise_for(scope, async_id);
    let result = dialed(scope, id, ready);
    rv.set(result);
}

/// The input queue that `__ws_next` on `id` reads, for its owner. `Ok(None)`
/// for an id that names no open socket.
fn next_queue(owner: &WsOwner, id: u64) -> Result<Option<WsPullQueue>, String> {
    if !may_use(owner, id)? {
        return Ok(None);
    }
    Ok(ws_pull().lock().unwrap().get(&id).cloned())
}

/// Await the next inbound event on an isolate-polled socket. Resolves with a
/// tagged buffer; a closed queue resolves as a 1006 close so the JS pump always
/// terminates rather than hanging on a dropped sender.
pub(super) fn op_ws_next(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let queue = match next_queue(&owner_of(&event_context(scope)), id) {
        Ok(queue) => queue,
        Err(error) => return loader_throw(scope, &error),
    };
    let async_id = asyncrt::enqueue_io_context(async move {
        let Some(queue) = queue else {
            return Ok(WsPull::Close(1006, "socket is not registered".into(), false).encode());
        };
        let mut queue = queue.lock().await;
        Ok(queue
            .recv()
            .await
            .unwrap_or_else(|| WsPull::Close(1006, String::new(), false))
            .encode())
    });
    rv.set(promise_for(scope, async_id));
}

/// `__ws_connect(url, protocols)`: `new WebSocket(url, protocols)`. Returns
/// `{ id, ready }`, where `ready` resolves with a JSON envelope: the chosen
/// subprotocol, or the egress policy's refusal, which the caller reports as a
/// `TypeError`.
pub(super) fn op_ws_connect(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if let Some(refusal) = egress_refusal(scope) {
        return loader_throw(scope, refusal);
    }
    let context = event_context(scope);
    let (cell, facet) = match dialing_route(&context) {
        Ok(route) => route,
        Err(error) => return loader_throw(scope, &error),
    };
    let url = args.get(0).to_rust_string_lossy(scope);
    let protocols: Vec<String> =
        match serde_json::from_str(&args.get(1).to_rust_string_lossy(scope)) {
            Ok(protocols) => protocols,
            Err(error) => {
                return loader_throw(
                    scope,
                    &format!("websocket: the subprotocol list is not a JSON array: {error}"),
                )
            }
        };
    // No cell means a Worker socket: the isolate polls it, and it is tracked
    // against the running request.
    let (id, rx) = start_dial(
        &context,
        cell,
        facet,
        Dial {
            url,
            protocols,
            headers: Vec::new(),
            want_response: false,
            target: None,
            exempt: None,
        },
    );
    let async_id = asyncrt::enqueue(async move {
        let Some(rx) = rx else {
            return Err("no outbound WebSocket channel".into());
        };
        match rx.await {
            Ok(Ok(open)) => Ok(
                serde_json::json!({ "protocol": open.protocol.unwrap_or_default() }).to_string(),
            ),
            Ok(Err(error)) => match error.downcast_ref::<crate::public_egress::Refused>() {
                Some(refused) => {
                    Ok(serde_json::json!({ "refused": refused.to_string() }).to_string())
                }
                None => Err(format!("WebSocket connection failed: {error}")),
            },
            Err(error) => Err(format!("WebSocket connector dropped: {error}")),
        }
    });
    let ready = promise_for(scope, async_id);
    let result = dialed(scope, id, ready);
    rv.set(result);
}

/// `__ws_bind_target(target)`: join this isolate's client socket to a
/// Durable Object socket that a subrequest already upgraded. Returns the id
/// of the client socket. The cell end lives in another isolate, so the host
/// carries each direction: it is the same route an external client takes,
/// with a pull queue in place of a TCP connection.
///
/// Called from `accept()`, never from the upgrade itself. A Worker that
/// passes the response straight back out never accepts the socket, and the
/// host binds that 101 to the real client instead — binding here as well
/// would give one cell socket two readers.
pub(super) fn op_ws_bind_target(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(target) = serde_json::from_str::<WsTarget>(&args.get(0).to_rust_string_lossy(scope))
    else {
        return loader_throw(scope, "WebSocket target is not valid");
    };
    let context = event_context(scope);
    if let Err(error) = admit_target(&context, &target) {
        return loader_throw(scope, &error);
    }
    // The caller's own route, which is empty for a Worker: the socket is
    // accounted against the isolate holding it, exactly as `op_ws_connect`
    // accounts an outbound one.
    let (cell, facet) = match dialing_route(&context) {
        Ok(route) => route,
        Err(error) => return loader_throw(scope, &error),
    };
    let (id, rx) = start_dial(
        &context,
        cell,
        facet,
        Dial {
            url: String::new(),
            protocols: Vec::new(),
            headers: Vec::new(),
            want_response: false,
            target: Some(target),
            exempt: None,
        },
    );
    // Nothing observes the outcome: the socket is already open, so there is
    // no handshake for JS to await. The task keeps the reply receiver alive
    // until the connector answers. A bind failure drops the pull sender, so
    // `op_ws_next` reports the caller socket as abnormally closed.
    asyncrt::enqueue(async move {
        let Some(rx) = rx else {
            return Err::<String, String>("no outbound WebSocket channel".into());
        };
        match rx.await {
            Ok(Ok(_)) => Ok(String::new()),
            Ok(Err(error)) => Err(format!("WebSocket bind failed: {error}")),
            Err(error) => Err(format!("WebSocket connector dropped: {error}")),
        }
    });
    rv.set(v8::Number::new(scope, id as f64).into());
}

/// Accept socket `id` (0 allocates one) as a hibernatable socket of `cell`,
/// the running Durable Object. Returns its id.
fn accept_hibernatable(cell: &str, id: u64, tags: Vec<String>) -> Result<u64, String> {
    let id = claim(&WsOwner::Cell(cell.to_string()), id)?;
    let replaced_regular_scope = {
        let registry = ws_registry();
        let mut registry = registry.lock().unwrap();
        let sockets = &mut registry.metadata;
        let replaced_regular_scope = sockets
            .get(&id)
            .filter(|meta| !meta.hibernatable)
            .map(|meta| meta.scope.clone());
        sockets
            .entry(id)
            .and_modify(|meta| {
                meta.scope = cell.to_string();
                meta.hibernatable = true;
                meta.tags = tags.clone();
            })
            .or_insert(WsMeta {
                scope: cell.to_string(),
                hibernatable: true,
                tags,
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet: None,
            });
        replaced_regular_scope
    };
    if let Some(scope) = replaced_regular_scope {
        decrement_regular_ws(&scope);
    }
    tracing::info!(ws_id = id, scope = %cell, "accepted hibernatable WebSocket");
    Ok(id)
}

/// `__ws_accept(id, tags)`: `ctx.acceptWebSocket(ws, tags)`. Returns the id.
pub(super) fn op_ws_accept(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let cell = match running_cell(&event_context(scope)) {
        Ok(cell) => cell,
        Err(error) => return throw_type_error(scope, &error),
    };
    // Tags are how `state.getWebSockets(tag)` finds this socket again after a
    // hibernation, so a silent default accepted the socket untagged and the
    // Worker could not address it by tag; only a bare `getWebSockets()` still
    // returned it.
    let tags: Vec<String> = match serde_json::from_str(&args.get(1).to_rust_string_lossy(scope)) {
        Ok(tags) => tags,
        Err(error) => {
            return loader_throw(
                scope,
                &format!("websocket: the tag list is not a JSON array: {error}"),
            )
        }
    };
    match accept_hibernatable(&cell, id, tags) {
        Ok(id) => rv.set(v8::Number::new(scope, id as f64).into()),
        Err(error) => loader_throw(scope, &error),
    }
}

/// Register socket `id` (0 allocates one) as a regular socket of `cell`, the
/// running Durable Object, which returns it in a 101. Returns its id.
fn accept_regular(cell: &str, id: u64) -> Result<u64, String> {
    let id = claim(&WsOwner::Cell(cell.to_string()), id)?;
    let inserted = {
        let registry = ws_registry();
        let mut registry = registry.lock().unwrap();
        let sockets = &mut registry.metadata;
        if let std::collections::hash_map::Entry::Vacant(entry) = sockets.entry(id) {
            entry.insert(WsMeta {
                scope: cell.to_string(),
                hibernatable: false,
                tags: Vec::new(),
                attachment: None,
                pending: Vec::new(),
                auto_response_at: None,
                facet: None,
            });
            true
        } else {
            false
        }
    };
    if inserted {
        increment_regular_ws(cell);
    }
    tracing::info!(ws_id = id, scope = %cell, "accepted regular WebSocket");
    Ok(id)
}

/// `__ws_accept_regular(id)`. Returns the id.
pub(super) fn op_ws_accept_regular(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let cell = match running_cell(&event_context(scope)) {
        Ok(cell) => cell,
        Err(error) => return throw_type_error(scope, &error),
    };
    match accept_regular(&cell, id) {
        Ok(id) => rv.set(v8::Number::new(scope, id as f64).into()),
        Err(error) => loader_throw(scope, &error),
    }
}

/// The hibernatable sockets of `cell`, as JSON rows.
fn list_hibernatable(cell: &str, tag: Option<&str>) -> String {
    let rows = ws_registry()
        .lock()
        .unwrap()
        .metadata
        .iter()
        .filter(|(_, meta)| {
            meta.hibernatable
                && meta.scope == cell
                && tag.is_none_or(|tag| meta.tags.iter().any(|held| held == tag))
        })
        .map(|(id, meta)| {
            serde_json::json!({
                "id": id,
                "tags": meta.tags,
                "attachment": meta.attachment,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&rows).unwrap()
}

/// `__ws_list(tag)`: `ctx.getWebSockets(tag)` for the running Durable Object.
pub(super) fn op_ws_list(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let cell = match running_cell(&event_context(scope)) {
        Ok(cell) => cell,
        Err(error) => return throw_type_error(scope, &error),
    };
    let tag = args.get(0);
    let tag = if tag.is_undefined() || tag.is_null() {
        None
    } else {
        Some(tag.to_rust_string_lossy(scope))
    };
    let json = list_hibernatable(&cell, tag.as_deref());
    rv.set(v8::String::new(scope, &json).unwrap().into());
}

/// Store the serialized attachment of socket `id` for its owner.
fn set_attachment(owner: &WsOwner, id: u64, attachment: Vec<u8>) -> Result<(), String> {
    if !may_use(owner, id)? {
        return Ok(());
    }
    if let Some(meta) = ws_registry().lock().unwrap().metadata.get_mut(&id) {
        meta.attachment = Some(attachment);
    }
    Ok(())
}

pub(super) fn op_ws_attachment_set(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    let Some(attachment) = view_bytes(args.get(1)) else {
        return throw_type_error(scope, "__ws_attachment_set expects bytes");
    };
    let owner = owner_of(&event_context(scope));
    if let Err(error) = set_attachment(&owner, id, attachment.to_vec()) {
        loader_throw(scope, &error);
    }
}

/// `__ws_auto_response_set(request, response)` for the running Durable
/// Object. A null request removes its pair.
pub(super) fn op_ws_auto_response_set(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let cell = match running_cell(&event_context(scope)) {
        Ok(cell) => cell,
        Err(error) => return throw_type_error(scope, &error),
    };
    let request = args.get(0);
    if request.is_null() || request.is_undefined() {
        ws_auto_responses().lock().unwrap().remove(&cell);
        return;
    }
    let request = request.to_rust_string_lossy(scope);
    let response = args.get(1).to_rust_string_lossy(scope);
    ws_auto_responses()
        .lock()
        .unwrap()
        .insert(cell, (request, response));
}

/// `__ws_auto_response_get()` for the running Durable Object.
pub(super) fn op_ws_auto_response_get(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let cell = match running_cell(&event_context(scope)) {
        Ok(cell) => cell,
        Err(error) => return throw_type_error(scope, &error),
    };
    let pair = ws_auto_responses().lock().unwrap().get(&cell).cloned();
    let json = match pair {
        Some((request, response)) => serde_json::to_string(&[request, response]).unwrap(),
        None => "null".to_string(),
    };
    rv.set(v8::String::new(scope, &json).unwrap().into());
}

/// When the shell last auto-responded on socket `id`, for its owner. Another
/// owner's socket reads as never answered, as in workerd, where the
/// timestamp belongs to the running object's hibernation manager.
fn auto_response_ts(owner: &WsOwner, id: u64) -> Option<f64> {
    if ws_access(id, owner) != WsAccess::Owned {
        return None;
    }
    ws_registry()
        .lock()
        .unwrap()
        .metadata
        .get(&id)
        .and_then(|meta| meta.auto_response_at)
}

pub(super) fn op_ws_auto_response_ts(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = id_arg(scope, &args, 0);
    match auto_response_ts(&owner_of(&event_context(scope)), id) {
        Some(ms) => rv.set(v8::Number::new(scope, ms).into()),
        None => rv.set(v8::null(scope).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws_registry::tests::{released, worker_socket};

    /// Install the shared test domain, whose services every test must use.
    fn services_ready() {
        let _ = crate::asyncrt::test_host_runtime();
    }

    /// A socket parked for `context`'s request and adopted by it, as
    /// `__hostResponseSocket` leaves one: returns its token and caller id.
    fn adopted_by(context: &IoContext, socket: WorkerWebSocket) -> (WorkerHandoffToken, u64) {
        let token = park_worker_handoff(socket, context.handoff_issuer(1)).unwrap();
        let caller =
            adopt_worker_handoff(&token, context.handoff_request, owner_of(context)).unwrap();
        context.worker_handoffs.lock().unwrap().push(token.clone());
        (token, caller)
    }

    #[test]
    fn a_retiring_caller_releases_the_socket_it_adopted() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            let context = IoContext::new();
            let (token, _) = adopted_by(&context, socket);

            context.close_sockets();

            assert!(take_worker_handoff(&token, context.handoff_request).is_err());
            assert!(context.worker_handoffs.lock().unwrap().is_empty());
            // The server end hears that the request ended, as a request's own
            // sockets do when it retires, and the host holds nothing more.
            assert_eq!(
                queue.next_close().await,
                Some((1001, "request ended".into()))
            );
            assert!(released(&queue).await);
        });
    }

    #[test]
    fn another_request_can_neither_adopt_nor_take_the_socket() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            let caller = IoContext::new();
            let other = IoContext::new();
            let token = park_worker_handoff(socket, caller.handoff_issuer(1)).unwrap();
            assert_eq!(
                adopt_worker_handoff(&token, other.handoff_request, owner_of(&other)),
                Err(WorkerHandoffRefusal::OtherRequest)
            );
            adopt_worker_handoff(&token, caller.handoff_request, owner_of(&caller)).unwrap();
            caller.worker_handoffs.lock().unwrap().push(token.clone());
            assert_eq!(
                take_request_worker_handoff(&other, &token).err().as_deref(),
                Some(CROSS_REQUEST_IO)
            );
            // Still the caller's, and still open.
            assert!(queue.registered());
            let (socket, _) = take_request_worker_handoff(&caller, &token).unwrap();
            assert!(caller.worker_handoffs.lock().unwrap().is_empty());
            drop(socket);
        });
    }

    #[test]
    fn an_accept_under_another_id_closes_the_server_end() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            let context = IoContext::new();
            let (token, caller) = adopted_by(&context, socket);
            assert_eq!(
                take_for_accept(&context, &token, caller + 1)
                    .err()
                    .as_deref(),
                Some("WebSocket is not valid")
            );
            assert_eq!(
                queue.next_close().await,
                Some((1011, "WebSocket is not valid".into()))
            );
            assert!(released(&queue).await);
            assert!(context.worker_handoffs.lock().unwrap().is_empty());
        });
    }

    /// A context running an event of the Durable Object `cell`, as
    /// `start_cell_event` leaves one.
    fn cell_context(cell: &str) -> Arc<IoContext> {
        let context = IoContext::new();
        context.egress.lock().unwrap().push(EgressFrame {
            storage: cell.to_string(),
            before: 0,
            root: None,
        });
        context
    }

    /// A registered socket that `owner` owns, with the channel its frames
    /// leave by.
    fn owned_socket(owner: WsOwner) -> (u64, tokio::sync::mpsc::UnboundedReceiver<WsOut>) {
        let id = ws_allocate(owner);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        ws_register(id, tx);
        (id, rx)
    }

    fn cross_request() -> Option<String> {
        Some(CROSS_REQUEST_IO.to_string())
    }

    #[test]
    fn the_running_event_owns_what_it_allocates() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let request = IoContext::new();
        assert_eq!(
            owner_of(&request),
            WsOwner::Request(request.handoff_request)
        );
        assert!(running_cell(&request).is_err());
        let cell = cell_context("cell-a");
        assert_eq!(owner_of(&cell), WsOwner::Cell("cell-a".into()));
        assert_eq!(running_cell(&cell).as_deref(), Ok("cell-a"));
        // Every event of one Durable Object is the same owner.
        assert_eq!(owner_of(&cell_context("cell-a")), owner_of(&cell));
        assert_ne!(owner_of(&IoContext::new()), owner_of(&request));
    }

    #[test]
    fn frames_leave_only_through_the_owners_socket() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let owner = IoContext::new();
            let other = IoContext::new();
            let cell = cell_context("cell-a");
            let (id, mut frames) = owned_socket(owner_of(&owner));
            let frames_to_send: [fn() -> WsOut; 3] = [
                || WsOut::Text("text".into()),
                || WsOut::Binary(vec![1, 2]),
                || WsOut::Close(1000, "done".into()),
            ];
            for out in frames_to_send {
                assert_eq!(emit_as(&other, id, out()).err(), cross_request());
                assert_eq!(emit_as(&cell, id, out()).err(), cross_request());
                emit_as(&owner, id, out()).unwrap();
            }
            assert!(matches!(frames.try_recv(), Ok(WsOut::Text(text)) if text == "text"));
            assert!(matches!(frames.try_recv(), Ok(WsOut::Binary(bytes)) if bytes == [1, 2]));
            assert!(matches!(frames.try_recv(), Ok(WsOut::Close(1000, _))));
            assert!(frames.try_recv().is_err());
            // An id that names no socket drops the frame, as a closed one did.
            ws_unregister(id);
            emit_as(&owner, id, WsOut::Text("late".into())).unwrap();
            emit_as(&other, id, WsOut::Text("late".into())).unwrap();
        });
    }

    #[test]
    fn a_cells_socket_answers_in_its_later_events_only() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let first = cell_context("later-a");
            let (id, mut frames) = owned_socket(owner_of(&first));
            // A later event of the same Durable Object, as a hibernated
            // socket's message wakes one. Sending from a cell event samples
            // its storage, so the check is asked directly.
            assert_eq!(may_use(&owner_of(&cell_context("later-a")), id), Ok(true));
            assert_eq!(
                emit_as(&cell_context("later-b"), id, WsOut::Text("x".into())).err(),
                cross_request()
            );
            assert_eq!(
                emit_as(&IoContext::new(), id, WsOut::Text("x".into())).err(),
                cross_request()
            );
            assert!(frames.try_recv().is_err());
            ws_unregister(id);
        });
    }

    #[test]
    fn next_reads_only_the_owners_queue() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let owner = WsOwner::Cell("cell-a".into());
        let id = ws_allocate(owner.clone());
        let (_sender, queue) = ws_pull_channel();
        ws_pull_register(id, queue);
        assert!(next_queue(&owner, id).unwrap().is_some());
        assert_eq!(
            next_queue(&WsOwner::Cell("cell-b".into()), id).err(),
            cross_request()
        );
        assert_eq!(
            next_queue(&WsOwner::Request(u64::MAX), id).err(),
            cross_request()
        );
        ws_pull_unregister(id);
        // Gone: the pump reads a 1006, as it did.
        assert!(next_queue(&owner, id).unwrap().is_none());
        assert!(next_queue(&WsOwner::Request(u64::MAX), id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn accepting_allocates_for_the_running_cell() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let id = accept_hibernatable("accept-a", 0, vec!["tag".into()]).unwrap();
        assert_eq!(ws_owner(id), Some(WsOwner::Cell("accept-a".into())));
        // Its own cell accepts it again, in any event, and lists it.
        assert_eq!(accept_hibernatable("accept-a", id, Vec::new()), Ok(id));
        assert!(list_hibernatable("accept-a", None).contains(&format!("\"id\":{id}")));
        assert!(!list_hibernatable("accept-b", None).contains(&format!("\"id\":{id}")));
        // Another cell neither accepts it nor registers it as its own.
        assert_eq!(
            accept_hibernatable("accept-b", id, Vec::new()).err(),
            cross_request()
        );
        assert_eq!(accept_regular("accept-b", id).err(), cross_request());
        let regular = accept_regular("accept-a", 0).unwrap();
        assert_eq!(ws_owner(regular), Some(WsOwner::Cell("accept-a".into())));
        assert!(has_regular_websocket("accept-a"));
        assert_eq!(accept_regular("accept-a", regular), Ok(regular));
        assert_eq!(
            accept_hibernatable("accept-b", regular, Vec::new()).err(),
            cross_request()
        );
        // An id that names nothing is not a socket to register.
        let unknown = ws_next_id();
        assert_eq!(
            accept_hibernatable("accept-a", unknown, Vec::new()).err(),
            Some(NOT_VALID.to_string())
        );
        assert_eq!(
            accept_regular("accept-a", unknown).err(),
            Some(NOT_VALID.to_string())
        );
        assert_eq!(ws_owner(unknown), None);
        ws_unregister(id);
        ws_unregister(regular);
        assert_eq!(ws_owner(id), None);
        assert_eq!(ws_owner(regular), None);
        assert!(!has_regular_websocket("accept-a"));
    }

    #[test]
    fn attachments_and_auto_response_times_belong_to_the_cell() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let owner = WsOwner::Cell("cell-a".into());
        let id = accept_hibernatable("cell-a", 0, Vec::new()).unwrap();
        ws_registry()
            .lock()
            .unwrap()
            .metadata
            .get_mut(&id)
            .unwrap()
            .auto_response_at = Some(42.0);
        for stranger in [WsOwner::Cell("cell-b".into()), WsOwner::Request(u64::MAX)] {
            assert_eq!(
                set_attachment(&stranger, id, vec![9]).err(),
                cross_request()
            );
            // Another object reads its own timestamp, as in workerd: none.
            assert_eq!(auto_response_ts(&stranger, id), None);
        }
        let attachment = |id| {
            ws_registry()
                .lock()
                .unwrap()
                .metadata
                .get(&id)
                .and_then(|meta| meta.attachment.clone())
        };
        assert_eq!(attachment(id), None);
        set_attachment(&owner, id, vec![1]).unwrap();
        assert_eq!(attachment(id), Some(vec![1]));
        assert_eq!(auto_response_ts(&owner, id), Some(42.0));
        ws_unregister(id);
        set_attachment(&owner, id, vec![2]).unwrap();
        assert_eq!(auto_response_ts(&owner, id), None);
    }

    #[test]
    fn a_returned_pair_belongs_to_the_request_that_prepared_it() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let owner = IoContext::new();
            let other = IoContext::new();
            let id = prepare_worker_websocket_handoff(&owner, 0).unwrap();
            assert_eq!(ws_owner(id), Some(owner_of(&owner)));
            assert_eq!(*owner.sockets.lock().unwrap(), [id]);
            assert_eq!(
                prepare_worker_websocket_handoff(&other, id).err(),
                cross_request()
            );
            assert_eq!(
                transfer_worker_websocket_handoff(&other, id).err(),
                cross_request()
            );
            assert_eq!(
                transfer_worker_websocket_handoff(&cell_context("cell-a"), id).err(),
                cross_request()
            );
            // Still the owner's, and still prepared.
            let socket = transfer_worker_websocket_handoff(&owner, id)
                .unwrap()
                .expect("prepared");
            assert!(owner.sockets.lock().unwrap().is_empty());
            assert!(transfer_worker_websocket_handoff(&owner, id)
                .unwrap()
                .is_none());
            // The response's socket releases every registration, the owner
            // with them.
            drop(socket);
            assert_eq!(ws_owner(id), None);
            assert!(transfer_worker_websocket_handoff(&other, id)
                .unwrap()
                .is_none());
        });
    }

    #[test]
    fn only_the_adopting_request_binds_its_end() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let (socket, queue) = worker_socket();
            let context = IoContext::new();
            let (token, caller) = adopted_by(&context, socket);
            assert_eq!(ws_owner(caller), Some(owner_of(&context)));
            for stranger in [IoContext::new(), cell_context("cell-a")] {
                assert_eq!(
                    take_for_bind(&stranger, &token, caller).err(),
                    cross_request()
                );
            }
            // Refused before anything moved: the socket waits for its owner.
            assert!(queue.registered());
            let target = take_for_bind(&context, &token, caller).unwrap();
            assert_eq!(target.id(), queue.0);
            assert_eq!(ws_owner(caller), Some(owner_of(&context)));
            drop(target);
            ws_unregister(caller);
            assert_eq!(ws_owner(caller), None);
        });
    }

    #[test]
    fn a_caller_end_that_is_never_bound_leaves_no_owner() {
        crate::asyncrt::test_host_runtime().block_on(async {
            // Released when its request retires.
            let (socket, _queue) = worker_socket();
            let context = IoContext::new();
            let (_, caller) = adopted_by(&context, socket);
            context.close_sockets();
            assert_eq!(ws_owner(caller), None);
            // Returned in the request's response.
            let (socket, _queue) = worker_socket();
            let context = IoContext::new();
            let (token, caller) = adopted_by(&context, socket);
            let socket = take_response_worker_handoff(&context, &token).unwrap();
            assert_eq!(ws_owner(caller), None);
            drop(socket);
            // Refused by an `accept()` under another id.
            let (socket, _queue) = worker_socket();
            let context = IoContext::new();
            let (token, caller) = adopted_by(&context, socket);
            assert!(take_for_accept(&context, &token, caller + 1).is_err());
            assert_eq!(ws_owner(caller), None);
        });
    }

    #[test]
    fn the_owner_goes_with_the_last_registration() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let id = ws_allocate(WsOwner::Request(u64::MAX));
        ws_register_outbound(id, "", None);
        let (_sender, queue) = ws_pull_channel();
        ws_pull_register(id, queue);
        // The request still reads the close waiting in the queue.
        ws_unregister(id);
        assert_eq!(ws_owner(id), Some(WsOwner::Request(u64::MAX)));
        ws_pull_unregister(id);
        assert_eq!(ws_owner(id), None);

        // The other order.
        let id = ws_allocate(WsOwner::Request(u64::MAX));
        ws_register_outbound(id, "", None);
        let (_sender, queue) = ws_pull_channel();
        ws_pull_register(id, queue);
        ws_pull_unregister(id);
        assert_eq!(ws_owner(id), Some(WsOwner::Request(u64::MAX)));
        ws_unregister(id);
        assert_eq!(ws_owner(id), None);
    }

    #[test]
    fn a_dial_that_never_reaches_the_connector_leaves_nothing() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        // Unit tests run no connector.
        for (context, target) in [
            (IoContext::new(), None),
            (cell_context("cell-a"), None),
            (
                IoContext::new(),
                Some(WsTarget {
                    id: 1,
                    scope: "cell-b".into(),
                    tunnel: None,
                }),
            ),
        ] {
            let cell = running_cell(&context).unwrap_or_default();
            let (id, reply) = start_dial(
                &context,
                cell,
                None,
                Dial {
                    url: "ws://127.0.0.1:9/".into(),
                    protocols: Vec::new(),
                    headers: Vec::new(),
                    want_response: false,
                    target,
                    exempt: None,
                },
            );
            assert!(reply.is_none());
            assert_eq!(ws_owner(id), None);
            assert!(!ws_pull().lock().unwrap().contains_key(&id));
            assert!(!ws_registry().lock().unwrap().metadata.contains_key(&id));
        }
    }

    #[test]
    fn a_failed_dial_releases_what_its_op_registered() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let id = ws_allocate(WsOwner::Request(u64::MAX));
        let (_sender, queue) = ws_pull_channel();
        ws_pull_register(id, queue);
        drop(WsDialGuard::new(id));
        assert_eq!(ws_owner(id), None);
        assert!(!ws_pull().lock().unwrap().contains_key(&id));

        // A request that reached the connector's channel but that no task
        // ran releases the socket as it drops.
        let id = ws_allocate(WsOwner::Cell("dial-a".into()));
        let (reply, _answer) = tokio::sync::oneshot::channel();
        let request = OutboundWsReq {
            scope: "dial-a".into(),
            id,
            url: "ws://127.0.0.1:9/".into(),
            protocols: Vec::new(),
            pull: None,
            headers: Vec::new(),
            want_response: false,
            target: None,
            facet: None,
            exempt: None,
            reply,
            release: WsDialGuard::new(id),
        };
        let (connector, queued) = tokio::sync::mpsc::unbounded_channel();
        connector.send(request).ok().unwrap();
        assert!(ws_owner(id).is_some());
        drop(queued);
        assert_eq!(ws_owner(id), None);

        // A dial that registered keeps its socket.
        let id = ws_allocate(WsOwner::Cell("cell-a".into()));
        WsDialGuard::new(id).disarm();
        assert_eq!(ws_owner(id), Some(WsOwner::Cell("cell-a".into())));
        ws_unregister(id);
        assert_eq!(ws_owner(id), None);
    }

    fn target(id: u64, scope: &str) -> WsTarget {
        WsTarget {
            id,
            scope: scope.to_string(),
            tunnel: None,
        }
    }

    #[test]
    fn a_target_is_admitted_once_under_its_grant() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let caller = IoContext::new();
            let other = IoContext::new();
            let socket = accept_regular("grant-a", 0).unwrap();
            let granted = target(socket, "grant-a");
            ws_grant(&granted, owner_of(&caller), &WsCallerRetired::default()).unwrap();
            // Another request that copied the name, and another object, are
            // refused, and the grant stays for its holder.
            assert_eq!(admit_target(&other, &granted).err(), cross_request());
            assert_eq!(
                admit_target(&cell_context("grant-b"), &granted).err(),
                cross_request()
            );
            // The holder cannot widen the name.
            let mut tunneled = granted.clone();
            tunneled.tunnel = Some(7);
            assert!(admit_target(&caller, &tunneled).is_err());
            assert!(admit_target(&caller, &target(socket, "grant-b")).is_err());
            admit_target(&caller, &granted).unwrap();
            // Consumed: one accept, or one response.
            assert!(admit_target(&caller, &granted).is_err());
            ws_unregister(socket);
        });
    }

    #[test]
    fn an_object_returns_its_own_socket_without_a_grant() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let socket = accept_hibernatable("own-a", 0, Vec::new()).unwrap();
        let own = cell_context("own-a");
        admit_target(&own, &target(socket, "own-a")).unwrap();
        // Still its own, so again.
        admit_target(&own, &target(socket, "own-a")).unwrap();
        // Not under another scope, through a tunnel, or by another object.
        assert!(admit_target(&own, &target(socket, "own-b")).is_err());
        let mut tunneled = target(socket, "own-a");
        tunneled.tunnel = Some(1);
        assert!(admit_target(&own, &tunneled).is_err());
        assert_eq!(
            admit_target(&cell_context("own-b"), &target(socket, "own-a")).err(),
            cross_request()
        );
        assert_eq!(
            admit_target(&IoContext::new(), &target(socket, "own-a")).err(),
            cross_request()
        );
        // A name that matches nothing.
        assert_eq!(
            admit_target(&own, &target(ws_next_id(), "own-a")).err(),
            Some(NOT_VALID.to_string())
        );
        ws_unregister(socket);
    }

    #[test]
    fn grants_go_with_their_holder_or_their_target() {
        crate::asyncrt::test_host_runtime().block_on(async {
            // The holder's request retires.
            let caller = IoContext::new();
            let owner = owner_of(&caller);
            let socket = accept_regular("release-a", 0).unwrap();
            ws_grant(
                &target(socket, "release-a"),
                owner.clone(),
                &WsCallerRetired::default(),
            )
            .unwrap();
            // A target on another node, which no local unregister reaches.
            let mut remote = target(socket, "release-a");
            remote.tunnel = Some(3);
            ws_grant(&remote, owner.clone(), &WsCallerRetired::default()).unwrap();
            assert_eq!(ws_grants_held(&owner), 2);
            caller.close_sockets();
            assert_eq!(ws_grants_held(&owner), 0);

            // The holder object stops.
            let holder = WsOwner::Cell("release-holder".into());
            ws_grant(
                &target(socket, "release-a"),
                holder.clone(),
                &WsCallerRetired::default(),
            )
            .unwrap();
            ws_close_facet("release-holder", "stopped");
            assert_eq!(ws_grants_held(&holder), 0);

            // The target goes; a remote one with the same id stays.
            let request = WsOwner::Request(u64::MAX - 1);
            ws_grant(
                &target(socket, "release-a"),
                request.clone(),
                &WsCallerRetired::default(),
            )
            .unwrap();
            ws_grant(&remote, request.clone(), &WsCallerRetired::default()).unwrap();
            ws_unregister(socket);
            assert_eq!(ws_grants_held(&request), 1);
            ws_release_grants(&request);
            assert_eq!(ws_grants_held(&request), 0);
        });
    }

    /// Call `op` through V8 with string arguments, as a script that bypassed
    /// the harness would. Answers what it returned, or the message it threw.
    fn call_op(
        scope: &mut v8::PinScope,
        op: impl v8::MapFnTo<v8::FunctionCallback>,
        args: &[&str],
    ) -> Result<String, String> {
        let tc = std::pin::pin!(v8::TryCatch::new(scope));
        let tc = &mut tc.init();
        let function = v8::Function::new(tc, op).unwrap();
        let args: Vec<v8::Local<v8::Value>> = args
            .iter()
            .map(|arg| v8::String::new(tc, arg).unwrap().into())
            .collect();
        let recv = v8::undefined(tc).into();
        match function.call(tc, recv, &args) {
            Some(value) => Ok(value.to_rust_string_lossy(tc)),
            None => Err(tc
                .exception()
                .map(|error| error.to_rust_string_lossy(tc))
                .unwrap_or_default()),
        }
    }

    /// `read_response` on a reader that names `target`, as a harness that
    /// let a forged target through would.
    fn read_forged(scope: &mut v8::PinScope, target: &str) -> Result<HttpResponse, String> {
        let source = format!(
            "__celld.__readResponse = () => ({{ status: 101, bodyBytes: new Uint8Array(), \
             bodyStreamId: 0, headersJson: \"[]\", wsTargetJson: {target:?}, \
             workerSocketId: 0 }});"
        );
        run_internal_snippet(scope, &source).expect("the reader is replaced");
        let ret = v8::undefined(scope).into();
        read_response(scope, ret).map_err(|error| error.to_string())
    }

    #[test]
    fn the_host_refuses_a_target_that_bypassed_the_harness() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        Engine::init();
        // On a thread started after V8, as `runtime::init_v8` requires.
        std::thread::spawn(|| {
            let config = Arc::new(WorkerConfig::new(WorkerConfigOptions {
                src: "export default { fetch() { return new Response(); } };\n".into(),
                script_name: "admit".into(),
                do_classes: Vec::new(),
                bindings: Vec::new(),
                r2_bindings: Vec::new(),
                d1_bindings: Vec::new(),
                kv_bindings: Vec::new(),
                queue_bindings: Vec::new(),
                queue_consumers: Vec::new(),
                workflow_bindings: Vec::new(),
                vars: Vec::new(),
                node: String::new(),
                modules: Vec::new(),
                compat: Compat::default(),
            }));
            let mut worker = Worker::load_config(config).unwrap();
            // Granting starts the sweep, which needs the host runtime.
            let _runtime = crate::asyncrt::test_host_runtime().enter();
            let request = IoContext::new();
            let _current = CurrentGuard::enter(request.clone());
            // Another object's socket, which this request was never handed.
            let socket = accept_hibernatable("admit-a", 0, Vec::new()).unwrap();
            let stolen = format!(r#"{{"id":{socket},"scope":"admit-a"}}"#);
            let unknown = format!(r#"{{"id":{},"scope":"admit-a"}}"#, ws_next_id());
            worker.with_scope_for_test(|scope| {
                for target in [&stolen, &unknown] {
                    let refused = call_op(scope, op_ws_bind_target, &[target]).unwrap_err();
                    assert!(
                        refused.contains(CROSS_REQUEST_IO) || refused.contains(NOT_VALID),
                        "{refused}"
                    );
                    let refused = read_forged(scope, target).err().unwrap();
                    assert!(
                        refused.contains(CROSS_REQUEST_IO) || refused.contains(NOT_VALID),
                        "{refused}"
                    );
                }
                assert!(call_op(scope, op_ws_bind_target, &[&stolen])
                    .unwrap_err()
                    .contains(CROSS_REQUEST_IO));
                // The same target under a grant to this request: admitted, and
                // the grant is consumed by that one use.
                let granted: WsTarget = serde_json::from_str(&stolen).unwrap();
                ws_grant(&granted, owner_of(&request), &WsCallerRetired::default()).unwrap();
                let response = read_forged(scope, &stolen).unwrap();
                assert!(matches!(
                    response.websocket,
                    Some(HttpResponseWebSocket::Cell(ref target)) if *target == granted
                ));
                assert!(read_forged(scope, &stolen).is_err());
                ws_grant(&granted, owner_of(&request), &WsCallerRetired::default()).unwrap();
                let id: u64 = call_op(scope, op_ws_bind_target, &[&stolen])
                    .unwrap()
                    .parse()
                    .unwrap();
                assert_ne!(id, socket);
                assert!(call_op(scope, op_ws_bind_target, &[&stolen]).is_err());
            });
            ws_unregister(socket);
        })
        .join()
        .unwrap();
    }

    #[test]
    fn a_retired_caller_is_granted_nothing() {
        // Before any registry access: the shared domain replaces the
        // fallback services, and an id from one would name another\'s socket.
        services_ready();
        let caller = IoContext::new();
        let owner = owner_of(&caller);
        let socket = accept_regular("late-a", 0).unwrap();
        caller.close_sockets();
        // The response arrives after the caller retired.
        ws_grant(&target(socket, "late-a"), owner.clone(), &caller.ws_retired).unwrap();
        assert_eq!(ws_grants_held(&owner), 0);
        ws_unregister(socket);
    }

    #[test]
    fn an_owner_holds_at_most_its_limit_of_grants() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let owner = WsOwner::Request(u64::MAX - 2);
            let retired = WsCallerRetired::default();
            for id in 0..WS_GRANTS_PER_OWNER as u64 {
                ws_grant(&target(u64::MAX - id, "cap-a"), owner.clone(), &retired).unwrap();
            }
            assert!(ws_grant(&target(1, "cap-a"), owner.clone(), &retired).is_err());
            ws_release_grants(&owner);
            assert_eq!(ws_grants_held(&owner), 0);
        });
    }
}
