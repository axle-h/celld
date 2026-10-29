# Limitations

celld v0.6.2 is a beta release with these operational limits. See
[Cloudflare compatibility](cloudflare-compat.md) for the supported services,
APIs, and Wrangler configuration.

## Fleets

- A fleet runs one application. celld has no account service, multi-tenant
  scheduler, or managed ingress.
- A fleet stores its durable state in an S3-compatible bucket, a Google Cloud
  Storage bucket, or an Azure Blob Storage container. Only `celld dev` can use
  the local SQLite object store.
- Ownership balancing counts cells by node weight, not by CPU or memory use.
  It moves only hibernated cells, so a fleet without idle eviction balances
  only the cells that hibernate on their own.

## Networking and security

- celld does not terminate TLS. Terminate public TLS at an ingress proxy, and
  put the internal listener on a private network or an encrypted overlay.
- Peer traffic is plaintext HTTP. The fleet HMAC authenticates tunnel
  establishment and control requests but does not encrypt data, so the network
  must provide confidentiality.
- The fleet bucket controls the fleet. Give its credentials access to one fleet
  only. See [Security](security.md).

## Object storage credentials

- The credential methods differ by provider. See
  [Configure object storage](README.md#configure-object-storage).
- Azure identity works only in the public Azure cloud. A managed identity from
  Azure App Service or Azure Container Apps does not work. Use a workload
  identity or a storage account key there.

## WebSockets

- An outbound Durable Object WebSocket keeps its cell resident. It closes when
  the cell moves to another node, so the application must store the
  connection intent and reconnect.
- A node limits the resident cells and outbound WebSockets.
- Sent WebSocket messages that wait for a slow peer are bounded at 32 MiB per
  socket, and by the isolate's memory budget for all of its sockets
  together. A message past either bound closes its socket with code 1011,
  and the application sees code 1006. A Durable Object holds at most 32,768
  hibernatable WebSockets. See [Cloudflare
  compatibility](cloudflare-compat.md).
- A socket that closes first waits at most 10 seconds for its peer's reply.
- `new WebSocket()` cannot go through a Dynamic Worker's `globalOutbound`
  Fetcher. A `fetch()` upgrade can.
- A WebSocket that a stateless Worker holds crosses service bindings, Dynamic
  Worker entrypoints and Durable Object calls only within one node. A Durable
  Object on another node cannot return one.

## TCP sockets

- A request or Durable Object holds at most `CELLD_MAX_TCP_SOCKETS` open
  `connect()` sockets (32 by default). One more is refused at once:

  ```text
  celld refused connect(): this Durable Object already holds 32 open TCP sockets, the most CELLD_MAX_TCP_SOCKETS allows. Close one first.
  ```

  A socket a script dropped is collected before the cap is applied, so
  connecting and dropping a socket in each event is never refused: a refusal
  means that many sockets are still reachable. Cloudflare limits an
  invocation to six simultaneous connections and queues the rest until one
  closes; celld neither queues nor counts `fetch()` against the cap.
- A Durable Object's sockets close when the object leaves memory, even with
  a read waiting, so the application must reconnect after an eviction.

## Isolate limits

- A Worker must load within the V8 heap limit of its isolate
  (`CELLD_V8_HEAP_LIMIT_MB`, 128 MB by default) and within 1 second of CPU
  time, as on Cloudflare. The load covers compiling and evaluating the modules,
  installing the `env` and `process.env`, and reading the handlers. A load past
  either limit fails with Cloudflare's error, `Script startup exceeded memory
  limits.` or `Script startup exceeded CPU time limit.`, and celld discards the
  isolate. Through a Worker Loader, the error reads as workerd's report of a
  Worker that failed to start: `Failed to start Worker:` and
  `Error: Script startup exceeded CPU time limit.` on the next line. workerd
  run locally enforces neither limit, so this follows workerd's source rather
  than a recording.
- Module scope cannot wait for I/O or a timer: celld runs no event loop
  while a Worker starts, so a top-level `await` on one fails the start with
  `Top-level await in module is unsettled.` workerd refuses the operation
  itself, with `Disallowed operation called within global scope.`, and also
  refuses `crypto.getRandomValues()` there, which celld allows.
- Each isolate start is a load, so the limits apply whenever a pool adds an
  isolate under load, or a Durable Object's isolate starts, and not only at a
  deployment. A Worker whose load is close to a limit can fail later, when a
  pool grows. A Durable Object request whose isolate fails to start rejects
  with the startup error, as a Worker Loader reports one: `Failed to start
  Worker:` and the cause on the next line, cut to 4 KiB. A start that fails for another
  reason, such as its storage, rejects with `route failed: RuntimeFailed`, and
  the node log has the cause.
- After the load, an isolate that reaches the heap limit is condemned, and no
  JavaScript runs in it again. The event running then, and every other event
  in the isolate, fails with workerd's error, `Worker has exceeded memory
  limit.`; their `waitUntil` work stops, and frames they held for
  hibernatable WebSockets are dropped. The next request runs in a new
  isolate. A Dynamic Worker loads again, so its module scope runs again, after
  a backoff if it keeps reaching the limit (see
  [Dynamic Workers](services/dynamic-workers.md)). A Durable Object in the
  isolate resets as after `ctx.abort()`, and starts again in a new isolate;
  its requests wait for that isolate.
- celld stops JavaScript at the memory limit when the operation in progress
  finishes, at the load and after it: a JavaScript loop stops at once, but one
  builtin call, such as a single allocation of up to 1 GB (V8's largest
  object) or a `JSON.parse()`, runs to its end first. The node can therefore
  briefly hold a few GB more than the limit; a 1 GB array peaks at about
  2.2 GB of resident memory. celld frees a condemned isolate when its last
  event or Durable Object leaves it.
- Memory outside the V8 heap has a budget of its own, as large as the heap
  limit; Cloudflare counts both in one 128 MB. The budget counts
  `ArrayBuffer`s, typed arrays, `SharedArrayBuffer`s, WebAssembly memory, and
  the buffers celld hands a Worker: bodies, crypto and compression output,
  SQL blobs, and bundle files.
- Memory a Worker asks for past the budget is refused, after V8 has
  collected garbage, with V8's `RangeError`: `Array buffer allocation
  failed` for a buffer, and the error of the method for growth. A refusal
  takes no memory, so it does not condemn the isolate, and a Worker may
  catch it and ask for less, as Emscripten does when it grows its heap.
- An isolate that comes to hold more than the budget is condemned as at the
  heap limit. That happens when a buffer celld hands over in a synchronous
  call, such as `inflateSync()` or a SQL read, takes it past the budget, so a
  loop of such calls stops within one buffer; when Wasm code grows its own
  memory past it; and when a turn or the load ends past it, after a
  collection.
- A WebAssembly memory and a resizable `ArrayBuffer` or growable
  `SharedArrayBuffer` grow outside the allocator, and count in the same
  budget through V8's external memory. celld checks growth that JavaScript
  asks for before it happens: `resize()`, `grow()`, `transfer()`,
  `transferToFixedLength()`, `memory.grow()`, and a buffer made with a
  `maxByteLength`. It checks what V8 makes whole once made: `new
  WebAssembly.Memory()`, `new WebAssembly.Instance()`,
  `WebAssembly.instantiate()`, and `structuredClone()`. Each WebAssembly
  memory is capped at the heap limit.
- Wasm code that grows its own memory with `memory.grow` is checked every
  5 ms while a turn of an isolate that has made WebAssembly runs. The check
  collects garbage once the memory has grown by an eighth of the budget
  since its last collection, so the isolate can pass the budget by that
  eighth, and by what it writes in 5 ms, before it is condemned. An instance
  whose own memories pass the budget as it is made may be refused or
  condemned, whichever check sees it first.
- A grow of a WebAssembly memory past both its own maximum and the budget
  throws the budget's `RangeError` rather than V8's `Maximum memory size
  exceeded`, since a memory's maximum cannot be read.
- The host gathers a body read whole in chunks, each charged to the budget as
  it arrives. Buffers the Worker dropped still count until a collection,
  which the host cannot ask for while it reads, so reads in flight may pass
  the budget by as much again; the turn that takes a read over collects and
  then condemns the isolate if it is still past the budget. An isolate can
  therefore briefly hold its heap and twice the budget, about 384 MiB by
  default.
- Reading a body whole, with `arrayBuffer()`, `text()`, `json()` or
  `blob()`, holds it once in the budget, so a body larger than the budget
  rejects with workerd's `TypeError`, and the isolate lives on: `Memory limit
  would be exceeded before EOF.` when its length is known to be past the
  budget before it is read, and `Memory limit exceeded before EOF.` when it
  passes the budget as it is read. Stream a larger body instead. After
  `arrayBuffer()` or `blob()` hands a body over, reading it again throws
  `Body has already been used`, as in workerd.
- A clone or `tee()` of a body the host holds (a fetched body, a request
  body, an R2 object's) holds what its slower branch has not read yet on the
  host, charged to the budget. All of an isolate's tees together hold at
  most half the budget, so the branches being read have the other half. Past that, both branches end with
  Cloudflare's `TypeError: ReadableStream.tee() buffer limit exceeded. …`
  after what they hold, and the isolate lives on; workerd run locally has no
  such limit. A clone or tee of a stream the Worker made buffers in the
  isolate, so past the limit it condemns the isolate instead. Read clones
  and tees in parallel.
- Each invocation has a CPU limit, of 30 seconds unless the Worker's
  `limits.cpu_ms` sets another, from 1 ms to 5 minutes, as on Cloudflare's
  Standard usage model. A Dynamic Worker's `cpuMs` works the same way (see
  [Dynamic Workers](services/dynamic-workers.md#differences-from-cloudflare)).
  An invocation is a request, a service-binding or RPC call, a queue batch, a
  cron run, or one event of a Durable Object (a request, an RPC call, an
  alarm, a WebSocket message), each with a limit of its own; its `waitUntil`
  work counts toward it. The time is the CPU time of the isolate's thread
  while the invocation's JavaScript runs, summed across its turns, and a turn
  that would pass the limit is stopped. `celld dev` applies the same limits;
  `wrangler dev` applies none.
- A turn stops at the limit where JavaScript checks for interrupts, so a
  long builtin call, or a SQL statement (stopped within about 10,000 SQLite
  steps), can run past it. A loop of large allocations has been seen to run
  about 9 seconds past a 1 second limit before it stopped. A turn that runs on 100 ms, or the
  limit if that is longer, past its limit condemns its isolate, as the
  memory limit does: nothing new is placed there, its Durable Objects move
  once the turn returns, and its events fail with the CPU limit's error.
  The thread stays in the call until it returns.
- Turns run on isolate threads of their own (`CELLD_ISOLATE_THREADS`, the
  CPU count by default), never on the threads that serve the listeners, so
  a turn that holds its thread, past its limit or inside a limit of minutes,
  holds only an isolate thread: the node's listeners, its health checks and
  its other Workers keep answering. A turn that has run for 50 ms no longer
  counts against the isolate threads, and the node starts another thread
  for the turns that wait, up to twice the count of threads that are not
  stuck and a hard ceiling with them; past that, waiting turns wait for one
  to end.
- A turn still running after the CPU watchdog asked it to stop, for the
  limit or 100 ms, whichever is longer, but at most 500 ms, is stuck: it holds its thread and its heap until the call returns, and its
  isolate takes no new work. Stuck turns count against their owner, the
  script, including the Dynamic Workers it loads. An owner with 2 stuck
  turns starts no new event until one returns: its requests, Dynamic Worker
  calls and Durable Object events fail at once with the CPU limit's error,
  and its Durable Objects are not placed; events already running go on.
  With half as many stuck turns on the node as isolate threads (at least 3),
  an owner that has one starts no isolate: a request that needs one is
  refused with status 503 (`Worker refused: node has N isolates stuck past
  their CPU limit…`), while owners with none grow as before. The caps stop
  new work, not work already running: turns running when an owner reaches
  its cap can still become stuck. `/state` reports the counts
  (`stuckIsolates`) and the threads (`isolateThreads`).
- While an owner has a turn that has run for 50 ms and is not stuck, it
  starts at most half as many turns at once as there are isolate threads;
  its further events wait behind its own, so other owners keep threads. A
  few isolate threads past every ceiling are kept for owners with no stuck
  or long turn.
- PBKDF2 (WebCrypto and `node:crypto`) refuses more than 100 000
  iterations, as Cloudflare does, with `NotSupportedError: Pbkdf2 failed:
  iteration counts above 100000 are not supported (requested N).`; workerd
  run locally sets no limit.
- A D1 call (a query, a batch or an `exec()`) has Cloudflare's 30 second
  limit on its duration (`CELLD_D1_QUERY_LIMIT_MS` sets another). A
  statement still running at the limit is interrupted, the call fails with
  `D1_ERROR: D1 DB exceeded its CPU time limit and was reset.`, its writes
  roll back, and the database serves the next call.
- An invocation past its CPU limit fails with `Worker exceeded CPU time
  limit.`, the isolate lives on, and its other requests go on. Cloudflare
  answers such a request with error 1102 ("Worker exceeded resource limits");
  celld answers a request from the public listener with status 500 and
  `Worker failed: Worker exceeded CPU time limit.`, and a caller through a
  binding gets the error. workerd run locally enforces no CPU limit, so this
  follows Cloudflare's documentation rather than a recording.
- A Durable Object whose event runs past its CPU limit resets, as workerd
  aborts the object: the write of the turn the limit stopped never commits,
  the object's other events fail with the same error, a stub bound to it
  keeps throwing it, and the next call reaches a new instance. A facet past
  its limit instead fails every later call until its root object starts
  again; workerd resets the facet alone.
- A cron trigger whose interval is an hour or more gets the same limit as any
  invocation, 30 seconds by default; Cloudflare gives it 15 minutes.

## Platforms

- The installer supplies binaries for Linux x86-64, Linux ARM64, and Apple
  Silicon. Windows is not supported.
