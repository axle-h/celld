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
```

`--runtime=both` runs each differential case on workerd, checks workerd
still matches `expect.json`, then diffs celld against workerd's live
transcript.

The runner exits 1 when a case fails or passes unexpectedly, and 2 when a
case is malformed or the setup is incomplete. Each run works in a copy of the
case under `.run/`, which is deleted unless the case fails.

- On celld, the runner starts `target/<profile>/celld dev --no-watch --clean
  --port 0 -c <first worker> -c …` and reads the ready line from stdout. When
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
`node_modules`.

```json
{
  "kind": "differential",
  "workers": ["front", "back"],
  "env": { "CELLD_FETCH_PRIVATE_ALLOW": "127.0.0.1:9000" },
  "xfail": "1.7",
  "steps": [
    { "path": "/run" },
    { "path": "/items", "method": "POST", "headers": { "content-type": "text/plain" }, "body": "x" },
    { "ws": "/socket", "send": ["a"], "close": 1000 },
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
- `observability` (default `false`) turns tracing on for both runtimes. On
  celld the runner starts an OTLP/HTTP receiver (`lib/otlp.mjs`) and sets
  `CELLD_OTEL` to it, with `CELLD_OTEL_FLUSH_MS=100`; otherwise it clears
  every telemetry variable the shell has. On workerd it sets wrangler's
  `X_LOCAL_OBSERVABILITY`, which attaches Miniflare's trace collector. So
  `tracing` spans report `isTraced: true` on both runtimes with it, and
  `false` on both without it.
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
  are optional. The transcript records the status and the body, parsed as
  JSON when the response says it is JSON.
- **`ws`**: opens a WebSocket and sends the `send` frames.
  - With `close`, the client waits for `receive` frames, or one frame per
    frame sent by default. It then closes with that code.
  - Without `close`, the step waits for the server to close.

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

### Kinds

- **`differential`** (the default): `expect.json` is recorded from workerd
  with `--update`. Its header names the workerd and wrangler versions. A
  differential case fails on a different installed workerd until it is
  re-recorded. Use this kind whenever workerd can run the scenario.
- **`celld-only`**: for behaviour workerd can't show locally, such as OTLP
  export, the egress allowlist, deploy refusals, multi-node or celld limits.
  `reason` is required and says why. `expect.json` is written by hand and
  reviewed. `--update` and `--runtime=workerd` skip these cases.

### Expected failures

`"xfail": "<plan item>"` marks a case that celld can't pass yet. It reports
`XFAIL` with the item. If the case passes, the runner reports `XPASS` and
fails the run, so the marker comes out in the change that fixes celld. xfail
covers celld only: workerd must still match `expect.json`.
