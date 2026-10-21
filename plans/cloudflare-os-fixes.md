# Cloudflare OS on celld: implementation plan

This is the ordered plan for the celld changes that let Cloudflare OS run on
celld, and for how each change is verified. It is written for an engineer or
agent who has not seen the earlier work: read the **Orientation** section
first, then work the phases in order.

Related documents:

- [cloudflare-os.md](cloudflare-os.md): the gap analysis.
- [cloudflare-os-trial.md](cloudflare-os-trial.md): the first trial run and
  its failures, numbered 1 to 9. This plan refers to them as "trial failure N".

Status: planned 2026-10-21. Nothing in this plan is implemented yet.

## Orientation

### The two repositories

| Repo | Path | Notes |
| --- | --- | --- |
| celld | `~/projects/celld` | Rust + V8 runtime. Most JS runtime behaviour lives in `crates/celld/js/harness.js` (about 11.5k lines). Commit to `main` directly (it is Alex's fork). |
| Cloudflare OS starter | `~/projects/cloudflare-os-starter` | Alex's fork; commit to `main` directly. Upstream Cloudflare OS is the `cloudflare-os/` submodule: **never edit it**, it moves only by pin. celld-specific tooling lives in `celld/`. |

Paths below are relative to the celld repo unless they start with
`starter:` (the starter root) or `cos:` (`starter:cloudflare-os/packages/`).

### The celld rules that shape every change

- **Loud-gap rule** (`docs/cloudflare-compat.md`): an unsupported config key
  or API fails at deploy or at first use. Accepting something without effect
  is a defect. Several items below exist only because of this rule.
- **workerd is the reference.** When behaviour is unclear, read workerd's
  source (`gh api repos/cloudflare/workerd/...`) and match it, then pin it with
  a differential test (Phase 0).
- **Docs are part of the change.** `docs/cloudflare-compat.md`,
  `docs/services/*.md` and `docs/limitations.md` list each difference from
  Cloudflare. Update them in the same commit.

### How celld runs Workers (what you need to know for this plan)

- A node serves one `Generation` (`crates/celld/generation.rs`). The primary
  script is the last one deployed; scripts reachable through service bindings
  are co-hosted in the same process.
- Each script has a **stateless isolate pool** and a separate **cell
  (Durable Object) pool** (`generation.rs:580-626`, `runtime.rs:647`). So a
  Worker's fetch handler and its own DOs always run in **different isolates**.
  Two co-hosted scripts are different isolates too.
- JS RPC today (`harness.js` around 3600-5800): within one isolate, a stub,
  RpcTarget, function or stream crosses through an entry table
  (`__stubEntries`, `__stubLift` ~4202, `__stubRevive` ~4457). A marker from
  another isolate revives as `__foreignStub()` (~4524), which throws "RPC stubs
  cannot cross isolate boundaries yet". DO stubs (`__celld$do`) cross by value.
  `ctx.exports` loopback stubs (`__celld$svc`) only revive in their own isolate.
- DO calls: `__rpc_call` → `op_rpc_call` (`js.rs:8956`) →
  `dispatch_rpc_call` (`main.rs:1407`) → local `CellJob::Rpc` (`js.rs:5296`)
  or a peer tunnel (`main/peer_tunnel.rs:611`).
- Service-binding calls: `__makeServiceBinding` (`harness.js:3526`),
  `op_svc_call_impl` (`js.rs:7129`), `op_svc_rpc` (`js.rs:7063`),
  `begin_entrypoint_rpc` (`js.rs:4658`).
- Existing cross-isolate precedents to copy: AbortSignals (`RPC_SIGNALS`,
  `js.rs:486-510`), host-held WebSockets (`ws_registry.rs`), and body streams
  (`http_streams.rs`, `register_body_stream`).

### What Cloudflare OS does (the journeys that must work)

Cloudflare OS is seven Workers: router, workshop-backend, gatekeeper-context,
gatekeeper-scheduler, gatekeeper-websearch, custom-gatekeeper and
error-reporter. The browser talks Cap'n Web over a WebSocket at `/api`. Boundary labels used below:

- **A**: within one isolate.
- **B**: a stateless handler and its own script's DO.
- **C**: one DO and another DO of the same script.
- **D**: one script and another script.
- **E**: the Overseer DO and a facet whose class comes from another script.
- **F**: the host and a Dynamic Worker.

| Journey | What happens | Needs |
| --- | --- | --- |
| J1: page load after sign-in | Cap'n Web subscriber stubs (Proxy over a function) go into the User DO (B). The DO returns `RpcStub` leases. `subscriber.ready()` and `subscriber.notify()` call back (`cos:workshop-backend/src/user.ts:481-494`, `1650-1771`). | Phase 3 |
| J2: onboarding "turn on" gatekeepers | `vendor.createAccount()` returns a `ctx.exports.XAccount({props})` stub from another script (D), which is stored in DO storage (`user.ts:1444-1455`). | Phase 2 |
| J3: start a conversation | `overseer.open(…, notifyClosed, …)` passes a function with `Symbol.dispose` (B) and returns an `OverseerClientInterface` RpcTarget (B). It then calls `newChat`. Gatekeeper facets come from other scripts' DurableObjectClass handles (E). Capsule failures are caught (`overseer.ts:7639-7653`), so chat can work before the facets do. | Phases 1 and 3, then 4 for gatekeepers |
| J4: gadget from a blueprint | The BYOB pack reader (`cos:workshop-backend/src/git-codec.ts:663` on `new Blob([pack]).stream()`), `LOADER.get`, a facet from a Dynamic Worker class reached through `ctx.restore` (`overseer.ts:4549`), and a facet Proxy that claims RpcTarget's prototype, forwarded to the browser. | Phases 1, 3 and 5 |
| J5: gatekeeper tool use and scheduler | Pipelined `startGatekeeperSession` (`overseer.ts:10815`). An ApprovalQueue RpcTarget goes into a facet from another script (E). `bindHook` stores a controller from another script and a persistent callback. The ScheduleDriver alarm calls a stored initiator (`cos:gatekeeper-scheduler/src/schedule-driver.ts:136,410`). | Phases 3, 4 and 5 |
| J6: code mode | `LOADER.load` with loopback env stubs. Tails report RPC calls (`verify`/`run`). A `RestoreForger` RpcTarget goes into the Dynamic Worker. `ctx.restore` runs inside the Dynamic Worker. | Phases 3, 5 and 6 |

In a single-node fleet no capability crosses a node. Cross-node support
(Phase 8) is needed only for multi-node fleets.

### Local environment for verification

The trial harness lives in `starter:celld/` (see its `README.md`):

- `generate.ts`: writes `celld.<worker>.jsonc` per Worker. Each workaround it
  applies is commented, and later phases remove them.
- `build.sh`: builds the Workers, including the capnweb-validate step.
- `deploy.sh [--no-router]`: deploys all seven Workers and reloads the node.
- `env.sh`: bucket settings (Azurite), the `CELLD` binary path, and the trial
  account (`CFOS_TRIAL_USER`/`CFOS_TRIAL_PASSWORD`).
- `azurite-container.py`: creates a blob container.

The services the trial used:

- Azurite in podman: container `celld-azurite`, port 10000.
- A celld node on `127.0.0.1:8790`, logging to `starter:.celld/node.log`.
- A mock OpenAI-compatible LLM on `127.0.0.1:11434`, added in the UI as an
  "Other Ollama…" provider with model `mock-llm`. It currently lives in a
  scratch directory; Phase 0 commits a better one into the starter.

MinIO images can no longer be pulled anonymously, so use Azurite.

## Decisions to settle before starting

Each decision has a recommendation. They are listed here so they can be
agreed up front. Phases refer to them as D1-D14.

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where new tests live. The repo has **no test bodies**: Rust tests are `include!`d from out-of-tree files (`CELLD_INTERNAL_*_TESTS`, `CELLD_CONFORMANCE_*`, see `crates/celld/lib.rs:15-180`), and the workerd conformance corpus and simulator in `docs/testing.md` are not in the tree. | Add in-repo tests: inline `#[cfg(test)]` modules for Rust, and a new `tests/conformance/` workerd-differential corpus. Don't depend on the private suites. Ask upstream whether those suites can be shared. |
| D2 | Same-node capabilities first, and a loud error for anything that would cross nodes until Phase 8. | Yes. Document that Cloudflare OS needs a single-node fleet until then. |
| D3 | Native `stub.onRpcBroken()`. Cloudflare OS calls it on stubs that are really forwarded Cap'n Web stubs (`cos:workshop-backend/src/server.ts:307` says the built-in RPC lacks it). | Don't add a native method that would shadow the forwarded one. Confirm with a workerd differential test at compat date 2026-09-04. |
| D4 | Can a DO with live exported capabilities be evicted? | No idle eviction while exports are live. Pressure eviction is still allowed and breaks them. |
| D5 | Re-exported stubs (B passes X's stub on to C): take a shortcut, or proxy through B as workerd does? | Shortcut, documented as a difference. |
| D6 | `allow_irrevocable_stub_storage` enforcement. celld currently stores same-script loopbacks without the flag. | Enforce the flag for new token kinds and for restore. Same-script loopbacks keep working with a deprecation warning for one release. |
| D7 | Authenticate stored capability tokens? | Yes: HMAC with deployment key material, as workerd authenticates its channel tokens. |
| D8 | Where a facet whose class comes from another script runs. | In the target script's isolate, on the root's owner node, so it gets its own `env`, `ctx.exports` and flags. |
| D9 | `ai` and `browser` bindings. | Keep them refused in celld. The starter maps `WORKERS_AI`/`AI` to a service binding on an operator shim Worker (Phase 9). A first-class celld binding is deferred. |
| D10 | Should `celld deploy` run Wrangler's `build.command`? | Yes, with `--no-build` to skip it. That removes `starter:celld/build.sh`'s capnweb step. |
| D11 | `global_fetch_strictly_public` escape hatch, and always blocking the node's own listeners. | Add `CELLD_FETCH_PRIVATE_ALLOW` with host:port entries. Always block `--internal-listen` and the advertise addresses, even without the flag. |
| D12 | `accept()` on a WebSocket that a stateless Worker returned through a service binding. | Refuse loudly for now; only passthrough is needed. |
| D13 | `tracing`: a correct no-op first (`isTraced=false`), or OTLP export straight away? | No-op first (Phase 1), OTLP later (Phase 9). |
| D14 | Dynamic Worker tails: legacy `tail()` for RPC and facet invocations, or `tailStream`? | Legacy only. Cloudflare OS doesn't use `tailStream` yet; refuse `streamingTails`. |

## Phase overview

| Phase | Theme | Unblocks | Effort (engineer time) |
| --- | --- | --- | --- |
| 0 | Test infrastructure | Every later gate | 1.5-2 weeks |
| 1 | Loud gaps and small fixes | Router mode; the trial workarounds go away; BYOB; chat critical path (tracing) | 2.5-3 weeks |
| 2 | Address-like capability tokens and storage | J2 ("turn on" gatekeepers) | 1.5-2 weeks |
| 3 | Cross-isolate RPC on one node | J1, J3 chat | 5-7 weeks |
| 4 | Facets from another script's class | J3 gatekeepers, J5 | 1.5-2 weeks |
| 5 | `ctx.restore` and persistent stubs | J4, J5 hooks, J6 | 4 weeks |
| 6 | Dynamic Worker tails for RPC and facets | J6 code mode, gadget logs | 0.5 week |
| 7 | Streams over RPC and stream performance | gitPull, gadget export | 1.5 weeks |
| 8 | Cross-node capabilities | Multi-node fleets | 4 weeks |
| 9 | Follow-ups | OTLP spans, AI shim, wider integration coverage | 1.5 weeks |

Phases 0 and 1 can overlap: Phase 1 items need only the Phase 0 runner. Phase 2
can start alongside Phase 3; Phase 4 needs both.

Each item below gives the problem, the design, the tests in three tiers, and
the gate it must pass. The tiers are:

- **Unit**: Rust `#[cfg(test)]`, plus pure logic in `crates/logic`.
- **Integration**: a `tests/conformance/` case run on both celld and workerd,
  and the Cloudflare OS integration-test adapter where it applies.
- **E2E/manual**: the starter's e2e smoke step and a browser checklist row.

---

## Phase 0: test infrastructure

There is no in-repo test harness yet, so nothing else can be gated until this
phase exists.

### 0.1 Multi-config `celld dev`

**Problem.** `celld dev` (`crates/celld/dev.rs:585`, `deploy_project`) deploys
a single project, so no test can co-host several scripts.

**Design.**
- Accept `celld dev -c a.jsonc -c b.jsonc …`, matching `wrangler dev -c`. The
  **first config is the primary**, as in Wrangler, so a fixture runs unchanged
  on both runtimes.
- Deploy every config into the dev store; the primary is deployed last
  internally.
- Add `--port 0` and a machine-parsable stdout line with the public and
  internal origins.
- The watcher watches all project directories.

**Tests.**
- Unit: argument parsing, and the deploy order (primary last).
- Integration: the runner (0.2) uses it for every case.
- E2E/manual: the `wsfront`/`wsback` repro from the trial starts with one
  command.

### 0.2 Conformance corpus with workerd as reference: `tests/conformance/`

**Layout.**

```
tests/conformance/
  package.json        # pins wrangler 4.147.0 (createTestHarness), capnweb
  run.mjs             # --runtime=celld|workerd|both  --update  --filter <glob>  --nodes N
  cases/<area>/<case>/
    workers/<name>/wrangler.jsonc + index.js   # first listed = primary
    case.json         # {"workers":[...], "steps":[{"path":"/run"} | {"ws": "/x", "send": [...], "expect": [...]}], "normalize":[...]}
    expect.json       # recorded from workerd with --update, committed
```

**How a case works.**
- The primary exposes `/run`, runs the scenario inside the runtime, and
  returns a JSON transcript of `[step, value]` pairs.
- Errors are recorded as `{name, message}`.
- `normalize` lists regexes for messages that legitimately differ. Each entry
  carries a comment, and an entry that hides a semantic difference is a bug.

**How the runner works.**
- **celld:** runs `target/<profile>/celld dev --no-watch --clean --port 0 -c …`
  in a temp copy of the case, waits for the origin line, runs the steps,
  diffs against `expect.json`, then `POST /shutdown` on the internal listener.
- **workerd:** runs the case through wrangler's `createTestHarness`, which is
  the API `cos:integration-tests/src/harness.ts` uses.
- `--update` writes expectations **from workerd only**.
- `--runtime=both` diffs the two live.

**workerd binary.** Pin wrangler, and so workerd, in `package.json` and record
the version in each `expect.json`. A copy already exists at
`starter:node_modules/.pnpm/@cloudflare+workerd-linux-64@1.20261019.1/…/bin/workerd`.

**Test-loop builds.** Use `cargo build --profile lab` (thin LTO, incremental).
Release builds use fat LTO and are too slow for test loops.

**Seed cases**, which pin current behaviour:
- `examples/rpc` (same-isolate RPC)
- `examples/facets`
- `examples/dynamic-worker-tails`
- `examples/counter`

### 0.3 Rust unit-test convention

- Inline `#[cfg(test)] mod tests` beside the code, run with
  `cargo test -p celld <module>::`.
- First targets are the pure parsers in `deploy.rs`. Each test asserts both
  the accepted shape and the loud refusal message.
- Keep `cargo clippy --all-targets -- -D warnings` clean. The `Dockerfile`
  test stage (lines 23-34) already runs `cargo test` and clippy.

### 0.4 Cloudflare OS e2e harness in the starter: `starter:celld/e2e/`

There is one entry point:
`starter:celld/e2e.sh [up|build|deploy|smoke|browser|all|down] [--router] [--fresh]`.

1. **up**
   - Starts Azurite (`celld-e2e-azurite`).
   - Waits for port 10000 and creates container `celld-e2e-$RUN_ID` (fresh per
     `--fresh`).
   - Starts the mock LLM.
   - Once 0.1 exists, offers `--dev-store`: multi-config `celld dev` with no
     podman.
2. **build**: `celld/build.sh`, skipped when outputs are newer than sources.
   After D10 lands, `celld deploy` runs the builds itself.
3. **deploy**: `celld/deploy.sh [--no-router]`. Router mode becomes the
   default after 1.7.
4. **Node**
   - Starts the node, logging to `.celld/e2e/node.log`.
   - Health check: `GET /` returns HTML, then a cheap Cap'n Web call over
     `ws://…/api`, with a 60 s timeout.
   - On failure, dumps the last 200 log lines.
5. **Mock LLM**, committed as `starter:celld/mock-llm.ts` (Node 26 runs TS
   directly). It listens on `127.0.0.1:11434`.
   - **Surface:**
     - `GET /api/tags`
     - `GET /v1/models` (model `scripted`)
     - `POST /v1/chat/completions`, both SSE and non-streamed
   - **Control:**
     - `POST /__script`: a queue of `{text}`, `{toolCall:{id,name,arguments}}`
       and `{error}` steps
     - `GET /__requests`
     - `POST /__reset`
     - The default reply is `{text:"ok"}`.
   - **Reuse:** import `scriptedChatCompletions` and the auxiliary-prompt
     table from `cos:integration-tests/src/mock-model.ts`, so titles are
     deterministic. Take tool names and argument shapes from
     `cos:integration-tests/__tests__/workshop-agent*.test.ts` and
     `workshop-callable-agents.test.ts`.
6. **smoke** (`e2e/smoke.ts`): Cap'n Web from Node.
   - Uses `capnweb@0.12.0` and the types from `@gadgets/workshop-shared/api`
     (`cos:workshop-shared/src/api.ts`).
   - **Auth** matches the frontend (`cos:workshop-frontend/src/passwordHash.ts`):
     argon2id from `hash-wasm`, with salt = `SERVICE_SALT` + username.
     Sequence: `createAccount`, or `login` if the account exists, then
     `authenticate(token)`.
   - Each step prints PASS/FAIL tagged with the trial failure it covers:

     | Step | Call | Expected | Covers |
     | --- | --- | --- | --- |
     | S1 | `amIAdmin()`, `getAdminApi()` | `true`; a stub | |
     | S2 | `admin.setGatekeeperMode(v, "optional")` for each built-in gatekeeper | resolves | 7 |
     | S3 | `subscribeToNotifications(new RpcStub(sub))`; dispose | no server error | 6, 8 |
     | S4 | `subscribeConnectedAccounts(sub)` | `ready()` called within 10 s | 6 |
     | S5 | `provisionAmbientAccount("context")` | account arrives on S4's subscriber | 7 |
     | S6 | `api.newGadget().newChat("hello", "scripted")`, pipelined | chat id; model called; chat goes idle | 6 |
     | S7 | `newGadgetFromBlueprint(featuredId, {})`, `getMetadata()` | title | 9 |
     | S8 | scripted tool call that schedules a task 5 s out | alarm fires; hook message in chat | |
     | S9 | restart the node, log in; S5's account still listed; reopen S6's gadget | works | durable stubs, restore |
     | S10 | `--router`: rerun S1-S7 through the router | same | 5 |
     | S11 | scan `node.log` for "cannot cross isolate", "could not be cloned", "is not a function", "dropped a frame for a closed WebSocket", "Invalid reader mode" | none | all |
7. **browser** (`e2e/browser.ts`)
   - Uses `playwright-core` 1.64 from `starter:cloudflare-os/node_modules/.pnpm`
     with the cached Chromium in `~/.cache/ms-playwright/`.
   - Steps: log in → home renders → send "hello" and see the mock reply →
     Gatekeepers page: toggle one on → create a gadget from a blueprint.
   - Fails on console errors outside an allowlist. The allowlist starts with
     the upstream `useAuthenticatedApi must be used within an AuthProvider`
     and `Flagship binding missing`.
   - Fails on any `/api` WebSocket close code 1006.
   - Screenshots go to `.celld/e2e/shots/`.
8. **Manual checklist**: `starter:celld/e2e/CHECKLIST.md`. Each row of the
   phase sections below is a line in it.

`generate.ts` gains a function export of its config filter, so the adapter in
0.5 can reuse it.

### 0.5 Cloudflare OS integration-test adapter: `starter:celld/integration/`

Upstream's `cos:integration-tests` (40 files) speak Cap'n Web over `/api`
through `createTestHarness`. They are the best existing end-to-end coverage.

**`startCelldHarness()`** returns the same `Harness` type, and is selected
with `CFOS_RUNTIME=celld` through a vitest alias of `../src/harness.js`.

**Configs** use upstream's `workshopConfig` patches, passed through the
`generate.ts` filter.

**Primary Worker:** a generated `test-front` Worker that service-binds every
Worker.
- It forwards `/__worker/<name>/…` and proxies everything else, including the
  `/api` WebSocket, to the workshop.
- That needs item 1.7, so the adapter can run only after 1.7 lands.

**Network interception** has to change. Upstream's interceptor patches Node's
`fetch`, but celld makes outbound requests itself.
- Run upstream's handlers (`scriptedChatCompletions`, `github-fake.ts`) behind
  a Node HTTP server, `celld/mock-upstream.ts`.
- Point the model provider at that server.
- Requests that match no handler get status 599 and are recorded.

**Allowlist:** `celld/integration/status.json` lists the files that pass. It
only grows, and CI fails on a regression. Start with `workshop-lifecycle`,
`workshop-agent*`, `workshop-blueprints`, `workshop-connections`,
`observer-*`, `workshop-hooks`, `workshop-sharing` and `workshop-presence`.
Exclude files that redeploy or need vendor fakes.

### 0.6 CI

Add `.github/workflows/test.yml` for pull requests:
- `cargo test --profile lab`
- clippy
- `node tests/conformance/run.mjs --runtime=celld`

Add a nightly job:
- `--runtime=both`
- `--nodes 2` against an Azurite service container

### Phase 0 gate

- The seed conformance cases pass on both runtimes.
- `e2e.sh all --no-router` reproduces the trial's state, so smoke steps S1-S11
  fail exactly where the trial did.
- CI runs on pull requests.

---

## Phase 1: loud gaps and small fixes

These items are independent, and each is small. Do them in this order, because
the early ones sit on the chat critical path or remove trial workarounds.

### 1.1 Every `cloudflare:workers` export, and `restore` as a real symbol

**Problem.** `stub_source` (`crates/celld/js/modules.rs:600-607`) emits
`export const X = __celld.__cf.X` for any imported name, so names celld lacks
come through as `undefined`.
- `tracing` gives a `TypeError` on first use, on every chat turn
  (`cos:workshop-backend/src/agent-tracing.ts:92-204`).
- `restore`, which is used as `[restore](params)` in 34 places, silently
  defines a method named `"undefined"`.

**Design.**
- Export exactly the names workerd's `cloudflare:workers` exports.
- A name celld doesn't implement yet becomes a stub that throws on use and
  names itself.
- A name workerd lacks fails at link time, as in workerd.
- `restore` becomes a real well-known symbol now, ahead of Phase 5.
  `ctx.restore` throws "not implemented" until Phase 5.

**Tests.**
- Unit: `stub_source` output for a known name, an unimplemented name and an
  unknown name.
- Integration: a `modules/cloudflare-workers-exports` case that imports each
  name and reports `typeof`, compared with workerd.

### 1.2 `tracing` phase 1

**Design.**
- Implement `tracing` and `ctx.tracing` (the same object) per Cloudflare's
  custom-spans API: `enterSpan`, `startActiveSpan`, `startSpan`,
  `getActiveSpan`, and the `Span` methods.
- `isTraced` is `false`, as for an unsampled request on Cloudflare.
- The active span is tracked with the existing CPED/AsyncLocalStorage frame
  (`harness.js:3813`). `enterSpan` ends the span when its promise settles.
- Spans are dropped, and the compat doc says so.

**Tests.**
- Integration: a `tracing/` case covering:
  - sync and async callbacks
  - exception propagation
  - nesting
  - `getActiveSpan()` outside a request
  - chaining of `setAttributes`
  - `ctx.tracing === tracing`
- E2E/manual: becomes testable after Phase 3; a chat turn completes.

### 1.3 `ctx.exports` namespaces for classes declared only in migrations (trial failure 4)

**Problem.** `do_classes` comes only from `durable_objects.bindings`
(`deploy.rs:1401-1417`). It drives three things, all of which skip
migration-only classes:
- `register_class` (`js.rs:5928-5948`)
- `populate_cf_exports` (`js/bootstrap.rs:356`)
- `cell_configs` (`generation.rs:520-570`)

**Design.**
- In `read_project`, add each non-reserved class from `sqlite_classes` to
  `do_classes`. Namespace keys depend only on (script, class), so ids don't
  change, and trial data created under the `CELLD_DO_*` workaround stays
  reachable.
- Fix the "DO class not exported" check (`js.rs:5936`). `ns.get` returns
  `undefined`, not `None`, so the check never fires; make it a clear load
  error.

**Tests.**
- Unit: a migration-only class lands in `do_classes`; no duplicates when it
  is also bound; reserved classes are unaffected; the control-plane manifest
  check passes.
- Integration: an `exports/migrated-namespace` case. The id from
  `ctx.exports.X.getByName("a")` equals the id from an `env` binding.
- E2E/manual: remove `generate.ts` workaround 4 and redeploy over the trial
  bucket. The admin user and their settings survive.

### 1.4 Service-binding `props`, and refusing ignored keys

**Problem.** `deploy.rs:1424-1460` drops `props`, and every other key except
`binding`, `service` and `entrypoint`. The runtime already carries props:
`__makeServiceBinding(script, ep, propsSc)`, `SvcRpcReq.props`, and `ctx.props`
delivery in `__beginEvent`.

**Design.**
- **Deploy:** keep `props` (a JSON object, size-bounded like loader props) in
  the binding metadata.
- **Node:** `fleet.rs:999` `service_bindings` returns a struct with `props`.
  `bootstrap.rs:660` passes them to `__makeServiceBinding`.
- **Default entrypoint:** `op_svc_call_impl` (`js.rs:7141-7148`) drops props
  when the entrypoint is null. Send them as entrypoint `"default"` instead.
- **Refuse:** any unknown `services[]` key, and `environment`.
- **Refuse in `durable_objects`:** `script_name`, `environment`, and any key
  other than `name`/`class_name` in a binding. Also refuse any key other
  than `bindings` at the `durable_objects` top level.
- **Accept:** `remote`, which only affects `wrangler dev`, with a code comment.

**Tests.**
- Unit:
  - props round-trip into the metadata
  - non-object props refused
  - oversize props refused
  - unknown key refused
  - DO `script_name` refused
- Integration: a `service-bindings/props` case. A named entrypoint and the
  default export each echo `this.ctx.props` over fetch and over RPC, within
  one script and across scripts.
- E2E/manual: drop the generator's props note; an error report carries
  `service` and `environment`.

### 1.5 `redirect: "manual"` on incoming requests

**Problem.** `__makeRequest` (`harness.js:538`) gives incoming requests
`redirect: "follow"`. When the router forwards `req`, the target's 302 is
followed on the server, which breaks the gatekeeper OAuth redirects.

**Design.** Incoming requests get `redirect: "manual"`. That covers top-level
requests, DO `__dispatchTo`, service-binding targets and entrypoint targets.

**Tests.**
- Integration: a `service-bindings/redirect` case. A front forwards `req` to a
  back that returns 302, and the client sees the 302. The same holds for
  `fetch(req)` to an outside URL.

### 1.6 Deploy configuration relaxations

| Change | Design | Unit tests |
| --- | --- | --- |
| JSON `vars` | A `{"type":"json"}` binding, installed with `JSON.parse` per isolate. Add feature flag `FEATURE_JSON_VARS_V1` (`protocol.rs:64`). Cap each var at 5 KiB. Dotenv overrides stay strings. | Nested values; a dotenv override; an old node refusing the feature |
| `rules[].fallthrough` | Accept `false`. Accept `true` only when no other rule claims that extension; refuse it otherwise. | All three cases |
| `observability` | Accept, and print one line: telemetry is operator-controlled (`CELLD_OTEL`). | Warning text |
| `build` | Run `build.command` with `sh -c` in `build.cwd` (default: the config's directory) before resolving `main`. A non-zero exit stops the deploy. `--no-build` skips it. `celld dev` watches `watch_dir`. | cwd; failure propagation; `--no-build` |
| `workers_dev`, `preview_urls` | `false` is accepted silently; `true` is accepted with a warning. | Both |
| `account_id` | Accept and ignore. | |
| `routes` | Keep refusing, with a better message. | Message |
| `secrets.required` | Each name must be provided by `vars` or a dotenv override, or the deploy fails. Document that celld secrets are plaintext vars. | Missing and present |

**Integration.**
- A `deploy/` case runs `celld deploy --dry-run` on configs that use each key.
- An `env/json-vars` case checks `Array.isArray(env.ADMINS)`.

**E2E/manual.**
- Run `generate.ts --keep-unsupported`, minus the `ai`/`browser` bindings,
  and the deploy succeeds.
- `build.sh` loses the capnweb-validate loop.
- Signing in as admin opens `/admin` with `ADMINS` as a real array.

### 1.7 WebSocket returned through a service binding (trial failure 5)

**Root cause.**
- The target returns a Worker-held socket,
  `HttpResponseWebSocket::Worker` (`js.rs:12645-12660`).
- On the way back to the caller, `encode_http_response`
  (`http_streams.rs:1751-1785`) encodes only the `Cell` variant. The Worker
  socket is dropped, and its `Drop` (`ws_registry.rs:464`) unregisters it.
- The caller then sees a 101 with no socket, and `runtime_response`
  (`main.rs:345`) writes a bare 101.
- The same bug affects Dynamic Worker entrypoint fetch (`op_loader_fetch`
  calls `encode_http_response(…, false, …)` at `js.rs:7853`) and the
  `globalOutbound` broker (`js.rs:9098`).

**Design.** Hand the frame channel across using the existing handoff map.
- **`ws_registry.rs`:**
  - `WorkerWebSocket::into_handoff(self)`, without running `Drop`.
  - `park_worker_handoff(ws)` puts the socket back into
    `registry.worker_handoffs`.
- **`encode_http_response`:** with `ws_target`, park the socket and emit
  `"wsWorker": id`. Without `ws_target`, a socket is an **error**, never a
  drop. The loader fetch call site passes `true`.
- **New op `__ws_adopt_worker_handoff(id)`:** tracks the socket on the
  caller's context, so it is released if the caller drops the response.
- **`harness.js`:**
  - Service-binding, loader and broker fetch results with `wsWorker` produce
    a client `WebSocket` carrying `_workerHandoff = id`. The id lives on the
    socket, so `new Response(res.body, res)` rebuilds keep it.
  - `__wrapServiceResponse` keeps the socket.
  - `__readResponse` passes `workerSocketId` through without a new pump.
- **Refusals:**
  - `accept()` on a `_workerHandoff` socket throws a clear `TypeError` (D12).
  - A DO returning such a socket throws.
  - A 101 response with no socket becomes a 500 that names the cause.
- **Risks:**
  - The target's event must stay alive while its socket is pumped.
  - `Sec-WebSocket-Protocol` must pass through.
  - A parked handoff that is never adopted must be swept, with a guard or a
    generation sweep.

**Tests.**
- Unit:
  - Encoding a Worker socket keeps it registered.
  - `ws_target=false` with a socket is an error.
  - Adopt, then caller retire, removes the handoff.
  - A 101 with no socket gives a 500.
- Integration: `service-bindings/ws-101` covers:
  - an echo round trip
  - a server message sent before the first client frame
  - close codes in both directions
  - a double hop
  - a `new Response(r.body, r)` rebuild
  - a Dynamic Worker entrypoint returning a pair
  - the `accept()` refusal
- E2E/manual:
  - `deploy.sh` **without** `--no-router`: the UI loads past "Can't reach
    the server", and DevTools shows the `/api` 101 with `Upgrade`.
  - No "dropped a frame" lines in `node.log`.
  - Smoke S10 passes.
  - Remove `--no-router` from the starter README.

### 1.8 BYOB readers on platform streams (trial failure 9)

**Problem.** `js/streams.js:405` rejects any reader `mode`.

These platform streams don't support BYOB today:
- `CelldHttpBodyStream` (`harness.js:206`): streamed fetch bodies, inbound
  request bodies, R2 `get` bodies and loader responses
- `Blob.stream()` (`harness.js:10007`)
- the readable side of `CompressionStream`/`DecompressionStream`
  (`compression_streams.js:29`)
- readables revived from RPC (`harness.js:4413`)

Trial failure 9 is `Blob.stream()`: `cos:workshop-backend/src/blueprint-release.ts:455`
reads it through the BYOB `PackReader` (`git-codec.ts:663`).

**Design.**
- In `byte_streams.js`, generalise `ReadableStreamBYOBReader._buffered` into
  `_chunked(pullChunk, cancel)`. It pulls whole chunks, copies them into the
  caller's view, keeps the remainder, and supports `min`/`readAtLeast`.
- Add a helper, `__makeInternalByteStream`, that installs the `getReader`
  override the way `identity_transform_stream.js:311` already does. Apply it
  to each stream above, and check the KV stream type.
- `tee()` of these streams returns streams of the same kind.
- A user `new ReadableStream()` without `type:"bytes"` keeps refusing BYOB,
  as the spec and workerd do.

**Tests.**
- Integration: `streams/byob-*` cases on each stream type, covering:
  - partial reads, and a view smaller than the chunk
  - `readAtLeast`
  - cancel mid-read
  - `releaseLock`
  - tee branches
  - the user-stream refusal
- E2E/manual: smoke S7 gets past the pack read. The rest of S7 needs Phase 5.
  In the browser, "Create Gadget" from a blueprint no longer shows "Invalid
  reader mode".

### 1.9 `global_fetch_strictly_public` (and `nodejs_als`)

**Problem.** The flag is accepted with no effect. Global `fetch` uses plain
`reqwest` clients (`js.rs:721-730`, `11091`), so any Worker can reach the
internal listener's unauthenticated operator routes, cloud metadata
endpoints, and peers. In Cloudflare OS that includes the agent's `webFetch` of
model-chosen URLs. `reqwest` also honours proxy environment variables.

**Design.**
- With the flag set, outbound clients use a resolver that drops these
  ranges, including their IPv4-mapped forms:
  - loopback
  - RFC1918
  - CGNAT
  - link-local and metadata
  - ULA
  - multicast
  - unspecified
- IP-literal hosts are checked before each request and in every redirect
  hop.
- Clients use `.no_proxy()`.
- The error text matches workerd's.
- Service bindings, `ctx.exports` and `connect()` are exempt, as in workerd.
- Escape hatch (D11): `CELLD_FETCH_PRIVATE_ALLOW`, parsed in `env_vars.rs`.
- Always block the node's own internal listener and advertise addresses,
  flag or not, as a separate hardening commit.
- `nodejs_als`: AsyncLocalStorage already works without gating. Add it to the
  honoured-flags list in the docs and pin it with a case.

**Tests.**
- Unit:
  - the resolver filter table, including v4, v6, mapped and NAT64 forms
  - the escape-hatch parser
- Integration: `fetch-public/` with and without the flag, covering:
  - a literal IP
  - a redirect to a private address
  - a hostname that resolves to a private address
  - a public host
- E2E/manual:
  - The trial's mock LLM needs `CELLD_FETCH_PRIVATE_ALLOW=127.0.0.1:11434`
    (add it to `env.sh`).
  - Asking the agent to fetch `http://127.0.0.1:<internal port>/state` is
    refused.

### 1.10 Small built-in fixes

- **`Uint8Array` base64/hex:** a case pinning `toHex`, `toBase64`, `fromHex`,
  `fromBase64`, `setFromHex` and `setFromBase64`. V8 152 should already have
  them; this confirms it.
- **`node:zlib`:** add the level `constants` (`git-codec.ts:98` uses
  `Z_BEST_SPEED`). Honour `level`. Honour `maxOutputLength`, or throw on it.
- **`scheduler.wait({signal})`:** implement the signal, or throw on it.

### Phase 1 gate

- All new conformance cases pass on both runtimes.
- `generate.ts` workarounds 2, 3 and 4, the props note and `--no-router` are
  gone, and `e2e.sh deploy --router` succeeds.
- The browser shows the home page through the router.
- Smoke S1 and S10 pass. S3-S7 still fail, now only for the Phase 2/3 reasons
  (S11 is clean of "Invalid reader mode" and "dropped a frame").
- The 0.5 adapter boots.

---

## Phase 2: address-like capability tokens and storage

The cheapest capability work, and it unblocks J2. Cloudflare OS mostly passes
`ctx.exports.X({props})` stubs and DurableObjectClass handles across scripts.
Those are **addresses** (script, entrypoint or class, props), not live
objects, so they can cross isolates and go into storage without the Phase 3
machinery.

**workerd semantics** (from workerd's source):
- `compatibility-date.capnp` defines `allowIrrevocableStubStorage`.
- `io/io-channels.h:29-33` and `384-418`: only stubs minted from a
  flag-enabled Worker's `ctx.exports` are **persistent**, and the bit
  travels with the token.
- `api/http.c++:2526-2629` and `api/actor.c++:435-520` write storage tokens.
- `server/channel-token.h` defines four token kinds: Entrypoint, ActorClass,
  Actor and Restored. They are encrypted and authenticated.
- The flag must be set on the storing Worker and on the target.
- These are not storable: `env` service bindings, `env` DO namespaces, and
  Worker Loader classes.

### 2.1 Token format

**Kinds:**
- `svc{script, entrypoint, props}`
- `cls{script, class, props}`
- `do{script, class, id, name}`
- `rst{…}`, reserved for Phase 5

Each token carries a `persistent` bit taken from the minting script's flag.
Props are nested trees and may contain tokens.

**Where they apply:**
- Extend `__svcMeta` and `__outboundMeta` (`harness.js:3668`) with `script`
  and `persistent`. Give class handles (`__durableClassMeta`, ~2097) a
  `script`.
- **Over RPC**, tokens replace `__celld$svc` and cross by value to any
  isolate.
- **On revival:**
  - `svc` and `cls` resolve through `__makeServiceBinding(script, ep, props)`.
  - `do` resolves through a new host op that returns `namespace_key` for any
    co-hosted script (`engine_api.rs:545`).

**Failures are lazy.** A script that isn't co-hosted, a missing class, or a
target whose flag is now off fails on first **call**, not on decode. Listing
stored records must never throw.

### 2.2 Storage

- **`__storedLift`/`__storedRevive`** (`harness.js:4856-4973`) store tokens as
  `0x01 ‖ HMAC(key, bytes) ‖ bytes` (D7). The HMAC reuses the key material
  behind DO-id HMACs.
- **Refused, with workerd's wording:**
  - a non-persistent token
  - any write from a script without the flag
  - a plain transient stub or RpcTarget ("not a persistent stub")
- **Compat:** `Compat` (`engine_api.rs:247-266`) gains
  `allow_irrevocable_stub_storage`.
- **Existing behaviour:** same-script loopback storage without the flag stays
  allowed, with a deprecation warning (D6).

### 2.3 Callable migrated namespace

workerd's `LoopbackDurableObjectNamespace` is a namespace that is also
callable. `ctx.exports.Cls({props})` returns a `cls` token.
- Make celld's migrated-class namespaces (`harness.js:4988-4993`) callable.
- Remove the facet-doc restriction "A class with a storage migration cannot
  supply one".
- Using the token as a facet class is Phase 4.

### Tests

**Unit:**
- encode/decode round trips, with nested tokens in props
- HMAC tamper rejection
- persistent-bit rejection
- lazy failure for a missing script

**Integration:** `storage-stubs/` cases with two scripts and the flag:
- B returns `ctx.exports.Acc({props})`; A's DO stores it, `ctx.abort()`s,
  reloads it, calls it, and sees the props.
- The same for `ctx.exports.Cls({props})` and for a DO stub from another
  script's namespace.
- Negative cases for an `env` binding, an RpcTarget and a missing flag,
  recorded from workerd.

**E2E/manual:**
- Smoke S2 and S5 pass.
- Onboarding "turn on" for Context, Scheduler, Web Search and Custom shows no
  error toast, and the accounts survive a node restart (S9, first half).

### Phase 2 gate

- `storage-stubs/` passes on both runtimes.
- S2 and S5 pass.
- `node.log` has no "could not be cloned".

---

## Phase 3: cross-isolate RPC on one node

The largest item. It lets transient capabilities (RpcTargets, functions,
received stubs and Cap'n Web proxies) cross between isolates on one node.
Cross-node is Phase 8 (D2).

### Design: host-mediated capability tables

All isolates on a node share one process, so the host brokers capabilities.

**Export table, per isolate (JS).**
- `__stubEntries` stays the export table.
- A new op, `__cap_export(entryId, scope, ctxId)`, registers an entry with
  the host and returns a random 128-bit `CapId` (`getrandom`).

**Host `CapRegistry`** (new `crates/celld/capabilities.rs`, modelled on
`RPC_SIGNALS`):
- `CapId` → `{home: (generation, script, isolate, cell scope?, ctx), importers: {importer key → refcount}, state: Live | Broken(reason)}`.

**Wire form.**
- Payloads become `[tree, caps[]]`. Only the host rewrites `caps`.
- On delivery, each `CapId` becomes a **transfer** bound to the destination
  (isolate, scope, ctx). The receiver redeems it with `__cap_import(i)`; no
  other isolate can redeem it.
- User data with own `__celld$*` keys is refused at lift time, as
  `__loaderServiceMarker` is today (`harness.js:3384`).

**Import side.**
- `__makeStub` gets a remote variant whose calls go through
  `__cap_call(handle, path, args)`.
- The host routes each call to the export's home:
  - **cell exports:** a new `CellJob::CapCall` through `cell_event`, with the
    same gates as `CellJob::Rpc`, run under `__ctxRun(entry.ctx)`. It keeps the
    `entry.section` re-entry rule, so `blockConcurrencyWhile` doesn't
    deadlock.
  - **stateless exports:** a job **pinned to that exact isolate**. The pool
    needs targeted dispatch (`crates/logic/isolate.rs:231` places stateless
    work freely today). It is refused if the exporting context has ended.
- Outbound calls from a DO pass the output gate (`egress_gate_request`).

**Lifetime.**
- `dup()` is local. The last local release sends `__cap_release`. When
  every importer has released, the home gets `CapReleased`, and the target's
  `Symbol.dispose` runs.
- Implicit disposal is unchanged: received params at call end, handles at
  `__ctxEnd`, and a result's dispose.
- **Breakage** marks a CapId `Broken` and notifies importers, who watch it
  with `__cap_watch`. Causes:
  - the exporting context ends or aborts
  - the cell is released or evicted
  - the heap is freed or killed
  - the generation retires
- Pending calls reject, and later calls reject with the reason.
- **Importer death** releases everything it held. This is what the workshop's
  `notifyClosed[Symbol.dispose]` relies on (`server.ts:300-320`).
- A cell with live exports is skipped by idle eviction (D4,
  `crates/logic/lib.rs:6103 evict_idle`).

**Re-export** (B passes X's stub to C): the import record moves to C (D5).

**Callable Proxies.** A Cap'n Web stub is a Proxy over a function with
methods as properties. The receiver must resolve `stub.ready()`,
`stub.notify()` and `stub.onRpcBroken()` through `[[Get]]` on the function
target, as workerd does. D3: don't define a native `onRpcBroken` that would
shadow it. Pin the exact rules with differential cases, including
`Object.hasOwn` on proxies.

**Proxy claiming RpcTarget's prototype** (`overseer.ts:4632-4680`) must
export as a target.

**Limits:**
- 32 MiB per envelope
- about 64k live exports per isolate
- about 10k imports per importer
- path depth 5120

Each is refused loudly.

### Milestones

| M | Scope | Unblocks | Effort |
| --- | --- | --- | --- |
| 3.0 | The envelope, the reserved-key refusal, random CapIds, a `CapRegistry` skeleton, and pinned stateless dispatch. No behaviour change. | | 1 week |
| 3.1 | Calls, args and returns for RpcTargets, functions, callable Proxies, re-passed stubs and `new RpcStub(obj)`. Covers stateless↔own DO, DO↔DO, and script↔script. | J1 subscribers, J3 `overseer.open`/`newChat`, trial failure 6 | 2-3 weeks |
| 3.2 | Lifetime: release, dup, implicit disposal, break notices, importer death, the eviction pin, and `Symbol.dispose` callbacks across isolates. | J1 unsubscribe, `notifyClosed`, trial failure 8 | 1.5-2 weeks |
| 3.3 | Pipelining: a call on an RpcPromise or RpcProperty whose root is remote waits for the root, then forwards, keeping e-order. Wildcard-get Proxies (`GatekeeperLoopback`, `overseer.ts:10815`). | J5, J6 env calls; `observer-tracker.ts:258` | 3-5 days |

In each milestone, remove the corresponding "cannot cross isolate boundaries
yet" refusal in `harness.js`.

**Risks:**
- **WebSocket-session contexts.** The workshop mints Cap'n Web stubs inside a
  stateless WebSocket session. Check early that the session's event context
  stays alive for the life of the socket; otherwise every export breaks at
  once.
- **Generation cutover.** Capabilities must break cleanly when old heaps
  retire.
- **Leaked releases** when an importer is terminated. Release by importer key
  when a heap is freed.

### Tests

**Unit:**
- `CapRegistry` redemption is bound to the destination, and foreign
  redemption is refused.
- Refcounts work across importers.
- Breaks fan out to every importer.
- Imports are released when a heap is freed.
- The limits are enforced.
- Pinned dispatch, in `crates/logic/isolate.rs` (pure).
- `evict_idle` skips cells with exports.

**Integration:** the `rpc/` matrix. Boundaries:
- stateless→own DO
- DO→DO in another heap (set a small `max_cells` to force a separate
  isolate)
- script→script

Value kinds, each crossing every boundary:
- RpcTarget argument
- function argument
- callable Proxy with properties
- returned RpcTarget
- re-passed stub
- `dup` with `using`
- implicit param disposal
- `Symbol.dispose` callback
- break on `abort` and on eviction
- a pipelined call
- a 33 MiB payload (refused)
- a forged `__celld$cap` object (refused)

Plus `examples/rpc-caps/` as a runnable example.

**Integration (adapter):** turn on `workshop-lifecycle`, `workshop-agent`
(chat only), `workshop-presence` and `observer-*` in `status.json`.

**E2E/manual:**
- Smoke S1, S3, S4 and S6 pass, and S11 is clean of "cannot cross isolate".
- In the browser:
  - Sign in: no notification or account subscription errors in the console.
  - Start a conversation: the mock reply appears.
  - Close the tab: `node.log` shows the subscriber disposed.

### Phase 3 gate

- The `rpc/` cases (except streams) pass on both runtimes.
- Smoke S1-S6 pass.
- The browser e2e gets through "send hello, see the reply".

---

## Phase 4: facets from another script's class

The Overseer DO runs each gatekeeper's DO class (ContextGatekeeper,
SchedulerGatekeeper, WebSearchGatekeeper, CustomGatekeeper) as a facet. The
class arrives as a `cls` token from the gatekeeper's script (Phase 2), and the
facet is opened with `ctx.facets.get` (`overseer.ts:4828`). That runs the
gatekeeper's code against the Overseer's storage.

### Design (D8)

- **New host kind.** Add `FacetHost::Script(script)` (`js.rs:8062`), and pass
  `script` through `__facet_rpc` and `__facet_fetch` (`harness.js:2198`,
  `2211`).
- **Resolution:**
  - same script → `Own`
  - otherwise → a slot from `generation.cell_isolates(script)`
    (`generation.rs:372`) on the root's owner node, running with that script's
    `env`, `ctx.exports` and flags
- **Facet identity:** `ctx.props` = the class props (already read from
  `__cell.facetConfigs[scope].props`, `harness.js:2591`). `ctx.id` = the
  root's id unless the caller sets one.
- **Lifetime.** Treat it like a `Loaded` facet:
  - Record it in `ROOT_FACETS` (`js.rs:8101-8208`), so give-back and abort
    close it (`release_root_facets`, `js.rs:8231`).
  - Count it in the slot's `cells`/`adopted_cells` (`pool.rs:196-202`), so
    the slot isn't retired while the facet is open.
  - A generation swap follows `RootRelease::Swap`.
- **Unchanged:** storage stays a facet stream under the root
  (`facet_streams.rs`), with the root's epoch, fence and output gate.
- **Facet alarms** stay unsupported. No gatekeeper facet sets one.

Calls into the facet carry RpcTargets both ways: the ApprovalQueue goes in, and
sessions and slash-command providers come out. Those use Phase 3 over boundary
E.

### Tests

**Unit:**
- `FacetHost::Script` resolution
- the `ROOT_FACETS` record and its release on Stop and on Swap
- slot `cells` accounting with a facet from another script

**Integration:** `facets/cross-script`:
- A's DO opens B's class as a facet.
- The facet reads `ctx.props` and B's `env`.
- Facet storage survives `abort()` of the root.
- An RpcTarget crosses into and out of the facet.

Also add `examples/facets-cross-script`.

**Integration (adapter):** turn on `workshop-connections`.

**E2E/manual:**
- Start a conversation: the built-in gatekeepers mount (no "capsule" errors
  in `node.log`), and the Gatekeepers panel in the workspace lists them.
- Ask the agent (scripted tool call) to run a context search, then a web
  search. Web search needs the Phase 9 AI shim; until then, the clean error
  is what's expected.

### Phase 4 gate

- `facets/cross-script` passes on both runtimes.
- Gatekeepers mount in a workspace.

---

## Phase 5: `ctx.restore` and persistent stubs

Every gadget facet and every gatekeeper facet stub reaches the Overseer through
`this.ctx.restore(...)` (`overseer.ts:4549`, `4821`). That puts `ctx.restore`
on the critical path for J4-J6, not just hooks.

### workerd semantics

From `api/restore.c++` and `server/factory/worker-factory.c++:959-1255`:

- **`ctx.restore(params)`** synchronously calls `this[restore](params)` on
  the current entrypoint or DO.
- **The result** is coerced:
  - a Fetcher stays a Fetcher;
  - an RpcTarget or function becomes an RpcStub.
- **Restored channel.** The result is wrapped in a channel that records
  (self-token, params).
- **Storage.** A stored restored stub writes `rst{vendor: self-token, arg,
  kind}`. Loading it lazily replays `[restore](arg)` on the vendor, hop by
  hop for chains.
- **Self-tokens:**
  - a stateless entrypoint: `svc{…}`
  - a root DO: `do{…}`
  - a facet or Dynamic Worker: only the `rst` of the restored channel the
    current call arrived on
  - otherwise `ctx.restore` throws "the immediate caller did not specify how
    to restore it"
- **Replay** must return the same kind as the original.

### 5.1 Live restore (C1)

- **Self-token per context.** The restored channel's token travels as call
  metadata through `__facet_rpc` and `__loader_rpc`. The callee keeps it per
  event, alongside `__ctxNow()`.
- **`ctx.restore`** wraps the live result together with `rst{selfToken,
  sc(params), kind}`.
- **The forger** (`overseer.ts:10052-10132`, `142-199`): a Dynamic Worker
  loaded inside `[restore]` inherits that event's restored token.
- **`restore` on a Fetcher.** The code-mode harness does
  `Object.defineProperty(stub, restore, …)` on env stubs and checks
  `stub.constructor.name === "Fetcher"` (`overseer.ts:102-128`). So env stubs
  must be extensible and report `Fetcher`.
- **Depends on** Phase 3.1 (RpcStubs returned from other isolates) and
  Phase 4 (gatekeeper facets).

### 5.2 Persistence (C2)

- `rst` tokens are storable, and loading one builds a lazy stub.
- **First call:**
  - A `do` or `svc` vendor dispatches a "restore" event to the target.
  - Each nested `rst` hop calls `[restore](arg)` on the previous hop's
    result, inside the root's event when the hop is a facet.
  - The live result is cached for the stub's lifetime.
- **Restore-event lifetime** is pinned to the stub's disposal, with a
  `FinalizationRegistry` backstop (`harness.js:3318`).
- **Replay type check:** a replay that returns a different kind fails.
- **Re-entrancy risk.** A replay triggered from the Overseer's own event must
  dispatch within the current turn, not queue behind it.

### Tests

**Unit:**
- self-token selection per context kind
- `rst` encode/decode, with a chain depth of at least 3
- the replay type check

**Integration:** `restore/` cases:
- A root DO's `[restore]` → `ctx.restore` → store → evict → reload → call
  replays.
- A chain: root restore → facet F → `F.ctx.restore(p)` → stored → both hops
  replay.
- A facet reached through raw `facets.get` calls `ctx.restore` and throws
  workerd's message.
- The forger pattern.
- A replay type mismatch.

**Integration (adapter):** turn on `workshop-blueprints`, `workshop-hooks` and
`workshop-callable-agents`.

**E2E/manual:**
- Smoke S7, S8 and S9 pass.
- In the browser:
  - Create a gadget from a blueprint: it opens and its files list.
  - Open it again after a node restart.
  - Have the scripted model schedule a task, restart the node before it fires,
    then see it fire in chat.

### Phase 5 gate

- `restore/` passes on both runtimes.
- Smoke S7-S9 pass.
- The browser e2e creates and reopens a gadget.

---

## Phase 6: Dynamic Worker tails for RPC and facet invocations

**Problem.** Tail events are produced only for loader `fetch`
(`harness.js:3239-3275`, `js.rs:2994`).
- **Code mode** calls `entrypoint.verify()`/`run()` over RPC. It waits 5 s for
  a tail event and fails with "Timed out waiting for logs from code
  execution".
- **Gadget facets** get no tail events at all. That is a loud-gap defect
  today, and `docs/services/dynamic-workers.md:110` doesn't mention it.

**Design (D14).** Generalise `TailReportState` to every invocation of a loaded
Worker:
- fetch
- RPC, with `event: {rpcMethod}`
- facet fetch, RPC and alarm, with `event: {scheduledTime}` for alarms

Deliver one `tail([event])` per invocation, with:
- `logs[].message` as an array, `logs[].level` and `logs[].timestamp`
- `exceptions[]`

Refuse `streamingTails`.

**Tests.**
- Unit: the event JSON for each kind.
- Integration: `dynamic-workers/tails-rpc` and `tails-facet`, with the shape
  compared against workerd's `TraceItem`.
- E2E/manual:
  - A scripted code-mode tool call shows its console output in chat, not the
    timeout.
  - A gadget's console lines appear in the gadget log.

---

## Phase 7: streams over RPC, and stream performance

### 7.1 Byte streams across isolates

**Problem.** Byte streams currently cross through the per-chunk bridge
(`__readableBridge`/`__writableBridge`). Once Phase 3 lands, that works, but
costs a host hop per chunk.

**Design.**
- A `ReadableStream` lifts to a `register_body_stream` id
  (`http_streams.rs:2102`), which the receiver claims once.
- A `WritableStream` crosses the same way in reverse.
- Value streams keep the bridge.
- Revived readables are internal byte streams (1.8).

**Unblocks:**
- `GadgetClient.export()` (`overseer.ts:12921`)
- `gitPull` → `GitPullTransfer` (`cos:gatekeeper-kit/src/git-pull-transfer.ts`)
- `consumePackFromGatekeeper` (`git-cache.ts:317`), which needs BYOB on the
  revived stream

**Tests.**
- Integration: `rpc/streams-*` covering:
  - a readable stream and a writable stream as arguments and as return values
  - backpressure
  - cancel
  - error propagation
  - BYOB on the received stream
- E2E/manual: gadget export downloads, and a context collection backed by git
  refreshes.

### 7.2 Incremental `DigestStream`

**Problem.** `crypto.js:808-820` buffers all input until close. Packs can be
up to 64 MiB (`git-cache.ts:94`).

**Design.** Hash incrementally through a host hasher handle.

**Tests.**
- Integration: a digest over chunked input matches a one-shot digest.
- Unit: the hasher handle lifecycle.

---

## Phase 8: cross-node capabilities

Until this phase, a capability that would cross nodes fails at serialization
with "RPC capabilities cannot cross nodes yet" (D2).

**Design.**
- **New tunnel kind `cap`** on the existing peer tunnels (`peer_tunnel.rs`),
  with `call`, `release`, `broken`, `watch` and `redeem` requests. Each
  direction uses the dialer's own pooled tunnel, so no new socket type is
  needed.
- **Remote identity.** A remote CapId becomes `{node, process incarnation,
  CapId}`.
- **Ordering.** Each (import, export) pair gets a sequence number, and the
  exporter holds a reorder buffer, because calls can take different pooled
  connections.
- **Peer loss.** When peer probing or fleet membership declares a peer gone,
  break its imports and release its exports. The incarnation id catches
  restarts.
- **Pipelining.** Wire-level pipelining for calls on unanswered results.

**Which hops cross nodes in Cloudflare OS:**
- browser subscribers and `notifyClosed` going into the User or Overseer DO
- `OverseerClientInterface`, `GadgetClient`, `GatekeeperClient` and the
  facet proxy coming back
- ScheduleDriver → Overseer hook callbacks

E and F hops never cross nodes.

**Tests.**
- Unit:
  - sequence and reorder-buffer logic
  - incarnation handling, in `crates/logic` if it can be made pure
- Integration: the `rpc/` corpus with `--nodes 2`, with DOs forced onto the
  other node through `/evict` or by picking names. Assert:
  - the same `expect.json` results
  - a `SIGKILL` of the owner breaks imports
- E2E/manual:
  - Run two nodes on one bucket and put the browser on node A. Open
    workspaces until `/state` shows an Overseer owned by node B, then chat in
    it.
  - Kill B: the client reconnects and recovers.

---

## Phase 9: follow-ups

- **Tracing phase 2.** With `CELLD_OTEL` on, set `isTraced=true` and export
  spans. Changes:
  - `telemetry::Span` gets owned names and attributes (`telemetry.rs:322`)
  - `otlp.rs:107` emits attributes
  - the Parquet schema gains an attributes column
  - one host op, `__span_end`

  Unit: OTLP encoding. E2E/manual: the collector shows `invoke_agent`, `chat`
  and `execute_tool` spans.
- **AI shim in the starter** (D9). `starter:celld/ai-shim/` is a
  `WorkerEntrypoint` with:
  - `toMarkdown`: HTML → Markdown through `HTMLRewriter`; other formats
    return an error
  - `websearch`: forwards to an operator-configured SearXNG or Brave URL

  `generate.ts` maps `WORKERS_AI`/`AI` to it. It depends on `Blob` and
  `Response` crossing scripts over RPC (Phase 3). E2E/manual: the agent fetches
  `https://example.com` and gets Markdown; web search returns results.
- **Integration allowlist growth.** Triage the remaining
  `cos:integration-tests` files, and add vendor-host redirection so
  `github-fake`/`google-fake` can run.
- **Docs.** Remove the trial workarounds from `starter:celld/README.md`.
  Update `docs/cloudflare-compat.md`'s RPC, Dynamic Workers, facets and flags
  sections as each phase lands.

---

## Definition of done: "Cloudflare OS works on celld"

1. `e2e.sh all --router --fresh` passes twice in a row on a single node.
2. The browser e2e script passes.
3. Every row of `starter:celld/e2e/CHECKLIST.md` is checked by hand:
   - [ ] Load `/` through the router and sign in. `/api` shows 101 with
     `Upgrade`.
   - [ ] The notifications bell works; closing a second tab drops its
     subscriber.
   - [ ] Admin → Gatekeepers: turn on Context, Scheduler, Web Search and
     Custom. The setting survives a reload.
   - [ ] Connected accounts survive a node restart.
   - [ ] A new conversation streams the mock reply and gets the title "Test
     chat".
   - [ ] A scheduled reminder fires after an alarm, including across a
     restart.
   - [ ] A gadget from a blueprint opens and lists its files, and reopens
     after a restart.
   - [ ] Running gadget code shows its output and console logs.
   - [ ] An error report carries the service-binding props.
   - [ ] An agent fetch of `http://127.0.0.1:<internal port>` is refused.
4. The `cos:integration-tests` allowlist covers the triaged set.
5. The conformance corpus passes on celld and matches workerd, with every
   `normalize` entry justified.
6. For multi-node fleets, Phase 8's two-node checks also pass.

When a phase lands, append its date and commit range to the phase heading and
update [cloudflare-os-trial.md](cloudflare-os-trial.md)'s "How far it got"
table.
