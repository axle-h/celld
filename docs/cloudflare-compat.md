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
  `observability` settings do not turn tracing on or off.
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

- An RPC stub cannot cross an isolate boundary.
- An `AbortSignal` in a Durable Object RPC call does not cross a node boundary.
- A remote RPC retries only when the failed peer attempt did not start the
  method. Use a stable operation ID for an application retry.

### [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)

- celld expires an unclaimed and inactive HTTP stream after 60 seconds. A
  successful stream operation starts a new 60-second period.
- An expired or unknown stream reports an error instead of EOF.

### [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

- An outbound Worker socket closes when its event and `waitUntil` work end. A
  socket returned in the response stays open.
- Each isolate-polled input queue has a 1 MiB budget for non-terminal frames. A
  message larger than 1 MiB uses the complete budget.
- If the isolate stops polling, celld discards unread frames during cleanup. A
  later pull reports an abnormal close.
- A WebSocket transport cannot move to a new cell owner. A client must reconnect
  with the same application operation ID.
- A tunneled connection forwards the owner's Close without an additional Close.
  If the owner connection fails between frames before a Close, the ingress sends
  code 1012. If a frame is incomplete, the ingress closes the transport instead.
- `acceptWebSocket()` throws above 90 percent of the V8 heap limit.
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

### [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

- celld implements `node:assert`, `node:async_hooks`, `node:buffer`,
  `node:diagnostics_channel`, `node:events`, `node:fs`, `node:os`, `node:path`,
  `node:stream`, `node:timers/promises`, and `node:util`.
- `node:diagnostics_channel` does not export messages to a tail Worker.
- `node:crypto` does not implement Diffie-Hellman, streaming signatures,
  ciphers, RSA-PSS, or DSA signatures and key generation.
- `KeyObject.toCryptoKey()` applies the requested algorithm, extractability,
  and usages to an asymmetric key.
- `node:zlib` implements only the synchronous gzip and deflate functions.
- `node:fs` provides `access`, `mkdir`, `realpath`, `stat`, `lstat`, and
  `readFile`. It exposes an empty, request-local `/tmp` and a read-only
  `/bundle` that contains the Worker modules.
- The global `process` matches workerd for each field that it defines, such
  as `process.execPath`, `process.argv`, and `process.title`. Other fields,
  such as `process.kill` and `process.features`, are undefined.
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

- A socket cannot outlive its event. A Durable Object must reconnect during a
  later event.
- celld verifies a TLS server against its bundled Mozilla root store.
- celld does not block the destination ports that Cloudflare blocks. The fleet
  network controls the egress policy.

### BroadcastChannel

The class exists so that a bundle can load, but its constructor throws.

## Compatibility flags

celld honors these compatibility flags:

- `delete_all_deletes_alarm`
- `js_rpc`
- `fetcher_no_get_put_delete`
- `sqlite_vec`
- `websocket_standard_binary_type`
- The static-assets navigation flags
- `allow_irrevocable_stub_storage`, which adds only a `ctx.restore()` that
  rejects (see [Context](#context)). Stubs still cannot be stored.

celld accepts every other flag without effect.
`Cloudflare.compatibilityFlags` reports only the honored flags.

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
- `define` and `rules`

Any other top-level key, including `routes`, stops the deployment.

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
extension different types stop the deployment. celld already applies
`CompiledWasm` to `**/*.wasm`, so only that type is valid for `.wasm`.
`no_bundle` skips esbuild, so `no_bundle` with `define` or `rules` stops the
deployment.

An asset-only project can omit `main`. `celld deploy` refuses an unsafe asset
path, and `.assetsignore` requires Wrangler.

See [Limitations](limitations.md) for the operational limits.
