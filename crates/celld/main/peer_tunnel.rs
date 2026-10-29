// Copyright 2026 Deno Land Inc. All rights reserved.

//! The peer tunnel: an upgraded stream per peer, plain HTTP inside.
//!
//! Establishment is an h1 upgrade on `/peer/tunnel` — CONNECT semantics with Upgrade
//! mechanics, because CONNECT's authority-form target fits this use badly.
//! After the 101 the connection is an opaque duplex stream, and app requests
//! cross as literal HTTP driven by hyper on both ends: the hop never
//! interprets the inner bytes, so the headers the cell must receive
//! byte-faithful (`Host`, `Content-Length`, `Upgrade`) are data here, not
//! metadata. Per-call control (scope, cell name, request id, capacity
//! handoff, the caller's trace context, the caller) rides `x-cells-*` headers on the
//! inner request; node A overwrites and node B strips them, so the reserved
//! names cannot be smuggled by an application in either direction.
//!
//! Idle tunnels are pooled per peer and reused for sequential calls — plain
//! h1 keep-alive inside the tunnel, never multiplexing. Without reuse every
//! call is a fresh TCP connection, and a loopback-speed caller saturates the
//! whole ephemeral-port range into TIME_WAIT within seconds (~1k calls/s is
//! the hard OS ceiling), which the pooled transport this replaces never hit.

use std::collections::HashMap;
use std::convert::Infallible;

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::TryStreamExt;
use http_body_util::BodyExt;
use hyper::body::Body;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::Request;
use hyper::Response;
use hyper::StatusCode;
use hyper_util::rt::TokioIo;

use super::*;
use celld::js::HttpChunkStream;

pub(crate) const TUNNEL_PROTOCOL: &str = "celld-tunnel";
pub(crate) const TUNNEL_VERSION: &str = "7";
pub(crate) const VERSION_HEADER: &str = "x-cells-tunnel-version";
pub(crate) const KIND_HEADER: &str = "x-cells-tunnel-kind";
pub(crate) const SCOPE_HEADER: &str = "x-cells-scope";
pub(crate) const NAME_HEADER: &str = "x-cells-do-name";
pub(crate) const REQUEST_ID_HEADER: &str = "x-cells-request-id";
pub(crate) const HANDOFF_HEADER: &str = "x-cells-capacity-handoff";
/// The calling handler's trace context, in `traceparent` form. Node A writes
/// it from the context the host read at the call site, never from the
/// application's headers, so a cell joins its caller's trace on any node.
pub(crate) const TRACE_HEADER: &str = "x-cells-traceparent";
/// Who made the call: `host`, or `script:<name>` for a Worker script's code.
/// Node B checks the call against the grant its own deployment gives that
/// script, so a call is refused on the owner as it is on the caller's node.
pub(crate) const CALLER_HEADER: &str = "x-cells-caller";
/// The cell whose event made a script's call, when one did.
pub(crate) const CALLER_EVENT_HEADER: &str = "x-cells-caller-event";

/// The inner headers node A owns. A overwrites them on the way in and B
/// strips them on the way out, so an application header with a reserved name
/// is dropped rather than obeyed.
const CONTROL_HEADERS: [&str; 7] = [
    SCOPE_HEADER,
    NAME_HEADER,
    REQUEST_ID_HEADER,
    HANDOFF_HEADER,
    TRACE_HEADER,
    CALLER_HEADER,
    CALLER_EVENT_HEADER,
];

/// The caller of a tunneled call as it crosses: the script by name, since a
/// grant is this node's own and the owner builds the script's from its own
/// deployment (see `forwarded_caller`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TunnelCaller {
    Host,
    Script {
        script: String,
        event: Option<String>,
    },
}

impl TunnelCaller {
    pub(crate) fn of(caller: &Caller) -> Self {
        match caller {
            Caller::Host => TunnelCaller::Host,
            Caller::Script(caller) => TunnelCaller::Script {
                script: caller.grant.script().to_string(),
                event: caller.event.clone(),
            },
        }
    }

    /// Node B: the caller, with the grant `grant_of` gives its script under
    /// this node's deployment. A script it does not deploy (a Dynamic Worker,
    /// or a script of another deployment) reaches no cell.
    pub(crate) fn resolve(
        self,
        grant_of: impl FnOnce(&str) -> Option<Arc<celld::scope_grant::ScopeGrant>>,
    ) -> Caller {
        match self {
            TunnelCaller::Host => Caller::Host,
            TunnelCaller::Script { script, event } => {
                let grant = grant_of(&script)
                    .unwrap_or_else(|| Arc::new(celld::scope_grant::ScopeGrant::none(&script)));
                Caller::Script(celld::scope_grant::ScriptCaller { grant, event })
            }
        }
    }

    /// Node A: the caller's headers on an inner request.
    fn write(&self, inner: hyper::http::request::Builder) -> hyper::http::request::Builder {
        match self {
            TunnelCaller::Host => inner.header(CALLER_HEADER, "host"),
            TunnelCaller::Script { script, event } => {
                let inner = inner.header(CALLER_HEADER, format!("script:{script}"));
                match event {
                    Some(event) => inner.header(CALLER_EVENT_HEADER, event.as_str()),
                    None => inner,
                }
            }
        }
    }

    /// Node B: the caller an inner request names. `None` when it names none,
    /// which only a peer that is not this version sends: the call is refused.
    fn read(headers: &hyper::HeaderMap) -> Option<TunnelCaller> {
        let caller = headers.get(CALLER_HEADER)?.to_str().ok()?;
        if caller == "host" {
            return Some(TunnelCaller::Host);
        }
        let script = caller.strip_prefix("script:")?;
        let event = match headers.get(CALLER_EVENT_HEADER) {
            Some(event) => Some(
                event
                    .to_str()
                    .ok()
                    .filter(|event| celld_logic::cell::valid_cell_scope(event))?
                    .to_string(),
            ),
            None => None,
        };
        Some(TunnelCaller::Script {
            script: script.to_string(),
            event,
        })
    }
}

/// The refusal for an inner request that names no caller.
fn missing_caller() -> HttpReply {
    peer_response(response(
        StatusCode::BAD_REQUEST,
        "the tunneled call names no caller",
    ))
}

enum TunnelKind {
    Do,
    Rpc,
}

/// The control fields of one tunneled call, carried as inner-request headers
/// so one tunnel can serve calls for any cell.
pub(crate) struct TunnelControl {
    pub(crate) scope: String,
    pub(crate) name: Option<String>,
    pub(crate) request_id: Option<celld::js::RequestId>,
    pub(crate) capacity_handoff: bool,
    pub(crate) parent: Option<celld::telemetry::TraceContext>,
    pub(crate) caller: TunnelCaller,
}

/// The caller's trace context from an inner request, as a remote parent.
/// A malformed value is ignored, as an ingress `traceparent` is.
fn trace_parent(headers: &hyper::HeaderMap) -> Option<celld::telemetry::TraceContext> {
    headers
        .get(TRACE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(celld::telemetry::parse_traceparent)
        .map(celld::telemetry::ParentContext::context)
}

/// Node B: the control fields of an inner fetch, or the refusal when the
/// scope is missing or malformed or no caller is named.
fn tunnel_control(headers: &hyper::HeaderMap) -> Result<TunnelControl, Box<HttpReply>> {
    let scope = headers
        .get(SCOPE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .filter(|scope| celld_logic::cell::valid_cell_scope(scope))
        .ok_or_else(|| Box::new(peer_response(malformed_scope())))?;
    let caller = TunnelCaller::read(headers).ok_or_else(|| Box::new(missing_caller()))?;
    Ok(TunnelControl {
        scope,
        name: headers
            .get(NAME_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        request_id: headers
            .get(REQUEST_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(celld::js::parse_request_id),
        capacity_handoff: headers.get(HANDOFF_HEADER).is_some(),
        parent: trace_parent(headers),
        caller,
    })
}

/// Node B: the inner request's headers without node A's control headers,
/// which are the application's to receive.
fn application_headers(headers: &hyper::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| !CONTROL_HEADERS.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

impl TunnelControl {
    /// The cell and the call node B dispatches for an inner fetch.
    fn into_fetch(
        self,
        url: String,
        method: String,
        headers: Vec<(String, String)>,
    ) -> (String, ForwardedFetch) {
        let fetch = ForwardedFetch {
            name: self.name,
            url,
            method,
            headers,
            request_id: self.request_id,
            capacity_handoff: self.capacity_handoff,
            parent: self.parent,
            caller: self.caller,
        };
        (self.scope, fetch)
    }
}

/// Node B: an inner RPC's control fields, checked before its body is read.
struct RpcHead {
    scope: String,
    name: Option<String>,
    method: String,
    structured: bool,
    parent: Option<celld::telemetry::TraceContext>,
    caller: TunnelCaller,
}

impl RpcHead {
    fn parse(headers: &hyper::HeaderMap) -> Result<RpcHead, Box<HttpReply>> {
        let Some(scope) = headers
            .get(SCOPE_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .filter(|scope| celld_logic::cell::valid_cell_scope(scope))
        else {
            return Err(Box::new(peer_response(malformed_scope())));
        };
        let Some(method) = headers
            .get(METHOD_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
        else {
            return Err(Box::new(peer_response(response(
                StatusCode::BAD_REQUEST,
                "RPC method header is missing",
            ))));
        };
        let Some(caller) = TunnelCaller::read(headers) else {
            return Err(Box::new(missing_caller()));
        };
        Ok(RpcHead {
            scope,
            name: headers
                .get(NAME_HEADER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            method,
            structured: headers
                .get(hyper::header::CONTENT_TYPE)
                .is_some_and(|value| value.as_bytes() == b"application/octet-stream"),
            parent: trace_parent(headers),
            caller,
        })
    }

    /// The call, with the arguments in the encoding the caller named.
    fn with_body(self, body: Bytes) -> Result<ForwardedRpc, Box<HttpReply>> {
        let args = if self.structured {
            celld::js::RpcData::V8(body)
        } else {
            match String::from_utf8(body.to_vec()) {
                Ok(json) => celld::js::RpcData::Json(json),
                Err(_) => {
                    return Err(Box::new(peer_response(response(
                        StatusCode::BAD_REQUEST,
                        "JSON RPC arguments are not UTF-8",
                    ))));
                }
            }
        };
        Ok(ForwardedRpc {
            scope: self.scope,
            name: self.name,
            method: self.method,
            args,
            parent: self.parent,
            caller: self.caller,
        })
    }
}

pub(crate) fn is_tunnel_request(request: &Request<Incoming>) -> bool {
    request
        .headers()
        .get(hyper::header::UPGRADE)
        .is_some_and(|value| value.as_bytes() == TUNNEL_PROTOCOL.as_bytes())
}

/// Node B: answer a tunnel establishment on `/peer/tunnel` with a 101 and serve the
/// inner connection until the peer closes it.
///
/// The establishment carries the fleet HMAC and nothing after it does. The
/// signature gates who can open a tunnel — the inner calls it then carries
/// are cell dispatches, and a reserved-class dispatch must demand the fleet
/// secret on every path the way `/runtime/` does. The signature does not
/// authenticate the bytes after the 101 and does not encrypt anything; the
/// private network remains the boundary for both.
pub(crate) fn accept(mut request: Request<Incoming>, app: AppHandle) -> HttpReply {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map_or_else(|| request.uri().path().to_string(), ToString::to_string);
    if let Err(error) = app.peer_auth.verify(
        request.method(),
        &path_and_query,
        request.headers(),
        b"",
        app.peer_auth.source(),
    ) {
        let mut denied = response(error.status(), error.message());
        // A wrong target means the dialer holds a stale lease for this
        // address; the stale marker lets its redispatch invalidate the
        // route instead of retrying the same dead name.
        if matches!(error, peer_auth::VerifyError::WrongTarget) {
            denied.headers_mut().insert(
                hyper::header::HeaderName::from_static(STALE_ROUTE_HEADER),
                hyper::header::HeaderValue::from_static(STALE_ROUTE_VALUE),
            );
        }
        return peer_response(denied);
    }
    let headers = request.headers();
    if headers
        .get(VERSION_HEADER)
        .is_none_or(|value| value.as_bytes() != TUNNEL_VERSION.as_bytes())
    {
        // The reply names this node's version, so the dialer can say which
        // two versions met.
        let mut refused = response(
            StatusCode::UPGRADE_REQUIRED,
            "peer tunnel version is incompatible",
        );
        refused.headers_mut().insert(
            hyper::header::HeaderName::from_static(VERSION_HEADER),
            hyper::header::HeaderValue::from_static(TUNNEL_VERSION),
        );
        return peer_response(refused);
    }
    let kind = match headers
        .get(KIND_HEADER)
        .map(hyper::header::HeaderValue::as_bytes)
    {
        Some(b"do") => TunnelKind::Do,
        Some(b"rpc") => TunnelKind::Rpc,
        _ => {
            return peer_response(response(StatusCode::BAD_REQUEST, "unknown tunnel kind"));
        }
    };
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let upgraded = match upgrade.await {
            Ok(upgraded) => upgraded,
            Err(_) => return,
        };
        match kind {
            TunnelKind::Do => serve_do(upgraded, app).await,
            TunnelKind::Rpc => serve_rpc(upgraded, app).await,
        }
    });
    let mut reply = response(StatusCode::SWITCHING_PROTOCOLS, "");
    reply.headers_mut().insert(
        hyper::header::UPGRADE,
        hyper::header::HeaderValue::from_static(TUNNEL_PROTOCOL),
    );
    reply.headers_mut().insert(
        hyper::header::CONNECTION,
        hyper::header::HeaderValue::from_static("upgrade"),
    );
    reply.headers_mut().insert(
        hyper::header::HeaderName::from_static(VERSION_HEADER),
        hyper::header::HeaderValue::from_static(TUNNEL_VERSION),
    );
    peer_response(reply)
}

/// One inner request, one call: parse the app request hyper already framed,
/// dispatch it exactly as the enveloped path did, and let the reply stream
/// back as an ordinary HTTP response. The connection serves calls until the
/// peer closes it or an inner upgrade consumes it.
async fn serve_do(upgraded: hyper::upgrade::Upgraded, app: AppHandle) {
    let service = service_fn(move |mut inner: Request<Incoming>| {
        let app = app.clone();
        async move {
            let control = match tunnel_control(inner.headers()) {
                Ok(control) => control,
                Err(refusal) => return Ok::<_, Infallible>(*refusal),
            };
            // A tunneled upgrade is the client's own handshake, so the
            // owner answers it directly: fastwebsockets computes the 101
            // for the client's key, and the inner connection becomes the
            // socket the cell speaks — the same machinery a locally
            // connected client gets.
            let client_upgrade = if fastwebsockets::upgrade::is_upgrade_request(&inner) {
                match fastwebsockets::upgrade::upgrade(&mut inner) {
                    Ok(pair) => Some(pair),
                    Err(error) => {
                        return Ok(peer_response(response(
                            StatusCode::BAD_REQUEST,
                            format!("tunneled upgrade: {error}"),
                        )));
                    }
                }
            } else {
                None
            };
            let (parts, body) = inner.into_parts();
            let headers = application_headers(&parts.headers);
            // Streaming by construction: the inner body is handed to the
            // isolate as a stream whatever its size, bounded the way the
            // enveloped path bounded its frame.
            let limited = http_body_util::Limited::new(body, MAX_PEER_FORWARD_BODY_BYTES);
            let chunks: HttpChunkStream = Box::pin(
                http_body_util::BodyStream::new(limited)
                    .try_filter_map(|frame| async move { Ok(frame.into_data().ok()) })
                    .map_ok(|data: Bytes| data.to_vec())
                    .map_err(|error| error.to_string()),
            );
            let stream_id = match celld::js::register_body_stream(chunks) {
                Ok(stream_id) => stream_id,
                Err(error) => {
                    return Ok(peer_response(response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        format!("request body stream: {error}"),
                    )));
                }
            };
            let body = celld::js::RequestBody::Stream(stream_id);
            let (scope, fetch) =
                control.into_fetch(parts.uri.to_string(), parts.method.to_string(), headers);
            let outcome = dispatch_forwarded_fetch(app.clone(), scope, fetch, body).await;
            let (target, worker_headers) = match outcome {
                ForwardedFetchOutcome::Reply(reply) => return Ok(reply),
                ForwardedFetchOutcome::WebSocket { target, headers } => (target, headers),
            };
            let Some((accept, upgrade)) = client_upgrade else {
                // `dispatch_forwarded_fetch` refuses a request without
                // `Upgrade: websocket`, so this branch sees only a request
                // that names the upgrade but is not a valid handshake. The
                // socket is registered with the core by now, and the refusal
                // must release it.
                let refusal = super::websocket::refuse_websocket_without_upgrade(
                    &app,
                    HttpResponseWebSocket::Cell(target),
                )
                .await;
                return Ok(peer_response(refusal));
            };
            // The cell accepted: hand the inner stream to the same socket
            // task a local client gets, and answer with the real 101. The
            // Worker's application headers ride along; the sidecars and
            // the hop framing die here.
            tokio::spawn(async move {
                match upgrade.await {
                    Ok(socket) => super::websocket::websocket_task(app, target, socket).await,
                    Err(error) => {
                        eprintln!("celld tunneled upgrade failed: {error}");
                    }
                }
            });
            let (accept_parts, _) = accept.into_parts();
            let mut answer = Response::from_parts(
                accept_parts,
                BodyExt::boxed_unsync(http_body_util::Empty::new().map_err(|never| match never {})),
            );
            for (name, value) in &worker_headers {
                let lowered = name.to_ascii_lowercase();
                if lowered == "content-length"
                    || lowered == "upgrade"
                    || lowered == "connection"
                    || lowered == "sec-websocket-accept"
                {
                    continue;
                }
                let Ok(name) = hyper::header::HeaderName::from_bytes(name.as_bytes()) else {
                    continue;
                };
                let Ok(value) = hyper::header::HeaderValue::from_str(value) else {
                    continue;
                };
                answer.headers_mut().append(name, value);
            }
            Ok(peer_response(answer))
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(upgraded, service)
        .with_upgrades()
        .await;
}

type TunnelSender = hyper::client::conn::http1::SendRequest<TunnelBody>;

/// The peer rejected the outer tunnel before an application request crossed
/// it. This is a definite stale route, so the caller can refresh ownership
/// without risking a duplicate handler invocation.
#[derive(Debug)]
pub(crate) struct StaleTunnelRoute;

impl std::fmt::Display for StaleTunnelRoute {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("peer rejected the stale tunnel route")
    }
}

impl std::error::Error for StaleTunnelRoute {}

/// The peer speaks another tunnel version. Versions never mix in a fleet:
/// every node stops before the new version starts (docs/README.md, "Upgrade
/// notes"). The attempt is not a stale route, so it fails at once.
#[derive(Debug)]
pub(crate) struct TunnelVersionMismatch {
    node: String,
    /// The peer's version, which a node before version 6 does not report.
    theirs: Option<String>,
}

impl std::fmt::Display for TunnelVersionMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "peer {} speaks tunnel version {}, and this node speaks {TUNNEL_VERSION}; \
             stop every node before starting a new version",
            self.node,
            self.theirs.as_deref().unwrap_or("5 or older"),
        )
    }
}

impl std::error::Error for TunnelVersionMismatch {}

/// Report a version mismatch once per peer and version, so a mixed fleet is
/// loud in the log without a line per call.
fn report_version_mismatch(mismatch: &TunnelVersionMismatch) {
    /// The (peer, peer version) pairs already logged.
    type Reported = std::collections::HashSet<(String, Option<String>)>;
    static REPORTED: std::sync::OnceLock<std::sync::Mutex<Reported>> = std::sync::OnceLock::new();
    let first = REPORTED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert((mismatch.node.clone(), mismatch.theirs.clone()));
    if first {
        tracing::error!(
            event = "peer_tunnel_version_mismatch",
            peer = %mismatch.node,
            peer_version = mismatch.theirs.as_deref().unwrap_or("5 or older"),
            version = TUNNEL_VERSION,
            "{mismatch}"
        );
    }
}

/// Who node A dials and how it proves itself. One borrow carries the
/// client, the fleet key, and the routed peer's address and name through
/// an attempt.
pub(crate) struct Peer<'a> {
    pub(crate) http: &'a reqwest::Client,
    pub(crate) auth: &'a PeerAuth,
    pub(crate) addr: &'a str,
    pub(crate) node: &'a str,
}

/// Idle tunnels per (peer, kind). A sender goes back only after its response
/// body reaches a clean end, so active replies do not consume the idle bound.
/// A dropped or poisoned connection reports `is_closed` and is purged on scan.
static TUNNELS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Vec<TunnelSender>>>> =
    std::sync::OnceLock::new();
/// Completed idle tunnels count against this bound. Active calls own their
/// senders outside the pool, so concurrency cannot evict a reusable tunnel.
const TUNNEL_POOL_CAP: usize = 64;

fn checkout(key: &str) -> Option<TunnelSender> {
    let mut pool = TUNNELS.get_or_init(Default::default).lock().unwrap();
    let senders = pool.get_mut(key)?;
    senders.retain(|sender| !sender.is_closed());
    let index = senders.iter().position(TunnelSender::is_ready)?;
    Some(senders.swap_remove(index))
}

fn park(key: &str, sender: TunnelSender) {
    let mut pool = TUNNELS.get_or_init(Default::default).lock().unwrap();
    let senders = pool.entry(key.to_string()).or_default();
    if senders.len() < TUNNEL_POOL_CAP {
        senders.push(sender);
    }
}

/// Establish a fresh tunnel to `addr` and hand back its inner h1 client.
/// The establishment is a bodiless GET, so the fleet HMAC signs it whole —
/// the one signature every call on this tunnel then rides.
async fn establish(peer: &Peer<'_>, kind: &'static str) -> anyhow::Result<TunnelSender> {
    let request = peer
        .http
        .get(format!("http://{}/peer/tunnel", peer.addr))
        .header(reqwest::header::UPGRADE, TUNNEL_PROTOCOL)
        .header(reqwest::header::CONNECTION, "upgrade")
        .header(VERSION_HEADER, TUNNEL_VERSION)
        .header(KIND_HEADER, kind)
        .header(
            peer_auth::RESPONSE_VERSION_HEADER,
            peer_auth::PROTOCOL_VERSION_TEXT,
        );
    let response = peer
        .auth
        .sign(request, "GET", "/peer/tunnel", b"", peer.node)?
        .send()
        .await?;
    peer_auth::validate_response(response.headers())?;
    if response
        .headers()
        .get(STALE_ROUTE_HEADER)
        .is_some_and(|value| value == STALE_ROUTE_VALUE)
    {
        return Err(StaleTunnelRoute.into());
    }
    if response.status() == reqwest::StatusCode::UPGRADE_REQUIRED {
        let mismatch = TunnelVersionMismatch {
            node: peer.node.to_string(),
            theirs: response
                .headers()
                .get(VERSION_HEADER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        };
        report_version_mismatch(&mismatch);
        return Err(mismatch.into());
    }
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::SWITCHING_PROTOCOLS,
        "tunnel establishment answered {}",
        response.status()
    );
    let upgraded = response.upgrade().await?;
    let (sender, connection) = hyper::client::conn::http1::Builder::new()
        .handshake(TokioIo::new(upgraded))
        .await?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    Ok(sender)
}

fn inner_request(
    control: &TunnelControl,
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: TunnelBody,
) -> anyhow::Result<Request<TunnelBody>> {
    let mut inner = Request::builder().method(method).uri(url);
    for (name, value) in headers {
        if CONTROL_HEADERS
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(name))
        {
            continue;
        }
        inner = inner.header(name.as_str(), value.as_str());
    }
    inner = inner.header(SCOPE_HEADER, control.scope.as_str());
    if let Some(name) = &control.name {
        inner = inner.header(NAME_HEADER, name);
    }
    if let Some(request_id) = control.request_id {
        inner = inner.header(REQUEST_ID_HEADER, celld::js::request_id_string(request_id));
    }
    if control.capacity_handoff {
        inner = inner.header(HANDOFF_HEADER, "1");
    }
    if let Some(parent) = &control.parent {
        inner = inner.header(TRACE_HEADER, celld::telemetry::traceparent(parent));
    }
    inner = control.caller.write(inner);
    Ok(inner.body(body)?)
}

/// Send one inner request, preferring a pooled tunnel. A pooled connection
/// can die between checkout and use, so a replayable body retries once on a
/// fresh tunnel — the same stale keep-alive race every h1 pool has. A
/// streamed body is not replayable; its pooled failure surfaces as the
/// attempt failure the caller already handles.
async fn send_inner(
    peer: &Peer<'_>,
    kind: &'static str,
    build: impl Fn(TunnelBody) -> anyhow::Result<Request<TunnelBody>>,
    body: celld::js::RequestBody,
) -> anyhow::Result<Response<PooledResponseBody>> {
    let key = format!("{}#{kind}", peer.addr);
    let replay = match &body {
        celld::js::RequestBody::Bytes(bytes) => Some(bytes.clone()),
        celld::js::RequestBody::Stream(_) => None,
    };
    let body = match body {
        celld::js::RequestBody::Bytes(bytes) => full_body(bytes),
        celld::js::RequestBody::Stream(stream_id) => {
            let payload = celld::js::take_body_stream(stream_id)
                .map_err(|error| anyhow::anyhow!("take tunnel body: {error}"))?;
            stream_body(payload)
        }
    };
    let mut body = Some(body);
    if let Some(sender) = checkout(&key) {
        match send_on_tunnel(&key, sender, build(body.take().unwrap())?).await {
            Ok(response) => {
                return Ok(response);
            }
            Err(error) => {
                let Some(bytes) = replay else {
                    return Err(error);
                };
                body = Some(full_body(bytes));
            }
        }
    }
    let sender = establish(peer, kind).await?;
    send_on_tunnel(&key, sender, build(body.take().unwrap())?).await
}

async fn send_on_tunnel(
    key: &str,
    mut sender: TunnelSender,
    request: Request<TunnelBody>,
) -> anyhow::Result<Response<PooledResponseBody>> {
    let response = sender.send_request(request).await?;
    let reusable =
        (response.status() != StatusCode::SWITCHING_PROTOCOLS).then(|| (key.to_string(), sender));
    Ok(response.map(|body| PooledResponseBody { body, reusable }))
}

/// An inner response owns its tunnel until the body finishes successfully.
/// Returning the sender at the response head makes active replies consume the
/// idle-pool bound. Sustained RPC concurrency then creates and discards one
/// upgraded TCP connection for every overflow call.
pub(crate) struct PooledResponseBody {
    body: Incoming,
    reusable: Option<(String, TunnelSender)>,
}

impl Body for PooledResponseBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        match std::pin::Pin::new(&mut self.body).poll_frame(cx) {
            std::task::Poll::Ready(None) => {
                if let Some((key, sender)) = self.reusable.take() {
                    park(&key, sender);
                }
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Ready(Some(Err(error))) => {
                // The unread or failed stream cannot carry another request.
                self.reusable.take();
                std::task::Poll::Ready(Some(Err(error)))
            }
            other => other,
        }
    }

    fn is_end_stream(&self) -> bool {
        // Force one final poll while the sender is still attached. A zero-byte
        // response can otherwise skip `poll_frame` and close a reusable tunnel.
        self.reusable.is_none() && self.body.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.body.size_hint()
    }
}

pub(crate) async fn fetch(
    peer: &Peer<'_>,
    control: &TunnelControl,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: celld::js::RequestBody,
) -> anyhow::Result<Response<PooledResponseBody>> {
    send_inner(
        peer,
        "do",
        |body| inner_request(control, &url, &method, &headers, body),
        body,
    )
    .await
}

pub(crate) const METHOD_HEADER: &str = "x-cells-rpc-method";

/// One inner request, one RPC: the method name rides a header, the
/// arguments ride the body, and the content type says which encoding the
/// caller used.
async fn serve_rpc(upgraded: hyper::upgrade::Upgraded, app: AppHandle) {
    let service = service_fn(move |inner: Request<Incoming>| {
        let app = app.clone();
        async move {
            let head = match RpcHead::parse(inner.headers()) {
                Ok(head) => head,
                Err(refusal) => return Ok::<_, Infallible>(*refusal),
            };
            let body =
                match collect_limited_body(inner.into_body(), MAX_PEER_FORWARD_BODY_BYTES).await {
                    Ok(body) => body,
                    Err(error) => {
                        return Ok(peer_response(body_read_error("tunnel RPC", error)));
                    }
                };
            let call = match head.with_body(body) {
                Ok(call) => call,
                Err(refusal) => return Ok(*refusal),
            };
            Ok(dispatch_forwarded_rpc(app, call).await)
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(upgraded, service)
        .await;
}

/// Node A: one RPC through the pooled rpc tunnel.
pub(crate) async fn rpc(
    peer: &Peer<'_>,
    scope: &str,
    name: Option<&str>,
    method: &str,
    args: &celld::js::RpcData,
    parent: Option<&celld::telemetry::TraceContext>,
    caller: &Caller,
) -> anyhow::Result<Response<PooledResponseBody>> {
    let caller = TunnelCaller::of(caller);
    let (content_type, payload) = match args {
        celld::js::RpcData::Json(json) => ("application/json", Bytes::from(json.clone())),
        celld::js::RpcData::V8(bytes) => ("application/octet-stream", bytes.clone()),
    };
    send_inner(
        peer,
        "rpc",
        |body| rpc_inner_request(scope, name, method, content_type, parent, &caller, body),
        celld::js::RequestBody::Bytes(payload),
    )
    .await
}

fn rpc_inner_request(
    scope: &str,
    name: Option<&str>,
    method: &str,
    content_type: &str,
    parent: Option<&celld::telemetry::TraceContext>,
    caller: &TunnelCaller,
    body: TunnelBody,
) -> anyhow::Result<Request<TunnelBody>> {
    let mut inner = Request::builder()
        .method("POST")
        .uri("/")
        .header(SCOPE_HEADER, scope)
        .header(METHOD_HEADER, method)
        .header(hyper::header::CONTENT_TYPE, content_type);
    if let Some(name) = name {
        inner = inner.header(NAME_HEADER, name);
    }
    if let Some(parent) = parent {
        inner = inner.header(TRACE_HEADER, celld::telemetry::traceparent(parent));
    }
    inner = caller.write(inner);
    Ok(inner.body(body)?)
}

/// The owner half of a tunneled WebSocket 101, parked until the caller's own
/// client socket finishes upgrading.
static TUNNEL_UPGRADES: std::sync::OnceLock<
    std::sync::Mutex<HashMap<u64, hyper::upgrade::OnUpgrade>>,
> = std::sync::OnceLock::new();
static NEXT_TUNNEL_UPGRADE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(crate) fn park_upgrade(upgrade: hyper::upgrade::OnUpgrade) -> u64 {
    let id = NEXT_TUNNEL_UPGRADE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    TUNNEL_UPGRADES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(id, upgrade);
    id
}

fn remove_upgrade(parked: u64) -> Option<hyper::upgrade::OnUpgrade> {
    TUNNEL_UPGRADES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(&parked)
}

/// Own one parked upgrade after its numeric id returns from JavaScript.
///
/// The id itself releases nothing. Binding it to this value makes every early
/// response exit and every cancelled executor task remove the stored upgrade.
/// A successful splice consumes the same value and takes the connection once.
pub(crate) struct TunnelUpgradeClaim {
    upgrade: hyper::upgrade::OnUpgrade,
}

pub(crate) fn claim_upgrade(parked: u64) -> anyhow::Result<TunnelUpgradeClaim> {
    let upgrade = remove_upgrade(parked)
        .ok_or_else(|| anyhow::anyhow!("tunneled upgrade {parked} is gone"))?;
    Ok(TunnelUpgradeClaim { upgrade })
}

impl TunnelUpgradeClaim {
    fn into_upgrade(self) -> hyper::upgrade::OnUpgrade {
        self.upgrade
    }
}

/// Splice the upgraded client socket to the tunneled owner: the hop stops
/// dispatching WebSocket frames and copies bytes until either side closes.
pub(crate) async fn splice<S>(client: S, parked: TunnelUpgradeClaim) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let upgrade = parked.into_upgrade();
    let inner = upgrade.await?;
    let inner = TokioIo::new(inner);
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut inner_read, mut inner_write) = tokio::io::split(inner);
    celld::asyncrt::select! {
        _ = tokio::io::copy(&mut client_read, &mut inner_write) => {
            // The client went away; the owner sees EOF through the tunnel
            // and runs its own close dispatch.
        }
        can_append_close = copy_owner_to_client(&mut inner_read, &mut client_write) => {
            // A second Close fails browser channels. An incomplete frame
            // would consume a synthetic Close as payload, so only append at
            // a frame boundary before the owner starts closing.
            if can_append_close {
                let client = client_read.unsplit(client_write);
                let mut ws = fastwebsockets::WebSocket::after_handshake(
                    client,
                    fastwebsockets::Role::Server,
                );
                let _ = ws
                    .write_frame(fastwebsockets::Frame::close(1012, b"owner unavailable"))
                    .await;
            }
        }
    }
    Ok(())
}

/// Return whether owner EOF or a read error leaves room for a failure Close.
/// A client write failure ends the splice without any further writes.
async fn copy_owner_to_client<R, W>(owner: &mut R, client: &mut W) -> bool
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut scanner = celld_logic::schedule::WebSocketCloseScanner::default();
    let mut buffer = [0u8; 8192];
    loop {
        let read = match owner.read(&mut buffer).await {
            Ok(0) | Err(_) => return scanner.can_append_close(),
            Ok(read) => read,
        };
        if client.write_all(&buffer[..read]).await.is_err() {
            return false;
        }
        scanner.observe(&buffer[..read]);
        // Flush before waiting for more owner bytes, including a peer's
        // closing-handshake response. Buffered writers must make progress.
        if client.flush().await.is_err() {
            return false;
        }
    }
}

type TunnelBody = http_body_util::combinators::UnsyncBoxBody<Bytes, std::io::Error>;

fn full_body(bytes: Bytes) -> TunnelBody {
    BodyExt::boxed_unsync(http_body_util::Full::new(bytes).map_err(|never| match never {}))
}

fn stream_body(payload: HttpChunkStream) -> TunnelBody {
    let frames = payload.map(|chunk| {
        chunk
            .map(|data| hyper::body::Frame::data(Bytes::from(data)))
            .map_err(std::io::Error::other)
    });
    BodyExt::boxed_unsync(http_body_util::StreamBody::new(frames))
}

/// The inner response body as the chunk stream the reply path already
/// speaks.
pub(crate) fn response_stream(body: PooledResponseBody) -> HttpChunkStream {
    Box::pin(
        http_body_util::BodyStream::new(body)
            .try_filter_map(|frame| async move { Ok(frame.into_data().ok()) })
            .map_ok(|data: Bytes| data.to_vec())
            .map_err(|error| error.to_string()),
    )
}

#[cfg(all(test, celld_internal_tests))]
mod private_tests {
    include!(env!("CELLD_CONFORMANCE_PEER_TUNNEL_TESTS"));
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALLER: celld::telemetry::TraceContext = celld::telemetry::TraceContext {
        trace_id: [7; 16],
        span_id: [9; 8],
        sampled: true,
        remote: false,
    };

    fn control(parent: Option<celld::telemetry::TraceContext>) -> TunnelControl {
        TunnelControl {
            scope: "Object:00".to_string(),
            name: None,
            request_id: None,
            capacity_handoff: false,
            parent,
            caller: TunnelCaller::Host,
        }
    }

    fn arrived(request: &Request<TunnelBody>) -> celld::telemetry::TraceContext {
        trace_parent(request.headers()).expect("the trace context crosses the tunnel")
    }

    /// The ids, the sampling decision and whether the parent is remote.
    fn fields(context: celld::telemetry::TraceContext) -> ([u8; 16], [u8; 8], bool, bool) {
        (
            context.trace_id,
            context.span_id,
            context.sampled,
            context.remote,
        )
    }

    #[test]
    fn a_fetch_carries_the_callers_trace_context_as_a_remote_parent() {
        let request = inner_request(
            &control(Some(CALLER)),
            "http://object/",
            "GET",
            &[],
            full_body(Bytes::new()),
        )
        .unwrap();
        assert_eq!(
            fields(arrived(&request)),
            (CALLER.trace_id, CALLER.span_id, true, true)
        );
    }

    #[test]
    fn an_rpc_carries_the_callers_trace_context_as_a_remote_parent() {
        let unsampled = celld::telemetry::TraceContext {
            sampled: false,
            ..CALLER
        };
        let request = rpc_inner_request(
            "Object:00",
            None,
            "call",
            "application/octet-stream",
            Some(&unsampled),
            &TunnelCaller::Host,
            full_body(Bytes::new()),
        )
        .unwrap();
        assert_eq!(
            fields(arrived(&request)),
            (CALLER.trace_id, CALLER.span_id, false, true)
        );
    }

    /// The header is node A's: an application's own copy is dropped, so a
    /// Worker cannot choose the trace its callee's spans join.
    #[test]
    fn an_application_header_cannot_set_the_trace_context() {
        let forged = vec![(
            TRACE_HEADER.to_string(),
            "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01".to_string(),
        )];
        let request = inner_request(
            &control(None),
            "http://object/",
            "GET",
            &forged,
            full_body(Bytes::new()),
        )
        .unwrap();
        assert!(request.headers().get(TRACE_HEADER).is_none());
        let request = inner_request(
            &control(Some(CALLER)),
            "http://object/",
            "GET",
            &forged,
            full_body(Bytes::new()),
        )
        .unwrap();
        assert_eq!(request.headers().get_all(TRACE_HEADER).iter().count(), 1);
        assert_eq!(arrived(&request).trace_id, CALLER.trace_id);
    }

    /// Node B hands node A's context to the fetch it dispatches, and keeps
    /// the control header from the application.
    #[test]
    fn node_b_dispatches_a_fetch_under_the_callers_context() {
        let request = inner_request(
            &control(Some(CALLER)),
            "http://object/",
            "GET",
            &[("x-app".to_string(), "kept".to_string())],
            full_body(Bytes::new()),
        )
        .unwrap();
        let headers = application_headers(request.headers());
        assert!(headers.iter().all(|(name, _)| name != TRACE_HEADER));
        assert!(headers.contains(&("x-app".to_string(), "kept".to_string())));
        let (scope, fetch) = tunnel_control(request.headers())
            .expect("a well-formed control")
            .into_fetch("http://object/".to_string(), "GET".to_string(), headers);
        assert_eq!(scope, "Object:00");
        assert_eq!(
            fields(fetch.parent.expect("the parent reaches dispatch")),
            (CALLER.trace_id, CALLER.span_id, true, true)
        );
    }

    #[test]
    fn node_b_dispatches_an_rpc_under_the_callers_context() {
        let request = rpc_inner_request(
            "Object:00",
            Some("name"),
            "call",
            "application/octet-stream",
            Some(&CALLER),
            &TunnelCaller::Host,
            full_body(Bytes::new()),
        )
        .unwrap();
        let Ok(head) = RpcHead::parse(request.headers()) else {
            panic!("a well-formed RPC head");
        };
        let Ok(call) = head.with_body(Bytes::from_static(b"args")) else {
            panic!("structured arguments");
        };
        assert_eq!(
            (
                call.scope.as_str(),
                call.name.as_deref(),
                call.method.as_str()
            ),
            ("Object:00", Some("name"), "call")
        );
        assert_eq!(
            fields(call.parent.expect("the parent reaches dispatch")),
            (CALLER.trace_id, CALLER.span_id, true, true)
        );
    }

    fn script_caller() -> TunnelCaller {
        TunnelCaller::Script {
            script: "app".to_string(),
            event: Some(format!("Own:{}", "ab".repeat(32))),
        }
    }

    /// A script's call names the script and its event to node B, on a fetch
    /// and on an RPC, and an application header cannot name another caller.
    #[test]
    fn the_caller_crosses_the_tunnel() {
        let forged = vec![
            (CALLER_HEADER.to_string(), "host".to_string()),
            (CALLER_EVENT_HEADER.to_string(), "Other:00".to_string()),
        ];
        let control = TunnelControl {
            caller: script_caller(),
            ..control(None)
        };
        let request = inner_request(
            &control,
            "http://object/",
            "GET",
            &forged,
            full_body(Bytes::new()),
        )
        .unwrap();
        assert_eq!(request.headers().get_all(CALLER_HEADER).iter().count(), 1);
        assert!(application_headers(request.headers())
            .iter()
            .all(|(name, _)| name != CALLER_HEADER && name != CALLER_EVENT_HEADER));
        let Ok(arrived) = tunnel_control(request.headers()) else {
            panic!("a well-formed control");
        };
        assert_eq!(arrived.caller, script_caller());

        for caller in [TunnelCaller::Host, script_caller()] {
            let request = rpc_inner_request(
                "Object:00",
                None,
                "call",
                "application/octet-stream",
                None,
                &caller,
                full_body(Bytes::new()),
            )
            .unwrap();
            let Ok(head) = RpcHead::parse(request.headers()) else {
                panic!("a well-formed RPC head");
            };
            assert_eq!(head.caller, caller);
        }
    }

    /// An inner request that names no caller comes from a peer of another
    /// version, and node B refuses it rather than guessing who sent it.
    #[test]
    fn a_call_that_names_no_caller_is_refused() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(SCOPE_HEADER, "Object:00".parse().unwrap());
        headers.insert(METHOD_HEADER, "call".parse().unwrap());
        assert!(tunnel_control(&headers).is_err());
        assert!(RpcHead::parse(&headers).is_err());
        headers.insert(CALLER_HEADER, "someone".parse().unwrap());
        assert!(tunnel_control(&headers).is_err());
        headers.insert(CALLER_HEADER, "host".parse().unwrap());
        assert!(tunnel_control(&headers).is_ok());
        assert!(RpcHead::parse(&headers).is_ok());
    }

    /// Node B checks a forwarded call against the grant its own deployment
    /// gives the caller's script: a cell outside it, or any cell for a script
    /// it does not deploy, is refused; the host reaches any cell.
    #[test]
    fn node_b_refuses_a_cell_outside_the_callers_grant() {
        let do_classes = ["Own".to_string()];
        let grant = Arc::new(celld::scope_grant::ScopeGrant::new(
            celld::scope_grant::GrantSource {
                script: "app",
                do_classes: &do_classes,
                kv_namespaces: Vec::new(),
                queues: Vec::new(),
                d1_databases: Vec::new(),
            },
        ));
        let own = format!("Own:{}", "cd".repeat(32));
        let other = format!("Other:{}", "cd".repeat(32));
        let known = |script: &str| (script == "app").then(|| grant.clone());
        let caller = script_caller().resolve(known);
        assert!(caller.admit(&own).is_ok());
        let refusal = caller.admit(&other).unwrap_err().to_string();
        assert_eq!(refusal, celld::scope_grant::refusal("app", &other));
        let unknown = TunnelCaller::Script {
            script: "__loader:7".to_string(),
            event: None,
        }
        .resolve(known);
        assert!(unknown.admit(&own).is_err());
        assert!(TunnelCaller::Host.resolve(known).admit(&other).is_ok());
    }

    /// A Queue cell's dead-letter transfer to a Queue cell on node B names the
    /// runtime cells as its caller: B gives it the runtime cells' grant, which
    /// reaches the catalog's Queue cells from a Queue cell's event, and lets
    /// it call their internal methods. A script's call does neither.
    #[test]
    fn node_b_admits_the_runtime_cells_relay_only() {
        let runtime = Arc::new(celld::scope_grant::ScopeGrant::runtime_cells([(
            "jobs",
            Some("jobs-dlq"),
        )]));
        let known =
            |script: &str| (script == celld::deploy::RUNTIME_SCRIPT).then(|| runtime.clone());
        let queue = celld::engine_api::queue_cell_scope("jobs");
        let dlq = celld::engine_api::queue_cell_scope("jobs-dlq");
        let relay = TunnelCaller::Script {
            script: celld::deploy::RUNTIME_SCRIPT.to_string(),
            event: Some(queue.clone()),
        }
        .resolve(known);
        assert!(relay.admit(&dlq).is_ok());
        assert!(relay.internal());
        assert!(relay.admit_fetch(&dlq).is_err());
        let outside_event = TunnelCaller::Script {
            script: celld::deploy::RUNTIME_SCRIPT.to_string(),
            event: None,
        }
        .resolve(known);
        assert!(outside_event.admit(&dlq).is_err());
        let script = script_caller().resolve(known);
        assert!(script.admit(&dlq).is_err());
        assert!(!script.internal());
    }

    #[test]
    fn a_malformed_trace_context_is_ignored() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(TRACE_HEADER, "not a traceparent".parse().unwrap());
        assert!(trace_parent(&headers).is_none());
    }
}
