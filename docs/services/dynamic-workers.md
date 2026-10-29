# Dynamic Workers

A Dynamic Worker is Worker code that a running Worker supplies at runtime and
loads through a Worker Loader binding, such as code that a customer uploads or
that a model writes. celld compiles the code into a separate V8 isolate on the
node of the loader. Cloudflare runs this feature in an
[open beta](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/),
so the API can change. Read the
[Cloudflare Dynamic Workers documentation](https://developers.cloudflare.com/dynamic-workers/)
and the
[API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)
for the standard API.

## Example

The [Dynamic Workers example](../../examples/dynamic-worker-tails) loads a
Worker and sends its invocation records to a Tail Worker.

<!-- celld-example: dynamic-worker-tails -->

## API

- `env.LOADER.get(id, getCode)` loads a Worker under a string id, and
  `env.LOADER.load(code)` loads an anonymous Worker.
- `getCode` returns a `WorkerCode` object: `mainModule`, `modules`,
  `compatibilityDate`, `compatibilityFlags`, `env`, `globalOutbound`, `limits`,
  and `tails`.
- `stub.getEntrypoint(name, options)` returns a Fetcher for the default export
  or for a named `WorkerEntrypoint`.
- `stub.getDurableObjectClass(name, options)` returns a Durable Object class,
  for example for a [facet](durable-object-facets.md).
- `stub.dispose()` releases the loaded Worker.

## Loading a Worker

A `worker_loaders` entry accepts only the `binding` name, as in Wrangler.
celld stops the deployment when the entry sets `tails` or `limits`; set them in
the `WorkerCode` object, or set `limits` in a `getEntrypoint()` call.

celld calls the `getCode` callback of `env.LOADER.get(id, getCode)` only when
it must compile, so a throw in `getCode` surfaces at the first use of the
Worker, not at `get()`.

- A `modules` value can be a module object such as `{ wasm: bytes }`; the
  [WebAssembly page](../wasm.md#dynamic-workers) shows that form. celld refuses
  bare bytes, as workerd does.
- A relative import resolves from the name of the importing module, so
  `dir/a.js` can import `./b.js` when the map contains `dir/b.js`.
- `compatibilityDate` is required, as in workerd.
- The module sources can total 64 MiB by default, as in workerd. An operator
  can set `CELLD_MAX_DYNAMIC_WORKER_CODE_BYTES` on each node to a larger byte
  count. Loaded code cannot raise it, and the heap, execution, and admission
  limits still apply.
- When both `WorkerCode.limits` and `getEntrypoint()` set a limit, celld uses
  the lower value.

The load must stay within the isolate's heap limit and 1 second of CPU time,
as a deployed Worker's must (see [Limitations](../limitations.md#isolate-limits)).
A load past either one fails, and the first call through the Worker rejects
with `Script startup exceeded memory limits.` or `Script startup exceeded CPU
time limit.`, in the form below. Copying an `env` into `process.env` is part of
the load, so it counts too.

A Worker that fails to start rejects its calls with an `Error` whose message
is workerd's: `Failed to start Worker:`, then the cause on the next line. A
syntax error, a throw at module scope, an import that does not resolve or
link, or a top-level `await` that rejects reads `Uncaught ` and the thrown
value's description, then a line for each frame where the error was made,
such as `  at main.js:2:7 in inner`; celld's own frames are left out. A
value other than an `Error` reads `Uncaught Error: ` and the value, with no
location unless `Error.captureStackTrace` gave it frames. A top-level `await`
that is still pending once module scope has run fails with `Uncaught Error:
Top-level await in module is unsettled.`, because celld runs no event loop
while a Worker starts.

## The isolation boundary

The loaded isolate has its own context and heap, but it runs in the process of
the loader. It is not a second process or a virtual machine, so the boundary
scopes what the code can address and makes no claim about V8 escape safety.
For a kernel boundary, run the code in a container under a named runtime; read
[the isolation boundary](containers.md#the-isolation-boundary) on the
Containers page.

The loaded Worker gets no binding and no `vars` entry of the deployment, and no
Worker Loader binding, so it cannot load another Worker. It reaches only the
`env` of its `WorkerCode`, from the time its main module evaluates. Under its
own compatibility date and flags, its `process.env` is copied from that `env`
too, never from the loader's `vars` (see
[Node.js compatibility](../cloudflare-compat.md#nodejs-compatibility)). A
capability call is an RPC into the isolate of the loader. celld passes host
operations to its internal scripts as function parameters, never as globals,
so `globalThis` exposes none.

When `WorkerCode` omits `globalOutbound`, the loaded Worker inherits the egress
policy of the loader. A `null` value makes `fetch()` and `connect()` throw. A
Fetcher brokers each `fetch()` through the loader. A `connect()` or a WebSocket
through a Fetcher throws, because the celld service protocol carries no
bidirectional tunnel.

An entrypoint's `fetch()` can answer with a WebSocket upgrade. The loader
returns or accepts the socket as it does one from a
[service binding](workers.md#service-bindings), with the same limits.

## Lifetime and caching

`get(id, getCode)` memoizes the compiled Worker by id inside one loader binding
of one host isolate, so module scope survives between calls there. Each
isolate, each node, and each `worker_loaders` entry has its own map, and pays
the compile again. Cloudflare describes this reuse as possible, not
guaranteed. `load(code)` compiles on each call.

A stub, an entrypoint, a Durable Object class, or a running facet keeps its
loaded Worker alive. The id map holds a weak reference, so after the last
reference disappears the garbage collector can release the Worker, at no
guaranteed time, and a later `get()` runs `getCode` again.

The `dispose()` method of a stub releases its loaded Worker and removes the id
from the map. The other stubs for that load cannot start new calls, and an
in-flight call finishes.

A loaded Worker whose isolate reaches the heap limit fails its running calls
with `Worker has exceeded memory limit.`, as on Cloudflare, and celld lets the
isolate go, with any facet that ran in it. The next call loads the code again
into a new isolate, so module scope runs again, and the stub stays valid. When
the Worker reaches the limit again, or loading it again fails, celld waits
before the next load: 1 second after the second time in a row, doubling to at
most 60 seconds. A call in that wait fails with an error that says the Worker
is backing off, why, and when it loads again. A Worker that served for 60
seconds starts the count again.

A first load that fails stays failed when the same code would fail again: a
syntax error, a throw at module scope, or the startup memory limit. A first
load that runs past the startup CPU limit, which a busy node can cause, is
retried with the same backoff.

A Worker that failed for good no longer counts as a loaded Worker, and celld
keeps only its error, cut to 4 KiB, until the stub is collected: a script can
hold 256 of them, and the process 1,024, and past that a load fails with
`worker loader: too many failed loads … are still referenced`.

celld drops every loaded Worker when its host isolate retires, after in-flight
calls finish. A loaded Worker never outlives its loader, and a redeploy
compiles the code again.

## Differences from Cloudflare

- The process limit is 256 live Dynamic Workers, and each script generation can
  use 255 slots, so one loader cannot take the whole process. Every loader and
  script shares the process limit, and a load over either limit throws.
- The process rejects the removed `CELLD_MAX_LOADED_WORKERS` environment
  variable.
- `getEntrypoint()` supports `props` and `limits` options, while
  `getDurableObjectClass()` supports only `props`. A structured-clone encoded
  `props` value can be at most 1 MiB.
- A `globalOutbound` Fetcher cannot use `connect()` or a WebSocket. Its
  props, from `ctx.exports.Name({ props })`, can be at most 1 MiB encoded.
- A `WorkerCode.tails` array accepts Service Binding Fetchers. Each Fetcher
  receives one event after a Dynamic Worker fetch invocation finishes.
- The event contains the request metadata, the response status, the console
  logs, the uncaught exception, and the invocation outcome.
- celld records at most 256 KiB of serialized console log records for each
  invocation. It stops recording when the next complete record exceeds this
  limit.
- Tail delivery starts after the response is available. A Tail Worker failure
  does not change the response, and celld writes the failure to the console.
- celld enforces `cpuMs` and `subRequests` in `WorkerCode.limits` and in a
  `getEntrypoint()` call. It rejects `allowExperimental`. `cpuMs` applies to
  each invocation, not to the load, which has its own limit of 1 second.
  Without one, an invocation gets 30 seconds, the plan's default. A `cpuMs`
  over 5 minutes, the plan's maximum, is refused with an error. An
  invocation past its limit fails with `Worker exceeded CPU time limit.`
- `WorkerCode.env` accepts structured-clone values and Service Binding
  capabilities. The encoded values and the capability props can total 1 MiB.
- A loaded Worker can import a `node:` module without the flag that provides
  it, and a `cloudflare:` module that does not exist, by a named or default
  import. workerd fails such a Worker's start with `No such module`. A
  side-effect import of a builtin, such as `import "node:buffer";`, fails the
  start on celld.
- workerd refuses I/O, timers and random values at module scope with
  `Uncaught Error: Disallowed operation called within global scope. …`, which
  fails the Worker's start. celld does not: a timer, `scheduler.wait()` or
  `fetch()` awaited there fails the start as an unsettled top-level `await`,
  and `crypto.getRandomValues()` or reading a body works.
- Some runtime APIs throw with other messages than workerd's, such as
  `new URL("bad")`, `atob`, `new Headers([["a"]])` and `new TextDecoder("bogus")`.
- A loaded Worker entrypoint cannot transfer to another Worker. Awaitable and
  pipelined properties are also unavailable.

The [Cloudflare compatibility](../cloudflare-compat.md#services) page
lists the runtime APIs and the unsupported services.
