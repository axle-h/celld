// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! WebSockets on the ingress: accepting them, proxying them to the owner,
//! and the tasks that pump each one.
//!
//! A socket outlives the request that opened it, so each becomes its own
//! task. Three shapes exist — a local socket to a cell on this node, a
//! socket proxied to the owning peer, and a socket the worker opened
//! outbound — and they differ only in what sits on the far end.
use super::*;

/// Where the events of one socket go.
///
/// Resolved once, when the socket's task starts, and passed to every event of
/// the socket. The core's cancel path closes a socket and unregisters it
/// before the socket task dispatches the close, so a route read again at
/// that point would find no facet record and name the facet's scope as a
/// cell. Routing a request to that scope starts an activation for a cell
/// that no Worker exports.
#[derive(Clone)]
enum SocketRoute {
    /// A socket that a cell accepted.
    Cell(String),
    /// A socket that a Durable Object facet accepted. Routing, activity, and
    /// the output gate belong to the root cell. Only the handler runs in
    /// the facet.
    Facet {
        scope: String,
        facet: celld::js::FacetSocket,
    },
}

impl SocketRoute {
    /// Read the route of `target` while it is still registered.
    fn of(target: &celld::js::WsTarget) -> Self {
        match celld::js::ws_facet(target.id) {
            Some(facet) => Self::Facet {
                scope: target.scope.clone(),
                facet,
            },
            None => Self::Cell(target.scope.clone()),
        }
    }

    /// The scope that accepted the socket: the cell, or the facet.
    fn scope(&self) -> &str {
        match self {
            Self::Cell(cell) => cell,
            Self::Facet { scope, .. } => scope,
        }
    }

    /// The cell that owns the socket.
    fn cell(&self) -> &str {
        match self {
            Self::Cell(cell) => cell,
            Self::Facet { facet, .. } => &facet.root,
        }
    }
}

async fn dispatch_ws_message(
    app: &AppHandle,
    socket: &SocketRoute,
    ws_id: u64,
    data: celld::js::WsIn,
) -> anyhow::Result<()> {
    let scope = socket.scope();
    // The auto-response short circuit: a matched text frame is answered here
    // in the shell and never becomes a `webSocketMessage`. No routing, no
    // activity, no wake — a hibernated cell stays hibernated, which is the
    // feature.
    if let celld::js::WsIn::Text(text) = &data {
        if let Some(response) = celld::js::ws_auto_response(scope, ws_id, text) {
            celld::js::ws_emit_batch(vec![(ws_id, celld::js::WsOut::Text(response))]);
            // workerd writes the reply before it reads on, so a peer that
            // does not read stops being read too. A Pong needs no wait: the
            // reader writes it itself before it reads on.
            celld::js::ws_await_backlog(ws_id).await;
            return Ok(());
        }
    }
    let Routed { request, route } = app
        .websocket_request(socket.cell().to_string(), ws_id)
        .await
        .map_err(|error| anyhow::anyhow!("route WebSocket {scope}: {error:?}"))?;
    anyhow::ensure!(route == Route::Local, "WebSocket owner moved off node");
    // The handler's output must reach the gate even when the caller stops
    // waiting. A socket task stops reading, and drops this future, once its own
    // socket closes, but the handler it started runs on regardless. A dropped
    // reply loses a captured batch that already reserved places on other
    // sockets, and a lost batch must close those sockets with 1011 because the
    // gate never answered for it. A task, which a dropped handle only
    // detaches, therefore owns everything from the handoff on. Routing stays
    // above it: a message the cell never received has no output to lose.
    let app = app.clone();
    let scope = scope.to_string();
    let socket = socket.clone();
    let (started, receive) = tokio::sync::oneshot::channel();
    let delivery = celld::asyncrt::spawn(async move {
        deliver_ws_message(&app, &socket, request, ws_id, data, started).await
    });
    // The reader waits only until the first turn. Keep observing completion:
    // ignoring the detached task would hide failures and leave a broken
    // connection open. The delivery still owns its activity and output gate
    // handoff even if this socket closes while the handler is suspended.
    celld::asyncrt::spawn(async move {
        let failure = match delivery.await {
            Ok(Ok(())) => return,
            Ok(Err(error)) => format!("{error:#}"),
            Err(panic) => format!("WebSocket message delivery panicked: {panic}"),
        };
        tracing::warn!(scope, ws_id, %failure, "WebSocket message delivery failed");
        celld::js::ws_close(ws_id, 1011, "WebSocket message delivery failed");
    })
    .detach();
    receive.await.context("WebSocket message did not start")
}

/// Run `webSocketMessage` and hand its output to the cell's barrier queue.
async fn deliver_ws_message(
    app: &AppHandle,
    socket: &SocketRoute,
    request: u64,
    ws_id: u64,
    data: celld::js::WsIn,
    started: tokio::sync::oneshot::Sender<()>,
) -> anyhow::Result<()> {
    let scope = socket.cell();
    let activity = app.activity(request, scope.to_string());
    let runtime = app.runtime.as_ref().context("no cell runtime")?;
    let dispatched = match socket {
        SocketRoute::Cell(cell) => runtime.ws_message(cell.clone(), ws_id, data, started).await,
        SocketRoute::Facet { scope, facet } => {
            runtime
                .facet_ws_message(scope.clone(), facet, ws_id, data, started)
                .await
        }
    };
    let dispatch = match dispatched {
        Ok(dispatch) => dispatch,
        // A handler that failed after it committed opens the barrier a
        // successful writer's batch opens, with no frames behind it: the
        // commit is as unproven either way, and a read-only batch or response
        // that followed would otherwise trail nothing and reveal it (#715).
        // The frames it captured before it failed are dropped, as before.
        //
        // A facet's failed handler opens no barrier. Its position counts in
        // the facet's stream, which the root cell's gate would read as its
        // own, and the facet's next output proves that whole stream anyway.
        Err(error) => {
            let position = match socket {
                SocketRoute::Cell(_) => celld::js::failed_write_position(&error),
                SocketRoute::Facet { .. } => None,
            };
            if let Some(position) = position {
                // The barrier is registered before the activity guard
                // drops: the core reads the still-pinned request when it
                // opens the barrier, and a guard dropped first would let
                // the cell be released under an unregistered write.
                if let Err(stopped) = app
                    .ws_output(request, scope.to_string(), Vec::new(), Some(position), None)
                    .await
                {
                    tracing::warn!(scope, position, %stopped, "no barrier for a failed webSocketMessage handler's write");
                }
            }
            drop(activity);
            return Err(error);
        }
    };
    // A read-only frame can reveal another event's unproven write, so all
    // captured frames pass through the cell's barrier queue before emission.
    if !dispatch.frames.is_empty() || dispatch.write_position.is_some() {
        if let Err(stopped) = app
            .ws_output(
                request,
                scope.to_string(),
                dispatch.frames,
                dispatch.write_position,
                dispatch.observed_position,
            )
            .await
        {
            tracing::warn!(scope, %stopped, "no barrier for a webSocketMessage handler's output");
        }
    }
    drop(activity);
    Ok(())
}

async fn dispatch_ws_closed(
    app: &AppHandle,
    socket: &SocketRoute,
    ws_id: u64,
    code: u16,
    reason: String,
    was_clean: bool,
) -> anyhow::Result<()> {
    let scope = socket.scope();
    let Routed { request, route } = app
        .websocket_request(socket.cell().to_string(), ws_id)
        .await
        .map_err(|error| anyhow::anyhow!("route WebSocket close {scope}: {error:?}"))?;
    anyhow::ensure!(route == Route::Local, "WebSocket owner moved off node");
    let _activity = app.activity(request, socket.cell().to_string());
    let runtime = app.runtime.as_ref().context("no cell runtime")?;
    match socket {
        SocketRoute::Cell(cell) => {
            let answer = runtime
                .ws_closed(cell.clone(), ws_id, code, reason, was_clean)
                .await;
            gate_lifecycle_write(app, request, cell, &answer).await;
            answer.map(|_| ())
        }
        // No lifecycle barrier, for the reason a failed facet message opens
        // none.
        SocketRoute::Facet { scope, facet } => {
            runtime
                .facet_ws_closed(scope.clone(), facet, ws_id, code, reason, was_clean)
                .await
        }
    }
}

/// Open the barrier a lifecycle handler's write needs.
///
/// `webSocketOpen` and `webSocketClose` answer nothing a client sees, so a
/// write they made opens a barrier with no frames behind it, whether the
/// handler returned or failed after it committed. A read-only batch or
/// response that follows then trails that barrier instead of revealing the
/// write while a crash can still lose it (#715).
async fn gate_lifecycle_write(
    app: &AppHandle,
    request: u64,
    scope: &str,
    answer: &anyhow::Result<Option<u64>>,
) {
    let position = match answer {
        Ok(position) => *position,
        Err(error) => celld::js::failed_write_position(error),
    };
    if let Some(position) = position {
        tracing::debug!(
            scope,
            position,
            failed = answer.is_err(),
            "gate lifecycle write"
        );
        if let Err(stopped) = app
            .ws_output(request, scope.to_string(), Vec::new(), Some(position), None)
            .await
        {
            tracing::warn!(scope, position, %stopped, "no barrier for a lifecycle handler's write");
        }
    }
}

async fn finish_websocket(
    app: &AppHandle,
    target: &celld::js::WsTarget,
    code: u16,
    reason: String,
    was_clean: bool,
) {
    let socket = SocketRoute::of(target);
    let _ = dispatch_ws_closed(app, &socket, target.id, code, reason, was_clean).await;
    app.websocket_closed(socket.cell().to_string(), target.id);
    celld::js::ws_unregister(target.id);
}

/// Release a WebSocket that the Worker accepted but that celld will not upgrade.
///
/// `accept()` registers the socket and charges it to the scope's regular-socket
/// count before the Worker's response reaches this code, and `WsTarget` is plain
/// data: dropping it releases nothing. A rejection that only returns an error
/// status therefore leaks the registration and the count for the life of the
/// process, and the Worker never sees a close. A remote target is registered on
/// the owner node instead, so the entry node has nothing to release — the same
/// split that the upgrade-failure path makes. 1006 is the code for a connection
/// that closed without a close frame, which is exactly what happened.
pub(super) async fn reject_accepted_websocket(
    app: &AppHandle,
    target: &celld::js::WsTarget,
    reason: &str,
) {
    if target.tunnel.is_none() {
        finish_websocket(app, target, 1006, reason.to_string(), false).await;
    }
}

/// Answer a Worker response on a connection that did not upgrade.
///
/// A response with a socket reaches a client only through `handle_websocket`
/// or a tunneled upgrade, so every other response path answers through this
/// function. workerd checks each response against the request it answers and
/// throws a `TypeError`, which an HTTP client receives as a 500. The object
/// that answers a Durable Object call applies the same check in
/// `dispatch_local_fetch` and `dispatch_forwarded_fetch`. This check therefore
/// covers the top-level Worker's own response, and a path such as `/do/` that
/// cannot upgrade at all.
pub(super) async fn reply_without_upgrade(
    app: &AppHandle,
    mut worker_response: HttpResponse,
    preserve_representation_length: bool,
) -> HttpReply {
    let Some(websocket) = worker_response.websocket.take() else {
        return runtime_response(worker_response, preserve_representation_length);
    };
    refuse_websocket_without_upgrade(app, websocket).await
}

/// Release a socket on a path that cannot upgrade, and answer with a 500.
///
/// Dropping a Worker socket or a tunnel claim releases it, and a local cell
/// socket needs the explicit close. workerd's 500 has an empty body; celld
/// names the `TypeError` in the body, as it does for any other Worker failure.
pub(super) async fn refuse_websocket_without_upgrade(
    app: &AppHandle,
    websocket: HttpResponseWebSocket,
) -> HttpReply {
    let error = format!("TypeError: {WEBSOCKET_WITHOUT_UPGRADE}");
    if let Ok(PendingWebSocket::Cell(target)) = PendingWebSocket::new(websocket) {
        reject_accepted_websocket(app, &target, &error).await;
    }
    response(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Worker failed: {error}"),
    )
}

/// One accepted WebSocket response after it returns from JavaScript.
///
/// Keep the response shape in one value through every validation and executor
/// exit. A tunneled response attaches its parked connection lifetime here,
/// so dropping an unfinished response cannot leave host state behind.
enum PendingWebSocket {
    Worker(celld::js::websocket::WorkerWebSocket),
    Cell(celld::js::WsTarget),
    Tunnel {
        target: celld::js::WsTarget,
        upgrade: super::peer_tunnel::TunnelUpgradeClaim,
    },
}

impl PendingWebSocket {
    fn new(websocket: HttpResponseWebSocket) -> anyhow::Result<Self> {
        Ok(match websocket {
            HttpResponseWebSocket::Worker(worker) => Self::Worker(worker),
            HttpResponseWebSocket::Cell(target) => match target.tunnel {
                Some(parked) => Self::Tunnel {
                    target,
                    upgrade: super::peer_tunnel::claim_upgrade(parked)?,
                },
                None => Self::Cell(target),
            },
        })
    }

    fn target(&self) -> Option<&celld::js::WsTarget> {
        match self {
            Self::Worker(_) => None,
            Self::Cell(target) => Some(target),
            Self::Tunnel { target, .. } => Some(target),
        }
    }
}

enum OutboundWebSocketSink {
    /// A socket that a Durable Object dialed. A facet's socket routes,
    /// registers, and gates through the facet's root, as an accepted facet
    /// socket does.
    Cell {
        app: Box<AppHandle>,
        socket: SocketRoute,
    },
    Isolate(celld::js::WsPullSender),
}

impl OutboundWebSocketSink {
    async fn open(&self, websocket: u64, protocol: String) -> anyhow::Result<()> {
        match self {
            Self::Cell { app, socket } => {
                let cell = socket.cell();
                let Routed { request, route } = app
                    .request(cell.to_string())
                    .await
                    .map_err(|error| anyhow::anyhow!("route outbound WebSocket: {error:?}"))?;
                anyhow::ensure!(
                    route == Route::Local,
                    "outbound WebSocket cell moved off node"
                );
                let _activity = app.activity(request, cell.to_string());
                app.websocket_opened(cell.to_string(), websocket, WebSocketKind::Outbound)
                    .await?;
                let runtime = app.runtime.as_ref().context("no cell runtime")?;
                let answer = match socket {
                    SocketRoute::Cell(cell) => {
                        let answer = runtime.ws_open(cell.clone(), websocket, protocol).await;
                        gate_lifecycle_write(app, request, cell, &answer).await;
                        answer.map(|_| ())
                    }
                    // No lifecycle barrier, for the reason a failed facet
                    // message opens none.
                    SocketRoute::Facet { scope, facet } => {
                        runtime
                            .facet_ws_open(scope.clone(), facet, websocket, protocol)
                            .await
                    }
                };
                if answer.is_err() {
                    app.websocket_closed(cell.to_string(), websocket);
                }
                answer
            }
            Self::Isolate(tx) => tx
                .send(celld::js::WsPull::Open(protocol))
                .await
                .map_err(|_| anyhow::anyhow!("isolate stopped reading WebSocket")),
        }
    }

    async fn message(&self, websocket: u64, data: celld::js::WsIn) -> anyhow::Result<()> {
        match self {
            Self::Cell { app, socket } => dispatch_ws_message(app, socket, websocket, data).await,
            Self::Isolate(tx) => tx
                .send(data.into())
                .await
                .map_err(|_| anyhow::anyhow!("isolate stopped reading WebSocket")),
        }
    }

    async fn closed(
        &self,
        websocket: u64,
        code: u16,
        reason: String,
        was_clean: bool,
    ) -> anyhow::Result<()> {
        match self {
            Self::Cell { app, socket } => {
                let result =
                    dispatch_ws_closed(app, socket, websocket, code, reason, was_clean).await;
                app.websocket_closed(socket.cell().to_string(), websocket);
                result
            }
            Self::Isolate(tx) => tx
                .send_close(code, reason, was_clean)
                .map_err(|_| anyhow::anyhow!("isolate stopped reading WebSocket")),
        }
    }

    /// Register the socket before any event of it can be dispatched. A
    /// facet's socket takes its record in the same insertion, so the
    /// registry never holds it under the facet's scope without the route.
    fn register(&self, websocket: u64) {
        if let Self::Cell { socket, .. } = self {
            let facet = match socket {
                SocketRoute::Cell(_) => None,
                SocketRoute::Facet { facet, .. } => Some(facet.clone()),
            };
            celld::js::ws_register_outbound(websocket, socket.scope(), facet);
        }
    }
}

/// Carry frames between a Durable Object's socket and a client end another
/// isolate in this process kept, after a `stub.fetch` upgrade.
///
/// A same-isolate pair links its two ends directly and never involves the
/// host. This pair cannot: the cell end lives in the cell's isolate and the
/// client end in the caller's, and neither can reach the other's heap. So
/// each direction takes the route an external client's frames take —
/// `dispatch_ws_message` into the cell, a pull queue out to the caller —
/// which is also why a hibernatable server end needs nothing special here.
///
/// The task ends when either side closes, and it unregisters both.
async fn local_websocket_pipe(
    app: AppHandle,
    id: u64,
    target: celld::js::WsTarget,
    pull: Option<celld::js::WsPullSender>,
    reply: tokio::sync::oneshot::Sender<anyhow::Result<celld::js::OutboundWsOpen>>,
    release: celld::js::WsDialGuard,
) -> anyhow::Result<()> {
    let Some(pull) = pull else {
        // `release` unregisters the caller's end, which the op registered.
        let _ = reply.send(Err(anyhow::anyhow!(
            "a bound WebSocket target needs an isolate queue"
        )));
        return Ok(());
    };
    // Both registrations flush whatever each end queued before it had
    // anywhere to send: the cell's greeting frame is queued while its own
    // fetch handler still runs, and the caller can send the moment it
    // accepts.
    let socket = SocketRoute::of(&target);
    let (caller_tx, mut from_caller) = celld::js::ws_out_channel();
    let (cell_tx, mut from_cell) = celld::js::ws_out_channel();
    let caller_overflow = from_caller.watch();
    let cell_overflow = from_cell.watch();
    celld::js::ws_register(id, caller_tx);
    celld::js::ws_register(target.id, cell_tx);
    // The pipe's own exit unregisters both ends from here on.
    release.disarm();
    let _ = reply.send(Ok(celld::js::OutboundWsOpen {
        protocol: None,
        declined: None,
    }));
    // Set only by a close the caller sent. A close from the cell needs no
    // entry here: the isolate that sent it has already told the cell's own
    // handler, and telling it again would be a second `webSocketClose`.
    let mut caller_close: Option<(u16, String)> = None;
    let mut cell_closed = false;
    loop {
        celld::asyncrt::select! {
            frame = from_caller.recv() => match frame {
                Some(celld::js::WsOut::Text(text)) => {
                    if let Err(error) = dispatch_ws_message(
                        &app, &socket, target.id, celld::js::WsIn::Text(text),
                    ).await {
                        tracing::warn!(%error, scope = %target.scope, "kept WebSocket message failed");
                        break;
                    }
                }
                Some(celld::js::WsOut::Binary(bytes)) => {
                    if let Err(error) = dispatch_ws_message(
                        &app, &socket, target.id, celld::js::WsIn::Binary(bytes),
                    ).await {
                        tracing::warn!(%error, scope = %target.scope, "kept WebSocket message failed");
                        break;
                    }
                }
                Some(celld::js::WsOut::Close(code, reason)) => {
                    caller_close = Some((code, reason));
                    break;
                }
                // The caller's request retired and took its socket with it.
                None => break,
            },
            frame = from_cell.recv() => match frame {
                Some(celld::js::WsOut::Text(text)) => {
                    if !forward_to_caller(&pull, celld::js::WsPull::Text(text), &cell_overflow).await { break; }
                }
                Some(celld::js::WsOut::Binary(bytes)) => {
                    if !forward_to_caller(&pull, celld::js::WsPull::Binary(bytes), &cell_overflow).await { break; }
                }
                // The overflow's Close, when the cell's channel overflowed,
                // as a TCP peer that does not read would get it.
                Some(celld::js::WsOut::Close(code, reason)) => {
                    let _ = pull.send_close(code, reason, true);
                    cell_closed = true;
                    break;
                }
                None => break,
            },
        }
    }
    if let Some((code, reason)) = caller_close {
        // A caller whose channel overflowed closes abnormally, and the cell
        // gets the overflow's Close, which nothing answers.
        let overflowed = caller_overflow.overflowed();
        if overflowed {
            celld::js::close_overflowed(&pull, &caller_overflow);
        }
        // A dispatch that failed reached no handler that could reply.
        if dispatch_ws_closed(&app, &socket, target.id, code, reason, true)
            .await
            .is_ok()
            && !overflowed
        {
            let hibernatable = celld::js::ws_is_hibernatable(target.id);
            // Bounded and skipped on a draining node, for the reasons
            // `websocket_task` gives.
            let flushed = async {
                if !app.is_draining() {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        celld::js::ws_await_flushes(target.id),
                    )
                    .await;
                }
            };
            carry_cell_reply(
                hibernatable,
                flushed,
                &pull,
                &mut from_cell,
                &mut from_caller,
            )
            .await;
        }
        celld::js::ws_ended_after_peer_close(target.id);
    } else if cell_closed {
        // The cell's socket is CLOSING until the caller's reply, and its
        // close event carries that reply. One whose channel overflowed
        // closes abnormally at once, as does one the caller never answers.
        let (code, reason, was_clean) = if cell_overflow.overflowed() {
            (1006, cell_overflow.reason().to_string(), false)
        } else {
            match await_caller_reply(&mut from_caller, celld::js::WORKER_BRIDGE_CLOSE_TIMEOUT).await
            {
                Some((code, reason)) => (code, reason, true),
                None => (1006, String::new(), false),
            }
        };
        let _ = dispatch_ws_closed(&app, &socket, target.id, code, reason, was_clean).await;
    }
    app.websocket_closed(socket.cell().to_string(), target.id);
    celld::js::ws_unregister(target.id);
    celld::js::ws_unregister(id);
    celld::js::ws_pull_unregister(id);
    Ok(())
}

/// Carry one frame of the cell's to the caller of a `local_websocket_pipe`,
/// once its queue has room. Whether the pipe carries on: a caller that
/// stopped reading ends it, and a cell whose channel overflowed meanwhile
/// goes on to the overflow's Close.
async fn forward_to_caller(
    pull: &celld::js::WsPullSender,
    frame: celld::js::WsPull,
    overflow: &celld::js::WsOutWatch,
) -> bool {
    celld::asyncrt::select_biased! {
        "an overflow ends the wait for room for a frame it discards";
        () = overflow.clone().overflow() => true,
        sent = pull.send(frame) => sent.is_ok(),
    }
}

/// Carry the cell's reply to a Close the caller sent through a
/// `local_websocket_pipe`, as `websocket_task` writes it to a client.
///
/// A hibernatable socket replies only from its `webSocketClose` handler,
/// whose output may still be behind the output gate until `flushed`. An
/// accepted one replied during its close event unless it is half-open, and
/// then the Durable Object may close it later. The wait also ends when the
/// object's socket goes, when the caller stops reading, or when the caller's
/// request ends and takes its socket with it, so neither side pins the
/// other. Without a reply, the caller's queue ends without a Close, which it
/// reports as 1006.
async fn carry_cell_reply(
    hibernatable: bool,
    flushed: impl std::future::Future<Output = ()>,
    pull: &celld::js::WsPullSender,
    from_cell: &mut celld::js::WsOutReceiver,
    from_caller: &mut celld::js::WsOutReceiver,
) {
    // Whether the pipe carries on after `frame`.
    let forward = |frame| async move {
        match frame {
            celld::js::WsOut::Text(text) => pull.send(celld::js::WsPull::Text(text)).await.is_ok(),
            celld::js::WsOut::Binary(bytes) => {
                pull.send(celld::js::WsPull::Binary(bytes)).await.is_ok()
            }
            celld::js::WsOut::Close(code, reason) => {
                let _ = pull.send_close(code, reason, true);
                false
            }
        }
    };
    if hibernatable {
        flushed.await;
        while let Some(frame) = from_cell.try_recv() {
            if !forward(frame).await {
                return;
            }
        }
        return;
    }
    loop {
        celld::asyncrt::select! {
            frame = from_cell.recv() => match frame {
                Some(frame) => if !forward(frame).await { return },
                None => return,
            },
            // The caller has sent its Close, so nothing it sends now is a
            // frame to carry; its channel ending means its request ended.
            frame = from_caller.recv() => if frame.is_none() { return },
            () = pull.drained() => return,
        }
    }
}

/// Wait up to `timeout` for the caller's reply to a Close the cell sent
/// first through a `local_websocket_pipe`, which the cell's close event then
/// reports. `None` when the caller never answers, or its request ends first.
async fn await_caller_reply(
    from_caller: &mut celld::js::WsOutReceiver,
    timeout: std::time::Duration,
) -> Option<(u16, String)> {
    tokio::time::timeout(timeout, async {
        while let Some(frame) = from_caller.recv().await {
            if let celld::js::WsOut::Close(code, reason) = frame {
                return Some((code, reason));
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

pub(crate) async fn outbound_websocket_task(
    app: AppHandle,
    request: celld::js::OutboundWsReq,
) -> anyhow::Result<()> {
    use hyper::header::{HeaderMap, HeaderName, HeaderValue, SEC_WEBSOCKET_PROTOCOL};

    let celld::js::OutboundWsReq {
        scope,
        id,
        url,
        protocols,
        pull,
        headers,
        want_response,
        target,
        facet,
        exempt,
        reply,
        release,
    } = request;
    if let Some(target) = target {
        return local_websocket_pipe(app, id, target, pull, reply, release).await;
    }
    let sink = match pull {
        Some(pull) => OutboundWebSocketSink::Isolate(pull),
        None => OutboundWebSocketSink::Cell {
            app: Box::new(app),
            socket: match facet {
                Some(facet) => SocketRoute::Facet { scope, facet },
                None => SocketRoute::Cell(scope),
            },
        },
    };
    let mut handshake = HeaderMap::new();
    for (name, value) in &headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "upgrade"
                | "connection"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-protocol"
                | "host"
        ) {
            continue;
        }
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) else {
            continue;
        };
        handshake.insert(name, value);
    }
    if !protocols.is_empty() {
        handshake.insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(&protocols.join(", "))
                .context("invalid WebSocket subprotocol")?,
        );
    }
    let timeout = std::time::Duration::from_secs(10);
    let connected = tokio::time::timeout(
        timeout,
        celld::ws_client::connect(&url, handshake, celld::ws_client::Dial::Worker { exempt }),
    )
    .await;
    let connection = match connected {
        Ok(Ok(connection)) => connection,
        Ok(Err(celld::ws_client::Error::Declined(declined))) if want_response => {
            let declined = celld::js::DeclinedUpgrade {
                status: declined.status.as_u16(),
                headers: declined
                    .headers
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.as_str().to_string(),
                            value.to_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect(),
                body: declined.body,
            };
            let _ = reply.send(Ok(celld::js::OutboundWsOpen {
                protocol: None,
                declined: Some(declined),
            }));
            return Ok(());
        }
        // The op reports a refusal as the egress policy's TypeError, so it
        // keeps its type.
        Ok(Err(celld::ws_client::Error::Refused(refused))) => {
            let _ = reply.send(Err(anyhow::Error::new(refused)));
            return Ok(());
        }
        Ok(Err(error)) => {
            let _ = reply.send(Err(anyhow::anyhow!("{error}")));
            return Ok(());
        }
        Err(_) => {
            let _ = reply.send(Err(anyhow::anyhow!(
                "outbound WebSocket handshake timed out after {}ms",
                timeout.as_millis()
            )));
            return Ok(());
        }
    };
    let mut socket = connection.socket;
    // The Worker's socket answers the peer's Close, as an accepted one does.
    socket.set_auto_close(false);
    let protocol = connection
        .headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if protocol
        .as_ref()
        .is_some_and(|selected| !protocols.iter().any(|offered| offered == selected))
    {
        let _ = reply.send(Err(anyhow::anyhow!(
            "server selected an unrequested WebSocket subprotocol"
        )));
        return Ok(());
    }

    let (outbound, mut outputs) = celld::js::ws_out_channel();
    sink.register(id);
    celld::js::ws_register(id, outbound);
    // Every return before this point released what the op registered.
    release.disarm();
    if let Err(error) = sink
        .open(id, protocol.as_deref().unwrap_or_default().to_string())
        .await
    {
        celld::js::ws_unregister(id);
        let _ = reply.send(Err(error));
        return Ok(());
    }
    if reply
        .send(Ok(celld::js::OutboundWsOpen {
            protocol,
            declined: None,
        }))
        .is_err()
    {
        let _ = sink
            .closed(id, 1006, "opening event was cancelled".into(), false)
            .await;
        celld::js::ws_unregister(id);
        return Ok(());
    }

    // Ping is answered by the reader's auto-pong, as the previous client
    // library also did unprompted. A Close is the Worker's to answer.
    let Pumped {
        close,
        writer,
        reader,
    } = {
        let sink = &sink;
        pump_socket(socket, &mut outputs, move |data| sink.message(id, data)).await
    };
    if reader.is_some() {
        celld::js::ws_peer_closed(id);
    }
    let delivered = sink
        .closed(id, close.state.0, close.state.1, close.state.2)
        .await;
    // A Close the Worker never received leaves nobody to reply.
    if let (Some(reader), Ok(())) = (reader, delivered) {
        write_until_close(&writer, &mut outputs, reader).await;
    }
    if close.initiator == CloseInitiator::Peer {
        celld::js::ws_ended_after_peer_close(id);
    }
    celld::js::ws_unregister(id);
    Ok(())
}

/// A close frame the peer sent is a clean close, as workerd reports it, even
/// when its payload is malformed and the code becomes a protocol error; only
/// a transport end without a frame (1006) is unclean.
fn websocket_close_details(payload: &[u8]) -> (u16, String) {
    match payload {
        [] => (1005, String::new()),
        [_] => (1002, String::new()),
        [first, second, reason @ ..] => {
            let Ok(reason) = std::str::from_utf8(reason) else {
                return (1007, String::new());
            };
            let code = u16::from_be_bytes([*first, *second]);
            if !celld_logic::schedule::websocket_close_code_is_allowed(code) {
                return (1002, String::new());
            }
            (code, reason.to_string())
        }
    }
}

/// The write half of a cell socket, shared by the reader and the writer.
///
/// The reader needs it because auto-pong and auto-close hand their reply back to
/// the caller once a socket is split. The writer needs it for the cell's own
/// frames, and the close path needs it after both directions stop.
type SocketWriter<S> =
    std::sync::Arc<tokio::sync::Mutex<fastwebsockets::WebSocketWrite<tokio::io::WriteHalf<S>>>>;

/// The read half of a cell socket, which the pump hands back after the peer's
/// Close so the transport is still watched while the reply is pending.
type SocketReader<S> = fastwebsockets::FragmentCollectorRead<tokio::io::ReadHalf<S>>;

/// Close details: the code, the reason, and whether the close was clean.
type CloseState = (u16, String, bool);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloseInitiator {
    Peer,
    Application,
    Transport,
}

#[derive(Debug, Eq, PartialEq)]
struct PumpClose {
    state: CloseState,
    initiator: CloseInitiator,
}

async fn write_ws_out<S>(ws: &SocketWriter<S>, out: celld::js::WsOut) -> bool
where
    S: tokio::io::AsyncWrite + Unpin,
{
    use fastwebsockets::Frame;
    let keep_open = matches!(out, celld::js::WsOut::Text(_) | celld::js::WsOut::Binary(_));
    let frame = match out {
        celld::js::WsOut::Text(text) => Frame::text(text.into_bytes().into()),
        celld::js::WsOut::Binary(data) => Frame::binary(data.into()),
        // 1005 names a Close without a status, which cannot carry a reason:
        // the automatic reply to such a Close is empty, as kj writes it.
        celld::js::WsOut::Close(1005, _) => Frame::close_raw(Vec::new().into()),
        celld::js::WsOut::Close(code, reason) => Frame::close(code, reason.as_bytes()),
    };
    ws.lock().await.write_frame(frame).await.is_ok() && keep_open
}

/// How a write of one of the application's frames ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Written {
    /// The frame was a message, and the socket is still open.
    Open,
    /// The frame was a Close, or the write failed.
    Ended,
    /// The socket's queue overflowed, or its owner let go of it, and the
    /// write did not finish within [`WS_OUT_ABANDON_GRACE`]. It was abandoned
    /// partway, so nothing may be written on the connection any more.
    Abandoned,
}

/// How long a write still under way may take once the socket's queue has
/// overflowed or its owner has let go of it, before the connection is
/// dropped. A peer that does not read gets nothing more.
const WS_OUT_ABANDON_GRACE: std::time::Duration = std::time::Duration::from_secs(1);

/// [`write_ws_out`], holding the frame's charge until the write finishes, so
/// a write that never does stays counted against the socket's bound and its
/// isolate's budget while the owner lives. It is abandoned when the
/// socket's queue overflows, or when its owner lets go of it, and it is
/// still under way [`WS_OUT_ABANDON_GRACE`] later: the peer is not reading,
/// and nothing would otherwise end the task, its connection or the memory.
/// While the owner lives there is no other bound, as in workerd: the budget
/// bounds what such writes hold.
async fn write_bounded<S>(
    ws: &SocketWriter<S>,
    (out, held): (celld::js::WsOut, celld::js::WsOutHeld),
    watch: &celld::js::WsOutWatch,
) -> Written
where
    S: tokio::io::AsyncWrite + Unpin,
{
    let given_up = async {
        celld::asyncrt::select! {
            () = watch.clone().overflow() => {}
            () = watch.clone().closed() => {}
        }
        tokio::time::sleep(WS_OUT_ABANDON_GRACE).await;
    };
    let written = celld::asyncrt::select_biased! {
        "a write that finishes as the grace ends is not abandoned";
        open = write_ws_out(ws, out) => if open { Written::Open } else { Written::Ended },
        () = given_up => Written::Abandoned,
    };
    drop(held);
    written
}

/// Write what the application sends after its peer's Close, until its own
/// Close or until nothing can send on the socket any more.
///
/// A socket whose peer closed first replies with a Close of its own: at once
/// when the Worker's socket replies automatically
/// (`web_socket_auto_reply_to_close`), or when the Worker calls `close()` on
/// a half-open one. Frames it sends before then still go out, as workerd
/// sends them. When the socket's owner goes away without a Close, the
/// connection ends without one and the peer sees 1006.
///
/// The transport is read meanwhile, so the wait lives as long as the
/// connection and never past it:
/// - A peer that disconnects ends the wait after [`REPLY_AFTER_PEER_LEFT`]
///   at most.
/// - A peer that only shuts down its side of the connection (FIN) may still
///   read, so the wait goes on, as workerd's does: workerd reads nothing
///   after the Close. A peer that closed its socket outright sent a FIN as
///   well, so each [`HALF_OPEN_PROBE_INTERVAL`] a Ping goes out. The
///   connection of a peer that has gone answers it with a reset, the next
///   Ping fails, and the wait ends.
async fn write_until_close<S>(
    writer: &SocketWriter<S>,
    outputs: &mut celld::js::WsOutReceiver,
    mut reader: SocketReader<S>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let overflow = outputs.watch();
    let write = async {
        while let Some(output) = outputs.recv_held().await {
            if write_bounded(writer, output, &overflow).await != Written::Open {
                return;
            }
        }
    };
    let mut write = std::pin::pin!(write);
    let transport = until_transport_ends(&mut reader, writer);
    let shut_down = celld::asyncrt::select! {
        () = &mut write => return,
        shut_down = transport => shut_down,
    };
    if shut_down {
        loop {
            celld::asyncrt::select! {
                () = &mut write => return,
                () = tokio::time::sleep(HALF_OPEN_PROBE_INTERVAL) => {
                    // A write under way holds the writer, and is a probe
                    // itself: a reset fails it. Waiting for the lock here
                    // would stop polling that write, which would then never
                    // let go.
                    let Ok(mut held) = writer.try_lock() else {
                        continue;
                    };
                    let ping = fastwebsockets::Frame::new(
                        true,
                        fastwebsockets::OpCode::Ping,
                        None,
                        fastwebsockets::Payload::Owned(Vec::new()),
                    );
                    // Not cancelled while the owner lives, since a partial
                    // frame would break the stream: the application's writes
                    // wait for it, and a reset fails it. A peer with a zero
                    // window holds it, so it gives up as an application
                    // write does once the owner lets go, and the connection
                    // goes with it.
                    let given_up = async {
                        overflow.clone().closed().await;
                        tokio::time::sleep(WS_OUT_ABANDON_GRACE).await;
                    };
                    let pinged = celld::asyncrt::select_biased! {
                        "a Ping that finishes as the grace ends is not abandoned";
                        pinged = held.write_frame(ping) => pinged.is_ok(),
                        () = given_up => false,
                    };
                    if !pinged {
                        return;
                    }
                }
            }
        }
    }
    // The peer's side ended. A reply already on its way still goes out, as
    // workerd writes it to a peer that only shut down its side, and does not
    // land on a socket that is gone; a peer that went away fails the write
    // at once. Nothing waits longer than that for a peer that has left.
    let _ = tokio::time::timeout(REPLY_AFTER_PEER_LEFT, write).await;
}

/// How long a socket whose peer's connection failed still takes a reply
/// that is already on its way.
const REPLY_AFTER_PEER_LEFT: std::time::Duration = std::time::Duration::from_secs(1);

/// How often a socket waiting for its application's reply checks, with a
/// Ping, that a peer that shut down its side of the connection is still
/// there. A peer that left is noticed within two intervals.
const HALF_OPEN_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Read a socket whose peer already sent its Close until the connection
/// ends. A frame after the Close breaks the protocol and is ignored; a Ping
/// is still answered. True when the peer shut down its side of the
/// connection (an end of stream), false when the connection failed.
async fn until_transport_ends<S>(reader: &mut SocketReader<S>, writer: &SocketWriter<S>) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use fastwebsockets::{Frame as WsFrame, Payload, WebSocketError};
    let mut obligated = |frame: WsFrame<'_>| {
        let reply = WsFrame::new(
            frame.fin,
            frame.opcode,
            None,
            Payload::Owned(frame.payload.to_vec()),
        );
        async move { writer.lock().await.write_frame(reply).await }
    };
    loop {
        match reader.read_frame(&mut obligated).await {
            Ok(_) => {}
            Err(WebSocketError::UnexpectedEOF) => return true,
            Err(_) => return false,
        }
    }
}

/// Carry frames between a socket and the cell behind it until one side stops.
///
/// The read is never cancelled. `fastwebsockets::read_frame` consumes header
/// bytes from its buffer and then awaits for the payload, holding what it parsed
/// in local variables, so dropping that future keeps the buffer advanced and
/// loses the header. The next read then treats a payload byte as a frame header
/// and the stream never realigns. Earlier versions of both callers read the
/// socket in the same select as the cell's outbound queue, which drops the losing
/// future on every iteration. Cancelling a read mid-payload fails against that
/// shape.
///
/// One async block therefore owns each direction. The halves are split so that
/// the writer can write while the reader reads, and the writer stops on a signal
/// instead of being dropped, because dropping it can leave a partial frame on
/// the socket.
///
/// The reader answers a Ping with a Pong on the same socket, exactly as the
/// unsplit collector wrote it, until the application's Close has gone out.
/// Every caller turns `auto_close` off: the application answers a Close, not
/// the reader.
///
/// When the application closes first, the socket is CLOSING until the peer
/// replies, as in workerd: the reader goes on, delivering what the peer
/// still sends, and the peer's Close becomes the close state. A peer that
/// disconnects instead ends it with 1006, so the wait lasts no longer than
/// the connection. A socket whose queue overflowed closes abnormally (1006)
/// without waiting: its peer is not reading.
///
/// The returned writer is still live, so the caller can write the close frames
/// that follow, unless the queue overflowed.
#[cfg(all(test, celld_internal_tests))]
async fn pump_cell_socket<S, F, Fut>(
    socket: fastwebsockets::WebSocket<S>,
    outputs: &mut celld::js::WsOutReceiver,
    inbound: F,
) -> (PumpClose, SocketWriter<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: FnMut(celld::js::WsIn) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pumped = pump_socket(socket, outputs, inbound).await;
    (pumped.close, pumped.writer)
}

/// What [`pump_socket`] leaves: how the socket closed, the live writer, and
/// the reader when the peer's Close ended the pump before the application
/// sent its own, so the caller can keep reading the transport while it waits
/// for the application's reply.
struct Pumped<S> {
    close: PumpClose,
    writer: SocketWriter<S>,
    reader: Option<SocketReader<S>>,
}

/// How the writer of [`pump_socket`] stopped, when it was not told to.
enum WriterEnd {
    /// It wrote the application's Close.
    Closed,
    /// It wrote the overflow's Close, or abandoned a write after the overflow.
    Overflowed,
    /// It abandoned a write after the socket's owner let go of it.
    Abandoned,
}

/// The close state of a socket whose queue overflowed, as its application
/// sees it.
fn overflow_close(overflow: &celld::js::WsOutWatch) -> PumpClose {
    PumpClose {
        state: (1006, overflow.reason().to_string(), false),
        initiator: CloseInitiator::Application,
    }
}

/// [`pump_cell_socket`], keeping the reader after the peer's Close.
async fn pump_socket<S, F, Fut>(
    socket: fastwebsockets::WebSocket<S>,
    outputs: &mut celld::js::WsOutReceiver,
    mut inbound: F,
) -> Pumped<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: FnMut(celld::js::WsIn) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    use fastwebsockets::{
        FragmentCollectorRead, Frame as WsFrame, OpCode, Payload, WebSocketError,
    };

    let (reader, writer) = socket.split(tokio::io::split);
    let mut reader: SocketReader<S> = FragmentCollectorRead::new(reader);
    let writer: SocketWriter<S> = std::sync::Arc::new(tokio::sync::Mutex::new(writer));
    let overflow = outputs.watch();

    let mut app_closed = false;
    let mut abandoned = false;
    let mut close = PumpClose {
        state: (1006, String::new(), false),
        initiator: CloseInitiator::Transport,
    };
    let (stop_writer, mut stopped) = tokio::sync::oneshot::channel::<()>();
    {
        let obligated_writer = writer.clone();
        let mut obligated = move |frame: WsFrame<'_>| {
            let writer = obligated_writer.clone();
            // The reply borrows the reader's buffer, and the write outlives the
            // callback, so the payload is copied out. The reader builds a pong
            // unmasked, and `write_frame` masks it if the role needs it,
            // exactly as the unsplit collector did.
            let reply = WsFrame::new(
                frame.fin,
                frame.opcode,
                None,
                Payload::Owned(frame.payload.to_vec()),
            );
            async move {
                match writer.lock().await.write_frame(reply).await {
                    // The application's Close went out, and nothing follows
                    // it: the peer's Ping goes unanswered, as kj leaves it.
                    Err(WebSocketError::ConnectionClosed) => Ok(()),
                    written => written,
                }
            }
        };

        let read = async {
            loop {
                let Ok(frame) = reader.read_frame(&mut obligated).await else {
                    return Some(PumpClose {
                        state: (
                            1006,
                            celld::js::DISCONNECTED_WITHOUT_CLOSE.to_string(),
                            false,
                        ),
                        initiator: CloseInitiator::Transport,
                    });
                };
                let delivered = match frame.opcode {
                    OpCode::Text => {
                        inbound(celld::js::WsIn::Text(
                            String::from_utf8_lossy(&frame.payload).into_owned(),
                        ))
                        .await
                    }
                    OpCode::Binary => {
                        inbound(celld::js::WsIn::Binary(frame.payload.to_vec())).await
                    }
                    OpCode::Close => {
                        let (code, reason) = websocket_close_details(&frame.payload);
                        return Some(PumpClose {
                            state: (code, reason, true),
                            initiator: CloseInitiator::Peer,
                        });
                    }
                    _ => Ok(()),
                };
                if delivered.is_err() {
                    return None;
                }
            }
        };

        // `recv` and the stop signal are both cancel-safe, and the write runs in
        // the branch body, so no write is ever cancelled either, except one
        // that an overflow or the owner's going abandons with the connection.
        let write = async {
            loop {
                celld::asyncrt::select_biased! {
                    "a stop signal that ties an outbound frame prevents one more socket write";
                    _ = &mut stopped => return None,
                    output = outputs.recv_held() => {
                        let output = output?;
                        let closing = matches!(output.0, celld::js::WsOut::Close(..));
                        match write_bounded(&writer, output, &overflow).await {
                            Written::Open => {}
                            Written::Abandoned if overflow.overflowed() => return Some(WriterEnd::Overflowed),
                            Written::Abandoned => return Some(WriterEnd::Abandoned),
                            Written::Ended if overflow.overflowed() => return Some(WriterEnd::Overflowed),
                            Written::Ended if closing => return Some(WriterEnd::Closed),
                            Written::Ended => return None,
                        }
                    }
                }
            }
        };

        let mut read = std::pin::pin!(read);
        let mut write = std::pin::pin!(write);
        celld::asyncrt::select! {
            result = &mut read => {
                if let Some(details) = result { close = details; }
                // Stop the writer between frames rather than dropping it, so a
                // frame it started reaches the socket whole.
                let _ = stop_writer.send(());
                // A write already under way when the stop came finishes, and
                // may be the application's own Close, crossing the peer's.
                let ended = write.await;
                abandoned = matches!(ended, Some(WriterEnd::Abandoned));
                app_closed = ended.is_some();
            }
            result = &mut write => match result {
                // CLOSING until the peer's reply, which the reader goes on to
                // read: its Close is the close state, or the connection's end
                // when that comes first.
                // The wait ends, with 1006, when the socket's owner lets go of
                // it (its request ended, or it was unregistered), or after
                // WORKER_BRIDGE_CLOSE_TIMEOUT, as the bridge waits: a peer
                // that never answers holds neither the connection nor the
                // object's residency for good.
                Some(WriterEnd::Closed) => {
                    app_closed = true;
                    let owner_gone = overflow.clone().closed();
                    let reply = tokio::time::timeout(celld::js::WORKER_BRIDGE_CLOSE_TIMEOUT, async {
                        celld::asyncrt::select! {
                            reply = &mut read => reply,
                            () = owner_gone => None,
                        }
                    })
                    .await;
                    if let Ok(Some(reply)) = reply {
                        close = PumpClose {
                            state: reply.state,
                            initiator: CloseInitiator::Application,
                        };
                    }
                }
                // The read is dropped here. That is safe only because the
                // pump is over and the socket is never read again.
                Some(WriterEnd::Overflowed) => {
                    app_closed = true;
                    close = overflow_close(&overflow);
                }
                // Nobody is left to hear how it closed.
                Some(WriterEnd::Abandoned) => {
                    app_closed = true;
                    abandoned = true;
                }
                None => {}
            },
        }
    }
    // A write abandoned partway left a partial frame: nothing more goes out.
    if overflow.overflowed() || abandoned {
        outputs.finish();
    }
    // Only a read that ended at the peer's Close left the reader between
    // frames; a read the writer's end dropped may have stopped mid-frame. A
    // socket whose application already sent its Close has replied, so it has
    // nothing to wait for.
    let reader = (close.initiator == CloseInitiator::Peer && !app_closed).then_some(reader);
    Pumped {
        close,
        writer,
        reader,
    }
}

/// Carry a client socket into the top-level Worker request that returned it.
///
/// A Durable Object has a stable scope, so its frames can return through a
/// later cell dispatch. A stateless Worker has no such address. Its pending
/// `__ws_next` operation therefore keeps this request and isolate resident,
/// and this task carries each client frame through that operation's queue.
async fn worker_websocket_task<S>(
    worker: celld::js::WorkerWebSocket,
    mut socket: fastwebsockets::WebSocket<S>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket.set_auto_close(false);
    let id = worker.id();
    let inbound = worker.inbound();
    let (outbound, mut outputs) = celld::js::ws_out_channel();
    celld::js::ws_register(id, outbound);
    let Pumped {
        close,
        writer,
        reader,
    } = pump_socket(socket, &mut outputs, move |data| {
        let inbound = inbound.clone();
        async move {
            inbound
                .send(data.into())
                .await
                .map_err(|_| anyhow::anyhow!("Worker stopped reading WebSocket"))
        }
    })
    .await;
    let inbound = worker.inbound();
    let delivered = inbound.send_close(close.state.0, close.state.1, close.state.2);
    // A Close the Worker never received leaves nobody to reply.
    if let (Some(reader), Ok(())) = (reader, delivered) {
        write_until_close(&writer, &mut outputs, reader).await;
    }
    if close.initiator == CloseInitiator::Peer {
        celld::js::ws_ended_after_peer_close(id);
    }
    // The connection and the frames still queued for it go first.
    drop((writer, outputs));
    // The Worker reads its queue by socket id, so dropping `worker` now would
    // lose the frames and the Close still queued for it. Its request reads
    // them while it runs, and one that ended dropped the queue, which ends
    // the wait too; a Worker that stopped reading is not waited for long.
    let _ = tokio::time::timeout(celld::js::WORKER_BRIDGE_CLOSE_TIMEOUT, inbound.drained()).await;
}

pub(super) async fn websocket_task<S>(
    app: AppHandle,
    target: celld::js::WsTarget,
    mut socket: fastwebsockets::WebSocket<S>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket.set_auto_close(false);
    let route = SocketRoute::of(&target);
    let (outbound, mut outputs) = celld::js::ws_out_channel();
    celld::js::ws_register(target.id, outbound);
    let Pumped {
        close,
        writer,
        reader,
    } = {
        let app = &app;
        let route = &route;
        let id = target.id;
        pump_socket(socket, &mut outputs, move |data| {
            dispatch_ws_message(app, route, id, data)
        })
        .await
    };
    let dispatched = dispatch_ws_closed(
        &app,
        &route,
        target.id,
        close.state.0,
        close.state.1.clone(),
        close.state.2,
    )
    .await;
    if let Err(error) = &dispatched {
        tracing::warn!(
            %error,
            scope = %target.scope,
            websocket = target.id,
            "WebSocket close dispatch failed"
        );
    }

    // The close handler chooses the reply. Its output is queued while
    // dispatch_ws_closed drives V8, so flush it before unregistering the
    // socket.
    //
    // Its output can also still be behind the output gate: the handler may
    // read, and what it reads can belong to a write another request has not
    // proved durable yet. The drain below does not block, so a hibernatable
    // socket's Close still in flight would be lost, and its peer would see
    // 1006 instead of the reply the handler chose.
    //
    // Bounded, and skipped outright on a draining node. The drain loop polls
    // the gate calls it already dispatched but never receives a new one: it
    // has no `gate_rx` arm. A ticket taken after the main loop broke is sent
    // to a live but unread channel and parks for good, so waiting on it here
    // would hold the socket task open until the drain hits its deadline. The
    // bound covers the same park reached the other way: `is_draining` is read
    // once, and shutdown can begin between that read and the wait. Giving up
    // costs the reason the handler chose, never a frame the gate has not
    // cleared -- the drain below finds nothing, and a frame released later
    // lands on a socket that is gone.
    if !app.is_draining() {
        let waited = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            celld::js::ws_await_flushes(target.id),
        )
        .await;
        if waited.is_err() {
            tracing::warn!(
                scope = %target.scope,
                websocket = target.id,
                "gave up waiting for the close handler's frames"
            );
        }
    }
    // Ends with a Close written, or with a write that failed.
    let overflow = outputs.watch();
    let mut ended = false;
    while let Some(output) = outputs.try_recv_held() {
        if write_bounded(&writer, output, &overflow).await != Written::Open {
            ended = true;
            break;
        }
    }
    // A hibernatable socket never replies by itself: workerd drops it once
    // `webSocketClose` returns, so a handler that did not close it leaves its
    // peer with 1006. An accepted one replied during the close event unless
    // it is half-open, and then the Durable Object may close it later. A
    // dispatch that failed reached no handler that could reply: the object
    // broke or could not be routed to, and workerd disconnects the sockets of
    // an object that broke, so the peer sees 1006.
    if let Some(reader) = reader {
        if awaits_reply(ended, dispatched.is_ok(), || {
            celld::js::ws_is_hibernatable(target.id)
        }) {
            write_until_close(&writer, &mut outputs, reader).await;
        }
    }
    if close.initiator == CloseInitiator::Peer {
        celld::js::ws_ended_after_peer_close(target.id);
    }
    app.websocket_closed(route.cell().to_string(), target.id);
    celld::js::ws_unregister(target.id);
}

/// Whether a socket whose peer closed first waits for the application's
/// reply after its close event: not when the drain already ended the socket,
/// not when the dispatch failed and so reached no handler, and not for a
/// hibernatable socket, which workerd drops once `webSocketClose` returns.
fn awaits_reply(ended: bool, dispatched: bool, hibernatable: impl FnOnce() -> bool) -> bool {
    !ended && dispatched && !hibernatable()
}

/// Headers that the WebSocket server must compute or remove for a 101.
///
/// `fastwebsockets` creates its response before the Worker runs, so blindly
/// appending the Worker's response afterwards can replace the accept hash or
/// restore framing fields that an upgrade cannot carry. This is the exclusion
/// set in kj's `acceptWebSocket`: it forces the three handshake fields, drops
/// the obsolete or request-only fields, and drops `Sec-WebSocket-Extensions`.
fn forwards_worker_websocket_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "upgrade"
            | "sec-websocket-accept"
            | "keep-alive"
            | "te"
            | "trailer"
            | "content-length"
            | "transfer-encoding"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
    )
}

pub(crate) async fn handle_websocket(mut request: Request<Incoming>, app: AppHandle) -> HttpReply {
    let started = Instant::now();
    let cancellation = celld::runtime::RequestCancellationLifetime::stateless();
    let request_id = cancellation.request_id();
    let (mut upgrade_response, upgrade) = match fastwebsockets::upgrade::upgrade(&mut request) {
        Ok(upgrade) => upgrade,
        Err(error) => return response(StatusCode::BAD_REQUEST, format!("ws upgrade: {error}")),
    };
    let runtime = app.runtime.as_ref().expect("WebSocket runtime checked");
    let body_started = Instant::now();
    let (url, method, body, headers) = match request_payload(
        request,
        app.trust_forwarded_headers,
        app.max_request_body_bytes,
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let body_read_us = body_started.elapsed().as_micros() as u64;
    let worker_started = Instant::now();
    let mut worker_response = match runtime
        .fetch_worker_pool(url, method, body.into(), headers, cancellation)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            emit_websocket_connection_timing(
                runtime,
                request_id,
                started,
                body_read_us,
                worker_started.elapsed().as_micros() as u64,
                WebSocketConnectionOutcome {
                    outcome: "worker_error",
                    route: "",
                    scope: "",
                    status: StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
                },
            );
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Worker failed: {error:#}"),
            );
        }
    };
    let worker_dispatch_us = worker_started.elapsed().as_micros() as u64;
    let websocket = match worker_response.websocket.take() {
        Some(websocket) => match PendingWebSocket::new(websocket) {
            Ok(websocket) => websocket,
            Err(error) => {
                return response(
                    StatusCode::BAD_GATEWAY,
                    format!("tunneled WebSocket upgrade: {error}"),
                );
            }
        },
        None => {
            emit_websocket_connection_timing(
                runtime,
                request_id,
                started,
                body_read_us,
                worker_dispatch_us,
                WebSocketConnectionOutcome {
                    outcome: "rejected",
                    route: "",
                    scope: "",
                    status: worker_response.status,
                },
            );
            return runtime_response(worker_response, false);
        }
    };
    let target = websocket.target();
    if worker_response.status != 101 {
        emit_websocket_connection_timing(
            runtime,
            request_id,
            started,
            body_read_us,
            worker_dispatch_us,
            WebSocketConnectionOutcome {
                outcome: "rejected",
                route: "",
                scope: target.map_or("", |target| target.scope.as_str()),
                status: worker_response.status,
            },
        );
        if let Some(target) = target {
            reject_accepted_websocket(&app, target, "unsupported WebSocket route").await;
        }
        return response(StatusCode::BAD_GATEWAY, "unsupported WebSocket route");
    }
    // Workerd shallow-copies the Worker's complete header list into
    // `acceptWebSocket`, which preserves duplicate application fields such as
    // `Set-Cookie`. Validate the complete batch before changing the response,
    // because returning a partially copied handshake is never useful.
    let mut worker_headers = Vec::new();
    for (name, value) in &worker_response.headers {
        if !forwards_worker_websocket_header(name) {
            continue;
        }
        let parsed = hyper::header::HeaderName::from_bytes(name.as_bytes())
            .ok()
            .zip(hyper::header::HeaderValue::from_str(value).ok());
        let Some(header) = parsed else {
            let reason = format!("invalid WebSocket response header: {name}");
            emit_websocket_connection_timing(
                runtime,
                request_id,
                started,
                body_read_us,
                worker_dispatch_us,
                WebSocketConnectionOutcome {
                    outcome: "rejected",
                    route: "",
                    scope: target.map_or("", |target| target.scope.as_str()),
                    status: StatusCode::BAD_GATEWAY.as_u16(),
                },
            );
            if let Some(target) = target {
                reject_accepted_websocket(&app, target, &reason).await;
            }
            return response(StatusCode::BAD_GATEWAY, "invalid WebSocket response header");
        };
        worker_headers.push(header);
    }
    for (name, value) in worker_headers {
        upgrade_response.headers_mut().append(name, value);
    }
    emit_websocket_connection_timing(
        runtime,
        request_id,
        started,
        body_read_us,
        worker_dispatch_us,
        WebSocketConnectionOutcome {
            outcome: "accepted",
            route: match target {
                Some(target) if target.tunnel.is_some() => "remote",
                Some(_) => "local",
                None => "worker",
            },
            scope: target.map_or("", |target| target.scope.as_str()),
            status: 101,
        },
    );
    let task_app = app.clone();
    let task = Box::pin(run_websocket_upgrade(task_app, upgrade, websocket));
    if app.websockets.send(task).is_err() {
        return response(
            StatusCode::SERVICE_UNAVAILABLE,
            "WebSocket executor stopped",
        );
    }
    upgrade_response.map(|body| body.map_err(|never| match never {}).boxed_unsync())
}

/// Finish the client upgrade through the same owned response value that
/// survives validation. Keeping this work in one future makes a failed client
/// upgrade and a cancelled executor task drop the same owned response.
async fn run_websocket_upgrade(
    task_app: AppHandle,
    upgrade: fastwebsockets::upgrade::UpgradeFut,
    websocket: PendingWebSocket,
) {
    match (upgrade.await, websocket) {
        (Ok(socket), PendingWebSocket::Worker(worker)) => {
            worker_websocket_task(worker, socket).await;
        }
        (Ok(socket), PendingWebSocket::Tunnel { upgrade, .. }) => {
            if let Err(error) = super::peer_tunnel::splice(socket.into_inner(), upgrade).await {
                eprintln!("celld tunneled WebSocket splice ended: {error:#}");
            }
        }
        (Ok(socket), PendingWebSocket::Cell(target)) => {
            websocket_task(task_app, target, socket).await;
        }
        (Err(error), PendingWebSocket::Worker(_)) => {
            eprintln!("celld Worker WebSocket upgrade failed: {error}");
        }
        (Err(error), PendingWebSocket::Cell(target)) => {
            eprintln!("celld WebSocket upgrade failed: {error}");
            finish_websocket(&task_app, &target, 1006, String::new(), false).await;
        }
        (Err(error), PendingWebSocket::Tunnel { .. }) => {
            eprintln!("celld tunneled WebSocket upgrade failed: {error}");
        }
    }
}

#[cfg(all(test, celld_internal_tests))]
pub(super) async fn run_websocket_upgrade_for_test(
    task_app: AppHandle,
    upgrade: fastwebsockets::upgrade::UpgradeFut,
    websocket: HttpResponseWebSocket,
) {
    let websocket = PendingWebSocket::new(websocket).unwrap();
    run_websocket_upgrade(task_app, upgrade, websocket).await;
}

struct WebSocketConnectionOutcome<'a> {
    outcome: &'a str,
    route: &'a str,
    scope: &'a str,
    status: u16,
}

fn emit_websocket_connection_timing(
    runtime: &RuntimeManager,
    request_id: celld::js::RequestId,
    started: Instant,
    body_read_us: u64,
    worker_dispatch_us: u64,
    event_outcome: WebSocketConnectionOutcome<'_>,
) {
    let WebSocketConnectionOutcome {
        outcome,
        route,
        scope,
        status,
    } = event_outcome;
    tracing::debug!(
        target: "timing",
        event = "websocket_connection_timing",
        outcome,
        route,
        scope,
        request_id = %celld::js::request_id_string(request_id),
        node = runtime.node(),
        region = runtime.region(),
        runtime_version = env!("CARGO_PKG_VERSION"),
        status,
        total_us = started.elapsed().as_micros() as u64,
        body_read_us,
        worker_dispatch_us,
        "WebSocket connection resolved"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use celld::js::{WsOut, WsPull};
    use fastwebsockets::{Frame, OpCode, Role, WebSocket};
    use std::time::Duration;

    type Duplex = tokio::io::DuplexStream;

    /// The client end of an in-memory connection, split so that it can still
    /// read after its own Close.
    struct Client {
        read: fastwebsockets::WebSocketRead<tokio::io::ReadHalf<Duplex>>,
        write: fastwebsockets::WebSocketWrite<tokio::io::WriteHalf<Duplex>>,
    }

    impl Client {
        async fn read_frame(&mut self) -> Frame<'static> {
            let frame = self
                .read
                .read_frame(&mut |_| async { Ok::<_, std::io::Error>(()) })
                .await
                .unwrap();
            Frame::new(frame.fin, frame.opcode, None, frame.payload.to_vec().into())
        }
    }

    /// A server socket as the connection tasks hold it, and the client at the
    /// other end of an in-memory connection.
    fn connection() -> (WebSocket<Duplex>, Client) {
        let (server, client) = tokio::io::duplex(4096);
        let mut server = WebSocket::after_handshake(server, Role::Server);
        server.set_auto_close(false);
        let mut client = WebSocket::after_handshake(client, Role::Client);
        client.set_auto_close(false);
        let (read, write) = client.split(tokio::io::split);
        (server, Client { read, write })
    }

    /// Pump `server` until the client's Close, which the client sends first.
    async fn pumped_after_client_close(
        server: WebSocket<Duplex>,
        client: &mut Client,
        outputs: &mut celld::js::WsOutReceiver,
    ) -> Pumped<Duplex> {
        client
            .write
            .write_frame(Frame::close(4000, b"bye"))
            .await
            .unwrap();
        let pumped = pump_socket(server, outputs, |_| async { Ok(()) }).await;
        assert_eq!(pumped.close.initiator, CloseInitiator::Peer);
        assert_eq!(pumped.close.state, (4000, "bye".to_string(), true));
        pumped
    }

    #[tokio::test]
    async fn a_half_open_socket_ends_when_its_peer_disconnects() {
        let (server, mut client) = connection();
        // The application never replies, and its channel stays open.
        let (_application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pumped_after_client_close(server, &mut client, &mut outputs).await;
        drop(client);
        tokio::time::timeout(
            Duration::from_secs(5),
            write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()),
        )
        .await
        .expect("the wait ends with the connection");
    }

    #[tokio::test]
    async fn a_half_open_socket_waits_while_its_peer_stays_connected() {
        let (server, mut client) = connection();
        let (_application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pumped_after_client_close(server, &mut client, &mut outputs).await;
        let waited = tokio::time::timeout(
            Duration::from_millis(200),
            write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()),
        )
        .await;
        assert!(
            waited.is_err(),
            "no wall-clock bound while the peer is there"
        );
    }

    #[tokio::test]
    async fn a_half_open_socket_sends_frames_and_then_its_reply() {
        let (server, mut client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pumped_after_client_close(server, &mut client, &mut outputs).await;
        application.send(WsOut::Text("last".into())).unwrap();
        application
            .send(WsOut::Close(4001, "reply".into()))
            .unwrap();
        write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()).await;
        let text = client.read_frame().await;
        assert_eq!(
            (text.opcode, &text.payload[..]),
            (OpCode::Text, &b"last"[..])
        );
        let close = client.read_frame().await;
        assert_eq!(close.opcode, OpCode::Close);
        assert_eq!(
            websocket_close_details(&close.payload),
            (4001, "reply".into())
        );
    }

    #[tokio::test]
    async fn a_reply_to_a_close_without_a_status_is_empty() {
        let (server, mut client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pumped_after_client_close(server, &mut client, &mut outputs).await;
        application.send(WsOut::Close(1005, String::new())).unwrap();
        write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()).await;
        let close = client.read_frame().await;
        assert_eq!(close.opcode, OpCode::Close);
        assert!(close.payload.is_empty());
    }

    #[tokio::test]
    async fn closes_that_cross_leave_nothing_to_wait_for() {
        let (server, mut client) = connection();
        // The application's Close is queued as the peer's arrives.
        let (application, mut outputs) = celld::js::ws_out_channel();
        application.send(WsOut::Close(4009, "mine".into())).unwrap();
        client
            .write
            .write_frame(Frame::close(4000, b"bye"))
            .await
            .unwrap();
        let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
        // Either the pump wrote the application's Close, and so returns no
        // reader to wait on, or the Close is still queued and the wait
        // writes it at once. Neither waits for the peer to disconnect.
        if let Some(reader) = pumped.reader {
            tokio::time::timeout(
                Duration::from_secs(5),
                write_until_close(&pumped.writer, &mut outputs, reader),
            )
            .await
            .expect("the queued Close ends the wait");
        }
        let close = client.read_frame().await;
        assert_eq!(close.opcode, OpCode::Close);
        assert_eq!(
            websocket_close_details(&close.payload),
            (4009, "mine".into())
        );
        drop(application);
    }

    #[tokio::test]
    async fn a_socket_that_closes_first_reports_its_peers_reply() {
        let (server, mut client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        application.send(WsOut::Text("last".into())).unwrap();
        application.send(WsOut::Close(4001, "mine".into())).unwrap();
        let pump = tokio::spawn(async move {
            let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
            (pumped.close, pumped.reader.is_some())
        });
        assert_eq!(client.read_frame().await.opcode, OpCode::Text);
        let close = client.read_frame().await;
        assert_eq!(
            websocket_close_details(&close.payload),
            (4001, "mine".into())
        );
        // The socket is CLOSING until the reply, which is its close state.
        client
            .write
            .write_frame(Frame::close(4002, b"reply"))
            .await
            .unwrap();
        let (close, reader) = tokio::time::timeout(Duration::from_secs(5), pump)
            .await
            .expect("the reply ends the pump")
            .unwrap();
        assert_eq!(close.state, (4002, "reply".to_string(), true));
        assert_eq!(close.initiator, CloseInitiator::Application);
        assert!(
            !reader,
            "a socket that sent its Close has nothing to wait for"
        );
        drop(application);
    }

    #[tokio::test]
    async fn a_socket_that_closes_first_ends_abnormally_when_its_peer_leaves() {
        let (server, mut client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        application.send(WsOut::Close(4001, "mine".into())).unwrap();
        let pump = tokio::spawn(async move {
            pump_socket(server, &mut outputs, |_| async { Ok(()) })
                .await
                .close
        });
        assert_eq!(client.read_frame().await.opcode, OpCode::Close);
        drop(client);
        let close = tokio::time::timeout(Duration::from_secs(5), pump)
            .await
            .expect("the connection's end ends the pump")
            .unwrap();
        assert_eq!(
            close.state,
            (
                1006,
                celld::js::DISCONNECTED_WITHOUT_CLOSE.to_string(),
                false
            )
        );
        drop(application);
    }

    #[tokio::test]
    async fn a_socket_whose_peer_does_not_read_closes_past_its_queue_limit() {
        // The client reads nothing, so the server's writes stop once the
        // connection's small buffer is full.
        let (server, client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        let megabyte = || WsOut::Binary(vec![0; 1024 * 1024]);
        let pump = tokio::spawn(async move {
            let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
            (pumped.close, outputs.try_recv().is_none())
        });
        // The first frame's write blocks on the full connection.
        application.send(megabyte()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let budget = celld::js::WS_OUT_QUEUE_MAX_BYTES / (1024 * 1024);
        let mut refused = false;
        for _ in 0..budget + 8 {
            refused |= application.send(megabyte()).is_err();
        }
        assert!(refused, "the channel stops taking frames past its limit");
        // The write under way is abandoned once the grace has passed.
        let (close, finished) =
            tokio::time::timeout(WS_OUT_ABANDON_GRACE + Duration::from_secs(5), pump)
                .await
                .expect("the overflow ends the pump")
                .unwrap();
        assert_eq!(close.state.0, 1006);
        assert_eq!(close.state.1, celld::js::WS_OUT_OVERFLOW_REASON);
        assert!(
            finished,
            "nothing more is written on the abandoned connection"
        );
        drop(client);
    }

    /// A server socket on a real TCP connection, and the client's stream:
    /// shutting down one side of a connection, or resetting it, needs one.
    async fn tcp_connection() -> (WebSocket<tokio::net::TcpStream>, tokio::net::TcpStream) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = tokio::net::TcpStream::connect(listener.local_addr().unwrap());
        let (client, accepted) = tokio::join!(client, listener.accept());
        let mut server = WebSocket::after_handshake(accepted.unwrap().0, Role::Server);
        server.set_auto_close(false);
        (server, client.unwrap())
    }

    #[tokio::test]
    async fn a_half_open_socket_waits_for_a_peer_that_only_shut_down_its_side() {
        use tokio::io::AsyncWriteExt;
        let (server, client) = tcp_connection().await;
        let mut client = WebSocket::after_handshake(client, Role::Client);
        client.set_auto_close(false);
        client
            .write_frame(Frame::close(4000, b"bye"))
            .await
            .unwrap();
        let (_application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
        assert_eq!(pumped.close.initiator, CloseInitiator::Peer);
        let mut client = client.into_inner();
        client.shutdown().await.unwrap();
        let waited = tokio::time::timeout(
            HALF_OPEN_PROBE_INTERVAL * 3,
            write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()),
        )
        .await;
        assert!(
            waited.is_err(),
            "a peer that may still read keeps the socket"
        );
        drop(client);
    }

    #[tokio::test]
    async fn a_half_open_socket_ends_soon_after_its_peer_closes_its_connection() {
        let (server, client) = tcp_connection().await;
        let mut client = WebSocket::after_handshake(client, Role::Client);
        client.set_auto_close(false);
        client
            .write_frame(Frame::close(4000, b"bye"))
            .await
            .unwrap();
        let (_application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
        // Closed outright: its side ends as a shut-down one does, and the
        // first Ping that reaches it is answered with a reset.
        drop(client);
        tokio::time::timeout(
            HALF_OPEN_PROBE_INTERVAL * 4,
            write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()),
        )
        .await
        .expect("the probe finds the peer gone");
    }

    #[tokio::test]
    async fn a_half_open_socket_ends_when_its_peer_resets_during_a_write() {
        use tokio::io::AsyncWriteExt;
        // A small receive buffer, so the application's writes block.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        let (client, accepted) = tokio::join!(
            socket.connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        let (server, client) = (accepted.unwrap().0, client.unwrap());
        let mut server = WebSocket::after_handshake(server, Role::Server);
        server.set_auto_close(false);
        let mut client = WebSocket::after_handshake(client, Role::Client);
        client.set_auto_close(false);
        client
            .write_frame(Frame::close(4000, b"bye"))
            .await
            .unwrap();
        let (application, mut outputs) = celld::js::ws_out_channel();
        let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
        let mut client = client.into_inner();
        client.shutdown().await.unwrap();
        // The client reads nothing, so the application's writes after its
        // Close fill the connection, and one is under way at each probe.
        for _ in 0..16 {
            application
                .send(WsOut::Binary(vec![0; 1024 * 1024]))
                .unwrap();
        }
        let wait = tokio::spawn(async move {
            write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()).await;
        });
        tokio::time::sleep(HALF_OPEN_PROBE_INTERVAL * 3).await;
        assert!(
            !wait.is_finished(),
            "a peer that may still read keeps the socket"
        );
        client.set_zero_linger().unwrap();
        drop(client);
        tokio::time::timeout(HALF_OPEN_PROBE_INTERVAL * 4, wait)
            .await
            .expect("the reset ends the write under way, and the wait")
            .unwrap();
        drop(application);
    }

    #[tokio::test]
    async fn a_blocked_write_is_abandoned_once_its_owner_lets_go() {
        // The client reads nothing, so the first frame's write blocks.
        let (server, client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        application
            .send(WsOut::Binary(vec![0; 1024 * 1024]))
            .unwrap();
        let pump = tokio::spawn(async move {
            let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
            (pumped.close, outputs.try_recv().is_none())
        });
        tokio::time::sleep(WS_OUT_ABANDON_GRACE * 2).await;
        assert!(!pump.is_finished(), "while the owner lives the write waits");
        drop(application);
        let (close, finished) = tokio::time::timeout(WS_OUT_ABANDON_GRACE * 4, pump)
            .await
            .expect("the owner's going abandons the write")
            .unwrap();
        assert_eq!(close.state.0, 1006);
        assert!(
            finished,
            "nothing more is written on the abandoned connection"
        );
        drop(client);
    }

    #[tokio::test]
    async fn a_half_open_probe_gives_up_once_its_owner_goes() {
        use tokio::io::AsyncWriteExt;
        // A connection that holds 64 bytes, which one frame fills, and a
        // client that never reads: a Ping then blocks, with no application
        // write under way.
        let (server, mut client) = tokio::io::duplex(64);
        let mut server = WebSocket::after_handshake(server, Role::Server);
        server.set_auto_close(false);
        let (application, mut outputs) = celld::js::ws_out_channel();
        // The client's Close, masked, then its side ends (FIN).
        let mut close = vec![0x88, 0x82, 1, 2, 3, 4];
        close.extend([0x0f ^ 1, 0xa0 ^ 2]);
        client.write_all(&close).await.unwrap();
        client.shutdown().await.unwrap();
        let pumped = pump_socket(server, &mut outputs, |_| async { Ok(()) }).await;
        assert_eq!(pumped.close.initiator, CloseInitiator::Peer);
        // Fills the connection: a 2-byte header and 62 bytes.
        application.send(WsOut::Binary(vec![0; 62])).unwrap();
        let wait = tokio::spawn(async move {
            write_until_close(&pumped.writer, &mut outputs, pumped.reader.unwrap()).await;
        });
        tokio::time::sleep(HALF_OPEN_PROBE_INTERVAL * 2).await;
        assert!(
            !wait.is_finished(),
            "while the owner lives the socket waits"
        );
        // The owner retires.
        drop(application);
        tokio::time::timeout(HALF_OPEN_PROBE_INTERVAL * 4, wait)
            .await
            .expect("the blocked Ping gives up once the owner goes")
            .unwrap();
        drop(client);
    }

    #[tokio::test]
    async fn a_socket_that_closes_first_stops_waiting_when_its_owner_goes() {
        let (server, mut client) = connection();
        let (application, mut outputs) = celld::js::ws_out_channel();
        application.send(WsOut::Close(4001, "mine".into())).unwrap();
        let pump = tokio::spawn(async move {
            pump_socket(server, &mut outputs, |_| async { Ok(()) })
                .await
                .close
        });
        assert_eq!(client.read_frame().await.opcode, OpCode::Close);
        // The peer never answers; the owner lets go of the socket.
        drop(application);
        let close = tokio::time::timeout(Duration::from_secs(2), pump)
            .await
            .expect("the owner's going ends the wait")
            .unwrap();
        assert_eq!(close.state, (1006, String::new(), false));
        drop(client);
    }

    #[test]
    fn only_a_dispatched_accepted_socket_waits_for_its_reply() {
        assert!(awaits_reply(false, true, || false));
        assert!(!awaits_reply(true, true, || false), "the drain ended it");
        assert!(!awaits_reply(false, false, || false), "no handler ran");
        assert!(!awaits_reply(false, true, || true), "hibernatable");
    }

    /// A pipe's channels: the cell's and the caller's outputs, and the
    /// caller's input queue.
    struct Pipe {
        cell: celld::js::WsOutSender,
        from_cell: celld::js::WsOutReceiver,
        caller: celld::js::WsOutSender,
        from_caller: celld::js::WsOutReceiver,
        pull: celld::js::WsPullSender,
        caller_queue: celld::js::WsPullReceiver,
    }

    fn pipe() -> Pipe {
        let (cell, from_cell) = celld::js::ws_out_channel();
        let (caller, from_caller) = celld::js::ws_out_channel();
        let (pull, caller_queue) = celld::js::ws_pull_channel();
        Pipe {
            cell,
            from_cell,
            caller,
            from_caller,
            pull,
            caller_queue,
        }
    }

    async fn carry(pipe: &mut Pipe, hibernatable: bool) {
        tokio::time::timeout(
            Duration::from_secs(5),
            carry_cell_reply(
                hibernatable,
                async {},
                &pipe.pull,
                &mut pipe.from_cell,
                &mut pipe.from_caller,
            ),
        )
        .await
        .expect("the carry ends");
    }

    #[tokio::test]
    async fn a_pipe_carries_the_cells_reply_to_the_caller() {
        let mut pipe = pipe();
        pipe.cell.send(WsOut::Text("last".into())).unwrap();
        pipe.cell.send(WsOut::Close(4005, "reply".into())).unwrap();
        carry(&mut pipe, false).await;
        assert!(
            matches!(pipe.caller_queue.recv().await, Some(WsPull::Text(text)) if text == "last")
        );
        assert!(matches!(
            pipe.caller_queue.recv().await,
            Some(WsPull::Close(4005, reason, true, _)) if reason == "reply"
        ));
    }

    #[tokio::test]
    async fn a_pipe_stops_waiting_when_the_callers_request_ends() {
        let mut pipe = pipe();
        let _cell = pipe.cell.clone();
        drop(std::mem::replace(
            &mut pipe.caller,
            celld::js::ws_out_channel().0,
        ));
        carry(&mut pipe, false).await;
    }

    #[tokio::test]
    async fn a_pipe_stops_waiting_when_the_caller_stops_reading() {
        let mut pipe = pipe();
        let _caller = pipe.caller.clone();
        drop(std::mem::replace(
            &mut pipe.caller_queue,
            celld::js::ws_pull_channel().1,
        ));
        carry(&mut pipe, false).await;
    }

    #[tokio::test]
    async fn a_pipe_stops_waiting_when_the_cells_socket_goes() {
        let mut pipe = pipe();
        let _caller = pipe.caller.clone();
        drop(std::mem::replace(
            &mut pipe.cell,
            celld::js::ws_out_channel().0,
        ));
        carry(&mut pipe, false).await;
    }

    #[tokio::test]
    async fn a_hibernatable_cell_replies_only_with_what_it_queued() {
        let mut pipe = pipe();
        let _caller = pipe.caller.clone();
        // The cell's channel stays open: the carry must not wait on it.
        carry(&mut pipe, true).await;
        drop(pipe.pull);
        assert!(pipe.caller_queue.recv().await.is_none(), "no reply");
    }

    #[tokio::test]
    async fn a_pipe_takes_the_callers_reply_to_the_cells_close() {
        let (caller, mut from_caller) = celld::js::ws_out_channel();
        caller.send(WsOut::Text("ignored".into())).unwrap();
        caller.send(WsOut::Close(4000, "reply".into())).unwrap();
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            await_caller_reply(&mut from_caller, Duration::from_secs(60)),
        )
        .await
        .expect("the reply ends the wait");
        assert_eq!(reply, Some((4000, "reply".to_string())));
        // A caller that never replies is waited for only so long.
        assert_eq!(
            await_caller_reply(&mut from_caller, Duration::from_millis(50)).await,
            None
        );
        drop(caller);
        assert_eq!(
            await_caller_reply(&mut from_caller, Duration::from_secs(60)).await,
            None
        );
    }
}

// Both cell socket loops had the same hazard as the tunnel: they read the socket
// in the same select! as the cell's outbound queue, so an outbound frame that
// won the race dropped a read in progress. A lost frame keeps the workload
// ledger exact while delivery is not, so frame-level observation is required.
#[cfg(all(test, celld_internal_tests))]
mod socket_cancel_private {
    include!(env!("CELLD_CONFORMANCE_SOCKET_CANCEL_TESTS"));
}
