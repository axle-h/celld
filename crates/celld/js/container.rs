//! Host ops behind `ctx.container`.
//!
//! JavaScript owns the surface and every validation message, copied from
//! workerd's `api/container.c++`; these ops perform the effects through
//! `crate::container`. Every op acts on the container of the Durable Object
//! whose event is running, which the host takes from that event, as the
//! WebSocket ops take their owner: a scope from JavaScript would reach
//! another object's container, its address and its exemption from the
//! egress policy.
//!
//! A `Container`, its ports and its processes are I/O objects of the object
//! that made them, as in workerd. Each op takes that object's scope as
//! `owner` and refuses with workerd's cross-object (or, outside any Durable
//! Object event, cross-request) I/O error unless the running event is that
//! object's. The owner is only compared, never used to find a container. An
//! exec process is addressed by the id `__container_exec` returned, and only
//! the container that started it answers for that id.

use super::*;
use crate::container::{self, CellContainer, ContainerEngine, ExecParams, StartParams};
use std::time::Duration;

/// workerd's text for an I/O object used during another Durable Object's
/// event (`IoContext::throwNotCurrentJsError`).
const CROSS_OBJECT_IO: &str = "Cannot perform I/O on behalf of a different Durable Object. I/O \
     objects (such as streams, request/response bodies, and others) created in the context of \
     one Durable Object cannot be accessed from a different Durable Object in the same isolate. \
     This is a limitation of Cloudflare Workers which allows us to improve overall performance.";

/// The same, for a use outside any Durable Object event.
const CROSS_REQUEST_IO: &str = "Cannot perform I/O on behalf of a different request. I/O \
     objects (such as streams, request/response bodies, and others) created in the context of \
     one request handler cannot be accessed from a different request's handler. This is a \
     limitation of Cloudflare Workers which allows us to improve overall performance.";

/// The refusal for a running object that has no container on this node.
const NO_CONTAINER: &str = "this Durable Object has no container";

/// The I/O object of workerd's `Container` that an operation reaches
/// first, which workerd's error names: the exit monitor for the lifecycle
/// operations, the container's or the process's RPC client, and the
/// Fetcher factory of a `getTcpPort()` port.
#[derive(Clone, Copy, Debug)]
enum IoType {
    Monitor,
    Client,
    OutgoingFactory,
}

/// workerd's error for an I/O object of another object or request.
fn foreign_io(in_cell_event: bool, io: IoType) -> String {
    let text = if in_cell_event {
        CROSS_OBJECT_IO
    } else {
        CROSS_REQUEST_IO
    };
    format!("{text} (I/O type: {io:?})")
}

/// The scope of the Durable Object (or facet) whose event `context` runs.
fn cell_of(context: &IoContext) -> Option<String> {
    current_cell_event(context).map(|frame| frame.storage)
}

/// Why an op cannot act on a container. Both throw an `Error`.
pub(super) enum Refusal {
    /// The object belongs to another object or request: workerd's text.
    Foreign(String),
    Container(String),
}

impl Refusal {
    pub(super) fn throw(&self, scope: &mut v8::PinScope) {
        match self {
            Refusal::Foreign(message) | Refusal::Container(message) => loader_throw(scope, message),
        }
    }
}

/// A container and the engine that runs it.
type Running = (Arc<ContainerEngine>, Arc<CellContainer>);

/// The container of the running object, which must be `owner`. `Ok(None)`
/// when it has no container here: the engine connected when the cell of a
/// container class started, so an engine that is not ready means this
/// object has no container.
fn owned_container(
    scope: &mut v8::PinScope,
    owner: v8::Local<v8::Value>,
    io: IoType,
) -> Result<Option<Running>, Refusal> {
    let Some(cell) = cell_of(&event_context(scope)) else {
        return Err(Refusal::Foreign(foreign_io(false, io)));
    };
    if !owner.is_string() || owner.to_rust_string_lossy(scope) != cell {
        return Err(Refusal::Foreign(foreign_io(true, io)));
    }
    Ok(container::engine_if_ready()
        .and_then(|engine| engine.cell(&cell).map(|cell| (engine, cell))))
}

/// `owned_container` on the op's first argument, throwing its refusal.
/// `None` once it has thrown.
fn container_or_throw(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    io: IoType,
) -> Option<Option<Running>> {
    match owned_container(scope, args.get(0), io) {
        Ok(container) => Some(container),
        Err(refusal) => {
            refusal.throw(scope);
            None
        }
    }
}

fn string_arg(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    index: i32,
) -> String {
    args.get(index).to_rust_string_lossy(scope)
}

fn number_arg(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, index: i32) -> u64 {
    args.get(index).integer_value(scope).unwrap_or(0).max(0) as u64
}

/// A port number the harness passed, or the refusal for anything else.
fn port_arg(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<u16, Refusal> {
    value
        .number_value(scope)
        .filter(|port| value.is_number() && port.fract() == 0.0 && (1.0..=65535.0).contains(port))
        .map(|port| port as u16)
        .ok_or_else(|| Refusal::Container("the container port is not a port number".to_string()))
}

/// The address of `port` on a container.
fn port_address(container: Option<Running>, port: u16) -> Result<String, Refusal> {
    let (_, cell) = container.ok_or_else(|| Refusal::Container(NO_CONTAINER.to_string()))?;
    cell.address(port).map_err(Refusal::Container)
}

/// `running`, for its owner only.
pub(super) fn op_container_running(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Monitor) else {
        return;
    };
    let running = container.is_some_and(|(_, cell)| cell.running());
    rv.set(v8::Boolean::new(scope, running).into());
}

/// `getTcpPort()`: only the owner may make a port.
pub(super) fn op_container_port(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    container_or_throw(scope, &args, IoType::Client);
}

/// The address a `getTcpPort()` request may reach past the egress policy,
/// from the port number the port's `fetch()` passes; `None` for any other
/// request. The port's `fetch()` has checked its owner with
/// `__container_address` already. The host looks the address up on the
/// running object's own container, so a request can name only a port of
/// that container, never an address of its choosing or another object's
/// container.
pub(super) fn port_address_arg(
    scope: &mut v8::PinScope,
    value: v8::Local<v8::Value>,
) -> Result<Option<std::net::SocketAddr>, Refusal> {
    if value.is_undefined() {
        return Ok(None);
    }
    let Some(cell) = cell_of(&event_context(scope)) else {
        return Err(Refusal::Foreign(foreign_io(false, IoType::OutgoingFactory)));
    };
    let port = port_arg(scope, value)?;
    let container = container::engine_if_ready()
        .and_then(|engine| engine.cell(&cell).map(|cell| (engine, cell)));
    let address = port_address(container, port)?;
    address.parse().map(Some).map_err(|error| {
        Refusal::Container(format!(
            "container address {address:?} is not ip:port: {error}"
        ))
    })
}

/// `__container_address(owner, port)`: `host:port` the node dials for a
/// port's `fetch()` and `connect()`, or a throw.
pub(super) fn op_container_address(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let address = owned_container(scope, args.get(0), IoType::OutgoingFactory)
        .and_then(|container| Ok((container, port_arg(scope, args.get(1))?)))
        .and_then(|(container, port)| port_address(container, port));
    match address {
        Ok(address) => rv.set(v8::String::new(scope, &address).unwrap().into()),
        Err(refusal) => refusal.throw(scope),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs {
    entrypoint: Option<Vec<String>>,
    #[serde(default)]
    env: Vec<(String, String)>,
    #[serde(default)]
    enable_internet: bool,
    #[serde(default)]
    labels: Vec<(String, String)>,
}

pub(super) fn op_container_start(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Monitor) else {
        return;
    };
    let raw = string_arg(scope, &args, 1);
    let request: StartArgs = match serde_json::from_str(&raw) {
        Ok(request) => request,
        Err(error) => return loader_throw(scope, &format!("start(): {error}")),
    };
    let Some((engine, cell)) = container else {
        return rv.set(rejected_promise(scope, NO_CONTAINER));
    };
    // The run opens here, on the calling thread, so the monitor() that
    // follows this call in the same turn waits for this start's exit.
    let run = cell.begin_run();
    let async_id = asyncrt::enqueue_io_context(async move {
        engine
            .start(
                &cell,
                run,
                StartParams {
                    entrypoint: request.entrypoint,
                    env: request.env,
                    enable_internet: request.enable_internet,
                    labels: request.labels,
                },
            )
            .await
            .map_err(|error| format!("{error:#}"))?;
        Ok::<String, String>(String::new())
    });
    rv.set(promise_for(scope, async_id));
}

/// Resolves with the root process's exit code as text once the current
/// run ends. Unrefed: a handler can await it, but once the handler has
/// answered it cannot keep the event, and so the cell, alive. A drain
/// would otherwise wait on a promise that settles only when the container
/// exits. After the event, `running` reports the host's state.
pub(super) fn op_container_monitor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Monitor) else {
        return;
    };
    let Some((engine, cell)) = container else {
        return rv.set(rejected_promise(scope, NO_CONTAINER));
    };
    let run = cell.current_run();
    let async_id = asyncrt::enqueue_unrefed(async move {
        let code = engine.monitor(&cell, run).await?;
        Ok::<String, String>(code.to_string())
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_container_destroy(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Monitor) else {
        return;
    };
    let Some((engine, cell)) = container else {
        return rv.set(rejected_promise(scope, NO_CONTAINER));
    };
    let async_id = asyncrt::enqueue(async move {
        engine
            .destroy(&cell)
            .await
            .map_err(|error| format!("{error:#}"))?;
        Ok::<String, String>(String::new())
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_container_signal(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Monitor) else {
        return;
    };
    let signal = number_arg(scope, &args, 1) as u32;
    let Some((engine, cell)) = container else {
        return rv.set(rejected_promise(scope, NO_CONTAINER));
    };
    let async_id = asyncrt::enqueue(async move {
        engine
            .signal(&cell, signal)
            .await
            .map_err(|error| format!("{error:#}"))?;
        Ok::<String, String>(String::new())
    });
    rv.set(promise_for(scope, async_id));
}

/// Sets the idle window at once; the promise is the surface's.
pub(super) fn op_container_inactivity(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Client) else {
        return;
    };
    let duration = number_arg(scope, &args, 1);
    let Some((_, cell)) = container else {
        return rv.set(rejected_promise(scope, NO_CONTAINER));
    };
    cell.set_inactivity(Duration::from_millis(duration));
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let undefined = v8::undefined(scope).into();
    resolver.resolve(scope, undefined);
    rv.set(resolver.get_promise(scope).into());
}

#[derive(serde::Deserialize)]
struct ExecArgs {
    cmd: Vec<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
    cwd: Option<String>,
    user: Option<String>,
    #[serde(default)]
    combined: bool,
}

pub(super) fn op_container_exec(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Monitor) else {
        return;
    };
    let raw = string_arg(scope, &args, 1);
    let request: ExecArgs = match serde_json::from_str(&raw) {
        Ok(request) => request,
        Err(error) => return loader_throw(scope, &format!("exec(): {error}")),
    };
    let Some((engine, cell)) = container else {
        return rv.set(rejected_promise(scope, NO_CONTAINER));
    };
    let async_id = asyncrt::enqueue(async move {
        let process = engine
            .exec(
                &cell,
                ExecParams {
                    cmd: request.cmd,
                    env: request.env,
                    cwd: request.cwd,
                    user: request.user,
                    combined: request.combined,
                },
            )
            .await
            .map_err(|error| format!("{error:#}"))?;
        Ok::<String, String>(
            serde_json::json!({ "id": process.id, "pid": process.pid }).to_string(),
        )
    });
    rv.set(promise_for(scope, async_id));
}

// The process ops below take `(owner, id, ...)`, and are unrefed like
// `monitor()`: a handler awaits them, and a process left running when the
// handler answers does not pin the cell.

/// The refusal for a process id the running container does not answer for.
const PROCESS_CLOSED: &str = "the process is closed";

/// The process `id` names, if the owner's container started it. Another
/// container's process is refused as a closed one is, so an id says
/// nothing about the processes of other objects. On `Err` the op has
/// thrown, or `rv` holds the rejected promise.
fn process_or_refuse(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    rv: &mut v8::ReturnValue<v8::Value>,
) -> Result<Arc<container::ExecProcess>, ()> {
    let container = container_or_throw(scope, args, IoType::Client).ok_or(())?;
    let id = number_arg(scope, args, 1);
    match container.and_then(|(_, cell)| cell.process(id)) {
        Some(process) => Ok(process),
        None => {
            rv.set(rejected_promise(scope, PROCESS_CLOSED));
            Err(())
        }
    }
}

/// One chunk of stdout (1) or stderr (2); an empty chunk is the end.
pub(super) fn op_container_exec_read(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(process) = process_or_refuse(scope, &args, &mut rv) else {
        return;
    };
    let which = number_arg(scope, &args, 2) as u8;
    let async_id = asyncrt::enqueue_unrefed(async move {
        Ok::<Vec<u8>, String>(process.read(which).await.to_vec())
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_container_exec_write(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(process) = process_or_refuse(scope, &args, &mut rv) else {
        return;
    };
    let Some(bytes) = view_bytes(args.get(2)) else {
        return loader_throw(scope, "stdin write needs bytes");
    };
    let async_id = asyncrt::enqueue_unrefed(async move {
        process.write(&bytes).await?;
        Ok::<String, String>(String::new())
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_container_exec_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(process) = process_or_refuse(scope, &args, &mut rv) else {
        return;
    };
    let async_id = asyncrt::enqueue_unrefed(async move {
        process.close_stdin().await;
        Ok::<String, String>(String::new())
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_container_exec_wait(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(process) = process_or_refuse(scope, &args, &mut rv) else {
        return;
    };
    let async_id = asyncrt::enqueue_unrefed(async move {
        let code = process.wait().await.map_err(|error| format!("{error:#}"))?;
        Ok::<String, String>(code.to_string())
    });
    rv.set(promise_for(scope, async_id));
}

pub(super) fn op_container_exec_kill(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(process) = process_or_refuse(scope, &args, &mut rv) else {
        return;
    };
    let signal = number_arg(scope, &args, 2) as u32;
    let async_id = asyncrt::enqueue_unrefed(async move {
        process
            .kill(signal)
            .await
            .map_err(|error| format!("{error:#}"))?;
        Ok::<String, String>(String::new())
    });
    rv.set(promise_for(scope, async_id));
}

/// Forget a process of the owner's container.
pub(super) fn op_container_exec_drop(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let Some(container) = container_or_throw(scope, &args, IoType::Client) else {
        return;
    };
    let id = number_arg(scope, &args, 1);
    if let Some((_, cell)) = container {
        cell.drop_process(id);
    }
}

#[cfg(test)]
mod tests {
    use super::super::cell_event_context_for_test as cell_context;
    use super::*;
    use crate::container::test_support;

    #[test]
    fn the_cell_is_the_running_events() {
        assert_eq!(cell_of(&IoContext::new()), None);
        assert_eq!(cell_of(&cell_context("cell-a")).as_deref(), Some("cell-a"));
    }

    #[derive(Clone, Copy)]
    enum Arg<'a> {
        Text(&'a str),
        Number(f64),
    }

    /// Call `op` through V8, as a script that bypassed the harness would.
    /// Answers what it returned (a promise as its state, and a rejection
    /// with its reason), or the exception it threw.
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
                v8::PromiseState::Rejected => {
                    format!("rejected: {}", promise.result(tc).to_rust_string_lossy(tc))
                }
            },
            Err(_) => value.to_rust_string_lossy(tc),
        })
    }

    /// `port_address_arg` on `port`, as the fetch and upgrade ops call it.
    fn exempt(scope: &mut v8::PinScope, port: Option<f64>) -> Result<Option<String>, String> {
        let value = match port {
            Some(port) => v8::Number::new(scope, port).into(),
            None => v8::undefined(scope).into(),
        };
        match port_address_arg(scope, value) {
            Ok(address) => Ok(address.map(|address| address.to_string())),
            Err(Refusal::Foreign(message) | Refusal::Container(message)) => Err(message),
        }
    }

    /// Run `f` in an isolate on a thread started after V8, as
    /// `runtime::init_v8` requires, with the host runtime entered.
    fn in_isolate(f: impl FnOnce(&mut v8::PinScope) + Send + 'static) {
        let _ = crate::asyncrt::test_host_runtime();
        Engine::init();
        std::thread::spawn(|| {
            let config = Arc::new(WorkerConfig::new(WorkerConfigOptions {
                src: "export default { fetch() { return new Response(); } };\n".into(),
                script_name: "containers".into(),
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
            let _runtime = crate::asyncrt::test_host_runtime().enter();
            worker.with_scope_for_test(f);
        })
        .join()
        .unwrap();
    }

    /// Every op called with `owner` throws `expected(io type)`, and reaches
    /// no container.
    fn every_op_throws(
        scope: &mut v8::PinScope,
        owner: &str,
        process: u64,
        expected: impl Fn(IoType) -> String,
    ) {
        let owner = Arg::Text(owner);
        let id = Arg::Number(process as f64);
        macro_rules! throws {
            ($op:ident, $io:ident, $($arg:expr),*) => {
                assert_eq!(
                    call_op(scope, $op, &[owner, $($arg),*]),
                    Err(format!("Error: {}", expected(IoType::$io))),
                    stringify!($op)
                );
            };
        }
        throws!(op_container_running, Monitor,);
        throws!(op_container_start, Monitor, Arg::Text("{}"));
        throws!(op_container_monitor, Monitor,);
        throws!(op_container_destroy, Monitor,);
        throws!(op_container_signal, Monitor, Arg::Number(15.0));
        throws!(op_container_exec, Monitor, Arg::Text(r#"{"cmd":["true"]}"#));
        throws!(op_container_inactivity, Client, Arg::Number(1.0));
        throws!(op_container_port, Client,);
        throws!(op_container_address, OutgoingFactory, Arg::Number(8080.0));
        throws!(op_container_exec_read, Client, id, Arg::Number(1.0));
        throws!(op_container_exec_write, Client, id);
        throws!(op_container_exec_close, Client, id);
        throws!(op_container_exec_wait, Client, id);
        throws!(op_container_exec_kill, Client, id, Arg::Number(9.0));
        throws!(op_container_exec_drop, Client, id);
    }

    #[test]
    fn outside_a_durable_object_event_every_op_throws_the_cross_request_error() {
        in_isolate(|scope| {
            let engine = test_support::install_engine();
            let cell = test_support::add_cell(&engine, "refuse-a", Some("10.0.0.1"));
            let process = test_support::add_process(&cell);
            let _current = CurrentGuard::enter(IoContext::new());
            every_op_throws(scope, "refuse-a", process, |io| foreign_io(false, io));
            assert_eq!(
                exempt(scope, Some(8080.0)),
                Err(foreign_io(false, IoType::OutgoingFactory))
            );
            // A request that is no container port's passes untouched.
            assert_eq!(exempt(scope, None), Ok(None));
            assert!(cell.running());
            assert_eq!(cell.current_run(), 0);
            assert_eq!(test_support::inactivity(&cell), None);
            assert!(test_support::process_known(process));
        });
    }

    #[test]
    fn another_objects_container_throws_the_cross_object_error() {
        in_isolate(|scope| {
            let engine = test_support::install_engine();
            let a = test_support::add_cell(&engine, "foreign-a", Some("10.0.0.1"));
            let b = test_support::add_cell(&engine, "foreign-b", Some("10.0.0.2"));
            let process = test_support::add_process(&a);
            // "a"'s objects used during an event of "b".
            let _current = CurrentGuard::enter(cell_context("foreign-b"));
            every_op_throws(scope, "foreign-a", process, |io| foreign_io(true, io));
            // Neither container was touched.
            for cell in [&a, &b] {
                assert_eq!(cell.current_run(), 0);
                assert_eq!(test_support::inactivity(cell), None);
            }
            assert!(test_support::process_known(process));
            // An owner that is no scope at all is no owner.
            let refused = call_op(scope, op_container_running, &[Arg::Number(1.0)]);
            assert_eq!(
                refused,
                Err(format!("Error: {}", foreign_io(true, IoType::Monitor)))
            );
        });
    }

    #[test]
    fn the_owner_acts_on_its_own_container() {
        in_isolate(|scope| {
            let engine = test_support::install_engine();
            let a = test_support::add_cell(&engine, "own-a", Some("10.0.0.1"));
            let b = test_support::add_cell(&engine, "own-b", Some("10.0.0.2"));
            let idle = test_support::add_cell(&engine, "own-idle", None);
            let a_process = test_support::add_process(&a);
            let b_process = test_support::add_process(&b);

            {
                let _current = CurrentGuard::enter(cell_context("own-a"));
                let owner = Arg::Text("own-a");
                let running = call_op(scope, op_container_running, &[owner]);
                assert_eq!(running.as_deref(), Ok("true"));
                assert_eq!(
                    call_op(scope, op_container_port, &[owner]).as_deref(),
                    Ok("undefined")
                );
                let address = call_op(scope, op_container_address, &[owner, Arg::Number(8080.0)]);
                assert_eq!(address.as_deref(), Ok("10.0.0.1:8080"));
                assert_eq!(
                    exempt(scope, Some(8080.0)),
                    Ok(Some("10.0.0.1:8080".into()))
                );
                // Only an integral port number in range names a port.
                for port in [
                    Arg::Text("8080"),
                    Arg::Number(0.0),
                    Arg::Number(65536.0),
                    Arg::Number(8080.5),
                    Arg::Number(f64::NAN),
                ] {
                    let refused = call_op(scope, op_container_address, &[owner, port]).unwrap_err();
                    assert!(refused.contains("not a port number"), "{refused}");
                }
                assert!(exempt(scope, Some(80.5)).is_err());
                call_op(
                    scope,
                    op_container_inactivity,
                    &[owner, Arg::Number(1234.0)],
                )
                .unwrap();
                assert_eq!(
                    test_support::inactivity(&a),
                    Some(Duration::from_millis(1234))
                );
                assert_eq!(test_support::inactivity(&b), None);
                // Another container's process is closed here, whatever the
                // op, and is not this object's to drop.
                let foreign = Arg::Number(b_process as f64);
                let closed = Ok(format!("rejected: Error: {PROCESS_CLOSED}"));
                macro_rules! closed {
                    ($op:ident, $($arg:expr),*) => {
                        assert_eq!(
                            call_op(scope, $op, &[owner, foreign, $($arg),*]),
                            closed,
                            stringify!($op)
                        );
                    };
                }
                closed!(op_container_exec_read, Arg::Number(1.0));
                closed!(op_container_exec_write, Arg::Text("x"));
                closed!(op_container_exec_close,);
                closed!(op_container_exec_wait,);
                closed!(op_container_exec_kill, Arg::Number(9.0));
                call_op(scope, op_container_exec_drop, &[owner, foreign]).unwrap();
                assert!(test_support::process_known(b_process));
                // Its own process answers.
                let own = Arg::Number(a_process as f64);
                let read = call_op(
                    scope,
                    op_container_exec_read,
                    &[owner, own, Arg::Number(1.0)],
                );
                assert_eq!(read.as_deref(), Ok("pending"));
                call_op(scope, op_container_exec_drop, &[owner, own]).unwrap();
                assert!(!test_support::process_known(a_process));
            }

            {
                let _current = CurrentGuard::enter(cell_context("own-b"));
                assert_eq!(
                    exempt(scope, Some(8080.0)),
                    Ok(Some("10.0.0.2:8080".into()))
                );
                let owner = Arg::Text("own-b");
                call_op(
                    scope,
                    op_container_exec_drop,
                    &[owner, Arg::Number(b_process as f64)],
                )
                .unwrap();
                assert!(!test_support::process_known(b_process));
            }

            {
                let _current = CurrentGuard::enter(cell_context("own-idle"));
                let owner = Arg::Text("own-idle");
                let running = call_op(scope, op_container_running, &[owner]);
                assert_eq!(running.as_deref(), Ok("false"));
                let refused = call_op(scope, op_container_address, &[owner, Arg::Number(8080.0)]);
                assert_eq!(
                    refused,
                    Err("Error: the container is not running".to_string())
                );
                // start() opens the run of the owner's container.
                let started = call_op(scope, op_container_start, &[owner, Arg::Text("{}")]);
                assert_eq!(started.as_deref(), Ok("pending"));
                assert_eq!(idle.current_run(), 1);
                assert!(idle.running());
                assert_eq!((a.current_run(), b.current_run()), (0, 0));
            }

            {
                // An object with no container on this node: every async op
                // rejects.
                let _current = CurrentGuard::enter(cell_context("own-none"));
                let owner = Arg::Text("own-none");
                let rejected = Ok(format!("rejected: Error: {NO_CONTAINER}"));
                macro_rules! rejects {
                    ($op:ident, $($arg:expr),*) => {
                        assert_eq!(
                            call_op(scope, $op, &[owner, $($arg),*]),
                            rejected,
                            stringify!($op)
                        );
                    };
                }
                rejects!(op_container_start, Arg::Text("{}"));
                rejects!(op_container_monitor,);
                rejects!(op_container_destroy,);
                rejects!(op_container_signal, Arg::Number(15.0));
                rejects!(op_container_inactivity, Arg::Number(1.0));
                rejects!(op_container_exec, Arg::Text(r#"{"cmd":["true"]}"#));
                assert_eq!(exempt(scope, Some(8080.0)), Err(NO_CONTAINER.to_string()));
                assert_eq!(a.current_run(), 0);
            }
        });
    }
}
