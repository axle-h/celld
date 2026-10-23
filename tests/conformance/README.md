# Conformance corpus

Each case runs a set of Workers through a list of steps on celld and on
workerd, the reference. Its transcript must match `expect.json`, which is
recorded from workerd.

## Running

```sh
cd tests/conformance
pnpm install                                 # wrangler 4.147.0 (workerd 1.20261001.1), esbuild, capnweb
cargo build --profile lab -p celld           # from the repository root
node run.mjs                                 # both runtimes (the default)
node run.mjs --runtime=celld                 # celld against expect.json
node run.mjs --runtime=workerd               # workerd against expect.json
node run.mjs --filter 'storage/*'            # only matching case ids; repeatable
node run.mjs --profile release               # run target/release/celld
node run.mjs --update                        # re-record expect.json from workerd
CONFORMANCE_REQUIRE=docker node run.mjs      # fail, not skip, a case that needs Docker when none answers
```

`--runtime=both` runs each differential case on workerd, checks workerd
still matches `expect.json`, then diffs celld against workerd's live
transcript.

The runner exits 1 when a case fails or passes unexpectedly, and 2 when a
case is malformed or the setup is incomplete. Each run works in a copy of the
case under `.run/`, which is deleted unless the case fails.

- On celld, the runner starts `target/<profile>/celld dev --no-watch --clean
  --port 0 -c <first worker> -c …` and reads the ready line from stdout. The
  node gets the shell's environment without `CELLD_OTEL*`, `OTEL_*` and
  `CELLD_FETCH_PRIVATE_ALLOW`, and with the case's `env`. Any
  other line on stdout fails the case: stdout carries only ready records. When
  the steps finish, it sends `POST /shutdown?handoff=preserve` to the
  internal origin. `CELLD_ESBUILD` points at this package's esbuild.
- On workerd, it uses wrangler's `createTestHarness`.

## Adding a case

Create `cases/<area>/<case>/` with:

- `workers/<name>/wrangler.jsonc` and the Worker's source, one directory per
  Worker
- `case.json`, as described below

Then run `node run.mjs --update --filter <area>/<case>`, read the recorded
`expect.json`, and commit it with the case. `--update` runs the case twice on
workerd and refuses to record if the two transcripts differ, so a
nondeterministic case shows up when it is recorded. A case runs as it would under
`wrangler dev -c`, so a Worker can import `capnweb` from this package's
`node_modules`, and the modules this package's `package.json` names under
`imports`: `#byob` is `lib/worker/byob.js`, the BYOB reader checks the
`streams/byob-*` cases share, and `#params-dup` is `lib/worker/params-dup.js`,
the stub-ownership checks the `rpc/params-dup*` cases run under different
compatibility dates and flags, `#process-env` is
`lib/worker/process-env.js`, the `process.env` report each
`node/process-env` Worker gives under its own date and flags,
`#ws-close-reply` is `lib/worker/ws-close-reply.js`, the WebSocket close
replies the `flags/websocket-*-reply` cases check under different flags, and
`#clone` is `lib/worker/clone.js`, the `Response.clone()` and
`Request.clone()` checks the `fetch/*-clone*` cases run on each source.

```json
{
  "kind": "differential",
  "workers": ["front", "back"],
  "env": { "CELLD_FETCH_PRIVATE_ALLOW": "127.0.0.1:${UPSTREAM_PORT}" },
  "upstream": true,
  "xfail": "1.7",
  "steps": [
    { "path": "/run" },
    { "path": "/items", "method": "POST", "headers": { "content-type": "text/plain" }, "body": "x" },
    { "path": "/upload", "method": "POST", "body": "x", "chunked": true },
    { "path": "/login", "responseHeaders": ["location"] },
    { "ws": "/socket", "send": ["a"], "close": 1000 },
    { "ws": "/chat", "protocols": ["chat.v2", "chat.v1"], "send": ["a"] },
    { "restart": true }
  ],
  "normalize": [{ "pattern": "id-[0-9a-f]{32}", "replace": "id-<id>", "why": "ids are random" }]
}
```

- `workers` lists the Worker directories. The first is the primary, which
  receives the steps' requests.
- `env` sets environment variables for the `celld dev` process. Names must
  be valid environment variable names. workerd
  doesn't use it. Telemetry variables (`CELLD_OTEL*`, `OTEL_*`) are refused:
  the runner sets them, from `observability`.
- `upstream` (default `false`) starts the runner's local HTTP server,
  `lib/upstream.mjs`, for the case's Workers to fetch as "the network". It
  listens on two loopback ports. `/bounce` answers 302 to
  `/landed?from=bounce`, `/landed` answers `{"landed": <query>}`,
  `/redirect?to=<url>&status=<code>` answers that status (302 by default) to
  that URL, `/chain?n=<n>` redirects `n` times and lands, `/loop` redirects
  to itself, `/echo` answers JSON describing the request it received,
  `/big?kib=<n>` answers `n` KiB, and every other path answers `upstream`. A WebSocket upgrade to
  `/redirect?to=<url>` answers 302 to that URL, and one to `/chain?n=<n>`
  redirects `n` times and lands on `/ws/close-first`. A WebSocket upgrade to
  `/ws/close-first?id=<id>` (with optional `code` and `reason`) sends the
  server's Close at once and records the reply, which `/ws/log?id=<id>`
  answers as JSON once the connection ends. A WebSocket upgrade to
  `/ws/silent` is accepted, and the server never sends anything, not even a
  reply to a Close. One to `/ws/stall` is accepted, and the server never
  reads either.
  celld's egress policy refuses loopback, so a case that fetches
  the upstream on celld allows it in `env`, as in
  `"CELLD_FETCH_PRIVATE_ALLOW": "127.0.0.1:${UPSTREAM_PORT}"`.
- Placeholders name the ports the runner picks for a run, in `env` values and
  in `path` and `ws` steps:
  - `${UPSTREAM_PORT}` and `${UPSTREAM_PORT_2}`: the upstream's two ports.
    They need `"upstream": true`.
  - `${PUBLIC_PORT}`: celld's public listener, for a Worker that fetches its
    own origin and has to allow it. The runner picks a free port and passes it
    as `--port`, so another process can take it first. It needs a
    `celld-only` case.
  - `${INTERNAL_PORT}`: celld's operator listener, passed as
    `--internal-port` in the same way. It needs a `celld-only` case.

  The runner writes each port back as its placeholder wherever the transcript
  has it after a `:` or a `=`, as it writes the origin as `http://origin.test`.
- `observability` (default `false`) turns tracing on for both runtimes. On
  celld the runner starts an OTLP/HTTP receiver (`lib/otlp.mjs`) and sets
  `CELLD_OTEL` to it, with `CELLD_OTEL_FLUSH_MS=100`; otherwise it clears
  every telemetry variable the shell has. On workerd it sets wrangler's
  `X_LOCAL_OBSERVABILITY`, which attaches Miniflare's trace collector. So
  `tracing` spans report `isTraced: true` on both runtimes with it, and
  `false` on both without it.
- `requires` lists what the case needs of the machine beyond the runner's
  own dependencies. The only requirement is `"docker"`: a container engine
  that `docker info` reaches (or the CLI that `CELLD_DOCKER` names, such as
  `podman`), as `celld dev` uses to build a container image. The runner
  checks each requirement once per run. A case whose requirement is missing
  reports `SKIP` with the reason, unless the comma-separated
  `CONFORMANCE_REQUIRE` environment variable names that requirement: then it
  reports `FAIL`. CI sets `CONFORMANCE_REQUIRE=docker`, so a container case
  never skips there. A case's image pins its base image by digest.
- `normalize` rewrites matches of a regular expression in every string value
  of the transcript. It doesn't touch numbers, booleans or object keys. Use it only for values that differ from run to run, such as
  random ids or timestamps, and say why in `why`. The runner itself rewrites
  the origin it connected to as `http://origin.test`, because both runtimes
  listen on a random port.

The runner refuses unknown keys and malformed values. It also refuses fields
whose support hasn't landed yet: `nodes` greater than 1 or a step's `node`
(multi-node).

### Steps

- **`path`**: an HTTP request to the primary. `method`, `headers` and `body`
  are optional. A step whose `headers` name a `sec-fetch-` header, such as
  `"sec-fetch-mode": "navigate"`, goes out through `node:http`, because
  `fetch()` sends its own `sec-fetch-mode`; it takes only a string body.
  `"chunked": true` sends the body with no length, so celld streams it to
  the Worker instead of holding it as bytes. The client does not follow
  redirects. The transcript records the status and the body, parsed as JSON
  when the response says it is JSON.
  `responseHeaders` (lower-case names, such as `["location"]`) also records
  those response headers, `null` when absent.
- **`ws`**: opens a WebSocket and sends the `send` frames.
  - With `close`, the client waits for `receive` frames, or one frame per
    frame sent by default. It then closes with that code.
  - Without `close`, the step waits for the server to close.
  - `protocols` (optional) offers those subprotocols, and the transcript
    then also records the one the server selected as `protocol`.

  - `"close": null` closes with no status code, an empty Close, which the
    server reads as 1005.
  - `"raw": true` uses a raw socket that keeps reading after the client's
    Close, because Node's WebSocket drops frames that arrive after it. It
    records binary frames as Node's does, and fails the step on a fragmented
    message. The transcript then also has the frames the server sent before
    its reply,
    its Close (`null` without one), and `ended`: whether the server ended
    the connection within 3 s. `"shutdown": true` also shuts down the
    client's side of the connection (FIN) after its Close. A Close the
    server sends first gets the same code back, and a client that shut down
    its side no longer answers a Ping. Neither takes `protocols`.
  - `"stall": <ms>` (up to 20000) makes the raw client read nothing for
    that long once its frames are sent, as a peer that reads too slowly
    does. A stalled client records a connection the server ended first,
    instead of failing the step.
  - `"record"` says what a raw step's transcript keeps of the frames it
    received: all of them (`"frames"`, the default), `{"count", "bytes"}`
    (`"count"`), or nothing (`"none"`).
  - `"reset": <ms>` (up to 20000) makes the raw client read nothing after
    its Close and reset the connection (RST) that long after, as a peer that
    goes away does. The transcript then has only `{"reset": true}`.
  - `"repeat": <n>` (up to 100000) makes a raw client send each frame of
    `send` that many times, in one write.
  - `"drop": true` ends the connection without a Close once the frames are
    sent (FIN), and reads nothing more. The transcript has only `ended`:
    whether the server ended the connection within 3 s. It takes neither
    `close` nor `receive`.

  The transcript records the frames received and the close code and reason.
  A text frame is recorded as a string, and a binary frame as
  `{"binary": "<base64>"}`. A refused upgrade fails the step, because Node's
  WebSocket doesn't expose the response. Use a `path` step to the same URL to
  record what the server answered.
- **`restart`**: stops the runtime with its storage kept and starts it
  again.
  - On celld: `POST /shutdown`, then the same command without `--clean`.
  - On workerd: the harness's `update()` with unchanged options. Miniflare
    replaces the workerd process and keeps the storage directory. The
    harness can't reopen another harness's storage, because it hard-codes
    `persist: false`.

- **`rss`**: `{"rss": "baseline"}` resets the celld node's peak resident
  memory (`/proc/<pid>/clear_refs`) and notes where it stands; a later
  `{"rss": 96}` checks that the peak has grown by at most 96 MiB since. The
  transcript records the verdict, `"baseline"` or `"grew at most 96 MiB"`,
  and the growth only when it is over. The step needs `"kind": "celld-only"`.

- **`cpu`**: `{"cpu": 300}` measures the CPU time all the celld node's
  threads use in one second while the case sends nothing, and checks it is
  at most 300 ms. `"wait": <ms>` (up to 90000) leaves the node alone that long
  first. The transcript records the verdict, `"at most 300 ms in 1 s"`, and
  the time only when it is over. A task that spins shows as most of a core.
  The step needs `"kind": "celld-only"`.

- **`sockets`**: counts the celld node's TCP connections to the ports the
  case opened: the upstream's, and the client ports of its raw `ws` steps.
  Listeners and the runner's own HTTP connections are not counted. It also
  counts the node's sockets opened since the baseline that no protocol table
  of `/proc/<pid>/net` lists, such as a connection that a reset removed from
  the TCP table while the node kept its fd.
  `{"sockets": "baseline"}` notes the count, and a later `{"sockets": 0}`
  waits up to `within` ms (5000 by default, at most 30000) for the node to
  hold at most that many more. It records `"at most 0 more"`, or how many
  more it held. It shows a connection the node kept after its peer or its
  owner left. The step needs `"kind": "celld-only"`.

- **`otlp`**: `{"otlp": {"spans": ["celld.fetch", "outer"]}}` waits until
  celld has exported spans with those names (a name listed twice waits for
  two), then until nothing more arrives for 500 ms. It records everything
  exported since the previous `otlp` step as trees: each span's name, kind,
  status, attributes, exception events, log lines and children. ids, times
  and the per-run attributes (`celld.request_id`, `celld.isolate`,
  `celld.queue_wait_us`, `celld.epoch`) are left out; a span whose parent was
  not exported is a root marked `"parent": "remote"` if it had one. Siblings
  sort by content. The step needs `"kind": "celld-only"` and
  `"observability": true`: workerd's spans go to Miniflare's collector, which
  the runner doesn't read.

- **`deploy`**: `{"deploy": "<worker>", "args": ["--no-build"]}` runs
  `celld deploy --dry-run --json` on that worker's `wrangler.jsonc`, from the
  case's directory, with `env`. `args` is optional, and `--no-build` is the
  only flag it takes. The transcript records the exit code, the `worker` the
  JSON row names (`null` on failure), and stderr's non-empty lines as
  `output`. The runner rewrites the case directory as `<case>`, the celld
  version line as ` celld <version>`, sizes as `<size>` and times as
  `(<time>)`, so a celld release or a bundle change does not change the
  transcript. A case with `deploy` steps must be `celld-only` and have only
  `deploy` steps: it starts no node, so its configs can be ones `celld deploy`
  refuses, and `observability` is refused.

### Steps that close the connection

workerd closes the connection after some requests, such as one whose Worker
cancels a chunked request body, or reads part of a body sent with a length
and then cancels it. A step like that must be the last step of its case,
because otherwise the next step can fail on workerd. wrangler's harness puts
a proxy, a second workerd running wrangler's `ProxyWorker`, in front of the
case's Workers, and that proxy re-sends each request over a pool of
keep-alive connections. The pool can hand the closed connection to the next
request, which then fails with a 500 response from Miniflare's entry Worker:
`Error: Network connection lost.` This happens on whatever connection the
runner opens, so `connection: close` on the step does not help. Give each
such step a case of its own, as `streams/byob-request-body-held-cancel` and
`streams/byob-request-body-streamed-reader` do.

### Kinds

- **`differential`** (the default): `expect.json` is recorded from workerd
  with `--update`. Its header names the workerd and wrangler versions. A
  differential case fails on a different installed workerd until it is
  re-recorded. Use this kind whenever workerd can run the scenario.
- **`celld-only`**: for behaviour workerd can't show locally, such as OTLP
  export, the egress policy (`fetch-public/*`), deploy refusals, multi-node or
  celld limits.
  `reason` is required and says why. `expect.json` is written by hand and
  reviewed. `--update` and `--runtime=workerd` skip these cases.
  A celld-only case that workerd can run, but wrangler's harness can't show,
  can be recorded from workerd run directly. `fetch/redirect-follow` is one:
  the harness follows every global `fetch()` redirect in Node. Give the case
  a `workerd.capnp` beside `case.json`, a workerd config whose socket is
  named `http`, and run `node lib/workerd-direct.mjs <case> --write`. It
  starts the upstream, runs `workerd serve` on that config with the socket on
  a free port, runs the case's `path` steps as the runner does, and writes
  `expect.json` with the workerd version it came from. Review the result
  before committing it.

### Expected failures

`"xfail": "<plan item>"` marks a case that celld can't pass yet. It reports
`XFAIL` with the item. If the case passes, the runner reports `XPASS` and
fails the run, so the marker comes out in the change that fixes celld. xfail
covers celld only: workerd must still match `expect.json`.
