//! Outbound TCP host ops for `cloudflare:sockets` `connect()`.
//!
//! A socket is a split tokio stream in a process-global registry: the
//! read and write halves live behind separate async mutexes so a
//! pending read never blocks a write. `startTls()` takes both halves
//! back, reunites them, runs the rustls handshake, and registers the
//! upgraded stream under a new id — the old id is gone, which is what
//! makes the old Socket's streams fail instead of leaking plaintext.
//!
//! A socket is an I/O object of the code that opened it, as in workerd: a
//! request, or a Durable Object (or facet), whose every event may use it.
//! The id is a counter, so it grants nothing: the registry records the
//! owner when the id is allocated, from the running event, and every op
//! refuses another owner's socket with workerd's cross-request (or
//! cross-object) error. A request's sockets close when it retires; an
//! object's live with its residency and close when the cell is given back
//! ([`release_cell`]).
//!
//! Every op is an `asyncrt` promise. The ops do their own tokio I/O
//! instead of going through a connector task: a TCP socket never outlives
//! its owner, so nothing has to survive the request driver.

use super::*;
use crate::ws_registry::WsOwner;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;

trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}

type Duplex = Box<dyn Stream>;
type ReadHalf = tokio::io::ReadHalf<Duplex>;
type WriteHalf = tokio::io::WriteHalf<Duplex>;
type Half<T> = Arc<tokio::sync::Mutex<Option<T>>>;

/// The refusal of every op on a socket that is gone.
const SOCKET_CLOSED: &str = "socket is closed";

/// How many sockets one request or Durable Object may hold open at once
/// (`CELLD_MAX_TCP_SOCKETS`, validated at startup).
const DEFAULT_MAX_TCP_SOCKETS: usize = 32;

fn max_sockets() -> usize {
    static MAX: OnceLock<usize> = OnceLock::new();
    *MAX.get_or_init(|| {
        crate::env_vars::positive_or("CELLD_MAX_TCP_SOCKETS", DEFAULT_MAX_TCP_SOCKETS)
            .unwrap_or(DEFAULT_MAX_TCP_SOCKETS)
    })
}

/// One socket id. It is registered, with its owner, when the id is
/// allocated; the halves are empty until the connection (or the TLS
/// handshake) completes.
struct TcpSocket {
    owner: WsOwner,
    read: Half<ReadHalf>,
    write: Half<WriteHalf>,
    /// Dropped with the entry. Every op on the socket waits on a receiver
    /// beside its I/O and ends when it goes, so an op in flight (a read
    /// parked on a silent peer, a handshake) gives the halves back and the
    /// connection closes at once.
    _closing: tokio::sync::watch::Sender<()>,
}

impl TcpSocket {
    fn closed(&self) -> tokio::sync::watch::Receiver<()> {
        self._closing.subscribe()
    }
}

/// `work`, unless the socket `closed` belongs to closes first.
async fn until_closed<T>(
    mut closed: tokio::sync::watch::Receiver<()>,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    crate::asyncrt::select_biased! {
        "a socket that closed ends its op even when its I/O is ready too";
        // Nothing is ever sent: this answers only when the sender drops.
        _ = closed.changed() => Err(SOCKET_CLOSED.to_string()),
        result = work => result,
    }
}

/// Frees a socket id unless the op that allocated it attached a stream: a
/// failed connect or handshake, or a cancelled op, leaves nothing behind.
struct Unattached(Option<u64>);

impl Unattached {
    fn attached(mut self) {
        self.0 = None;
    }
}

impl Drop for Unattached {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            free(id);
        }
    }
}

fn registry() -> &'static Mutex<HashMap<u64, TcpSocket>> {
    static SOCKETS: OnceLock<Mutex<HashMap<u64, TcpSocket>>> = OnceLock::new();
    SOCKETS.get_or_init(Default::default)
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// workerd's I/O type for the half of a socket an op reaches: its
/// writable's sink for writes and shutdowns, its readable's source for the
/// rest (`startTls()` and `close()` detach the readable first).
#[derive(Clone, Copy, Debug)]
enum IoType {
    Writable,
    ReadableStreamSource,
}

/// What the running code may do with a socket id.
enum TcpAccess<T> {
    /// The running code owns the socket; the half the op asked for.
    Owned(T),
    /// The id names no open socket: it closed, or it was never allocated.
    /// The op answers as for a closed socket.
    Unknown,
    /// Another request or Durable Object owns the socket. `object` when a
    /// Durable Object owns it and one is asking.
    Other { object: bool },
}

fn access<T>(id: u64, owner: &WsOwner, half: impl FnOnce(&TcpSocket) -> T) -> TcpAccess<T> {
    match registry().lock().unwrap().get(&id) {
        None => TcpAccess::Unknown,
        Some(socket) if socket.owner == *owner => TcpAccess::Owned(half(socket)),
        Some(socket) => TcpAccess::Other {
            object: matches!(owner, WsOwner::Cell(_)) && matches!(socket.owner, WsOwner::Cell(_)),
        },
    }
}

/// The half of socket `id` that the running code may use, `None` for an id
/// that names no open socket, or workerd's error for another owner's.
fn owned_half<T>(
    scope: &mut v8::PinScope,
    id: u64,
    io: IoType,
    half: impl FnOnce(&TcpSocket) -> T,
) -> Result<Option<T>, String> {
    let owner = websocket::owner_of(&event_context(scope));
    match access(id, &owner, half) {
        TcpAccess::Owned(half) => Ok(Some(half)),
        TcpAccess::Unknown => Ok(None),
        TcpAccess::Other { object } => Err(crate::ws_registry::foreign_io_error(
            object,
            &format!("{io:?}"),
        )),
    }
}

/// How many sockets `owner` holds open now.
#[cfg(test)]
fn owner_count(owner: &WsOwner) -> usize {
    registry()
        .lock()
        .unwrap()
        .values()
        .filter(|socket| socket.owner == *owner)
        .count()
}

/// The refusal for an owner still at the cap after a sweep. A refusal means
/// that many sockets are still reachable.
fn cap_refusal(owner: &WsOwner) -> String {
    let holder = match owner {
        WsOwner::Request(_) => "request",
        WsOwner::Cell(_) => "Durable Object",
    };
    format!(
        "celld refused connect(): this {holder} already holds {} open TCP sockets, \
         the most CELLD_MAX_TCP_SOCKETS allows. Close one first.",
        max_sockets()
    )
}

/// How long connects at the cap share one forced collection, and how long
/// each waits for the slots it frees before it is refused.
const SWEEP_WINDOW: std::time::Duration = std::time::Duration::from_millis(100);

/// When this isolate last forced a collection for the cap (an isolate slot).
#[derive(Default)]
struct CapSweep {
    last: Option<std::time::Instant>,
}

#[cfg(test)]
static FORCED_SWEEPS: AtomicU64 = AtomicU64::new(0);

/// A connect found its owner at the cap. The cap counts reachable sockets,
/// but a `Socket` the script dropped closes only once V8 collects it and its
/// FinalizationRegistry runs (`__tcp_collect`, at the end of the turn), so a
/// connect-and-drop loop would be refused on dead sockets. Force a full
/// collection at most once per [`SWEEP_WINDOW`] per isolate: a burst at the
/// cap shares one sweep. `low_memory_notification`, because it is the call
/// that reliably collects the dropped sockets so their finalizers run: a
/// critical memory-pressure notification, which would keep the compilation
/// cache, left them uncollected (`sockets/socket-cap`'s connect-and-drop
/// step was refused), and a plain full GC needs `--expose-gc`.
/// Answers whether it collected now.
fn sweep_for_cap(scope: &mut v8::PinScope) -> bool {
    let now = std::time::Instant::now();
    if scope.get_slot::<CapSweep>().is_none() {
        scope.set_slot(CapSweep::default());
    }
    let sweep = scope.get_slot_mut::<CapSweep>().unwrap();
    if sweep
        .last
        .is_some_and(|last| now.duration_since(last) < SWEEP_WINDOW)
    {
        return false;
    }
    sweep.last = Some(now);
    #[cfg(test)]
    FORCED_SWEEPS.fetch_add(1, Ordering::Relaxed);
    scope.low_memory_notification();
    true
}

/// What a first connect at the cap answers when the window allowed no sweep
/// of its own and the earlier sweep freed nothing for it: the harness calls
/// `__tcp_connect` once more, in a later turn, when a sweep is due again.
/// Never reaches a script: the retry answers with the refusal instead.
const SWEEP_AGAIN: &str = "celld: sweep again";

/// Wait for the sweep to free a slot, taking it under the registry lock as
/// [`try_reserve`] does, so only as many waiters proceed as slots came free;
/// refused if the owner is still at the cap when the window has passed --
/// or, for a first attempt that shared an earlier sweep (`again`), answered
/// [`SWEEP_AGAIN`] so the harness retries once with a sweep of its own.
async fn reserve_after_sweep(context: &IoContext, again: bool) -> Result<Reserved, String> {
    let deadline = tokio::time::Instant::now() + SWEEP_WINDOW;
    loop {
        if let Some(reserved) = try_reserve(context) {
            return Ok(reserved);
        }
        if tokio::time::Instant::now() >= deadline {
            if again {
                return Err(SWEEP_AGAIN.to_string());
            }
            return Err(cap_refusal(&websocket::owner_of(context)));
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

type Reserved = (u64, tokio::sync::watch::Receiver<()>);

/// Reserve an id for a new connection of the running code's owner, unless
/// it already holds [`max_sockets`]. Counted and inserted under one registry
/// lock, so connects in one turn, or waiters for a sweep, can never take
/// more slots than are free.
fn try_reserve(context: &IoContext) -> Option<Reserved> {
    let owner = websocket::owner_of(context);
    let mut registry = registry().lock().unwrap();
    let held = registry
        .values()
        .filter(|socket| socket.owner == owner)
        .count();
    (held < max_sockets()).then(|| insert(&mut registry, context, owner))
}

/// Allocate an id that the running code owns, with the receiver that tells
/// its op the socket closed, whatever the owner holds: the socket
/// `startTls()` makes replaces one.
fn allocate(context: &IoContext) -> Reserved {
    let owner = websocket::owner_of(context);
    insert(&mut registry().lock().unwrap(), context, owner)
}

/// Register a new id for `owner`. A request's ids are tracked on its
/// context, which closes them when it retires; an object's live until the
/// `Socket` is collected or its cell is released.
fn insert(registry: &mut HashMap<u64, TcpSocket>, context: &IoContext, owner: WsOwner) -> Reserved {
    let id = next_id();
    if matches!(owner, WsOwner::Request(_)) {
        context.tcp_sockets.lock().unwrap().push(id);
    }
    let (closing, closed) = tokio::sync::watch::channel(());
    registry.insert(
        id,
        TcpSocket {
            owner,
            read: Default::default(),
            write: Default::default(),
            _closing: closing,
        },
    );
    (id, closed)
}

/// Drop one socket's registry entry, which closes the connection. The
/// request context calls this for every socket the event opened, so an
/// abandoned socket cannot outlive its event. Idempotent.
pub(super) fn free(id: u64) {
    let removed = registry().lock().unwrap().remove(&id);
    // Closing a connection can do work; keep it out of the registry lock.
    drop(removed);
}

/// Close every socket a Durable Object or facet opened. Called on both
/// edges of the cell's residency, as its other isolate state is released,
/// so a socket never spans two epochs and an evicted object leaks none.
pub(super) fn release_cell(cell: &str) {
    let released: Vec<TcpSocket> = {
        let mut registry = registry().lock().unwrap();
        let ids: Vec<u64> = registry
            .iter()
            .filter(|(_, socket)| matches!(&socket.owner, WsOwner::Cell(owner) if owner == cell))
            .map(|(id, _)| *id)
            .collect();
        ids.iter().filter_map(|id| registry.remove(id)).collect()
    };
    // Closing a connection can do work; keep it out of the registry lock.
    drop(released);
}

/// Put the connected `stream` behind socket `id`. An id that was freed
/// while it connected (its owner retired or was released) drops the
/// stream, which closes it.
async fn attach(id: u64, stream: Duplex) -> Result<(), String> {
    let halves = registry()
        .lock()
        .unwrap()
        .get(&id)
        .map(|socket| (socket.read.clone(), socket.write.clone()));
    let (read_slot, write_slot) = halves.ok_or(SOCKET_CLOSED)?;
    let (read, write) = tokio::io::split(stream);
    *read_slot.lock().await = Some(read);
    *write_slot.lock().await = Some(write);
    Ok(())
}

/// Mozilla's roots, the same choice `ws_client` makes and for the same
/// reason: a downloaded celld must reach TLS hosts on a machine with no
/// `/etc/ssl/certs`. Test TLS servers use a root injected through the
/// gated seam below.
#[cfg(celld_internal_tests)]
fn test_root() -> &'static Mutex<Option<Vec<u8>>> {
    static ROOT: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
    ROOT.get_or_init(Default::default)
}

/// Trust one extra DER root for outbound TLS, so test servers with
/// self-signed certificates verify. No compatibility guarantee.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn test_extra_tls_root(der: Vec<u8>) {
    *test_root().lock().unwrap() = Some(der);
}

// Rebuilt per handshake only under the internal-tests cfg, where the
// injected root must be visible; production caches the connector.
#[cfg(celld_internal_tests)]
fn tls_connector() -> tokio_rustls::TlsConnector {
    build_tls_connector(test_root().lock().unwrap().clone())
}

#[cfg(not(celld_internal_tests))]
fn tls_connector() -> tokio_rustls::TlsConnector {
    static CONNECTOR: OnceLock<tokio_rustls::TlsConnector> = OnceLock::new();
    CONNECTOR.get_or_init(|| build_tls_connector(None)).clone()
}

fn build_tls_connector(extra_root: Option<Vec<u8>>) -> tokio_rustls::TlsConnector {
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    if let Some(der) = extra_root {
        let _ = roots.add(rustls::pki_types::CertificateDer::from(der));
    }
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

async fn handshake(stream: Duplex, host: String) -> Result<Duplex, String> {
    let name = rustls::pki_types::ServerName::try_from(host)
        .map_err(|error| format!("invalid TLS server name: {error}"))?;
    let tls = tls_connector()
        .connect(name, stream)
        .await
        .map_err(|error| format!("TLS handshake failed: {error}"))?;
    Ok(Box::new(tls))
}

#[derive(serde::Deserialize)]
struct ConnectArgs {
    hostname: String,
    port: u16,
    secure: bool,
    #[serde(default)]
    expected_host: Option<String>,
}

pub(super) fn op_tcp_connect(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    match &actor_runtime_state(scope).egress {
        EgressPolicy::Allow => {}
        EgressPolicy::Deny => {
            return loader_throw(
                scope,
                "This worker is not permitted to access the internet via global functions.",
            );
        }
        // A Fetcher is still an authority boundary for sockets. celld's
        // service protocol has no bidirectional CONNECT tunnel, so refusing is
        // required: a direct TcpStream here would silently bypass the broker.
        EgressPolicy::Broker(_) => {
            return loader_throw(
                scope,
                "A globalOutbound Fetcher cannot broker connect() in celld.",
            );
        }
    }
    let raw = args.get(0).to_rust_string_lossy(scope);
    let request: ConnectArgs = match serde_json::from_str(&raw) {
        Ok(request) => request,
        Err(error) => return loader_throw(scope, &format!("connect(): {error}")),
    };
    let context = event_context(scope);
    // The id exists before the connection does, so its owner holds the
    // socket even if the event ends mid-connect. At the cap, a sweep may free
    // the slots of sockets the script dropped; the connect waits for it.
    // `retry`: the harness's second attempt after `SWEEP_AGAIN`.
    let retry = args.get(1).is_true();
    let reserved = try_reserve(&context);
    let again = reserved.is_none() && !sweep_for_cap(scope) && !retry;
    let gate = egress_gate_request(&context, celld_logic::Channel::Tcp);
    let async_id = asyncrt::enqueue(async move {
        let (id, closed) = match reserved {
            Some(reserved) => reserved,
            None => reserve_after_sweep(&context, again).await?,
        };
        let unattached = Unattached(Some(id));
        until_closed(closed, async move {
            await_egress_gate(gate).await?;
            // Any address the node can reach, except its own internal listener.
            let stream = crate::public_egress::connect_socket(&request.hostname, request.port)
                .await
                .map_err(|error| match error {
                    crate::public_egress::ConnectError::Refused(refused) => refused.to_string(),
                    crate::public_egress::ConnectError::Io(error) => format!(
                        "connection to {}:{} failed: {error}",
                        request.hostname, request.port
                    ),
                })?;
            let remote = stream.peer_addr().map(|a| a.to_string()).ok();
            let local = stream.local_addr().map(|a| a.to_string()).ok();
            let mut stream: Duplex = Box::new(stream);
            if request.secure {
                let host = request.expected_host.unwrap_or(request.hostname);
                stream = handshake(stream, host).await?;
            }
            attach(id, stream).await?;
            unattached.attached();
            Ok::<String, String>(
                serde_json::json!({
                    "id": id,
                    "remoteAddress": remote,
                    "localAddress": local,
                })
                .to_string(),
            )
        })
        .await
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_tcp_read(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let held = match owned_half(scope, id, IoType::ReadableStreamSource, |s| {
        (s.read.clone(), s.closed())
    }) {
        Ok(held) => held,
        Err(error) => return loader_throw(scope, &error),
    };
    let async_id = asyncrt::enqueue(async move {
        let (half, closed) = held.ok_or(SOCKET_CLOSED)?;
        until_closed(closed, async move {
            let mut guard = half.lock().await;
            let read = guard.as_mut().ok_or(SOCKET_CLOSED)?;
            let mut buffer = vec![0u8; 16 * 1024];
            let n = read
                .read(&mut buffer)
                .await
                .map_err(|error| format!("read failed: {error}"))?;
            buffer.truncate(n);
            Ok::<Vec<u8>, String>(buffer)
        })
        .await
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_tcp_write(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let Some(bytes) = view_bytes(args.get(1)) else {
        return loader_throw(scope, "socket write needs bytes");
    };
    let held = match owned_half(scope, id, IoType::Writable, |s| {
        (s.write.clone(), s.closed())
    }) {
        Ok(held) => held,
        Err(error) => return loader_throw(scope, &error),
    };
    let gate = egress_gate_request(&event_context(scope), celld_logic::Channel::Tcp);
    let async_id = asyncrt::enqueue(async move {
        let (half, closed) = held.ok_or(SOCKET_CLOSED)?;
        until_closed(closed, async move {
            await_egress_gate(gate).await?;
            let mut guard = half.lock().await;
            let write = guard.as_mut().ok_or(SOCKET_CLOSED)?;
            write
                .write_all(&bytes)
                .await
                .map_err(|error| format!("write failed: {error}"))?;
            write
                .flush()
                .await
                .map_err(|error| format!("flush failed: {error}"))?;
            Ok::<String, String>(String::new())
        })
        .await
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_tcp_shutdown(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let held = match owned_half(scope, id, IoType::Writable, |s| {
        (s.write.clone(), s.closed())
    }) {
        Ok(held) => held,
        Err(error) => return loader_throw(scope, &error),
    };
    let gate = egress_gate_request(&event_context(scope), celld_logic::Channel::Tcp);
    let async_id = asyncrt::enqueue(async move {
        let (half, closed) = held.ok_or(SOCKET_CLOSED)?;
        until_closed(closed, async move {
            await_egress_gate(gate).await?;
            let mut guard = half.lock().await;
            let write = guard.as_mut().ok_or(SOCKET_CLOSED)?;
            write
                .shutdown()
                .await
                .map_err(|error| format!("shutdown failed: {error}"))?;
            Ok::<String, String>(String::new())
        })
        .await
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_tcp_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    match owned_half(scope, id, IoType::ReadableStreamSource, |_| ()) {
        Ok(Some(())) => free(id),
        Ok(None) => {}
        Err(error) => loader_throw(scope, &error),
    }
}

/// `__tcp_collect(id)`: close the socket of a `Socket` the isolate
/// collected, as workerd closes an unreferenced socket. The harness calls
/// it only from the FinalizationRegistry that holds each open socket's id,
/// which runs in no event of the owner's, so no owner is checked: the id
/// comes from a registry a script cannot reach, and names a socket no
/// object refers to any more.
pub(super) fn op_tcp_collect(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    free(args.get(0).integer_value(scope).unwrap_or(0) as u64);
}

#[derive(serde::Deserialize)]
struct StartTlsArgs {
    id: u64,
    host: String,
}

pub(super) fn op_tcp_starttls(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let raw = args.get(0).to_rust_string_lossy(scope);
    let request: StartTlsArgs = match serde_json::from_str(&raw) {
        Ok(request) => request,
        Err(error) => return loader_throw(scope, &format!("startTls(): {error}")),
    };
    // Refused before anything is consumed: another owner's socket stays
    // whole. An unknown id fails below, as a closed socket does.
    let plaintext = match owned_half(scope, request.id, IoType::ReadableStreamSource, |s| {
        s.closed()
    }) {
        Ok(plaintext) => plaintext,
        Err(error) => return loader_throw(scope, &error),
    };
    let context = event_context(scope);
    let (new_id, closed) = allocate(&context);
    let unattached = Unattached(Some(new_id));
    let gate = egress_gate_request(&context, celld_logic::Channel::Tcp);
    let async_id = asyncrt::enqueue(until_closed(closed, async move {
        let plaintext = plaintext.ok_or(SOCKET_CLOSED)?;
        // The plaintext socket remains registered while the gate waits so the
        // event cleanup can close it. Consume it only when the TLS handshake can
        // start, and make every later operation on the old id fail.
        until_closed(plaintext, await_egress_gate(gate)).await?;
        let taken = registry().lock().unwrap().remove(&request.id);
        let socket = taken.ok_or(SOCKET_CLOSED)?;
        let read = socket.read.lock().await.take().ok_or(SOCKET_CLOSED)?;
        let write = socket.write.lock().await.take().ok_or(SOCKET_CLOSED)?;
        let stream = read.unsplit(write);
        let stream = handshake(stream, request.host).await?;
        attach(new_id, stream).await?;
        unattached.attached();
        Ok::<String, String>(serde_json::json!({ "id": new_id }).to_string())
    }));
    rv.set(promise_for(scope, async_id));
}

#[cfg(test)]
mod tests {
    use super::super::cell_event_context_for_test as cell_context;
    use super::*;
    use crate::ws_registry::foreign_io_error;

    /// Register a connected socket for `owner`, as `connect()` does once the
    /// connection is up. The peer end is returned so the stream stays open.
    fn register(owner: WsOwner) -> (u64, tokio::io::DuplexStream) {
        let (stream, peer) = tokio::io::duplex(64);
        let (read, write) = tokio::io::split(Box::new(stream) as Duplex);
        let id = next_id();
        registry().lock().unwrap().insert(
            id,
            TcpSocket {
                owner,
                read: Arc::new(tokio::sync::Mutex::new(Some(read))),
                write: Arc::new(tokio::sync::Mutex::new(Some(write))),
                _closing: tokio::sync::watch::channel(()).0,
            },
        );
        (id, peer)
    }

    fn connected(id: u64) -> bool {
        registry()
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|socket| socket.read.try_lock().is_ok_and(|half| half.is_some()))
    }

    #[test]
    fn a_socket_answers_only_its_owner() {
        let (request, _a) = register(WsOwner::Request(u64::MAX - 1));
        let (object, _b) = register(WsOwner::Cell("tcp-access-a".into()));
        let (other, _c) = register(WsOwner::Cell("tcp-access-b".into()));
        let owned = |id, owner: &WsOwner| matches!(access(id, owner, |_| ()), TcpAccess::Owned(()));
        let other_of = |id, owner: &WsOwner| match access(id, owner, |_| ()) {
            TcpAccess::Other { object } => Some(object),
            _ => None,
        };
        assert!(owned(request, &WsOwner::Request(u64::MAX - 1)));
        assert_eq!(
            other_of(request, &WsOwner::Request(u64::MAX - 2)),
            Some(false)
        );
        assert_eq!(
            other_of(request, &WsOwner::Cell("tcp-access-a".into())),
            Some(false)
        );
        assert!(owned(object, &WsOwner::Cell("tcp-access-a".into())));
        assert_eq!(
            other_of(object, &WsOwner::Cell("tcp-access-b".into())),
            Some(true)
        );
        assert_eq!(
            other_of(object, &WsOwner::Request(u64::MAX - 1)),
            Some(false)
        );
        assert!(matches!(
            access(u64::MAX, &WsOwner::Request(u64::MAX - 1), |_| ()),
            TcpAccess::Unknown
        ));
        // Releasing a cell closes its sockets and no other's.
        release_cell("tcp-access-a");
        assert!(matches!(
            access(object, &WsOwner::Cell("tcp-access-a".into()), |_| ()),
            TcpAccess::Unknown
        ));
        assert!(connected(request) && connected(other));
        free(request);
        free(other);
    }

    /// Freeing a socket, as retirement, a cell's release or a collected
    /// `Socket` does, ends an op still waiting on it, so the op gives the
    /// halves back and the connection closes.
    #[test]
    fn freeing_a_socket_ends_its_ops() {
        let runtime = crate::asyncrt::test_host_runtime();
        let (id, _peer) = register(WsOwner::Request(u64::MAX - 3));
        let (half, closed) = {
            let registry = registry().lock().unwrap();
            let socket = &registry[&id];
            (socket.read.clone(), socket.closed())
        };
        let read = runtime.spawn(until_closed(closed, async move {
            let mut guard = half.lock().await;
            let mut buffer = [0u8; 1];
            // The peer never writes.
            guard
                .as_mut()
                .unwrap()
                .read(&mut buffer)
                .await
                .map_err(|e| e.to_string())
        }));
        free(id);
        let answer = runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(5), read).await
        });
        assert_eq!(answer.unwrap().unwrap(), Err(SOCKET_CLOSED.to_string()));
    }

    /// An id whose connect or handshake failed, or whose op was dropped, is
    /// freed; an attached one is kept.
    #[test]
    fn an_unattached_id_is_freed() {
        let (failed, _a) = register(WsOwner::Request(u64::MAX - 4));
        drop(Unattached(Some(failed)));
        assert!(!registry().lock().unwrap().contains_key(&failed));
        let (attached, _b) = register(WsOwner::Request(u64::MAX - 4));
        Unattached(Some(attached)).attached();
        assert!(connected(attached));
        free(attached);
    }

    /// The cap is taken slot by slot under the registry lock: an owner gets
    /// exactly `max_sockets()` reservations, another owner is counted apart,
    /// and a freed slot can be reserved again.
    #[test]
    fn reservations_stop_at_the_cap() {
        let context = IoContext::new();
        let owner = websocket::owner_of(&context);
        let ids: Vec<u64> = std::iter::from_fn(|| try_reserve(&context).map(|(id, _)| id))
            .take(max_sockets() + 10)
            .collect();
        assert_eq!(ids.len(), max_sockets());
        assert_eq!(owner_count(&owner), max_sockets());
        let refused = cap_refusal(&owner);
        assert!(refused.contains(&format!("already holds {} open TCP sockets", max_sockets())));
        assert!(refused.contains("request"));
        let other = IoContext::new();
        let (theirs, _) = try_reserve(&other).unwrap();
        free(ids[0]);
        let (again, _) = try_reserve(&context).unwrap();
        assert!(try_reserve(&context).is_none());
        for id in ids[1..].iter().chain([&again, &theirs]) {
            free(*id);
        }
    }

    /// Connects waiting at the cap take only the slots that come free: two
    /// freed slots let exactly two of five waiters through, and the rest are
    /// refused when the window has passed.
    #[test]
    fn waiters_take_only_the_freed_slots() {
        let runtime = crate::asyncrt::test_host_runtime();
        let context = IoContext::new();
        let ids: Vec<u64> = std::iter::from_fn(|| try_reserve(&context).map(|(id, _)| id))
            .take(max_sockets())
            .collect();
        let waiters: Vec<_> = (0..5)
            .map(|_| {
                let context = context.clone();
                runtime.spawn(async move {
                    reserve_after_sweep(&context, false).await.map(|(id, _)| id)
                })
            })
            .collect();
        free(ids[0]);
        free(ids[1]);
        let answers: Vec<Result<u64, String>> = runtime.block_on(async {
            let mut answers = Vec::new();
            for waiter in waiters {
                answers.push(waiter.await.unwrap());
            }
            answers
        });
        let granted: Vec<u64> = answers
            .iter()
            .filter_map(|a| a.as_ref().ok().copied())
            .collect();
        assert_eq!(granted.len(), 2, "{answers:?}");
        assert!(answers
            .iter()
            .filter(|a| a.is_err())
            .all(|a| a.as_ref().unwrap_err().contains("already holds")));
        for id in ids[2..].iter().chain(&granted) {
            free(*id);
        }
    }

    #[derive(Clone, Copy)]
    enum Arg<'a> {
        Text(&'a str),
        Number(f64),
        Bytes,
    }

    /// Call `op` through V8, as a script that bypassed the harness would.
    /// Answers what it returned (a promise as its state), or what it threw.
    fn call_op(
        scope: &mut v8::PinScope,
        op: impl v8::MapFnTo<v8::FunctionCallback>,
        args: &[Arg],
    ) -> Result<String, String> {
        let tc = std::pin::pin!(v8::TryCatch::new(scope));
        let tc = &mut tc.init();
        let function = v8::Function::new(tc, op).unwrap();
        let args: Vec<v8::Local<v8::Value>> = args
            .iter()
            .map(|arg| match *arg {
                Arg::Text(text) => v8::String::new(tc, text).unwrap().into(),
                Arg::Number(number) => v8::Number::new(tc, number).into(),
                Arg::Bytes => {
                    let buffer = v8::ArrayBuffer::new(tc, 1);
                    v8::Uint8Array::new(tc, buffer, 0, 1).unwrap().into()
                }
            })
            .collect();
        let recv = v8::undefined(tc).into();
        let Some(value) = function.call(tc, recv, &args) else {
            return Err(tc
                .exception()
                .map(|error| error.to_rust_string_lossy(tc))
                .unwrap_or_default());
        };
        Ok(match value.try_cast::<v8::Promise>() {
            Ok(promise) => match promise.state() {
                v8::PromiseState::Pending => "pending".to_string(),
                v8::PromiseState::Fulfilled => "fulfilled".to_string(),
                v8::PromiseState::Rejected => "rejected".to_string(),
            },
            Err(_) => value.to_rust_string_lossy(tc),
        })
    }

    /// Every op that takes a socket id, called with `id` by the code running
    /// now: what each answered.
    fn uses(scope: &mut v8::PinScope, id: u64) -> Vec<(&'static str, Result<String, String>)> {
        let number = Arg::Number(id as f64);
        let starttls = format!(r#"{{"id":{id},"host":"example.com"}}"#);
        vec![
            (
                "Writable",
                call_op(scope, op_tcp_write, &[number, Arg::Bytes]),
            ),
            ("Writable", call_op(scope, op_tcp_shutdown, &[number])),
            (
                "ReadableStreamSource",
                call_op(scope, op_tcp_read, &[number]),
            ),
            (
                "ReadableStreamSource",
                call_op(scope, op_tcp_close, &[number]),
            ),
            (
                "ReadableStreamSource",
                call_op(scope, op_tcp_starttls, &[Arg::Text(&starttls)]),
            ),
        ]
    }

    fn worker(name: &str) -> Worker {
        let config = Arc::new(WorkerConfig::new(WorkerConfigOptions {
            src: "export default { fetch() { return new Response(); } };\n".into(),
            script_name: name.into(),
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
        Worker::load_config(config).unwrap()
    }

    /// A burst of connects at the cap forces one collection per window, not
    /// one per connect.
    #[test]
    fn a_burst_at_the_cap_forces_one_sweep() {
        let _ = crate::asyncrt::test_host_runtime();
        Engine::init();
        std::thread::spawn(|| {
            let mut isolate = worker("tcp-sweep");
            let _runtime = crate::asyncrt::test_host_runtime().enter();
            let request = IoContext::new();
            let ids: Vec<u64> = std::iter::from_fn(|| try_reserve(&request).map(|(id, _)| id))
                .take(max_sockets())
                .collect();
            let _current = CurrentGuard::enter(request.clone());
            let before = FORCED_SWEEPS.load(Ordering::Relaxed);
            isolate.with_scope_for_test(|scope| {
                let args = r#"{"hostname":"127.0.0.1","port":9,"secure":false}"#;
                for _ in 0..300 {
                    call_op(scope, op_tcp_connect, &[Arg::Text(args)]).unwrap();
                }
            });
            assert_eq!(FORCED_SWEEPS.load(Ordering::Relaxed) - before, 1);
            for id in ids {
                free(id);
            }
        })
        .join()
        .unwrap();
    }

    /// A socket id that a request or a Durable Object opened is refused, in
    /// every op, to another request in its isolate, to another object, and
    /// to a request in another isolate (a Loader child, or another script);
    /// the refusals take nothing from the owner, whose every event still
    /// reaches the socket.
    #[test]
    fn a_socket_id_is_refused_to_code_that_does_not_own_it() {
        let _ = crate::asyncrt::test_host_runtime();
        Engine::init();
        // On a thread started after V8, as `runtime::init_v8` requires.
        std::thread::spawn(|| {
            let mut parent = worker("tcp-owner-parent");
            let mut child = worker("tcp-owner-child");
            let _runtime = crate::asyncrt::test_host_runtime().enter();
            let request = IoContext::new();
            let (by_request, _a) = register(websocket::owner_of(&request));
            let (by_object, _b) = register(WsOwner::Cell("tcp-owner-cell".into()));
            let strangers = [
                (by_request, false, false, IoContext::new()),
                (by_request, false, false, cell_context("tcp-owner-cell")),
                (by_request, true, false, IoContext::new()),
                (by_object, false, false, IoContext::new()),
                (by_object, false, true, cell_context("tcp-owner-other")),
                (by_object, true, false, IoContext::new()),
            ];
            for (id, in_child, object, stranger) in strangers {
                let isolate = if in_child { &mut child } else { &mut parent };
                let _current = CurrentGuard::enter(stranger);
                for (io, answer) in isolate.with_scope_for_test(|scope| uses(scope, id)) {
                    let refusal = answer.unwrap_err();
                    assert!(refusal.contains(&foreign_io_error(object, io)), "{refusal}");
                }
                assert!(connected(id));
            }
            // A collected Socket's id closes from any event: the harness
            // takes it only from its own FinalizationRegistry.
            let (collected, _c) = register(websocket::owner_of(&request));
            {
                let _current = CurrentGuard::enter(cell_context("tcp-owner-other"));
                parent.with_scope_for_test(|scope| {
                    call_op(scope, op_tcp_collect, &[Arg::Number(collected as f64)]).unwrap();
                });
            }
            assert!(!registry().lock().unwrap().contains_key(&collected));
            // The owners still reach their sockets: a read waits for bytes,
            // in any event of the object, and a close frees the socket.
            for (id, owner) in [
                (by_request, request.clone()),
                (by_object, cell_context("tcp-owner-cell")),
            ] {
                let _current = CurrentGuard::enter(owner);
                parent.with_scope_for_test(|scope| {
                    let number = Arg::Number(id as f64);
                    assert_eq!(
                        call_op(scope, op_tcp_read, &[number]).as_deref(),
                        Ok("pending")
                    );
                    call_op(scope, op_tcp_close, &[number]).unwrap();
                });
                assert!(matches!(
                    access(id, &WsOwner::Request(0), |_| ()),
                    TcpAccess::Unknown
                ));
            }
        })
        .join()
        .unwrap();
    }
}
