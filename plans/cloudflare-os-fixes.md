# Cloudflare OS on celld: implementation plan

This is the ordered plan for the celld changes that let Cloudflare OS run on
celld, and for how each change is verified. It is written for an engineer or
agent who has not seen the earlier work: read the **Orientation** section
first, then work the phases in order.

Related documents:

- [cloudflare-os-trial.md](cloudflare-os-trial.md): the first trial run and
  its failures, numbered 1 to 9. This plan refers to them as "trial failure N".
- [cloudflare-os-prior-art.md](cloudflare-os-prior-art.md): other forks that
  attempted this, their commits (fetched as `refs/forks/*`), and learnings
  N1-N12. **Read its security warning before touching any fork's RPC code.**

### Using prior art

This is a production effort. Code from other forks is **input to our own
work**, never a shortcut past review. Each item below may carry a **Prior art**
line, and the [adoption policy](#adoption-policy-for-code-from-other-forks)
applies to all of them. The words mean:

- **Adopt:** the commit is a sound starting point. Cherry-pick it with
  `git cherry-pick -x` into the item's branch, then bring it up to the policy
  bar before it lands on `main`.
- **Rework:** start from the commit, but change it substantially as noted.
- **Reference:** read it for mechanism and reimplement. **Do not
  cherry-pick.**

No fork's cross-isolate capability routing may be merged, in any form: they
all let code forge capabilities. The full disposition table is in the
prior-art page.

### Scope: fresh deployments only

This work targets **new Cloudflare OS deployments on this celld fork**. There
are no existing fleets, manifests or cell data to carry forward. So:
- no migrations;
- no legacy code paths;
- no compatibility with data or manifests written by v0.6.2;
- no rolling upgrades between old and new nodes.

Every node in a fleet runs the same build. If an item seems to need backward
compatibility, that is a sign the design is wrong for this project; raise it
rather than adding a compatibility path. If this work is ever offered
upstream, upstream's compatibility rules (feature flags in `protocol.rs`,
rolling-upgrade support) would be added then.

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

Each Worker's needs, from the starter's final configs (`starter:packages/cf-os/src/core/deployment.ts`, `generateConfigs()`):

| Worker | Notable needs |
| --- | --- |
| router | static assets (SPA, `run_worker_first`), service bindings to workshop and every `GATEKEEPER_*` |
| workshop-backend | `LOADER`, facets, KV x2, R2, `ai`, `browser`, service bindings with `entrypoint: "GatekeeperVendor"` and `props`, 5 SQLite DO classes via `ctx.exports` |
| gatekeeper-context | KV, optional Artifacts, 4 SQLite DO classes |
| gatekeeper-scheduler | alarms, stores the workshop's hook stub and calls it from an alarm |
| gatekeeper-websearch | `ai` (`AI.websearch`) |
| custom-gatekeeper, error-reporter | starter-owned; error-reporter reads service-binding `props` |

No Worker declares `durable_objects` bindings: every namespace is reached
through `ctx.exports`. All but router and error-reporter set
`allow_irrevocable_stub_storage`.

### What already works on celld (v0.6.2)

The trial and source review confirmed these, so no item here re-does them:

- Several Workers linked by service bindings, co-hosted on one node
  (`crates/celld/generation.rs`), with named entrypoints.
- SQLite DOs through `ctx.exports`; sync KV, `transactionSync`, alarms,
  `deleteAll`, `sync()`, `blockConcurrencyWhile`, `abort()`.
- Facets; Worker Loader `get`/`load` with `globalOutbound: null` and `tails`.
- KV, R2, static assets with SPA fallback and `run_worker_first`.
- `FixedLengthStream`, `DigestStream`, `timingSafeEqual`, ECDH, HKDF,
  AES-GCM, `AsyncLocalStorage`, `URLPattern`.
- Storing DO stubs and same-script `ctx.exports` loopback stubs in DO storage.

In a single-node fleet no capability crosses a node. Cross-node support
(Phase 8) is needed only for multi-node fleets.

### Local environment for verification

The trial harness lives in `starter:celld/` (see its `README.md`):

- `generate.ts`: writes `celld.<worker>.jsonc` per Worker. It applies these
  workarounds, which this plan names **W1-W5**; later items remove them:
  - **W1**: drops every top-level key celld refuses. That covers
    `observability`, `build`, `ai`, `browser`, `workers_dev` and
    `preview_urls` (trial failure 1). Removed by 1.6, except `ai`/`browser`,
    which stay refused (D9) and are mapped to the AI shim instead.
  - **W2**: strips `rules[].fallthrough` (trial failure 2). Removed by 1.6.
  - **W3**: passes `ADMINS` as a JSON string (trial failure 3). Removed by
    1.6.
  - **W4**: adds a `CELLD_DO_<Class>` binding per migrated class (trial
    failure 4). Removed by 1.3 (done).
  - **W5**: `--no-router` makes the workshop primary and serves the frontend
    (trial failure 5). Removed by 1.7.

  It also passes service-binding `props` through, but celld drops them
  without an error until 1.4.
- `build.sh`: builds the Workers, including the capnweb-validate step.
- `deploy.sh [--no-router]`: deploys all seven Workers and reloads the node.
- `env.sh`: bucket settings (Azurite), the `CELLD` binary path, and the trial
  account (`CFOS_TRIAL_USER`/`CFOS_TRIAL_PASSWORD`).
- `azurite-container.py`: creates a blob container.

The services the trial used:

- Azurite in podman: container `celld-azurite`, port 10000.
- A celld node on `127.0.0.1:8790`, logging to `starter:.celld/node.log`.
- A mock OpenAI-compatible LLM on `127.0.0.1:11434`, added in the UI as an
  "Other Ollama…" provider. The trial used a scratch mock (model `mock-llm`);
  `starter:celld/mock-llm.ts` replaces it (model `scripted`). `env.sh` sets
  `CELLD_FETCH_PRIVATE_ALLOW` to its address.

MinIO images can no longer be pulled anonymously, so use Azurite.

## Decisions

Alex settled all of these on 2026-10-21. The **Decision** column is binding.
Phases refer to them as D1-D16. Two went against the original
recommendation: D12 and D13. D6 and D15 were later simplified: deployments
are always fresh, so there is nothing to keep compatible.

| # | Question | Decision |
| --- | --- | --- |
| D1 | Where new tests live. The repo has **no test bodies**: Rust tests are `include!`d from out-of-tree files (`CELLD_INTERNAL_*_TESTS`, `CELLD_CONFORMANCE_*`, see `crates/celld/lib.rs:15-180`), and the workerd conformance corpus and simulator in `docs/testing.md` are not in the tree. | Add in-repo tests: inline `#[cfg(test)]` modules for Rust, and a new `tests/conformance/` workerd-differential corpus. Don't depend on the private suites. Ask upstream whether those suites can be shared. |
| D2 | Same-node capabilities first, and a loud error for anything that would cross nodes until Phase 8. | Yes. Document that Cloudflare OS needs a single-node fleet until then. |
| D3 | Native `stub.onRpcBroken()`. Cloudflare OS calls it on stubs that are really forwarded Cap'n Web stubs (`cos:workshop-backend/src/server.ts:307` says the built-in RPC lacks it). | Don't add a native method that would shadow the forwarded one. Confirm with a workerd differential test at compat date 2026-09-04. |
| D4 | Can a DO with live exported capabilities be evicted? | No idle eviction while exports are live. Pressure eviction is still allowed and breaks them. |
| D5 | Re-exported stubs (B passes X's stub on to C): take a shortcut, or proxy through B as workerd does? | Shortcut, documented as a difference. |
| D6 | `allow_irrevocable_stub_storage` enforcement. celld currently stores same-script loopbacks without the flag. | **Enforce strictly, as workerd does,** for every storable stub, including same-script loopbacks. (Alex first chose a one-release deprecation, but there are no existing apps to protect: fresh deployments only.) |
| D7 | Authenticate stored capability tokens? | Yes, with HMAC, as workerd authenticates its channel tokens. Key = HMAC(peer_secret, "celld-capability-key-v1"), as in royalcala `2bd84cd`: fleet-wide, and it survives restarts. |
| D8 | Where a facet whose class comes from another script runs. | In the target script's isolate, on the root's owner node, so it gets its own `env`, `ctx.exports` and flags. |
| D9 | `ai` and `browser` bindings. | Keep them refused in celld. The starter maps `WORKERS_AI`/`AI` to a service binding on an operator shim Worker (Phase 9). A first-class celld binding is deferred. |
| D10 | Should `celld deploy` run Wrangler's `build.command`? | Yes, with `--no-build` to skip it. That removes `starter:celld/build.sh`'s capnweb step. |
| D11 | Outbound egress (1.9): escape hatch, and always blocking the node's own listeners. | Add `CELLD_FETCH_PRIVATE_ALLOW` with host:port entries. Always block `--internal-listen` and the advertise addresses, even without the flag. |
| D12 | `accept()` on a WebSocket that a stateless Worker returned through a service binding. | **Implement the host-side frame bridge in 1.7**, so passthrough and `accept()` both work (about 2 more days). The recommendation had been to refuse it for now. |
| D13 | `tracing`: a correct no-op first (`isTraced=false`), or OTLP export straight away? | **OTLP export in Phase 1 (1.2).** With `CELLD_OTEL` on, spans are traced and exported; with it off, `isTraced=false`. The recommendation had been a no-op first. |
| D14 | Dynamic Worker tails: legacy `tail()` for RPC and facet invocations, or `tailStream`? | Legacy only. Cloudflare OS doesn't use `tailStream` yet; refuse `streamingTails`. |
| D15 | How cell scopes become script-qualified (2.4). | **Always script-qualified, one code path.** Every deployment names cells by (script, class). There is no fleet setting, legacy naming or migration, because there are only fresh deployments. |
| D16 | Is the egress policy (1.9) on by default? | **Block by default**, matching Cloudflare's network and Cloudflare OS's assumptions. Operators allow specific internal `host:port` entries with `CELLD_FETCH_PRIVATE_ALLOW`. The node's own listeners are always blocked. |

## Review and commits

Decided by Alex on 2026-10-21.

- **Direct commits to `main`** in both forks. There are no pull requests.
  Commit messages follow the repo's style and end with the attribution trailer
  in use.
- **Before each commit, an independent agent review.** That is a fresh agent
  with no implementation context, or `/code-review`. The reviewer reads:
  - the diff
  - the item's section in this plan
  - the adoption policy, when fork code is involved

  Findings are fixed, or answered in the commit message, before the commit
  lands. The review checks:
  - correctness
  - the security checklist
  - tests in all three tiers as the item specifies
  - docs
  - no scope creep
- **Alex reviews at each phase gate.** The gate's evidence goes in this plan
  under the phase heading:
  - the conformance results
  - the smoke PASS/FAIL table against the baseline
  - the browser run
  - benchmark numbers, where relevant
- **Phase 3 security review.** Before Phase 3 code lands, a dedicated
  security-review agent reviews the threat model (`docs/security.md`
  additions); then Alex approves it. Each Phase 3 milestone gets the same
  security review of its code, on top of the normal per-item review.
- **CI** (0.6) runs on every push to `main`. A red build is fixed before the
  next item starts.

## Environment setup

What a fresh machine needs, as on the machine where this plan was written
(Fedora, x86-64):

| Tool | Version seen | Notes |
| --- | --- | --- |
| Rust | 1.99 (no `rust-toolchain` file) | `cargo build --profile lab -p celld` for test loops; `--release` (fat LTO) only for releases. Measured 2026-10-21 (V8 comes prebuilt): cold `lab` build 1m02s, warm rebuild after a `dev.rs` edit 25s. The 19 clippy warnings Rust 1.99 raised in v0.6.2 code are fixed (0.3). `fetch_update` stays behind `#[allow(deprecated)]`: its replacement `try_update` needs Rust 1.95 and the crates' `rust-version` is 1.94.1. The Dockerfile and `release.yml` build with Rust 1.98.1, so lints must pass on both. |
| Node.js | 26.3 (via nvm) | Runs the starter's TypeScript directly (`node celld/generate.ts`). |
| pnpm | 11.17 (the starter pins 11.17) | `pnpm install` in the starter also installs the `cloudflare-os/` submodule workspace through a postinstall hook. |
| esbuild | 0.28.x | `celld deploy` and `celld dev` need it. It isn't on `PATH`; `starter:celld/env.sh` sets `CELLD_ESBUILD` from the starter's `node_modules`. `tests/conformance` pins esbuild 0.28.1 as a devDependency and uses its own copy. |
| podman | 5.8 | Runs Azurite: `mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --loose`. MinIO images can't be pulled anonymously any more. |
| Python 3 | 3.x | `starter:celld/azurite-container.py <name>` creates a blob container (a SharedKey-signed PUT). |
| `gh` | any | Reading workerd's source for differential details: `gh api repos/cloudflare/workerd/contents/<path>?ref=<tag>`. |
| Playwright Chromium | cached under `~/.cache/ms-playwright/` | For `e2e/browser.ts`. Check which build `playwright-core` 1.64 expects (`npx playwright install --dry-run chromium`), and install it if it's missing. |
| sqlite3 CLI | any | The Dockerfile's test stage expects it. |

**Starter setup.**

```sh
cd ~/projects/cloudflare-os-starter
git submodule update --init
pnpm install
celld/build.sh
```

**Fork branches.** Fetch them as described in the prior-art page. The app-side
forks are re-cloned when needed:
- `https://github.com/patcon/cloudflare-os-celld`, branch `celld-test`, for
  `scripts/celld/run-local.ts`, `make-config.ts` and `TODO.md`
- `https://github.com/mohamedalichelbi/cloudflare-os`, branch
  `portability/celld-mvp`

Earlier scratch copies under `/tmp` are not kept.

## Adoption policy for code from other forks

Every commit brought in from another fork must meet the same bar as code we
write ourselves, before it lands on `main`.

1. **Read the whole diff line by line.** A reviewer's summary is not enough.
   Run `git show --stat` first, then reject or strip any hunk outside the
   item's scope, such as:
   - version bumps;
   - `Cargo.toml`/`Cargo.lock` dependency changes;
   - CI workflows;
   - build scripts;
   - new binaries or scripts.

   A dependency change needs its own justification and review: licence,
   maintenance, and `cargo deny`/advisory status.
2. **Write the test first.** Add the item's conformance case or unit test on
   `main`. It must fail for the stated reason. Then apply the change and show
   that it passes. Behaviour is pinned against workerd, not against the fork.
3. **Security checklist.** For each change, answer in the commit message or
   PR:
   - Can untrusted code (a Dynamic Worker, or model-written code mode) reach
     the new surface?
   - Does any value from user data, storage, or the wire gain authority, such
     as ids, markers, or script names?
   - Are inputs bounded (sizes, depths, counts)?
   - Do failures fail loudly?
   - Can it leak resources or pin isolates or cells?
4. **Quality.**
   - `cargo clippy --all-targets -- -D warnings` is clean.
   - Code reads like the surrounding code.
   - No dead code.
   - Errors match workerd's text where workerd has one.
   - Docs (`docs/cloudflare-compat.md`, `docs/services/*`) are updated in the
     same change.
5. **Provenance.** celld is Apache-2.0 (`LICENSE`, `NOTICE`, copyright Deno
   Land Inc.). Before adopting from a fork:
   - Confirm the fork still carries the Apache-2.0 `LICENSE` and adds no
     conflicting terms.
   - Keep the author's authorship with `cherry-pick -x` and a
     `Co-authored-by:` trailer.
   - When reworking, credit the source commit in the message.
   - If in doubt, ask the author to confirm Apache-2.0 for their change.
6. **Scripts from forks** (for example IlyaGulya's fleet and soak scripts) are
   read in full before they are first run. They run only against local
   throwaway buckets and processes, never with real credentials. Once
   reviewed, they are committed under `tests/` and owned like our own code.
7. **No spike builds.** Never build, deploy or develop against a branch that
   contains unadopted fork capability code, not even locally for tooling.
   The harness is developed against `main` and fails where `main` fails.

## Progress

Items run one at a time, in the order below. Each lands as its own commit on
`main` after an independent review. The order follows the plan's dependencies:
0.3 comes first because CI (0.6) needs a clean clippy, and 0.5 waits for 1.7.

| Order | Item | Status | Commit |
| --- | --- | --- | --- |
| 1 | 0.1 Multi-config `celld dev` | done | `11f383b` |
| 2 | 0.3 Rust unit-test convention, clippy clean on Rust 1.99 | done | `d20d9a6` |
| 3 | 0.2 Conformance corpus and runner, seed cases | done | `2b445e4` |
| 4 | 0.6 CI | done | `370d7df` |
| 5 | 0.4 part 1: e2e bring-up, mock LLM | done | starter `46ea5ad` |
| 5b | 0.4 part 2: smoke, browser, checklist, baseline | done | starter `c17f99a` |
| 6 | Phase 0 gate evidence | recorded; awaiting Alex | |
| 7 | 1.1 `cloudflare:workers` exports, `restore` | done | `3ef548c` |
| 8 | 1.2 `tracing` with OTLP export | done | `6e8b960` |
| 9 | 1.3 `ctx.exports` for migrated classes (W4 removed) | done | `9d443f5` |
| 10 | 1.4 service-binding `props`, refused keys | done | `7e8570d` |
| 11 | 1.5 `redirect: "manual"` on incoming requests | done | see log |
| 12+ | Phase 1 in plan order (1.6-1.20), then 0.5 after 1.7 | queued | |

## Phase overview

| Phase | Theme | Unblocks | Effort (engineer time) |
| --- | --- | --- | --- |
| 0 | Test infrastructure | Every later gate | 1.5-2 weeks |
| 1 | Loud gaps and small fixes, including N1/N2/N6/N8/N9, the WebSocket `accept()` bridge (D12) and OTLP spans (D13) | Router mode; the trial workarounds go away; BYOB; chat critical path (tracing, Proxy lookup, RpcPromise) | 4-4.5 weeks |
| 2 | Address-like capability tokens and storage; script-qualified cell scopes | J2 ("turn on" gatekeepers); more than one OAuth gatekeeper | 2.5-3 weeks |
| 3 | Cross-isolate RPC on one node, including facet and loader args | J1, J3 chat | 4.5-6.5 weeks |
| 4 | Facets from another script's class | J3 gatekeepers, J5 | 1.5-2 weeks |
| 5 | `ctx.restore` and persistent stubs | J4, J5 hooks, J6 | 4 weeks |
| 6 | Dynamic Worker tails for RPC and facets | J6 code mode, gadget logs | 0.5 week |
| 7 | Streams over RPC and stream performance | gitPull, gadget export | 1.5 weeks |
| 8 | Cross-node capabilities | Multi-node fleets | 4 weeks |
| 9 | Follow-ups | AI shim (websearch half), wider integration coverage, docs | 1 week |

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
- **Configs.** Accept `celld dev -c a.jsonc -c b.jsonc …`, matching
  `wrangler dev -c`. A positional `PROJECT_DIR_OR_CONFIG` stays as the
  one-config form.
- **Primary.** The **first config is the primary**, as in Wrangler, so a
  fixture runs unchanged on both runtimes. Every config is deployed into the
  dev store, and the primary is deployed last internally.
- **State.** Lives under the **primary's** directory (`<primary>/.celld/dev`),
  as today. `--clean` deletes only that.
- **Dotenv files.** Each config reads its own `.dev.vars` (or `.env`,
  `.env.local`) from its own directory, as `wrangler dev -c` does. Dotenv
  overrides never cross between scripts.
- **Port.** `--port 0` is allowed. Today `dev.rs` refuses anything outside
  1-65535.
- **Ready line.** When the node is ready, print one JSON line to stdout:
  `{"event":"ready","public":"http://127.0.0.1:P","internal":"http://127.0.0.1:Q"}`.
  It is printed again after every successful rebuild. The human-readable
  console output stays on stderr, as `docs/README.md` requires: data to
  stdout, messages to stderr.
- **Watching.** The watcher watches every config's project directory, with
  the same ignore rules. `.wrangler` is already ignored, so `build.command`
  output (1.6) does not loop.

**Tests.**
- Unit:
  - argument parsing: one config, several, mixing positional and `-c`, and
    duplicates refused
  - deploy order: primary last
  - per-config dotenv isolation
  - the ready-line format
- Integration: the runner (0.2) uses it for every case.
- E2E/manual: the two-script WebSocket repro in 1.7 starts with one command.

### 0.2 Conformance corpus with workerd as reference: `tests/conformance/`

**Layout.**

```
tests/conformance/
  package.json + pnpm-lock.yaml   # pnpm (as in the starter), lockfile committed;
                                  # pins wrangler 4.147.0 (createTestHarness) and capnweb 0.12
  run.mjs        # --runtime=celld|workerd|both  --update  --filter <glob>
  lib/           # runner helpers, the OTLP receiver (1.2), the fleet bring-up
  cases/<area>/<case>/
    workers/<name>/wrangler.jsonc + index.js   # order in case.json: first = primary
    case.json
    expect.json
```

**`case.json`.**

```json
{
  "kind": "differential",
  "reason": "only for kind=celld-only: why workerd can't run this case",
  "workers": ["front", "back"],
  "env": {"CELLD_FETCH_PRIVATE_ALLOW": "…"},
  "nodes": 1,
  "xfail": "1.7",
  "steps": [
    {"path": "/run"},
    {"ws": "/x", "send": ["a"], "close": 1000},
    {"restart": true},
    {"otlp": {"spans": ["chat", "execute_tool"]}}
  ],
  "normalize": [{"pattern": "…", "replace": "…", "why": "…"}]
}
```

`env`, `nodes`, `xfail` and `normalize` are optional. `nodes` is 1 by
default.

**Case kinds.**
- **`differential`** (the default). `expect.json` is **recorded from workerd**
  with `--update`; the celld run must match it. This is the only kind
  allowed when workerd can run the scenario.
- **`celld-only`.** For behaviour workerd can't exercise locally:
  - OTLP export (1.2)
  - the SSRF allowlist (1.9)
  - `deploy --dry-run` refusals (1.6)
  - multi-node (`nodes > 1`)
  - celld limits

  `expect.json` is written by hand and reviewed. `reason` is required.
  `--update` never touches these cases.

**Steps.**
- **`path`**: an HTTP request to the primary; the response status and body
  (JSON when typed so) are the transcript, plus any headers named in
  `responseHeaders`. The client doesn't follow redirects.
- **`ws`**: open a WebSocket, send frames, compare received frames and the
  close code. The step is `{ws, send, close?, receive?}`. With `close`, the
  client waits for `receive` frames (default: one per frame sent) and then
  closes with that code. Without `close`, it waits for the server to close.
  Received frames are recorded in `expect.json`. A refused upgrade fails the
  step.
- `path` takes optional `method`, `headers` and `body`.
- **`restart`**: stop the runtime, keep its state, start it again, then
  continue.
  - celld: `POST /shutdown`, then the same `celld dev` command without
    `--clean`.
  - workerd: `createTestHarness` hard-codes `persist: false`, so the runner
    calls `harness.update(sameOptions)`. Miniflare then restarts workerd over
    the same storage directory: memory resets and DO storage survives.
    `examples/counter` records an in-memory count, so a restart that does
    nothing fails.
- **`otlp`** (`{"otlp": {"spans": [...]}}`, celld-only, needs `"observability": true`): assert on spans captured by the runner's in-process OTLP/HTTP
  receiver (`lib/otlp.mjs`). The runner sets `CELLD_OTEL` to it. No collector
  container is needed.

**Multi-node (`nodes > 1`, always `celld-only`).** Arrives with the first
case that needs it; the runner refuses `nodes` and a step's `node` until then.
- The runner starts Azurite in podman and creates a container through
  `starter:celld/azurite-container.py`, or a copy under `lib/`.
- It runs `celld deploy` for each worker (primary last), then starts N
  `celld` nodes on one bucket with distinct `--listen`, `--internal-listen`
  and `--advertise` addresses.
- Steps go to node 1. A case can direct a step to `"node": 2`.

**Expected failures.**
- `"xfail": "<plan item>"` marks a case celld can't pass yet. The runner
  reports `XFAIL (until 1.7)`.
- A case that passes while marked xfail fails the run (**XPASS**), so the
  marker is removed in the same change that fixes it.

**How the runner works.**
- **celld:** runs `target/<profile>/celld dev --no-watch --clean --port 0 -c …`
  in a temp copy of the case. It waits for the ready line (0.1), runs the
  steps, diffs against `expect.json`, then sends
  `POST /shutdown?handoff=preserve` to the internal listener, as `dev.rs`
  does. Temp copies live in the ignored `tests/conformance/.run/`, so Workers
  resolve this package's `node_modules`. `env` applies to celld only.
- **workerd:** runs the case through wrangler's `createTestHarness`, the API
  `cos:integration-tests/src/harness.ts` uses.
- **`--update`** writes `expect.json` **from workerd only**, and only for
  `differential` cases. It runs each case twice and refuses to record if the
  transcripts differ.
- **`--runtime=both`** diffs the two runtimes live.

**workerd version.** Pin wrangler, and so workerd, in `package.json`, and
record the resolved workerd version in each `expect.json` header.
- wrangler 4.147.0 resolves a single workerd, **1.20261001.1**. A
  differential case fails when the installed workerd differs from its
  `expect.json` header.
- **Known workerd behaviour to avoid in cases:** an event waiting on a timer
  while another event holds `transaction()` or `blockConcurrencyWhile` and
  awaits its own timer deadlocks workerd, which resets the object after 30 s.
  celld completes.

**Seed cases**, which pin current behaviour:
- `examples/rpc` (same-isolate RPC)
- `examples/facets`
- `examples/dynamic-worker-tails`
- `examples/counter`
- `storage/nested-root-transactions` (see 1.14), green on both runtimes
- `storage/inflight-event-{async,sync}-transaction` (xfail until 1.14)
- `websocket/accept-websocket-echo`, and `websocket/close-without-handler`
  (xfail until 1.17)

**Prior art.** IlyaGulya's `examples/cloudflare-os-compat/` is a 43-case
`curl`-and-substring suite of Cloudflare OS primitives. Run
`git show refs/forks/IlyaGulya/agentos/cloudflare-os-phase0-runtime:examples/cloudflare-os-compat/test.sh`
to see it.
- **Not a 0.2 task.** Each later item converts the cases it names, into the
  area it names. Cases are recorded from workerd, never by matching
  substrings.
- **Restart cases** use the `restart` step.
- **Cases celld can't pass yet** carry `xfail`.

cnicolov's `crates/celld/tests/rpc_capabilities.rs` (in commit `fcb1977`)
shows a full-binary Rust test pattern.

### 0.3 Rust unit-test convention

- Inline `#[cfg(test)] mod tests` beside the code, run with
  `cargo test --profile lab -p celld <module>::tests`.
- `crates/logic` and `crates/ltx` set `test = false`; a public inline test
  there also needs that removed. The out-of-tree suites sit behind
  `cfg(celld_internal_tests)`, which nothing sets, so they compile out.
- First targets are the pure parsers in `deploy.rs`. Each test asserts both
  the accepted shape and the loud refusal message.
- Keep `cargo clippy --profile lab --all-targets --locked -- -D warnings` clean. The `Dockerfile`
  test stage (lines 23-34) already runs `cargo test` and clippy.

### 0.4 Cloudflare OS e2e harness in the starter: `starter:celld/e2e/`

There is one entry point:
`starter:celld/e2e.sh [check|up|build|deploy|node|smoke|browser|restart|all|down] [--router] [--fresh] [--dev-store] [--quick]`.
Part 1 (bring-up) landed as starter `46ea5ad`, part 2 (smoke, browser,
checklist) as `c17f99a`. `all --router` stops at the health check until 1.7;
run `smoke --router` and `browser --router` by hand. Ports
are configurable (`E2E_PORT`, `E2E_AZURITE_PORT`, `MOCK_LLM_PORT`, defaulting
to the plan's numbers), so it can run beside the manual trial. State lives in
`.celld/e2e/`, except that `--dev-store` uses the primary's `./.celld/dev`.

0. **check**: `celld deploy --dry-run` for every Worker. This idea comes from
   mohamedalichelbi's recipe.
1. **up**
   - Starts Azurite (`celld-e2e-azurite`, image pinned to 3.37.0 by digest). `celld/azurite-container.py <name>`
     takes the container name as its argument.
   - Waits for port 10000 and creates container `celld-e2e-$RUN_ID` (fresh per
     `--fresh`).
   - Starts the mock LLM.
   - `--dev-store`: multi-config `celld dev` with no podman, at a fixed port
     (`PUBLIC_BASE_URL` must match); `--fresh` passes `--clean`.
   - `down` stops only what the script started; `down --fresh` also removes
     the Azurite container and every run's data.
2. **build**: `celld/build.sh`, skipped when outputs are newer than sources.
   After D10 lands, `celld deploy` runs the builds itself.
3. **deploy**: `celld/deploy.sh [--no-router]`. Router mode becomes the
   default after 1.7.
4. **Node**
   - Starts the node, logging to `.celld/e2e/node.log`.
   - Health check (`e2e/health.ts`): `GET /` returns HTML, then `ping()` over
     `ws://…/api`, with a 60 s timeout. `deploy` fails if a running node does
     not adopt the new version.
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
     - The default reply is `{text:"ok"}`. `/__requests` keeps the last 1000.
   - **Reuse:** import `scriptedChatCompletions` from
     `cos:integration-tests/src/mock-model.ts`, which also answers the
     auxiliary prompts (upstream doesn't export the table), so titles are
     deterministic. `node celld/mock-llm.ts --self-test` checks it. Take tool names and argument shapes from
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
     | S0 | `GET /` (router assets); `ping()` as a Cap'n Web HTTP batch to `POST /api` | 200 / JSON | |
     | S1 | `amIAdmin()`, `getAdminApi()` | `true`; a stub | |
     | S2 | `admin.setGatekeeperMode(v, "optional")` for each built-in gatekeeper, `custom` set to the non-default `"disabled"` | modes read back | |
     | S3 | `subscribeToNotifications(new RpcStub(sub))`; dispose | no server error | 6, 8 |
     | S4 | `subscribeConnectedAccounts(sub)` | `ready()` called within 10 s | 6 |
     | S5 | `provisionAmbientAccount("context")` | account arrives on S4's subscriber | 7 |
     | S6 | `api.newGadget().newChat("hello", "scripted")`, pipelined | chat id; model called; chat goes idle; the scripted reply is in `getChatHistory`, with no error message | 6 |
     | S7 | `newGadgetFromBlueprint(id, {})`, with `id` taken from `listFeaturedBlueprints()[0]`; then `getMetadata()` | title | 9 |
     | S8 | scripted tool call that schedules a one-shot task 60 s out; `enableHook` | alarm fires; an `agentCallback` `onSchedule` message in chat | |
     | S9 | restart the node, log in; S2's `custom` mode, S5's account (if made this run) and S6's chat survive | works | durable stubs, restore |
     | S10 | `--router`: S1-S7 all passed through the router (not a rerun: `provisionAmbientAccount` throws the second time) | same | 5 |
     | S11 | scan `node.log` for "cannot cross isolate", "could not be cloned", "is not a function", "dropped a frame for a closed WebSocket", "Invalid reader mode", "already disposed", "does not implement" | none | all |

     Notes from building the gate:
     - celld logs "dropped a frame for a closed WebSocket" (`ws_registry.rs:569`)
       on every clean client disconnect. S11 counts it only when one of
       smoke's sockets closed with 1006. Revisit with 1.17.
     - RPC errors go back to the client and are not logged, so S11 can't see
       them. Phase gates rely on the per-step results.
     - S12 can't prove that the sessions' own isolate retired: nothing ties an
       `/api` session to its isolate. It counts `isolate retiring` lines and
       says so. **Follow-up (Phase 3, with N5/N12):** an info line
       `ws session bound ws_id=N isolate=<heap_id>`, and a way for the client
       to learn its ws_id.
     - S5 is a SKIP on a reused bucket; use `--fresh` for gate runs.
     | S12 | two sessions subscribed to one workspace; wait more than 60 s, so the session isolate retires; edit in one session | the other sees the change | N5, N12 |
     | S13 | scripted code-mode call `env.GADGET.rpc.getDocument()` in a Workspace Docs workspace | returns the document | N2, N6 |
7. **browser** (`e2e/browser.ts`)
   - Uses `playwright-core` 1.64 from `starter:cloudflare-os/node_modules/.pnpm`
     with the cached Chromium in `~/.cache/ms-playwright/`.
   - Steps B0-B6: account and model over the API → log in → home renders
     (onboarding leaves Web Search off) → send "hello" and see the mock reply
     → Gatekeepers page: turn Web Search on → create a gadget from a
     blueprint (reads the landing page's error banner) → scan `node.log`.
   - Fails on console errors outside an allowlist. The allowlist starts with
     the upstream `useAuthenticatedApi must be used within an AuthProvider`
     and `Flagship binding missing`.
   - Fails on any `/api` WebSocket close code 1006.
   - Screenshots go to `.celld/e2e/shots/`.
8. **Manual checklist**: `starter:celld/e2e/CHECKLIST.md`. Each row of the
   phase sections below is a line in it.

`generate.ts` exports `celldFilter(config)` and `generateConfigs(opts)`, so
the adapter in 0.5 can reuse them.

### 0.5 Cloudflare OS integration-test adapter: `starter:celld/integration/`

Upstream's `cos:integration-tests` (44 files) speak Cap'n Web over `/api`
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

After 1.9, `mock-upstream.ts` and the mock LLM are private addresses. The
adapter, `starter:celld/env.sh` and `e2e.sh` must set
`CELLD_FETCH_PRIVATE_ALLOW` for exactly their host:port entries.

### 0.6 CI (GitHub Actions on Alex's fork)

Work lands as direct commits to `main` (see [Review and commits](#review-and-commits)),
so CI runs on **push to `main`** and nightly. There are no pull requests to
gate.

**`.github/workflows/test.yml`, on push** (one job on ubuntu-24.04, Rust
1.98.1 as in `release.yml`, Node 26, pnpm 11.17; pushes touching only
`plans/**` or `**/*.md` are skipped):
- `cargo test --profile lab --locked` (the whole workspace)
- `cargo clippy --profile lab --all-targets --locked -- -D warnings`
- `pnpm --dir tests/conformance install --frozen-lockfile`, then
  `node tests/conformance/run.mjs --runtime=celld`. This runs the
  single-node cases against the committed expectations.

**Build cost.** A V8 build is heavy for hosted runners.
- Cache `~/.cargo` and `target/` with `Swatinem/rust-cache`, keyed on
  `Cargo.lock`.
- Use the `lab` profile.
- Measured on ubuntu-24.04 (2026-10-21): cold run 9m44s (build 4m37s, tests
  2m49s, clippy 1m23s); warm run, with `--runtime=both`, 6m04s (build 2m35s,
  tests 1m45s, clippy 29s, conformance 26s). workerd runs on the hosted
  runner.
- If warm runs exceed about 30 minutes, revisit: a larger runner, or splitting
  build and test.

**Nightly (`schedule`, and `workflow_dispatch`):**
- `--runtime=both`, with workerd from the pinned wrangler in
  `tests/conformance`
- the `nodes > 1` cases, with Azurite as a service container
- the `tests/fleet/` scripts once they're imported (Phase 8)

A failing nightly run opens an issue titled "Nightly test run failed", or
comments on the open one. **This needs issues enabled on the fork**
(`gh repo edit axle-h/celld --enable-issues`). They are off by default for
forks, and Alex has not yet decided. Until then, a nightly failure is
reported at the next phase gate.

The existing `release.yml` is unchanged.

**Prior art.** Import IlyaGulya's fleet scripts under `tests/fleet/`, after a
full review under policy rule 6.
- **Scripts:** `fleet-test.sh`, `ha-test.sh`, `soak-test.sh`, `soak-driver.py`
  and `s3-fault-proxy.py`, from commits `fe8938d`…`b40b607`.
- **Location:** on the fork they live under `examples/cloudflare-os-compat/`.
  The fork's workflow is `.github/workflows/cloudflare-os-compat.yml`.
- **Skip** `restore-test.sh` and `mc-shim.py`, which are S3-only and outside
  our scope. Adapt them for Azurite,
and add a `/call` capability load, since their soak never exercises
capabilities. They become Phase 8's gates. The fork's CI commits
(`bdf5eac`…`5191eca`) show a moto S3 stand and port offsets.

### Phase 0 gate

- The seed conformance cases pass on both runtimes.
- `e2e.sh all --no-router` runs end to end on `main`.
- **The baseline is recorded** (done 2026-10-21, in
  [cloudflare-os-trial.md](cloudflare-os-trial.md#baseline); every FAIL is
  explained by trial failures 5-9). Record each smoke step's actual
  PASS/FAIL there.
  - Every FAIL must name the trial failure or plan item that explains it. A
    failure with no explanation is a new finding, and is added to the plan
    before Phase 1 starts.
  - From then on, each phase gate lists which steps it turns from FAIL to
    PASS, and no step goes from PASS to FAIL.
- CI runs on push to `main` and nightly.

**Gate evidence (2026-10-21), awaiting Alex's review.**
- Conformance: `node run.mjs --runtime=both` gives 6 PASS and 3 XFAIL
  (1.14 x2, 1.17), locally and in CI run 39645990594 on GitHub.
- `e2e.sh all --fresh` (no router) runs end to end on `main`, ending in
  smoke and browser, with the expected failures.
- Baseline: [cloudflare-os-trial.md](cloudflare-os-trial.md#baseline). No
  router: S0, S1, S2, S9 and S11 PASS; S3, S4, S6 and S7 FAIL (trials 6, 8
  and 9); the rest SKIP. Router: S0 PASS; S1, S10 and S11 FAIL (trial 5).
  Browser: B0 PASS; B1-B5 FAIL (trials 5-9). No unexplained failure.
- CI: green on push (cold 9m44s) and with `--runtime=both` (warm 6m04s).
  Nightly failure issues need issues enabled on the fork (see 0.6).
- Not done: 0.5 (the integration adapter) waits for 1.7.

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
- `restore`, which is used as a computed key (`[restore](params)`) about 80
  times in Cloudflare OS's non-test sources, silently defines a method named
  `"undefined"`.

**Design.**
- Export exactly the names workerd's `cloudflare:workers` exports.
  - The canonical list is workerd's `src/cloudflare/workers.ts`, at the tag of
    the workerd version pinned in `tests/conformance`. Read it with
    `gh api repos/cloudflare/workerd/contents/src/cloudflare/workers.ts?ref=<tag>`.
  - Record the tag in a comment beside the list.
  - The differential case below catches drift.
- A name celld doesn't implement yet becomes a stub that throws on use and
  names itself.
- A name workerd lacks fails at link time, as in workerd.
- A namespace import (`import * as cf`), on the full-surface path at
  `modules.rs:601`, exposes exactly the canonical list. Unimplemented names
  appear there as the throwing stubs.
- `restore` becomes a real well-known symbol now, ahead of Phase 5.
  `ctx.restore` exists only under `allow_irrevocable_stub_storage`, as in
  workerd, and returns a rejected promise until Phase 5.
- **As built (1.1):** `default` is not exported, so a default import fails
  to link, as on workerd. `import()` returns the same module as the static
  import. `cache` and `tracing` are Proxies that throw on use but stay inert
  for logging and serialisation. The celld-only case
  `modules/cloudflare-workers-unimplemented` pins every stub; 1.2 updates it
  when `tracing` becomes real. Recheck the list (including the absent
  `retryable`) whenever the workerd pin moves.
- **N4:** pin `Symbol.keyFor(restore)` and the symbol's description against
  workerd with a differential case. workerd's symbol is native
  (`src/cloudflare/workers.ts:21`), while every fork used `Symbol.for(...)`.

**Tests.**
- Unit: `stub_source` output for a known name, an unimplemented name and an
  unknown name.
- Integration: a `modules/cloudflare-workers-exports` case that imports each
  name and reports `typeof`, compared with workerd.

### 1.2 `tracing`, with OTLP export (D13)

**Status.** Done. The design below is as built.

**Design.**
- `tracing` (from `cloudflare:workers`) and `ctx.tracing` follow
  Cloudflare's custom-spans API and workerd's `src/workerd/api/tracing.c++`
  at v1.20261001.1: `enterSpan`, `startActiveSpan`, `startSpan`,
  `getActiveSpan`, and the `Span` methods, with workerd's error texts.
- `ctx.tracing` is a distinct lazy `Tracing` per ExecutionContext (stateless
  and workflow), **not** `=== tracing`; a DO's `ctx` has none, as in workerd.
- The active span is a key in the AsyncLocalStorage frame. `enterSpan` and
  `startActiveSpan` also put the span's rider in CPED's trace slot, so logs,
  outbound fetches and DO `fetch()` inside the span are its children. A DO
  RPC call starts a new trace (see 1.19).
- `enterSpan` ends the span on sync return or throw, or when a returned
  promise settles. The returned promise always settles, even when it
  settles in another request's turn.
- **Host state.** Each traced invocation owns its span state, which its
  IoContext adopts before Worker code runs. The ops (`__span_owner`,
  `__span_start`, `__span_enter`, `__span_update`, `__span_end`) route by
  the current context. A rider is only a name inside that invocation, so it
  carries no authority. No rider reaches JS. `tracing.js` captures its
  primordials. Spans that are never ended are recorded when the invocation
  ends. A span used from another request throws workerd's IoOwn error.
- **With `CELLD_OTEL` off:** `isTraced` is `false` and spans are dropped.
  Locally, workerd reports `true` by default (wrangler's
  `X_LOCAL_OBSERVABILITY`), so cases set `"observability"` explicitly.
- **With `CELLD_OTEL` on:** spans export over OTLP and Parquet as children
  of the invocation's span. `telemetry::Span` has owned names, a
  `SpanStatus`, attributes and exceptions. Parquet gains `attributes` and
  `exceptions` columns.
- **Limits.** workerd's: 64-byte names, about 64 KiB of attributes per span
  (its `bytesUsed`, with its warning attributes), 64 KiB status messages,
  `undefined` ignored. celld's, because the data is in host memory:
  1024 open spans and 1 MiB per invocation with overhead charged, 64 MiB
  node-wide (shared, with no per-script fairness), and a 64 MiB export
  queue. `celld.` attribute keys are reserved for celld.
- Sampling is operator-controlled. 1.6 accepts the Wrangler `observability`
  block with a note, and doesn't read it.
- Also fixed here: `KIND_CONSUMER` exported as OTLP PRODUCER (4, now 5).

**Prior art.** royalcala `22b3352` (patcon `e5878e3`) and cnicolov's
`tracing.js` were read as reference only (no-op stubs); no code was taken.

**Tests.**
- Differential: `tracing/custom-spans` (including a `/patched-globals`
  route), `tracing/untraced`, `tracing/cross-request`,
  `tracing/workflow-context`.
- celld-only: `tracing/otlp-export` (the `otlp` step, with the receiver in
  `tests/conformance/lib/otlp.mjs`), and
  `tracing/settle-in-another-request`.
- Unit: limits, accounting, forged riders, concurrent invocations, OTLP
  encoding, span kinds, the queue cap.
- **Remaining differences (documented):** a function bound to module-scope
  async context sees the invocation span during a request; workerd sees
  `undefined`. Overlapping DO events have separate contexts, so a span used
  from a sibling event throws.
- E2E/manual: after Phase 3 and 1.19, a chat turn completes and the
  collector shows `invoke_agent`, `chat` and `execute_tool` spans in one
  trace.

### 1.3 `ctx.exports` namespaces for classes declared only in migrations (trial failure 4)

**Problem.** `do_classes` comes only from `durable_objects.bindings`
(`deploy.rs:1401-1417`). It drives three things, all of which skip
migration-only classes:
- `register_class` (`js.rs:5928-5948`)
- `populate_cf_exports` (`js/bootstrap.rs:356`)
- `cell_configs` (`generation.rs:520-570`)

**Design.**
- In `read_project`, add each non-reserved class from `sqlite_classes` to
  `do_classes`. Namespace keys depend only on (script, class).
- Fix the "DO class not exported" check (`js.rs:5936`). `ns.get` returns
  `undefined`, not `None`, so the check never fires; make it a clear load
  error.

**Prior art.** Adopt the `deploy.rs:1299` hunk of IlyaGulya `30f2a48`.

**As built.** The hunk was applied by hand. Also:
- `ctx.exports` lists every exported class as workerd does: a namespace for
  a class with storage, otherwise a loopback facet class (plain classes
  too). Workflow and cron classes are excluded.
- An unexported or non-class DO is a **load error** with workerd's text
  (workerd only logs it and fails calls), under the loud-gap rule. It fails
  the whole generation, co-hosted scripts included.
- A Python Worker with `new_sqlite_classes` is refused at deploy.
- With W4 gone, the starter's e2e matches the baseline.

**Tests.**
- Unit: a migration-only class lands in `do_classes`; no duplicates when it
  is also bound; reserved classes are unaffected; the control-plane manifest
  check passes.
- Integration: an `exports/migrated-namespace` case. The id from
  `ctx.exports.X.getByName("a")` equals the id from an `env` binding.
- E2E/manual: remove W4 from `generate.ts` and deploy to a fresh bucket.
  Sign-up, admin settings and the user DO work.

### 1.4 Service-binding `props`, and refusing ignored keys

**Problem.** `deploy.rs:1424-1460` drops `props`, and every other key except
`binding`, `service` and `entrypoint`. The runtime already carries props:
`__makeServiceBinding(script, ep, propsSc)`, `SvcRpcReq.props`, and `ctx.props`
delivery in `__beginEvent`.

**Design.**
- **Deploy:** keep `props`, which must be a JSON object, verbatim in the
  binding metadata (`"props": {...}`). That is Cloudflare's upload shape.
- **Node:** `fleet.rs:999` `service_bindings` returns a struct with
  `props: Option<serde_json::Value>`.
- **Encoding, end to end.** The manifest carries JSON. `bootstrap.rs:660`
  emits `__makeServiceBinding(script, ep, __celld.__propsBytes(<JSON literal>))`.
  `__propsBytes = (v) => __rpcOut(v, false)` structured-clone-encodes the
  props once, at isolate start, into the `propsSc` bytes the runtime already
  carries.
  - Emit the literal with `serde_json` and escape U+2028/U+2029, never with
    Rust `{:?}`.
  - When there are no props, emit `undefined`, so the same-script fast path
    still applies.
- **Size bound:** 1 MiB of encoded props, the same limit as loader props
  (`docs/services/dynamic-workers.md`). It is checked at deploy against the
  JSON size and at isolate start against the encoded size.
- **Default entrypoint:** `op_svc_call_impl` (`js.rs:7141-7148`) drops props
  when the entrypoint is null. Send them as entrypoint `"default"` instead.
- **Refuse:** any unknown `services[]` key, and `environment`.
- **Refuse in `durable_objects`:** `script_name`, `environment`, and any key
  other than `name`/`class_name` in a binding. Also refuse any key other
  than `bindings` at the `durable_objects` top level.
- **Accept:** `remote`, which only affects `wrangler dev`, with a code comment.

**As built.**
- Bootstrap emits props as a JSON string literal that the harness
  `JSON.parse`s (so `__proto__` stays an own key), then encodes it.
- Deploy refuses props whose **encoded** size could exceed 1 MiB, using a
  conservative estimate. The isolate-start check stays for foreign
  manifests. `op_svc_call`, `op_svc_rpc` and the loader's `globalOutbound`
  props are bounded too. Same-isolate calls are unbounded, as in workerd.
- Same-script calls keep props in the isolate. Each invocation gets its own
  props object, `{}` when there are none, as in workerd. Default-entrypoint
  props also reach `scheduled()`.
- `ctx.exports.X({props})` copies props when the stub is made, and builds a
  fresh instance per call. Values that can't be cloned are refused, as in
  workerd.
- Accepted with a comment: `remote` on services and DO bindings, and `dev`
  on services, checked against Wrangler's shape.
- A manifest with non-object props or a non-string entrypoint fails the
  load.
- **Remaining difference:** `ctx.props` keys arrive sorted, because
  serde_json has no `preserve_order` (a build-wide feature). Follow-up:
  decide whether to enable it.

**Prior art.** Rework IlyaGulya `2172ce1` (it applies cleanly). It carries
props through to `__makeServiceBinding`, but has no validation, no
default-entrypoint props and no refusals.

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
- E2E/manual: an error report from the workshop carries the `service` and
  `environment` props.

### 1.5 `redirect: "manual"` on incoming requests

**Problem.** `__makeRequest` (`harness.js:538`) gives incoming requests
`redirect: "follow"`. When the router forwards `req`, the target's 302 is
followed on the server, which breaks the gatekeeper OAuth redirects.

**Design.** Incoming requests get `redirect: "manual"`. That covers top-level
requests, DO `__dispatchTo`, service-binding targets and entrypoint targets.

**Tests.**
- Integration: a `service-bindings/redirect` case. A front forwards `req` to a
  back that returns 302, and the client sees the 302. It records `redirect`
  as seen by every target: top-level, service binding, named entrypoint,
  self binding, the three `ctx.exports` shapes, DO, facet and loader.
- `fetch(req)` to an outside URL is the celld-only
  `service-bindings/redirect-outside`: wrangler's harness follows redirects
  in its Node outbound service, whatever the mode. It reaches the node's own
  public listener over loopback, so 1.9 must keep it working (see 1.9).
- Path steps gained `responseHeaders` to record headers such as `Location`.

### 1.6 Deploy configuration relaxations

| Change | Design | Unit tests |
| --- | --- | --- |
| JSON `vars` | A `{"type":"json"}` binding, installed with `JSON.parse` per isolate. Cap each var at 5 KiB. Dotenv overrides stay strings. | Nested values; a dotenv override; the size cap |
| `rules[].fallthrough` | Accept `false`. Accept `true` only when no other rule claims that extension; refuse it otherwise. | All three cases |
| `observability` | Accept, and print one line: telemetry is operator-controlled (`CELLD_OTEL`). | Warning text |
| `build` | Run `build.command` with `sh -c` in `build.cwd` (default: the config's directory) before resolving `main`. A non-zero exit stops the deploy. `--no-build` skips it. `celld dev` watches `watch_dir`. | cwd; failure propagation; `--no-build` |
| `workers_dev`, `preview_urls` | `false` is accepted silently; `true` is accepted with a warning. | Both |
| `account_id` | Accept and ignore. | |
| `routes` | Keep refusing, with a better message. | Message |
| `secrets.required` | Each name must be provided by `vars` or, under `celld dev`, by a dotenv file (`.dev.vars`, `.env`). Otherwise the deploy fails. Document that celld secrets are plaintext vars. | Missing and present; dev vs deploy |

**Prior art.**
- Rework mertdogar `da1ef43`: `IGNORED_PLATFORM_KEYS` with a note, merging
  cleanly. Keep refusing `routes`/`route`. Make `workers_dev`/`preview_urls`
  silent when `false` and warned when `true`. Its extra keys are fine.
- Rework the JSON vars, `build` and `observability` pieces of IlyaGulya
  `d6e0988`. Add the size cap and `--no-build`. Drop its
  `rules` part.

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
- **The `accept()` bridge (D12).** When the intermediate Worker calls
  `accept()` on a `_workerHandoff` socket, it proxies frames itself.
  - The host adopts the target's handoff and bridges its pull queue to a new
    Worker-side socket owned by the caller's context.
  - Frames, close codes and errors pass in both directions.
  - Backpressure follows the 1 MiB queue budget per direction.
  - Closing either side closes the other with the same code.
  - The bridge is released when the caller's context retires.
  - A DO returning such a socket throws.
  - A 101 response with no socket becomes a 500 that names the cause.
- **Risks:**
  - The target's event must stay alive while its socket is pumped.
  - `Sec-WebSocket-Protocol` must pass through.
  - A parked handoff that is never adopted is closed with code 1011 and
    removed after **30 s**, and also when its generation retires. The sweep
    interval and timeout are constants with a unit test.
  - Only stateless Worker sockets go through this path. DO-held and
    hibernatable sockets already use the `Cell` variant, which crosses
    bindings today, and hibernation is unchanged.
- **A DO returning a handed-over socket.** Write a differential case first. If
  workerd allows it, implement it; if workerd refuses it, refuse it with
  workerd's message. Either way it is not a documented celld divergence.

**Prior art.**
- IlyaGulya `8376ebc` is a minimal reference. Its `WorkerWebSocket::repark`
  is our `park_worker_handoff`, but it keeps the id on the Response, so a
  rebuild loses it. It also has no adopt, sweep, loader or broker paths, or
  refusals.
- mohamedalichelbi's `fix/service-binding-websocket` is already upstream and
  covers only the `Cell` half. Keep his idea of registering the target's pump
  as `waitUntil` of the target event.

**Repro to start from** (trial failure 5; two scripts):

```js
// back.js (service "wsback")
export default { fetch() {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (e) => server.send("echo:" + e.data));
  return new Response(null, { status: 101, webSocket: client });
} };
// front.js (primary; services: [{binding: "BACK", service: "wsback"}])
export default { fetch: (req, env) => env.BACK.fetch(req) };
```

**Tests.** The integration case needs the 0.2 runner's `ws` step.
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
  - `accept()` in the front: the front sees each frame and echoes it on, close
    codes propagate both ways, and a large message respects the 1 MiB budget
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

**Design (chosen).** Two mechanisms, each where it fits.
- **Host-backed bodies and `Blob.stream()` become native `type:"bytes"`
  streams.**
  - This covers `CelldHttpBodyStream` (`harness.js:213`) and the Blob
    polyfill's `stream()`.
  - The underlying source fills `controller.byobRequest` directly when there
    is one, and enqueues chunks otherwise.
  - That is the spec's own mechanism, so BYOB, `readAtLeast`, `tee()` and
    cancel come from the streams implementation, not a parallel code path.
- **Generalise the rest with `_chunked`.** In `byte_streams.js`, turn
  `ReadableStreamBYOBReader._buffered` into `_chunked(pullChunk, cancel)`
  and install it with a `__makeInternalByteStream` helper, the way
  `identity_transform_stream.js:311` already does. This covers:
  - the readable side of `CompressionStream`/`DecompressionStream`
  - RPC-revived readables
  - KV streams, if they turn out not to be byte streams
  
  Each of those has its own chunk source.
- `tee()` of any of these returns streams of the same kind.
- A user `new ReadableStream()` without `type:"bytes"` keeps refusing BYOB,
  as the spec and workerd do.

**Prior art.** royalcala `ef5e87c` takes the native `type:"bytes"` approach
for `CelldHttpBodyStream` and `Blob`.
- **Reference only:** it depends on `crates/celld/capability.rs` from the
  forbidden capability routing, so it can't be cherry-picked. Write the change
  fresh.
- Skip `60209d3`.

**Performance check.** This changes the fetch-body hot path. Add a script,
`scripts/bench/fetch-body.sh`, that streams 256 MiB through a Worker
(`request.body` piped to the response, and a `fetch()` body read to the end)
on a `lab` build and reports MiB/s.
- Record before and after numbers in the commit message.
- A slowdown of more than 5% is fixed or explicitly justified.

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

### 1.9 Outbound egress policy for `fetch()` (and `nodejs_als`)

**Correction (checked against workerd's `compatibility-date.capnp`, `@51`).**
`global_fetch_strictly_public` is **not** a private-address filter. On
Cloudflare it only decides whether a `fetch()` to a hostname in the Worker's
**own zone** goes to the zone's origin server (`global_fetch_private_origin`)
or through Cloudflare's public front door.

What actually protects Workers on Cloudflare is the network. Global `fetch()`
always leaves from Cloudflare's edge onto the public internet, so it can
**never** reach private, loopback, link-local or metadata addresses, flag or
not. Cloudflare OS relies on that when its agent fetches model-chosen URLs
(`cos:workshop-backend/src/web-fetch.ts:12-19`).

**Problem.** celld's global `fetch` uses plain `reqwest` clients
(`js.rs:721-730`, `11091`), so any Worker can reach:
- the node's internal listener, with its unauthenticated operator routes
- cloud metadata endpoints
- peer nodes
- anything else on the host's networks

`reqwest` also honours proxy environment variables. This affects every Worker,
not only ones that set the flag.

**Design.**
- **A node-wide egress policy for global `fetch()` and `new WebSocket()`**
  (both are global outbound requests). It matches what Cloudflare's network
  gives a Worker. The resolver drops these ranges, including their
  IPv4-mapped and NAT64 forms:
  - loopback
  - RFC1918
  - CGNAT
  - link-local and metadata
  - ULA
  - multicast
  - unspecified
- **Requests.**
  - IP-literal hosts are checked before each request and at every redirect
    hop.
  - Clients use `.no_proxy()`.
- **Exempt, as on Cloudflare:** service bindings, `ctx.exports`, Durable
  Object stubs and `connect()` from `cloudflare:sockets`. The sockets API is
  a deliberate operator-network tool: keep it unrestricted and document that.
- **Operator escape hatch (D11):** `CELLD_FETCH_PRIVATE_ALLOW`, a list of
  `host:port` entries parsed and validated once in `env_vars.rs`. It is for
  self-hosted deployments that legitimately call internal services, and for
  local development (a local model server).
- **The node's own internal listener and advertise addresses are always
  blocked**, even when they are allowlisted.
  - **Plumbing:** the node passes those socket addresses into the outbound
    client builder when it builds the runtime.
  - This is a separate hardening commit.
- **Error.** A refused request rejects with a `TypeError` whose message names
  the policy and the escape hatch. Cloudflare can't produce this case, so no
  workerd text is matched; document the message in `docs/security.md`.
- **The `global_fetch_strictly_public` flag** is classified in 1.16 as
  **no-op by design**: celld has no zone origin to bypass. The policy above
  applies whatever the flag says.
- **`nodejs_als`:** AsyncLocalStorage already works without gating. Classify
  it as honoured in 1.16 and pin it with a case.

**On by default (D16).** Every Worker gets the policy with no flag. Local development (a mock LLM, Ollama, the integration adapter's mock upstream) adds `CELLD_FETCH_PRIVATE_ALLOW` entries.

**Tests.**
- Unit:
  - the resolver filter table, including v4, v6, mapped and NAT64 forms
  - the escape-hatch parser, including invalid entries
  - the node's own addresses always refused
- Integration: `fetch-public/` cases, all `celld-only` (Cloudflare's behaviour
  comes from its network, not the runtime):
  - a literal private IP
  - a redirect to a private address
  - a hostname that resolves to a private address (`localhost`, which the
    system resolver maps to 127.0.0.1)
  - a public host
  - an allowlisted host:port passing, while the same host on another port is
    refused
  - the internal listener refused even when allowlisted
  - `new WebSocket()` to a private address refused
- The runner starts celld on `--port 0`, so cases that fetch the node's own
  public listener (`service-bindings/redirect-outside`) need the runner to
  allow that port, or a placeholder in `env`. Decide whether the node's own
  public listener is always blocked; if it is, move such cases to a separate
  Worker served elsewhere.
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

### 1.11 Method lookup on get-only Proxies (N2)

**Problem.** `__stubResolve` (`harness.js:4018-4021`) and
`__entrypointResolve` (`4541-4546`) test methods with `prop in target`. A Proxy
without a `has` trap answers from its bare target, so a forwarded method is
rejected with "RPC receiver does not implement". workerd uses `[[Get]]`.

Cloudflare OS hits this in two places:
- the `getGadgetFacet` facet Proxy
- `GatekeeperLoopback`, whose constructor returns a Proxy

This is a same-isolate bug, independent of Phase 3.

**Design.** Fall back to `target[prop] !== undefined`, keeping workerd's
visibility rules for reserved names and own properties.

**Prior art.** Adopt royalcala `ffd1011` (RpcTarget) and `da57cca` (entrypoint
instance), from patcon. royalcala `2bd84cd` has a different variant. Choose
the one the differential case supports.

**Tests.**
- Integration: an `rpc/proxy-targets` case for a get-only Proxy RpcTarget, a
  WorkerEntrypoint whose constructor returns a Proxy, and `new RpcStub(proxy)`,
  diffed against workerd. Port IlyaGulya's `/proxy-rpc-target` and
  `/proxy-entrypoint` cases.
- E2E/manual: smoke S13 once Phase 3 lands.

### 1.12 DO stub calls return an RpcPromise (N6)

**Problem.** DO stub methods return a plain `async` Promise
(`harness.js:5275`), so pipelining (`stub.method().other()`) and property
access on the result fail. Cloudflare OS's `GatekeeperLoopback` returns a
get-only Proxy over an un-awaited `startGatekeeperSession()`.

**Design.** Return
`__makeNode(__valueSession(invoke(...)), [], __ctxNow())`, as entrypoint stubs
already do.

**Prior art.** Adopt royalcala `38082b4` (patcon `333a2c7`). For
`Symbol.dispose` on RpcPromises, also take IlyaGulya `4594b6c`, which applies
cleanly.

**Tests.**
- Integration: `rpc/do-promise-pipeline`, covering `host.returnTool().echo()`
  and the dispose of an RpcPromise. Port IlyaGulya's `/do-return-rpc-pipeline`
  and `/rpc-promise-dispose`.

### 1.13 Stubs passed as params are duplicated (N1, same-isolate part)

**Problem.**
- From compat date 2026-01-20, workerd **duplicates** stubs in call params
  (`rpcParamsDupStubs @152`; disabled by `rpc_params_transfer_stubs`), but
  still transfers return values.
- For an RpcTarget, function or Proxy with its own `dup()`, workerd calls it
  and takes ownership of the result. The result must be the same kind, or
  workerd throws `DOMDataCloneError` (`worker-rpc.c++` ~3010-3155).
- celld transfers instead (`harness.js:4231`,
  `meta.disposed = true; // the ref moves to the receiver`).
- Cap'n Web depends on duplication: a forwarded stub dies when the forwarding
  call returns ("This RpcImportHook was already disposed").

**Design.**
- Add `Compat.rpc_params_dup_stubs` (date-gated, with the disable flag).
- Duplicate in the **param** lift only, and apply the `dup()` rule with
  workerd's error text.
- Phase 3.2 extends this across isolates.

**Prior art.** Reference royalcala `b02d30e` (patcon `1f7076f`). It is a
heuristic: it applies to returns too, swallows errors and never validates the
result.

**Tests.**
- Integration: `rpc/params-dup`, covering:
  - proxying a call twice
  - a callee keeping `dup()` past the call
  - a return value still transferring
  - a `dup()` returning the wrong kind
  - the flag off
  
  All diffed against workerd.

### 1.14 Transactions on the root storage object (N8)

**Status.** Nested transactions are already fixed upstream in v0.6.0, and
`storage/nested-root-transactions` pins them on both runtimes: nested sync and
async, inner-only rollback, an inner commit undone by an outer rollback, and
two concurrent events (which both runtimes run one after the other; the order
is in the transcript). mohamedalichelbi `7221aa7` is a v0.3.0 fix that this
supersedes. **Do not port it.**

**Problem (found by 0.2).** The fix scopes the open transaction to its owner
event with `__io_context_id()` (`harness.js:1759-1780`, `1897-1911`;
denoland/celld#226). workerd has no such scoping. When event b is already in
flight and starts a transaction while event a's is open, workerd **joins** b
to a's transaction: each sees the other's uncommitted writes, and a's rollback
discards b's write. celld instead gives b a separate transaction that waits
for a (async), or throws "cannot start a transaction within a transaction"
(sync). `storage/inflight-event-{async,sync}-transaction` pin workerd's
behaviour and are xfail. Replacing the owner check with `true` at both sites
makes both XPASS.

**Decision.** Match workerd (the reference), following the plan's rule: drop
the owner scoping so an in-flight event joins the open transaction. Check
that the nested and concurrent cases stay green.

**Tests.** Remove `xfail` from both in-flight cases.

### 1.15 `process.env` and `node:process` (N9)

**Problem.**
- `nodejs_compat_populate_process_env` (default from 2025-04-01) is accepted
  without effect: under `nodejs_compat`, `process.env` should hold the string
  vars.
- `import process from "node:process"` is not the global `process`.

**Design.**
- Populate `process.env` before module evaluation, honouring the date gate and
  the enable/disable flags. Build the literal with JSON.
- Decide how JSON vars (1.6) appear in `process.env` with a differential test.
- Map `node:process` to the global.

**Prior art.** Rework mertdogar `6d8e461` and take `cde80c7`, dropping the
FORK.md hunks.

**Tests.**
- Integration: `node/process-env` (dates and flags, string and JSON vars) and
  `node/process-module`.

### 1.16 Compatibility-flag audit

**Problem.** `docs/cloudflare-compat.md:197` says celld "accepts every other
flag without effect". That blanket rule breaks the loud-gap rule. Most flags
are behaviour switches a Worker depends on, as
`nodejs_compat_populate_process_env` (1.15) and `rpc_params_dup_stubs` (1.13)
showed.

**Design.**
- List every flag that is enabled by a compatibility date up to 2026-09-04, or
  that a Cloudflare OS Worker sets.
- Classify each flag:
  - **honoured:** implemented, with a case
  - **no-op by design:** the behaviour is already celld's default, or the flag
    doesn't apply; each needs a one-line reason in the docs
  - **refused at deploy:** unimplemented behaviour a Worker would silently
    lose
- Unknown flags are refused at deploy, as workerd refuses them.
- Known gap (found by 1.4): celld always exposes Fetcher `scheduled()`.
  Without `service_binding_extra_handlers`, workerd treats
  `env.X.scheduled(...)` as an RPC call to a method named `scheduled`.
- Replace the blanket sentence in the docs with the three lists.
- New flags from later items (`rpc_params_dup_stubs` in 1.13, the
  `streamingTails` refusal in Phase 6) are added to the lists as they land.
  `allow_irrevocable_stub_storage` is already honoured and reported in
  `Cloudflare.compatibilityFlags` (1.1); Phase 2 adds its storage
  enforcement.

**Tests.**
- Unit: the classification table covers every flag in workerd's
  `compatibility-date.capnp` at the pinned tag. A new upstream flag fails the
  test until it is classified.
- Integration: a `deploy/` case where a refused flag stops the deploy, and one
  per honoured flag.

### 1.17 Close replies on WebSockets with no close handler

**Problem (found by 0.2).** celld always answers a peer's Close with an echo
(`ws_registry.rs` ~1246). workerd 1.20261001.1 does not:
- Hibernatable sockets never get an automatic reply. With no
  `webSocketClose` handler, the client sees 1006.
- Sockets accepted with `accept()` reply automatically only under
  `web_socket_auto_reply_to_close` (enable date 2026-04-07, disabled by
  `web_socket_manual_reply_to_close`). Before that date, the socket is
  half-open until the Worker calls `close()`.

**Design.** Match workerd: no automatic reply for hibernatable sockets, and
for accepted sockets only when the flag is on. 1.16 classifies both flags as
honoured.

**Tests.** `websocket/close-without-handler` (compat date 2026-01-01) loses
its `xfail`. Add the same case at a date after 2026-04-07 for the accepted
socket.

### 1.18 Worker Loader startup error text

**Problem (found by 1.1).** A Dynamic Worker that fails to start reports
`instantiate: SyntaxError: …` on celld. workerd reports
`Failed to start Worker:\nUncaught SyntaxError: …\n  at <file>:<line>:<col>`.

**Design.** Match workerd's text for every startup failure through the
Loader.

**Tests.** Widen the link steps in `modules/cloudflare-workers-exports`
back to the full message.

### 1.19 Trace context across DO RPC calls (found by 1.2)

**Problem.** `op_rpc_call` and `RpcCallReq` carry no parent trace context,
so a DO RPC event starts a new trace. Cloudflare OS's chat turns cross DO
RPC, so their spans split across traces.

**Design.** Thread the caller's trace context through `RpcCallReq` →
`dispatch_rpc_call` → `CellJob::Rpc` and the peer tunnel, as DO `fetch()`
already does.

**Tests.** Update the `tracing/otlp-export` transcript, which pins the new
root today.

### 1.20 Redirect handling (found by 1.5)

Each one differs from workerd 1.20261001.1:
- `fetch()` on a DO stub with the default `follow` returns the 302. workerd
  follows it through the same stub. Loader entrypoint and facet fetch
  likely share the path.
- A service binding follows a redirect through the global `fetch`. workerd
  follows it through the same Fetcher, so a relative `Location` goes back
  to the service.
- `redirect: "error"` is accepted. workerd throws `TypeError: Invalid
  redirect value, must be one of "follow" or "manual" ("error" won't be
  implemented since it does not make sense at the edge; use "manual" and
  check the response status code).`
- After a followed redirect, `response.url` is the original URL and
  `redirected` is false. workerd gives the final URL and `true`.

**Tests.** Differential cases for each, in `service-bindings/` and
`fetch/`.

### Phase 1 gate

- All new conformance cases pass on both runtimes.
- W1 (except `ai`/`browser`), W2, W3, W4 and W5 are gone from
  `generate.ts`, and `e2e.sh deploy --router` succeeds.
- The browser shows the home page through the router.
- Smoke S0, S1 and S10 pass. S3-S7 still fail, now only for the Phase 2/3
  reasons (S11 is clean of "Invalid reader mode" and "dropped a frame").
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
- Extend `__svcMeta` (`harness.js:4813`; loopback `ctx.exports` stubs) and
  `__outboundMeta` (`harness.js:3196`; service-binding Fetchers) with
  `script` and `persistent`.
- Give class handles (`__durableClassMeta`, `harness.js:2097`) a `script`.
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
  `0x01 ‖ HMAC(key, bytes) ‖ bytes` (D7).
- **The key (D7):** HMAC(peer_key, "celld-capability-key-v1").
  - `peer_key` is the fleet's persisted peer-signing key
    (`peer_auth::load_or_create`, `main.rs:3810`, `4004`), so the key is
    fleet-wide and survives restarts.
  - **Do not** use the DO-id key. That is `SHA256(namespace_key)`
    (`engine_api.rs:433-441`), which anyone can derive.
  - **`celld dev`** runs its node on the local dev store bucket, so it should
    get a persisted peer key the same way. Confirm this first. If dev has no
    persisted key, persist one in the dev store; a random key per process would
    break the `restart` conformance cases.
  - royalcala's random per-process fallback when no bucket exists is not
    acceptable: there is always a bucket.
- **Refused, with workerd's wording:**
  - a non-persistent token
  - any write from a script without the flag
  - a plain transient stub or RpcTarget ("not a persistent stub")
- **Compat:** `Compat` (`engine_api.rs:247-266`) gains
  `allow_irrevocable_stub_storage`.
- **Same-script loopbacks** need the flag too (D6). This changes today's
  lenient behaviour; update `docs/services/durable-objects.md` accordingly.

**Prior art.**
- **Rework** royalcala `d534083`: the HMAC-SHA256 token codec, with bounds,
  domain separation and 9 inline tests. Delete its unused
  `CapabilityRegistry`.
- **Adopt** `init_capability_key` from royalcala `2bd84cd` (`js.rs:9069`,
  `main.rs:4142`). The key is HMAC(peer_secret, "celld-capability-key-v1").
  The peer secret is already persisted, so the key is fleet-wide and survives
  restarts. **This is D7's key source.**
- **Reference** IlyaGulya `141db35` (`svc{script}` by value; its script field
  is trusted from the payload, which our HMAC fixes) and `30f2a48`
  (DurableObjectClass lift/revive/store).
- Do **not** take cnicolov's loopback hunk, which makes `ctx.exports` stubs
  transient and unstorable.

### 2.3 Callable migrated namespace

workerd's `LoopbackDurableObjectNamespace` is a namespace that is also
callable. `ctx.exports.Cls({props})` returns a `cls` token.
- Make celld's migrated-class namespaces (`harness.js:4988-4993`) callable.
- Remove the facet-doc restriction "A class with a storage migration cannot
  supply one".
- Using the token as a facet class is Phase 4.

**Prior art.** IlyaGulya `30f2a48` makes every `ctx.exports` class a callable
factory that also carries the namespace methods (`harness.js:5395` in the
fork). Use it as a reference.

Also pin `typeof ctx.exports.X === "function"` and the
`[object LoopbackDurableObjectClass]` tag of loopback classes in
`exports/migrated-namespace`; 1.3 left both out.

### 2.4 DO class names that collide across co-hosted scripts (N10)

**Problem.** (Until this lands, conformance cases give each co-hosted
script's DO classes distinct names; see `modules/cloudflare-workers-exports`.)
- v0.6.2 refuses two co-hosted scripts that export the same DO class name
  (`generation.rs:587-596`, "exported by more than one co-hosted script").
- About 14 Cloudflare OS OAuth gatekeepers (github, gitlab, slack, notion,
  google, …) each export `UserAccount`, and mcp and mcp-portal both export
  `McpAccount`.
- So a deployment with **two OAuth gatekeepers** can't start. The trial
  didn't hit this because it installed none.

**Design.**
- Key every user class's cells by `(script, class)`, whichever script is
  primary. Namespace keys already include the script (`engine_api.rs:545`).
  The remaining work is the class-keyed tables: `cell_configs`,
  `register_cell_class`, and the cell-scope routing in `generation.rs` and
  `runtime.rs`.
- **Always on, one code path (D15).** Every deployment names cells this way.
  Remove the "exported by more than one co-hosted script" refusal
  (`generation.rs:587-596`).
- **Do not** copy IlyaGulya's approach of hashing only **non-primary** scripts'
  classes (`.svc.<hash>`, `30f2a48`). Which script is primary changes with
  deploy order (for example, the trial's `--no-router` mode), so names would
  change with deploy order.


**Tests.**
- Unit: scope derivation does not depend on which script is primary.
- Integration: port IlyaGulya's `same-class` case (router + A + B, both
  exporting `UserAccount`; `/a` → `a:1`,`a:2`; `/b` → `b:110`,`b:120`). Then
  swap which script is primary and check that the data is still there.
- E2E/manual: deploy with two OAuth gatekeepers (for example GitHub and
  Linear, without credentials); the node starts and both appear on the
  Gatekeepers page.

### Tests

**Unit:**
- encode/decode round trips, with nested tokens in props
- HMAC tamper rejection
- persistent-bit rejection
- lazy failure for a missing script

**Integration:** port IlyaGulya's store/restart/read pairs as conformance
cases:
- `/service-stub-store`
- `/rpc-durable-class`
- the sync-record DO class case (`transactionSync` KV storing a class and its
  stubs)

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
- S5 passes (S2 already does).
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
  - **stateless exports:** a job **pinned to that exact isolate**.
    - v0.6.2 already has `runtime::drive(slot, …)` (`runtime.rs:2161`) and
      `Slot::affiliate` (`pool.rs:307`), so no new placement logic is needed.
    - **N5:** affiliate first, then check `Slot::is_live()`. Otherwise the call
      can enter a freed isolate.
    - **Retiring isolates must still accept calls.** The pool retires a
      session's isolate while its WebSocket session (and every browser
      subscriber it holds) is still live; patcon saw subscribers drop about
      30 s in (N12).
    - The call is refused only if the exporting context has ended.
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
| 3.0 | The envelope, the reserved-key refusal, random CapIds, a `CapRegistry` skeleton, and pinned stateless dispatch (N5). No behaviour change. | | 4-5 days |
| 3.1 | Calls, args and returns for RpcTargets, functions, callable Proxies, re-passed stubs and `new RpcStub(obj)`. Covers stateless↔own DO, DO↔DO, script↔script, **and facet and Dynamic Worker call args (N3, boundaries E and F)**. | J1 subscribers, J3 `overseer.open`/`newChat`, trial failure 6 | 2-3 weeks |
| 3.2 | Lifetime: release, dup (including N1's param duplication across isolates), implicit disposal, break notices, importer death, the eviction pin, and `Symbol.dispose` callbacks across isolates. | J1 unsubscribe, `notifyClosed`, trial failure 8 | 1.5-2 weeks |
| 3.3 | Pipelining: a call on an RpcPromise or RpcProperty whose root is remote waits for the root, then forwards, keeping e-order. Wildcard-get Proxies (`GatekeeperLoopback`, `overseer.ts:10815`). | J5, J6 env calls; `observer-tracker.ts:258` | 3-5 days |

In each milestone, remove the corresponding "cannot cross isolate boundaries
yet" refusal in `harness.js`.

**N3.** These must lift capabilities, and allow pipelined paths:
- facet calls: `__rpcOut(args, false)` at `harness.js:2200`, pipelining
  refused at `2197`
- loader calls: `harness.js:3302`, pipelining refused at `3298`

A celld facet stub (a Proxy over a plain object) must also lift as a
capability wherever it is passed or returned, not only through `ctx.restore`.

**Prior art.** Every fork solved part of this. **None can be merged**: see the
prior-art security warning.

| Milestone | Adopt / rework | Reference / reuse code |
| --- | --- | --- |
| 3.0 | — | Reference royalcala `713f1a5`: affiliate, then check liveness, and allow retiring slots. It patches `op_stub_rpc_call_heap`, which exists only in the forbidden routing, so it can't be adopted. Implement `Slot::is_live()` on `pool.rs` ourselves; today only `is_retiring` exists, at `pool.rs:409`. Lift `WorkerJob::StubRpc`/`begin_stub_rpc` and the reserved `__celld$` key refusal (`harness.js:4436` in the fork) from royalcala `674a9c4`. Use the dedicated `CellJob::StubRpc` shape of `64f8785`, **never** method-name multiplexing (`c6123d0`). |
| 3.1 | Adopt royalcala `280897e` (facet and loader args lift) once capabilities are sound | From cnicolov `fcb1977`: the transactional lift (roll back transfers, routes and stream locks on failure), revive-once for aliased markers, the disposer snapshot through cloning, and the `CallOrder` + egress-gate wiring. From royalcala `2bd84cd`: the `__facetStubs`/Proxy-RpcTarget resolution. |
| 3.2 | Adopt only the local `dup()` part of royalcala `874a2f2` | Reject its native `onRpcBroken` (D3). From IlyaGulya `779b7c9`: importer request-context adoption with implicit release, and a `/state` live-capability counter (expose this from `CapRegistry` as a metric). |
| 3.3 | | 1.12 already covers DO-stub RpcPromises. |

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

Plus `examples/rpc-caps/` as a runnable example. Seed it from cnicolov's
`examples/rpc-capabilities/` and `tests/rpc_capabilities.rs`.

The matrix also includes:
- facet and Dynamic Worker rows (N3)
- params duplicated across isolates (N1)
- a call into a retiring session isolate, and one into a freed isolate (N5)
- port IlyaGulya's `/transient`, `/do-return-rpc`, `/facet-capability-arg`
  and `/loader-do-only`

**Security cases:** each forgery shape from the prior-art warning must be
refused, without reproducing it as a working exploit:
- a reserved-key marker in user data
- a method name that looks like an internal op
- a stale id after the cell is re-activated
- a capability redeemed by an isolate other than its destination

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

**Prior art.** IlyaGulya `30f2a48` shows that a DurableObjectClass returned or
relayed from another script works as a facet class (its `returned` and
`relayed service DO class` cases). It uses `Generation::service_class_config`
and `op_service_class_loader` to run the class.

**Reference only:** it starts a standalone loader isolate per (script, class)
in every receiving isolate and caches it forever. That means a cold compile
per Overseer isolate, no pool accounting, and a conflict with v0.6.1's release
of unreferenced loaded Workers. D8 resolves to `FacetHost::Script` on the
script's cell pool instead.

**N7: bring the AI shim's `toMarkdown` forward to this phase.** Without
`WORKERS_AI`, the agent's `webFetch` of HTML crashes. That happens on the chat
path (J3 and J6), not only in web search.
- Wire up the `toMarkdown` half of 9.2 here, so manual chat testing isn't
  blocked.
- Don't copy patcon's app patch (`ead1d36`).

### Tests

**Unit:**
- `FacetHost::Script` resolution
- the `ROOT_FACETS` record and its release on Stop and on Swap
- slot `cells` accounting with a facet from another script

**Integration:** port IlyaGulya's `/returned-do-class`, `/relayed-do-class`
and `/facet-service-props-roundtrip`.

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

**Prior art.**
- **Skip royalcala `2bd84cd`'s restore.** Its `_cf_RESTORE` table design has
  four problems:
  - restored stubs can't be stored, because `__storedLift` has no case for
    them;
  - rows leak, because refcounts don't survive a restart;
  - handles alias after `deleteAll`, because they come from `MAX(handle)+1`;
  - facets and Dynamic Workers have no self-token.

  Our `rst` tokens follow workerd instead. Reuse its `__ctxInstance` plumbing
  and its synchronous stateless `[restore]`.
- **Reference IlyaGulya `c79ef09`.** Its recipes replay only in the current
  isolate, but its nested-recipe envelope for loaded workers
  (`__celld$loaderCall`) is a useful shape for 5.1's forger path.
- **Skip royalcala `c6a3e55` and `ef0d54d`** (patcon's async, live-only
  restore). `c6a3e55` references `__tracing` before it is defined.
- **Port IlyaGulya's restore cases with workerd expectations:**
  `/persistent-restore`, `/nested-restore-forger`, and the store/restart/read
  pairs for persistent, nested and switch.

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

**Prior art.**
- **Adopt royalcala `2f10749`** (patcon `d35faa8`, adapted to v0.6.2): it adds
  `TailReportState.rpc_method`, `WorkerJob::Rpc.tail_report` and
  `__deliverTails`.
  - It conflicts unless `280897e` is applied first. Resolve the conflict by
    hand instead; `280897e` belongs to Phase 3.
  - The RPC half of Phase 6 doesn't depend on Phase 3, so it can run any time
    after Phase 0. Only facet tails for gatekeeper facets wait for Phase 4. Then add facet fetch, RPC and alarm events, and the
  `streamingTails` refusal.
- **Reference IlyaGulya `f62bf29`.** It delivers tails before the call
  answers, which differs from workerd.

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

**Prior art.** royalcala `ef5e87c` carries streams as capabilities, one host
round trip per chunk. Use it as a correctness baseline and reference only; the
single-claim design above is the target, because packs reach 64 MiB.

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

**Prior art.** IlyaGulya `b22c115`, `779b7c9` and `2a4a1d6` are a reference.

| Adopt | Don't adopt |
| --- | --- |
| The identity triple: node, **process generation from the signed node lease** (use that as our incarnation, rather than inventing one), and id | HTTP-per-op transport (it breaks e-order) |
| Resolving the origin node's address through the signed lease | Sequential ids |
| `GONE` semantics for a restarted origin | Bumping `PROTOCOL_VERSION` |
| Implicit remote release when the importing request context drops | |

**Adopt IlyaGulya `6e6af49` at any time (N11).** It is an independent fleet
fix that applies cleanly: `RemoteRouteRetry::failed` sets `blocked` for
`NeverConnected` + redispatch. Also offer it upstream.

Gate this phase on the `tests/fleet/` scripts imported in 0.6:
- `ha-test.sh`: a returned RpcTarget called through another node while its
  owner is killed
- `fleet-test.sh`
- the soak, with a `/call` capability load, so leaked capabilities show up in
  the `/state` counter

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

## Production readiness

Beyond "it works", these must hold before the work is called done. Each
phase's gate includes the parts that apply to it.

- **Threat model.** Write `docs/security.md` sections, reviewed before
  Phase 3 code lands, covering:
  - capability identity and authority
  - who can mint, redeem, store and replay a capability
  - Dynamic Worker and code-mode isolation
  - the SSRF guard (1.9)
  - stored-token authentication (D7)
- **Fuzzing.** Add cargo-fuzz or property tests for every decoder that takes
  untrusted bytes: the capability envelope, stored tokens, the props and vars
  encodings, and the `rst` chains. A malformed input must be refused, never
  panic or alias.
- **Resource limits.** Every new table and queue has a documented, enforced
  bound, and a `/state` metric. That covers exports, imports, parked
  WebSocket handoffs, restore chains and tails.
- **Fresh-deployment correctness.** Every e2e and fleet gate runs against a
  fresh bucket. The [scope](#scope-fresh-deployments-only) rules out upgrade
  and compatibility paths, and new code must not add them.
- **Performance.** Before/after benchmarks for the request hot path (fetch
  bodies after 1.8, RPC calls after Phase 3) and the memory per isolate.
  Regressions are justified or fixed.
- **Observability.** New failure modes log with stable event names (as
  celld's `event=` logs do) and have metrics: capability breaks, refused
  forgeries, SSRF refusals, tails dropped.
- **Docs.** `docs/cloudflare-compat.md` lists every remaining difference from
  workerd. The trial workarounds are gone from the starter. Upstream-quality
  changelog entries are written per phase.
- **Review.** As set out in [Review and commits](#review-and-commits): an
  independent agent review of every item, Alex at every phase gate, and a
  dedicated security review of the Phase 3 threat model and code.

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
7. Every item in **Production readiness** holds.

When a phase lands, append its date and commit range to the phase heading and
update [cloudflare-os-trial.md](cloudflare-os-trial.md)'s "How far it got"
table.
