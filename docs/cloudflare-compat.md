# Cloudflare compatibility

This page lists only the differences from the linked Cloudflare APIs. An entry
without a note matches Cloudflare.

- **Yes**: implemented, except for the listed differences.
- **Partial**: a substantial part is unavailable.
- **Experimental**: can change without notice.
- **No**: not implemented.

celld rejects an unsupported configuration or API at deployment or first use.
An unsupported feature that does not cause an error is a defect.

## Services

| service | status |
| --- | --- |
| [Workers](services/workers.md) | **Yes** |
| [Durable Objects](services/durable-objects.md) | **Yes** |
| [Durable Object Facets](services/durable-object-facets.md) | **Yes** |
| [Containers](services/containers.md) | **Experimental** |
| [Static assets](services/static-assets.md) | **Yes** |
| [Cron Triggers](services/cron-triggers.md) | **Yes** |
| [Dynamic Workers](services/dynamic-workers.md) | **Yes** |
| [KV](services/kv.md) | **Yes** |
| [Queues](services/queues.md) | **Yes** |
| [D1](services/d1.md) | **Yes** |
| [Workflows](services/workflows.md) | **Yes** |
| [R2](services/r2.md) | **Yes** |
| Workers AI | **No** |
| Vectorize | **No** |
| Hyperdrive | **No** |
| Browser Rendering | **No** |
| Email Workers | **No** |
| [Python Workers](services/workers.md#python-workers) | **Partial** — `fetch` handlers on the Pyodide 0.28 runtime line |

## Runtime APIs

| API | status |
| --- | --- |
| [Fetch, Request, Response, and Headers](#fetch-request-response-and-headers) | **Yes** |
| [Bindings](#bindings) | **Yes** |
| [Context](#context) | **Yes** |
| [`cloudflare:workers`](#cloudflareworkers) | **Partial** |
| [Handlers](#handlers) | **Yes** |
| [RPC](#rpc) | **Yes** |
| [Streams](#streams) | **Yes** |
| Encoding | **Yes** |
| [WebSockets](#websockets) | **Yes** |
| [Web Crypto](#web-crypto) | **Yes** |
| [Web standards](#web-standards) | **Yes** |
| WebAssembly | **Yes** |
| [Performance and timers](#performance-and-timers) | **Yes** |
| Console | **Yes** |
| [Node.js compatibility](#nodejs-compatibility) | **Partial** |
| [Cache](#cache) | **Partial** |
| HTMLRewriter | **Yes** |
| [TCP sockets](#tcp-sockets) | **Yes** |
| EventSource | **Yes** |
| MessageChannel | **Yes** |
| BroadcastChannel | **No** |

### [Fetch, Request, Response, and Headers](https://developers.cloudflare.com/workers/runtime-apis/fetch/)

- The `cache` request option is unavailable.
- An inbound `Request` has a `cf` object without Cloudflare edge fields. celld
  cannot prove the geolocation, colo, or TLS metadata.
- celld removes `Content-Length` from a Worker response, except for a `HEAD`
  response.
- A remote Durable Object call cannot retry after request-body transmission
  starts because celld keeps no replay copy.
- A remote Durable Object call waits for a rejected owner generation to change
  for at most `CELLD_OPERATION_DEADLINE_MS`.
- Global `fetch()` and `new WebSocket()` reach only public addresses unless
  the node's `CELLD_FETCH_PRIVATE_ALLOW` names the `host:port`, as Cloudflare's
  network allows only public ones. A refusal is a `TypeError` that Cloudflare
  cannot produce. See [Limit Worker egress](security.md#limit-worker-egress).

### [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)

Only the binding types in the [services table](#services) are available.

### [Context](https://developers.cloudflare.com/workers/runtime-apis/context/)

- `passThroughOnException()` has no effect because celld has no CDN fallback.
- `ctx.facets` is available only inside a Durable Object.
- With the `allow_irrevocable_stub_storage` flag, `ctx.restore()` exists, as
  on Cloudflare, but it rejects because celld cannot restore a stub. Without
  the flag, `ctx.restore` is undefined.

### `cloudflare:workers`

- The module exports the same names as workerd 1.20261001.1. An import of any
  other name, or a default import, stops the Worker from loading, as on
  Cloudflare.
- `cache`, `withEnv`, `withExports`, `withEnvAndExports`, and `abortIsolate`
  are not implemented. They import, but a call, a construction, or a property
  access throws an error that names the export. Logging or serializing `cache`
  does not throw.
- `cache` throws on use everywhere, including at module scope, where
  Cloudflare's `cache` reads every property as `undefined` outside a
  request.
- `restore` is the symbol that names a `[restore]()` method, as on Cloudflare,
  but celld never calls that method.

### [Custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)

`tracing` from `cloudflare:workers` and `ctx.tracing` work as in workerd
1.20261001.1: `enterSpan`, `startActiveSpan`, `startSpan`, `getActiveSpan`,
and the `Span` methods, with workerd's argument conversion, errors and
limits. Each ExecutionContext, a workflow's included, has its own
`ctx.tracing`; a Durable Object's `ctx` has none, as in workerd. A span
belongs to the request that made it, and from another request its methods
throw workerd's "Cannot perform I/O on behalf of a different request" error.

- A span is traced when the request is: with telemetry on (`CELLD_OTEL`) and
  the request sampled. celld exports a traced span as a child of the active
  span, or of the invocation's span, with its attributes, status and
  exceptions. See [Telemetry](telemetry.md#custom-spans). The Wrangler
  `observability` settings do not turn tracing on or off; `celld deploy`
  accepts them with a note and does not read them.
- With telemetry off, or for an unsampled request, `isTraced` is `false` and
  nothing is recorded, as for an unsampled request on Cloudflare.
- Names are cut to 64 bytes, at a character boundary; workerd cuts at the
  byte. A span holds about 64 KiB of attributes and exceptions, after which
  celld drops writes and adds workerd's `span_data_limit_exceeded` warning.
- celld holds span data outside the isolate, so it bounds it, counting each
  span's and attribute's overhead: one invocation can hold 1,024 spans open
  with at most 1 MiB between them, and all invocations together 64 MiB. A span
  past a bound is untraced, an attribute past one is dropped with the same
  warning, and the invocation span records `celld.tracing.spans_dropped`.
- Attribute keys starting with `celld.` are reserved for celld's own
  attributes. celld drops a Worker's attribute under one, and celld's value
  wins over a Worker's for any key celld sets on the span.
- workerd shares one context between overlapping requests to a Durable
  Object, so a span from one can be used in the other. celld gives each event
  its own, and the other event's use throws the I/O error.
- A function bound to the module's async context, with
  `AsyncLocalStorage.bind()` or `snapshot()`, sees the invocation span when it
  runs during a request. In workerd it sees `undefined`.

### [Handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/)

The `tail` and `email` handlers are unavailable.

### [RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)

- An RPC stub, or a stream passed over RPC, cannot cross an isolate boundary.
  Nor can a Request or Response whose body is a stream not yet read into
  memory. A Headers, Blob, Request or Response crosses by value everywhere
  workerd serializes one, Durable Object storage and a Worker Loader env
  included, and a File or CryptoKey is refused, as in workerd.
- An `AbortSignal` crosses RPC without the experimental
  `enable_abortsignal_rpc` flag, which workerd needs to serialize one.
- A Durable Object stub's `connect()` throws "Fetcher.connect() is not
  implemented in celld". workerd hands the object's `connect` handler a
  socket.
- celld's service bindings and `ctx.exports` stubs always have
  `getRpcMethodForTestOnly()`. workerd has it only under the `experimental`
  flag.
- An `AbortSignal` in a Durable Object RPC call does not cross a node boundary.
- A remote RPC retries only when the failed peer attempt did not start the
  method. Use a stable operation ID for an application retry.

### [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)

- celld expires an unclaimed and inactive HTTP stream after 60 seconds. A
  successful stream operation starts a new 60-second period.
- An expired or unknown stream reports an error instead of EOF.
- An `IdentityTransformStream`'s writer, after its readable is cancelled,
  rejects with the cancel reason. workerd rejects with "Network connection
  lost." when a read was in flight, and refuses a write or close after a
  write the cancel rejected as "This WritableStream has been closed.".

### [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

- An outbound Worker socket closes when its event and `waitUntil` work end. A
  socket returned in the response stays open. A socket that a service binding,
  a Dynamic Worker or a Durable Object returned keeps its request alive once
  the request accepts it, as in workerd.
- celld closes a WebSocket that a service binding, a Dynamic Worker or a
  Durable Object returned with code 1011 when the caller has not taken it from
  the response after 30 seconds, or 5 seconds after its deployment retires.
- A request can hold at most 64 such sockets that it has not returned or
  accepted. The call that would return one more throws, and that socket closes
  with code 1011.
- A socket accepted from such a response carries a Close from either side
  and waits 10 seconds for the other side's reply. Without one, the side
  that sent the Close then sees code 1006.
- A Worker response with status 101 and no WebSocket fails with status 500,
  and `new Response(null, { status: 101 })` throws workerd's `RangeError`. A
  `fetch()` without `Upgrade: websocket` that a server answers with 101 throws
  a `TypeError` that says so.
- Each isolate-polled input queue has a 1 MiB budget for non-terminal frames. A
  message larger than 1 MiB uses the complete budget. A socket accepted from a
  subrequest's response has such a queue at each end.
- If the isolate stops polling, celld discards unread frames during cleanup. A
  later pull reports an abnormal close.
- A WebSocket transport cannot move to a new cell owner. A client must reconnect
  with the same application operation ID.
- A tunneled connection forwards the owner's Close without an additional Close.
  If the owner connection fails between frames before a Close, the ingress sends
  code 1012. If a frame is incomplete, the ingress closes the transport instead.
- `acceptWebSocket()` throws above 90 percent of the V8 heap limit.
- A socket that closes first is CLOSING until its peer's reply, and its close
  event then carries that reply, as in workerd. celld waits at most 10
  seconds for the reply, and less if the socket's owner lets go of it first
  (a stateless request ends, or the socket is unregistered). The close event
  then reports code 1006. workerd has no such bound while the peer stays
  connected.
- A half-open socket, whose peer sent its Close and has no reply yet, stays
  open after the peer shuts down its side of the connection, as in workerd.
  celld then sends a Ping every second, and ends the socket when one fails:
  a peer that closed its connection outright answers the first with a reset.
  workerd sends no Ping.
- A connection that ends without a Close gives a close event with code 1006
  and workerd's reason, `WebSocket disconnected without sending Close
  frame.`
- `send()` never waits or throws, as in workerd, and there is no
  `bufferedAmount`. workerd queues whatever a Worker sends. celld bounds what
  waits on the host for a peer that reads slowly:
  - Each socket holds at most 32 MiB of sent messages. One message of any
    size is always accepted into an empty queue.
  - Every socket of an isolate together holds no more than the isolate's
    memory budget (`CELLD_V8_HEAP_LIMIT_MB`), the budget its ArrayBuffers
    use. The messages count against that budget while they wait.
  - A message past either bound closes its socket. The peer gets a Close
    with code 1011 and the reason `celld closed this WebSocket: more than 32
    MiB of sent messages waited for the peer to read them` or `celld closed
    this WebSocket: its isolate's memory limit could not hold more sent
    messages`. The application gets an `error` event, then a close event
    with code 1006 and the same reason. What it sends after that is
    dropped. A write still under way 1 second later is abandoned with the
    connection.
  - A message being written stays counted until the write finishes. A
    write that never finishes, to a peer that does not read, stays counted
    while the socket's owner lives, and is abandoned with its connection 1
    second after the owner lets go of the socket (a stateless request
    ends, or the socket is unregistered). workerd has no such bound. So a
    peer with a zero window holds its socket while the owner lives, by
    design, and the isolate's budget bounds what it holds.
  - An auto-response (`setWebSocketAutoResponse`) waits on the host like
    any other message. While a socket's outgoing queue holds more than 1
    MiB, celld reads no further from that socket until the queue drains:
    workerd writes each auto-response before it reads the next message. So
    a peer that sends requests and never reads the replies is held to about
    1 MiB. The application's own messages do not pause reading.
  - A bound never condemns the isolate: the message that does not fit is
    refused instead of held.
- `ctx.acceptWebSocket()` throws once a Durable Object holds 32,768
  hibernatable sockets, Cloudflare's limit: `this Durable Object already
  holds 32768 hibernatable WebSockets, the most one can; close one before
  accepting another`. A facet's sockets count against its root object,
  since Cloudflare documents the limit per Durable Object and does not
  mention facets. workerd has no limit.
- A Dynamic Worker whose `globalOutbound` is a Fetcher can make a `fetch()`
  upgrade: the request goes to the Fetcher, as any other request does, and
  its 101 carries the socket back. `new WebSocket()` there throws an error
  that points to that `fetch()` upgrade instead. workerd sends a
  `new WebSocket()` upgrade to the Fetcher too.
- A response with a WebSocket to a request without `Upgrade: websocket` fails,
  as in workerd. A Durable Object's `stub.fetch()` call then rejects, and an
  HTTP client receives status 500. The server end of the socket receives a close
  event with code 1006.
- A Durable Object's `stub.fetch()` call rejects when the handler fails, on the
  owner node and on any other node.

### [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

- HMAC accepts MD5, SHA-1, SHA-224, SHA-256, SHA-384, and SHA-512.
- ECDSA supports only the P-256 curve with SHA-256.
- AES-GCM accepts authentication tags from 96 through 128 bits in 8-bit steps.
- RSA-OAEP accepts SHA-1, SHA-256, SHA-384, and SHA-512. A nonempty label must
  contain valid UTF-8.
- A secret key cannot use `jwk` with `exportKey()` or `wrapKey()`.
- Ed25519 signs and verifies, and `NODE-ED25519` names the same algorithm. A
  signature from one spelling verifies under the other.
- X25519 derives bits and keys. A peer key of a low order gives a shared secret
  of all zero bytes, so `deriveBits()` rejects that key instead.
- An Ed25519 or X25519 public key uses its 32-byte point for the `raw` format,
  so `importKey()` and `exportKey()` both carry the point alone.

### [Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)

### [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)

`performance.timeOrigin` is `0`, and `performance.now()` matches `Date.now()`.
Both clocks advance at an I/O boundary and stay fixed during JavaScript
execution.

`scheduler.wait(ms, { signal })` honours its signal: an abort rejects the
wait, and an already-aborted signal rejects it at once. celld rejects with
the signal's reason itself. workerd rejects with a copy rebuilt from the
reason's name and message, so there a reason that is not an `Error`, such as
a string, arrives as an `Error`. `scheduler` in `node:timers/promises` calls
the global `scheduler.wait`, as on workerd.

### [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

- celld implements `node:assert`, `node:async_hooks`, `node:buffer`,
  `node:diagnostics_channel`, `node:events`, `node:fs`, `node:os`, `node:path`,
  `node:stream`, `node:timers/promises`, and `node:util`.
- `node:diagnostics_channel` does not export messages to a tail Worker.
- `node:crypto` does not implement Diffie-Hellman, streaming signatures,
  ciphers, RSA-PSS, or DSA signatures and key generation.
- `KeyObject.toCryptoKey()` applies the requested algorithm, extractability,
  and usages to an asymmetric key.
- `node:zlib` implements the synchronous functions `deflateSync`,
  `inflateSync`, `gzipSync`, `gunzipSync`, `deflateRawSync` and
  `inflateRawSync`, with workerd's `constants` and `codes`. Every other
  export of workerd's `node:zlib` exists, with the type it has there, but
  throws `node:zlib.<name> is not implemented in celld` when called: the
  callback forms, the `create*` functions and stream classes, `unzip`,
  `unzipSync`, `crc32`, Brotli and Zstandard. A namespace import also binds
  the Zstandard constants and `BROTLI_PARAM_SIZE_HINT`, which workerd puts
  only on the default export.
  - `level` and `maxOutputLength` are honoured. Output is capped at 128 MiB
    by default, so an inflate bomb fails with `RangeError: Memory limit
    exceeded`, and a `maxOutputLength` fails exactly where it fails on
    workerd, which grows its output buffer in 40 KiB steps.
  - `chunkSize` and `flush` are checked and, as in workerd's synchronous
    path, change nothing.
  - These throw: `windowBits` other than 15 (inflate and gunzip also accept
    0, which reads the window size from the stream), `memLevel` other than
    8, `strategy` other than `Z_DEFAULT_STRATEGY`, `finishFlush` other than
    `Z_FINISH`, `dictionary`, and `info`.
  - `gunzipSync` decodes at most 65,536 gzip members in one call and throws
    beyond that, so input of empty members cannot hold the thread for long.
    BGZF, the common multi-member format, needs 2,048 members for 128 MiB.
  - The compressed bytes come from miniz_oxide rather than zlib. They are
    valid streams that any inflater reads, but they differ from workerd's
    bytes. Decoding errors carry zlib's messages, except that corrupt
    deflate data reports workerd's fallback, `Zlib error`, rather than
    zlib's specific reason.
- `node:fs` provides `access`, `mkdir`, `realpath`, `stat`, `lstat`, and
  `readFile`. It exposes an empty, request-local `/tmp` and a read-only
  `/bundle` that contains the Worker modules.
- The global `process` matches workerd for each field that it defines, such
  as `process.execPath`, `process.argv`, and `process.title`. Other fields,
  such as `process.kill` and `process.features`, are undefined. celld
  defines `process` whatever the flags say, where workerd has it only with
  Node.js compatibility.
- `node:process` and `process` resolve to the global `process`, as its
  default export and as named exports. `process.getBuiltinModule("process")`
  also returns the global, where workerd returns a separate object with the
  same fields.
- `process.env` holds the Worker's `vars` under
  `nodejs_compat_populate_process_env` (see
  [Compatibility flags](#compatibility-flags)), copied before the main module
  evaluates. A string var appears as it is, and a JSON var as the text
  `JSON.stringify` gives, so `process.env.ADMINS` is `'["admin"]'` where
  `env.ADMINS` is an array. A `.dev.vars` or `.env` entry under `celld dev`
  appears as a string. celld secrets are vars, so they appear too, as
  Cloudflare secrets do. Other bindings don't appear. A Dynamic Worker's
  `process.env` comes from the `env` its parent gives it, under the Dynamic
  Worker's own compatibility date and flags, never from the parent's vars.
  As in Node.js, a value stored in `process.env` reads back as a string, and
  changes stay in the isolate.
- The celld bundler supports a synchronous CommonJS `require()` of a Node.js
  built-in module. A raw ESM Worker has no global `require()`.
- A Node.js built-in module object is writable, so a dependency such as
  `graceful-fs` can patch it at load. The patch stays in its isolate.
- An import of another Node.js module succeeds, but its first call throws an
  error.

### [Cache](https://developers.cloudflare.com/workers/runtime-apis/cache/)

celld provides an always-miss cache because it has no shared edge cache.
`put()` validates and consumes a response but stores nothing, `match()` returns
`undefined`, and `delete()` returns `false`.

### [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

- A socket belongs to the request or Durable Object that opened it, and its
  streams refuse every other one with workerd's I/O error
  ([TCP socket ownership](security.md#tcp-socket-ownership)). A Durable
  Object keeps using a socket across its events. A socket no object refers
  to any more closes.
- Another owner's `close()` resolves and leaves the socket as it was. In
  workerd it also leaves the socket's `closed` rejected and its writable
  closing.
- `startTls()`'s `opened` waits for the TLS handshake, and a failed handshake
  rejects it. In workerd it resolves first, and the first write fails with
  "Network connection lost.".
- A request or Durable Object holds at most `CELLD_MAX_TCP_SOCKETS` open
  sockets; see [limitations](limitations.md#tcp-sockets).
- celld verifies a TLS server against its bundled Mozilla root store.
- celld does not block the destination ports that Cloudflare blocks, and
  `connect()` can reach private addresses, which the
  [egress policy](security.md#limit-worker-egress) of `fetch()` refuses. Only
  the node's internal listener is refused to it. The fleet network controls
  where a socket can go.

### BroadcastChannel

The class exists so that a bundle can load, but its constructor throws.

## Compatibility flags

celld checks a Worker's `compatibility_date` and `compatibility_flags` when
`celld deploy` or `celld dev` builds it, and a Dynamic Worker's
`compatibilityDate` and `compatibilityFlags` when the Worker Loader loads it.
It refuses what workerd 1.20261001.1 refuses, with workerd's message:

- an unknown flag (`No such compatibility flag`), a flag named twice, or a
  flag with its disable flag (`Compatibility flags are mutually
  contradictory`)
- an invalid date, which must have the form `YYYY-MM-DD`, or a date in the
  future
- in a Dynamic Worker, any experimental flag, with workerd's message that
  the flag needs `--experimental`

It also refuses:

- a Worker without a `compatibility_date`, as Wrangler does
- a date after 2026-09-04, the newest date celld models, with workerd's
  message for a date newer than the binary supports
- an experimental flag in a Worker's configuration, which Cloudflare refuses
  too, except `js_rpc` and `service_binding_extra_handlers`
- a flag from the [refused flags](#refused-flags) list, which would select a
  behaviour that celld lacks

`celld deploy` reports every error. The Worker Loader rejects with the first,
as workerd does.

`Cloudflare.compatibilityFlags` is a sealed object without a prototype, as in
workerd. It holds each honoured flag with the value workerd computes, each
flag that celld always behaves as on, as `true`, where workerd computes it on
for the Worker's date and flags, and `sqlite_vec`. Other flags are absent.

### Honoured flags

celld follows these flags and the dates that turn them on:

- `nodejs_compat` and `no_nodejs_compat` (on from 2026-08-04), and
  `nodejs_compat_v2` and `no_nodejs_compat_v2` (on from 2026-08-04, or from
  2024-09-23 with `nodejs_compat`). They turn on
  `nodejs_compat_populate_process_env` and decide whether `process.env` is
  filled (see [Node.js compatibility](#nodejs-compatibility)). celld offers
  its Node.js modules and the `process` and `Buffer` globals with or without
  them.
- `nodejs_compat_populate_process_env` and
  `nodejs_compat_do_not_populate_process_env`, which `nodejs_compat` turns on
  from 2025-04-01. With Node.js compatibility, `process.env` holds the env's
  strings and JSON values. Without it, `process.env` stays empty, because
  workerd has no `process` to fill.
- `nodejs_als` and `no_nodejs_als`. celld offers `node:async_hooks` with
  `AsyncLocalStorage` with or without the flag.
- `rpc_params_dup_stubs` and `rpc_params_transfer_stubs` (on from
  2026-01-20). An RPC call duplicates the stubs in its params instead of
  transferring them, and a param with its own `dup()` crosses as what `dup()`
  returns. Return values transfer their stubs either way. This applies within
  one isolate (see [RPC](#rpc)).
- `allow_irrevocable_stub_storage`, which adds only a `ctx.restore()` that
  rejects (see [Context](#context)). Stubs still cannot be stored.
- `disallow_importable_env` and `allow_importable_env`. With the flag, `env`
  and `exports` from `cloudflare:workers` read every name as `undefined`.
- `service_binding_extra_handlers`, an experimental flag that celld honours
  only in part. With it, a service binding has `scheduled()` and `queue()`. `scheduled()` runs the target's
  `scheduled` handler for a binding to the Worker's own default export and
  throws for any other binding. `queue()` always throws, because celld does
  not implement it. Without the flag, both names are RPC methods.
- `fetcher_no_get_put_delete` and `fetcher_has_get_put_delete` (on from
  2024-03-26). Before, a service binding and a Durable Object stub have the
  `get()`, `put()`, and `delete()` helpers.
- `js_rpc`, an experimental flag: RPC to a Durable Object class that does not
  extend `DurableObject`.
- `queues_json_messages` and `no_queues_json_messages` (on from 2024-03-18):
  a queue message's default content type is `json`, otherwise `v8`.
- `delete_all_deletes_alarm` and `delete_all_preserves_alarm` (on from
  2026-02-24): `deleteAll()` also deletes the Durable Object's alarm.
- `websocket_standard_binary_type` and `no_websocket_standard_binary_type`
  (on from 2026-03-17): a WebSocket's `binaryType` starts as `"blob"`, and a
  binary message arrives as a `Blob`. Otherwise it starts as
  `"arraybuffer"`.
- `web_socket_auto_reply_to_close` and `web_socket_manual_reply_to_close`
  (on from 2026-04-07): a WebSocket accepted with `accept()`, or dialed,
  answers its peer's Close with the same code and reason before its close
  event fires, and is CLOSED then. Otherwise it is CLOSING until the Worker
  calls `close()`, and can still send until then; a request that ends first
  drops the connection, so the peer sees 1006. `accept({ allowHalfOpen })`
  chooses for one socket. A hibernatable socket never replies by itself, and
  is CLOSING in `webSocketClose`. A peer's Close without a status is
  answered with an empty Close, which `close()` without a code also sends.
- `assets_navigation_prefers_asset_serving` and
  `assets_navigation_has_no_effect` (on from 2025-04-01); see
  [Static assets](services/static-assets.md).
- The Python Workers flags `python_workers`, `python_workers_20250116`,
  `no_python_workers_20250116`, `python_no_global_handlers`,
  `disable_python_no_global_handlers`, `python_workers_force_new_vendor_path`,
  `enable_python_external_sdk`, `disable_python_external_sdk`,
  `python_request_headers_preserve_commas`,
  `disable_python_request_headers_preserve_commas`,
  `python_workflows_implicit_dependencies`,
  `no_python_workflows_implicit_dependencies`, `python_process_pth_files`,
  `disable_python_process_pth_files`, `python_workers_20260610`,
  `no_python_workers_20260610`, `python_workers_314`, and
  `no_python_workers_314`. `celld deploy` refuses a Python Worker that they
  put on another runtime than celld's (see
  [Python Workers](services/workers.md#python-workers)). They have no effect
  on a JavaScript Worker.
- `sqlite_vec`, celld's own flag, which Cloudflare does not have: it exposes
  the pre-v1 sqlite-vec extension to SQLite-backed Durable Objects.

### Flags without effect

celld accepts these flags, and they change nothing it does. celld always
behaves as these flags select:

- `formdata_parser_supports_files`: formData() returns a file field as a File.
- `fetch_refuses_unknown_protocols`: fetch() rejects a URL whose scheme is not http or https.
- `durable_object_fetch_requires_full_url`: a Durable Object stub's fetch() needs an absolute URL.
- `streams_byob_reader_detaches_buffer`: a BYOB read detaches the buffer it is given.
- `streams_enable_constructors`: the ReadableStream and WritableStream constructors take JavaScript sources and sinks.
- `workers_api_getters_setters_on_instance`: Request, Response and Headers carry their attributes as own instance properties, not prototype accessors.
- `url_standard`: URL follows the WHATWG URL Standard.
- `global_navigator`: navigator is defined.
- `capture_async_api_throws`: a promise-returning API rejects instead of throwing.
- `r2_public_beta_bindings`: R2 bindings have the public R2 API.
- `dont_substitute_null_on_type_error`: an API never substitutes null for an argument of the wrong type.
- `transformstream_enable_standard_constructor`: the TransformStream constructor follows the Streams Standard.
- `r2_list_honor_include`: R2 list() returns only the metadata `include` names.
- `no_web_socket_compression`: celld never negotiates permessage-deflate on a WebSocket.
- `response_redirect_url_standard`: Response.redirect() serializes its URL with the WHATWG URL Standard.
- `http_headers_getsetcookie`: Headers has getSetCookie() and iterates each Set-Cookie separately.
- `no_cf_botmanagement_default`: request.cf never has default botManagement data.
- `urlsearchparams_delete_has_value_arg`: URLSearchParams delete() and has() take a value argument.
- `strict_compression_checks`: DecompressionStream errors on trailing or truncated data.
- `strict_crypto_checks`: Web Crypto validates RSA sizes and exponents and public key usages.
- `crypto_preserve_public_exponent`: an RSA key's publicExponent is a Uint8Array.
- `no_global_importscripts`: importScripts is undefined.
- `unwrap_custom_thenables`: an API that takes a promise also accepts a thenable.
- `rpc`: service bindings and Durable Object stubs support RPC.
- `internal_stream_byob_return_view`: a BYOB read that ends a platform stream returns an empty view.
- `fetch_standard_url`: fetch() parses its URL with the WHATWG URL Standard.
- `legacy_module_registry`: celld does not implement workerd's new module registry.
- `cache_option_disabled`: the Request `cache` option throws.
- `allow_custom_ports`: fetch() uses the URL's port.
- `upper_case_all_http_methods`: a Request upper-cases a known method name.
- `cache_no_cache_disabled`: the Request `cache` option throws.
- `urlpattern_standard`: URLPattern follows the WHATWG URLPattern Standard.
- `enable_weak_ref`: WeakRef and FinalizationRegistry are defined.
- `no_request_signal_passthrough`: an incoming request's signal never reaches a subrequest.
- `enable_navigator_language`: navigator.language is defined.
- `allow_eval_during_startup`: eval() and new Function() work while the Worker starts.
- `enable_request_signal`: an incoming request's signal aborts when the client disconnects.
- `set_event_target_this`: an event listener runs with the EventTarget as `this`.
- `non_pedantic_wpt`: celld does not implement workerd's pedantic WPT mode.
- `expose_global_message_channel`: MessageChannel and MessagePort are globals.
- `strip_authorization_on_cross_origin_redirect`: fetch() drops Authorization when it follows a redirect to another origin.
- `legacy_error_serialization`: structuredClone() and RPC carry an Error's name, message, stack and cause, but not its other own properties.
- `enable_ctx_exports`: ctx.exports is defined.
- `mutable_api_prototypes`: API prototypes are mutable.
- `strip_bom_in_read_all_text`: Response.text() and Request.text() drop a leading byte order mark.
- `no_nodejs_global_timers`: the global setTimeout() and setInterval() return numbers, not Node.js Timeout objects.
- `text_decoder_replace_surrogates`: the UTF-16LE TextDecoder replaces a lone surrogate with U+FFFD.
- `containers_pid_namespace`: a container has its own PID namespace.
- `text_decoder_cjk_decoder`: TextDecoder decodes CJK encodings per the Encoding Standard.
- `websocket_close_reason_byte_limit`: WebSocket close() throws SyntaxError for a reason over 123 bytes.
- `writable_stream_spec_compliant_writer`: a WritableStream writer follows the Streams Standard on release.
- `no_encoder_stream_spec_compliant_backpressure`: TextEncoderStream and TextDecoderStream accept a write before their readable side is read.
- `workflows_preserve_non_retryable_error_message`: a NonRetryableError keeps its message and name.
- `resizable_array_buffer_in_blob`: Blob accepts a resizable ArrayBuffer.
- `diagnostics_channel_has_subscribers_getter`: diagnostics_channel's hasSubscribers is a getter.
- `workflows_disable_fast_engine_creation`: Workflow create() without an id names the instance with a random UUID.

These flags do not apply to celld:

- `minimal_subrequests`, `no_minimal_subrequests`: it changes only how Cloudflare's CDN treats subrequests.
- `no_cots_on_external_fetch`, `cots_on_external_fetch`: it selects only Cloudflare's origin trust store.
- `durable_object_alarms`: it is obsolete; alarms are always available.
- `export_commonjs_default`, `export_commonjs_namespace`: celld has no CommonJS module type; esbuild resolves require() when it bundles.
- `tcp_sockets_support`: it is obsolete; TCP sockets are always available.
- `dynamic_dispatch_tunnel_exceptions`, `dynamic_dispatch_treat_exceptions_as_500`: it applies to dispatch namespace bindings, which celld does not support.
- `vectorize_query_metadata_optional`, `vectorize_query_original`: it applies to Vectorize bindings, which celld does not support.
- `global_fetch_strictly_public`, `global_fetch_private_origin`: it chooses how Cloudflare routes a fetch() to the Worker's own zone, and celld has no zone; the egress policy applies whatever the flag says.
- `nodejs_zlib`, `no_nodejs_zlib`, `enable_nodejs_process_v2`, `disable_nodejs_process_v2`, `enable_nodejs_http_modules`, `disable_nodejs_http_modules`, `enable_nodejs_http_server_modules`, `disable_nodejs_http_server_modules`, `enable_nodejs_fs_module`, `disable_nodejs_fs_module`, `enable_nodejs_os_module`, `disable_nodejs_os_module`, `remove_nodejs_compat_eol`, `add_nodejs_compat_eol`, `enable_nodejs_http2_module`, `disable_nodejs_http2_module`, `remove_nodejs_compat_eol_v22`, `add_nodejs_compat_eol_v22`, `remove_nodejs_compat_eol_v23`, `add_nodejs_compat_eol_v23`, `remove_nodejs_compat_eol_v24`, `add_nodejs_compat_eol_v24`, `enable_nodejs_console_module`, `disable_nodejs_console_module`, `enable_nodejs_vm_module`, `disable_nodejs_vm_module`, `enable_nodejs_perf_hooks_module`, `disable_nodejs_perf_hooks_module`, `enable_global_performance_classes`, `disable_global_performance_classes`, `enable_nodejs_domain_module`, `disable_nodejs_domain_module`, `enable_nodejs_v8_module`, `disable_nodejs_v8_module`, `enable_nodejs_tty_module`, `disable_nodejs_tty_module`, `enable_nodejs_punycode_module`, `disable_nodejs_punycode_module`, `enable_nodejs_cluster_module`, `disable_nodejs_cluster_module`, `enable_nodejs_child_process_module`, `disable_nodejs_child_process_module`, `enable_nodejs_worker_threads_module`, `disable_nodejs_worker_threads_module`, `enable_nodejs_stream_wrap_module`, `disable_nodejs_stream_wrap_module`, `enable_nodejs_wasi_module`, `disable_nodejs_wasi_module`, `enable_nodejs_dgram_module`, `disable_nodejs_dgram_module`, `enable_nodejs_inspector_module`, `disable_nodejs_inspector_module`, `enable_nodejs_trace_events_module`, `disable_nodejs_trace_events_module`, `enable_nodejs_readline_module`, `disable_nodejs_readline_module`, `enable_nodejs_repl_module`, `disable_nodejs_repl_module`, `enable_nodejs_sqlite_module`, `disable_nodejs_sqlite_module`, `throw_on_not_implemented_tls_options`, `no_throw_on_not_implemented_tls_options`: celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility).
- `python_external_packages`: it is obsolete.
- `disable_top_level_await_in_require`, `enable_top_level_await_in_require`, `require_returns_default_export`, `require_returns_namespace`: celld has no run-time require() of a module; esbuild resolves it when it bundles.
- `request_cf_overrides_cache_rules`, `no_request_cf_overrides_cache_rules`: it changes only Cloudflare's cache rules, and celld has no edge cache.
- `unique_ctx_per_invocation`: it is obsolete; each invocation gets its own ctx.
- `cache_api_request_cf_overrides_cache_rules`, `no_cache_api_request_cf_overrides_cache_rules`: celld's Cache API stores nothing.
- `cache_api_compat_flags`, `no_cache_api_compat_flags`: it passes flags only to Cloudflare's cache, and celld's Cache API stores nothing.
- `python_workflows`, `disable_python_workflows`: celld does not run Workflows in Python Workers.
- `set_forwardable_email_full_headers`, `set_forwardable_email_single_headers`: it applies to Email Workers, which celld does not run.
- `enable_validate_workflow_entrypoint`, `disable_validate_workflow_entrypoint`: it adds checks to Cloudflare's upload; `celld deploy` applies its own Workflows checks whatever the flag says.
- `python_dedicated_snapshot`, `disable_python_dedicated_snapshot`, `python_check_rng_state`, `disable_python_check_rng_state`: celld takes no Python memory snapshots.
- `enable_email_sending_queuing`, `disable_email_sending_queuing`: it applies to send_email bindings, which celld does not support.
- `env_module_nullable_support`, `no_env_module_nullable_support`: it changes only withEnv() and withExports(), which celld does not implement.
- `cache_reload_disabled`, `no_precise_timers`, `streams_auto_allocate_chunk_size_default`, `no_spec_compliant_property_attributes`, `no_auto_inject_python_workers`: each turns off an experimental
  flag, which is off unless its enable flag is set.

### Refused flags

`celld deploy` refuses these flags, and the Worker Loader refuses them in a
Dynamic Worker's code. celld always behaves as the flag named after each:

- `formdata_parser_converts_files_to_strings` (as formdata_parser_supports_files), `fetch_treats_unknown_protocols_as_http` (as fetch_refuses_unknown_protocols), `durable_object_fetch_allows_relative_url` (as durable_object_fetch_requires_full_url), `streams_byob_reader_does_not_detach_buffer` (as streams_byob_reader_detaches_buffer), `streams_disable_constructors` (as streams_enable_constructors), `url_original` (as url_standard), `no_global_navigator` (as global_navigator), `do_not_capture_async_api_throws` (as capture_async_api_throws), `r2_internal_beta_bindings` (as r2_public_beta_bindings), `substitute_null_on_type_error` (as dont_substitute_null_on_type_error), `transformstream_disable_standard_constructor` (as transformstream_enable_standard_constructor), `response_redirect_url_original` (as response_redirect_url_standard), `no_http_headers_getsetcookie` (as http_headers_getsetcookie), `cf_botmanagement_default` (as no_cf_botmanagement_default), `no_urlsearchparams_delete_has_value_arg` (as urlsearchparams_delete_has_value_arg), `no_strict_compression_checks` (as strict_compression_checks), `no_strict_crypto_checks` (as strict_crypto_checks), `no_crypto_preserve_public_exponent` (as crypto_preserve_public_exponent), `global_importscripts` (as no_global_importscripts), `no_unwrap_custom_thenables` (as unwrap_custom_thenables), `no_rpc` (as rpc), `internal_stream_byob_return_undefined` (as internal_stream_byob_return_view), `fetch_legacy_url` (as fetch_standard_url), `ignore_custom_ports` (as allow_custom_ports), `no_upper_case_all_http_methods` (as upper_case_all_http_methods), `urlpattern_original` (as urlpattern_standard), `disable_weak_ref` (as enable_weak_ref), `disable_navigator_language` (as enable_navigator_language), `disallow_eval_during_startup` (as allow_eval_during_startup), `disable_request_signal` (as enable_request_signal), `no_set_event_target_this` (as set_event_target_this), `no_expose_global_message_channel` (as expose_global_message_channel), `retain_authorization_on_cross_origin_redirect` (as strip_authorization_on_cross_origin_redirect), `disable_ctx_exports` (as enable_ctx_exports), `do_not_strip_bom_in_read_all_text` (as strip_bom_in_read_all_text), `disable_text_decoder_replace_surrogates` (as text_decoder_replace_surrogates), `no_containers_pid_namespace` (as containers_pid_namespace), `disable_text_decoder_cjk_decoder` (as text_decoder_cjk_decoder), `no_websocket_close_reason_byte_limit` (as websocket_close_reason_byte_limit), `no_writable_stream_spec_compliant_writer` (as writable_stream_spec_compliant_writer), `workflows_replace_non_retryable_error_message` (as workflows_preserve_non_retryable_error_message), `no_diagnostics_channel_has_subscribers_getter` (as diagnostics_channel_has_subscribers_getter).

celld lacks the behaviour these flags select:

- `html_rewriter_treats_esi_include_as_void_tag`: HTMLRewriter parses <esi:include> as an element with an end tag.
- `workers_api_getters_setters_on_prototype`: Request, Response and Headers carry their attributes as own instance properties, not prototype accessors.
- `web_socket_compression`: celld never negotiates permessage-deflate on a WebSocket.
- `brotli_content_encoding`, `no_brotli_content_encoding`: celld neither encodes nor decodes a body by its Content-Encoding, gzip or br.
- `blob_standard_mime_type`, `blob_legacy_mime_type`: Blob.type lower-cases a body's Content-Type but normalizes it as neither flag state does.
- `new_module_registry`: celld does not implement workerd's new module registry.
- `cache_option_enabled`, `cache_no_cache_enabled`: the Request `cache` option throws.
- `internal_writable_stream_abort_clears_queue`, `internal_writable_stream_abort_does_not_clear_queue`: celld does not model when abort() clears a platform writable stream's queue.
- `handle_cross_request_promise_resolution`, `no_handle_cross_request_promise_resolution`: celld does not model which request a promise continuation runs in.
- `set_tostring_tag`, `do_not_set_tostring_tag`: only some of celld's API classes have their name as Symbol.toStringTag.
- `fixup-transform-stream-backpressure`, `original-transform-stream-backpressure`: celld's TransformStream lets a write settle before its readable side is read, as neither flag state does.
- `nonclass_entrypoint_reuses_ctx_across_invocations`: each event gets its own ctx.
- `queue_consumer_no_wait_for_wait_until`, `queue_consumer_wait_for_wait_until`: celld does not model when a queue consumer reports its outcome relative to waitUntil().
- `request_signal_passthrough`: an incoming request's signal never reaches a subrequest.
- `bind_asynclocalstorage_snapshot_to_request`, `do_not_bind_asynclocalstorage_snapshot_to-request`: celld does not tie an AsyncLocalStorage snapshot to the request that took it.
- `throw_on_unrecognized_import_assertion`, `ignore_unrecognized_import_assertion`: celld does not model unknown import attributes.
- `pedantic_wpt`: celld does not implement workerd's pedantic WPT mode.
- `enhanced_error_serialization`: structuredClone() and RPC carry an Error's name, message, stack and cause, but not its other own properties.
- `enable_fast_jsg_struct`, `disable_fast_jsg_struct`: celld does not model whether an API dictionary carries absent optional fields as undefined.
- `enable_streams_nodejs_v24_compat`, `disable_streams_nodejs_v24_compat`: celld does not model the Node.js 24 stream changes.
- `immutable_api_prototypes`: API prototypes are mutable.
- `fetch_iterable_type_support`, `no_fetch_iterable_type_support`, `fetch_iterable_type_support_override_adjustment`, `no_fetch_iterable_type_support_override_adjustment`: a Request or Response body stringifies an Array but iterates an async iterable, as neither flag state does.
- `enable_nodejs_global_timers`: the global setTimeout() and setInterval() return numbers, not Node.js Timeout objects.
- `queue_expose_error_codes`, `no_queue_expose_error_codes`: celld does not model the error codes queue operations carry.
- `unhandled_rejection_after_microtask_checkpoint`, `no_unhandled_rejection_after_microtask_checkpoint`: celld does not model when an unhandled rejection is reported.
- `encoder_stream_spec_compliant_backpressure`: TextEncoderStream and TextDecoderStream accept a write before their readable side is read.
- `no_resizable_array_buffer_in_blob`: Blob accepts a resizable ArrayBuffer.
- `auto_grpc_convert`: celld does not convert a gRPC-web subrequest to gRPC.
- `workflows_enable_fast_engine_creation`: Workflow create() without an id names the instance with a random UUID.
- `spec_compliant_dispatch_exceptions`, `no_spec_compliant_dispatch_exceptions`: celld does not model how dispatchEvent() reports a listener's exception.
- `durable_object_io_tasks_prevent_eviction`, `durable_object_io_tasks_do_not_prevent_eviction`: celld does not model eviction protection for a Durable Object's waitUntil() tasks.
- `webcrypto_modern_algorithms`: Web Crypto has no ML-KEM or ML-DSA.

### Differences selected by compatibility date

celld implements one behaviour for each of these flags, so a Worker can get
a behaviour on Cloudflare that celld lacks.

#### From a date

From these dates Cloudflare gives a Worker the flag's behaviour. celld
behaves as before the date:

- `workers_api_getters_setters_on_prototype`, from 2022-01-31: Request, Response and Headers carry their attributes as own instance properties, not prototype accessors.
- `web_socket_compression`, from 2023-08-15: celld never negotiates permessage-deflate on a WebSocket.
- `brotli_content_encoding`, from 2024-04-29: celld neither encodes nor decodes a body by its Content-Encoding, gzip or br.
- `blob_standard_mime_type`, from 2024-06-03: Blob.type lower-cases a body's Content-Type but normalizes it as neither flag state does.
- `cache_option_enabled`, from 2024-11-11: the Request `cache` option throws.
- `internal_writable_stream_abort_clears_queue`, from 2024-09-02: celld does not model when abort() clears a platform writable stream's queue.
- `handle_cross_request_promise_resolution`, from 2024-10-14: celld does not model which request a promise continuation runs in.
- `set_tostring_tag`, from 2024-09-26: only some of celld's API classes have their name as Symbol.toStringTag.
- `fixup-transform-stream-backpressure`, from 2024-12-16: celld's TransformStream lets a write settle before its readable side is read, as neither flag state does.
- `cache_no_cache_enabled`, from 2025-08-07 with cache_option_enabled: the Request `cache` option throws.
- `bind_asynclocalstorage_snapshot_to_request`, from 2025-06-16: celld does not tie an AsyncLocalStorage snapshot to the request that took it.
- `throw_on_unrecognized_import_assertion`, from 2025-06-16: celld does not model unknown import attributes.
- `enhanced_error_serialization`, from 2026-04-21: structuredClone() and RPC carry an Error's name, message, stack and cause, but not its other own properties.
- `enable_fast_jsg_struct`, from 2025-12-03: celld does not model whether an API dictionary carries absent optional fields as undefined.
- `fetch_iterable_type_support`, from 2026-02-19: a Request or Response body stringifies an Array but iterates an async iterable, as neither flag state does.
- `fetch_iterable_type_support_override_adjustment`, from 2026-01-15 with fetch_iterable_type_support: a Request or Response body stringifies an Array but iterates an async iterable, as neither flag state does.
- `enable_nodejs_global_timers`, from 2026-02-10 with nodejs_compat: the global setTimeout() and setInterval() return numbers, not Node.js Timeout objects.
- `queue_expose_error_codes`, from 2026-03-12: celld does not model the error codes queue operations carry.
- `unhandled_rejection_after_microtask_checkpoint`, from 2026-03-03: celld does not model when an unhandled rejection is reported.
- `encoder_stream_spec_compliant_backpressure`, from 2026-03-24: TextEncoderStream and TextDecoderStream accept a write before their readable side is read.
- `workflows_enable_fast_engine_creation`, from 2026-08-11: Workflow create() without an id names the instance with a random UUID.

#### Before a date

Before these dates Cloudflare gives a Worker the behaviour without the
flag. celld behaves as from the date:

- `formdata_parser_supports_files` (2021-11-03), `fetch_refuses_unknown_protocols` (2021-11-10), `durable_object_fetch_requires_full_url` (2021-11-10), `streams_byob_reader_detaches_buffer` (2021-11-10), `streams_enable_constructors` (2022-11-30), `url_standard` (2022-10-31), `global_navigator` (2022-03-21), `capture_async_api_throws` (2022-10-31), `dont_substitute_null_on_type_error` (2022-06-01), `transformstream_enable_standard_constructor` (2022-11-30), `r2_list_honor_include` (2022-08-04), `response_redirect_url_standard` (2023-03-14), `http_headers_getsetcookie` (2023-03-01), `no_cf_botmanagement_default` (2023-08-01), `urlsearchparams_delete_has_value_arg` (2023-07-01), `strict_compression_checks` (2023-08-01), `strict_crypto_checks` (2023-08-01), `crypto_preserve_public_exponent` (2023-12-01), `no_global_importscripts` (2024-03-04), `unwrap_custom_thenables` (2024-04-01), `rpc` (2024-04-03), `internal_stream_byob_return_view` (2024-05-13), `fetch_standard_url` (2024-06-03), `allow_custom_ports` (2024-09-02), `upper_case_all_http_methods` (2024-10-14), `urlpattern_standard` (2025-05-01), `enable_weak_ref` (2025-05-05), `enable_navigator_language` (2025-05-19), `allow_eval_during_startup` (2025-06-01), `set_event_target_this` (2025-08-01), `expose_global_message_channel` (2025-08-15), `strip_authorization_on_cross_origin_redirect` (2025-09-01), `enable_ctx_exports` (2025-11-17), `strip_bom_in_read_all_text` (2026-01-13), `text_decoder_replace_surrogates` (2026-02-24), `containers_pid_namespace` (2026-04-01), `text_decoder_cjk_decoder` (2026-03-03), `websocket_close_reason_byte_limit` (2026-03-03), `writable_stream_spec_compliant_writer` (2026-03-24), `workflows_preserve_non_retryable_error_message` (2026-05-14), `diagnostics_channel_has_subscribers_getter` (2026-05-19).

#### Whatever the date

These flags have no date, so Cloudflare gives every Worker that does not
set them the behaviour without the flag. celld always behaves as with the
flag:

- `enable_request_signal`: an incoming request's signal aborts when the client disconnects.

## Wrangler configuration

`celld deploy` accepts `wrangler.jsonc` or `wrangler.json`, not
`wrangler.toml`.

The `name` value must contain 1 to 63 lowercase ASCII letters, digits, or
internal hyphens. It cannot start or end with a hyphen.

The accepted top-level keys:

- `$schema`, `name`, `main`, and `no_bundle`
- `compatibility_date` and `compatibility_flags`
- `durable_objects` and `migrations`
- `assets`, `services`, `triggers`, and `vars`
- `d1_databases`, `kv_namespaces`, `queues`, `workflows`, and
  `r2_buckets`
- `worker_loaders` and `containers`
- `define`, `alias`, `rules`, and `build`
- `secrets`

These keys configure Cloudflare's platform rather than the Worker, so the
Worker runs the same with or without them. `celld deploy` checks each against
Wrangler 4.147's config schema, so an unknown nested key or a wrong type
stops the deployment, and then ignores it, with one line on stderr when the
value asks for something celld does not do:

| Key | Line on stderr |
| --- | --- |
| `observability` | Always. Telemetry is operator-controlled with `CELLD_OTEL`; see [Telemetry](telemetry.md) |
| `workers_dev`, `preview_urls` | A warning when `true`: celld has no workers.dev or preview URLs. Nothing when `false` |
| `account_id`, `keep_vars` | Never |
| `upload_source_maps`, `minify` | When `true`: celld deploys no source maps, and does not minify |
| `placement` | Unless `mode` is `"off"`: celld runs a Worker on the node that receives its request |
| `dev` | Always: it configures `wrangler dev`, and `celld dev` takes its options on the command line |

Any other top-level key stops the deployment. `routes` and `route` stop it
with an explanation: celld does not route Cloudflare zones or custom
domains. A node serves the Worker deployed last for every hostname, and
other Workers through service bindings, so a proxy in front of the nodes
chooses hostnames.

`vars` values can be strings or any other JSON value, as in Wrangler. A
string becomes a `plain_text` binding, and any other value a `json` binding,
which each isolate parses with `JSON.parse`, as workerd does: `env.NAME` is
an ordinary, mutable value of that isolate, with the config's key order. A
JSON var can be at most 5 KiB (5,120 bytes) as compact JSON, Cloudflare's
5 KB variable size limit; celld does not apply that limit to string vars.
A `celld dev` dotenv entry is always a string, also when it replaces a JSON
var, as in `wrangler dev`.

celld has no secret store, so a secret is a var: it is stored in plaintext
with the deployment, and anyone who can read the fleet bucket can read it.
Each name in `secrets.required` must be set by `vars`, or, under `celld dev`,
by `.dev.vars`, the `.env` files or the environment; otherwise the deployment
stops. `wrangler dev` only warns about a missing secret. As in `wrangler dev`,
a config that declares `secrets` takes from `.dev.vars` or the `.env` files
only its vars and its required secrets, and ignores their other entries; the
environment is read only without a `.dev.vars`, and wins over the `.env`
files. `secrets` accepts only `required`.

`build.command` runs with `sh -c` before celld reads `main`, in
`build.cwd`, which defaults to the config's directory, with
`WRANGLER_COMMAND` set to `deploy` or `dev`, as Wrangler sets it. Wrangler resolves
`build.cwd` against the directory it runs in instead, which is the same when
you run it beside the config. The command's stdout and stderr go to stderr,
so the JSON that `celld deploy --json` and `celld dev` print on stdout stays
clean, and it gets no stdin. A command that fails, or that a signal stops,
stops the deployment, and the shell is killed if celld dies. `--no-build`, on
`celld deploy` and `celld dev`, skips the command, for a project built already.
`celld dev` also watches `build.watch_dir` (default `src`); see
[Develop an application locally](README.md#develop-an-application-locally).
The command comes from the deployer's own config and runs as the deployer,
with the deployer's environment, as `wrangler deploy` and the project's
`package.json` scripts do. Do not deploy a config you do not trust.

A `services` entry accepts `binding`, `service`, `entrypoint`, `props` (a
JSON object that encodes to at most 1 MiB), and `remote` and `dev`, which only affect
`wrangler dev`. A `durable_objects` binding accepts `name`, `class_name`, and
`remote`. Any other key in either, including `environment` and a Durable
Object's `script_name`, stops the deployment. See
[service bindings](services/workers.md#service-bindings) and
[Durable Objects](services/durable-objects.md#differences-from-cloudflare).

`define` and `rules` go to the esbuild run. Each `define` value is a
JavaScript expression, as in Wrangler. A rule `type` must be `Text`, `Data`,
or `CompiledWasm`, and each glob must have the form `**/*.ext` or `*.ext`,
because esbuild selects a loader by extension. Two rules that give one
extension different types stop the deployment. `fallthrough` works as in
Wrangler: the first rule of a type without `fallthrough: true` drops every
later rule of that type, with a warning unless it sets `fallthrough: false`.
celld applies `CompiledWasm` to `**/*.wasm` after the configured rules, as
Wrangler's default rule, so only that type is valid for `.wasm`, and a
`CompiledWasm` rule without `fallthrough: true` drops it. celld has no other
default rule: Wrangler's `Text` rule for `.html` and `.sql` and `Data` rule
for `.bin` need a configured rule.
`alias` works as in Wrangler, through the same esbuild plugin: it must be an
object of strings. Each key is an import path, relative ones included, and an
import of exactly that path, from any file, gets the module its value names.
An import that only starts with a key, such as `pkg/sub` for the key `pkg`,
resolves as usual. The value is resolved with Node's `require.resolve` from
the config's directory, when its key is first imported: a path, with Node's
file probing (`.js`, `.json`, `.node`, a directory's `package.json` `main` or
its `index`), or a package by its `exports` under Node's `require` conditions.
A target that does not resolve fails the build with Node's error, and a
Node.js builtin as a target fails it with esbuild's. An empty value aliases
nothing. An alias of a Node.js builtin, such as `node:path`, wins over the
runtime's module. The resolution follows the conditions that
`NODE_OPTIONS` adds with `--conditions` or `-C`, and `--no-addons`, as
Wrangler's Node does; `NODE_OPTIONS` with `--preserve-symlinks` or
`--no-require-module` stops the build. celld refuses the key `__proto__`,
which Wrangler's config parser drops, and `alias` in a Python Worker: esbuild
bundles only celld's JavaScript shell around a Python Worker, not its Python
code. The resolution does not search Node's global folders (`NODE_PATH`,
`~/.node_modules`), and it resolves `wrangler` from the project like any
package, where Wrangler resolves its own package first.
esbuild does not read `NODE_PATH` either, as under Wrangler, whose esbuild
API ignores it: an import that only `NODE_PATH` finds fails to resolve.
(celld ran esbuild's CLI before, which reads it.)
`no_bundle` skips esbuild, so `no_bundle` with `define`, `alias` or `rules`
stops the deployment.

An asset-only project can omit `main`. `celld deploy` refuses an unsafe asset
path, and `.assetsignore` requires Wrangler.

See [Limitations](limitations.md) for the operational limits.
