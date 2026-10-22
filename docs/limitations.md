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
- A WebSocket that a stateless Worker holds crosses service bindings, Dynamic
  Worker entrypoints and Durable Object calls only within one node. A Durable
  Object on another node cannot return one.

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
  with `route failed: RuntimeFailed`, and the node log names the limit.
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
- A request has a CPU limit only when a Dynamic Worker sets `cpuMs`. See
  [Dynamic Workers](services/dynamic-workers.md#differences-from-cloudflare).

## Platforms

- The installer supplies binaries for Linux x86-64, Linux ARM64, and Apple
  Silicon. Windows is not supported.
