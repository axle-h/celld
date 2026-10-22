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
- An `AbortSignal` in a Durable Object RPC call does not cross a node boundary.
- A remote RPC retries only when the failed peer attempt did not start the
  method. Use a stable operation ID for an application retry.

### [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)

- celld expires an unclaimed and inactive HTTP stream after 60 seconds. A
  successful stream operation starts a new 60-second period.
- An expired or unknown stream reports an error instead of EOF.
- A default reader on a platform stream (a request or response body, an R2
  object's or a KV value's body, `Blob.stream()`, a compression stream's
  output, or a stream received over RPC) accepts several pending reads, and a
  cancel ends a pending read as done, except on a compression stream. workerd
  allows one read at a time and rejects the pending read. BYOB readers on
  these streams behave as in workerd.

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
- A socket accepted from such a response forwards a Close the Worker sends
  and waits 10 seconds for the other side's reply. The Worker then sees code
  1006.
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
- celld does not block the destination ports that Cloudflare blocks, and
  `connect()` can reach private addresses, which the
  [egress policy](security.md#limit-worker-egress) of `fetch()` refuses. Only
  the node's internal listener is refused to it. The fleet network controls
  where a socket can go.

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
- `nodejs_als`. celld offers `node:async_hooks` with `AsyncLocalStorage`
  with or without the flag.

`global_fetch_strictly_public` has no effect by design. On Cloudflare it
decides whether a `fetch()` to the Worker's own zone goes to the zone's origin
server. celld has no zone origin, and its
[egress policy](security.md#limit-worker-egress) applies whatever the flag
says.

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
- `define`, `rules`, and `build`
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
`no_bundle` skips esbuild, so `no_bundle` with `define` or `rules` stops the
deployment.

An asset-only project can omit `main`. `celld deploy` refuses an unsafe asset
path, and `.assetsignore` requires Wrangler.

See [Limitations](limitations.md) for the operational limits.
