# Cloudflare OS on celld: implementation plan

This is the ordered plan for the celld changes that let Cloudflare OS run on
celld, and for how each change is verified. It is written for an engineer or
agent who has not seen the earlier work: read the **Orientation** section
first, then work the phases in order. To continue the work in progress, read
[Resuming this work](#resuming-this-work) next.

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
  - **W1**: drops every top-level key celld refuses (trial failure 1).
    Since 1.6 it drops only `ai`/`browser`, which stay refused (D9) and are
    mapped to the AI shim instead.
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

## Resuming this work

Written 2026-10-23, when the work was paused at 1.49. A fresh agent can pick
it up from here. Alex's standing instruction: **one subagent at a time** (to
spare usage limits), each started **fresh with a limited context, not
forked**; queue items in an acceptable order; implement, review, verify, then
commit and push to `main`; keep this plan current; stop only when truly
blocked, and otherwise decide from Alex's recorded decisions (workerd is the
reference, loud gaps, fresh deployments only, the production-quality bar).
The general method is the `orchestrate-subagents` skill
(`~/.claude/skills/orchestrate-subagents/SKILL.md`).

**Where to start.** The Progress table below: the row marked `next`,
then the `queued` rows in order. Each item's section has its design, and
an "As built" once done. Nothing is half-implemented in the tree.

**The loop for each item.**
1. One implementer subagent (`general-purpose`), with a self-contained prompt:
   the item number, which plan sections to read, scope, rules and the
   verification list below. It must not commit.
2. One fresh reviewer subagent, read-only, prompted with the item summary,
   priorities (security first), and "verify each finding; say explicitly
   when a severity has nothing".
3. Decide each finding from Alex's decisions, then send the decisions back to
   the implementer with SendMessage (it keeps its context). For HIGH
   findings, send the fixes back to the same reviewer for a focused re-review;
   repeat until no HIGH or MEDIUM remains.
4. Verify yourself (the list below), update the item's Progress row, commit
   (both repos when the starter changed) with the trailers in use, push, and
   watch CI with `gh run watch <id> --exit-status`. A red CI is fixed before
   the next item starts.
5. Every new difference or gap a round turns up becomes a plan item, or a
   line in an existing follow-up item, with an xfail case where workerd's
   behaviour is observable.

**Rules every subagent prompt must carry.**
- No subagents of its own. No git state changes at all: no commit, stash,
  checkout, reset, worktree, `git rm`, `git restore` or `git add`.
- Compare against HEAD with `git archive HEAD | tar -x -C <dir>` and its own
  `CARGO_TARGET_DIR`, both in the session scratchpad. The disk quota is
  tight, so delete big build dirs afterwards.
- Never edit the starter's `cloudflare-os/` submodule.
- Known differences go into the corpus as xfail, never left out.
- Tests for security fixes only check the refusal. Prompts for security work
  use neutral wording ("ownership tracking", "expects the refusal"): prompts
  that ask an agent to demonstrate an attack get stopped by the safety
  classifier.
- Make sure none of its background work is still running before it reports.

**Verification, and the baselines at 49693b3.**
- `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D
  warnings`; `cargo test --workspace`; `cargo build --profile lab -p celld`.
- `cd tests/conformance && CONFORMANCE_REQUIRE=docker node run.mjs
  --runtime=both`. Check the exit code itself: the last line is a summary
  such as `19 XFAIL, 143 PASS` (the order varies), and wrangler's log lines
  can come after a failure. Baseline: **143 PASS, 19 XFAIL**. `--filter
  <glob>` runs a subset; `--esbuild 0.28.0|0.28.2` checks bundling on the
  other supported versions.
- Starter e2e, from `~/projects/cloudflare-os-starter`:
  `CELLD=~/projects/celld/target/lab/celld E2E_PORT=8791
  E2E_AZURITE_PORT=10010 MOCK_LLM_PORT=11435 celld/e2e.sh all --fresh
  --quick`, then the same variables with `celld/e2e.sh down --fresh`.
  Baseline: S0, S1, S2, S9, S11, B0 and B6 pass; S3, S4, S6, S7, S10 and
  B1-B5 fail (Phase 2/3 reasons); S5, S8, S12 and S13 are skipped. The
  script exits 1 because of those expected failures. S11 must show no
  "dropped a frame" lines.
- Starter integration: `CELLD_INTEGRATION_JOBS=3 celld/integration.sh`
  (with the same `CELLD`). Baseline: exit 0, the adapter checks and
  `workshop-user-directory` pass, and 35 suites are pending with the first
  errors recorded in `celld/integration/status.json`. A changed first error
  is printed as a warning.
- CI (`.github/workflows/test.yml`) runs the conformance suite on a slower
  machine: memory-growth (`rss`) limits need about 1.5x headroom over local
  measurements (`websocket/send-budget` and `send-queue-overflow` were
  widened after CI measured more).

**Machine state to know about.**
- An old trial node (127.0.0.1:8790) and its Azurite container
  (`celld-azurite`, port 10000) are still running from the first trial.
  Tests use the alternate ports above; don't stop them without asking Alex.
- `celld/env.sh` defaults `CELLD` to the release build; tests use the lab
  build.

**Waiting on Alex.**
- The Phase 0 gate evidence (row 6) is recorded and awaits his review.
- Nightly CI failure reports need issues enabled on the fork
  (`gh repo edit axle-h/celld --enable-issues`).
- `celld_internal_tests` is an out-of-tree suite; 1.26's As built lists the
  internal signatures it changed.

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
| 11 | 1.5 `redirect: "manual"` on incoming requests | done | `1ca26cd` |
| 12 | 1.6 deploy configuration relaxations (W1-W3 removed) | done | see log |
| 13 | 1.7 WebSocket through a service binding; router mode default | done | see log |
| 14 | 1.21 part 1: host WebSocket owner map | done | `184054a` |
| 14b | 1.21 part 2: harness private state, target grants | done | `324563e` |
| 15 | 0.5 integration adapter | done | starter `fb97f16` |
| 16 | 1.8 BYOB readers on platform streams | done | `e8e6459` |
| 17 | 1.9 egress policy (part A), node-address always-block (part B) | done | `36b5b0f`, `5e33fe2` |
| 18 | 1.27 container ownership (security) | done | `f55c069` |
| 19 | 1.10 small built-in fixes | done | `c7295a0` |
| 20 | 1.11 method lookup on get-only Proxies | done | `a927af1` |
| 21 | 1.12 DO stub calls return an RpcPromise | done | `caa42f6` |
| 22 | 1.13 stubs passed as params are duplicated | done | `5b67c22` |
| 23 | 1.14 transactions on root storage; reset semantics | done | see log |
| 24 | fix the workerd-side flake in `streams/byob-request-body` | done | `ed11b98` |
| 25 | 1.15 `process.env` and `node:process` | done | `86c6418` |
| 26 | 1.31 isolate limits during module load (security) | done | `9b0c9c1` |
| 27 | 1.32 heap limit at request time (security) | done | `17b9c27` |
| 28 | 1.33 ArrayBuffer memory limits (security) | done | `cede9c5` |
| 28b | 1.35 Wasm and resizable growth within a turn (security) | done | `5ff3e96` |
| 29 | 1.16 compatibility-flag audit | done | `2fe3f0d`, starter `779b1e2` |
| 30 | 1.17 close replies on WebSockets; half-open sockets end on disconnect | done | `4d139d5` |
| 31 | 1.18 Worker Loader startup error text | done | `fc845db` |
| 32 | 1.19 trace context across RPC and the peer tunnel | done | `0477165` |
| 33 | 1.20 redirect handling through the same Fetcher | done | `1e23fdb`, starter `86b89b1` |
| 34 | 1.22 WebSocket follow-ups; bounded send queues and socket lifetimes (security) | done | `5a59ae1` |
| 35 | 1.23 `clone()` tees, 1.24 `alias` (package keys), 1.25 KV `preview_id` | done | `b9ee195`, starter `d5e7133` |
| 36 | 1.26 stream ownership on the host, readers and IdentityTransformStream | done | `e449d4d` |
| 37 | 1.45 esbuild service protocol; Wrangler `alias` exactly | done | `60f09d3`, starter `ec3cf7f` |
| 38 | 1.28 RPC method lookup on every receiver (security) | done | `8e1f06e` |
| 39 | 1.49 part A: Durable Object scope grants on the host (security) | done | `53e6198` |
| 39b | 1.50 TCP socket and HTMLRewriter ownership, socket cap, continuations (1.52) (security) | done | `fe784d8` |
| 39c | 1.49 part B: internals out of user reach, cell re-validation (security) | done | `1e8ac01` |
| 39d | 1.53 marker-shaped RPC data, with 1.29's forgeable-marker item (security) | done | `278cb9d` |
| 40 | 1.29 RPC serialisation follow-ups (leaks, Proxies, signals, flags) | done | `6b09eee` |
| 41 | 1.30 Durable Object reset follow-ups (hang, stale stubs, discarded writes, storage surface) | done | `a7272a7` |
| 42 | 1.34 Isolate limit follow-ups (per-request CPU limit, D1 query limit, stack frames, `bytes()`) | done | `e1a4bea` |
| 43 | 1.61 A stuck isolate must not starve the node (security) | done | `7d8df19` |
| 44 | 1.36 items 1–7 (error serialization, Node timers, Request `cache`, iterable bodies, stream backpressure, Blob MIME type, `Symbol.toStringTag`) | done | `0ac37a1` |
| 45 | 1.36 items 8–15 (accessors on prototypes, gzip Content-Encoding, Workflow ids, struct/queue/rejection/ALS/import/abort flags, request signal, old-date states, newest date 2026-10-01) | done | `33231d1` |
| 46 | 1.37 (importable `env`/`exports`, eval only during startup, module-scope I/O refused, Python startup window, `reportError`, `sendBeacon`, Performance classes and `node:perf_hooks`/`node:timers`, Queue JSON errors, HMAC/RSA/RSA-PSS checks, `getRpcMethodForTestOnly`) | done | `ad351f8` |
| 47 | 1.38 (builtin `node:` and `cloudflare:` modules only under the flags that provide them, side-effect imports and re-exports scanned, per-module flags honoured) | done | `167bd1a` |
| 48 | 1.39 (timers, random values, bodies, streams, `WebSocketPair`, `waitUntil` and the rest refused in global scope as workerd does; key generation and celld's own timers immune to replaced globals) | done | `c58b76a` |
| 49 | Durable Object stub RPC calls begin in the order they were made (the `storage/nested-root-transactions` flake; see 1.65) | done | `247e708` |
| 50+ | Phase 1 in plan order (1.40-1.44, 1.46-1.48, 1.51, 1.54, 1.55-1.60, 1.62, 1.63, 1.64, 1.65, 1.66, 1.67), and the 1.4 props key-order follow-up | queued | |

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
  the same ignore rules. Since 1.6, a rebuild that yields the same deployment
  version doesn't restart the node, which stops `build.command` output from
  looping.

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
- **`deploy`** (celld-only): `celld deploy --dry-run --json` without a
  node, recording the exit code, worker name and stderr. The runner also
  fails a case on any stdout line that isn't a ready record.
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
- **Steps that close the connection must end their case.** workerd closes
  the connection after a Worker cancels an unread request body. wrangler's
  proxy can then reuse the closed connection for the next request, which gets
  "Network connection lost". See the conformance README.
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
- `storage/inflight-event-{async,sync}-transaction`
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
- `crates/ltx` sets `test = false`; a public inline test there also needs
  that removed. `crates/logic` has inline tests since 1.32. The out-of-tree suites sit behind
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
3. **deploy**: `celld/deploy.sh [--no-router]`. Router mode is the default
   since 1.7; `e2e.sh --no-router` opts out.
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
     | S11 | scan `node.log` for "cannot cross isolate", "could not be cloned", "is not a function", "dropped a frame for a closed WebSocket", "does not support BYOB reads", "already disposed", "does not implement" | none | all |

     Notes from building the gate:
     - celld logs "dropped a frame for a closed WebSocket" (`ws_registry.rs:569`)
       on every clean client disconnect, in both modes. S11 counts it only when
       one of smoke's sockets closed with 1006. Revisit with 1.17.
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

**As built (starter `fb97f16`).**
- `celld/integration.sh` runs one multi-config `celld dev` per test file on
  free ports. Redeploy is a restart without `--clean`. `--workerd` runs
  upstream's harness as the reference.
- **Network.** The suites hardcode `api.cloudflare.com` and GitHub hosts. So
  instead of pointing the provider at the mock, a shim loaded before each
  Worker's code sends global `fetch()` to `mock-upstream.ts`, which restores
  `Location` and `content-length`. Unmatched requests get **500**, as under
  wrangler, because `observer-reverification` asserts it. The adapter
  bypasses celld's real outbound path (TLS, DNS, the 1.9 policy).
- **`status.json`** has `passing`, `pending` (each with its first error and
  plan mapping) and `excluded` (with reasons). The run fails on a
  regression, a flake, an unhandled error or a killed run, and warns when a
  pending suite's first error changes.
- An adapter self-test runs first. Its `it.fails` cases pin 1.20 and 1.23.
- **Today:** `workshop-user-directory` passes. All 35 pending suites fail on
  trial failures 6, 7 and 9, and pass on workerd. A run takes about 60 s with
  3 jobs.
- **Excluded:**
  - `github-hooks*` and `google-hooks-upgrade`: vendor fakes.
  - `external-message-*`: a DO `script_name` binding (see Phase 9).
  - `network-interceptor`, `mock-model` and `worker-inputs`: Node only.
- **To do:** add `celld/integration.sh` to the nightly CI job (0.6).

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
  outbound fetches and DO `fetch()` inside the span are its children. RPC
  calls across isolates join the trace too since 1.19.
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
- **Remaining difference:** `ctx.props` keys arrive sorted, because deploy
  parses them into a `serde_json` value. Follow-up: store props as text, as
  1.6 does for JSON vars, and add a `JSON.stringify` check to the props case
  (`isDeepStrictEqual` ignores key order).

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

**As built.**
- JSON vars are stored as compact JSON text, keeping the config's key order,
  capped at 5 KiB each (Cloudflare's documented limit). String vars are not
  capped. A dotenv override stays a string.
- `fallthrough` follows Wrangler's `parseRules`. celld's `.wasm` default
  rule comes after the configured rules.
- Accepted platform keys: `observability`, `workers_dev`, `preview_urls`,
  `account_id`, `upload_source_maps`, `placement`, `keep_vars`, `minify`,
  `dev`, each checked against Wrangler 4.147's schema.
- `build.command` runs with `sh -c` in `build.cwd` (resolved against the
  config's directory), with stdout sent to stderr and `WRANGLER_COMMAND`
  set. Under `celld dev` it runs in its own process group with a kill path.
- `celld dev` watches each config's directory plus `build.watch_dir`. A
  rebuild that yields the same deployment version doesn't restart the node,
  and drops only events whose file content is unchanged. A build that writes
  different content into a watched directory every run loops, as in
  `wrangler dev`.
- With `secrets` declared, `celld dev` filters dotenv entries as
  `wrangler dev` does, and reads process env. A missing secret fails
  (Wrangler warns).
- **Fixed on the way:** crons and the fence image were not part of the
  deployment version, so a crons-only deploy left nodes on the old
  schedule.

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

**As built.**
- Parked sockets are keyed by a 128-bit random token, not the socket id. The
  parked entry owns the socket (no `into_handoff`). `ws_target` is
  `Option<GenerationId>`.
- Only the request whose subrequest parked a socket can adopt it. The host
  chooses the caller-end id, and `accept()` binds only that id for that
  request. There are at most 64 held sockets per request.
- The target's event stays alive through its pending `__ws_next`; a
  stateless caller's stays alive through `waitUntil` after `accept()`.
- A DO may return a handed-over socket on the same node, as in workerd; across
  nodes it gets a 502. A DO returning a socket it already accepted logs
  workerd's text, and the client sees 1006, as on workerd.
- Retire closes parked sockets after a 5 s grace (two passes).
- A Response carrying a WebSocket can't cross RPC (workerd's DataCloneError).
  `HTMLRewriter` keeps the socket.
- Left for 1.17: the caller's close reply when the target closes first.
  Left for 1.22: bounding every socket's outbound frame channel.

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

**As built (replaces the design above).** workerd's platform streams are
*internal* streams, not spec byte streams:
- a BYOB read returns a `Uint8Array` whatever the view type;
- only one read can be pending;
- cancel rejects the read in flight;
- `releaseLock()` throws while a read is pending.

Native `type:"bytes"` streams would differ from workerd. So every platform
stream (host bodies, `Blob.stream()`, compression output, RPC-revived
readables, KV, the loopback response wrapper) is a `CelldChunkStream` with a
`_chunked` BYOB controller. Default reads keep the existing path. Also:
- `__celldStreamId` was forgeable, so a Worker could send another body the
  host held. It is now a private-field brand.
- Locked or disturbed bodies are refused with workerd's texts.
- Benchmark (256 MiB, lab): pipe 930 → 913 MiB/s (−1.8%), fetch 5588 → 5376
  MiB/s (−3.8%, noisy), BYOB fetch about 5330 MiB/s.
- E2E: S7 and B5 now get past the pack read and fail on "RPC stubs cannot
  cross isolate boundaries" (Phase 3).

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

**As built.**
- `crates/celld/public_egress.rs`:
  - Each Worker fetch runs in a task-local scope holding the hop's host and
    port. A custom resolver returns only addresses that pass, which also
    covers DNS rebinding.
  - IP literals are checked before the request and at every redirect hop.
  - Connections outside a scope are refused.
- The range table is IANA's non-global ranges. Mapped, NAT64
  (`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4 addresses are judged by their
  embedded IPv4. Teredo is refused.
- `new WebSocket()` and fetch upgrades use the same checks.
- Containers: `getTcpPort().fetch()` may reach exactly the running object's
  own container port, and only as a literal (1.27).
- `CELLD_FETCH_PRIVATE_ALLOW` is validated at startup. Public IPs and
  numeric-tail names are refused as entries.
- The node's **public** listener is not always blocked: a Worker on Cloudflare
  can fetch its own hostname, and it reaches nothing a Worker can't reach
  through `ctx.exports`.
- **Part B (separate commit):** the internal listener and advertise
  addresses are refused for `fetch()`, WebSockets **and** `connect()`, even
  when allowlisted. Wildcard binds are checked against `getifaddrs`, and the
  check fails closed. `connect()` is otherwise unrestricted.
- The runner gains placeholders (`${UPSTREAM_PORT}`, `${PUBLIC_PORT}`,
  `${INTERNAL_PORT}`) and an `upstream` server, clears an inherited
  `CELLD_FETCH_PRIVATE_ALLOW`, and `celld dev` gains `--internal-port`.
- Fixed on the way: a failed `new WebSocket()` dial now fires `close` (1006)
  after `error`.

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

**As built (done).**
- V8 already had the base64/hex methods, with workerd's messages; a case pins
  them.
- `scheduler.wait` honours the signal and rejects with the reason itself
  (workerd rebuilds a copy; documented). The default abort reason is now
  workerd's "The operation was aborted".
- `node:zlib` is a lazy module:
  - workerd's 172 constants and its export list. Unimplemented names
    (callback forms, `create*`, classes, `unzip`, `crc32`, Brotli, Zstd) are
    refusing stubs.
  - `level` and `maxOutputLength` are honoured (workerd's 40 KiB growth and
    "Memory limit exceeded"), with a 128 MiB default output cap and input
    under 128 MiB.
  - Options are validated in workerd's order with its messages.
  - `windowBits`/`memLevel`/`strategy`/`finishFlush`/`dictionary`/`info`
    throw "not implemented in celld".
- celld's own gzip header parser decodes every member, capped at 65,536 per
  call. Decode errors carry zlib's messages.
- Also fixed: truncated streams returned partial data, and gunzip read only
  the first member.
- **Follow-ups:**
  - `node:timers/promises` timers reject with the bare reason; workerd uses
    `AbortError({cause})` and validates options.
  - Corrupt deflate data gives "Zlib error" where workerd gives zlib's
    reason.
  - `CompressionStream("gzip")` writes OS byte 255.
  - A namespace import of `node:zlib` binds 34 constants that workerd puts
    only on the default export.
  - Model the `nodejs_zlib` flag in 1.16.
  - `streams/byob-request-body` occasionally gets "Network connection lost"
    from workerd (a harness flake to watch in nightly).

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

**As built (done).** workerd's `tryGetProperty` rule, applied by hand in
`__rpcClassMember`, used by `__stubResolve` and `__entrypointResolve`:
- reserved names are refused first; `scheduled` is no longer reserved,
  matching workerd;
- own properties are refused, which a Proxy's `getOwnPropertyDescriptor`
  answers;
- exactly one `[[Get]]`, never `in`, and `undefined` means "does not
  implement";
- `Object.prototype` names are refused before user code, because celld's
  stubs forward them where workerd's answer locally.

Neither fork variant matched workerd: patcon's ran `has` and `get`, and
royalcala's exposed own properties. Case `rpc/proxy-targets`.

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

**As built (done).**
- DO stub methods return an RpcPromise (patcon `333a2c7`).
- Dispose follows workerd's `JsRpcPromise::dispose`: one shared prototype
  method, and only RpcPromises are disposable. Awaiting after dispose still
  gives the result; a property read or call throws "RPC promise used after
  being disposed." This reworks IlyaGulya `4594b6c` where it differed.
- A pipelined walk through a foreign stub now throws instead of returning
  `undefined`.
- Cases: `rpc/do-promise-pipeline` (passes).
  `rpc/do-return-rpc-pipeline` is xfail until 3.1 (IlyaGulya's case needs a
  returned RpcTarget to cross isolates). `rpc/pipeline-receiver-rules` is
  xfail until 1.28.

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

**As built (done).**
- `Compat.rpc_params_dup_stubs`: from 2026-01-20 or the flag, off with
  `rpc_params_transfer_stubs`. It is reported in
  `Cloudflare.compatibilityFlags`.
- Only call params duplicate; returns still transfer. `dup()` on an
  RpcTarget, function or Proxy follows workerd's kind rule and
  DOMDataCloneError texts (including "RcpTarget").
- Refusals now happen in serialisation order, and a failed serialisation
  releases every ref it took.
- Received params dispose last-first and returns first-first, both as in
  workerd.
- A marker repeated in one value revives as one stub. Before, its target
  was disposed twice.
- Cases: `rpc/params-dup`, `-explicit`, `-transfer` and `-before`, with a
  shared `#params-dup` module. They cover RpcStub, `ctx.exports` and
  same-isolate DO calls.

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

**As built (done).**
- The owner scoping is gone. An in-flight event joins the innermost open
  layer.
- A nested transaction or nested `blockConcurrencyWhile` takes its slot
  synchronously but starts after the current turn, as workerd's critical
  sections do. That fixed an async transaction inside `transactionSync`
  corrupting the savepoint stack.
- An outer rollback while a nested transaction runs throws workerd's text,
  and both commit.
- An outer callback that ends while a nested one runs fails loudly: all is
  rolled back and the object resets. Only celld's error text differs from
  workerd's "internal error".
- A throwing outer rejects at once and rolls back when the nested one ends.
- Transaction views have no `transaction()`.
- **Resets now match workerd (pre-existing bugs fixed here):**
  - every storage op on a reset instance throws the reset error;
  - an open transaction is rolled back;
  - in-flight events reject promptly;
  - `ctx.abort()` no longer hangs other events, and uses workerd's text.

  Events track per-event deferreds. After a termination, the host wakes them
  under the CPU watchdog.
- **Overhead (5000 sequential calls, median, against HEAD):** RPC +1.0%,
  stub fetch −2.2%. RSS stays flat over 400k RPCs.
- Cases: `storage/inflight-event-join`, `nested-transaction-start`,
  `nested-transaction-running`, `reset-in-flight`. The in-flight cases use a
  "started" handshake rather than `Promise.all` order.

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
  workerd puts a JSON binding's text into `process.env`
  (`workerd-api.c++`, `createBindingValue`), so `process.env.ADMINS` should
  be the JSON string.
- Map `node:process` to the global.

**As built (done).**
- The env is populated only when Node compatibility is on (`nodejs_compat`
  or `_v2`) and `populateProcessEnv` is, by flag or implied by
  `nodejs_compat` after 2025-04-01. `nodejs_compat` and `_v2` are on by
  default from 2026-08-04.
- Strings are copied as they are, and JSON-serialisable values
  re-stringified, so `1.0` becomes `"1"`. A port of workerd's `process.env`
  Proxy enforces its rules.
- A Dynamic Worker's `process.env` comes only from its own `env`, which is now
  installed before module evaluation.
- `process` and `node:process` are the global. `getBuiltinModule` returns the
  global too, where workerd returns a separate object with the same fields
  (documented).
- Also fixed: `build_env` used Rust `{:?}` for binding names and text vars,
  so NUL followed by a digit became a legacy octal escape. It now uses
  `js_string_literal`.
- Cases: `node/process-env` (a 9-Worker date and flag matrix) and
  `node/process-module`.

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
- Already classified: `nodejs_compat_populate_process_env` (and its disable
  flag) are honoured and reported (1.15). `nodejs_compat`, `nodejs_compat_v2`
  and `no_nodejs_compat` are partly modelled: they gate only `process.env`.
  Classify them, and decide whether to report `nodejs_compat`.
- Already classified: `rpc_params_dup_stubs` / `rpc_params_transfer_stubs`
  are honoured (1.13). `global_fetch_strictly_public` is no-op by design
  (1.9). `nodejs_als` is honoured and reported in
  `Cloudflare.compatibilityFlags` (`flags/nodejs-als`).
- Known gap (found by 1.4, now reachable since 1.11 un-reserved `scheduled`):
  celld always exposes Fetcher `scheduled()`.
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

**As built (done).**
- One table, `crates/celld/compat_flags.rs`, classifies all 336 flag names of
  the vendored `compat_flags/compatibility-date.capnp` (v1.20261001.1):
  43 honoured (plus celld's `sqlite_vec`), 164 no-op, 129 refused (35 of them
  experimental). It computes workerd's values, including implied-by chains.
  Unit tests fail on any new or changed upstream flag, on a `WORKERD_VERSION`
  that differs from the conformance lockfile, and on a docs section whose
  flag set differs from the table (each docs list is exact).
- Deploy and the Worker Loader refuse unknown, duplicate and contradictory
  flags, refused flags, malformed dates (exactly `YYYY-MM-DD`), and dates after
  2026-09-04 or in the future, with workerd's texts. Deploy also refuses a
  missing `compatibility_date`, as wrangler does. Deploy reports every error;
  the Loader rejects with the first, refuses every experimental flag (as
  workerd's Loader does), and converts the date and flags as JSG does.
- **Decision:** experimental flags are refused unless honoured; at deploy
  `js_rpc` and `service_binding_extra_handlers` are honoured. The latter is
  partial: `queue()` throws, and `scheduled()` works only on a binding to the
  Worker's own default export (documented). Without it, Fetcher
  `queue`/`scheduled` are RPC methods, as in workerd.
- Newly honoured: `disallow_importable_env`, the Fetcher get/put/delete
  helpers (now on service bindings too), the real `queues_json_messages`
  names, the `websocket_standard_binary_type` date.
- `Cloudflare.compatibilityFlags` lists honoured flags, plus always-on flags
  where workerd also computes them on, as a sealed null-prototype object.
- **Decision:** behaviour a date selects but celld lacks is documented under
  "Differences selected by compatibility date", not refused; refusing it would
  refuse every date. Those flags become 1.36.
- Starter: the integration adapter drops the `gatekeeper-test` fixture's
  `experimental` flag, with a note (the fixture uses none of its APIs).
- Cases: `deploy/compat-flags`, `loader/compat-flags`,
  `loader/compat-flags-refused`, and `flags/*` for each honoured flag
  (9 failed before, 4 pin existing behaviour). The runner sends a step with a
  `sec-fetch-` header through node:http, since fetch() overrides it.

### 1.36 Behaviour selected by the Cloudflare OS date that celld lacks (found by 1.16)

Each is on by date at 2026-09-04, so every Cloudflare OS Worker differs
silently today (listed in the docs). Implement each as honoured, with a
differential case:
1. Errors keep their own properties, across RPC too
   (`enhanced_error_serialization`).
2. Node.js Timeout objects from the global timers
   (`enable_nodejs_global_timers`).
3. The Request `cache` option, `no-store` and `no-cache`
   (`cache_option_enabled`, `cache_no_cache`).
4. Iterable bodies (`fetch_iterable_type_support` and its override
   adjustment).
5. Stream backpressure (`encoder_stream_spec_compliant_backpressure`, and the
   TransformStream backpressure behind `fixup-transform-stream-backpressure`).
6. Blob MIME normalisation (`blob_standard_mime_type`).
7. `Symbol.toStringTag` on every API class (`set_tostring_tag`).
8. Accessors on prototypes (`workers_api_getters_setters_on_prototype`).
9. Content-Encoding gzip and br, including `brotli_content_encoding`.
10. Workflow instance ids from `newUniqueId`
    (`workflows_enable_fast_engine_creation`).
11. Verify and model `enable_fast_jsg_struct`, `queue_expose_error_codes`,
    `unhandled_rejection_after_microtask_checkpoint`,
    `bind_asynclocalstorage_snapshot_to_request`,
    `handle_cross_request_promise_resolution`,
    `throw_on_unrecognized_import_assertion` and
    `internal_writable_stream_abort_clears_queue`.
12. WebSocket permessage-deflate (`web_socket_compression`).
13. `enable_request_signal` (always on in celld; off by default in workerd).
14. Optional: the old-date states of recent always-on flags
    (`strip_bom_in_read_all_text`, `text_decoder_replace_surrogates`,
    `websocket_close_reason_byte_limit`,
    `writable_stream_spec_compliant_writer`).
15. Raise `NEWEST_DATE` once the three flags dated after 2026-09-04 are
    modelled.

**As built (items 1–7).** Each flag below is honoured, with its date and
its disable name, read from `compat_flags` and reported in
`Cloudflare.compatibilityFlags`. Probed on workerd 1.20261001.1 and read in
its source at that tag.
1. **`enhanced_error_serialization`** (jsg/ser.c++ `WriteHostObject` and
   `ReadHostObject`, jsg/util.c++ `decodeTunneledException`, jsg/value.h).
   Every serializer of the isolate (`structuredClone()`, storage, queue
   bodies, `__sc_encode`) writes a native Error other than a DOMException
   as workerd's host object, in its byte layout: tag 10, workerd's
   `ErrorTag`, the name when the tag does not give it, the message, then an
   object of its other own string-keyed properties, each read once and set
   as on any object (`storage_ops::write_native_error`, gated by a per-isolate
   slot set from the flag). The reader always takes it: a message that is
   not a string is workerd's DataCloneError, an unknown name is defined, the
   rest are defined as data, and `stack` is kept except over RPC
   (`__sc_decode(bytes, false)`). Over RPC an Error crosses as a
   `__celld$err` marker that the lift builds from the same record
   (`__errorRecord`, read in the projection, so a getter runs once), with
   its properties lifted and escaped as any plain data (plan 1.53): a
   function among them crosses as a stub, `__proto__` on the copy makes it
   refused as workerd refuses it, and the reviver
   (`__reviveError`) checks the tag, the message and the properties' object
   and defines each property as data; an Error that its own properties
   refer to is refused with V8's "Unable to deserialize cloned data.", as
   workerd's deserializer refuses it, and params a callee cannot read fail
   the call as an exception it threw (`remote`). An Error inside a Map or Set, which
   the lift does not walk, goes to the Rust writer. A thrown value now
   crosses as workerd tunnels it: the sender sends its description (V8's
   side-effect-free detail string, typed as workerd types it, or a
   DOMException's private name and message: `__tunneled_error`; one whose
   description starts `DOMException(<name>)` arrives as that DOMException,
   as in workerd) and its
   serialization under the sender's own flag; a receiver with the flag
   takes that serialization when it gives an object, otherwise an Error of
   the description's type and message with its own stack, and marks it
   `remote`. A Durable Object reset's error crosses the same way, within
   the envelope bound. Before, celld kept a thrown Error's own enumerable
   properties whatever the flag, and dropped them from a returned one.
   Case `flags/enhanced-error-serialization` (structuredClone, a returned
   value, a thrown one, a Durable Object, storage, and another script's
   enhanced and legacy callee, under four dates and flags) and
   `rpc/marker-shaped-error-props` (an Error's marker-shaped properties as
   params, result, thrown value and clone). `lib/worker/marker-shaped.js`
   adds `__celld$err` to the keys every marker-shaped case sends as data.
2. **`enable_nodejs_global_timers`** (worker.c++ loads
   node-internal:internal_timers_global_override, src/node/internal/
   internal_timers.ts). With it the global `setTimeout()` and
   `setInterval()` return workerd's `Timeout` (private state, `refresh`,
   `ref`, `unref`, `hasRef`, `close`, `Symbol.dispose`,
   `Symbol.toPrimitive`), and `clearTimeout()` and `clearInterval()` take a
   Timeout or an id, with Node's ERR_INVALID_ARG_TYPE for a callback that is
   not a function, its "Received" part as Node's `inspect` with depth -1
   gives it (`__installNodeGlobalTimers`, run before the modules
   evaluate). The flag alone turns it on, as in workerd. The base timers now
   have workerd's names, length 0 and its TypeError for a callback that is
   not a function. Case `flags/nodejs-global-timers`.
3. **`cache_option_enabled`, `cache_no_cache_enabled`** (http.c++
   `RequestInitializerDict::validate`, `Request::serializeCfBlobJson`,
   `fetchImplNoOutputLock`). A Request takes `"no-store"`, and `"no-cache"`
   with the second flag, with workerd's errors for any other mode (and for
   `reload`, whose flag is experimental), keeps the mode in a private field
   that `new Request(request)`, a Request given as the init, `clone()` and
   RPC (`k` in the Request marker, which the receiver's own flags then take
   or refuse) carry, and reports it from an unnamed `Request.prototype.cache`
   getter that exists only with the flag. `__fetchThrough` gives each
   subrequest workerd's `cf`, copied as JSON as workerd copies it (so a key
   that is undefined is not there), with the mode's cache properties and
   `cacheControl` made from the mode or from `cacheTtl`, which was missing
   without a mode too), then `Cache-Control` and `Pragma` `no-cache` unless
   set; the copy a same-isolate target receives has no mode. The two
   `cf.cacheControl` exclusions are checked as the init is. Case
   `flags/request-cache-option` (seven dates and flags; a same-isolate
   target, since `cf` does not reach another isolate, 1.41).
4. **`fetch_iterable_type_support`** and its override adjustment (jsg/
   iterator.h `AsyncGeneratorIgnoringStrings`, http.c++ `Body::extractBody`,
   `JsReadableStream::from`). Without the flag every such body is
   stringified; with it an object other than a boxed string with an async
   or else a sync iterator, its iterator taken at once, is read as a stream
   of its values, a promised value awaited, and with the adjustment a sync
   iterable other than an Array with its own `toString` or
   `Symbol.toPrimitive` is stringified. Before, celld concatenated an
   Array of views eagerly and stringified one with other values. A body
   read whole now takes a stream's chunks as workerd does: an ArrayBuffer or
   any view as its bytes (a Uint16Array was converted element-wise and an
   ArrayBuffer read as nothing), anything else as "This ReadableStream did
   not return bytes.". Case `flags/fetch-iterable-type-support`.
5. **Stream backpressure** (streams/standard.c++
   `TransformStreamDefaultController::enqueue`, streams/encoding.c++).
   Without `fixup-transform-stream-backpressure` an enqueue no longer sets
   a TransformStream's backpressure; without
   `encoder_stream_spec_compliant_backpressure` the readable side of a
   TextEncoderStream or TextDecoderStream has a high water mark of 1. Case
   `flags/stream-backpressure` (identity, two enqueues per write, encoder,
   decoder, five dates and flags).
6. **`blob_standard_mime_type`** (http.c++ `Body::blob`, util/
   mimetype.c++). A body's `blob()` has the Content-Type extracted and
   serialized as workerd's `MimeType` does it, its quirks kept (a backslash
   is a token character, every character from 0x80 is a quoted-string one,
   `boundary` after a space), or the header as it is without the flag;
   before, celld
   lower-cased it either way. Case `flags/blob-standard-mime-type` (30
   header values on Request and Response, two Content-Type headers).
7. **`set_tostring_tag`** (jsg/resource.h). Every API class celld defines,
   and the `crypto` object, gets its workerd name as a writable,
   configurable, non-enumerable `Symbol.toStringTag` through `__apiTag` (on a
   prototype of its own for `crypto`, as celld has no Crypto global)
   (api_tags.js, the first prelude script); without the flag the tags given
   before the flags are known are deleted and a lazy global gets none.
   Before, some classes had none, some an accessor and some a read-only
   one. Case `flags/set-tostring-tag` (51 prototypes and 30 instances under
   four dates and flags).
- The Request constructor reads a script's init as workerd's
  RequestInitializerDict does: each field in its struct order (`method`,
  `headers`, `body`, `redirect`, `fetcher`, `cf`, `cache`, `integrity`,
  `signal`, `encodeResponseBody`), converted before the next is read (the
  headers into a Headers, the body as workerd converts it), then validated
  (the cache mode, the `cf` exclusions, `encodeResponseBody` and an
  `integrity` that is not empty, with workerd's errors); pinned by a traced
  Proxy init in `fetch/redirect-mode`. celld's own inits are objects only
  it makes, known by identity (a WeakSet, so no property of a script's
  init is read to tell): they carry what an arrived request, the copy a
  same-isolate target receives and a revived one need (a one-time body, the
  client's signal, no cache mode, raw headers built lazily), and the
  one-time body and the subrequest signal are private fields. Every
  construction on celld's own paths uses the Request, Response and Headers
  classes captured before any script runs, and tests by brand, so a Worker
  that replaces those globals sees none of them
  (`fetch/request-global-replaced`).
  celld's own inits, the inits of the Responses it makes, its stream
  sources and strategies, the records `__readResponse` hands the host and
  the host's JSON replies on the request paths have no prototype, and the
  attributes of a Request, a Response and an AbortController are class
  fields (a Request's and a Response's `cf` is undefined when it has none,
  as workerd's is), so a getter or setter a script puts on
  Object.prototype is never run by these paths and cannot stand in for a
  field they leave out (`fetch/object-prototype-getters`: an incoming
  request, a service binding's fetch to the Worker's own entrypoint and to
  another script, an RPC call carrying a Request and a subrequest, with
  getters under 25 such names). Before, a getter named `signal` made every
  incoming request fail, and one named `headersList` or `cache` changed
  what celld's own Requests held.
- A fetch handler's result that is not a Response (a Proxy of one, an
  object with its prototype, a string, undefined, a Promise of either) is
  refused with workerd's TypeErrors: "Incorrect type for Promise: the
  Promise did not resolve to 'Response'.", and, for a class entrypoint's
  `fetch()` that returns neither a Promise nor a Response, "Callback
  returned incorrect type; expected 'Promise'". Before, celld answered 200
  with the value as text (`fetch/handler-non-response`).
  After these changes (lab, `ab -n 20000 -c 16`, medians of 5 interleaved
  rounds against 4010757): hello-world fetch 18728 → 18520 req/s (−1.1%),
  Durable Object RPC 16873 → 16837 (−0.2%).
- Found, as plan item 1.63 with xfail cases where workerd shows the
  behaviour: `flags/set-tostring-tag-instances`, `streams/pull-after-queued-read`,
  `rpc/error-shapes`.
- Updated: `flags/compatibility-flags` reports the ten flags;
  `deploy/compat-flags` and `loader/compat-flags-refused` refuse
  `webcrypto_modern_algorithms` in place of `enhanced_error_serialization`.
- Cost (lab, `ab -n 20000 -c 16`, medians of 11 interleaved rounds against
  4010757, every flag on): hello-world fetch 18710 → 18685 req/s (−0.1%),
  Durable Object RPC 17150 → 16975 (−1.0%), a service binding's fetch to the
  Worker's own entrypoint 18464 → 18333 (−0.7%), RPC to it 18145 → 18131
  (−0.1%).

**As built (items 8–15).** Probed on workerd 1.20261001.1 and read in its
source at that tag. Each honoured flag is read from `compat_flags`, with its
date and disable name, and reported in `Cloudflare.compatibilityFlags`.
8. **`workers_api_getters_setters_on_prototype`** (jsg/resource.h
   `registerReadonlyPrototypeProperty` and `registerReadonlyInstanceProperty`
   under `jsgPropertyOnPrototypeTemplate`). A Request's and a Response's
   state is in private fields of the classes, and their body in those of
   `Body` (`#bytes`, `#stream`, `#read`, `#text`), now a global as in
   workerd (a function that throws "Illegal constructor" called with or
   without `new`; its prototype holds `body`, `bodyUsed` and the read
   methods). Body, Request, Response and ReadableStream extend nothing, as
   in workerd at either date (`Object.getPrototypeOf` of each is
   Function.prototype). Each is a function rather than a class, so a call
   without `new` throws workerd's "Failed to construct '<name>': Please use
   the 'new' operator, this object constructor cannot be called as a
   function." (`__celld.__calledWithoutNew`), with a class's members and a
   read-only `prototype` (`__celld.__installMembers`). Each constructor
   makes its object itself (`__bodyInstance`, streams.js `streamInstance`,
   with `newTarget`'s prototype read once, or Object.prototype when that
   is not an object, as in workerd) and puts its private
   state on it through a state class no script can reach (`__BodyFields`,
   `__RequestFields`, `__ResponseFields`, `ReadableStreamFields`), whose
   base returns the object it is given (`__Stamp`). So giving one of the
   constructors another prototype changes no construction, celld's own
   included (`builtins/constructor-reparent`: both dates, the request a
   handler receives, a service binding's fetch and its response); every
   celld path reads them through accessor functions the class bodies hand
   out (`__requestUrl`, `__responseStatus`, `__bodyStream` and the like), so
   nothing a script defines on an instance or a subclass changes what
   crosses or is sent. Each attribute is an accessor of the prototype with
   no getter name, enumerable, as in workerd, for Request, Response, Body,
   Event and its subclasses, AbortSignal, AbortController, WebSocket, Blob,
   File, the streams, their readers and writers, TransformStream,
   TextEncoder, TextDecoder, DigestStream and `crypto` (a `Crypto`
   prototype with `subtle`). Without the flag, `__applyCompat` deletes those
   accessors and each instance gets its attributes as own data properties,
   read-only unless the attribute has a setter (`cancelBubble`), in the
   reverse of workerd's declaration order, as native data properties that
   read the live private state, so an attribute that changes (`bodyUsed`,
   `readyState`, `aborted`) still reads true. A Request, a Response and a
   ReadableStream, which every request makes, are made from an attribute
   class (`op_attribute_class`: a FunctionTemplate whose instance template
   holds the table's properties, made once per table): the object their
   constructor makes is an instance of it given the class's prototype, so
   every instance shares the accessors and the shape and the state goes on
   it. Each other class adds the properties to its instance after
   construction (`op_instance_accessors`), which costs about 1 µs an
   attribute. MessageEvent, CloseEvent and
   PromiseRejectionEvent have their own read-only properties either way, as
   workerd's do, defined before Event's. `structuredClone()` of a Request or a Response, which now
   has no own property for V8 to write, goes through the RPC marker lift
   and revival, as in workerd it serializes; every serializer of the
   isolate refuses a real Request, Response or AbortSignal (by a brand check
   and a refusal the harness registers, `storage_ops::HostClasses`: the
   walk up an object's prototype chain stops at Object.prototype or
   Array.prototype, and only one that reaches a host prototype calls the
   brand check), so storage lifts it into its marker as before; an object
   that only claims one of their prototypes is written as plain data, as
   workerd writes it, by `structuredClone()` too
   (`builtins/structured-clone-unbranded`). Every reviver reads a marker's
   own fields only (`__ownRecord`), so a getter a script put on
   Object.prototype under a marker field's name (`k`, `x`, `m`) changes
   nothing a Request or a Response revives as (`rpc/marker-fields-inherited`).
   Prototypes list `constructor` after their members, as workerd's do
   (api_tags.js), and WebSocket and its prototype carry workerd's
   `READY_STATE_*` and `CONNECTING`..`CLOSED` constants in its order, read-only
   and configurable, as Event's now are. An EventTarget method on another
   receiver throws workerd's "Illegal invocation" text, as every celld
   class's does now (`__celld.__illegalInvocation`). The 1.63
   entry "Request and Response attributes are own data properties" is
   closed; `rpc/marker-shaped-host-attributes` (xfail 1.36) now passes.
   Cases `flags/getters-setters-on-prototype` (Request, Response, events,
   AbortSignal, AbortController, WebSocket; four dates and flags) and
   `flags/getters-setters-on-prototype-streams`; found, with xfail cases:
   `builtins/readonly-attribute-assignment`, `builtins/internal-own-keys`.
9. **Content-Encoding** (api/system-streams.c++ `getContentEncoding`,
   http.c++ `makeHttpResponse` and `Response::send`). gzip is handled
   whatever the date: a body that arrives with exactly
   `Content-Encoding: gzip` (a `fetch()`, a service binding's, a Durable
   Object's or a cross-isolate cell's response) is decoded as it is read
   (`CelldGzipBodyStream`) unless the request has
   `encodeResponseBody: "manual"`: every gzip member of it, as kj's
   GzipInputStream decodes it, with its messages ("Gzip decompression
   failed.", "Gzip compressed stream ended prematurely."); a response sent
   with it is compressed
   (`__gzipBody`) unless it has `encodeBody: "manual"`, and a gzip body
   that arrived so and that nothing read goes out as it came. A copy, a
   clone and a Request used as the init keep the mode; a same-isolate
   service binding encodes or decodes only where the two sides' modes
   differ, as if the response crossed HTTP. Every coder, these and
   CompressionStream and DecompressionStream, is a native zlib stream
   (zlib.rs `ZlibStream`) that queues its input and codes it in bounded
   steps: up to 1 MiB of output as input is written, so bad input fails
   the write that brought it, as in workerd, then 64 KiB a read, taking
   more input only once its output is read. A decoder inflates with
   flate2's `Decompress` into a fixed 64 KiB buffer and reads gzip's
   framing itself (miniz, flate2's backend, inflates zlib and raw deflate
   only), so it takes its input whole. The header is a stream: its fixed
   ten bytes, then, as its flags say, FEXTRA's length and data, FNAME and
   FCOMMENT up to their NUL and FHCRC, each taken a whole slice at a time
   and never held, whatever its length (a 1 MiB FNAME decodes at once, on
   both runtimes, in `fetch/content-encoding`; an 8 MiB one in a unit
   test). FHCRC is checked against the CRC32 of the header's bytes, as
   zlib checks it: a wrong one fails a body with "Gzip decompression
   failed." and a DecompressionStream with "Decompression failed."
   (`fetch/content-encoding`, `streams/decompression-errors`).
   Throughput: plain text decodes at about 800 MB/s and zeros at 2.3 GB/s
   through a DecompressionStream, against
   520 MB/s and 910 MB/s at 62ffd57. Bytes after a body's last member
   that are not another member fail it with "Gzip decompression failed.",
   as kj's do. Before, a write inflated a
   whole chunk at once: a 256 KiB body of 256 MiB of zeros took that much
   memory, as a single large DecompressionStream write did already at HEAD
   (`fetch/gzip-bomb`, celld-only: 1 GiB of zeros in 1 MiB, read in full
   from a Durable Object's body and from one DecompressionStream write,
   while the node's peak memory grows by under 256 MiB, a quarter of what
   is decoded, from a baseline taken in the same process; the runner
   prints the growth when it is over). DecompressionStream now reports
   workerd's "Trailing bytes after end of compressed data" and "Called
   close() on a decompression stream with incomplete data"
   (`streams/decompression-errors`). The response to a HEAD request
   or with a null body status now has a null body, as `makeHttpResponse`
   gives it (it had an empty stream). `br` under `brotli_content_encoding`
   (on from 2024-04-29) is not supported: the flag is `Support::Off`, so
   `no_brotli_content_encoding` is accepted and the date's state is a
   listed difference; a br body passes as it is, as without the flag.
   celld carries no brotli implementation, and adding the `brotli` crate
   needs the review the quality bar asks for (plan 1.64). Cases
   `fetch/content-encoding` (a request body, sent responses in each mode, a
   service binding's and the Worker's own responses), `fetch/content-encoding-direct`
   (a global `fetch()`, recorded from workerd run directly, as the
   harness's Node outbound decodes it), `fetch/received-null-body`,
   `fetch/content-encoding-br-off`; xfail `fetch/content-encoding-br`,
   `fetch/passthrough-length`, `fetch/null-body-status-construct`. The
   conformance upstream gained `/encoded`.
10. **`workflows_enable_fast_engine_creation`** (on from 2026-08-11; only
    compatibility-date.capnp has it, as Cloudflare's engine is not in
    workerd). A Workflow instance that `create()` or `createBatch()` makes
    without an id is named by the Workflow's Durable Object namespace's
    `newUniqueId()`, 64 hex digits, with the flag, and by a random UUID
    without it, which Miniflare uses either way (`__wfNewInstanceId`). Case
    `flags/workflows-fast-engine-creation` (celld-only: Miniflare names
    every instance by UUID).
11. Each modelled, gated as workerd gates it:
    - **`enable_fast_jsg_struct`** (jsg/struct.h). The objects workerd
      builds from its structs are built by `__celld.__struct`,
      `__iterResult` and `__readResult` (api_tags.js), which keep workerd's
      member order and, with the flag, an absent optional member as
      undefined: stream reads, every iterator step (Headers,
      URLSearchParams, FormData, WebSocketPair, ReadableStream, SQL cursor,
      `kv.list()`, HTMLRewriter attributes, MIMEParams), URLPattern's
      `inputs`, `socket.opened`, queue metrics, R2's `httpMetadata`,
      `range`, `checksums.toJSON()` and `list()`, JWK export and
      `asymmetricKeyDetails`. The async iterators became classes
      (`ReadableStreamAsyncIterator`, a WebSocketPair `PairIterator`), as
      an async generator's step cannot be shaped. Case
      `flags/fast-jsg-struct`.
    - **`queue_expose_error_codes`** (api/queue.c++). The queue binding's
      send and sendBatch were rewritten as workerd's: its own TypeErrors
      for a bad body, content type or batch, then the service's refusal,
      which with the flag is an Error with Cloudflare's documented cause
      and code ("Message size out of bounds (10204)", 10205, 10206) and
      without it "Queue send failed: " or "Queue sendBatch failed: " and
      Miniflare's text. Cases `flags/queue-expose-error-codes`,
      `flags/queue-error-codes` (celld-only: Miniflare's service sends no
      code); found: `queues/send-metrics` (xfail).
    - **`unhandled_rejection_after_microtask_checkpoint`**
      (api/global-scope.c++, jsg/promise.c++). celld now has workerd's
      `unhandledrejection` and `rejectionhandled` events and
      `PromiseRejectionEvent`: V8's promise reject callback
      (`set_promise_reject_callback`) records rejections, and they are
      looked at after each microtask checkpoint with the flag, or from the
      next microtask without it, while the global scope has a listener;
      every checkpoint site goes through one `microtask_checkpoint` helper.
      Case `flags/unhandled-rejection-checkpoint`. The bookkeeping inside
      V8's callback, and the dispatch of the events, use captured
      functions, null-prototype records and index loops only, so nothing
      a script replaced on Map.prototype, Array.prototype or
      Object.prototype runs there; the listener count comes from
      EventTarget's private lists, which every dispatch now works on the
      same way. As in workerd (`ServiceWorkerGlobalScope::
      emitPromiseRejection`), a rejection is recorded only while a listener
      exists, so one added after it does not hear it
      (`builtins/unhandled-rejection-hooks` pins both against workerd). The
      global timers use captured functions too, and run a callback with the
      global scope as `this`, as workerd does under either timers flag (it
      was `undefined` at 62ffd57; `flags/nodejs-global-timers`).
    - **`bind_asynclocalstorage_snapshot_to_request`**
      (api/node/async-hooks.c++). A function from
      `AsyncLocalStorage.bind()` or `snapshot()`, and an `AsyncResource`,
      made in a request throws workerd's error when called in another with
      the flag; one made at module scope runs anywhere, and one made in a
      Durable Object runs in each of its requests, which share one
      IoContext in workerd (`__asyncContextOwner`: the object's state).
      Case `flags/async-local-storage-snapshot`.
    - **`handle_cross_request_promise_resolution`** (io/worker.c++, with
      workerd's V8 patches that tag promises with their context). celld's
      V8 lacks the patches, so the flag is `Support::Off`: a promise's
      continuations run in the request that resolves it. Case
      `flags/cross-request-promise-resolution` (xfail 1.64).
    - **`throw_on_unrecognized_import_assertion`** (jsg/modules.c++). An
      import with attributes, static or dynamic, fails with "Unrecognized
      import attributes specified" with the flag (`ImportAttributes` slot in
      `js/modules.rs`); without it they are ignored. `celld deploy` bundles
      with `--supported:import-attributes=false`, as Wrangler's esbuild
      drops them, so a deployed bundle keeps none; a Dynamic Worker's
      modules keep theirs. Case `flags/import-attributes`.
    - **`internal_writable_stream_abort_clears_queue`**
      (api/streams/internal.c++). `abort()` on an IdentityTransformStream's
      or FixedLengthStream's writable side rejects the queued writes and
      errors the stream at once with the flag; without it, with a write in
      flight, it waits until that write is read. A read of the readable
      side then fails with "Network connection lost." whatever the reason,
      as workerd's does. Cases `flags/internal-writable-stream-abort`,
      `streams/internal-abort-read-error`.
    - Found while modelling them: **`spec_compliant_dispatch_exceptions`**
      (api/basics.c++ `EventTarget::dispatchEventImpl`, on from 2026-09-15).
      EventTarget keeps its listeners in a private field and dispatches
      through one `__dispatchEvent(target, event, policy)`: with the flag a
      listener's exception is reported (an ErrorEvent on the global scope,
      then the console) and the remaining listeners run; without it the
      first exception ends the dispatch and propagates. An AbortSignal's
      abort, a WebSocket's, an EventSource's and a MessagePort's events
      follow it; a MessagePort fires `messageerror` with the flag. Case
      `flags/spec-compliant-dispatch-exceptions`; found:
      `websocket/listener-exception` (xfail).
    - **`durable_object_io_tasks_prevent_eviction`** (on from 2026-10-01;
      only compatibility-date.capnp has it). celld evicts an idle object
      with waitUntil() work pending, so the flag is `Support::Off`. Case
      `flags/durable-object-io-tasks-eviction` (xfail 1.64; workerd run
      locally keeps the object).
12. **`web_socket_compression`** (api/web-socket.c++, http.c++; on from
    2023-08-15) stays `Support::Off`: celld never agrees to
    permessage-deflate. The WebSocket library celld pins, fastwebsockets
    0.8.1, refuses a frame with RSV1 set (`ReservedBitsNotZero`), so
    support needs a reviewed fork or another library, and the negotiation
    and per-message deflate on every socket path (inbound, `fetch()`
    upgrades, Durable Object hibernation, cross-isolate pairs): plan 1.64.
    Cases `websocket/permessage-deflate-off` and
    `websocket/permessage-deflate` (xfail), both celld-only, recorded from
    workerd run directly (the harness's proxy agrees to the client's offer
    itself); the runner's `ws` step gained `"extensions": true` and
    `lib/workerd-direct.mjs` runs `ws` steps.
13. **`enable_request_signal`** (io/worker-entrypoint.c++; no date). With
    it an arrived request's `signal` aborts with an `AbortError`
    ("The client has disconnected") when its caller goes away, and a copy
    shares it; without it the request has a signal of its own that never
    aborts, and a copy gets another. A same-isolate service binding's call
    abandoned by its caller aborts the target's signal too. Case
    `flags/request-signal`.
14. The old-date states, each now honoured: **`strip_bom_in_read_all_text`**
    (a Request's or Response's `text()` keeps a BOM before 2026-01-13; a
    Blob's always does), **`text_decoder_replace_surrogates`** (the
    UTF-16LE decoder's fast path keeps lone surrogates before 2026-02-24),
    **`websocket_close_reason_byte_limit`** (no 123-byte check before
    2026-03-03) and **`writable_stream_spec_compliant_writer`** (`ready`
    waits for the start, stays resolved on release, and a write whose size
    algorithm released the writer goes ahead, before 2026-03-24). Case
    `flags/old-date-states`.
15. **`NEWEST_DATE`** is 2026-10-01, workerd 1.20261001.1's newest: the
    flags dated after 2026-09-04 are modelled (items 11 and above), and
    `python_workers_314`, which `python_workers` implies from 2026-09-08,
    is refused for a Python Worker with a hint to add
    `no_python_workers_314` or use an earlier date (`deploy/python.rs`).
    `deploy/compat-flags` and `loader/compat-flags-refused` now refuse
    2026-10-02.
- Also: `crypto.randomUUID()` is captured for celld's own use
  (`__celld.__randomUUID`), as is one TextEncoder for every body the
  harness encodes; a TextDecoder's fatal error is workerd's
  "Failed to decode input."; a socket's `opened` no longer has
  `localAddress`, which workerd's lacks.
- Updated: `flags/compatibility-flags` reports the new flags.
- Cost (lab, `ab -n 20000 -c 16`, medians of 9 interleaved rounds
  against 62ffd57): at 2026-09-04, hello-world fetch 19068 → 18982 req/s
  (−0.5%; an earlier 9 rounds gave +0.1%) and Durable Object RPC
  17160 → 17336 (+1.0%); at 2021-01-01, without
  workers_api_getters_setters_on_prototype, hello-world fetch
  18659 → 18496 (−0.9%). That last is the old state's own cost: an
  incoming Request and a Response are made through their attribute class,
  an API constructor, about 0.3 µs and 0.2 µs more than a plain object
  each, and the Response's body stream, a ReadableStream, about 0.15 µs
  more, which together are the 0.5 µs a request loses (in loops of
  300 000 constructions). Giving the attribute class the API class's
  prototype, so that no instance needs its prototype set, saved under
  0.05 µs, so it was left out. At 2026-09-04 each construction costs the
  same as at 62ffd57 or less. Before the attribute classes a Response
  cost 15 µs more at 2021-01-01 (its body stream's attribute took the
  stream off its shared shape), and the first review measured −4.8% on
  that hello world.

### 1.37 Gaps found by 1.16 that no flag gates

- `import { env }` at module scope in a top-level Worker is empty; workerd
  has the env. Importable `exports` lacks `default`.
- `eval` and `new Function` work during a request; workerd throws EvalError.
- Missing: `reportError`, `navigator.sendBeacon`, the Performance* classes,
  `node:timers` `setTimeout`.
- Queue JSON errors are Error where workerd throws TypeError.
- WebCrypto: an empty HMAC key is accepted; RSA exponent 3 is refused.
- `Blob.text()` strips a BOM; workerd keeps it.
- The Fetcher always exposes `getRpcMethodForTestOnly`.

**As built (done).** Probed on workerd 1.20261001.1 and read in its source
at that tag. Two bullets are flag-gated after all: eval during startup
(`allow_eval_during_startup`, now honoured) and the Performance classes
(`enable_global_performance_classes`, `enable_nodejs_perf_hooks_module`,
both now honoured).
- **`env` and `exports` from `cloudflare:workers`** (cloudflare/workers.ts,
  api/modules.c++ `EnvModule`, io/worker.c++). Both are workerd's proxies
  now (`__cfEnv`, `__cfExports`, with null-prototype handlers and captured
  `Reflect` functions): `env` over the Worker's env, which `load_realm`
  builds before the main module evaluates (the namespace keys, crons,
  workflows, containers, KV limits, queue config, `build_env` and the
  routing moved ahead of `module.evaluate`; none reads the module), so it
  holds every binding at module scope and a write through it reaches the
  handlers' env; `exports` over ctx.exports from once the module has
  evaluated (`__publishWorkerExports`, called by `populate_cf_exports`), so
  it has `default` and is empty at module scope, as in workerd. Under
  `disallow_importable_env` both read as empty. The raw export table that
  was the importable `exports` is now internal (`__moduleExports`, read by
  the Workflow engine), so a script can no longer change which class a
  Workflow runs by writing to it. Case `env/importable-env` (module scope
  and a request, writes, deletes, a Durable Object namespace and an
  entrypoint through `exports`, and a Worker with `disallow_importable_env`).
  Found: `env/binding-order` (xfail 1.65).
- **I/O at module scope** (io/io-context.c++ `IoContext::current()`, and its
  callers in kv.c++, actor.c++, http.c++, sockets.c++, worker-loader.c++).
  With `env` whole at module scope, a binding call there was enqueued and
  then ran inside the first request. workerd throws its global-scope error
  (`Disallowed operation called within global scope. …`, an `Error`) and
  starts nothing. celld now does the same at one choke point, the op table
  (`ops!`): the ops that start I/O through a binding or the network
  (`GLOBAL_SCOPE_IO_OPS`: subrequests, service fetch and RPC, Durable Object
  and runtime cell calls, so KV, Queues and Workflows, R2, Worker Loaders,
  sockets, WebSocket dials) refuse before they run while
  `ActorRuntimeState::global_scope` is set, which `ModuleEvaluation` sets
  for the main module's evaluation, the microtasks it queued and the
  reading of its exports: workerd reads the handlers (`unwrapExports`)
  before it leaves the Worker's startup, so a getter on the default export,
  or a Proxy default export's trap, runs in global scope too. The check
  is a compile-time constant per op, so an op that starts no I/O pays
  nothing, and one that does pays a slot read. Where workerd's method throws
  rather than rejects, the harness asks first (`__require_io_context`, a
  no-op op on the list): KV `get()` and `getWithMetadata()`, a service
  binding's RPC call or property, a Durable Object namespace's `get()` and
  `getByName()`, a Worker Loader's `get()` and `load()`; `connect()` and
  `new WebSocket()` already threw from their op. Where workerd's method asks
  before it checks its arguments, the harness asks first too, so its
  refusal comes first, after only the conversions workerd makes before it
  asks: a Queue's `send()` and `sendBatch()` (their options dictionaries and
  the batch's sequence of message dictionaries, with JSG's TypeErrors), D1's
  queries, `exec()` and `batch()` (after `query.trim()` and
  `statements.map`, whose TypeErrors come first), whose refusal is bare as
  workerd's client wraps only the answer's errors in `D1_ERROR`, and the
  Cache API's `put()` (after its Response converts and is not
  `Response.error()`, both rejections), `match()` and `delete()`, which
  reject; `caches.open()` asks nothing, as in workerd. A Cache method on
  something that is not a Cache throws workerd's Illegal invocation
  TypeError before anything else. The fix review found that `put()`
  rejects in global scope, not throws: the throw the case first recorded
  came from `new Response("x")`, which workerd refuses there (1.39). R2's
  `resumeMultipartUpload()` starts no I/O in workerd, so the handle now
  looks the upload up when a method first uses it, and it answers at module
  scope too. Case `builtins/cache-put-checks` (passes on both) pins the
  receiver and error-response checks in a request, and
  `queues/send-argument-types` (passes on both) the Queue conversions
  there. Cases `env/global-scope-binding-io` (passes on both): each refusal
  as workerd gives it, a var and an id still read, a refused call in a
  microtask, and two later requests that find the KV key absent and the
  service's and the Durable Object's counters at 0; and
  `env/global-scope-io-more` (passes on both): R2, Queues, D1 and the Cache
  API at module scope, a getter on the default export and a Proxy default
  export (each refused, with eval() working), and a later request that
  finds nothing written. Timers, random values and body reads stay with
  1.39.
- **eval** (jsg/setup.c++ `modifyCodeGenCallback` and `allowWasmCallback`,
  io/worker.c++). workerd allows `eval()`, `new Function()` (and the async
  and generator Function constructors) and compiling Wasm from bytes only
  while the main module evaluates, with the microtasks it queued and while
  its exports are read, and then only under `allow_eval_during_startup` (on
  from 2025-06-01); never in a
  request, a Durable Object's constructor or method, or a later timer. V8
  throws `EvalError: Code generation from strings disallowed for this
  context` and `CompileError: WebAssembly.Module(): Wasm code generation
  disallowed by embedder`. celld does the same with the context's own
  switch (`set_allow_generation_from_strings`), which no script reaches: on
  for the module's evaluation under the flag, off after it for the life of
  the isolate; an isolate-wide Wasm callback (`allow_wasm_code_generation`)
  answers with that switch. celld's own code compiles through the embedder
  API (`ScriptCompiler`), which the switch does not gate, and a configured
  Wasm module compiles before the module evaluates. The flag is
  `Support::Honoured`, so `disallow_eval_during_startup` is accepted.
  The switch and the global-scope flag above are one guard,
  `ModuleEvaluation`, which every exit from the load drops, after the
  exports are read.
  A Python Worker's interpreter, which workerd starts while the Worker
  starts but celld starts on the first request (it cannot evaluate an
  asynchronous top level), needs both (Pyodide's loader evaluates its
  `EM_ASM` code): `startInterpreter` from `celld:python` runs the start in
  the isolate's one startup window (`op_python_startup`). Only a deployed
  Python Worker has one: `celld:python` resolves, and the window is
  available, only in the isolates of a Worker whose manifest requires
  `python-workers-v1`, which `celld deploy` sets for a `.py` main
  (`WorkerConfig::with_python_runtime`, from `LoadedDeployment`); for any
  other Worker, `python_workers` or not, the specifier names no module.
  The manifest is the tenant's upload, so the node does not take its word:
  a deployment that requires the feature loads only under `python_workers`
  and with the interpreter `celld deploy` embeds, `pyodide.asm.wasm` and
  its GC sentinel as Wasm modules with the pinned SHA-256 digests
  (`fleet::python_runtime`, `deploy::python::carries_runtime`); any other
  fails its load. The bundle's JavaScript is the build's output and cannot
  be pinned, so a deployer who uploads the pinned interpreter beside a
  script of its own still gets the window (1.65). The window
  opens once, in a request and not at module scope, and closes when the
  start settles or `PYTHON_STARTUP_WINDOW` (30 s) after it opened, whichever
  is first, whatever becomes of the request that opened it: a client that
  disconnects during the start leaves it running, and the next request finds
  it. Pyodide 0.28.3's start with the vendored SDK took about 1 s on a lab
  build here (`celld dev`), so 30 s leaves room for a loaded node. At the
  deadline a thread condemns the isolate (a start still running then cannot
  finish as it should, and new requests go elsewhere), on the runtime of the
  turn that opened the window as the CPU watchdog does, so the slot's last
  reference never drops on that thread, and interrupts it; V8
  keeps no interrupt for an isolate no thread holds, so the next turn closes
  the window as it enters the realm (one load per turn while none is open).
  Checked by hand on a Python Worker built by `celld deploy`: the first
  request answers, a handler's `js.eval()` gets the EvalError, and a first
  request cut off at 0.3 s leaves the start to finish for the next one. Cases
  `flags/eval-during-startup` (four dates and flags; module scope, its
  microtasks, a request, a Durable Object's constructor and method, a timer)
  and `builtins/python-startup-window` (celld-only: a JavaScript Worker with
  `python_workers` and one without cannot import `celld:python`); the unit
  tests `js::python_startup_tests` cover a Python Worker's configuration:
  the import, the window opening once and closing on settle but not at the
  opening event's end, the deadline between turns and within one, the
  deadline condemning the slot on the turn's runtime, and module scope;
  `fleet::tests::only_a_python_bundle_gets_the_python_runtime` covers the
  grant. Rechecked by hand after the grant: a Python Worker `celld dev`
  built answers its first request. Found: `builtins/eval-non-string` (xfail
  1.65).
- **`reportError()`** (api/global-scope.c++
  `ServiceWorkerGlobalScope::reportError`). A global function, not
  enumerable, `length` 0, workerd's TypeError without an argument, that
  runs celld's existing error reporting (`__reportError`): a trusted,
  not cancelable ErrorEvent on the global scope from V8's message for the
  value, then the console. A listener's exception escapes it only when the
  dispatch propagates (without `spec_compliant_dispatch_exceptions`). The
  ErrorEvent class is now captured and the event's init has no prototype.
  Case `builtins/report-error` (two dates).
- **`navigator.sendBeacon()`** (api/global-scope.c++ `Navigator::sendBeacon`).
  In a request it POSTs the body through the global fetch() captured before
  any script runs (`__globalFetch`), as background work the request waits
  for, and answers true whatever the fetch does; outside one it answers
  false. Not enumerable, `length` 0, workerd's errors for no argument and a
  foreign receiver. Case `builtins/send-beacon`; the conformance upstream
  gained `/beacon` and `/beacon/log`.
- **Performance classes, `node:perf_hooks`, `node:timers`** (api/performance.h
  and .c++, global-scope.h, api/node/node.h; src/node/perf_hooks.ts,
  timers.ts, internal/internal_timers.ts). `enable_global_performance_classes`
  and `enable_nodejs_perf_hooks_module` (each implied by `nodejs_compat`
  from 2026-03-17) are honoured. `performance` and the seven classes are one
  lazy global group (`performance.js`), so a Worker that never names them
  compiles nothing (hello world no longer builds a `performance` object).
  Without either flag `performance` has only `timeOrigin` (0) and `now()`
  (`Date.now()`); with one, Performance is an EventTarget with workerd's
  user-timing methods, which record marks and measures and measure nothing,
  and `Performance`, `PerformanceEntry`, `PerformanceMark`,
  `PerformanceMeasure`, `PerformanceResourceTiming`, `PerformanceObserver`
  and `PerformanceObserverEntryList` are globals; the hooks flag adds
  `nodeTiming`, `eventLoopUtilization()`, `markResourceTiming()` and
  `timerify()`, and with Node.js compatibility `node:perf_hooks` resolves
  (otherwise it is celld's throw-on-use stub, as for other unavailable
  modules). It uses only intrinsics the harness captured and keeps entry
  state in private fields, with workerd's argument conversions and errors.
  `node:timers` shares workerd's `Timeout` with the global timers through
  one builder (`__nodeTimers`), and its `setImmediate`/`clearImmediate`
  return and take an `Immediate`; the global `setImmediate` and
  `clearImmediate` now exist only under `nodejs_compat_v2`, with workerd's
  errors, where before they existed whatever the flags and returned a
  number (a Timeout under global timers). A lazy module can have a default
  export of its own (`LazyModule.default`), which `process.getBuiltinModule`
  returns. Cases `builtins/performance-classes` (11 Workers across dates and
  flags), `node/perf-hooks`, `node/timers-module` (global timers on and
  off), `node/global-set-immediate`; found: `node/dynamic-import-namespace`
  (xfail 1.65). `flags/compatibility-flags` reports the three newly
  honoured flags.
- **Queue JSON bodies** (api/queue.c++ `serialize`, jsg `JsValue::toJson`).
  A JSON body is V8's `JSON.stringify` through the captured function: its
  own errors (a BigInt, a cycle, a throwing `toJSON`) reject `send()` and
  `sendBatch()` as they are, where celld wrapped them in a
  `QUEUE_ERROR` Error, and a value it leaves out (a function, a Symbol) is
  sent as the text `undefined`, as in workerd, where celld refused it.
  Queue bodies encode with the captured UTF-8 encoder. Case
  `queues/json-body-errors`.
- **WebCrypto.** An HMAC key imported from `raw` data takes workerd's
  length checks (api/crypto/digest.c++ `importHmac`): the data's bits, or a
  `length` up to 7 bits fewer whose extra bits are zeroed, converted as a
  WebIDL `long` (`_webIdlLong`: not finite is 0, out of 32 bits workerd's
  TypeError), never 0, so an empty key is refused with workerd's DataError;
  before, celld took the length from the data whatever `length` said. RSA
  generation checks its parameters as workerd's `generateRsa` and
  `validateRsaParams` (api/crypto/rsa.c++) do under `strict_crypto_checks`,
  in their order (`_rsaGenerateParams`): the exponent, the hash and the
  modulus are required; the modulus is a multiple of 8 from 256 to 16384
  bits, then the exponent 3 or 65537 (read as workerd's `fromBignum` reads
  it), then a multiple of 128, then at least 512 (BoringSSL's "RSA key size
  is too small."). Exponent 3 now generates (`RsaPrivateKey::new_with_exp`;
  the host op takes only 3 or 65537), and the key reports the exponent as
  given, leading zeros included. Between the modulus's presence and its
  range come the hash, which must be a digest workerd knows (else its
  NotSupportedError), and the usages, each one the algorithm has (else its
  SyntaxError); after the 512-bit floor, a pair whose private half has no
  usage is refused, and a pair's halves take workerd's public and private
  usage masks (`wrapKey` and `unwrapKey` were dropped). Found while testing
  it and fixed: RSA-PSS `verify()` ignored the salt length and verified only
  a salt as long as the digest, so a signature with `saltLength: 0` never
  verified, and `sign()` took a missing one as 0 and panicked the host op on
  one too long for the key. Both now take it as workerd's
  `RsaPssKey::addSalt` does (`_rsaPssSaltLength`): required (sign's
  DataError, verify's TypeError), a WebIDL long, not negative; a sign whose
  salt does not fit the key is workerd's OperationError, a verify false.
  Cases `builtins/hmac-import-length`, `builtins/rsa-generate-params`.
- **`Blob.text()`** keeps a BOM already: 1.36 item 14 made it so, and
  `flags/old-date-states` (`blobText`) pins it on both runtimes. No change.
- **`getRpcMethodForTestOnly`** (api/http.h `Fetcher`): workerd defines it
  only under the `experimental` flag, which celld refuses, so on a service
  binding and a `ctx.exports` stub the name is now an RPC method like any
  other. `rpc/rpc-refusals-internal` used the hook to send names no stub
  sends; its `/hook` step is now the unit test
  `js::rpc_params_tests::reserved_and_object_prototype_names_are_refused`,
  which drives the receiver's walk as a peer's call reaches it (the
  test-only `__liftedForTest.atEntrypoint`). Case
  `rpc/fetcher-test-only-method`.
- Updated: `docs/cloudflare-compat.md` (`cloudflare:workers`, Web Crypto,
  Web standards, Performance and timers, Node.js, the flag lists),
  `docs/services/workers.md` (the Python startup window), the conformance
  README (`/beacon`). `limits/backing-stores` compiled its Wasm module in a
  request; it now compiles it at module scope (`prelude`, which its Dynamic
  Workers' source declares too), and the unit test
  `growth_outside_the_allocator_is_bounded_within_the_load` loads at a date
  with `allow_eval_during_startup`.
- Cost (lab, `ab -n 20000 -c 16`, at 2026-09-04, medians of 12 interleaved
  rounds against c6a0f3e): hello-world fetch 19140 → 18907 req/s (−1.2%),
  Durable Object RPC 16980 → 17153 (+1.0%), both within the rounds' spread
  (hello world 18183-19453 against 18777-19300). The hot path gains one
  relaxed load per turn (the Python window's deadline, in `realm()`) and a
  slot read per op that starts I/O (the global-scope check); hello world no
  longer builds `performance`.

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
for accepted sockets only when the flag is on. 1.16 classified
`web_socket_auto_reply_to_close` as always-on; promote it (and the manual
disable name, now refused) to honoured.

**Tests.** `websocket/close-without-handler` (compat date 2026-01-01) and
`service-bindings/ws-101-client-close` lose their `xfail`; S11 then sees no
"dropped a frame" lines. Add the same case at a date after 2026-04-07 for the accepted
socket.

**As built (done).**
- `web_socket_auto_reply_to_close` and `web_socket_manual_reply_to_close` are
  honoured. The harness tracks each direction's Close. A socket that is not
  half-open replies to its peer's Close with the same code and reason before
  its close event fires (1005 as an empty Close, as kj writes it), so it is
  CLOSED then and a later `close()` does nothing. A half-open one is CLOSING
  until the Worker calls `close()`, and can still `send()` until then.
  `accept({allowHalfOpen})` chooses for one socket. A same-isolate pair now
  models the handshake too: the end that closes first is CLOSING, and its
  close event fires with the reply. A hibernatable socket is CLOSING in
  `webSocketClose`. `close()` without a code sends an empty Close (1005),
  as workerd does; it used to send 1000. `close()` accepts workerd's codes
  outside pedantic WPT mode (1000-4999 except 1004, 1005, 1006 and 1015,
  converted as an int) with workerd's error texts, and `send()` after
  `close()` throws workerd's TypeError.
- The host no longer echoes a Close anywhere. A client's socket (stateless
  or Durable Object), a dialed one (`set_auto_close(false)`), a
  `stub.fetch` pipe and the handoff bridge all deliver the Close and then
  carry the application's reply. The bridge waits for the reply whichever
  side closes first. A hibernatable socket never replies by itself, so a
  `webSocketClose` that does not close leaves its client with 1006.
- While a socket waits for the reply, the host keeps reading its transport
  (`write_until_close`), so a peer that disconnects ends the socket and
  releases the object's residency. A reply already on its way still goes
  out for up to 1 s after the peer's side ends, so it reaches a peer that
  only shut down its side and does not land on a socket that is gone. A
  socket whose application's Close crossed the peer's does not wait at
  all. A frame sent later still, to a socket that ended after its peer's
  Close, is logged at debug level (a bounded list of such ids), not as a
  lost frame. There is no wall-clock bound while the
  peer stays connected. A failed close dispatch reached no handler, so the
  socket ends at once (1006), as workerd disconnects the sockets of an
  object that broke. A `stub.fetch` pipe ends its wait when either side's
  socket goes or the caller's request ends, and when the object closes
  first it takes the caller's reply for up to 10 s, as the bridge does.
- **Decision:** a half-open socket that the isolate polls registers an op
  with a new lifetime, `IoContextUnrefed`. It keeps the request's other
  work running, so a timer that will call `close()` fires, but it cannot
  keep the request by itself. When the request ends, `IoContext::drop`
  releases the sockets it returned (`ws_release_returned`), and the
  connection ends without a Close, as workerd drops it. A dialed socket's
  retirement skips its 1001 once the peer has closed (`ws_peer_closed`).
- Cases: `flags/websocket-auto-reply` and `flags/websocket-manual-reply`
  (one shared Worker, `#ws-close-reply`: stateless, Durable Object,
  `allowHalfOpen`, relay, both caller paths, pairs, hibernatable, `send()`
  while half-open, Closes without a status both ways), the two former
  xfails, `websocket/dialed-close-reply` (celld-only: the runner's upstream
  now speaks WebSocket and records the reply a dialed socket sends),
  `websocket/half-open-disconnect` (celld-only), and
  `flags/compatibility-flags` reports the flag. `/close-errors` pins the
  `close()` and `send()` errors. The runner gained `"close": null` and raw
  `ws` steps (`"raw"`, `"shutdown"`) that read after the client's Close,
  record binary frames, and fail on a fragmented message. Before this change both flag cases failed (the manual
  flag was refused at deploy). S11 shows no "dropped a frame" lines. Host
  unit tests cover the reply wait, the transport watch, crossing Closes,
  the pipe, and the bounded list of ended sockets.
- Found: a server-end socket a Worker or Durable Object closes first is
  CLOSED at once and never fires the close event for the peer's reply
  (`websocket/server-close-event`), and a half-open socket ends when the
  peer shuts down its side, where workerd keeps it
  (`websocket/half-open-shutdown`). Both documented, as 1.22 xfails.

### 1.18 Worker Loader startup error text

**Problem (found by 1.1).** A Dynamic Worker that fails to start reports
`instantiate: SyntaxError: …` on celld. workerd reports
`Failed to start Worker:\nUncaught SyntaxError: …\n  at <file>:<line>:<col>`.

**Design.** Match workerd's text for every startup failure through the
Loader.

**Tests.** Widen the link steps in `modules/cloudflare-workers-exports`
back to the full message.

**As built (done).**
- Probed on workerd 1.20261001.1 and read in its source (`server.c++`
  `DynamicErrorReporter`, `worker.c++` `reportStartupError`, jsg's
  exception unwrapping and `JsMessage::addJsStackTrace`). A Worker Loader
  rejects every call of a Worker that failed to start with an `Error`
  whose message is `Failed to start Worker:` and the cause on the next line.
  For a thrown value the cause is `Uncaught ` and its description: V8's
  side-effect-free detail string, kept when the value is an object whose
  string starts with one of jsg's error types (`Error`, `TypeError`, …,
  `DOMException`) and otherwise typed as `Error: `. So a thrown `MyError`
  reads `Uncaught Error: MyError: …`, a string `Uncaught Error: …`, a plain
  object `Uncaught Error: #<Object>`, and a `DOMException`
  `Uncaught DOMException(<name>): …`. Then come location lines from the V8
  message: one per frame of its stack trace, `  at <file>:<line>:<col>`
  with ` in <function>` when the frame has one (10 frames at most), or,
  with no frames, the message's own location, whose column (0-based, as
  V8 gives a start column) and line are left out when 0. An `Error`'s
  frames are where it was constructed, because workerd rethrows module
  scope's rejection from C++. A thrown primitive has no location, unless
  `Error.captureStackTrace` gave it frames. workerd's runtime APIs are C++,
  so an error one throws has only the Worker's frames.
- celld does the same in `load_realm`. The isolate captures stack traces
  for uncaught exceptions while it loads, as workerd's does, so an `Error`
  keeps its construction frames; `uncaught!` and `uncaught_startup_error`
  build the report from a TryCatch's exception and message, and a rejected
  module promise goes through `v8::Exception::create_message`, which is
  the path `ThrowException` takes in workerd. celld's own scripts (prelude,
  harness, lazy builtins, host snippets) compile under the reserved name
  `celld:internal`, and the report leaves their frames out, so
  `new URL("bad")` reports only `  at main.js:2:1`. The load captures up to
  64 frames so that 10 of the Worker's remain after celld's are dropped.
  Code without a name (`new Function`) still reads as workerd's `worker.js`.
  A `DOMException` keeps the name and message it was made with in two
  `v8::Private` fields (`__dom_exception_brand`, called by its constructor),
  and the report reads only those, after refusing a Proxy, so building the
  report runs no Worker code: V8's detail string is side-effect free, and
  the global lookup, `instanceof` and getters an earlier draft used are gone.
  Compile, link and evaluation
  failures, a throwing handler lookup (`get fetch()`), and a sibling module
  that does not compile all report this way. A sibling that did not compile
  used to be dropped with a warning, so the start failed later, at link
  time. The link resolver throws workerd's `No such module "<path>".`
  with `  imported from "<module>"`, the path taken from the bundle's root
  as workerd's `kj::Path` evaluation gives it (a bare specifier is relative
  to the importing module's directory, one starting with `/` from the root,
  and `node:`, `cloudflare:` and `workerd:` are not paths). A root-relative
  specifier also resolves that way now. One that climbs past the root fails
  with workerd's `TypeError: Invalid module specifier "<spec>".` and
  `  imported from "<module>".`. It used to fail without an exception
  (`instantiate: <none>`). A dynamic `import()` of a module that is not
  there rejects with workerd's `No such module "<path>".`, made in the
  import hook so that it has the frames of the `import()` call.
- **Top-level await.** After evaluation celld runs a microtask checkpoint,
  and a module promise still pending fails the start with
  `Uncaught Error: Top-level await in module is unsettled.`, as workerd
  does. celld runs no event loop while a Worker starts, so nothing can
  settle it there. workerd fails I/O and timers at module scope before it
  gets that far (1.39). This applies to deployed
  Workers too, as in workerd, and closes the 1.34 check of
  `ns.get(...).unwrap()` reading a binding still in its TDZ.
- **Main module.** `op_loader_load` reports workerd's
  `Uncaught Error: No such module: <name>` for a `mainModule` the modules
  lack, and `Uncaught TypeError: Main module must be an ES module.` for a
  `json`, `text`, `data`, `cjs`, `py` or `wasm` main module.
- **Decision (the 1.34 question):** the startup limits get the prefix too.
  workerd's `reportStartupError` sends a limit error to the same
  `DynamicErrorReporter`, without `Uncaught `, as the error's description,
  which jsg always types (`Error: …`, or `Error: internal error` for an
  untunneled one). So the Loader reports `Failed to start Worker:` then
  `Error: Script startup exceeded CPU time limit.` (or `memory limits.`).
  workerd run locally enforces neither limit, so this text follows the
  source, not a recording; the sentence itself remains Cloudflare's deploy
  error. `failed_to_start` adds the prefix where the Loader records a
  failed load, so a deployed Worker's startup error stays the bare report
  (`Uncaught …`), which replaces `compile: …`, `instantiate: …` and
  `top-level rejected: …` in the node log.
- Cases: `loader/startup-errors` (58 children, each loaded twice, and one
  through `get()`): syntax errors in the main module, an imported sibling
  and an unimported one, throws of every kind of value and of errors with
  custom names, subclasses, empty and multi-line messages, a plain object
  with captured frames, a Proxy whose `getPrototypeOf` never returns,
  DOMExceptions whose properties were set, given a getter, or made with
  `Object.create`, `structuredClone` and `AbortSignal` throws (harness
  frames), frames across functions, methods, arrows, recursion past 10
  frames and modules, a missing main module and four kinds of non-ES main
  module, unresolved relative, bare, builtin and dynamic imports, imports
  past the root and from it, a missing export, rejected and unsettled
  top-level await, a throwing `fetch` getter and a primitive export.
  Before this change
  the 38 failure children it had then all differed, as did the `get()` step (`compile: …`, `top-level rejected:
  …\n<stack>`, `worker loader: module … missing or not a string`,
  `instantiate: <none>`, and `tla-never` loaded); the six added later
  (DOMException, Symbol, AggregateError, the getter, a wasm main module, a
  nested bare import) could not be run at HEAD, as a second lab build does
  not fit the scratch quota. It passes now. `modules/cloudflare-workers-exports`
  records the full message of its two link failures, with their location
  lines. The celld-only `loader/startup-cpu`, `loader/startup-memory` and
  `limits/backing-stores` take the new text (`backing-stores` now drops
  only the location lines). A unit test in `bootstrap.rs` pins the
  report and the prefix.
- Found:
  - Which builtin modules a Dynamic Worker can import differs from
    workerd. `loader/startup-errors-builtins` records it, xfail until 1.38.
  - Disallowed operations at module scope: `loader/global-scope-io`, xfail
    until 1.39.
  - Runtime API error messages: `loader/startup-errors-api-text`, xfail
    until 1.40.
  - celld's frames still show in `error.stack` (now as `celld:internal`
    rather than unnamed); workerd's C++ APIs add none. Only the startup
    report leaves them out. And a `DOMException` subclass's constructor
    frame is missing from the report, because celld's `DOMException` is a
    JS class whose constructor frames are internal; workerd reports the
    subclass constructor's frame (`loader/startup-errors-dom-subclass`,
    xfail until 1.34). Both listed in 1.34.

### 1.38 Builtin modules a Worker can import (found by 1.18)

**Problem.** workerd has a `node:` module (or its bare name, such as
`path`) only under the flags that provide it, and no `cloudflare:` module
it does not implement. A Dynamic Worker at 2026-01-01 without
`nodejs_compat` that imports `node:fs`, `node:buffer` or `path`, or that
imports a name from `cloudflare:nope`, fails to start there with
`No such module "<name>".` celld stubs every `node:` and `cloudflare:`
specifier a bundle imports by name, so the Worker loads, and only calls into
an unsupported stub throw. The reverse also holds: a side-effect import of
a builtin (`import "node:buffer";` under `nodejs_compat`) links on workerd,
but celld's import scan needs a `from` clause, so no stub is registered and
the start fails with `No such module`.

**Design.** Register a builtin only when the Worker's flags provide it, as
workerd's module registry does, and refuse unknown `cloudflare:` names at
link time. Scan side-effect imports too. Check what the starter's and
Cloudflare OS's bundles import without the flags first, since deployed
Workers share the stub path.

**Tests.** `loader/startup-errors-builtins` loses its `xfail`.

**As built (done).** Probed on workerd 1.20261001.1 and read in its source
at that tag (api/node/node.h `registerNodeJsCompatModules`, jsg/util.c++
`checkNodeSpecifier` and `NODEJS_BUILTINS`, jsg/modules.c++
`resolveCallback`, jsg/modules.h `dynamicImportCallback`, api/modules.h
`registerModules`, api/node/process.c++ `getBuiltinModule`,
`src/node/BUILD.bazel`, `src/cloudflare/BUILD.bazel`).
- **workerd's rules.** Its Node.js bundle (68 public modules, `node:test`
  among them) is registered only with Node.js compatibility (`nodejs_compat`
  or `nodejs_compat_v2`), and 30 of them need a flag of their own besides:
  `node:fs`, `node:os`, the `node:http`/`node:https`/`node:_http_*` client
  modules, `node:_http_server`, `node:http2`, `node:console`, `node:vm`,
  `node:perf_hooks`, `node:domain`, `node:v8`, `node:tty`, `node:punycode`,
  `node:cluster`, `node:child_process`, `node:worker_threads`,
  `node:_stream_wrap`, `node:wasi`, `node:dgram`, `node:inspector(/promises)`,
  `node:trace_events`, `node:readline(/promises)`, `node:repl` and
  `node:sqlite`. Most of those flags come with `nodejs_compat` from a date,
  not with `nodejs_compat_v2` alone; `node:fs/promises` needs none. Without
  Node.js compatibility only `node:async_hooks` exists, under `nodejs_als`,
  and `node:process`, which the resolver redirects to an internal module for
  every Worker. With Node.js compatibility, `checkNodeSpecifier` rewrites a
  bare Node.js name to `node:<name>` (and `sys`/`node:sys` to `node:util`)
  before the lookup, so a gated one reports `No such module "node:v8".`;
  without it a bare name is a path (`No such module "path".`, or
  `"lib/path"` from `lib/`). `test` is no bare name. The ten `cloudflare:`
  modules (`ai`, `br`, `durable-objects`, `email`, `node`, `pipelines`,
  `sockets`, `vectorize`, `workers`, `workflows`) exist whatever the flags;
  any other `cloudflare:` or `workerd:` name is `No such module` (the
  `workerd:` ones need experimental flags celld refuses).
  `process.getBuiltinModule()` applies `checkNodeSpecifier` whatever the
  flags and returns a Node.js module's default export, another builtin's
  namespace, or `undefined`.
- **celld** (`js/modules.rs`). `BuiltinModules`, the isolate slot that
  `inject_storage_compatibility` sets, now holds the flags and answers
  `canonical()` (workerd's `checkNodeSpecifier` under Node.js
  compatibility) and `provides()`, from workerd's tables
  (`NODE_BUILTIN_NAMES`, `NODE_MODULES`, `GATED_NODE_MODULES`,
  `CLOUDFLARE_MODULES`). Static resolution (`resolve_external`), `import()`
  (`host_import_module_dynamically`, through `builtin_source`),
  `process.getBuiltinModule()` (`op_builtin_module`) and stub registration
  all ask it, so a module the flags leave out gets no stub and its import
  fails with workerd's `No such module "<path>".` and `imported from`. The
  scan (`scan_external_imports`, one regex pass) now reads side-effect
  imports (minified `import"x"` too), `export * from`, `export * as … from`
  and `export { … } from`, and drops block comments inside a clause. Stubs
  are merged per module across the main module and its siblings (a
  sibling's names from a builtin the main module also imported used to be
  dropped, failing the link), and `register_requested_builtins` gives a
  full-surface stub to any builtin V8's module requests list that the scan
  missed (`import /* … */ "node:buffer"`). `process.getBuiltinModule()` of a
  `cloudflare:` module returns its namespace (it returned `undefined`). A
  user import of `celld:internals` is now `No such module`, as workerd
  reports it, rather than celld's own TypeError. `LAZY_MODULES` and
  `eager_module_global` are keyed by `node:` names only, and
  `node:test/reporters`, which workerd lacks, is gone. The 22 per-module
  `enable_nodejs_*`/`disable_nodejs_*` pairs are now `Honoured` (they were
  `NoEffect`), so `Cloudflare.compatibilityFlags` reports them as workerd
  does, and `nodejs_als` now decides `node:async_hooks` without Node.js
  compatibility.
- **Scanned names.** A binding name the scan reads from tenant code is
  interpolated into a stub's source, so the scan keeps only identifiers
  (`IDENTIFIER_RE`); a quoted string name is left out and fails to link as
  a missing export would. Found by review: the delimiters already kept a
  statement separator out of a name, so no escape was found, but nothing
  stated it (`the_scan_takes_only_identifiers`).
- **Deployed Workers.** All seven starter Workers (and the integration
  fixtures) run at 2026-09-04, where `nodejs_compat` is on by date
  (2026-08-04) and with it every module flag (the latest from 2026-03-17),
  so they keep every Node.js module; their sources import `cloudflare:`
  `workers` and `pipelines` (types only) besides. Cloudflare OS's Dynamic
  Workers (gadgets, code mode, the restore forger: 2026-02-01, no
  `nodejs_compat`) import only `cloudflare:workers`. Checked by loading the
  seven configs under `celld dev --no-build` behind a probe Worker that
  fetched each through a service binding: all seven linked (router, context,
  custom gatekeeper and error reporter answered 200, the workshop 404, the
  scheduler and websearch "does not export a fetch() function").
- **Tests.** `loader/startup-errors-builtins` loses its `xfail` and grows
  to 29 children: side-effect (plain, minified, missing), re-export (`*`,
  `* as`, named, minified, missing) and commented imports, names from one
  builtin across two modules, gated modules with and without their flag,
  `disable_nodejs_fs_module`, `node:fs/promises` under `nodejs_compat_v2`,
  bare names with and without Node.js compatibility, `sys`, bare `test`,
  `nodejs_als`, `node:process` without flags, a date that brings Node.js
  compatibility, known and unknown `cloudflare:` modules, `workerd:unsafe`.
  New `loader/builtin-modules` records, for eight dates and flag sets, the
  `import()` outcome of every bare and `node:` Node.js name and 22 other
  specifiers, and `process.getBuiltinModule()` of each where workerd has a
  `process`; its top-level Worker imports `cloudflare:email` and
  `cloudflare:workflows` for side effects. Both fail at HEAD (the second
  already at its top-level side-effect import). New
  `loader/builtin-missing-export` (xfail, 1.66). Unit tests in
  `js/modules.rs`: the scan's forms, a side-effect import before another
  statement, availability with and without Node.js compatibility and per
  flag, and the tables' agreement.
- Docs: `docs/cloudflare-compat.md` (Node.js compatibility, Honoured flags,
  Flags without effect), `docs/services/dynamic-workers.md`.
- Cost (lab, medians of 9 interleaved rounds against ddc8802): hello world
  (`ab -n 20000 -c 16`) 18435 → 18272 req/s (−0.9%, ranges 18266-19052
  against 18133-18889); a fresh Dynamic Worker per request importing three
  builtins (`ab -n 1000 -c 4`) 317 → 314 (−0.9%, 313-321 against 309-320).
  An isolate build adds a slot read and a map merge per imported builtin,
  and a walk of each module's requests.
- Found: 1.66.

### 1.39 Disallowed operations in global scope (found by 1.18)

**Problem.** workerd refuses, at module scope, asynchronous I/O, setting a
timer and generating random values. The operation throws, and the Worker
fails to start with:

```
Failed to start Worker:
Uncaught Error: Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope. To fix this error, perform this operation within a handler. https://developers.cloudflare.com/workers/runtime-apis/handlers/
  at main.js:2:7
```

Recorded for `await new Promise((r) => setTimeout(r, 0))`,
`await scheduler.wait(0)`, `crypto.getRandomValues(new Uint8Array(1))`,
`await new Response("x").text()`, reading a `TransformStream`'s readable
side through a `Response`, and `await fetch(…)`. celld reports the first
two and `fetch` as `Top-level await in module is unsettled.` (it runs no
event loop while a Worker starts), and loads the Worker for the other three.

**Design.** Refuse each such operation while a Worker loads, with
workerd's text, from the op or harness entry point that performs it, so
the frames are the caller's. Find the full list in workerd's
`IoContext::current()` callers that check `hasCurrentIncomingRequest`
(timers, crypto random, body reads, subrequests, sockets). 1.37 did the
I/O half: the ops in `GLOBAL_SCOPE_IO_OPS` (bindings, subrequests, sockets,
WebSocket dials) refuse while `ActorRuntimeState::global_scope` is set,
which now covers the reading of the main module's exports too, and the
harness asks first (`__require_io_context`) where workerd's method refuses
ahead of its own checks (Queues, D1, the Cache API), so timers, random
values and body reads remain; each can join that list or call
`__require_io_context` first. Making a body is refused too: `new
Response("x")` throws the error at module scope, where `new Response(null)`
does not (probed by 1.37's `env/global-scope-io-more`).

**Tests.** `loader/global-scope-io` loses its `xfail`.

**As built (done).** Probed on workerd 1.20261001.1 (a Dynamic Worker per
operation, which catches and reports) and read in its source at that tag:
io/io-context.c++ `IoContext::current()` and its callers in
api/global-scope.c++ (the timers, `setImmediate`), api/basics.c++
(`Scheduler::wait`, `AbortSignal::timeout`), api/crypto/crypto.c++,
digest.c++ and aes.c++ (`getRandomValues`, `randomUUID`, `generateHmac`,
`generateAes`), api/http.c++ (`Body::bufferingLimit`, `Body::text`,
`Body::formData`, `Response::constructor`, `Response::redirect`,
`Request::constructor`, `fetchImpl`), api/js-readable-stream.c++
(`bufferBackedImpl`), api/blob.c++ (`Blob::stream`),
api/streams/compression.c++ and identity-transform-stream.c++,
api/web-socket.c++ (`WebSocketPair`), api/worker-rpc.c++
(`JsRpcStub::constructor`), api/html-rewriter.c++ (`transform`),
api/eventsource.c++, api/node/diagnostics-channel.c++ (`Channel::publish`),
api/workers-module.c++ (`waitUntil`), and src/node/internal/internal_timers.ts.
- **workerd's rules.** Every method that asks for the current request throws
  the global-scope `Error` at module scope, synchronously, or as a rejection
  when the method returns a promise (`scheduler.wait()`, a body read,
  `generateKey()`), after the checks it makes first: argument conversions,
  `getRandomValues()`'s integer-view and 64 KiB checks, `generateKey()`'s
  usages and AES length, a Response's init and status, `Response.redirect()`'s
  status and URL, a used body or a missing Content-Type for `formData()`.
  Refused: setting a timer (`setTimeout`, `setInterval`, `setImmediate`,
  `scheduler.wait()` even with an aborted signal, `AbortSignal.timeout()`,
  node:timers and its promises), clearing one by a safe-integer id
  (`clearTimeout(1)`, `clearTimeout("1")`; not `undefined`, `null` or 1.5);
  `getRandomValues()`, `randomUUID()`, an AES or HMAC key from
  `generateKey()` and node:crypto's random functions (ECDSA, Ed25519, X25519
  and RSA keys are made); making any body but a stream (a string, bytes, a
  Blob, FormData, URLSearchParams, an async iterable; `Response.json()`,
  `Response.redirect()`, a Request with one); reading a stream body
  (`text()`, `json()`, `arrayBuffer()`, `bytes()`, `blob()`, `formData()`;
  a null body reads as empty, and reading the stream itself waits);
  `Blob.stream()`; `IdentityTransformStream`, `FixedLengthStream`,
  `CompressionStream`, `DecompressionStream` (a TransformStream, a
  WritableStream, the text streams and `DigestStream` are made);
  `WebSocketPair`; `new RpcStub()`; `HTMLRewriter.transform()` of a body;
  `waitUntil()` from `cloudflare:workers`; a diagnostics_channel
  `publish()`, after its subscribers run. `new EventSource()` and
  `EventSource.from()` throw `NotSupportedError: An EventSource can only be
  created within the context of a worker request.` first. A Worker whose
  module scope lets one escape fails to start with `Failed to start
  Worker:` and `Uncaught Error: Disallowed operation …` and the caller's
  frames; an unawaited rejected `generateKey()` does not fail it. A Durable
  Object's constructor, its own and a facet's from a Dynamic Worker, runs in
  the request that reached it, so all of these work there.
- **celld** refuses at the same points. The op table's list, now
  `GLOBAL_SCOPE_OPS` (js.rs), gains `__timer_alloc` (every timer),
  `$$randomValues` (a script's random values) and `__zlib_stream_new` (the
  compression streams), so those cost a slot read and nothing in the
  harness. celld's own random draws (multipart boundaries, queue message
  ids, the harness's UUIDs) go through a second name for the same op,
  `$$celldRandomValues`, which nothing refuses and no script reaches, so
  they also no longer go through a script's `crypto`. `generateKey()` draws
  an AES or HMAC key through `$$randomValues` itself, not through
  `getRandomValues()`, which a script can replace on `Crypto.prototype`
  (it made all-zero keys, and a key at module scope); workerd's draw is
  native. celld's own timers (a Queue producer group's flush, a Workflow
  step's deadline and its quiescence and stall timers, `scheduler.wait()`,
  `AbortSignal.timeout()`, node:timers/promises and EventSource's retry) arm
  through the harness's timers (`__setTimeout`, `__clearTimeout`, on
  `__celld` for the scripts after it) instead of the global `setTimeout`,
  which a script can replace; workerd's are C++, and its
  node:timers/promises uses node:timers', which captured the originals.
  They still allocate through `__timer_alloc`, so global scope refuses
  them as before. The rest ask
  `__require_io_context()` where workerd asks: the Response constructor
  after its status checks, for a body that is not a stream; the Request
  constructor after its method check, for a script's init with such a
  body; `Response.redirect()` after the URL parses; the body methods for a
  stream body (`text()` and `json()` after the used check, `formData()`
  after the used and Content-Type checks, which it now makes before reading,
  as workerd does in a request too, with workerd's text); `clearTimeout()`
  and `clearInterval()` for an id no timer of celld's has; an aborted
  `scheduler.wait()`; `Blob.stream()`; `IdentityTransformStream` (so
  `FixedLengthStream` after its length check); `WebSocketPair`; `RpcStub`
  before its target check; `HTMLRewriter.transform()` of a body;
  `waitUntil()`; diagnostics_channel `publish()`; and global `fetch()`,
  which now asks once its Request is made, before its first `await`, so the
  refusal has the caller's frame (it had none) and a `data:` URL is refused
  too. EventSource asks a new op, `__in_global_scope()`, and throws its own
  error. `clearTimeout()` and `clearInterval()` now take their id as workerd
  does: required (workerd's TypeError), converted as a number, clearing only
  a safe integer. `getRandomValues()` has workerd's TypeMismatchError and
  QuotaExceededError texts. Python's interpreter starts in a request
  (1.37), and the Workflow, Durable Object and Performance setup, the
  builtin modules' evaluation and the reading of the exports set no timer
  and draw nothing through the refused names, so none is refused; checked
  by the full suites and by hand on the Python Worker 1.37 used.
- **Tests.** `loader/global-scope-io` loses its `xfail` and grows to 25
  children: each refusal above that escapes module scope, a `data:` fetch,
  an unawaited rejection that still starts, and EventSource's own error,
  each with workerd's frames. New `loader/global-scope-ops` records 118
  operations at module scope through a shared probe
  (`lib/worker/global-scope-ops.js`, `#global-scope-ops`): whether each
  returns, throws or rejects, and with what, the checks that come before the
  refusal included, and that replacing the global `setTimeout` or
  `getRandomValues()` first changes none of them. Both fail at HEAD. New
  `builtins/replaced-globals` (fails at HEAD) pins, in a request, that a
  secret key from `generateKey()` is random after `getRandomValues()` is
  replaced, and that `scheduler.wait()`, `AbortSignal.timeout()` and
  node:timers/promises settle after the global `setTimeout` and
  `clearTimeout` are. New
  `loader/global-scope-durable-object` (passes at HEAD too) pins that a
  Durable Object's constructor and a Dynamic Worker facet's may set a
  timer, draw random values and make and read bodies. Found:
  `loader/global-scope-io-node-frames` and `loader/global-scope-ops-gaps`
  (xfail, 1.67). Unit test
  `js::global_scope_ops_tests::every_listed_op_is_installed`.
- **Deployed Workers.** Loading the seven starter configs (all at 2026-09-04)
  under `celld dev --no-build` behind a probe Worker that fetches each
  through a service binding, as 1.38 did, starts all seven (router, context,
  custom gatekeeper and error reporter answer 200, the workshop 404, the
  scheduler and websearch "does not export a fetch() function"), so none
  does any of these at module scope. Cloudflare OS's Dynamic Workers' own
  module scope (the code-mode harness, the restore forger) only imports and
  declares classes; the gadgets' and the agent's code is the user's, held to
  workerd's rules as on Cloudflare, and the bundled blueprints' servers
  (workspace docs, sheets, slides) do none of these at module scope.
- Docs: `docs/cloudflare-compat.md` (`cloudflare:workers`, Web Crypto, Web
  standards, Performance and timers), `docs/limitations.md`,
  `docs/services/dynamic-workers.md`.
- Cost: (lab, `ab -n 20000 -c 16` at 2026-09-04, medians of 9
  interleaved rounds against 4c055c2, three runs that failed to start or
  stalled left out): hello world 18624 → 18656 req/s (+0.2%, ranges
  18421-19359 against 18032-18921); a request that sets and clears a timer,
  clears it again, draws a UUID and random values, reads a Blob's stream
  through a Response and answers with a string body 18182 → 18177 (0.0%,
  17469-18500 against 17884-18414). The hot path gains a slot read on the
  timer and random ops, and an op call for a Response or Request made with
  a body that is not a stream, a stream body read, a clear of an unknown
  timer, `Blob.stream()` and the rarer constructors above.
- Found: 1.67.

### 1.40 Runtime API error messages (found by 1.18)

**Problem.** Some of celld's runtime APIs throw with other messages than
workerd's. At a Dynamic Worker's module scope (`loader/startup-errors-api-text`):

| Call | workerd | celld |
| --- | --- | --- |
| `new URL("bad")` | `TypeError: Invalid URL string.` | `TypeError: Invalid URL: relative URL without a base` |
| `atob("@@")` | `DOMException(InvalidCharacterError): atob() called with invalid base64-encoded data. (Only whitespace, '+', '/', alphanumeric ASCII, and up to two terminal '=' signs when the input data length is divisible by 4 are allowed.)` | `DOMException(InvalidCharacterError): Invalid base64` |
| `new Headers([["a"]])` | `TypeError: To initialize a Headers object from a sequence, each inner sequence must have exactly two elements.` | `TypeError: Headers init entry must be a 2-tuple` |
| `new TextDecoder("bogus")` | `RangeError: "bogus" is not a valid encoding.` | `RangeError: The encoding label 'bogus' is invalid.` |

**Design.** Use workerd's texts; survey the other polyfills' errors
against workerd's source.

**Tests.** `loader/startup-errors-api-text` loses its `xfail`.

### 1.19 Trace context across DO RPC calls (found by 1.2)

**Problem.** `op_rpc_call` and `RpcCallReq` carry no parent trace context,
so a DO RPC event starts a new trace. Cloudflare OS's chat turns cross DO
RPC, so their spans split across traces.

**Design.** Thread the caller's trace context through `RpcCallReq` →
`dispatch_rpc_call` → `CellJob::Rpc` and the peer tunnel, as DO `fetch()`
already does.

**Tests.** Update the `tracing/otlp-export` transcript, which pins the new
root today.

**As built.**
- **What arrived before.** Every RPC path that crosses an isolate was
  checked. DO stub RPC (`__rpc_call`) started a new root, on one node and
  across nodes. Service-binding RPC to another script's entrypoint
  (`__svc_rpc`) did too. A loaded Worker (Worker Loader) was never traced,
  for `fetch()` or RPC: its drive had no telemetry, so its spans were
  dropped and `isTraced` was `false`. Facet RPC (`__facet_rpc`) already
  joined the caller's trace. Same-isolate calls (`ctx.exports` entrypoints
  served in the caller's isolate) cross no isolate and keep the caller's
  context already.
- **Design.** The host reads the caller's context from CPED at the call
  site, as `__do_call` does, and carries it as `parent`: on `RpcCallReq` →
  `dispatch_rpc_call` → `RuntimeManager::rpc` → `drive_cell`, on
  `SvcRpcReq` → `rpc_service` → `WorkerJob::Rpc`, and on the loader's
  `WorkerJob::Rpc`. A stateless drive joins a `WorkerJob::Rpc`'s parent with
  `child_of`, as a cell event does, so the caller's sampling decision
  stands. A loaded Worker's drive gets `telemetry::identity()` (node and
  region, `Some` only while telemetry is on), so its invocations, `fetch()`
  included, are traced like a service target's.
- **Unsampled requests.** A root the sampler rejected used to have no
  context at all, so its callees decided afresh: under a ratio of 0.1, about
  one callee in ten of an unsampled request exported an orphan root. With
  telemetry on, `start_trace` now always answers a context, with `sampled`
  clear when rejected, so the rider is installed and every path (DO fetch
  and RPC, entrypoint, loader and facet RPC, outbound `fetch()`, the tunnel)
  carries the decision. The cost is one rider per turn for an unsampled
  request while telemetry is on. The runner can't set the sampler, and a
  callee's fresh decision is random, so a unit test pins it
  (`telemetry::tests::an_unsampled_root_propagates_its_decision`).
- **Cross-node.** The plan assumed DO `fetch()` already crossed nodes with
  its context. It didn't: the peer tunnel carried none, for fetch or RPC.
  The tunnel now has an `x-cells-traceparent` control header, written by
  node A from the host's context, for both kinds. It is in
  `CONTROL_HEADERS`, so an application header of that name is dropped in
  both directions, as the other control headers are.
- **Tunnel version 6.** An older peer would pass the new header to the
  application, so `TUNNEL_VERSION` is 6 and versions 5 and 6 refuse each
  other. Deployments are fresh, so there is no multi-version acceptance; a
  rolling update to this release is impossible, and `docs/README.md`
  "Upgrade notes" says to stop every node first. A node that dials a peer on
  the other version fails that call at once (`TunnelVersionMismatch`,
  classified ambiguous, so no retry) and logs
  `peer_tunnel_version_mismatch` once per peer and version, with both
  versions. Its 426 now carries its own version; a version-5 peer reports
  none, which the log names as "5 or older".
- **Remote parents.** `TraceContext` has a `remote` flag, set only for a
  context that arrived from another process (the tunnel header, or an
  ingress `traceparent`). A cell span's `celld.parent_remote` is now `true`
  under a parent on another node; it was always `false`.
- **Trust.** The context comes from the host at the call site, never from
  the caller's arguments or headers, so a caller can only make the callee a
  child of its own current span. A service-binding `fetch()` already lets a
  caller name any trace through a `traceparent` header, so RPC adds nothing
  a caller could not do before. Tunnel headers come from authenticated
  peers. No context reaches JS in the callee, but a callee's outbound
  `fetch()` sends a `traceparent` with the caller's trace id, a loaded
  Worker's included. That is kept: a W3C trace id is a correlation
  identifier, not a secret, and the caller's own outbound `fetch()` sends it
  too.
- **Not changed.** A service-binding `fetch()` and a loaded Worker's
  `fetch()` still carry no host context: their targets join a trace only
  through a `traceparent` header the caller sends, as before.
- **Tests.**
  - `tracing/otlp-export`: `/object` now shows `celld.rpc` under
    `around-call`.
  - New `tracing/rpc-context` (celld-only, two workers): service-binding
    RPC, loader RPC and facet RPC (from a DO RPC event), each inside a
    custom span, each callee's invocation span a child of it; a same-isolate
    `ctx.exports` call, whose span nests directly; and a loaded Worker's
    `fetch()`, traced (`isTraced` true), a root of its own without a header
    and a remote child of an application-set `traceparent`.
  - Unit (`peer_tunnel::tests`): node A writes the context into fetch and
    RPC inner requests as a remote parent and drops an application's copy;
    node B strips it from the application's headers and hands it to the
    `ForwardedFetch` and `ForwardedRpc` it dispatches; a malformed value is
    ignored. The conformance runner can't run two nodes, so cross-node is
    covered here only. `telemetry::tests` pin the unsampled decision.
  - Docs: `docs/telemetry.md`, `docs/README.md` (upgrade note).

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

**As built.**
- **What workerd does** (probed, and read in `api/http.c++`:
  `fetchImplNoOutputLock`, `handleHttpResponse`,
  `handleHttpRedirectResponse`). Every Fetcher follows through itself: the
  redirected request goes back to the same Fetcher, global `fetch()`'s
  network included. So a relative `Location` from a binding resolves
  against the binding's URL, and an absolute one to another host goes back
  to the same target, never to the network.
  - `redirect` is parsed in the Request constructor, ignoring ASCII case.
    `"error"` and every other value throw that `TypeError` there, so
    `fetch()` and `Fetcher.fetch()` reject before anything leaves.
  - Statuses 301, 302, 303, 307 and 308 with a `Location` are followed;
    without one the response comes back as it is. 301 and 302 turn only a
    `POST` into a `GET`; 303 turns everything but `HEAD` into a `GET`. The
    body is dropped then, and every header stays, `Content-Type` and
    `Content-Length` included. Other cases send the body again.
  - On a hop to another origin only `Authorization` is dropped
    (`strip_authorization_on_cross_origin_redirect`). `Cookie` and
    `Proxy-Authorization` stay.
  - At most 20 redirects. The 21st rejects with `TypeError: Too many
    redirects.` followed directly by the URL list joined with `", "`
    (`JSG_KJ_EXCEPTION` appends it). A loop gives the same error.
  - A body that can't be replayed (a stream, including the body of a
    request the Worker received, however small) fails on any status but
    303 with workerd's "one-time-use body" `TypeError`, even for a 301
    `POST` that would drop it.
  - A `Location` that doesn't parse: `TypeError: Invalid Location header;
    unable to follow redirect.`
  - `response.url` is the last URL without its fragment, and `redirected`
    is `true` once a redirect was followed. A Fetcher sends no fragment.
  - A WebSocket upgrade request follows too.
- **Design.** One harness helper, `__fetchThrough(req, send)`, implements
  those rules for every Fetcher. `send` makes one request and never
  follows: global `fetch()`, a service binding (and so `ctx.exports`), a
  Durable Object stub, a Worker Loader entrypoint, a facet, the `ASSETS`
  binding and a container's `getTcpPort()`. A loaded Worker's
  `globalOutbound` Fetcher is reached through global `fetch()`, so its hops
  go back to it. The old service-binding path, which followed through
  global `fetch()`, is removed.
  - The helper changes only the request its own `fetch()` made: it drops
    the fragment by setting that request's URL, so a byte body stays
    replayable. Each hop keeps the method, body, headers, signal and `cf`
    the rules leave it.
  - It reads the headers only once a redirect needs them. No `send` changes
    the caller's headers: a service binding puts its stream-framing header
    on the target's copy only.
  - It uses intrinsics captured before any Worker code runs (`Request`,
    `Headers`, `URL` and their methods, `ReadableStream#cancel`, the string
    methods), so a Worker that replaces a global can't change how a
    redirect is followed, as it can't on workerd, whose fetch is native.
- **Host.** The outbound client never follows (`public_egress::client`
  hard-codes `Policy::none()`), and `op_fetch` lost its redirect-mode
  argument. The three clients per mode, the request-scoped
  redirect-counting client and `public_egress::follow` are gone: each hop is
  an `op_fetch` of its own, so it is checked by the egress policy in full
  and charged as a subrequest.
  - **Subrequests.** Before, only a followed redirect of a plain `fetch()`
    was charged. A WebSocket dial was never charged, neither `new
    WebSocket()` nor a `fetch()` upgrade, so one upgrade could make 21
    uncounted dials. `op_ws_connect` and `op_ws_upgrade` now charge every
    dial, and so every hop of an upgrade.
  - **Timeout.** `CELLD_FETCH_TIMEOUT_S` bounds one whole `fetch()`, as it
    did when the HTTP client followed. The first hop's answer carries its
    deadline on a monotonic clock, and each later hop gets what is left,
    never more than one timeout (`celld --help` says so).
- **Security.** A redirect from global `fetch()` to a private address or the
  internal listener was already refused at every hop (`reqwest`'s policy
  ran `public_egress::follow`). It still is, now because every hop is a new
  checked request: `fetch-public/redirect-to-private`, and a redirect to the
  internal listener added to `fetch-public/internal-listener`. Following
  through a Fetcher reaches only that Fetcher's own target, so it gives a
  Worker nothing it couldn't reach directly. A container's redirect now
  goes back to the container's port instead of out to the network.
- **Incoming bodies.** A request the Worker received is marked as having a
  one-time body (`_oneTimeBody`, kept by copies that adopt the body), since
  celld may hold it as bytes where workerd has a stream.
- **Differences kept.** The redirect response's body is cancelled, not read
  to its end as workerd does, so a cross-isolate stream is released at
  once. Nothing observable depends on it.
- **Tests.**
  - `fetch/redirect-mode` (differential): modes, case, `"error"`, other
    values, from a Request, a Request as the init, and `fetch()` rejecting.
  - `service-bindings/redirect-follow` (differential): a relative and an
    absolute `Location`, `manual`, a 307 `POST` and a streamed 307 through
    every Fetcher kind (service binding, named entrypoint, self binding,
    `ctx.exports`, Durable Object, facet, loader); then, through one
    binding, the status-and-method matrix, same- and cross-origin
    credentials (a scheme change included), fragments (a `POST` 307 and a
    `PUT` 301 to a URL with one), no `Location`, 20 and 21 redirects, a
    loop, streamed 301 and 303, an invalid `Location` and `redirect:
    "error"`; `cf` on every hop through `ctx.exports`; a redirect followed
    while the Worker has replaced `Request`, `URL` and `Headers#get`; and a
    received
    request forwarded with `follow` (307 fails, 303 follows).
  - `fetch/redirect-follow` (celld-only, against the runner's upstream):
    the same rules for global `fetch()`, and a WebSocket upgrade. wrangler's
    harness follows every global `fetch()` redirect in Node, so the
    transcript is recorded from workerd run directly, by
    `lib/workerd-direct.mjs` with the case's `workerd.capnp` (a network
    service as `globalOutbound`).
  - `fetch/assets-redirect` (differential): `ASSETS.fetch()` follows
    html_handling's 307.
  - `limits/redirect-subrequests` (celld-only): a loaded Worker limited to
    3 subrequests follows a 2-redirect chain but not a 3-redirect one, by
    `fetch()` and by a WebSocket upgrade, and can't dial `new WebSocket()`
    once redirects spent its budget.
  - `containers/redirect` (celld-only, Docker): an absolute `Location` to
    another host goes back to the same container port.
  - The runner's upstream gained `/echo`, `/chain`, `/loop`, a status on
    `/redirect`, and redirects of a WebSocket upgrade.
  - Unit: `public_egress::tests` checks the container exemption per request
    instead of per redirect hop.
  - Starter: the integration adapter's "reports the final URL of a followed
    redirect" check, `it.fails` until now, is an `it`.
- **Found.** A byte body, and a request's `cf`, reach a Fetcher's target
  in another isolate without what workerd gives it: 1.41.

### 1.41 What a Fetcher's request carries to its target (found by 1.20)

- **`Content-Length`.** A request with a byte body (`"payload"`, or `""`)
  reaches the target of a service binding, `ctx.exports`, a Durable Object
  stub or a Worker Loader entrypoint with no `Content-Length` header.
  workerd gives it `Content-Length: 7` (or `0`), as HTTP would. celld adds
  the header only for a stream body. Pinned by
  `service-bindings/body-length` (xfail).
- **`cf`.** A request's `cf` reaches a target in another isolate (another
  script's service binding, a Durable Object, a loaded Worker) as `{}`:
  `__svc_call`, `__do_call` and `__loader_fetch` carry none, and neither
  does the peer tunnel. workerd delivers it, on every hop of a redirect
  too. A target in the caller's isolate gets it. Pinned by
  `service-bindings/request-cf` (xfail).

### 1.21 WebSocket ids carry authority (found by 1.7) — security, next after 1.7

**Problem.** WebSocket ownership is decided by values that JS can set:
- writable properties on WebSocket objects (`_id`, `_peer`, `_target`,
  `_boundTarget`, and the other `_x` state);
- the `WebSocket` constructor treating a numeric argument as an internal id
  (workerd treats it as a URL);
- `Response`'s `__wsTarget` init option and the `_wsTarget`, `tunnel` and
  `server._id` values `__readResponse` trusts;
- a writable `_scope` on DO `ctx`, which reaches `__ws_list`, accept and the
  auto-response ops in a process-wide registry.

The host ops in `js/websocket.rs` check no ownership. So a Worker, including
a Dynamic Worker running model-written code, can reach sockets owned by
other requests, cells and scripts.

**Design.**
- **Host owner map.** `WsRegistry` maps each socket id to its owner
  (`Request(handoff_request)` or `Cell(scope)`), taken from the running
  event, as workerd's actor-wide IoContext does.
- **Allocation.** Ids are allocated only inside the ops that register them
  (no free `__ws_alloc`). Every op checks the owner and refuses otherwise
  with workerd's cross-request I/O error. Ops that took a cell string from
  JS use the running event's cell.
- **Grants.** A Cell target handed to JS by `encode_http_response` becomes a
  grant to the caller, released at retire. `__ws_bind_target` and
  `read_response` accept only granted targets.
- **Harness.** All socket state moves to private fields. The numeric
  constructor path and the public `__wsTarget` init are removed. Primordials
  are captured on these paths.

**Tests.** Isolation tests that expect refusals: cross-request, cross-cell,
cross-script, Dynamic Worker vs parent, hibernatable sockets. Plus unit
tests for each op's ownership check, and regression coverage of the
legitimate cross-event uses.

**Part 1 (host owner map): done.** As built:
- Ids are allocated only by the registering ops; `__ws_alloc` is gone.
  `connect`/`upgrade` return `{id, ready}`. Pair ends have id 0 until
  registered.
- Every op checks the owner. An unknown id behaves as before (an unknown
  non-zero id passed to accept is "WebSocket is not valid"); another owner's
  socket gets the cross-request error.
- connect, upgrade, bind, list, accept and the auto-response ops route by the
  running event, never by a cell string from JS.
- The owner entry lives until the last registration (the input queue) goes.
  A `WsDialGuard` travels with each dial request, so an unrun dial leaks
  nothing.
- Cases: `websocket/socket-ids` (differential), `socket-ids-dial` and
  `cross-request-socket` (celld-only).

**Part 2 (harness and grants): done.** As built:
- All socket state is in a private field, reached through one accessor that
  is also the brand check. Primordials are captured. `WebSocket` is
  non-extensible. Internal objects are null-prototype, and host results are
  read as own properties.
- The constructor only dials. Internal sockets come from `__wsCreate`.
  `__wsTarget` is gone from `Response`, and `init.webSocket` is
  brand-checked.
- DO targets handed to JS become grants to the caller's owner. Each grant
  is consumed once, with at most 64 per owner and a 30 s expiry, and is
  never made for a retired caller. `admit_target` checks them in
  `op_ws_bind_target` and `read_response`.
- Socket objects carry a cached numeric owner token, checked first, so
  use from another request throws the cross-request error even after that
  request ended. Pair ends link in the isolate only while both are
  unregistered, unreturned and owned by the running owner. A returned
  socket can't be accepted again (workerd's text).
- A DO `ctx` used during another object's event acts on the running object
  and throws only on I/O to the other object's socket, as workerd does
  (`websocket/cross-object-socket`).
- Cases: `cross-script-socket`, `dynamic-worker-socket`, `forged-target`,
  `ended-request-socket`, `cross-object-socket`, `returned-pair`
  (differential), and `forged-response-target` (celld-only). Host refusals
  are unit-tested through V8.
- Follow-up: some Rust test modules may touch the WebSocket registry before
  the shared test runtime is installed (a race fixed in `js/websocket.rs`).
  Audit the others.
- A Dynamic Worker's TypeError arrives in the parent as a plain Error (error
  class lost across isolates). Check this against workerd under Phase 3.

### 1.22 WebSocket follow-ups (found by 1.7)

- A stateless Worker that `accept()`s a DO socket from `stub.fetch`
  (`op_ws_bind_target`) has it closed when its request retires. It needs the
  `waitUntil` pump that 1.7 added for handoffs.
- `worker_websocket_task` drops the socket right after `send_close`, losing
  frames still queued. Wait for `drained()`.
- The Response constructor checks no status range except 101.
- `close()` before `accept()` on a handoff socket is never sent.
- The `globalOutbound` broker path for a 101 is untested.
- A server-end socket that a Worker or Durable Object closes first is
  CLOSED at once, and its close event never fires: the host stops reading
  at the application's Close. workerd keeps it CLOSING until the peer's
  reply and then fires the event (`websocket/server-close-event`, found by
  1.17).
- A half-open socket ends when the peer shuts down its side of the
  connection (FIN) while still reading; workerd keeps it until it writes
  (`websocket/half-open-shutdown`, found by 1.17). celld cannot tell that
  from a peer that went away without writing; a write probe could.
- ~~A failed `new WebSocket(url)` dial fires `error` but never `close`~~:
  fixed in 1.9.
- Outbound frame channels (`outputs`) and the pre-upgrade `WsMeta.pending`
  buffer are unbounded for every socket. Add a per-socket byte budget with
  backpressure (a `bufferedAmount` model) or a close on overflow (1009/1011),
  and make the 1.7 bridge propagate its pull-queue backpressure into it.

**As built (done).**
- **Outgoing frames are bounded.** workerd queues whatever a Worker sends:
  `send()` never waits or throws, there is no `bufferedAmount`, and every
  message arrives once a slow client reads (`websocket/send-buffering`).
  celld keeps that below a per-socket bound and closes past it:
  - Each socket's channel comes from `ws_out_channel()`, bounded to
    `WS_OUT_QUEUE_MAX_BYTES`, 32 MiB. It is a documented constant, as the
    1 MiB pull-queue budget is. One message enters an empty queue whatever
    its size, so a message up to Cloudflare's 32 MiB limit always leaves,
    and a Close always enters.
  - **Decision:** close on overflow, since `send()` cannot wait. The queued
    frames are discarded, and the peer gets a Close with 1011 and celld's
    reason. The application sees an `error` event and then a close event
    with 1006 and the same reason. What it sends after that is dropped with
    one warning in all.
  - A write already under way when the queue overflows gets 1 s
    (`WS_OUT_OVERFLOW_GRACE`). After that the connection is dropped, so a
    peer that never reads holds no task.
  - `WsMeta.pending` has the same bound. A socket whose buffer overflowed
    before its channel registered closes as soon as one does.
  - **Per isolate too.** The per-socket bound alone let one Durable Object
    hold 1.3 GB in 40 sockets (review). Waiting frames, queued or pending,
    are now charged to the sending isolate's backing-store budget (1.33),
    through a `WsBudget` that every sending op records again on its socket,
    so after an eviction, a generation swap or a redeploy the new isolate
    pays for what it sends (re-review N2). Each frame carries the budget it
    was charged to, in the channel and in `WsMeta.pending`, and a pending
    frame moves into the channel with its charge rather than taking a
    second one (N3). The charge goes back once the frame is written, not
    when the writer takes it, so a write that never finishes stays counted
    (N1).
    **Decision:** a frame the budget cannot hold closes its socket (1011
    with its own reason, 1006 to the application), as the per-socket
    overflow does. The charge is taken before the frame queues, within the
    budget, as the allocator charges V8's allocations, so it is refused
    rather than held and never condemns the isolate. That follows 1.35's
    rule that only memory actually held past the budget condemns. A refusal
    in `send()` was not an option, since workerd never throws there.
  - A Durable Object holds at most 32,768 hibernatable sockets
    (`WS_HIBERNATABLE_PER_OBJECT`, Cloudflare's documented limit; workerd
    has none, so the error text is celld's). A facet's sockets count
    against its root: Cloudflare documents the limit per Durable Object
    and says nothing of facets.
  - **A write that never finishes** (a peer that does not read) is
    abandoned with its connection 1 s (`WS_OUT_ABANDON_GRACE`) after the
    socket's owner lets go of it, as after an overflow. While the owner
    lives it stays charged, so the budget bounds it, and there is no
    no-progress timeout, since workerd has none. The half-open socket with
    a full window follows the same rules. Before this, a stateless Worker
    that sent 30 MiB on each of three sockets to a server that never read,
    five times, left 15 connections and 533 MiB 60 s later. A peer with a
    zero window therefore holds its socket while the owner lives, by
    design, bounded by the budget (final review, F5 and F6).
  - **Auto-responses wait for the peer (final review F1).** A reply the
    host makes itself, from `setWebSocketAutoResponse`, was charged to no
    budget, since a hibernatable socket whose JavaScript sent nothing has
    none: 20 clients sending 16,000 requests each took the node from 51 to
    668 MiB in 8 s. workerd's `LegacyHibernationManagerImpl::readLoop`
    `co_await`s each auto-response's write (`maybeWriteBarrier`) before it
    receives the next message. celld now waits after an auto-response
    while the socket's queue holds more than `WS_REPLY_BACKLOG_MAX_BYTES`
    (1 MiB) and reads no further meanwhile (`ws_await_backlog`), so a burst
    of replies still shares the connection. **Decision:** only host-made
    replies pause reading. A Pong already does, since the reader writes it
    before it reads on, and the Close reply is the last frame. The
    application's own messages do not, as in workerd: a client that sends
    before it reads would otherwise deadlock against them.
  - The half-open probe's Ping gives up 1 s after the owner lets go, as an
    application write does (F3). Before, a Ping blocked by a zero window
    hid the owner's going.
  - In the 1.7 bridge and the `stub.fetch` pipe, each direction waits for
    room in the receiving 1 MiB pull queue. Meanwhile the sending side's own
    channel fills, so a reader that never reads makes the sender close
    abnormally once that channel passes its bound, and the reader gets the
    overflow's Close.
  - Not bounded here: frames held behind an output gate
    (`WsFlushState`) or captured during a handler's turn. They wait only
    until the gate answers or the turn ends.
- **A `stub.fetch` socket that a stateless request accepted** registers its
  pump as `waitUntil`, as a handed-over socket does, so the request lives
  while the socket is open.
- **`worker_websocket_task` waits for `drained()`** (at most 10 s) before it
  releases the socket's queue. The messages and the Close still queued for
  the Worker are no longer lost. A connection that ends without a Close now
  reports kj's reason, `WebSocket disconnected without sending Close
  frame.`, as workerd does (`websocket/client-drop`).
- **Before `accept()`.** In workerd, a socket that a pair or a response made
  reads OPEN until it closes, even before `accept()`, and `send()` and
  `close()` on it throw `You must call one of accept() or
  state.acceptWebSocket() on this WebSocket before sending messages.` celld
  read CONNECTING, queued such a `close()` and never sent it, and dropped
  such a `send()`. It now matches (`websocket/before-accept`).
- **Response status.** The status converts as a WebIDL `long`: a value that
  is not a finite number is 0, a fraction truncates, and a value outside 32
  bits throws workerd's TypeError. Without a WebSocket the range is 200-599,
  and with one the status must be 101, each with workerd's RangeError text
  (`builtins/response-status`). A network response keeps the status the
  origin sent.
- **An end that closes first is CLOSING until its peer's reply, and its
  close event carries that reply**, as in workerd. The pump goes on reading
  after the application's Close: frames the peer still sends are delivered,
  and the peer's Close becomes the close state. A connection that ends first
  gives 1006. The pipe hands the caller's reply to the object, waiting at
  most 10 s, and the bridge already carried it. Reading the transport ends
  the wait when the peer goes away. **Decision (from the review):** the
  socket task's wait for the reply also ends when the owner lets go of the
  socket (its last sender goes, as when a stateless request retires), and
  after `WORKER_BRIDGE_CLOSE_TIMEOUT` (10 s) at most, as the bridge's and the
  pipe's do. Without that, a stateless Worker that dialed a silent server,
  closed and returned kept the connection: five were still open 70 s later.
  workerd ends them with the IoContext, and has no bound for a Durable
  Object. The reader no longer answers a Ping after the application's
  Close.
  `websocket/server-close-event` loses its xfail, and
  `websocket/close-first-reply` covers each kind of end: a stateless
  Worker's, a hibernatable one, both ends of a handed-over socket, and both
  ends of a `stub.fetch` socket.
- **Half-open sockets survive a peer's FIN.** While waiting for the
  application's reply, a socket whose peer shut down its side keeps waiting,
  as workerd does. It sends a Ping every `HALF_OPEN_PROBE_INTERVAL` (1 s). A
  peer that closed its socket outright also sent a FIN, but it answers the
  Ping with a reset, so the next Ping fails and the wait ends within about
  2 s. The 1.17 leak does not come back. The review found that the probe
  waited for the writer's lock in a select branch while the application's
  write, suspended mid-frame, held it, so the task, its fd and the object's
  residency leaked. The probe now skips a tick while a write is under way,
  which a reset fails on its own. A connection that fails still gets
  `REPLY_AFTER_PEER_LEFT`. `websocket/half-open-shutdown` loses its xfail.
  `websocket/half-open-disconnect`, which pinned the old divergence, is
  gone. Host tests on a loopback TCP connection cover both peers.
- **`globalOutbound` and a 101.** A Dynamic Worker's `fetch()` upgrade
  through a `globalOutbound` Fetcher was refused ("cannot broker
  WebSockets"). It now goes to the Fetcher as an ordinary request
  (`__ws_upgrade` answers null for a broker), and the Fetcher's 101 carries
  the socket back, to pass on or to `accept()`. A service-binding or broker
  target that answers a plain request with a WebSocket now fails with
  workerd's TypeError, which it used to pass through
  (`loader/global-outbound-websocket`). `new WebSocket()` through a broker
  is still refused (1.42).
- **Runner.** Raw `ws` steps gained `"stall"` (read nothing for a while),
  `"record"` (`"count"` or `"none"`), `"drop"` (end without a Close) and
  `"reset"` (reset the connection a while after the Close). A raw client
  answers a Close the server sends first, and does not answer a Ping after
  it shut down its side. Celld-only `rss` and `sockets` steps check how far
  the node's peak memory and its open sockets grew from a baseline. The
  upstream gained `/ws/silent`. All of these are documented in the README.
- **Cases.** New differential cases: `websocket/send-buffering`,
  `websocket/before-accept`, `websocket/close-first-reply`,
  `websocket/client-drop`, `builtins/response-status` and
  `loader/global-outbound-websocket`. New celld-only case:
  `websocket/send-queue-overflow`. It floods 100 MB at a client that does
  not read, from a stateless Worker, from a Durable Object, and into a
  handed-over socket nothing has accepted yet. It checks each end's close
  and that the node's peak memory grows by at most 192 MiB (about 60 MiB
  measured locally, 131 MiB on CI; the 1011 closes in the transcript pin the
  bound). Celld-only cases from the review: `websocket/send-budget`
  (40 sockets × 31 MiB, peak memory growth at most 640 MiB: 195 MiB measured
  locally, 323 MiB on CI, 1257 MiB without the budget),
  `websocket/close-first-silent-peer` (a stateless Worker and a
  Durable Object dial a silent server, close and return, and the node's
  sockets come back to the baseline), and `websocket/half-open-reset` (a
  client Closes, shuts down, stops reading, and resets while 48 MiB is on
  its way; the node lets the connection go). `websocket/before-accept-fetched`
  records the network `fetch()` upgrade's socket from workerd run directly.
  `websocket/blocked-write-owner` (from the re-review) has a stateless
  Worker send 30 MiB on each of three sockets to a server that never reads,
  three times: each time the connections go within 5 s, and no later socket
  closes for the budget. The `sockets` step counts only the node's
  connections to the case's ports (the upstream's and the raw clients'), and
  takes a `within`; `close-first-silent-peer`'s stateless part allows 3 s,
  so it fails when owner release is broken (checked), and the object's part
  15 s. It also counts sockets opened since its baseline that no
  `/proc/<pid>/net` table lists: a reset removes a connection from the TCP
  table while a leaked fd stays open, so `half-open-reset` passed with the
  H1 leak until then (F2); it fails with the leak restored now (checked).
  `blocked-write-owner` checks peak memory against 200 MiB (119 MiB
  measured; an N1 regression is about 290). `websocket/auto-response-backlog`
  (F1): two clients send 100,000 auto-response requests each and never
  read; peak memory grows by at most 64 MiB. Without the wait, each socket
  queued past its 32 MiB bound and closed, which the transcript catches.
  The raw `ws` step gained `"repeat"`.
  New xfails for 1.42: `builtins/response-null-body`,
  `websocket/stateless-event-io`, `loader/global-outbound-websocket-dial`
  and `websocket/error-after-close`. At the previous commit, every new case fails except
  `websocket/send-buffering`, which pins what both runtimes do below the
  bound, and the four xfails still fail. `client-drop` lost six of its
  eight messages, which `socket is not registered` replaced.
  `close-first-reply` timed out on the relayed `stub.fetch` socket. The
  overflow case's parked socket hung. The review's three cases fail on the
  first version of this change: 3 and 4 sockets kept, 1 socket kept, and
  1257 MiB of growth. `blocked-write-owner` fails on the second version
  (3, 6 and 9 connections kept). The whole corpus: 123 PASS and 13 XFAIL (was 109 and
  11).
- **Unit tests.** The channel's budget, a Close entering a full queue, the
  pending buffer's bound, the bridge's overflow, charges given back as
  frames leave or a receiver goes, a pending frame the budget refuses, the
  watch on the owner, the hibernatable cap, a Ping blocked by a zero window
  giving up once the owner goes (fails without the fix), the reply after the
  application's Close, a peer leaving instead, the owner letting go, an
  overflow abandoning a blocked write, the two half-open peers on TCP, and
  a reset during a blocked write (which hangs with the old probe).
- **Review repros** (the reviewer's scripts, before and after):
  - Half-open, 20 MiB sent late, client resets: the node held 8 sockets
    40 s later, against 7 before the client came; now 7.
  - Five dial, close and return requests against a silent server: 12
    sockets and 5 open server connections 70 s later; now 7 and 0.
  - 40 hibernatable sockets × 31 MiB: RSS from 55 to 1311 MiB; now 56 to
    207 MiB.
  - Five requests, each sending 30 MiB on three sockets to a server that
    never reads: 22 node sockets (15 connections) and 533 MiB 60 s later;
    now 7 node sockets and 50 MiB (the script still counts 4 of its
    own server sockets open: they are paused, so they never read the FIN).
  - 20 clients × 16,000 auto-response requests, never reading: RSS 50
    (51) → 668 MiB before; now 51 → 83 MiB.
  - The same 40 sockets with idle eviction at 2 s: 194 MiB before and 196
    MiB after; the isolate was the same throughout, since the sockets kept
    the object resident, so this run does not exercise N2, which the unit
    test `each_frame_is_charged_to_the_isolate_that_sent_it_last` covers.
- **Docs.** `docs/cloudflare-compat.md` describes the close-first wait, the
  half-open probe, the bounds with their codes and reasons, the hibernatable
  cap and the `globalOutbound` upgrade. `docs/limitations.md` lists the
  bounds.

### 1.42 Follow-ups found by 1.22

- **Null body status and `statusText`.** workerd refuses a body with status
  101, 204, 205 or 304 unless it is empty: `Response with null body status
  (101, 204, 205, or 304) cannot have a body.` It treats an empty one as
  null, and refuses a control character in `statusText` (`Invalid
  statusText`). celld accepts both. Responses that celld builds from the
  network and from other isolates must first get a null body for those
  statuses, as workerd builds them, or the check would refuse them. Pinned
  by `builtins/response-null-body` (xfail).
- **Socket events of a stateless Worker after its response.** A message or
  close event that calls a Durable Object (or does other I/O) after the
  response has gone never gets an answer in celld: the call goes out, but
  the request has retired. workerd keeps the request while its socket is
  open. Pinned by `websocket/stateless-event-io` (xfail).
- **`new WebSocket()` through a `globalOutbound` Fetcher.** workerd sends
  the upgrade to the Fetcher. celld refuses the dial, and a `fetch()`
  upgrade reaches it (1.22). Pinned by
  `loader/global-outbound-websocket-dial` (xfail).
- **An `error` event after a clean close.** Under wrangler, workerd fires
  `error` with "Network connection lost." after the close event of a
  socket whose client closed cleanly. celld fires none. Find out whether
  wrangler's proxy in front of workerd causes it: `lib/workerd-direct.mjs`
  needs `ws` steps for that. Pinned by `websocket/error-after-close`
  (xfail).

### 1.23 `Response.clone()` on fetched bodies (found by 0.5)

`clone()` on a fetched Response throws "Cannot clone a streaming response
before consumption", and clones lose `url` and `redirected`. workerd tees the
body and keeps both. The adapter self-test's `it.fails` pins it.

**As built.**
- **What workerd does** (probed, and read in `api/http.c++`:
  `Response::clone`, `Request::clone`, `Body::clone`). `clone()` tees the
  body: the original keeps one branch and the clone gets the other. The
  clone has a copy of the headers with their guard, so a fetched
  Response's clone has immutable headers too, a deep copy of `cf`, and the
  status, statusText, type and URL list, so `url` and `redirected`.
  - A Response with a WebSocket: `TypeError: Cannot clone a response to a
    WebSocket handshake.`
  - A body a body method has read, or one locked to a reader: `TypeError:
    This ReadableStream is currently locked to a reader,` (the comma is
    workerd's). There is no `bodyUsed` check of its own.
  - After a partial read the clone has the rest, and both bodies are
    unused again (fresh branches). After a `cancel()` the clone succeeds
    with an empty, unused body.
  - `bodyUsed` is the stream's disturbed flag, and false for a null body.
    A body that is closed and was never read reads as empty and stays
    unused, as a tee branch of a finished stream does.
  - A Request clone shares the signal the request was made with; without
    one, as for a request the Worker received, it has its own.
  - A tee's slower branch holds what it has not read. workerd run locally
    has no limit; Cloudflare's buffering limit ends both branches with
    `TypeError: ReadableStream.tee() buffer limit exceeded. This error
    usually occurs when …` (kj's "tee buffer size limit exceeded", as
    `api/util.c++` translates it).
- **JS** (`harness.js`). `Response.clone()` and `Request.clone()` share
  `__cloneBody`: an untouched buffered body is copied, anything else is
  teed. The Response clone is built through the network-response path, so
  the constructor's status checks don't apply (`Response.error()`), and
  then gets the original's `type`, `url` and `redirected`. Headers
  are copied from the header list, not the iterator, and keep
  `_immutable`. `bodyUsed` became a getter over an internal flag (set by
  body methods and by a subrequest that takes the body over) and the
  stream's disturbed flag. The old "Body has already been consumed" and
  "Cannot clone a streaming response before consumption" texts are gone.
- **Responses that had the wrong properties to begin with**, which the
  clone then copied. A Durable Object stub's Response had mutable headers
  and no statusText, and a global `fetch()`'s had mutable headers. Both now
  have immutable headers, and the stub's gets the reason phrase, as a
  service binding's does.
- **A host stream's tee no longer stalls** (`http_streams.rs`). Each branch
  had a 16-chunk channel and the pump waited for the slower one, so reading
  one branch of a clone to its end before the other hung once the body
  passed 16 chunks. The pump now reads as fast as the faster branch reads,
  and holds the slower branch's chunks beyond its channel. They are
  charged to the isolate's backing-store budget (`TeeHold`), and all the
  isolate's tees together hold at most half of it (`tee_held` on
  `BackingStoreBudget`), so the branches being read have the other half.
  Past that both branches end with Cloudflare's text after what they hold,
  and the isolate lives on. **Decision:** half the budget, because a tee
  allowed to fill it condemned the isolate at the next buffer the reader
  took (`limits/tee-buffer` did, before the cap). A finished or cancelled
  host stream is teed in JS, since the host has nothing left under its id.
  - **Review fix: the pump ends once no branch has a consumer.** A dropped
    receiver gives its channel's permits back, so a branch that held
    nothing still looked as if it wanted the next chunk, and a branch done
    already made the "both closed" wait pending for good: the pump could
    loop on a quiet source, or never notice the second consumer leave.
    Each branch is now closed as soon as its sender reports the receiver
    gone (`flush`), and the read waits on `gone()`, which is ready for a
    done branch. In a node the unfixed pump stayed parked rather than
    spinning on the paths tried, so the unit tests below pin it, with a
    bounded poll count.
- **Known differences.** A clone or `tee()` of a stream the Worker made is
  teed in JS and buffers in the isolate, so past the memory limit it
  condemns the isolate where Cloudflare gives the tee error; workerd run
  locally has no limit either way (`docs/limitations.md`). Gaps the cases
  found outside `clone()` are 1.43.
- **Tests.**
  - `fetch/response-clone` (differential): 12 checks (clone and read in
    either order, a clone of a clone, after a partial read, a lock, `text()`
    and a cancel, cancelling either branch, the headers guard, both read
    together, `cache.put(response.clone())`) on Responses that are
    constructed (string, stream, null, `Response.json()`,
    `Response.error()`), wrap an R2 object's body, or come from a service
    binding (streamed, buffered, a followed redirect, a manual one) and a
    Durable Object stub (streamed and redirected); a 4 MiB body cloned and
    read one branch at a time, both orders, together, and with the clone
    never read, from a constructed stream, a service binding and a stub;
    the WebSocket refusal; and `Response.redirect()`'s clone's guard.
  - `fetch/response-clone-network` (celld-only, recorded by
    `lib/workerd-direct.mjs`, as wrangler's harness follows global
    `fetch()` redirects in Node): the same checks on global `fetch()`
    Responses, plain, redirected and manual, and the 4 MiB backpressure
    rows. The checks live in `lib/worker/clone.js` (`#clone`); the runner's
    upstream gained `/big?kib=<n>`.
  - `fetch/request-clone` (differential): the Request checks (signal, `cf`
    copy, guard) on constructed Requests (string, stream, GET, copied, a
    fetched body) and on the received request, with a length and chunked.
  - `limits/tee-buffer` (celld-only): a 400 MiB fetched body cloned, and
    teed, and read one branch first ends both with the tee error, and the
    isolate serves the next request. A `/shared` step pins the
    per-isolate cap: alone, a tee's read branch gets past 48 MiB before the
    limit; with 40 MiB held by another tee's unread clone, a second stops
    under 32 MiB.
  - `limits/tee-idle` (celld-only): after a clone of a quiet streamed body
    whose bodies are cancelled, and one left unread past the 60 s idle
    sweep, the node uses at most 300 ms of CPU in a second. It needed a new
    runner step, `cpu` (`lib/celld.mjs`, README).
  - Unit: `http_streams::tests`, a tee branch read to its end before the
    other, a tee past its limit, both branches cancelled while the source
    idles, and one cancelled after the other (the last two failed on the
    unfixed pump); `js::backing_store_budget_tests`, the shared half cap, the
    refund on drop, and a refusal that takes nothing.
  - `limits/backing-stores` (hand-written) pinned celld's old text for a
    clone of a request whose body was forwarded; it now has workerd's lock
    error, probed on workerd.
  - Starter: the adapter's "a clone of a fetched response keeps its URL"
    is an `it`.
- **Found.** 1.43.

### 1.43 Body and Response defaults (found by 1.23)

Each one differs from workerd 1.20261001.1; `builtins/body-defaults` pins
them (xfail):
- A string body gets no `Content-Type`. workerd gives a Request's or a
  Response's `text/plain;charset=UTF-8`.
- A Response made without a `statusText` has `""`. workerd's is its
  status's reason phrase (`defaultStatusText`), including
  `Response.json()` and `Response.redirect()`.
- A service binding's and a global `fetch()`'s Response have the reason
  phrase of their status, not the one the target sent (`Made` for a 201;
  the network's wire reason).
- `text()` after a partial read of a buffered body returns the whole body.
  workerd refuses it: `TypeError: Body has already been used. It can only
  be used once. Use tee() first if you need to read it twice.`
- A received request's headers are mutable, and so are its clone's.
  workerd's are immutable (`Can't modify immutable headers.`).
- Reading a Response body twice (`text()` then `text()`) does not throw;
  workerd gives the "Body has already been used" error above. And
  `new Request(a)` leaves `a.bodyUsed` false, where workerd marks `a`'s body
  used (found by the 1.53 review; add both to `builtins/body-defaults`).

### 1.24 Wrangler `alias` (found by 0.5)

`celld deploy` refuses `alias`, which upstream's `bundleBlueprints` uses.
Map it to esbuild's `alias`, as wrangler does.

**As built.**
- **What Wrangler does** (4.147.0, `wrangler-dist/cli.js`).
  - `normalizeAndValidateAliases`: `alias` must be an object (`Expected
    alias to be an object, but got string`), and every value a string,
    each failure named (`Expected alias["k"] to be a string, but got
    number`).
  - It applies `alias` with its own esbuild plugin, not esbuild's `alias`.
    The plugin matches an import path exactly, any string, relative ones
    included, and leaves `key/sub` alone. It resolves the value with
    Node's `require.resolve(value, { paths: [projectRoot] })`, the config's
    directory, when the key is imported: a path relative to it, with Node's
    file probing (`.js`, `.json`, `.node`, a directory's `main` or `index`),
    or a package by its `require` conditions. An empty value aliases
    nothing.
  - The plugin comes before the `nodejs_compat` ones, so an alias of
    `node:path` or `fs` wins over unenv.
- **celld** first mapped each entry to esbuild's CLI `--alias:KEY=FILE`,
  with the target resolved in Rust, and refused what that can't express:
  a key that is not a package path, a package as the target, and a subpath
  import of a key. **Superseded by 1.45**, which runs Wrangler's plugin
  itself through esbuild's service protocol: those three refusals and the
  `--alias` path are gone. What stays from 1.24:
  - the type checks, with `typeof` names as Wrangler's (`null` is "got
    object"), and the refusal of a `null` or array `alias`, which `typeof`
    calls an object: Wrangler crashes on `null` and reads an array's
    indexes as keys;
  - `no_bundle` with `alias` stops the deploy, as with `define` and `rules`;
  - an empty value prints a note;
  - a directory target whose `package.json` does not parse fails, as
    Node's `ERR_INVALID_PACKAGE_CONFIG` does.
- **bundleBlueprints** gives the relative key
  `./generated/bundled-blueprints.js`, which 1.24 refused. **Decision (Alex,
  2026-10-23):** support Wrangler's relative keys exactly, through esbuild's
  service protocol: 1.45.
- **Tests.** `modules/alias` (differential) and `deploy/alias`
  (celld-only), as 1.45 extended them; unit tests in `deploy::alias`.
- Docs: `docs/cloudflare-compat.md`.

### 1.25 KV `preview_id` under `celld dev` (found by 0.5)

`celld dev` requires a KV `id` and ignores `preview_id`, where `wrangler dev`
uses `preview_id`. The comment at `deploy.rs:1678` ("`wrangler dev`, which
celld does not run") is out of date.

**As built.**
- **What Wrangler does** (4.147.0). Its config validation allows `id` (a
  non-empty string), `preview_id` (a string) or neither. `wrangler dev`
  binds `preview_id ?? id` (`convertConfigToBindings` with
  `usePreviewIds`), and with neither a local namespace named after the
  binding (`kvNamespaceEntry`), so a missing id is no error there.
  `wrangler deploy` uses `id`.
- **celld.** `read_project` takes whether it builds for `celld dev`, and
  binds the same namespace as `wrangler dev` there. `celld deploy` still
  requires `id` and ignores `preview_id`, with its message for a missing
  one. An empty `id`, or an `id` or `preview_id` that is not a string,
  stops both, as in Wrangler. An empty `preview_id`, which Wrangler takes,
  stops only `celld dev`, since a cell can't have that name. The comment is
  replaced.
- **Tests.** `dev/kv-preview-id` (differential): bindings with both, only
  `preview_id`, only `id` and neither, each read back by `id` from another
  Worker. `deploy/refused-keys` gained a deploy of a `preview_id`-only
  binding.
- **Starter.** The adapter's `previewIdsAsIds` workaround and its README
  note are gone.
- Docs: `docs/services/kv.md`.
- **Found.** R2's and D1's preview keys are accepted and ignored: 1.44.

### 1.44 R2 and D1 preview keys (found by 1.25)

`celld deploy` checks no key of an `r2_buckets` or `d1_databases` entry
beyond those it reads, so `preview_bucket_name` and `preview_database_id`,
and any unknown key, are accepted and ignored. `wrangler dev` binds
`preview_bucket_name ?? bucket_name` and `preview_database_id ??
database_id` (`convertConfigToBindings` with `usePreviewIds`). `celld dev`
should do the same, as it does for KV since 1.25, and both commands should
refuse the keys they don't model. Pinned by `dev/r2-d1-preview` (xfail).

### 1.26 Stream follow-ups (found by 1.8)

- **Security hardening.** The host does not check ownership of HTTP stream
  ids on the response path. JS can no longer forge them (1.8), so this is
  defence in depth, as 1.21 part 1 was for sockets.
- A body from one service-binding `fetch()`, sent on as another subrequest's
  body, fails with "the body stream is not owned". workerd accepts it.
  Register response streams for transfer, or fall back to reading in JS.
  Then un-skip the row in `streams/body-usable`.
- Default readers on platform streams still allow several pending reads, and
  a cancel resolves the pending read as done.
- `IdentityTransformStream`: BYOB returns the view's type, `tee()` branches
  can't take a BYOB reader, and `releaseLock` with a read pending rejects
  the read instead of throwing.

**As built.**
- **What workerd does** (probed). A body an IoContext received is an I/O
  object of it. From another request it is refused with the cross-request
  error, `(I/O type: ReadableStreamSource)` (the cross-object text between
  Durable Objects).
  - Making a reader, `new Response(body)`, `locked` and a reader's `closed`
    are not refused. `tee()` throws. Reads, `cancel()`, `text()`,
    `pipeTo()`, iteration and a subrequest taking the body reject.
    Returning the body as a response fails the request; a service
    binding's caller gets the error.
  - A refused read also errors the stream: `closed` then rejects with the
    refusal.
  - An `IdentityTransformStream` is an I/O object too: its readable is
    refused as a body is, its writable's `write()`, `close()` and `abort()`
    with `(I/O type: Writable)`. A `TransformStream` made by one request
    is not refused in another, but reads and writes there never settle
    (`cancel()`, `close()`, `abort()` do settle). So a body piped through
    one and stashed delivers nothing later. Plain `ReadableStream`s cross
    requests freely.
  - Once a request ends, a pipe it was pumping stops, and its promise never
    settles.
  - Internal streams: one read in flight, a second rejects with "only
    supports a single pending read request". `releaseLock()` throws
    "outstanding read promises" while one is pending. A cancel rejects it
    with the reason as an Error ("Stream was cancelled." for none), and
    later reads are done. The reader is the standard
    `ReadableStreamDefaultReader`, from `getReader()` or its constructor.
  - An `IdentityTransformStream` read is served on a later turn even when
    written bytes wait, so a second read, a `releaseLock()` or a cancel in
    the read's turn meets it in flight. BYOB answers a `Uint8Array` of the
    bytes filled, whatever the view, and `readAtLeast` counts the view's
    elements. `tee()` branches take BYOB readers.
  - A `TransformStream` starts with backpressure on: a write's transform
    waits for a read. celld ran it at once, so a pipe from a pull source
    with `highWaterMark: 0` into one filled memory until the isolate hit its
    limit.
  - Two things the probes showed are wrangler's harness, not workerd: its
    `drainBody` middleware reads an unread request body after the handler
    answers. So a request body stashed past its request reads as locked,
    and a service echoing `request.body` as its response fails with "Body
    has already been used". Cases echo with `text()`.
- **Host** (`http_streams.rs`, `js.rs`). Each `HttpStreamEntry` records an
  owner, a `WsOwner` as 1.21's sockets do, from the running event when the
  id is handed out:
  - the caller of every fetch that answers with a body: network, service
    binding, Durable Object, facet, Worker Loader, `globalOutbound`, assets
    (`encode_http_response` takes it);
  - R2 `get`, `__response_stream_create` and both tee branches;
  - an incoming body's handler, which claims it (`claim_for`, which
    replaces the sender's owner). A cell event now claims after its frame
    is pushed, so the owner is the object (a facet is its own).

  `access(id, owner)` answers Owned, Other (another owner, or none yet), or
  Unknown (finished or never registered: the op answers as before, so
  nothing leaks). Read, read_all, tee, cancel, the three response-stream
  writer ops and `read_response` refuse Other. So does the body transfer
  of every subrequest kind. The text comes from both owners' kinds, through
  one builder shared with sockets and containers
  (`ws_registry::foreign_io_error`).
  - A pump an ended request left reading already stops, as in workerd
    (probed: a `pipeTo` stops writing, and its promise never settles): the
    host drops the request's pending ops when it ends.
  - **Decision: no read refusal keyed on retirement.** It was tried and
    reverted. A request is marked retired (`ws_retired`) once its 101 is
    returned, while its sockets' handlers still run and read bodies, so
    `websocket/cross-request-socket` hung.
  - `read_response` reports what `__readResponse` threw by its message,
    without the old "readResponse threw:" prefix, so a service binding's
    caller gets workerd's error. `websocket/forged-response-target`'s
    hand-written expectation changed with it.
- **Forwarding a fetched body.** `transfer_body_stream(id, owner)` sends
  any id the running code owns. A request's incoming body moves with the
  claim it holds; any other id is claimed at the transfer. So a body a
  subrequest answered with is sent on as in workerd, and
  `streams/body-usable`'s skipped row runs.
  - The sender's body now reads as used (`_disturbed`), as in workerd.
    Before, only the new Request's flag was set.
- **Streams** (`streams.js`, `writable_stream.js`, `byte_streams.js`,
  `harness.js`). Two registries keyed by the stream, in WeakMaps, so
  nothing a Worker sets reaches them (`__celld.__streamIo`):
  - `internal(stream, hooks)`: the internal-stream contract, inside
    `ReadableStreamDefaultReader` itself, for every platform stream
    (`CelldChunkStream`) and `IdentityTransformStream` readable. The
    contract is one read in flight, and `releaseLock()` throwing while it
    is pending. The hooks let `IdentityTransformStream`'s controller serve
    the reads and keep a per-reader `closed`. `CelldChunkStream._cancel`
    rejects the pending read with the reason as an Error, replacing
    `_cancelRejectsReads`, which only compression streams set and which
    rejected with the raw reason.
  - `own(stream, kind)`: the stream belongs to the code running now.
    Checked first by both readers' reads and cancels, `cancel()`, `tee()`,
    `pipeTo()`, `__hostStreamId` (`text()`, a subrequest's body, the
    response path), and by a writer's `write()`, `close()` and `abort()`
    and the writable's own `close()` and `abort()`. Host bodies and both
    sides of an `IdentityTransformStream` (unless made at global scope)
    are owned.
  - `pipeTo()` releases its reader through `_release()`, so a shutdown with
    a read in flight still unlocks.
- **`TransformStream`** (`writable_stream.js`) has spec backpressure: a
  write waits until the readable is read, an enqueue that fills the readable
  sets it again, and an error, a cancel or an abort clears it. It records
  the `__ws_owner` token of the code that made it, unless that is global
  scope. Another owner's pull and write return a promise that never
  settles.
- **`IdentityTransformStream`** (`identity_transform_stream.js`).
  - Reads are served on a later turn.
  - BYOB answers `Uint8Array`.
  - Both readers' `releaseLock()` throws with a read pending (`_reading`
    for the BYOB reader).
  - A cancel rejects the read in flight.
  - `tee()` reads the readable through one reader as a platform stream and
    tees that, so the branches take BYOB readers. They buffer in the
    isolate, as 1.23's JS tees do.
- **Decision: no lease for same-isolate RPC.** A host body returned or
  passed over a same-isolate RPC is read under its owner, since the
  entrypoint shares its caller's owner. Probed: a fetched body or Response
  returned from `ctx.exports`, passed to it as an argument or in a Request,
  `waitUntil` reads, `clone()` and `tee()` all still read the whole body.
  Cross-isolate RPC streams are still Phase 7.
- **Decision: a refused read errors the stream,** as the probes show
  workerd's does (a reader's `closed` rejects with the refusal afterwards).
  Every other refusal leaves the stream as it was.
- **Internal signatures changed**, for the out-of-tree
  `celld_internal_tests` suite to follow:
  - `js::claim_http_stream`'s re-export is gone (`claim_for` replaces it in
    `own_body_stream`);
  - `HttpStreamService::register`, `register_response_pair`,
    `encode_http_response` and `prepare_http_stream_tee` take an owner;
  - `IoContext::transfer_body_stream` takes the owner and returns
    `Result<RequestBodyGuard, Option<String>>`;
  - `HttpStreamAccess::Other` carries `object`;
  - the `CROSS_REQUEST_IO` constants in `js/websocket.rs` and
    `js/container.rs` are now `foreign_io_error`.
- **Tests.**
  - `streams/cross-request-body` (differential): bodies one request
    stashed, each used by a later request (read, read then `closed`, BYOB
    read, cancel, tee, `text()`, sent on, `pipeTo`, iteration, and
    `closed` alone, which waits):
    - fetched by the Worker;
    - answered by a Dynamic Worker;
    - fetched by the Dynamic Worker itself and used in its next request.

    These go through real Loader dispatch.
  - `streams/cross-request-response-body` (differential, through a
    reporting Worker's service binding): each kind returned as a later
    request's response fails the call with workerd's error.
  - `streams/cross-request-wrappers` (differential): a fetched body piped
    through a `TransformStream` and through an `IdentityTransformStream`,
    unread and read once, then read by a later request; each read, BYOB
    read, cancel, write, close and abort of a stashed transform of each
    kind.
  - `streams/platform-default-reader` (differential): a fetched body, an
    `IdentityTransformStream`, a `DecompressionStream`, a Blob stream and a
    streamed request body. Checks: a second read, a cancel with each kind of
    reason and a `releaseLock()` with a read in flight, in the read's turn
    and after it waited; the reader's class, constructor, prototype and tag,
    and `new ReadableStreamDefaultReader(stream)` keeping the contract.
  - `streams/byob-identity-transform` (differential): the shared BYOB
    checks, the view types, `readAtLeast` on a `Uint16Array`, tee branches,
    and `releaseLock()` with a read in flight, with and without written
    bytes.
  - Unit: `http_streams::tests::a_stream_answers_only_its_owner` covers:
    owner, claim, a claim replacing the sender, a facet and its parent as
    different owners, tee branches, finished ids.
    `js::http_stream_owner_tests::a_stream_id_is_refused_to_code_that_does_not_own_it`
    calls every op, `read_response` and the body transfer through V8 with
    another request's id: as a request, as a Durable Object, and from a
    second isolate standing for a Loader child. Each is refused, the
    owner's stream is untouched, and the owner can still send it on.
- **Verification.**
  - `cargo fmt --check`, clippy `-D warnings` and `cargo test --workspace`
    (264 passed) are clean, and so is the lab build.
  - Conformance `--runtime=both`: 136 PASS, 18 XFAIL, exit 0 (was 131 and
    15). At HEAD, every new passing case and the un-skipped
    `streams/body-usable` row fail.
  - Starter e2e `all --fresh --quick` matches the baseline: S0, S1, S2, S9,
    S11, B0 and B6 pass.
  - Integration exits 0. `workshop-user-directory` passes, and every pending
    suite's first error is unchanged.
- **Found.** 1.46.

### 1.45 Wrangler `alias` via esbuild's service protocol (found by 1.24)

1.24 maps `alias` to esbuild's CLI `--alias`, which takes only package-name
keys, rewrites every subpath of a key, and resolves a target its own way.
Wrangler's exact semantics need an on-resolve plugin, which the esbuild CLI
can't run. Drive esbuild through its service protocol instead, as its JS API
does (`esbuild --service=<version>`), with an on-resolve plugin that does
what Wrangler's does.
- **Wrangler's plugin** (`wrangler-dist/cli.js` ~184913): an unanchored
  regex filter of the keys, then `alias[args.path]` as a literal match of the
  import path, from any importer. The value is resolved with
  `require.resolve(value, { paths: [dirname(config)] })`.
- **The protocol** is a length-prefixed packet codec, tied to the esbuild
  version, so CI must cover each esbuild version celld supports.
- Diagnostics come back structured, so celld can report them as esbuild's
  CLI does.
- Package targets need Node's CommonJS resolution, `exports` included.
- Estimated at 400–700 lines.
- It unblocks `workshop-blueprints`' redeploy case, and removes 1.24's
  refusals of relative keys, package targets and subpath imports.

**As built.**
- **One bundling path.** Every esbuild run, the Worker bundle and the
  Python Worker bundle, goes through `crates/celld/deploy/esbuild.rs`,
  which drives `esbuild --service=<version> --ping` as esbuild's JS API
  does. The CLI path and `--alias` are gone.
  - Sources, at 0.28.1: `cmd/esbuild/service.go` (`handleBuildRequest`,
    `convertPlugins`, the `on-start`/`on-resolve` requests),
    `cmd/esbuild/stdio_protocol.go` and `lib/shared/stdio_protocol.ts`
    (the codec), `lib/shared/common.ts` (`buildOrContextImpl`,
    `handlePlugins`, `createChannel`), `cmd/esbuild/main.go` (the version
    check, `--ping`, the CLI's GC setting).
  - The build request carries the CLI's flags unchanged: the service
    parses them with the CLI's parser (`cli.ParseBuildOptions`). That parser
    starts from a silent log with no limit, so celld adds the CLI's
    `--log-level=info --log-limit=6` (the Python build keeps its
    `--log-level=warning`). `write: true`, so esbuild writes the output
    directory as the CLI did. The entry goes in `entries`, absolute, as
    Wrangler passes it, so an alias key meets it as it would there;
    esbuild prints paths relative to `absWorkingDir` either way.
  - The CLI turns Go's collector off for a build of one entry point
    (`debug.SetGCPercent(-1)`); the service leaves it on, which made the
    large bundles 6–7% slower. Each service runs one such build and exits,
    so it runs with `GOGC=off`, as the CLI did, in time and in memory.
  - With `NODE_PATH` unset, bundles are byte-identical: every Cloudflare OS
    Worker keeps its deployment version (`7aade69af0ae65d7` for
    gatekeeper-scheduler, and so on) before and after, and so does a Python
    Worker.
  - **Deliberate change: `NODE_PATH` no longer reaches esbuild.** The CLI
    reads it (`runImpl` in `pkg/cli/cli_impl.go`); the service reads only
    the request's `nodePaths`, which Wrangler's JS API call leaves empty,
    and so does celld. **Decision (coordinator, 2026-10-23):** match
    Wrangler. Recorded in `docs/cloudflare-compat.md` and the upgrade notes
    in `docs/README.md`.
- **The codec** is hand-written (~150 lines), no new crate: the protocol is
  JSON with an int and a byte-array type, length-prefixed, little-endian.
  Malformed input is an error, never a panic: short values, unknown types,
  trailing bytes, nesting over 64, a packet over 64 MiB (an answer carries
  only diagnostics), over 2^20 values in one packet (a value takes a byte
  on the wire and tens in memory); counts are checked against the bytes
  left before anything is allocated. Strings decode as
  the JS API's `TextDecoder` does (U+FFFD).
- **Diagnostics.** The service's logger writes stderr as the CLI's does,
  and celld shows that stderr when a build fails, as it showed the CLI's
  (16 MiB at most). One difference is esbuild's own: the service sets
  `logger.API = JSAPI`, so a hint that names an option spells it as the JS
  API does (`"platform: 'node'"`, not `"--platform=node"`). celld's flags
  mark every bare builtin external, so none of its cases meets one. A
  refused request (`error` in the answer, such as a flag the parser
  rejects) prints as `✘ [ERROR] <text>`. Of the deploy/ and modules/ texts,
  only `deploy/alias` pinned esbuild output, and only its subpath step's
  text changed, because the behaviour did: Wrangler resolves `thing/sub.js`
  as usual, so esbuild's own "Could not resolve" replaces the CLI alias's
  "remapped" error.
- **Wrangler's plugin** (`deploy/alias.rs`), as `bundleWorker` registers
  it: one on-resolve callback, `name: "alias"`, whose filter is the
  `source` of Wrangler's `new RegExp(keys.map(escapeRegex).join("|"))`
  (line terminators as escapes, `(?:)` when empty), compiled by esbuild as
  Go does for Wrangler. The callback looks `alias[args.path]` up
  literally, from any importer and namespace, and only then resolves the
  value: a target that does not resolve fails only a build that imports
  its key, with Node's message (`Cannot find module './lib/missing'`,
  `Package subpath './dist/index.js' is not defined by "exports" in …`),
  which esbuild places at the import. A Node builtin as the target returns
  its name, which esbuild refuses as Wrangler's run does (`Plugin "alias"
  returned a non-absolute path: node:fs`). An import of an
  `Object.prototype` name the filter passes (`toString` with a key `t`)
  fails, as `alias["toString"]` does in Wrangler.
  - **Loud gaps.** The key `__proto__` is refused: Wrangler's JSONC parser
    assigns it to the prototype, so it aliases nothing there. `alias` in a
    Python Worker is refused; it was silently ignored before. esbuild
    bundles only celld's JavaScript shell around a Python Worker, not its
    Python code.
- **`require.resolve`**, from Node 26.3's `cjs/loader.js`
  (`_resolveFilename`, `_findPath`, `tryPackage`, `resolveExports`,
  `_nodeModulePaths`), `esm/resolve.js` (`packageExportsResolve`,
  `resolvePackageTarget`, `patternKeyCompare`, the segment checks) and
  `src/node_modules.cc` (which `package.json` fields count): builtins by
  name or `node:`, relative and absolute paths with file probing,
  `node_modules` from the config's directory up, a request that starts
  with `..` but is not relative (`..foo`, `.../x`) from the working
  directory (`_resolveLookupPaths` gives it `['.']`), `exports` with
  patterns, arrays and `null`, under `require`, `node`, `node-addons`,
  `module-sync` and `default`, in source order (a small ordered JSON type,
  since `serde_json`'s map sorts), real paths. The segment and separator
  checks fold ASCII case only, as JavaScript's `/i` without `u` does (`ſ`
  is not `s`). Error texts are Node's, without the `Require stack` line,
  which names Wrangler's own file.
  - `NODE_OPTIONS`, as Wrangler's Node reads it: split as
    `ParseNodeOptionsEnvVar` splits it (`src/node_options.cc`), each
    `--conditions=X`, `--conditions X` or `-C X` adds a condition, and
    `--no-addons` drops `node-addons`. `-C=X` and a `--conditions` without
    its argument stop the build with Node's message, as Node refuses to
    start. `--preserve-symlinks` and `--no-require-module` (or
    `--no-experimental-require-module`), which would change resolution
    otherwise, stop the build.
  - Not done, as documented in `docs/cloudflare-compat.md`: Node's global
    folders (`NODE_PATH`, `~/.node_modules`), which come after every
    `node_modules` and so only turn a failure into a success, and
    `trySelf`, Node's resolution of `wrangler` and `wrangler/…` against the
    running Wrangler; celld resolves them from the project like any
    package. Node's deprecation warnings (DEP0128, DEP0155, DEP0166) are not
    printed; the resolution is the same.
- **Versions.** celld runs `esbuild --version` and speaks the protocol of
  0.28.0, 0.28.1 and 0.28.2 (read at 0.28.1; 0.28.0 to 0.28.1 changed no
  protocol file, and 0.28.2 added only `logStyle` to `format-msgs`, which
  celld does not send). Any other version stops the build: `esbuild 0.27.7
  (…) is not a version celld can drive: celld speaks the service protocol
  of esbuild 0.28.0, 0.28.1, 0.28.2. Install one of them, or set
  CELLD_ESBUILD to its path.` The probe costs ~2 ms a build. It runs as
  the service does (below). A `CELLD_ESBUILD` with a `/` is made absolute
  once, against celld's working directory, for the probe and the service,
  which runs in the build's directory.
  - CI: `tests/conformance` pins `esbuild-0.28.0` and `esbuild-0.28.2`
    (npm aliases, in the lockfile) beside `esbuild` 0.28.1, the runner takes
    `--esbuild VERSION`, and a new `test.yml` step runs `deploy/*`,
    `modules/*`, `dev/*` and `node/*` on each.
- **Lifecycle.** One service per build, and its version probe, each spawned
  through
  `spawn_build_process`, which `build.command` now shares: it dies with
  celld (`PR_SET_PDEATHSIG`), and under `celld dev` it leads a process
  group registered in `DevGroup`, so `stop_builds`/`kill_builds` reach it
  and none starts once `celld dev` is stopping. A failed exchange kills it;
  otherwise celld closes stdin, drains stdout, reaps it, and the `Service`
  guard kills and reaps on any other exit. `--ping` makes esbuild exit if
  celld vanishes. Checked: no esbuild after five `celld dev` watch
  rebuilds and a failing one, after SIGTERM to `celld dev`, or after
  SIGKILL to a `celld deploy` mid-build. Memory and time are bounded as the
  CLI's were: no timeout, as before; GC off, as before.
- **Security.** Build-time only: the plugin runs in the `celld deploy`/`celld
  dev` process, resolving the deployer's own config with the deployer's
  privileges, as the CLI path's alias did. No Worker code runs during a
  build, and nothing here is reachable from a running Worker.
- **Tests.**
  - Unit, `deploy::esbuild`: random round-trips (2,000 values), the bytes
    the JS `encodePacket` writes, every truncation, trailing bytes, unknown
    types, oversized counts and lengths, nesting, invalid UTF-8, the
    stream framing, 20,000 random byte strings; with a fake esbuild, the
    version refusal, a protocol break (killed, stderr shown) and a `celld
    dev` stop (SIGTERM reaches it; none starts after); the value budget;
    the `CELLD_ESBUILD` path. The fake is written under another name,
    closed, renamed into place and run until it runs, since a child that
    another test forks while it is open for writing makes `exec` fail with
    ETXTBSY until that child execs.
  - The `celld dev` build tests take turns through a guard that also lets
    builds start again when it drops, so one failure cannot fail the next,
    and they wait for a killed child to go instead of asserting at once.
    The `deploy::` and `dev::` tests passed 200 runs in a row, and the
    whole library suite 30.
  - Unit, `deploy::alias`: the config checks, the filter source, literal
    lookup, and 60 requests on one tree recorded from Node 26.3's
    `require.resolve` (paths, `main`, invalid configs, builtins, `exports`
    conditions, patterns, fallbacks, `null`, invalid targets and subpaths,
    sugar, duplicate keys, `..foo` from the working directory, `ſ`), and
    the `NODE_OPTIONS` conditions, also recorded from Node.
  - `modules/alias` (differential): a relative key that no file backs,
    from two directories; a key that only another import contains; a
    subpath of a key; a package by its `require` condition (capnweb's
    CommonJS build, not the `workerd` one); an exported subpath
    (`wrangler/package.json`).
  - `deploy/alias` (celld-only): the relative key accepted; a missing
    package, a missing file, a non-exported subpath and a builtin target,
    each imported; an unresolvable subpath import; `__proto__`; and a
    missing target never imported, accepted. Each outcome also checked
    against `wrangler deploy --dry-run`.
- Docs: `docs/cloudflare-compat.md`, `README.md`, `docs/README.md`,
  `docs/services/workers.md`, `celld deploy --help`,
  `tests/conformance/README.md`.
- **Results (2026-10-23, after the review fixes).**
  - Bundling time, `celld deploy --dry-run --no-build` of the seven
    Cloudflare OS Workers, interleaved with the pre-1.45 binary, 10 rounds:
    694 ms before, 720 ms after (+3.7 ms a Worker, about 2 ms of it the
    version probe; the `Bundled` times are unchanged). Without `GOGC=off`
    it was 757 ms. The final binary: 722 ms a round, same versions.
  - `cargo test --workspace`: 278 passed (dev and lab profiles).
  - Conformance (`--runtime=both`): 136 PASS, 18 XFAIL, as before. The
    bundling cases (15 PASS, 1 XFAIL) also pass on esbuild 0.28.0 and
    0.28.2.
  - Starter e2e: S0, S1, S2, S9, S11, B0 and B6 pass, S3, S4, S6, S7, S10
    and B1–B5 fail, as before.
  - Integration: `workshop-user-directory` passes, and every pending
    suite's first error is unchanged. `workshop-blueprints`' redeploy case
    (bundleBlueprints) now deploys: its generated `workshop-backend.jsonc`
    carries the key `./generated/bundled-blueprints.js`, which bundles, and
    the node becomes ready. It fails next on `RPC stubs cannot cross
    isolate boundaries yet` (Phase 3), as the suite's other cases do. The
    starter's `status.json` says so.

### 1.46 Stream and entrypoint gaps found by 1.26

Each differs from workerd 1.20261001.1 and is pinned xfail:
- `streams/identity-transform-writer`: after an `IdentityTransformStream`'s
  readable is cancelled, celld rejects the writer with the reason every
  time. workerd rejects with `Error: Network connection lost.` when a read
  was in flight. After a write the cancel rejected, a write or `close()`
  finds `TypeError: This WritableStream has been closed.`.
- `streams/object-request-body-after-response`: a Durable Object that
  keeps its request's body past the response and reads it in a later event
  gets celld's "HTTP stream N expired or is not registered". workerd's is
  `TypeError: Can't read from request stream after response has been
  sent.`. A fix has to end the body when the response is sent, not when the
  event retires (later `waitUntil` work), so it is not a remap of the
  error.
- `exports/entrypoint-without-fetch`: `fetch()` on a `ctx.exports`
  entrypoint with no fetch handler throws `Entrypoint "Source" has no fetch
  handler`. workerd's is `Handler does not export a fetch() function.`.

Also from the second review of 1.26, not yet pinned:
- The JS ownership check can be stepped round through public underscore
  internals (`readable._ictl._read()`, `writable._write()`, `_cancel()`,
  `reader._release()`). The host check stays the boundary; move these behind
  module-private state.
- One foreign pull on a stashed `TransformStream` wedges it for its owner
  too (pull is never called again). Check workerd and pin it.
- `CompressionStream` and `DecompressionStream` inherit the TransformStream
  behaviour (another request's use hangs). workerd's are native internal
  streams and probably refuse with the cross-request error; probe and match.
- `read_response` drops a `TypeError`'s name ("Worker failed: <message>").

### 1.47 Hung requests (found by 1.26)

A request whose promise can never settle (`await new Promise(() => {})`, or
one only another request could resolve) hangs in celld until the client
disconnects or the handler budget ends; the runtime reports a request idle
only when it has ops pending (`runtime.rs` ~2530-2591). workerd cancels it
at once with "The Workers runtime canceled this request because it detected
that your Worker's code had hung and would never generate a response." (500).
A dev node with such a request reports `draining` on shutdown. Detect it as
workerd does and pin it with a differential case.

### 1.27 Container scope comes from JS (found by 1.9) — security

**Problem.** `ContainerPort._scope` is a writable property (`harness.js`
~2620), and the container ops (`port_address_arg` in `js/container.rs`,
start, exec, `__container_address`) trust the scope that JS sends. So a
Worker can name another Durable Object's container, which reaches its
address, its lifecycle and the 1.9 egress exemption.

**Design.** Bind container operations to the running cell on the host, as
1.21 does for sockets: a DO reaches only its own container, and the scope
never comes from JS. Keep harness state private.

**Tests.** A celld-only isolation case that expects the refusal, and unit
tests for each op.

**As built (done).**
- Every container op takes its container from the running DO event. No op
  accepts a scope from JS.
- Container, port and exec-process objects carry a private owner, which is
  only ever compared. Use during another object's event throws workerd's
  "Cannot perform I/O on behalf of a different Durable Object" error, with
  workerd's I/O type (`Monitor`, `Client`, `OutgoingFactory`). Use outside
  any DO event throws the cross-request variant.
- **Also fixed:** exec process ids were a global counter, so any Worker could
  read or kill another object's process. Ids now resolve only through the
  running container's own process set.
- The 1.9 `getTcpPort` exemption takes only an integer port.
- `containers/ownership` (celld-only) needs Docker. The runner's new
  `requires: ["docker"]` skips it locally when there's no engine, and CI sets
  `CONFORMANCE_REQUIRE=docker` so it can never be skipped there.
- Follow-up: check the I/O type names against workerd, and the difference in
  `running` (workerd returns false without throwing when the owner never
  started its container).

### 1.28 RPC method lookup everywhere else (found by 1.11)

1.11 applied workerd's rule to RpcTargets and class entrypoints. These paths
still differ from workerd:
- **DO stubs.** `__rpcTargetMethod` uses a bare `inst[method]`:
  - own-property methods are callable;
  - `stub.alarm()` runs the DO's alarm, where workerd says it is reserved;
  - a missing method says "is not a function" instead of "does not
    implement";
  - `await stub.version` returns a function.

  Reuse the reserved set and `__rpcClassMember`, after checking which
  internal names reach `__dispatchRpc`.
- **Plain-object entrypoints.** `__callObjectEntrypoint` reads `handler[method]`
  with no reserved, own-only or `Object.prototype` rule. For example,
  `constructor(x)` calls `Object(x)`.
- **Client side.** celld stubs send `Object.prototype` names (`toString`,
  `constructor`) to the receiver; workerd answers them locally. Either answer
  them locally or document the difference.
- workerd refuses pipelining on a returned Proxy RpcTarget (it fails
  `isInstanceOf<JsRpcTarget>`); celld probably allows it.
- Tests to add: a prototype accessor on a plain class returning `undefined`,
  and `constructor`/`dup` refused on a transient RpcTarget.
- Value-session pipelining (`__walkLocal`) uses plain `[[Get]]`: a missing
  name gives `undefined` and a primitive's members can be read, where workerd
  refuses both (`rpc/pipeline-receiver-rules`, xfail).
- `connect` on DO stubs is an RPC call; workerd has a native Fetcher
  `connect`.
- workerd puts `Symbol.dispose` on every object RPC result; celld does so only
  when the result carries stubs.

**As built (done).** One walker, `__rpcPath`, applies workerd's
`tryGetProperty` to every receiver: stub targets, class and plain-object
entrypoints, Durable Objects and call results. `__stubResolve`,
`__entrypointResolve`, `__walkable` and `__rpcTargetMethod` are gone.
- **Reserved names.** Every name on a path is checked against the reserved
  set of the target where the call started. An entrypoint or Durable Object
  reserves `constructor`, `fetch`, `connect`, `alarm`, the three
  `webSocket*` handlers and `dup`. A transient target (an RpcStub's, or a
  call result's) reserves `constructor` and `dup`. So `stub.tools.alarm()`
  is refused as well as `stub.alarm()`.
- **Durable Objects.** A DO is looked up as an entrypoint: class members
  only, so `ctx`, `env`, own-property methods and celld's `__celldState`
  are hidden. A member that reads `undefined` is a missing method, and the
  texts are workerd's. A stub member is now an RpcProperty. Awaiting it
  reads the property, and a longer path is walked at the object. The method
  stays the first name, and the rest of the path rides with the arguments
  as `{ path, args }` (`__doRpcRequest`), with null args for a read. A plain
  call still sends an array, so the wire is unchanged for it.
- **Runtime cells.** The KV, Queue, D1 and Workflow cells answer only the
  methods their bindings call, called directly (`__runtimeClass(name, cls,
  methods)`). At HEAD, user code could reach these stubs through
  `env.QUEUE._stub` and call `_purge`, `_setPaused`, `_peek` or `__kvSweep`.
- **Plain-object entrypoints** use the same walker in own-property mode.
  Reads and paths work, as on workerd: `await env.SVC.value` and
  `env.SVC.nested.fn(x)`. A function on the path is called as
  fn(arg, env, ctx) with its object as `this`, under workerd's arity rules,
  including "RPC function has unreasonable length attribute". At HEAD,
  `constructor(x)` called `Object(x)`, and `alarm`, `dup` and `connect`
  reached the handler.
- **Client side.** RpcStub, RpcPromise, RpcProperty, `ctx.exports`, service
  bindings and DO stubs answer their prototype chain's names locally, which
  includes Object.prototype's. Array indices are `undefined`, as workerd's
  wildcard never sees them. `in` reports what workerd reports. RpcStub,
  RpcPromise and RpcProperty carry workerd's `toString()` tags
  (`[object JsRpcStub]` and so on). A DO stub's `constructor` and tag come
  from a local `DurableObject` stub class.
- **Value-session pipelining** (`__walkLocal`) applies workerd's
  call-pipeline rules. A plain object exposes its own properties, which may
  be `undefined`. A stub passes the path to its target, and a DO stub or
  service binding is walked as a Fetcher. Anything else (a primitive, an
  array, a Date, a Map, a Response, an Error) refuses its first name. An
  array is no longer walkable mid-path on either side.
- **Proxy RpcTargets.** A returned Proxy that claims RpcTarget's prototype
  still crosses as a stub, but its call has no pipeline: its marker says
  so, and the stub it revives as refuses a pipelined name. `new
  RpcStub(proxy)`, or the stub passed on, keeps a pipeline, as on workerd.
- **`connect` on DO stubs** is a native method, one function for every
  stub. celld has no connect handlers, so it throws "Fetcher.connect() is
  not implemented in celld", as `queue()` does (1.48).
- **`Symbol.dispose`.** Every object a call or property read answers with
  gets its own non-enumerable, writable, configurable disposer. It is empty
  unless the result carries stubs. The lift never forwards the empty one.
- **Server-side Object.prototype names** are still refused before user
  code. workerd reads the member and compares it with Object.prototype's.
  The two differ only for a name that no workerd client sends without the
  `experimental` flag.
- **Cases.**
  - Differential: `rpc/do-method-lookup`, `rpc/client-names`,
    `rpc/object-entrypoint-lookup` and `rpc/result-dispose`, and
    `rpc/rpc-refusals` (refusals only). `rpc/pipeline-receiver-rules` is
    extended and no longer xfail.
  - `rpc/rpc-refusals-internal` is celld-only. It covers the test hook's
    Object.prototype names and the runtime cells.
  - `rpc/do-connect` and `rpc/client-shapes` are xfail until 1.48.
  - Every new case and the extended one fail at HEAD. At HEAD, the refusal
    cases reached a DO's `alarm` and `webSocket*` handlers, `dup` and
    own-property methods; an entrypoint's reserved names one step down a
    path; an object entrypoint's `alarm`, `dup`, `webSocket*`, `connect`
    and `constructor`; a transient `dup` through a path; and the Queue and
    KV cells' internal methods.

### 1.48 Follow-ups found by 1.28

- **Security: runtime-cell stubs are reachable.** Moved to 1.49, which the
  review of 1.28 widened to cross-script reach.
- **`connect()` on a DO stub** should reach the object's `connect(socket)`
  handler, as on workerd (`rpc/do-connect`, xfail). A service binding's
  and a `ctx.exports` stub's `connect` are still RPC names, which the
  target refuses as reserved. workerd's is the native Fetcher method.
- **Client shapes.** These differ from workerd (`rpc/client-shapes`, xfail):
  - A DO stub's `fetch` is a new function per stub; workerd's is one (in
    `rpc/do-connect`).
  - RpcPromise inherits from Promise.prototype.
  - Stubs and pipeline nodes report the own keys `length`, `name` and
    `prototype`.
  - A DO stub's own keys are `id`, `name`; workerd's are `name`, `id`.
  - A service binding's and a `ctx.exports` stub's `toString()` give
    `[object Object]` and `[object Function]`, not `[object Fetcher]` and
    `[object LoopbackServiceStub]`.
- **Facet and Worker Loader stubs** still send array indices as names.
  They refuse property reads and paths, as before.

### 1.49 Durable Object scope authorisation (found by the 1.28 review) — security

**Problem.** Nothing on the host ties a caller to the Durable Object scopes
it may reach. Verified in `celld dev` with two scripts, where `attacker`
used only its own bindings:
- **Cross-script reach.** Namespace keys are fixed strings
  (`engine_api.rs` ~597-640: `cells:v1:queue:__Queue`,
  `cells:v1:<len>:<script>:<class>`), `DurableObjectNamespace` takes the
  class and key as plain constructor arguments (`harness.js` ~6168), and
  `dispatch_rpc_call` (`main.rs`) checks only that a scope is well formed.
  `attacker` read `victim`'s KV values (`env.KV._namespace()`), queued
  messages (the Queue cell's `peek`), D1 rows (the D1 cell's `exec`), called
  a method on `victim`'s own Durable Object, and read its Workflow status.
- **Operator handlers.** `_stub.fetch()` on a Worker's own runtime bindings
  reaches the cells' operator handlers (`harness.js` ~8572-8620 Queue
  info/purge/pause/resume/peek/redrive and `/__qSettle`; ~8772-8800 D1
  migrate and exec; `kv.js` ~674-770). A producer-only Queue binding could
  peek, pause and purge a fleet-wide queue. (D1's engine authoriser still
  refuses `_cf_*` and `_litestream*` writes.)
- **Cell methods trust the caller's validation.** The allowlisted methods
  are validated in the caller's isolate only: `_stub.__kvPut` stored a
  5000-byte key (public limit 512), and `_stub.__queueDlqAcceptBatch`
  (cell-to-cell, yet on the binding allowlist) took a caller-chosen id, a
  wrong declared size and a `deadLetterSource` naming another queue.

**Design.**
- Enforce on the host: every DO fetch, RPC, alarm and WebSocket call to a
  scope is checked against the calling script's authorised namespaces: the
  classes its own bindings and `ctx.exports` name, runtime classes only
  through a binding it holds, and (from Phase 2) whatever a verified
  capability token grants. Cross-script DO bindings (`script_name`) and
  Phase 4 facets of another script's class must go through that check, not
  around it.
- Take namespace keys, `_stub`, `_namespace` and the
  `DurableObjectNamespace` constructor out of user reach (private state or
  closures); refuse `fetch` on runtime classes except on the authenticated
  `/runtime/` route.
- Re-validate every limit inside the cell methods (keys, sizes, ids, content
  types, metadata), and give cell-to-cell calls (`__queueDlqAcceptBatch`) an
  internal path that a binding's allowlist does not include.
- Consider deriving DO ids with a fleet secret so an id is not computable
  from public strings alone (as Phase 2's D7 key does for tokens).

**Tests.** Celld-only refusal cases with two scripts, one per path above
(neutral framing: each expects the refusal), and unit tests on the host
check.

**Also (LOW, from the same review):** a JSON-flavour peer RPC call whose
arguments are `null` now fails "Malformed Durable Object RPC request"; it
used to call with no arguments. Only authenticated peers send it.

**As built (part A: host-side ownership tracking).**
- **Grants.** `scope_grant::ScopeGrant`, built once per `WorkerConfig`
  (`WorkerConfig::scope_grant`, lazily, after the builder sets the consumer
  catalog) and held on `ActorRuntimeState` next to `script_name`, and per
  script on `Generation` (`scope_grant(script)`) for the owner-side check.
  It admits every object of the script's `do_classes` except the shared
  runtime classes (so its bindings' and migrated classes, `ctx.exports`,
  and its own `__Workflow.<script>`), and of `__KvNamespace`, `__Queue`
  and `__D1Database` only the exact cells its bindings name:
  `kv_cell_scope(id, 0)` per KV binding, `queue_cell_scope` per producer,
  `d1_cell_scope` per D1 binding. Another shard of an own KV namespace is
  not admitted. A scope without a `:` names no cell. Dynamic Workers
  (`WorkerOrigin::Dynamic`) get `ScopeGrant::none`.
- **Queue consumers** need nothing: they never call the Queue cell.
  `dispatch_queue_batch` delivers the batch and settles the lease
  (`/__qSettle`) from the host.
- **Shared runtime cells.** Calls celld makes itself (ingress and `/do/`,
  `/runtime/`, queue settlement, cron arming) carry `Caller::Host`. The one
  cell-to-cell call from JavaScript is the Queue cell's dead-letter transfer
  and redrive, which runs in the first script's isolates and so under that
  script's grant. It is admitted by a relay, not a wider user grant: while
  the running event is a `__Queue` cell's, the grant also admits the Queue
  cells of the deployment's consumer catalog (each consumed queue and its
  dead-letter queue, which every isolate carries). Other code never runs
  in a Queue cell's event, short of patched builtins reaching harness code,
  which part B's primordials work covers. A redrive back to a queue that
  the current catalog no longer consumes is refused, loudly.
- **Caller-side checks.** `op_do_call_impl` (fetch, cancellable fetch,
  WebSocket upgrade) and `op_rpc_call` call `admitted_caller` first: the
  caller is `Caller::Script { grant, event }`, event being the running
  cell event's scope, and a scope outside the grant throws
  `Durable Object <scope> is not reachable from Worker "<script>": the
  Worker holds no binding to its namespace` before anything is sent.
  `DoCallReq`/`RpcCallReq` and `cell_dispatch::CallContext` carry the
  `caller`; `dispatch_call_attempt` (both dispatchers) and `main.rs`
  `dispatch_rpc_call` check it again before routing, so a producer of a
  call that skipped the op check is still refused.
- **Peer tunnel, version 7.** Node A writes `x-cells-caller` (`host` or
  `script:<name>`) and, for a script's call from a cell event,
  `x-cells-caller-event`; both are control headers, so an application's
  copies are dropped. Node B (`tunnel_control`, `RpcHead::parse`) refuses
  an inner request that names no caller (400), and
  `dispatch_forwarded_fetch`/`dispatch_forwarded_rpc` resolve the script's
  grant from B's own current generation (`TunnelCaller::resolve`; an
  unknown script, such as a Dynamic Worker, gets none) and refuse before
  routing: a fetch as a handler failure, which A raises to the caller, and
  an RPC as 403. `TUNNEL_VERSION` is 7; `docs/README.md` "Upgrade notes"
  now says 5 to 7 for the next release (stop all; fresh deployments only,
  no compatibility path), as 1.19 set up.
- **Storage, cursors, alarms and gates bound to the running event.** Every
  op that takes a storage scope from JavaScript goes through
  `owned_storage_cell`: the `__storage_*` data ops (get, put, delete, list,
  queued puts, flush, sync, transaction control, delete-all), every `__sql_*`
  op that takes a scope (and the test-only ones), `__d1_run`,
  `__alarm_set/get/delete` and `__queue_alarm_set_wait`. The scope must equal
  the running event's (`current_cell_event`), as 1.27 did for containers, or
  the op throws workerd's cross-object error `(I/O type: ActorCacheInterface)`
  (outside any object event, the cross-request one). `storage.sync()`'s old
  private check is folded into this one.
  - **SQL and kv.list() cursors** carry their cell (`sql_cursor_scope`,
    `sync_list_cursor_scope`). `__sql_cursor_next`/`__storage_sync_list_next`
    refuse a cursor whose cell is not the running object's, with workerd's I/O
    types `State` and `ListCursor`. A cursor prefetches one row ahead, so the
    harness also calls `__sql_cursor_check` before it hands out each buffered
    row: a cursor leaked to another object throws on the first read, before
    any of a's rows reach it. `__sql_cursor_close` (finalizer-driven) closes a
    cursor only for the object that owns it, so one object cannot close
    another's; the cell's connection teardown sweeps the rest.
  - **`blockConcurrencyWhile`** (`op_gate_acquire`) takes the running event's
    cell, never `this._scope`: a forged scope cannot shut another object's
    input gate (celld-only refusal, there is no name to forge in workerd).
    Its per-context held map (`release_input_gate`) then names only cells this
    context took, so `op_gate_release` and the host-driven
    `__retireInputGateContext` stay correct -- a forged release finds no claim
    and is a no-op, with no scope trusted. `op_gate_wait` (the same-isolate
    RPC-stub delivery point) reaches a cell its running event need not be, so
    it is checked against the script's grant exactly as a Durable Object call
    is: a stub into another object of the script, or the Queue relay, is
    admitted; a forged cross-script scope is refused.
  - **Reset and abort** (`_abort`, `_resetAfterConcurrencyFailure`) discard a
    cell's buffered writes, delete its instance and break it. `_scope` is
    writable, so these now act only on the cell `this` is the registered
    instance of (`__cell.instances`, which user code cannot reach): a forged
    `_scope` names a cell `this` is not and clears, deletes and breaks
    nothing. The host-driven retire path reads the scope from `__cellBlocks`,
    which `op_gate_acquire` now keys by the running event, so it is authentic
    too. `__storage_cancel_pending_puts` keeps a grant check as a second
    guard and never throws, so a reset cannot fail on it.
- **Facets and loaders.** `__facet_rpc/fetch/abort/delete` take the parent
  scope from JavaScript; it must be the running event's, or they throw the
  cross-object error `(I/O type: FacetManager)`, workerd's text for another
  object's `ctx.facets`. Loader ids are a process-wide counter, so
  `__loader_fetch/rpc/drop` and `FacetHost::of` now answer only for the
  isolate that loaded the Worker (`LoaderOwner`); another isolate's id is
  "worker loader: unknown worker". `__ws_connect` takes no scope (1.21
  routes it by the running event), so it needed nothing.
- **No fleet secret for ids** (decided): the grant makes a computable id
  non-authorising, so `durable_object_id_key` stays a hash of public
  strings and the `celld kv`/`d1`/`queue` CLIs keep deriving scopes.
- **Op sweep.** Every op that takes a cell scope, cursor id, gate, facet id,
  loader id or stream/socket id from JS is bound to its owner: the Durable
  Object call and RPC ops and the peer tunnel (the grant); storage, SQL and
  list cursors, alarms, `blockConcurrencyWhile` and facets (the running
  event); `cancel_pending_puts` and `gate_wait` (the grant); WebSocket and
  body/http streams (1.21/1.26 owner maps); containers (1.27); loaders and
  loaded-worker facets (`LoaderOwner`). `__do_id` only derives an id, which
  the grant makes non-authorising; `__kv_blob` and `__queue_dispatch` take
  their cell from the running event's gate, not from JS. The TCP
  socket ops (`__tcp_*`) and the HTMLRewriter ops (`__hr_*`) were not bound
  at part A: their ids were reachable (a writable `socket._id`, a writable
  `__state` on every content token) and process-wide, so a forged id reached
  another script's connection or parked parser. 1.50 binds both to the
  request or object that made them (the 1.21 owner model) and makes the ids
  private. The RPC-signal ids (`__rpc_signal_*`) are not reachable: 64
  random bits (per process) plus a counter, held only in harness WeakMaps, never
  shown to a script, and a forged one only subscribes to a signal (1.53 has
  the marker-shaped-data gap that would carry one). `__zlib_stream_*` and
  `__r2_mp_*` ids live in closures, and `__timer_cancel` is reached only
  through the isolate's own timer map, so none takes an id a script names.
- **Docs.** `docs/security.md` "Durable Object reach"; the upgrade note.
- **Tests.** `rpc/scope-grants` (celld-only, `front` and `back`): own DO,
  `ctx.exports`, KV, Queue and D1 still work, a message whose consumer
  fails reaches `back`'s dead-letter queue (the relay), and each of these
  expects the refusal: a DO fetch and an RPC to `back`'s class through the
  `DurableObjectNamespace` constructor, `back`'s KV, Queue, dead-letter
  queue, D1 and workflow cells, another shard of `front`'s own KV, storage
  and alarm ops with a forged `_scope`, and a facet with a forged manager
  state, and `blockConcurrencyWhile` with the gate's cell forged (cross- and
  same-script, with the running object's own gate still working).
  Differential: `storage/cross-object-storage` (another object's leaked
  `ctx.storage`, and a leaked SQL cursor `(I/O type: State)` and kv.list()
  cursor `(I/O type: ListCursor)`, which at HEAD still yielded a's buffered
  rows) and `storage/cross-object-facets` (leaked `ctx.facets`). Unit tests:
  `scope_grant::tests`, `js::scope_grant_op_tests` (op refusals through V8:
  calls, storage, facets, the gate ops, the loader owner) and the peer
  tunnel's caller tests.
- **Internal signatures changed** (for `celld_internal_tests`): `DoCallReq`,
  `RpcCallReq` and `CallContext` gained `caller`; `peer_tunnel::rpc` takes
  a `&Caller`; `FacetHost::of` takes the owner.
- `rpc/rpc-refusals-internal` still passes: its `env.KV._stub` reaches its
  own KV cell, which the grant admits.

**As built (part B: internals out of user reach, runtime cells apart).**
- **What workerd shows** (probed, `env/private-state`,
  `storage/private-state`). A namespace, a KV and a Queue binding, `ctx.sql`,
  a cursor, `storage.kv`, a `kv.list()` iterator, `ctx.facets` and a
  transaction have no own properties; an id has `jurisdiction` and `name`, a
  stub `name` and `id`, `ctx.storage` `kv` and `sql`, and `ctx` `facets`,
  `container`, `storage`, `id`, `props` and `exports` (in those orders). `new
  value.constructor()` throws "Illegal constructor" for each. The D1 and
  Workflow bindings are JavaScript wrappers with public fields and
  constructors that take anything (1.55).
- **Private state** (`harness.js`, `kv.js`). `DurableObjectNamespace`,
  `DurableObjectId`, `DurableObjectState`, the storage base (root and
  transaction view), `SqlStorage`, `SqlCursor`, `SyncKvStorage`, its list
  iterator, `DurableObjectFacets`, the KV, Queue and D1 bindings (database,
  statement, session) and the Workflow binding and instance keep every field
  in private fields, and the methods that acted on them are private methods.
  Each constructor takes a module-private brand and otherwise throws
  "Illegal constructor"; the own properties are workerd's, in its order
  (`ctx.exports` is an own getter, `ctx.container` an own `undefined`
  outside `containers`, a transaction reaches `kv` and `sql` through
  prototype getters). The rest of the harness reaches them through
  accessor tables set in static blocks (`__objectState`,
  `__storageInternals`, `__doIdScope` and friends, `__facetsRelease`,
  `__d1Runners`), which no script reaches. So no scope, key, id, cursor id or
  prefetched row is readable or writable: a property a script sets is its
  own and names nothing (`rpc/scope-grants`). The runtime cells take their
  scope from their own `ctx` the same way. `#ownScope` stays: a reset of an
  instance that a reset already replaced must not touch the replacement.
- **No replaceable method on the way to a cell** (review round). A script
  could replace `getByName`/`get` on the namespace prototype (or a member
  of the stub prototype) and receive working stubs of its own runtime cells,
  since the clients resolved their stub that way. The clients now call
  `__cellRpc(class, name, method, args)`, which derives the scope with the
  namespace's private `#idFromName` and sends the RPC with no stub at all;
  the public `get`/`getByName`/`idFromName` go through private methods, and
  the harness's own lookups use `__namespaceGet`. Audit of every harness
  path that hands an internal object to a method a script can replace:
  - fixed: the KV, Queue, D1 and Workflow clients (`__cellRpc`); the Queue
    cell's dead-letter transfer (same, though its isolate has no script);
    the RPC and storage stub revival (`__namespaceGet`); `transactionSync`
    delegating to the open view and a transaction's critical section
    (`#transactionSync`, `__objectState.blockConcurrencyWhile`); the
    workflow and cron cells, which run beside the script's code, now use
    their storage through the methods captured at harness load
    (`__ownStorage`: `get`, `put`, the alarm methods, `transactionSync`, and
    `kv.get/put/delete/list`, the list answered as an array);
  - second round: the workflow and cron cells' instances and state.
    Objects' states are now in a module-private WeakMap (`__instanceState`)
    rather than an `inst.__celldState` defined through
    `Object.defineProperty`; the workflow and cron cells keep their state in
    private fields; their prototype chains, and every runtime class's, end at
    null, so a member they lack never reaches an `Object.prototype` getter
    with the instance; a runtime class's RPC method is captured at load and
    applied with the captured `Reflect.apply` (`__doRpcCall`), and the
    general RPC walk uses the captured `Object.hasOwn`, `Reflect.apply` and
    `bind`; the harness registries (`__cell` itself, `instances`, `classes`,
    `idNames`, `facetConfigs`, `namespaceKeys`, `doExports`, `entrypoints`,
    `workflows`, `containers`, `compat`, a facet's config, the Queue
    catalog) are null-prototype objects, from the host too; `ctx`'s and an
    id's own properties are class fields and a stub's target an object
    literal, so no assignment runs an `Object.prototype` setter; `ctx.exports`,
    the root storage's `kv` and `sql` and `ctx.restore` are defined with the
    captured `Object.defineProperty`; the workflow engine's storage rows
    (`__ownStorage`'s `kv.list`, now null-prototype `{ key, value }` rows) are
    walked with counted loops and sorted with the captured `sort`, its
    storage-failure tracker and driver are null-prototype literals, and its
    transaction view's fields are fields; `__cellRpc` takes the dispatch name
    from its own argument.
  - left, with the reason: the KV, Queue and D1 cells' own storage calls
    (their isolate holds no script); stubs and facets of the script's own
    classes (its own objects, and the host checks loader owner, parent and
    grant); builtins that only ever receive data (`JSON`, `String`, array
    iterators, `Promise.resolve`).
- **Marker-shaped data naming a runtime class.** A KV, Queue, D1, workflow
  or cron cell's stub is never handed to a script, so none is ever lifted;
  `__stubRevive` and `__storedRevive` now revive a `__celld$do` marker that
  names one as the plain data it is (as workerd delivers it,
  `rpc/runtime-cell-marker`). At HEAD such data, beside a Headers in an RPC,
  revived as the cell's stub, the one route to its methods left once
  `_stub` went. The general marker gap stays 1.53.
- **Runtime cells in an isolate of their own** (`generation.rs`,
  `WorkerConfig::runtime_cells`). The shared reserved classes (KV, Queue, D1)
  are no longer registered with the first script that names them: the
  build collects them and registers them with one config, script
  `deploy::RUNTIME_SCRIPT` (`__runtime`, which `valid_script_name` cannot
  produce; a co-hosted manifest that uses it is refused), whose module is
  a bare default export and whose `WorkerOrigin::Runtime` config has no
  binding, var or service, the deployment's consumer catalog (only these
  isolates host a Queue cell, so user configs no longer get it) and a fixed
  compatibility (`NEWEST_DATE`, no flags: the cells are celld's code). Its
  cells get their own pool under `__runtime` in `cell_isolates`, so a
  script's replaced builtins never run in their events
  (`env/runtime-cells-isolate`: a script that zero-fills
  `crypto.getRandomValues` and fixes `randomUUID` still gets random, distinct
  message ids; at HEAD every id ended in that script's zeros). Workflow and
  cron cells stay with their script, which they belong to. Cost: one more
  isolate pool per generation that binds any KV, Queue or D1 (one isolate
  with the harness, about what an empty Worker costs), reclaimed like any
  cell pool; `/state` lists it as `cells.__runtime`. Cell storage is keyed by
  scope, so no stored layout moves, and the tunnel carries the runtime
  cells' calls as `script:__runtime`, which needs no version change (7 has
  not shipped).
- **Grants.** `ScopeGrant::runtime_cells(catalog)` is the runtime isolate's
  grant: the Queue relay (every consumed queue and its dead-letter queue,
  from a Queue cell's event) and nothing else, marked `runtime`. A script's
  grant no longer has a relay (`GrantSource.consumed_queues` is gone): its
  code never runs in a Queue cell's event. `Generation::grants` holds the
  runtime grant under `__runtime`, so node B resolves a forwarded relay call
  to it (`node_b_admits_the_runtime_cells_relay_only`).
- **Operator handlers.** `Caller::admit_fetch` refuses a script's fetch or
  WebSocket upgrade to a KV, Queue or D1 cell, whatever its grant ("Durable
  Object <scope> is a KV, Queue or D1 cell, which answers fetch() only on
  celld's authenticated /runtime/ route"): at the op (`admitted_caller(..,
  fetch)`), in `dispatch_call_attempt` and on node B
  (`dispatch_forwarded_fetch`). Only `Caller::Host` fetches them: the
  `/runtime/` route and Queue settlement (`/__qSettle`).
- **Internal cell-to-cell path.** `__runtimeClass(name, cls, binding,
  internal)`: `__queueDlqAcceptBatch` (dead-letter transfer and redrive) is
  internal and on no binding's list. `Caller::internal()` (the host, or the
  runtime grant) rides `CellJob::Rpc.internal` into
  `__dispatchRpc(scope, method, args, internal)`, and `__doRpcCall` answers
  an internal method only to an internal call; a binding's call gets "does
  not implement the method". The relay above is still exactly the reach that
  path needs: a Queue cell's event, the catalog's Queue cells.
- **Validation in the cells.** Each binding method checks again, with the
  binding's own error text, before it touches storage:
  - KV `__kvGet`/`__kvDelete`: an array of 1-100 string keys, each 1-512
    bytes. `__kvPut`: 1-100 entries; key as above; value bytes up to 25 MiB;
    tag `text` or `bytes`; metadata `null` or JSON text up to 1024 bytes;
    expiration `null` or whole milliseconds after the cell's clock.
    `__kvList`: string prefix and cursor, limit 1-1000. The cell's clock
    replaces the `now` the binding sent (which a caller could set to read
    expired keys). The operator route calls the same reads and writes
    (`_get`, `_put`, `_delete`, `_list`) with its own checks, and now refuses
    a tag other than `text` or `bytes` too.
  - Queue `__queueSend`: 1-100 entries; bytes body; content type `text`,
    `bytes`, `json` or `v8`; declared size equal to the body's, at most
    128000; delay 0-86400; the batch at most 256000 bytes.
    `__queueDlqAcceptBatch` (internal): 1-100 transfers, UUID transfer and
    message ids, a string or `null` dead-letter source, and each body
    checked as a send's (a stored body arrives as an ArrayBuffer).
  - D1 `__d1Query`/`__d1Batch`: an array of statements with SQL text and an
    array of binds (the engine already checks each bind and every cap);
    `__d1Exec`: SQL text. No coercion of what a caller sent.
  - Workflow `__wfCreate` (`__wfCheckCreate`): a bound workflow name, a
    valid instance id, the binding's normalized retention (whole
    milliseconds up to 30 days) and location hint, and the instance the
    cell is (`<workflow>/<instance>`). `__wfSendEvent` and `__wfRestart`
    already checked; the others take no arguments.
  - Tested in `js::runtime_cell_tests::a_runtime_cell_checks_what_a_binding_sends`
    (each refusal, and a call past the checks reaching storage), since no
    script reaches a cell's methods any more.
- **JSON-null peer RPC.** A peer's JSON `null` arguments call with none
  again, as before 1.28.
- **`rpc/rpc-refusals-internal`.** Its `/runtime` step now checks that no
  binding, session or statement has a property its stub was once read
  through; the runtime cells' method refusals moved to
  `js::runtime_cell_tests::a_runtime_cell_answers_a_binding_only_its_methods`.
- **Docs.** `docs/security.md` "Durable Object reach" (no route to a runtime
  cell, the checks in the cell, no operator handlers, the isolate of their
  own); `docs/README.md` `/state` (`cells.__runtime`); the D1 and Workflow
  shape differences in `docs/services/d1.md` and `workflows.md`.
- **Tests.**
  - Differential: `storage/private-state` and `env/private-state` (the own
    properties and "Illegal constructor" above, and the parts still work),
    `rpc/runtime-cell-marker`. xfail (1.55): `env/wrapper-binding-state`,
    `storage/cursor-rows-written` and `env/class-names`.
  - celld-only: `rpc/scope-grants` rewritten (constructors refused, no
    scope-shaped state, a forged property ignored, the relay's dead-letter
    transfer still works), `env/runtime-cells-isolate`, and
    `rpc/rpc-refusals-internal`'s `/runtime` step, and
    `env/patched-prototypes` (a script replaces the namespace's `get`,
    `getByName`, `idFromName` and `idFromString`, the stub prototype's cell
    methods, and the storage, `kv` and state methods, then uses KV, Queue,
    D1 and a workflow: no replacement sees a receiver that is not the
    script's own; it also replaces `Object.defineProperty`, `hasOwn`,
    `create`, `assign`, `Reflect.apply` and friends at module scope and puts
    setters on `Object.prototype`, and none receives a workflow or cron
    cell's instance, ctx or storage. With `_instance` defining one property
    through `Object.defineProperty` again, the case fails). Every one of these fails at HEAD except the xfails.
  - Unit: `scope_grant::tests` (`a_script_cannot_fetch_a_runtime_cell`,
    `only_the_host_and_the_runtime_cells_call_internal_methods`, the relay on
    the runtime grant only), `generation::tests` (placement, no runtime
    cells without the classes, the reserved name refused),
    `js::runtime_cell_tests` (the isolate holds no script; the internal
    allowlist and JSON null; the checks above;
    `a_scripts_op_call_reaches_the_cell_through_the_host`, which drives
    `op_rpc_call` through the host channel, `Caller::internal`,
    `CellJob::rpc` and `drive_cell` into the runtime cells' isolate: a
    script's `__queueDlqAcceptBatch` and `__kvSweep` refused in the cell, an
    oversized key refused in the cell, another shard refused at the op, the
    operator fetch refused at the op, and the runtime cells' own transfer
    from a Queue event reaching the method),
    `js::scope_grant_op_tests::a_runtime_cells_operator_handler_is_refused_to_a_binding`,
    and the peer tunnel's `node_b_admits_the_runtime_cells_relay_only`.
- **Internal signatures changed** (for `celld_internal_tests`):
  `CellJob::Rpc` gained `internal`; `RuntimeManager::rpc` takes the
  `&Caller`; `__dispatchRpc` takes `internal`; `GrantSource` lost
  `consumed_queues`; `CellJob::rpc` builds an RPC job from its caller;
  `pool::Slot::for_test` exists under `cfg(test)` too; the harness classes
  above take a brand first; the KV binding takes a `call(method, args)`
  instead of a namespace thunk; the KV
  cell's reads and writes are `_get`/`_put`/`_delete`/`_list`, and its RPC
  methods take no `now`; `SqlCursor` has no `columns`, and `rowsRead`,
  `rowsWritten` and `reusedCachedQueryForTest` are getters.
- **Verification** (after the second review round). fmt, `git diff --check`,
  clippy `-D warnings`, `cargo test --workspace` (272 lib tests, 33 and 4 in
  the other crates) and the lab build are clean. Conformance
  `--runtime=both` with `CONFORMANCE_REQUIRE=docker`: 160 PASS, 25 XFAIL,
  exit 0 (was 155 and 22). Starter e2e `all --fresh --quick` matches the
  baseline (exit 1 for the expected failures, no "dropped a frame");
  integration exits 0, `workshop-user-directory` passes, no first error
  changed.
- **Remaining.**
  - An end-to-end two-node test of the forwarded-caller refusal (node B 403
    / handler failure, node A surfaces it): unit-tested only, as part A
    noted; the repo has no cheap two-node harness.
  - The harness's own code in a script's isolate still passes data (never
    a cell, stub, namespace or storage object of celld's) through that
    script's builtins; capturing those primordials is hardening, not
    authority.
  - 1.55 (the differences found here).

### 1.50 TCP socket and RPC-signal ownership (found by the 1.49 review) — security

**Problem.** The TCP socket registry (`js/tcp.rs` ~39-57) is process-wide
and keyed by a global counter, and `op_tcp_read`, `write`, `shutdown`,
`close` and `starttls` (~196-290) check no owner. `sockets.js` (~64-200)
keeps the id in a writable `socket._id` and reads it again on every pull
and write. So a Worker that sets its own `Socket`'s `_id` to another
script's open connection (a database session, say) can read, write, close
or upgrade it. Dynamic Workers included. Found by reading the code; not
reproduced (it needs an external TCP peer). The RPC-signal ops
(`__rpc_signal_*`) hold process-wide ids too and were not traced.

**Design.** As 1.21 did for WebSockets: record the owner (the opening
request or cell context) when a socket is opened, check it in every
`__tcp_*` op, and refuse loudly otherwise. Keep the id private (closure or
private field). Trace `__rpc_signal_*` and apply the same model if its ids
are reachable across scripts or requests.

**Tests.** Celld-only cases that expect the refusal: a socket whose id names
another request's or script's connection (using a local TCP echo upstream
from the corpus libs), and the same for RPC signals if they prove reachable.
Unit tests on the owner check.

**As built.**
- **What workerd does** (probed, `sockets/cross-request-socket`). A socket
  is an I/O object of the request or Durable Object that opened it.
  - From another request, whether the opening request still runs
    (`waitUntil`) or has ended: a read, a reader's read or `cancel()` throw
    the cross-request error `(I/O type: ReadableStreamSource)`; a write and
    the writer's `close()` `(I/O type: Writable)`. `opened` resolves,
    `closed` stays pending, `getReader()` works, `close()` resolves and
    `startTls()` returns a Socket.
  - From another Durable Object in the isolate: reads and `cancel()` throw
    the cross-object error; writes and the writer's `close()` never settle.
  - The object that opened a socket uses it in its later events (write,
    read, echo, close all work). So the owner unit is 1.21's `WsOwner`: the
    request (`handoff_request`), or the object or facet (`Cell(scope)`), as
    for WebSockets and bodies. celld closed a socket at the end of the event
    that opened it, so this is a fix as well as a refusal.
  - `Object.keys(socket)` is empty and `new socket.constructor()` throws
    "Illegal constructor".
- **Host** (`js/tcp.rs`). Each `TcpSocket` records its owner, taken from
  the running event when the id is allocated (`allocate`), before the
  connection exists; the halves are filled in by `attach` once it does, and
  an id freed meanwhile drops the stream. `access(id, owner)` answers
  Owned, Unknown or Other; every op (`read`, `write`, `shutdown`, `close`,
  `starttls`) refuses Other synchronously with `foreign_io_error` (I/O type
  `Writable` for write and shutdown, `ReadableStreamSource` for the rest),
  before touching the connection; `starttls` refuses before it consumes the
  plaintext socket. Unknown answers as before ("socket is closed").
  - **Lifetime.** A request's ids are tracked on its context and freed at
    retirement, as before. An object's are not: `tcp::release_cell` closes
    every socket a cell (or each of its facets) owns, called from
    `finish_cell_adoption` on both edges of the residency, beside
    `ws_release_grants`, before the script's release snippet and whatever
    that returns; the facet loop releases every facet's host side even if
    one facet's snippet fails, and answers with the first failure.
  - **Collection.** A `Socket` the isolate collects closes its connection,
    as in workerd: `sockets.js` registers each opened socket's id in a
    FinalizationRegistry, whose callback calls `__tcp_collect(id)`. That op
    checks no owner, because a finalizer runs in no event of the owner's;
    the id comes only from the registry, which no script reaches. So an
    object that connects in every event and drops the socket holds none.
  - **Cancellation.** Each `TcpSocket` holds a `watch::Sender` that drops
    with the entry; every op future (connect and its handshake, read, write,
    shutdown, starttls) runs under `until_closed`, a `select_biased!` on its
    receiver, so freeing an id (retirement, release, collection, close)
    ends an op still waiting on it and the halves it held go: a read parked
    on a silent peer no longer keeps an evicted object's connection open.
  - **Failure.** `Unattached` frees an allocated id unless its op attached a
    stream, so a failed or cancelled connect or handshake leaves nothing.
  - **Cap.** A new connection is refused once its owner holds
    `CELLD_MAX_TCP_SOCKETS` (default 32, validated at startup with the
    other limits): "celld refused connect(): this Durable Object already
    holds 32 open TCP sockets, the most CELLD_MAX_TCP_SOCKETS allows. Close
    one first." (or "this request"). Because a dropped `Socket` closes only
    when V8 collects it, a connect-and-drop-per-event loop would otherwise
    hit the cap on sockets already unreachable (the reviewer saw 13 spurious
    refusals after 32). The slot is reserved synchronously in the op,
    counted and inserted under one registry lock (`try_reserve`), so the
    connects of one turn cannot overshoot (the third review opened 100 with a
    cap of 32 when the count and the insert were apart). At the cap the op
    forces a collection (`sweep_for_cap`) at most once per isolate per
    100 ms (`SWEEP_WINDOW`), and the async connect waits up to that window
    for the end-of-turn finalizer sweep, taking a freed slot under the same
    lock (`reserve_after_sweep`), so only as many waiters proceed as slots
    came free. A connect that shared an earlier sweep and still found no
    slot answers an internal `SWEEP_AGAIN`; `sockets.js` calls
    `__tcp_connect` once more in a later turn, where a sweep of its own is
    due, and that attempt answers the connection or the refusal. So 300
    connects at the cap cost at most two collections, a window apart (the
    review measured 300 back-to-back GCs before). The collection is
    `low_memory_notification`: a critical memory-pressure notification,
    which would keep the compilation cache, left the dropped sockets
    uncollected (the connect-and-drop step was refused), and a plain full GC
    needs `--expose-gc`. A refusal therefore means the cap's worth of
    sockets are genuinely reachable. workerd run locally enforces nothing (probed: 40
    opened at once in one request); Cloudflare documents six simultaneous
    connections per invocation, the rest queued until one closes. A queue
    would hold an object's events open on someone else's socket, so celld
    refuses loudly instead, and `docs/limitations.md` notes a refusal means
    32 are still reachable. The socket `startTls()` makes replaces one and
    is not counted.
- **Harness** (`js/sockets.js`). All `Socket` state is in private fields,
  the host id included; the constructor takes a module-private brand and
  otherwise throws "Illegal constructor". The readable is an internal
  stream (one read in flight) and both streams are `__streamIo.own`ed, so
  the refusals above come from 1.26's registry with workerd's text. `own`
  gained `objectPends`: another object's write, close and abort of the
  writable return a promise that never settles. Another owner's `close()`
  resolves and touches nothing. Another owner's `startTls()` changes none
  of the socket's state: as workerd does (probed), it leaves the owner's
  writable locked and returns a Socket whose `opened` never settles and
  whose writes reject with the readable's I/O error.
- **HTMLRewriter** (traced as part of the sweep, and reachable). Content
  tokens kept the rewriter id in a writable `__state`, and `__hr_*` checked
  nothing, so a handler that set `element.__state.id` to the id before its
  own sent commands into another script's parked parser (reproduced at
  HEAD: back's output gained front's attribute). Now `#state` is private in
  each token class, every `__hr_*` op checks the rewriter's owner
  (`WsOwner`, recorded at `__hr_create`) and refuses another's with the
  cross-request text and I/O type `HTMLRewriter` (celld's: workerd has no id
  to forge). A request's rewriter is tracked on its `event_context` and
  freed at retirement; a Durable Object's lives with the cell
  (`html_rewriter::release_cell`, beside the TCP release), so a later event
  reads a transform an earlier one made (`builtins/html-rewriter-object`,
  differential: it said "HTMLRewriter is gone" when the event that made it
  ended). An unread transform does not grow: the pump reads the source only
  on a credit, which the parser's event loop grants each time it has drained
  the ready events and wants more input, and only while the output readable
  has room (`desiredSize > 0`). Without a consumer the readable fills and no
  credit is granted, so the source parks -- one chunk in the parser, not the
  whole source. This is workerd's parser backpressure; before it, a Durable
  Object's unread transform of an endless source grew to the isolate's
  memory limit (`builtins/html-rewriter-endless`). The creating event still
  returns (the parked pump is background work), and a pull resumes the
  credits when a later event reads.
- **RPC signals and the other handles.** See 1.49's Op sweep: signal ids are
  64 random bits (per process) plus a counter, kept in harness WeakMaps and
  never shown to a script; a forged one could only subscribe (`wait`,
  `poll`), and needs the 1.53 marker gap to be named at all. zlib and R2
  multipart ids are closure-held; timers are reached only through the
  isolate's own map. None is bound further.
- **Continuation identity for stateless requests (1.52, done here).**
  celld ran a stateless request's continuation that another request's turn
  resolved as that other request: only cell events had a continuation id
  in CPED, so `event_context` fell back to the thread's current context.
  With the owner checks above, a module-scope single-flight promise
  (`token ??= fetch(...)`) awaited by a later request left that request
  refused its own socket and transform (bodies had the gap since 1.26).
  Now every invocation context is one V8 captures: `IoContext::invocation`
  allocates a continuation id and registers the context in the isolate's
  `io_contexts`, for a fetch (`begin`), an entrypoint RPC and a queue batch
  as `tracked` already did for cell events (which now builds through it).
  Each of those `begin`s installs the id with `install_io_context` before
  the handler runs, and `turn_begin` restores CPED after `begin` returns,
  as every later turn (`turn_deliver`, `cancel_turn`) already did for any
  context with an id. So a reaction V8 runs during another request's
  checkpoint resolves to its own request, and the ops it enqueues go to
  that request's driver through the `handed` mailbox (`adopt`), the path
  cell events already used. A continuation whose request has retired finds
  no context and runs as the current one, as before.
- **Docs.** `docs/security.md` "TCP socket ownership" and "HTMLRewriter
  ownership"; `docs/cloudflare-compat.md` TCP sockets (a socket lives
  across a Durable Object's events and closes when collected; the 1.51
  differences; the cap); `docs/limitations.md` "TCP sockets" (the cap, and
  reconnecting after an eviction); `docs/README.md` `CELLD_MAX_TCP_SOCKETS`.
- **Tests.**
  - `sockets/cross-request-socket` (differential): the shape, each use from
    a later request while the opener runs and after it ended, the opening
    object's later event, and another object. At HEAD every step but the
    openings fails.
  - `sockets/forged-socket-id` (celld-only, `front` and `back`): asserts
    the private state (a Socket has no `_id` and no own properties), sets an
    `_id` anyway, and writes and closes. Front reads its own echo, and
    back's connection (held by a request, then by a Durable Object)
    receives nothing and stays open. At HEAD, front's `_id - 1` named back's
    connection, which received "forged" and was closed. Now no script can
    hand the host an id, so the host's own refusal is covered by the unit
    tests below, not by this case.
  - `builtins/html-rewriter-forged-token` (celld-only): the same for a
    token's `__state` (asserted absent). At HEAD back's document gained the
    attribute.
  - `streams/cross-request-continuation` (differential, was the 1.52 xfail)
    and `streams/single-flight` (differential): a later request's code
    after awaiting a promise an earlier request settles uses its own
    socket, fetched body and HTMLRewriter transform.
  - `builtins/html-rewriter-object` (differential): a Durable Object reads
    in a later event the transform an earlier one made.
  - `sockets/object-eviction` (celld-only, `CELLD_IDLE_EVICT_S=1`): an idle
    socket and one with a read waiting are both closed once the object is
    evicted (the `sockets` step counts the echo connections), and the next
    request finds a new instance. With the cancellation removed the case
    fails (`1 more, past 0`), so it also shows `finish_cell_adoption`
    reaching `release_cell` on eviction.
  - `sockets/socket-cap` (celld-only, `CELLD_MAX_TCP_SOCKETS=3`): a request
    and a Durable Object each open three, the fourth is refused with the
    text above, and one more opens after a close; then a Durable Object that
    connects and drops the socket in forty successive events is refused
    none, which the sweep is what makes true; and five connects started in
    one turn and kept open three and refuse exactly two.
  - `builtins/html-rewriter-endless` (celld-only): a Durable Object makes a
    transform of an endless source and never reads it; a later event still
    answers, the node stays idle (`cpu`) and memory bounded (`rss`). Without
    backpressure this grew to the limit.
  - Collection is not in the corpus: no build a case runs exposes `gc()`.
    `__tcp_collect` is unit-tested.
  - xfail: `sockets/foreign-close` (1.51), `rpc/marker-shaped-data` (1.53).
  - `lib/upstream.mjs` has a TCP echo server on a third port,
    `${UPSTREAM_ECHO_PORT}`.
  - Unit: `tcp::tests::a_socket_answers_only_its_owner` (owner, other,
    object flag, unknown, `release_cell`) and
    `a_socket_id_is_refused_to_code_that_does_not_own_it` (every op through
    V8, from another request, a cell, a second isolate, and another object;
    the owner, in any of its events, still reads and closes; a collected
    id closes from another owner's event), `freeing_a_socket_ends_its_ops`,
    `an_unattached_id_is_freed`, `reservations_stop_at_the_cap`,
    `waiters_take_only_the_freed_slots` (five waiters, two freed slots: two
    proceed), `a_burst_at_the_cap_forces_one_sweep` (300 connects through
    V8 at the cap: one forced collection);
    `html_rewriter::tests::a_rewriter_id_is_refused_to_code_that_does_not_own_it`
    (also: an object's transform goes with `release_cell`, a request's with
    its retirement).
- **Internal signatures changed** (for `celld_internal_tests`): `tcp`
  gained `release_cell` and the op `__tcp_collect`; `html_rewriter` gained
  `release_cell`; `__streamIo.own(stream, kind, objectPends)`; the `Socket`
  constructor takes a brand first; `IoContext::invocation` builds every
  stateless invocation's context (registered in `io_contexts`), and
  `tracked` goes through it.
- **Verification.**
  - `cargo fmt --check`, clippy `-D warnings` and `cargo test --workspace`
    (262 lib tests, 32 and 4 in the other crates) are clean, and so is the
    lab build.
  - Conformance `--runtime=both` with `CONFORMANCE_REQUIRE=docker`: 155
    PASS, 22 XFAIL, exit 0 (was 146 and 19). `cross-request-socket`,
    `forged-socket-id` and `html-rewriter-forged-token` fail at HEAD;
    `object-eviction` fails without the cancellation.
  - Starter e2e `all --fresh --quick` matches the baseline: S0, S1, S2, S9,
    S11, B0 and B6 pass, exit 1 for the expected failures, no "dropped a
    frame".
  - Integration exits 0; `workshop-user-directory` passes and no first
    error changed.
- **Found.** 1.51, 1.52 (done here), 1.53, 1.54.

### 1.51 TCP socket follow-ups (found by 1.50)

Probed in workerd; each is in `sockets/foreign-close` (xfail).
- Another request's `close()` resolves, and then the socket's `closed`
  rejects with the cross-request error `(I/O type: ReadableStreamSource)`
  while the opening request runs (it never settles once that request has
  ended). Another object's `close()` leaves the owner's `closed` rejected
  with the cross-object error and its writable "belongs to an object that
  is closing". celld's foreign `close()` touches nothing.
- (Matched in 1.50: another owner's `startTls()` returns a Socket whose
  `opened` never settles and whose writes are refused `(I/O type:
  ReadableStreamSource)`, and leaves the owner's writable locked.)
- The owner's own `startTls()` resolves `opened` before the handshake; a
  peer that does not speak TLS then fails the first write with "Network
  connection lost.". celld's `opened` waits for the handshake and rejects
  with the rustls error.
- `getWriter()` on a locked writable says "This WritableStream is currently
  locked to a writer."; celld's says "WritableStream is locked".

### 1.52 Continuations resolved by another request (found by 1.50) — done as part of 1.50

workerd runs a request's continuation as the request that created it, even
when another request's code resolved the promise. celld's stateless
contexts carried no continuation id in CPED, so the continuation ran as the
resolving request and was refused its own fetched body (1.26), TCP socket
and HTMLRewriter transform (1.50). Done in 1.50 ("Continuation identity for
stateless requests"): every invocation context now has one.
`streams/cross-request-continuation` and `streams/single-flight` pass.

### 1.53 Marker-shaped data in RPC payloads (found by 1.50) — security, low

`__stubRevive` recognises celld's markers (`__celld$hdr`, `$blob`, `$sig`,
`$stub`, `$svc`, `$do`, `$rs`, `$ws`, `$req`, `$res`, `$disp`) by key in any
plain object of a lifted payload, and `__stubLift` passes a script's plain
objects through unchanged. So data shaped like a marker revives as a
Headers, a Blob, a signal or a stub when the payload also carries a value
that needs the lift. workerd delivers it as the plain object
(`rpc/marker-shaped-data`, xfail; celld's signal row fails as a corrupt
payload). Reach: a forged `$sig` subscribes to the signal it names, but a
signal id is 64 random bits (per process) plus a counter, never shown to a
script (1.50); a forged `$stub` names an entry of the
same isolate by its counter and `__stubIsolate`, a `Math.random()` token.
Escape a script's plain objects whose keys collide with a marker in the
lift, or carry markers out of band.

**As built (done).**
- **Design: escape the keys.** In a lifted tree (RPC envelopes 0x01 and
  0x02, a stored stub row, a Worker Loader env) every marker is a plain
  object literal whose *first* key starts with `__celld$` and a character
  other than `$`; `__celld$disp` beside a plain object's keys carries its
  disposer. The lift gives a script's key that starts with `__celld$` one
  more `$` after the prefix (`__celld$x` -> `__celld$$x`, `__celld$$x` ->
  `__celld$$$x`) and the revival removes it, so the escape is a bijection
  whose image never holds a marker key, and the receiver tells a marker
  from data by its first key alone. Chosen over out-of-band markers (a
  side list of paths, or V8 host objects through the serializer delegate)
  because it is one rule in JS on both ends, local to each object, and
  costs nothing on the plain path: plain data still crosses as one V8
  clone (0xff) with no walk on either side, and a lifted tree pays two
  string comparisons per key (a key starts with `__celld$` exactly when it
  sorts in `["__celld$", "__celld%")`, which calls nothing a script can
  replace). Only plain objects are ever markers: arrays, Maps, Sets and
  host objects are never interpreted (the lift leaves Map and Set contents
  to the clone, and the revival does not walk them), so their keys need no
  escape. A tree object with an unescaped `__celld$` key other than a
  marker's or `__celld$disp`, or a marker kind the tree cannot hold, is
  refused with "corrupt RPC or storage payload" (no lift writes one).
- **Paths.** `__stubLift`/`__stubRevive` (RPC args and results: same
  isolate, cross-isolate, peer tunnel, service bindings, ctx.exports, DO
  and facet RPC, loader RPC and props), `__storedLift`/`__storedRevive`
  (`ctx.storage` get, get-many, list, and `storage.kv` get and list), and
  the Worker Loader env (which refused the key `__celld$loaderSvc` with a
  DataCloneError; workerd delivers it). The two revivals share one walker,
  `__reviveLifted`. Queue bodies, Workflow params, step outputs, events
  and outputs, and WebSocket attachments are plain clones that no revival
  reads; `structuredClone` uses its own host-object brand
  (`op_structured_clone`), not markers. No Rust code reads a marker key.
- **The runtime-cell special case** (1.49 part B) is gone: data can no
  longer pose as a `__celld$do` marker, and no lift writes one for a
  runtime class. `rpc/runtime-cell-marker` still passes.
- **`__stubIsolate`** is 128 bits from the host CSPRNG (`$$randomValues`,
  drawn before any script runs) instead of `Math.random()`. It is no
  authority any more (only a lift writes a marker); it only keeps another
  isolate's marker from naming a local entry.
- **Host values by brand (review round).** The escape covers only the
  objects the lift copies, and the lift used to pick them by prototype
  (`instanceof`), while V8's serializer writes any ordinary object as a
  plain object: `Object.create(Date.prototype)` or
  `Object.create(Headers.prototype)` holding a marker key crossed unescaped
  and revived as a marker, in the same isolate and, over a service
  binding, in the callee's (a stub of the callee's own class); a class
  instance in a stored stub row, or in a Worker Loader env, did the same.
  Every envelope now classifies by brand (`__hostKind`, `__TYPE_*`):
  V8's own type checks (`op_util_type_flags`, which gained
  `is_wasm_module_object`) for builtins, and a private-field brand for each
  of celld's host classes (`Headers`, `Blob`, `File`, `Request`,
  `Response`, `ReadableStream`, `WritableStream`, `AbortSignal`,
  `RpcTarget`, `CryptoKey`), exported from a static block. Only a Proxy is
  still classified by the prototype chain it presents, as workerd does.
  - RPC (`__rpcProject`, `__stubLift`): a genuine host or cloned builtin
    crosses as itself, a Map or Set is copied, a plain object or array is
    copied and escaped, and any other object is refused with workerd's
    text, `Could not serialize object of type "<constructor name>". This
    type does not support serialization.` (probed: a class instance names
    its class; `Object.create` of `Date`, `RegExp`, `Map`, `Error`,
    `Array`, `Headers`, `Blob`, `Request`, `AbortSignal` and
    `ReadableStream` prototypes names that type; of `RpcTarget.prototype`,
    `"JsRpcTarget"`; a null prototype, `"Object"`). An object read through a
    Proxy, which the projection does not walk, is classified the same way
    in the lift (it was left to the clone unescaped). A Proxy presenting
    neither a plain object nor an RpcTarget, a null prototype included,
    gets workerd's proxy error. `Object.create(RpcTarget.prototype)` is no
    RpcTarget any more (1.29's brand item).
  - Storage (`__storedLift`): every object V8 writes as a plain object is
    copied and escaped, whatever its prototype, as workerd stores it
    (probed: each shape above reads back as a plain object). The brand
    check runs only off `Object.prototype`, since it costs an op per object,
    so a Proxy presenting a plain object is copied through its traps in a
    stub row, where workerd's clone refuses it (workerd stores no such row).
  - Worker Loader env: classified as RPC is, with workerd's refusals
    (probed: the same texts), and V8's clone error is a DataCloneError
    there, as in workerd.
  - Queue bodies and Workflow values are plain clones (no revival), and
    workerd queues each shape as a plain object, as celld does.
- **Host instances never reach the clone (second review round).** celld's
  host classes are JavaScript classes, which V8 writes as plain objects of
  their own keys: only an own, deletable function property (`__celldHost`)
  failed the clone. A Headers stripped of it and given marker keys, left to
  the clone in a lifted tree (across isolates, in storage, in a Loader env),
  revived as a marker. Now:
  - A lifted tree never hands a host instance to V8. A value crosses as a
    marker built from its state on every transport (`__hostValueMarker`):
    a Headers' entries from its list (`__celld.__headerPairs`, not its
    iterator), a Blob's bytes and type, a Request's or Response's parts and
    headers; a body as bytes, or as a stream handle within an isolate. So
    Headers, Blob, Request and Response now cross isolates by value, as in
    workerd, and storage and a Loader env store or pass them
    (`__hostValueOutsideRpc`, revived by `__reviveHostValue`), as workerd
    does (probed). What workerd refuses, celld refuses with its text: a
    File and a CryptoKey everywhere (`Could not serialize object of type
    "File"`); outside RPC a stream, and a Request or Response with a body
    (`ReadableStream can only be serialized for RPC.`, `WritableStream ...`)
    and an AbortSignal (`AbortSignal serialization is not enabled.`). A
    stream (or streamed body) across isolates is celld's own refusal ("RPC
    streams cannot cross isolate boundaries yet.", plan 7.1). An RpcTarget
    in storage keeps celld's text (workerd's is "Remote RPC references can
    only be serialized for RPC."), and a Proxy presenting one gets it too
    (it had become V8's TypeError). A File no longer crosses RPC (it did,
    as a File marker; workerd refuses it).
  - A payload holding a host instance skips the plain clone
    (`projected.host`), so a stripped one cannot cross as a plain object
    either. The poison is fixed (non-writable, non-configurable) on Headers,
    Blob and AbortSignal, so storage's plain clone fails for them too.
  - A stored array keeps its holes and named keys, as workerd stores it
    (probed), and the revival walks an array's named keys.
- **Every marker field from the value's own state, checked again on
  revival (third review round).** A Request's `_bodyBytes` and a Blob's
  `_bytes` were writable own properties the lift sent as the body, and the
  revival revived any non-bytes body: `r._bodyBytes = { "__celld$do": ... }`
  minted a stub of the receiver's own class, and a Blob marker forged its
  body and type. Now:
  - A Request's and Response's buffered body and a Blob's bytes and type are
    private fields (`#bodyBytes`, `#bytes`, `#type`), reached through
    `__bodyBytesOf`, `__setBodyBytes`, `__blobBytesOf` and `__blobTypeOf`;
    a Blob's `size` and `type` are prototype accessors, as in workerd (they
    were own properties). A property a script names `_bodyBytes`, `_bytes`
    or `type` is its own and changes nothing that crosses, as in workerd.
  - A Request's and Response's other attributes (url, method, redirect,
    status, statusText, cf, headers, body) stay own properties in celld
    (1.36's accessors item), so the lift checks each one's type (strings,
    an integer status, a plain-object `cf`, a branded Headers, a branded
    stream body) and refuses the value otherwise. What a script defines
    over them crosses, where workerd ignores it:
    `rpc/marker-shaped-host-attributes` (xfail 1.36; passes since 1.36
    items 8–15).
  - The revival (`__reviveHostValue`) checks every field's type again, and
    a body is null, a Uint8Array (by V8's type check, a new
    `op_util_type_flags` bit) or, over RPC, a stream marker the lift built
    (first key `__celld$rs`); anything else is "corrupt RPC or storage
    payload: a malformed `<kind>` marker."
  - Storage and a Loader env refuse a Request or Response with any body,
    buffered or not, as workerd does.
  - A class made non-extensible after its prototype was replaced throws a
    fixed TypeError when constructed ("Failed to construct 'File': its
    prototype was replaced and it was made non-extensible."), and one made
    so during `super()` keeps the prototype the script set last.
  - The stored lift walks an array by index when it has every index and
    nothing else, and by key otherwise.
- **Brands a script cannot stamp (second review round).** A derived class's
  `super()` calls the class's current [[Prototype]], so `Object.setPrototypeOf(
  File, function () { return target; })` had `new File()` install `#name` on
  `target`, which then classified as a File; the same held for
  `AbortSignal`'s brand, and for the private state of `WebSocket` (1.21), a
  body stream's id (`CelldHttpBodyStream`, 1.8/1.26) and the body streams'
  internal registration, and the storage objects. Each derived host class
  records its real base (`__recordBase`) and runs `super()` between
  `__pinBase` and `__unpinBase`, which point it at that base for the call
  and then restore the script's prototype (so the change stays visible, as
  workerd's constructors stay extensible, and every instance is one its base
  really built). Audit:
  - pinned: `File`, `AbortSignal`, `WebSocket`, `CelldChunkStream`,
    `CelldBodyStream`, `CelldHttpBodyStream`, `DurableObjectStorage`,
    `DurableObjectTransaction`;
  - base classes, whose fields only their own allocation gets: `Headers`,
    `Blob`, `Request`, `Response`, `ReadableStream`, `WritableStream`,
    `RpcTarget`, `CryptoKey`, `EventTarget`, `DurableObjectState`, the
    storage base, `Socket` (1.50), `HTMLRewriter` (1.50), and the 1.49 part B
    classes;
  - WeakMap and WeakSet brands (`__stubMeta`, `__svcMeta`, `__doStubMeta`,
    `__outboundMeta`, `__rpcSignalMeta`, `__rpcStreamMeta`,
    `__instanceState`, `__durableClassMeta`): filled by harness code for
    objects it made (Proxies or base-class instances), never by a derived
    constructor;
  - derived classes with no private state or brand, where a redirect only
    changes which object a constructor writes data onto: the `Event`
    subclasses, `DOMException`, `NonRetryableError`, `RpcPromise`,
    `MessagePort`, `EventSource`, `DigestStream`, `FixedLengthStream`,
    `ByteDefaultReader` (1.56).
- **Primordials on these paths.** The lift, both revivals, the projection
  and the loader env walk use captured `Object.keys`, `getPrototypeOf`,
  `defineProperty`, `Array.isArray`, `Array.prototype.push` and the
  WeakMap/Map methods on `__stubMeta`, `__svcMeta`, `__doStubMeta`,
  `__outboundMeta`, `__stubEntries` and their own tables. The RPC lift now
  rewrites the projection's own copies in place (own data properties, so
  no prototype setter sees the tree) and copies only an object reached
  through a Proxy or one it escapes, onto a null-prototype object
  (`__bareObject`); the stored lift copies onto such objects and arrays
  whose indices are already own (`__ownArray`). Markers are literals with
  every field own (`np`, `p`, `r` always present), so no optional field is
  read through a prototype getter. Left, all on values already classified
  by brand: the Headers iterator in the lift, the signal and stream revival
  helpers' Map and Set calls, `__unwrapStoredMap`'s Map iteration, the
  projection's own `seen`/`originals` tables (which hold only the script's
  data), and the Map and Set walks of the projection and the loader env
  (1.56).
- **Test hook.** `__celld.__liftedForTest` exists only in test builds:
  `bootstrap.rs` puts `LIFTED_TEST_HOOK` at the harness's
  `/*__CELLD_TEST_LIFTED_HOOK__*/` under `cfg(test)`.
- **Wire and storage formats.** RPC frames and the tunnel are unchanged (7
  has not shipped; builds from before this change do not interoperate,
  which the stop-all upgrade note already covers, now saying so). A stored
  stub row is tagged 0x02; an 0x01 row an older build wrote is refused on
  read ("storage: this value holds a stub and was stored by an older celld
  build ..."), since its unescaped keys could revive as markers
  (`storage_ops.rs`, `UNESCAPED_STORED_STUB_TAG`). Plain rows are
  unchanged. `docs/README.md` "Upgrade notes" says what happens to them.
- **Cost** (`celld dev`, lab build, 20 operations on a 22,000-object,
  110,000-key nested value, after the review round; HEAD rebuilt from
  `git archive`, means of two interleaved runs of 5, after the third
  review round): RPC plain (no lift) 534 -> 542 ms and RPC lifted (a
  Headers beside) 769 -> 723 ms, both within the runs' spread (the lift now
  rewrites the projection in place, and the projection's one op per object,
  which used to be `__util_proxy_details`, is `__util_type_flags`); DO
  storage of a value with a stub, put + get, 147 -> 192 ms (put alone
  83 -> 101, get alone 65 -> 78; arrays are walked by key unless they hold
  every index and nothing else); plain storage 57 -> 59. Fetch throughput
  (`ab`, `celld dev`, 8 clients): hello-world 20,469 -> 20,224 requests/s,
  a 1 MiB body proxied through a service binding (4 clients) 2,719 -> 2,673
  requests/s, both within the runs' spread. The extra is on stub-bearing
  rows only: the captured-method calls and the stored lift's copies. The
  copies are `Object.setPrototypeOf({}, null)` (`__bareObject`): a
  `{ __proto__: null }` literal starts as a dictionary in V8 and made a
  stored put about 50% slower, as a brand op on every stored object did.
- **Tests.**
  - Differential: `rpc/marker-shaped-data` (no longer xfail), every key
    celld gives a meaning (`__celld$stub`, `$svc`, `$do`, `$hdr`, `$blob`,
    `$req`, `$res`, `$rs`, `$ws`, `$sig`, `$disp`, `$unsupported`,
    `$loaderSvc`) and escape-shaped keys (`__celld$`, `__celld$$`,
    `__celld$$hdr`, `__celld$$$stub`, `__celld$%`), on each value, all on
    one object, in an array and nested, on the holding object too: params
    and results of ctx.exports, DO and facet RPC under no lift, a Headers,
    a Request, an RpcTarget and a function; service-binding RPC; a Dynamic
    Worker's env, props and RPC params; DO storage get, get-many, list and
    `kv`; a Queue body (`v8`); a Workflow's params, step output, event and
    output. Shared data in `lib/worker/marker-shaped.js` (`#marker-shaped`).
    `rpc/marker-shaped-objects`: a class instance, `Object.create` of nine
    host and builtin prototypes and of `RpcTarget.prototype`, and a null
    prototype, each holding every marker key, over ctx.exports and DO RPC
    (params alone and beside a Headers, results), a service binding and a
    Loader env (workerd's refusal), and in storage get, get-many and `kv`
    and a Queue body (plain data). At HEAD its RPC, DO, service and loader
    steps fail. `rpc/marker-shaped-proxies` (xfail 1.29): Proxies of
    such objects, which workerd stubs over RPC when they present a plain
    object and refuses in storage, a Queue and a Loader env with V8's
    DataCloneError (celld copies by value, and refuses with a TypeError and
    `QUEUE_ERROR` in storage and a Queue).
    `rpc/marker-shaped-facet-params` (xfail 3.1): a facet's params beside a
    capability, which celld refuses until 3.1.
  - celld-only: `rpc/marker-shaped-data-internal`, a stored service stub
    and DO stub beside the data through every storage read (the stub still
    answers), and an AbortSignal beside it in same-isolate params and
    results and a cross-isolate service-binding call (workerd stores no
    such stub here and needs the experimental `enable_abortsignal_rpc`),
    and the objects of `rpc/marker-shaped-objects` stored beside a stub
    (each reads back as a plain object; at HEAD the step fails).
  - Second round: `rpc/marker-shaped-hosts` (differential): genuine
    Headers, Headers subclass, Blob, Blob subclass, Request, Response with
    and without a body, File and streams, each given every marker key after
    an attempt to delete the poison, over ctx.exports RPC (params alone and
    beside a Headers, results), a service binding (streams aside, 7.1),
    storage and a Loader env, and objects stamped through File's and
    AbortSignal's constructors on the same paths. At HEAD it fails.
    `rpc/abortsignal-without-flag` (xfail 1.29): celld serializes an
    AbortSignal over RPC without workerd's experimental flag.
  - Third round: `rpc/marker-shaped-hosts` also sends a Blob with own
    `_bytes` and `type`, a Request with a body and own `_bodyBytes` shaped
    like a DO stub marker, and a Response with own `_bodyBytes` shaped like
    a Blob marker; each arrives as it really is, on every path.
    `rpc/marker-shaped-host-attributes` (xfail 1.36): own `url`, `cf` and
    `status` over a Request's and Response's attributes cross in celld.
  - Unit (`js::marker_key_tests`): the escape is undone exactly, is
    injective and never yields a marker key (keys around the prefix,
    already-escaped ones, `__proto__`); an RPC payload and a stored row keep
    every such key, its order, a cycle through an escaped object and the
    lifted value beside them; unescaped reserved keys and foreign marker
    kinds are refused; an older build's 0x01 stub row is refused; host
    values are classified by brand (each host class, `Object.create` of its
    prototype and a Proxy of it; genuine and created Dates, RegExps and
    Errors); and an object claiming the Date, Headers, RpcTarget, a null or
    a class prototype is refused over RPC with workerd's text and stored as
    plain data; a host value crosses from its state, never its own keys
    (the poison stays, a Headers with marker keys arrives without them, a
    Blob is stored by value, and File, a stream, a signal and a body are
    refused in storage with workerd's texts); and a constructor pointed at a
    function that returns another object stamps no brand on it, still
    makes a genuine instance, and leaves the script's prototype in place;
    and a host marker with a field no lift writes (a body shaped like a DO
    stub, Blob or array marker, a stream marker in storage, a Blob's bytes
    or type, a Headers pair, a Response's status or `cf` of the wrong type)
    is refused, while a script's own `_bodyBytes` and `_bytes` change
    nothing a Request or Blob sends.
  - At HEAD: `rpc/marker-shaped-data` fails its RPC, DO, facet and loader
    steps (its service, storage, Queue and Workflow steps pass: those paths
    lift nothing workerd also takes), `rpc/marker-shaped-data-internal`
    fails both steps, and the unit tests need the new test hook
    (`__celld.__liftedForTest`).

### 1.54 A finished request's continuation runs as the resolver (found by 1.50) — low

A continuation of a request that has already finished -- a module-scope
promise it chained, resolved later by another request B -- runs during B's
turn. celld (1.52) gives every invocation a continuation id, but once the
request retires its context leaves `io_contexts`, so the CPED token names a
gone context and `event_context` falls back to the running context, B. The
continuation then acts as B: an I/O object is still checked against its own
owner (so A's socket is refused, B's own is reached, as in workerd), but a
new subrequest the continuation starts runs as B rather than being refused.
workerd (probed) runs the synchronous continuation, lets it use B's live
socket, and refuses a new `fetch()` with the cross-request error
`(I/O type: SpanParent)`, because the subrequest is bound to A's finished
context. The difference is within one script (A and B are the same Worker),
so it is no cross-script reach; matching it means distinguishing "no CPED
token" from "token names a gone context" and refusing new I/O from the
latter with workerd's `SpanParent` text, on the request hot path.
`streams/finished-continuation` (differential, xfail) records it.

### 1.55 Differences found by 1.49 part B

- **D1 and Workflow binding shapes.** workerd's D1 database, statement and
  session, and its Workflow binding and instance, are JavaScript wrappers:
  own `alwaysPrimarySession`/`fetcher`, `dbSession`/`statement`/`params`,
  `fetcher`/`bookmarkOrConstraint`, `binding`, `id`/`binding`, and
  constructors that take any argument. celld's keep their database and
  workflow name private (they name a cell, not a binding) and refuse
  construction (`env/wrapper-binding-state`, xfail). Matching means public
  fields that hold nothing with authority.
- **A cursor's `rowsWritten`.** celld reads the connection's change count
  when a cursor ends, so a write made while a SELECT's cursor is still open
  (a `kv.put` between `exec` and `toArray`) is counted for the SELECT; workerd
  counts the statement's own writes (`storage/cursor-rows-written`, xfail).
- **Names and tags.** celld's Queue binding is `Queue` (workerd
  `WorkerQueue`), its cursor `SqlCursor` (`Cursor`), and its namespaces, ids,
  bindings and storage objects have no `Symbol.toStringTag`, so
  `Object.prototype.toString` gives `[object Object]` where workerd names the
  class (`env/class-names`, xfail).

### 1.56 Harness primordials in a script's isolate (found by the 1.49 part B review)

Harness code that runs beside a script's code still passes a few internal
objects to builtins the script can replace. Each is same-script, with no
host authority and no cross-script reach, and each predates part B:
- `__actorEventStack` (`harness.js` ~3882-3906) uses `Array.prototype`
  `push`/`lastIndexOf`/`splice`, so a patched method sees and can edit the
  frames that `__currentActorScope()` reads (abort termination, a WebSocket's
  recorded scope, stub gating). Use captured methods or index arithmetic and
  null-prototype frames.
- `__cellBlocks` uses `Map.prototype.get/delete`; use captured methods.
- `Object.hasOwn(__cell.workflows, …)` (~9725) and
  `Object.hasOwn(__cell.namespaceKeys, …)` (~6253) use the uncaptured
  `hasOwn`; `Math.min(...driver.blocked.map(...))` (~10915) spreads Workflow
  driver entries. Use `__ObjectHasOwn` and a counted loop.
- Left by 1.53 on the RPC and storage paths, all on values already
  classified by brand (so none decides what is a marker): the Headers
  iterator (`[...v]`) in the lift, the signal and stream revival helpers'
  Map and Set calls, `__unwrapStoredMap`'s Map iteration and `set`, the
  projection's own `seen`/`originals` tables, and the Map and Set walks of
  the projection and the Worker Loader env (encode and revival).
- Derived classes without private state or a brand still take a script's
  redirected [[Prototype]] in `super()` (1.53's audit): the `Event`
  subclasses, `DOMException`, `NonRetryableError`, `RpcPromise`,
  `MessagePort`, `EventSource`, `DigestStream`, `FixedLengthStream` and
  `ByteDefaultReader` then write their data onto the object the redirect
  returns. No authority rides on them; `__pinBase` would make them match
  workerd's constructors, which ignore the redirect.
- Latent: `__rpcProject` (~4797) treats any non-`Object.prototype` object as
  unsupported, so returning one of part B's null-prototype objects over RPC
  would fail. Nothing does today.

Tests: extend `env/patched-prototypes` with patched `Array.prototype`,
`Map.prototype` and `Object.hasOwn`, expecting no harness object captured.

Also: `websocket/client-drop` reads `/seen` straight after dropping the
client, without waiting for the 1006 close to be recorded, and failed once
in a full run (30/30 and 20/20 on reruns, at HEAD too). Make `/seen` wait for
the close, bounded by a timeout.

### 1.57 Stateless requests share one context (found by 1.29)

celld runs every stateless Worker request outside any request context
(`__ctxNow()` is undefined), so a stub one request made, kept in module
state, can be called and passed on by a later request. workerd refuses both
with "Cannot perform I/O on behalf of a different request ... (I/O type:
Client)". Same script only, so no cross-script reach. Matching it means a
context id per stateless request (the CPED frame the Durable Object events
already get), ended with the request so the stubs it holds are disposed,
without slowing the plain fetch path. Because celld cannot tell the
requests apart, an op on a stub such a request made, called from another
context (an entrypoint's call, say), runs in a fresh context (1.29), so a
param it keeps belongs to no stateless request: the request that made the
stub cannot pass it on either, which workerd allows. Also, workerd lets a
Durable Object pass on, in a later event, a param one event kept with
`dup()`; celld refuses it as another request's. `rpc/stub-other-request`
(xfail) has all three.

### 1.58 RPC param gaps found by the 1.29 review

- A service binding (`env.SELF`) passed as an RPC param, to an RpcTarget or
  a Durable Object, is refused ("Proxy could not be serialized because it
  is not a valid RPC receiver type ..."); workerd delivers a Fetcher that
  works (`rpc/service-binding-param`, xfail).
- `new Proxy(stub, {})` passed as a param and called reaches the target;
  workerd throws "TypeError: Illegal invocation: function called with
  incorrect `this` reference ..." (`rpc/proxied-stub-param`, xfail). Called
  directly, the Proxy works on both.

### 1.59 Durable Object gaps found by 1.30

- **A stub binds to an instance only through RPC.** A stub whose first call
  was `fetch()` reaches the instance a later reset replaced: celld's fetch
  carries no instance token (the RPC payload does), so the stub stays
  unbound. In workerd it binds at its first call of either kind and stays
  broken (`rpc/reset-stale-stub-fetch`, xfail). Carrying the token needs a
  field on the cell fetch request and response, and on the peer tunnel.
- **A Durable Object fetch handler's error.** A `fetch()` handler that throws
  rejects the caller's `stub.fetch()` with `Error: rejected: <name>: <message>
  [<stack>]`; workerd delivers the thrown error, type and message intact
  (`rpc/do-fetch-throws`, xfail).
- **Writes a reset keeps.** A `transactionSync()` inside the turn's implicit
  transaction is a savepoint in it in workerd, and an abort later in the turn
  discards it; celld commits the implicit transaction first, because an
  alarm written inside the transaction is published, with its wake-entry
  gate, at a commit. An `INSERT … RETURNING` cursor read in part when a
  `blockConcurrencyWhile()` starts fails workerd's commit there with an
  internal error, carrying a reference; celld's block refuses the commit,
  and the object resets when the turn ends, so the call fails with a bare
  "internal error" (`storage/reset-discards-writes-xfail`). An output (a reply, a
  subrequest, `storage.sync()`) and an alarm write commit the implicit
  transaction early, so a reset later in the same turn keeps what they
  committed; workerd holds the output for the turn's commit instead.
- **A reset object's WebSocket closes with 1011.** A `webSocketMessage()`
  handler still running when its object resets fails, and celld closes the
  socket at once with 1011 ("WebSocket message delivery failed"); workerd
  drops the connection, and the client reads 1006 (`rpc/reset-websocket`,
  xfail).
- **A bound class as a facet's class.** `ctx.exports.Obj`, for a class that
  also has a namespace binding, is a facet class in workerd; celld's is the
  namespace only, and `ctx.facets.get()` refuses it
  (`rpc/facet-bound-class`, xfail).
- **A reset with an error workerd cannot carry.** A revoked Proxy, or any
  error while the script has made `Error.prototype.name` throw and replaced
  `Uint8Array` and `%TypedArray%.prototype.set`: workerd fails the call and
  the stale stub with "Promise will never complete."; celld's carry what it
  could read ("critical section failed" for the Proxy)
  (`storage/reset-revoked-error`, xfail).
- **A facet whose commit fails stays failed** until its root moves; workerd
  resets the facet, and a fresh facet stub reaches a new instance
  (`storage/facet-failed-commit`, xfail). Resetting it from the host needs
  the facet's stream and its stubs' state handled as `ctx.facets.abort()`
  does, which runs in the root's event.
- **An alarm write under an unfinished write cursor.** workerd fails the call
  with an internal error at the turn's commit, resets the object and
  discards the write; celld refuses the `setAlarm()` and the output, and
  resets the object as the turn ends, so only the texts differ
  (`storage/alarm-under-write-cursor`, xfail).
- **`ctx.storage`'s surface.** It lacks workerd's point-in-time recovery
  methods (`getBookmarkForTime`, `getCurrentBookmark`,
  `onNextSessionRestoreBookmark`), and neither storage class carries
  `Symbol.toStringTag` (`storage/storage-surface`, xfail).

### 1.60 Limit gaps found by 1.34

- **No subrequest limit for a deployed Worker.** Cloudflare allows 10 000 per
  invocation by default (`limits.subrequests`, up to 10 million), counting
  calls to its own services and each redirect. celld counts only a Dynamic
  Worker's `fetch()` and WebSocket subrequests (`subRequests`), so `celld
  deploy` refuses `limits.subrequests`. Counting needs the same charge at
  KV, R2, D1, Queue, Durable Object and service-binding calls.
- **An hourly cron's CPU limit.** Cloudflare gives a Cron Trigger whose
  interval is an hour or more 15 minutes by default; celld gives every cron
  run the Worker's limit (30 s by default).
- **The public listener's answer to a limit.** A request past its CPU or
  memory limit answers 500 with `Worker failed: <error>`; Cloudflare answers
  error 1102 ("Worker exceeded resource limits"), documented without its
  status code. Not observable on workerd run locally.
- **A cut turn's other continuations.** The termination that stops a turn at
  its limit also drops the microtasks V8 had queued in it, which can belong
  to other events of the isolate (as with `ctx.abort()`). The turn's event,
  the event whose code was running and the objects with an open transaction
  in the turn fail or reset; another event whose queued continuation was
  dropped fails only when its driver finds it waiting on nothing.
- **A facet past its CPU limit** fails closed until its root moves, as a
  facet's failed commit does (1.59), rather than resetting alone.
- **Stack depth.** V8 captures `Error.stackTraceLimit` frames before celld's
  are dropped, so a deep stack through celld's APIs shows fewer of the
  Worker's frames than workerd's.
- **A Durable Object caller's startup text** has no end-to-end case: nothing
  fails a cell isolate's start without failing the stateless pool's.
- **A builtin that holds its turn.** A termination V8 drops (only `JSON.parse`
  and `JSON.stringify` are known, and wrapped) condemns the isolate after
  the grace, but its thread stays in the call until the call returns: a call
  that never returns would hold a runtime thread for good. A worker thread per
  turn, or a turn timeout that abandons the thread, would bound it.
- **The per-turn CPU clock.** Each limited turn reads the thread's CPU
  clock three times, each a system call (about 400 ns), which a SELECT per
  DO call measured at about 4% (1.34's third round). A cheaper clock, such as
  per-thread `rusage` batched per turn or the TSC calibrated against the
  thread clock at turn ends, would cut it.
- **The cut turn's owner fails too.** When another event's code spent the
  limit in a turn, the turn's own event fails with the CPU error as well,
  since its queued work was dropped with the turn; Cloudflare would charge
  only the spender.

### 1.61 A stuck isolate must not starve the node (found by the 1.34 review) — security

**Problem.** Isolate turns run inline on the Tokio worker threads that also
serve the public and internal listeners. A turn that holds its thread holds
a worker: a long CPU limit (up to 5 minutes), a builtin that does not stop
for a termination (1.34 condemns its isolate after the grace, but the
thread stays in the call), or, at HEAD before 1.34, any `for (;;)` with no
limit. Enough of them take every worker, and the node answers nothing, its
`/ping` included.

**Repro (review, 1.34 tree).** `for (...) new Array(1e6).fill(1)` with
`cpu_ms: 1000`, 48 requests 200 ms apart: requests ran 45–78 s,
condemnation fired at about 2 s, every worker wedged, `/ping` timed out,
about 1.5 GB RSS leaked, and the node did not recover. Not reproduced on
the 1.34 author's machine (24 cores, and 4 cores with `taskset`): the same
48 requests ended in 1.0–6.1 s, `/ping` answered in 2–8 ms throughout, and
a bare isolate with a 128 MiB or 1 GiB heap stopped the loop at the limit
exactly. The review's final check, on the third-round tree, used a sync
`fetch` returning an async IIFE that runs
`for (i < 1e9) c += new Array(1e6).fill(1).length` under `cpu_ms: 1000`
(`celld dev`): one request failed after 9.3–9.6 s, all on the isolate's
thread (so the termination lands late, not GC helpers), and 48 requests
200 ms apart all failed after 65–83 s while every `/ping` timed out; the
node then recovered on its own. The wedge itself follows from the design whatever triggers the
long turns, so it is recorded here.

**Design.**
- **Turns off the Tokio workers.** Run every isolate turn on a dedicated
  pool of isolate threads, bounded by the node's isolate concurrency (for
  example the CPU count). A turn is a job sent to the slot's thread and
  awaited through a oneshot, so a stuck turn holds an isolate thread, never
  a worker. `Slot::turn` keeps its signature; its body changes.
- **Listeners on threads isolates cannot take.** The public and internal
  listeners, `/ping`, the actor and the peer tunnel stay on the Tokio
  runtime, which then runs no JavaScript.
- **A bound on stuck isolates.** Count, per script, isolates condemned but
  still in a turn. Past a cap (for example 2), the pool refuses to build
  another isolate for the script and fails its requests at once with the
  CPU error, until one of them returns; the node-wide count of stuck
  isolate threads has a cap too, past which every script's growth is
  refused. Report both in `/state`.
- **Memory.** A condemned isolate that is still in a turn keeps its heap;
  the caps above bound how many exist. Measure RSS under the repro.

**Tests.** A celld-only case that sends more long-running requests than the
node has workers (a builtin loop under a long `cpu_ms`) and checks that
`/ping` and another Worker keep answering within a bound, and that the
script's further requests are refused once its stuck isolates reach the
cap; unit tests for the caps.

**As built (done).**
- **Isolate threads** (`isolate_threads.rs`). JavaScript no longer runs on
  the Tokio workers. `main` starts the pool before any Worker loads:
  `CELLD_ISOLATE_THREADS` threads (the CPU count by default), each entered
  into the host runtime, so a turn can spawn, arm timers and read
  `Handle::current()` as before (no turn uses `block_in_place`); they inherit
  V8's PKRU. Work that has run 50 ms is *long*: while work waits and fewer
  than `core` threads run short work, the pool (or its monitor, every 10 ms)
  starts a thread, up to `2 × core` that are not stuck and, counting stuck
  ones, a hard ceiling of `2 × core + max(core/2, 3)`; past it work waits,
  except that `max(core/2, 2)` reserve threads past the ceilings take the
  work of owners with no stuck or long turn, so well-behaved Workers make
  progress however many others hold threads. A thread over `core` exits
  after 10 s idle; threads start outside the pool's lock. Without isolate
  threads (unit tests, the simulated runtime) a driver is an `asyncrt` task
  and a load runs on `asyncrt::blocking`. Work goes to the idle thread that last ran its isolate, else the one
  that went idle last (a FIFO hand-off to any idle thread cost a plain fetch
  about 8%). Loads and placements run there too (`offload`: pool growth,
  `place_cell`, Dynamic Worker loads, a deploy's `Generation::build`).
- **Turns** (`pool.rs`). Deviation: `Slot::turn` keeps its shape but takes a
  `Send + 'static` closure. A borrowing closure run on another thread is
  sound only if the awaiting future cannot be dropped mid-turn, which Rust
  cannot guarantee (a leaked pinned future frees what the turn borrows).
  Call sites move their state in and get it back (`Slot::turn_with` for an
  event's `InFlight`, the `Residency` of `adopt`, the cell-gate job). A turn
  whose caller leaves before it starts never runs; once started it runs to
  its end and its result drops on the isolate thread, inside a catch. A
  per-slot `TurnQueue` replaces the tokio `Mutex` and `TurnScheduler`, with
  the same lane round robin. A submitted run takes the slot's waiting turns
  back to back for up to 1 ms; a driver polled on an isolate thread runs its
  own turn inline and hands the rest to a thread, so its reply waits for no
  other request's turn. A run that unwinds ends itself (a guard clears the
  slot's run, its poisoned locks, and hands the rest on).
- **Drivers on the isolate threads.** Every event driver (stateless, cell,
  alarm, facet, Dynamic Worker, worker-on-cell) is a task on a small
  executor there (`isolate_threads::spawn_near`, first polled on the thread
  that last ran its isolate, and counted as its isolate's owner's work), so its turns run where it is polled: an op
  completing costs one wakeup, as at HEAD. A wakeup queues the task itself
  (`Job::Poll`), with no allocation; a panic in polling or dropping a task
  ends the task.
- **Owners and stuck turns** (`turn_owner.rs`). An owner is a script: its
  stateless and cell pools across generations, and the Dynamic Workers it
  loads (a Dynamic Worker counts against its loader, which chose its code
  and ids). celld has no tenant above a script: a tenant's several scripts
  are several owners. A turn is *stuck* once it still runs
  `min(grace, 500 ms)` after the CPU watchdog first asked it to stop, where
  the grace is the condemnation's `max(limit, 100 ms)`: counted from then
  until it returns (`TurnMark`, marked synchronously on the watchdog's thread
  and keyed by the slot's turn number, so a later turn is never marked).
  Deviation from "500 ms after the first fire": for a limit under 500 ms the
  grace is shorter, and a turn the grace condemns should count by then; an
  ordinary overrun (a collection, a large sort) ends well inside 100 ms. A
  stuck isolate takes no new work at once, and placement, the pool policy,
  `live()` and the census all count it as not live. An owner with 2 stuck turns starts no new event: its stateless
  requests and Dynamic Worker calls fail at admission, and an event that
  reaches a turn anyway (`turn_begin`, `turn_begin_cell`) fails there, with
  `Worker exceeded CPU time limit.` (500 `Worker failed: …` on the public
  listener); none of its cells is placed (the Durable Object's caller sees
  the same text). Events already running go on: failing their next turns
  would need the CPU-failure path (rollback, Durable Object reset) for
  events that did nothing wrong. At the node-wide count, half the isolate
  threads and at least 3, so one owner at its own cap never reaches it, an
  owner that already has a stuck turn grows no isolate (503 `Worker refused:
  node has N isolates stuck past their CPU limit, this Worker's among them,
  and starts no more for it`); other owners grow as before. The node cap and
  the hard thread ceiling bound the threads and heaps stuck turns hold.
- **Long turns.** While an owner has a long turn (not stuck) it starts at
  most `core/2` turns at once (at least 1), stuck turns not counted; a turn
  that would start an event past that waits for one of its turns to end
  (`Owner::defer`), so other owners always have threads. Only turns that
  start an event (`Slot::turn_event`, `turn_cell_event`) wait: a turn that
  continues, cancels or settles an event, or releases a cell, never does, and
  an owner at its stuck cap never waits, so its new events reach the refusal
  at once. While event starts wait, the run takes the first turn queued that
  is not one, in lane order (`TurnQueue::next_skipping_events`), and defers
  only when nothing but event starts is left.
- **PBKDF2.** workerd's `checkPbkdfLimits` (`api/crypto/impl.c++`), called
  from WebCrypto `deriveBits` (`pbkdf2.c++`) and node:crypto's `getPbkdf`
  (`api/node/crypto.c++`), refuses past the limit enforcer's
  `checkPbkdfIterations`: the default enforcer caps at
  `DEFAULT_MAX_PBKDF2_ITERATIONS` (100 000, `io/limit-enforcer.h`), and
  workerd run locally (`server.c++`) sets none, which is why 1 000 000
  `pbkdf2Sync` iterations ran there. celld follows the default (Cloudflare's):
  a `NotSupportedError` `Pbkdf2 failed: iteration counts above 100000 are not
  supported (requested N).`, at the same point in each API (case
  `builtins/pbkdf2-iterations`, celld-only).
- **Runner.** An `internal` step (a GET to the operator listener within a
  bound, optionally polling dotted JSON paths with `until`, and `record`) and
  a path step's `probe` (the operator listener every 100 ms while the request
  is in flight). A Worker cannot reach the operator listener itself.
- **Test hold.** `CELLD_CONFORMANCE_HOLD=1`, which only `limits/stuck-isolates`
  sets, gives every isolate `__celldTestHold(ms)` (at most 60 s): a host call
  that burns its thread's CPU and ignores a termination, so a case holds a
  turn past its limit for a known time. Only a `celld dev` node has it: any
  other node refuses to start with the variable set, and a `celld dev` node
  logs a warning. Without it the global does not exist and the op refuses.
- **A Durable Object RPC's route** now reports why its cell did not start,
  as a fetch's route did (`RoutedRequestError::for_cell`): the CPU limit's
  error of an owner at its cap, or a startup error, rather than `route RPC
  …: RuntimeFailed`.
- **Case** `limits/stuck-isolates` (celld-only; 2 Tokio workers, 4 isolate
  threads, 2 isolates per Worker): the review's repro ×6 while `/ping` and
  another Worker answer within 500 ms; then holds of 6 s under `cpu_ms: 10`,
  one stateless and one in a Dynamic Worker of `stuck` (2, its cap: the
  Dynamic Worker counts against `stuck`) and one of `stuck2` (3, the node's
  cap), while `/ping` answers within 500 ms. `stuck` is then refused at once
  with the CPU error, `stuck2` gets the node-cap 503 at once, `other` (no
  stuck turn) grows a second isolate, and a Durable Object of `stuck` armed
  before them sends a new event to an object already placed, which fails
  within 500 ms with the CPU error, and is refused placement of a new object
  with the same error; once the holds return `stuck` serves and places
  again. Deterministic (5 runs, and 3 more pinned to 4 cores). At HEAD, run
  with an uncapped `pbkdf2Sync` in the hold's place (the hold does not exist
  there), the node wedged: `/ping` got no answer within 500 ms during the
  holds, `/state` had no counts, and `stuck` was not refused.
- Unit tests: the caps (owner, node, refusal only for owners with stuck
  turns), the mark across a turn and racing marks, the long-turn share,
  refusal at the cap for a stateless request and a cell across pools, lane
  round robin, a run that unwinds, the pool's growth rule and hard ceiling,
  locality, cancellation, panics, the executor.
- **Measured, the review repro** (48 requests 200 ms apart, `cpu_ms: 1000`,
  `celld dev`, 24 cores): HEAD ran each 5.2–16.9 s, peak RSS 1.33 GB; now 22
  ran up to 4.8 s and 26 were refused in about 1 ms, peak RSS 518 MB, at
  most 6 stuck at once against a cap of 2 (13 when counted at the grace of
  1 s, 4 at the first retry, 10 ms), `/ping` at most 5 ms and another Worker
  at most 6 ms. With `CELLD_TOKIO_THREADS=4`, HEAD's `/ping` took up to 2 s
  and timed out once; now at most 5 ms.
- **Cost** (lab, `ab -n 20000 -c 16`, medians of 11 interleaved rounds against
  912ba10, a hello-world fetch, an RPC to one Durable Object, and an RPC to it
  running one SELECT over 1 000 rows): plain fetch 19472 → 18719 req/s
  (−3.9%), DO RPC 16630 → 17188 (+3.4%), SELECT per DO call 11826 → 11967
  (+1.2%). A plain fetch crosses threads twice where it crossed none. Kept:
  the allocation-free task wakeup, threads started outside the lock, a
  per-slot turn number, the inline turn limited to the driver's own. Tried
  and dropped, as no measured gain: a spinning idle thread (one, at 30 and
  100 µs), the caller spinning for the result (10–100 µs), a FIFO hand-off.
  Not tried: a lock-free idle stack, and pairing Tokio workers with isolate
  threads; the remaining cost is two wakeups, which neither removes.

### 1.62 Isolate thread gaps (found by 1.61)

- **Turns already running when an owner reaches its cap** can still become
  stuck: the review's repro peaked at 6 against a cap of 2, counting a turn
  500 ms after its limit. Failing an owner's running events at their next
  turn would bound it, but needs the CPU-failure path for each kind of event.
- **Reserve threads judge cleanliness at submit time.** An owner with no
  stuck or long turn when its work is queued at the ceilings gets a reserve
  thread; if its turns then run long they hold the reserve until they end.
  The total stays bounded (`max(core/2, 2)` reserve threads).
- **No tenant above a script.** A tenant whose deployment has many scripts
  gets an owner, and its caps, per script; only the node cap and the hard
  thread ceiling bound them together.
- **A load stuck in a builtin** (module scope past the 1 s startup budget, in
  a call that does not stop) is never marked stuck, so its owner's caps do
  not count it; it holds an isolate thread until it returns.
- **Other host calls without a bound.** PBKDF2 now has Cloudflare's cap;
  any other synchronous host call that runs long (a large `zlib` call) still
  holds its turn past the limit. Audit them against workerd's.
- **The hand-off** costs a plain fetch at 16 connections about 4%: two
  wakeups per request.
- **Out-of-tree internal tests** (`celld_internal_tests`) need updating:
  `Slot::turn` and `turn_cell` take `Send + 'static` closures;
  `Pool::new` takes the build closure unboxed; `Slot::loaded_worker` takes a
  `turn_owner::Owner`; `hold_turn_for_test` now holds the slot's turn queue
  (no turn runs while it is held, and queued ones run when it drops) rather
  than a lock; turn observations are recorded on the isolate thread;
  `vacant_for_request_cancellation_test` is built in every test build; the
  `/state` fields are `stuckIsolates.{total,nodeCap,ownerCap,longShare,owners}`.

### 1.63 Gaps found by 1.36 (items 1–7)

- **Instances that are not of an API class.** celld's global scope, `ctx`,
  bindings (service, KV, R2, Queue, Durable Object namespace and id), a
  Durable Object's state, storage, `sql`, id and `this`, `navigator`,
  `scheduler`, `Cloudflare`, `console` and `process` are plain objects; an
  RPC stub and property are functions, an RPC promise a Promise, and a
  DOMException a native Error. So `Object.prototype.toString()` gives none
  of them workerd's class name with `set_tostring_tag`, and the stubs,
  promise and DOMException give `[object Function]`, `[object Promise]` and
  `[object Error]` without it, where workerd gives `[object Object]`.
  celld lacks the globals `Body`, `Crypto`, `FetchEvent`, `Navigator`, the
  `Performance` classes, `ScheduledEvent`,
  `ServiceWorkerGlobalScope`, `TailEvent`, `TraceEvent` and
  `WorkerGlobalScope`, has `DigestStream` and `Temporal` globals that
  workerd does not, and no API prototype has workerd's
  `Symbol.for("cloudflare:internal-class")` mark. Pinned by
  `flags/set-tostring-tag-instances` (xfail).
- **When a ReadableStream pulls.** workerd pulls on start, after an enqueue
  and when a read finds the queue empty (standard.c++ `pullIfNeeded`
  callers); celld, as the Streams Standard, also after a read that its
  queue satisfies. A source with a high water mark above 0 refills earlier
  in celld, and a TextEncoderStream before
  `encoder_stream_spec_compliant_backpressure` (with the TransformStream fix)
  runs its next write earlier. Pinned by `streams/pull-after-queued-read`
  (xfail); `flags/stream-backpressure` leaves that combination to it.
- **Error shapes.** A DOMException's `code` is an accessor of its prototype
  in celld and its own in workerd, and one returned over RPC, passed as a
  param or written to Durable Object storage arrives as an Error named
  `"Error"` without a `code`; workerd's arrives as a DOMException in all
  three. An Error's
  stack starts with the message it has when the stack is first read;
  workerd's starts with the one it was made with. Pinned by
  `rpc/error-shapes` (xfail).
- **A stored value that cannot be read back** (an Error whose properties
  refer to it, say) fails `storage.get()` with celld's "actor storage
  deserialization failed; …" text; workerd's is "internal error; reference
  = <id>". `flags/enhanced-error-serialization` leaves that path out for
  that value.
- **Another script's handler errors.** A fetch handler in another script
  that returns something other than a Response, or throws, reaches the
  caller as an `Error` whose message carries the text ("fetch threw:
  TypeError: …" for a throw); workerd's caller gets the TypeError. Pinned
  by `service-bindings/target-errors` (xfail).
- **Object.prototype elsewhere.** Paths outside the request, response and
  RPC ones still build ordinary objects and read fields they may lack from
  them: the R2, D1 and Queue host replies, the WebSocket and storage
  records, and the own fields that celld's other JavaScript classes (the
  streams, events, Headers) create by assignment, so a getter-only
  accessor a script puts on Object.prototype under one of those names
  (`_closedPromise`, `_hwm` and the like) makes the class throw.
- **Request init fields celld reads and does not use.** `fetcher` is read
  and ignored, where workerd sends the Request through that Fetcher
  (`encodeResponseBody` is used since 1.36 item 9). Other globals that celld's own
  paths look up when they run (`structuredClone`, `TextDecoder`, `Blob`
  and others beyond Request, Response, Headers, AbortController,
  ReadableStream, FormData and URLSearchParams) can still be replaced by a
  Worker under them.
- **A failed fetch handler's 500 body.** celld's 500 shows
  "Worker failed: <message>" to the client where workerd sends
  "Internal Server Error"; the text is workerd's own fixed message, so
  nothing leaks, but the body differs.
- **What is not yet observable.** A thrown value's detail holds a Blob or
  another celld host value only as V8 writes it, which fails (the host
  classes refuse a plain clone), so it falls back to the description; in
  workerd the host value serializes. An Error's property that is a
  function crosses another isolate's RPC result as a DataCloneError where
  workerd gives a stub (cross-isolate stubs, Phase 3).

### 1.64 Gaps found by 1.36 (items 8–15)

- **Content-Encoding br** (`brotli_content_encoding`, on from 2024-04-29).
  celld neither compresses nor decodes a br body, as if the flag were off,
  so the flag is `Support::Off`: a response a Worker sends with
  `Content-Encoding: br` goes out uncompressed under that header, and a br
  response a Worker fetches arrives undecoded. Supporting it needs a brotli
  implementation, the `brotli` crate or the C library, reviewed as the
  quality bar asks, behind the same paths as gzip (`CelldGzipBodyStream`,
  `__gzipBody`). Pinned by `fetch/content-encoding-br` (xfail).
- **WebSocket permessage-deflate** (`web_socket_compression`, on from
  2023-08-15). celld never agrees to it; fastwebsockets 0.8.1 refuses a
  frame with RSV1 set, so it needs a reviewed fork or another library, then
  the negotiation and per-message deflate (with context takeover and window
  bits) on every socket path: an accepted socket, a `fetch()` upgrade, a
  hibernated Durable Object's sockets and a pair across isolates. Pinned by
  `websocket/permessage-deflate` (xfail, recorded from workerd run
  directly).
- **A WebSocket whose listener throws.** workerd errors the socket out (an
  `error` event with the exception, the socket CLOSED, the peer sees 1006),
  after the remaining listeners under `spec_compliant_dispatch_exceptions`
  or at once without it. celld runs the listeners as the flag says and
  leaves the socket open. Pinned by `websocket/listener-exception` (xfail).
- **Cross-request promise resolution**
  (`handle_cross_request_promise_resolution`, on from 2024-10-14). workerd
  runs a promise's continuations in the request that made it, or drops them
  with a warning when that request is over, through its own V8 patches that
  tag promises with their context; celld's V8 lacks them, so continuations
  run in the request that resolves the promise. Pinned by
  `flags/cross-request-promise-resolution` (xfail).
- **Durable Object eviction with work pending**
  (`durable_object_io_tasks_prevent_eviction`, on from 2026-10-01). On
  Cloudflare an object whose waitUntil() work is pending stays in memory
  for up to 15 minutes; celld ends a request's activity with its answer,
  so idle eviction takes the object and its pending work is lost. Holding
  the object's activity until that work settles, within the bound, models
  it. Pinned by `flags/durable-object-io-tasks-eviction` (xfail; workerd
  run locally keeps the object too).
- **Queue send metrics.** The backlog a `send()` or `sendBatch()` reports
  counts the message being sent in celld; Miniflare's service counts the
  queue before it. Pinned by `queues/send-metrics` (xfail). celld's service
  also refuses with Cloudflare's documented codes where Miniflare's sends
  none (`flags/queue-error-codes`, celld-only).
- **JWK export.** celld exports no symmetric key (HMAC, AES) as a JWK, and
  an asymmetric one without `key_ops`, `ext` and `alg` and in another member
  order. Pinned by `builtins/jwk-export` (xfail).
- **Assigning to a read-only attribute** in strict code: workerd's
  prototype accessors are V8 read-only accessors, so V8 reports "Cannot
  assign to read only property"; celld's are JavaScript getters, so V8
  reports a getter without a setter. Pinned by
  `builtins/readonly-attribute-assignment` (xfail).
- **Own keys of API objects.** The streams, their readers, writers and
  controllers, Headers, Blob, File, FormData, EventTarget and others still
  hold their state in own `_`-prefixed properties, which `Object.keys()`
  and `Reflect.ownKeys()` show; workerd's have none. Their move to private
  fields, as Request, Response, Event and AbortSignal had in 1.36, closes
  it. Pinned by `builtins/internal-own-keys` (xfail). `Headers.prototype`
  also carries celld's `__celldHeaderList` getter.
- **A Response with a null body status and a body.** workerd refuses one
  whose body is a stream or not empty, and treats an empty one as no body;
  celld takes the body. celld's own paths build such responses from what a
  target sent, so they need to pass a null body first. Pinned by
  `fetch/null-body-status-construct` (xfail).
- **Content-Length of a body passed on.** A fetched gzip response a Worker
  returns unread keeps the upstream's `Content-Length` in workerd; celld
  sends it chunked (the listed difference "celld removes Content-Length from
  a Worker response"). Pinned by `fetch/passthrough-length` (xfail,
  recorded from workerd run directly).
- **A socket's writable side and `internal_writable_stream_abort_clears_queue`.**
  The flag's old state is modelled for IdentityTransformStream and
  FixedLengthStream; a TCP socket's writable side, an internal stream in
  workerd, is a standard WritableStream in celld, which aborts as the
  Streams Standard does whatever the flag.
- **Old-date attributes elsewhere.** Without
  workers_api_getters_setters_on_prototype only a Request, a Response and a
  ReadableStream come from an attribute class (`__bodyInstance`,
  `streamInstance`);
  every other class with attributes (Event and its subclasses,
  AbortSignal, AbortController, WebSocket, Blob, File, the readers and
  writers, WritableStream, TransformStream, TextEncoder, TextDecoder,
  DigestStream) adds them to each instance after construction, about 1 µs
  an attribute (an Event about 12 µs), and the instance loses its shared
  shape. Making each hierarchy's root build its object as Body does closes
  it.
- **Prototype member order.** Members other than `constructor` are not all
  in workerd's order (Blob's `slice`, AbortSignal's `onabort`, TextDecoder's
  `decode`, Headers' `getAll`, which celld lacks).
- **deflate-raw output.** celld's compressor is miniz (flate2's default
  backend), whose output differs in size from zlib's, which workerd uses:
  5 MB of zeros encodes to 4861 bytes in celld and 4874 in workerd, with
  `deflate-raw` (and likewise for the other formats). Both decode either.
  Matching it needs flate2's zlib backend, a C dependency or `zlib-rs`,
  reviewed as the quality bar asks.
- **DecompressionStream details.** A close after a failed write rejects
  with "Stream already closed/errored" where workerd's reads "This
  WritableStream has been closed.", and a CompressionStream gives a small
  message back in one chunk where workerd gives two.
- **Constructor surface.** `Request.prototype`, `Response.prototype`,
  `ReadableStream.prototype` and `Body.prototype` are read-only in celld
  where workerd's are writable (non-enumerable, non-configurable); making
  them writable needs celld's own constructions to stop reading them at run
  time first. Constructing reads `newTarget.prototype` twice (V8 allocates
  `this` from it, then celld builds the instance) and allocates one object
  it discards; workerd reads it once. `length` is 1, 1 and 2 where
  workerd's is 0, and `toString()` shows source rather than
  `[native code]`.

### 1.65 Gaps found by 1.37

- **eval() of a value that is not a string, and an empty `new Function()`.**
  workerd's code-generation callback (jsg/setup.c++
  `modifyCodeGenCallback`) refuses `eval()` of anything but `undefined` in a
  request, a number or an object included, and lets `new Function()` and
  `Function()` with no arguments (and a class extending Function that calls
  `super()`) through, as their source holds no code. celld switches code
  generation off on the context, which V8 checks for strings only and for
  every Function constructor, so `eval(5)` returns 5 and `new Function()`
  throws. Matching it needs V8's `SetModifyCodeGenerationFromStringsCallback`,
  which rusty_v8 152 does not bind: an upstream binding, or a reviewed
  patch. Pinned by `builtins/eval-non-string` (xfail).
- **The env's order.** workerd lists a Worker's vars first, then its other
  bindings, as Wrangler's configuration gives them; celld lists Durable
  Object namespaces, then R2, KV, queues, D1, Workflows, service bindings,
  and the vars last (`build_env`). `Object.keys(env)` shows it, at module
  scope and in a handler. Pinned by `env/binding-order` (xfail).
- **A string body's Content-Type** (1.43): `navigator.sendBeacon()` with a
  string body sends no `Content-Type`, as every celld Request with one;
  `builtins/send-beacon` leaves those bodies' type to
  `builtins/body-defaults`.
- **A Node.js built-in's namespace from `import()`.** A dynamic import of
  any Node.js built-in links a separate `dyn:` module, so its namespace is
  another object than a static import's, though its members are the same
  values. Pinned by `node/dynamic-import-namespace` (xfail).
- **`node:timers`' `promises`** stands in for workerd's internal namespace of
  `node:timers/promises` with an object that has a namespace's prototype,
  tag, keys and attributes; a script can assign to its members, which a
  namespace refuses. Listed in the docs, no case.
- **Node.js polyfills Wrangler adds.** With `nodejs_compat` but the perf
  flags off, Wrangler bundles unenv's polyfills for `node:perf_hooks` and
  `performance`, and celld's `celld deploy` does not. That state cannot be
  recorded from workerd through the harness, so it is only listed.
- **Performance class details** left out of the cases: the classes sit on
  celld's global object rather than workerd's global scope prototype, the
  EventTarget method descriptors differ as for every celld EventTarget, and
  workerd's internal symbols are absent.
- **Which handler fields are read at startup.** workerd reads every field of
  its `ExportedHandler` (`fetch`, `tail`, `trace`, `scheduled`, `alarm`,
  `test`, `queue`, `email` and the rest) off every object export, the
  default and the named ones, while the Worker starts; celld reads the
  default export's `fetch`, `queue` and `scheduled` there, and a named
  export's handlers when one is invoked. A getter or Proxy trap on another
  key, or on a named export, runs in global scope on workerd and in a
  request on celld. `env/global-scope-io-more` pins the default export's
  `fetch` only.
- **The Python startup window for a bundle that only looks like one.** The
  node grants the window to a deployment under `python_workers` that
  carries the pinned Pyodide interpreter and sentinel (1.37), but the
  bundle's JavaScript is the deployer's and cannot be pinned, so a deployer
  can upload the interpreter beside a script of its own and open the window
  once per isolate: eval() and Wasm compilation for up to 30 s in its own
  isolate, as its module scope has anyway under `allow_eval_during_startup`.
  It reaches nothing outside that isolate, since workerd's rule is
  forensic, not an isolation boundary. `condemnIsolate` from `celld:python`
  lets such a script retire its isolate and get a fresh window with the
  next one; it stays because Pyodide's fatal hook needs it (workerd aborts
  the isolate there, and an interpreter after a fatal error answers nothing
  correctly), and it costs the deployer its own cold starts and nothing
  more: any Worker can retire its isolate by passing its heap or CPU limit.
  Closing it fully needs the node to build the bundle's JavaScript itself.
- **The order of `Cache.put()`'s checks in a request.** workerd checks the
  key's method (GET), the response's 206 status and its `Vary: *`, silently
  resolves for a 304, starts serializing the body, and validates the key's
  URL last, in the PUT it then makes (api/cache.c++ `Cache::put`, about
  lines 282–371). celld's `asKey` validates the URL first, so a key that
  breaks two rules (a POST to `ftp://`) gets the URL's TypeError where
  workerd gives the method's, and a 304 under an invalid key rejects where
  workerd resolves. Pre-existing; no case.
- **As built: `storage/nested-root-transactions` was flaky** (about one run
  in 20, CI run 41104475000): its `/concurrent` step began `b` before `a`,
  though the Worker called `a` first on the same stub. The case was right
  and celld was wrong. A Durable Object stub's RPC calls took no place in
  their caller's order: each became its own drive task (`run_cell_event`)
  and the first to take the isolate began first. A stub's `fetch()` already
  took one (`CallOrder`, taken synchronously in `op_do_call_impl` and waited
  on in `drive_cell_inner`). On workerd a stub's calls begin in the order
  they were made, as its event loop and the object's input gate
  (io-gate.c++, `waiters.front()`) are both FIFO. Fixed: `op_rpc_call` takes
  the call's place too, `RpcCallReq` and `CellJob::Rpc` carry it, and the
  drive waits for the calls ahead to be delivered, not to finish, so events
  still interleave at their awaits. Fetches and RPC calls keep separate
  chains (`CallKind`): workerd begins a fetch before an RPC call made just
  ahead of it, cold or warm, which one chain would forbid. Calls from a
  facet stub take no place, as before. `rpc/do-call-order` makes 24 calls
  at once on a cold and a warm object, from another object, over two stubs
  and by `fetch()`, and failed on every run before the fix. Only a stub's
  RPC call takes a place: `__cellRpc`, behind the KV, D1, Queue and
  Workflow bindings, shares `op_rpc_call` but sends no stub head, and
  workerd orders none of those through a stub (ordering them cost about 15%
  on 600 concurrent KV operations). Review fixed two holes in `CallOrder`
  that fetch had too, now unit-tested (`call_order_tests`): a call that died
  undelivered as the tail removed its entry, so the next call began ahead
  of a call still waiting, and now leaves what it waited on as the tail
  (with that call's `seq`, so the entry still goes when the chain empties);
  and `wait` moved its receiver out, so a drive cancelled mid-wait let the
  next call jump, and now polls it in place. A remote attempt holds its
  place until the remote call ends, as fetch's does: when ownership moves
  back mid-flight, a call behind it delivered locally waits for the whole
  remote call, not just its beginning.

### 1.66 Gaps found by 1.38

- **A name a builtin module does not export.** V8 links a static import
  against the module's exports, so on workerd `import { nope } from
  "node:path"` (or `from "node:http"`, `"cloudflare:sockets"`,
  `"cloudflare:pipelines"`, and `export { nope } from "node:buffer"`) fails
  the start with `Uncaught SyntaxError: The requested module 'node:path'
  does not provide an export named 'nope'` and the import's location.
  celld's stub of a builtin exports every name the Worker imports, binding
  `undefined` for an implemented module and a stub that throws on use for
  the others, so the Worker starts. Matching it needs each builtin's export
  list as workerd has it. Binding only the names an implemented module's
  backing object has would fail the start of a Worker that imports a name
  workerd has and celld lacks, and no one has checked those objects
  against workerd's lists; the stubbed modules have no list at all. Pinned by
  `loader/builtin-missing-export` (xfail).
- **The surface of a stubbed builtin.** A namespace import or `import()`
  of a module celld only stubs (`node:http`, `node:net`, `cloudflare:ai`,
  `cloudflare:email`, …) gives an empty namespace, where workerd's has the
  module's exports; the same export lists would fill it. No case.
- **`cloudflare:email` in a Dynamic Worker.** Its implementation,
  `cloudflare-internal:email`, is a Miniflare extension, which workerd run
  locally gives top-level Workers only, so there a loaded Worker's import of
  it fails with `No such module "cloudflare-internal:email".` and
  `imported from "cloudflare:email"`. celld gives it to every Worker, as
  Cloudflare does in production. `loader/builtin-modules` leaves the name
  out of its list for this reason and imports it from its top-level Worker.
- **The bundler's builtin names.** `celld deploy` keeps external the bare
  names in `BARE_NODE_BUILTINS` (engine_api.rs), which lacks some of
  workerd's `NODEJS_BUILTINS`: `console`, `domain`, `repl`, `sys`, `wasi`,
  `trace_events`, and the `_http_*`, `_stream_*` and `_tls_*` modules. A
  bundle that imports one of those bare names has esbuild resolve it from
  `node_modules` instead, and fail the build when nothing there has it. The
  list is also the same whatever the Worker's flags. Not probed against
  Wrangler's bundling; no case.

### 1.67 Gaps found by 1.39

- **A Node.js module's frames.** workerd's `node:` modules are JavaScript,
  so when a refusal comes from inside one (`randomBytes()`, node:timers'
  `setTimeout()` and the promises API), its startup error lists that
  module's frames (`at node-internal:crypto_random:67:19 in randomFillSync`)
  above the caller's. celld's Node.js modules are its own code, whose frames
  every startup error leaves out, so it lists only the caller's. Matching it
  needs celld's module code to carry workerd's file names, lines and
  function names. Pinned by `loader/global-scope-io-node-frames` (xfail).
- **`generateKey()` for a secret key.** workerd checks an AES key's usages
  (`SyntaxError: Attempt to generate AES-GCM key with invalid usage
  "sign".`) and its length (128, 192 or 256, `Generated AES key length must
  be 128, 192, or 256 bits but requested 7.`) and an HMAC key's hash
  (`Unrecognized or unimplemented digest algorithm requested.`) before it
  draws the key, and makes AES-KW keys. celld checks no AES usage, refuses
  192 bits, has its own texts for the other two, and cannot make an AES-KW
  key; at module scope the first shows as the global-scope refusal where
  workerd gives its SyntaxError. Pinned by `loader/global-scope-ops-gaps`
  (xfail), with the next.
- **`queueMicrotask()`** is celld's polyfill, `Promise.resolve().then(f)`:
  it returns a promise where workerd's returns `undefined`, takes anything
  as its callback, and turns a callback's throw into a rejection rather than
  a reported error. Pinned by `loader/global-scope-ops-gaps` (xfail).
- **The order of a Request init's checks.** workerd refuses a body at module
  scope after checking `integrity`, the method and the headers, and before
  `redirect`, `cache` and `encodeResponseBody`; celld refuses it after all
  of them but the method's, so an init at module scope with a body and a bad
  `cache` or `encodeResponseBody` gets their TypeError where workerd gives
  the refusal. No case.
- **Timers celld builds on the global `setTimeout` (done, in 1.39).**
  `scheduler.wait()`, `AbortSignal.timeout()`, node:timers/promises,
  EventSource's retry and the Queue and Workflow timers called the global
  `setTimeout`, so a script that replaced it changed what they did, and
  decided whether they were refused at module scope; workerd's are native
  and use its own timers. They now use the harness's timers. Pinned by
  `builtins/replaced-globals` and `loader/global-scope-ops`.

### 1.29 RPC serialisation follow-ups (found by 1.13)

- **Security: forgeable markers (done, 1.53).** The lift copies user keys
  named `__celld$stub` without escaping them, so a user object can pose as
  a marker if it knows `__stubIsolate`. That token comes from `Math.random`.
  The reach is same isolate and same script only. Escape user keys, or use
  a brand JS cannot forge, as 1.8 and 1.21 did. 1.53 escapes them, and the
  token now comes from the host CSPRNG and carries no authority.
- An AbortSignal crosses RPC without the experimental
  `enable_abortsignal_rpc` flag; workerd refuses it ("AbortSignal
  serialization is not enabled."). `rpc/abortsignal-without-flag` (xfail).
- A Proxy that presents a plain object is serialised by value; workerd stubs
  it and, under 1.13, calls its `dup()`. `rpc/marker-shaped-proxies`
  (xfail) records it, with storage's and a Queue's Proxy refusals, a
  TypeError and `QUEUE_ERROR` where workerd's is V8's DataCloneError.
- The RpcTarget check is `instanceof`, where workerd uses the JSG brand, so
  `Object.create(RpcTarget.prototype)` is accepted. (Done in 1.53: a
  private-field brand; such an object is refused as `"JsRpcTarget"`.)
- If a call fails after `__rpcOut` but before the callee decodes (a gate
  refusal, or `__rpc_call` rejecting), the lifted refs leak in both modes.
- The cross-isolate DO path leaks one stub entry per call, and under 1.13 one
  `dup()`ed Cap'n Web import per call. Phase 3 (3.2) owns this; a stopgap is
  to release the refs when a call to a foreign target settles.
- A stub with no request context (made in a top-level handler) runs each op
  in a fresh context, so it cannot be returned or passed from inside the
  target's method ("different request"). workerd allows it (one IoContext).
- Contradictory compatibility flags (enable and disable both set) are
  accepted, with the enable flag winning; workerd refuses them. 1.16 should
  refuse them for every switch.

**As built (done).**
- **Params in flight** (the two leak items). `__rpcOut` registers the entry
  references a call's lifted params carry as a *transit* when the call site
  passes one: same-isolate stub ops (`__stubOp`), Durable Object calls and
  runtime-cell calls (`__cellRpc`). Such params go out as a tag-3 envelope,
  `[isolate token, transit id, tree]`. The callee's `__rpcDesArgs` claims
  the transit when it revives them in the sending isolate; when the call
  settles (`__rpcTransitEnd`: the dispatch's end, or `__rpc_call`
  settling), an unclaimed transit is released newest first, as workerd
  drops a message's capabilities. A stub op's transit stays in the
  isolate (`local`): it keeps the references itself, the dispatch claims
  them just before it decodes (so only an op that never decodes releases
  them, at its end), and the params cross in the ordinary envelope. That
  covers a call refused before decoding (a failed `blockConcurrencyWhile()`
  refusing what queued, through a returned stub or the object's stub) and a
  callee in another isolate, whose markers revive as foreign stubs (for
  example every stateless Worker -> Durable Object call). A callee that
  decodes after its caller settled finds the transit gone and revives
  those stubs as released ones ("RPC stub used after being disposed."),
  adopting nothing. Another isolate's tag-3 params claim nothing here.
  Service-binding and loader calls lift no capabilities, and same-isolate
  `ctx.exports` calls decode synchronously, so they need no transit.
- **No failed clone first.** The projection marks a payload that holds a
  capability, a Proxy or a host instance (`lift`), and such a payload goes
  straight to the lift instead of failing V8's clone first, which made a
  DataCloneError (a stack trace) per call; the clone runs only to give the
  refusal when nothing was liftable.
- **A param's disposer is not lifted.** The lift gave a param object's
  `Symbol.dispose` an entry that no callee ever released; workerd
  serializes no param disposer (probed), so only results carry one now.
- **Stopgap for 3.2.** Under 1.13 a dup()ed param (a Cap'n Web import) now
  goes when the call to a foreign object ends, so a long-running caller
  stays flat. Left for 3.2: a stub a foreign callee *returns* leaks its entry
  in the callee's isolate (the callee cannot tell that its reply went to
  another isolate); a stream bridge in a refused or foreign call is not
  released (streams across isolates are refused, 7.1; same-isolate refusals
  leave the origin locked); and the stubs themselves still fail on use
  across isolates (3.1).
- **Stubs without a request context.** A stub entry made outside any
  request context (a stateless Worker's top-level handler) runs its ops, and
  pipeline hops into it, outside any context too when called from outside
  any (`__ctxRunIn`), instead of a fresh one each, so its target can return,
  pass on and use stubs made in the handler or in its earlier calls, as
  workerd's one IoContext allows. Called from a context (an entrypoint's
  call, say), it still runs in a fresh one: celld cannot tell stateless
  requests apart (1.57), so a param such a call hands the target, kept with
  `dup()`, must not become every stateless request's (the review found the
  first version let a later request pass it on; workerd refuses that with
  "different request", `/pass-kept`).
- **Proxies.** A Proxy is classified by the prototype chain it presents, as
  workerd's checkStubType (`__rpcStubType`, captured `getPrototypeOf` and
  `RpcTarget.prototype`): a plain object or a callable crosses as a stub over
  its own properties, an RpcTarget as a class stub, anything else (an array
  included, which celld used to copy) is workerd's proxy refusal. Under 1.13
  a Proxy's dup() must return an object of the same stub type (a plain
  object or function for a plain-object Proxy). A returned plain-object
  Proxy keeps its pipeline; only an RpcTarget Proxy has none. Durable Object
  stubs (celld's own Proxies) lift before the classification. RPC promise
  and property nodes carry a brand (`__rpcNodes`), which the lift's refusal
  and the dup rules read instead of `instanceof`. Calling a stub whose
  target is not callable throws workerd's `"(this)" is not a function.`
- **DataCloneError.** V8's refusal of a value it cannot clone is the
  DataCloneError workerd throws, with V8's text, wherever celld clones:
  the serializer delegates (`storage_ops.rs`) throw what
  `__celld.__dataCloneError` makes, for storage `put`, `kv.put`, a Queue's
  `send`/`sendBatch` (which threw `QUEUE_ERROR` before) and
  `structuredClone()` (which converted every TypeError, a getter's own
  included).
- **AbortSignal.** `enable_abortsignal_rpc` is honoured (experimental, so
  deploy accepts it and the Worker Loader refuses it) and reported.
  Without it every serialization of a signal throws "AbortSignal
  serialization is not enabled." (RPC params and results, Durable Object
  and loader calls, storage, a Loader env, `structuredClone()`); with it a
  signal crosses RPC as before, and storage, a Loader env and
  `structuredClone()` refuse it with "AbortSignal can only be serialized
  for RPC.", as workerd checks the flag first. No case or starter Worker
  sent a signal over RPC except `rpc/marker-shaped-data-internal`, whose
  signal step moved to the differential `rpc/marker-shaped-signal`, which
  sets the flag.
- **Contradictory flags** were already refused for every switch by 1.16
  (deploy, `celld dev` and the Loader, with workerd's text, probed again
  with wrangler). A unit test now checks every switch.
- **Wire.** Tag 3 is new; the stop-all upgrade note says so.
- **Memory** (lab build, local, peak RSS growth over the baseline step):
  4,000 stateless -> Durable Object calls, each passing an RpcTarget and a
  function holding 32 KiB and a duplicated stub: HEAD grows 121 MiB and then
  fails the Worker with "Array buffer allocation failed"; now 32-41 MiB
  (garbage awaiting GC), every param disposed. Twenty rounds of 300 calls
  refused by a failed `blockConcurrencyWhile()`, each holding 32 KiB and
  each round with a new callee: HEAD fails with "Array buffer allocation
  failed"; now 69-90 MiB (garbage, and twenty new objects). HEAD's peak,
  capped by that failure, is 139-141 MiB, under the case's 144 MiB bound,
  so what fails HEAD there is the transcript (its `released` counts, and
  the failed rounds), not the RSS step.
- **Cost** (lab build, `celld dev`, wall time of one request; 15 runs each,
  HEAD rebuilt from `git archive`, interleaved; medians): 20,000 same-isolate
  stub calls passing a function, from a stateless Worker 211 -> 139 ms and
  from a Durable Object 210 -> 164 ms; the same calls passing a number
  78 -> 67 ms; 5,000 stateless -> Durable Object calls passing a function
  484 -> 401 ms. The first version of this change cost the Durable Object
  case 15% (194 -> 223 ms in the review): a tag-3 envelope, a map entry and
  an abort closure per stub op; stub ops now keep their transit local, and
  the failed clone each lifted call paid at HEAD is gone.
- **Tests.**
  - Differential: `rpc/refused-call-params` (through a returned stub and the
    object's stub: the RpcTarget and function are disposed, the caller's
    duplicated stub only by its caller), `rpc/foreign-call-params` (to a
    Durable Object in another isolate: RpcTarget, function, a plain-object
    Proxy's dup() and its disposal, a duplicated stub, two params disposed
    last first), `rpc/stub-without-request-context`, `storage/clone-refusals`
    (functions, symbols, Proxies, nested values and WeakMaps in storage, a
    Queue and `structuredClone()`), `flags/abortsignal-rpc` and
    `rpc/abortsignal-without-flag` (shared `#abortsignal-rpc`: params with a
    late abort, a Durable Object call, a result, loader params, storage, a
    Loader env, `structuredClone()`), `rpc/marker-shaped-signal`;
    `rpc/marker-shaped-proxies` is no longer xfail; `rpc/params-dup*` gained
    plain-object Proxy rows (dup to a Proxy, a plain object and a function;
    no dup; a dup of the wrong type, both ways); `loader/compat-flags`
    gained the Loader's refusal of `enable_abortsignal_rpc`.
    `rpc/stub-without-request-context` `/keep` and `/pass-kept`: a param an
    entrypoint's call hands a top-level stub's target, kept with `dup()`,
    which a later request cannot pass on (fails with the first version of
    this change). The refused-call cases arm the block with a call that
    returns once the input gate is closed, rather than a wait.
  - xfail: `rpc/marker-shaped-proxies-service` (3.1: the service-binding row,
    split out), `rpc/stub-other-request` (1.57, with the kept-param and
    Durable Object rows), `rpc/service-binding-param` and
    `rpc/proxied-stub-param` (1.58).
  - celld-only: `rpc/foreign-call-params-memory` (64 MiB bound) and
    `rpc/refused-call-params-memory` (144 MiB), whose transcripts also pin
    that every param is released.
  - Unit: `js::rpc_params_tests` (released when unrevived, in both stub
    modes; the callee's once revived; nothing adopted by a late revival;
    a stub op's local transit claimed or released;
    another isolate's params claim nothing; no param disposer; what each
    Proxy shape crosses as), and `compat_flags` (every contradictory pair,
    in both contexts; the signal flag accepted at deploy, refused by the
    Loader, reported).
  - At HEAD: the two leak cases fail (no param is disposed), both memory
    cases fail (their transcripts, and the foreign one with 500s),
    `rpc/stub-without-request-context` fails ("different request"),
    `storage/clone-refusals` fails (TypeError, `QUEUE_ERROR`),
    `rpc/abortsignal-without-flag` and `rpc/marker-shaped-proxies` fail,
    `flags/abortsignal-rpc` and `rpc/marker-shaped-signal` do not deploy
    (the flag was refused), and the new `rpc/params-dup*` rows fail.

### 1.30 Durable Object reset follow-ups (found by 1.14)

- **A DO caller never gets a callee's reset.** DO "caller" awaits
  `stub.b()` on DO "target", and another event resets target (`abort()` or a
  failed `blockConcurrencyWhile`). On workerd, the caller catches the error.
  On celld the call never settles, and later calls to the caller, and to
  fresh objects in the same run, time out. A stateless caller works. This
  predates 1.14.
- **Autocommit writes made before a reset survive it.** A write stepped
  before the reset (e.g. `INSERT … RETURNING`) is kept; workerd's implicit
  transaction discards it. This predates 1.14.
- Transaction views still have `transactionSync`, `sql`, `kv` and `sync`,
  which workerd's `DurableObjectTransaction` lacks.
- **A stub that saw a reset keeps reaching the object** (found by the 1.29
  review). After a failed `blockConcurrencyWhile()`, workerd resets the
  object, and a fresh `getByName()` stub reaches a new instance (celld's
  too); the stub that saw the reset stays broken, its later calls (200 ms on
  as well) throwing the block's error. celld's old stub silently reaches the
  new instance. From a stateless Worker and from another Durable Object
  alike: `rpc/reset-stale-stub` (xfail).

**As built (done).**
- **The hang (root cause).** Each event has a driver task of its own, which
  enters the isolate only when one of the event's own ops completes (or, with
  none pending, on a poll tick). A reset rejects the other events of the
  object (`#untilReset`) in the resetting event's turn, so their promises
  settled in a foreign turn, and a driver waiting on a pending op of its own
  was never told: an event awaiting a timer answered when it fired, and one
  awaiting a call that never answers (another object's, the DO-to-DO shape
  of the report) never did, so its caller hung. A stateless caller hung the
  same way; only an event with nothing pending answered, on its tick. Now a
  reset asks every event driver of the isolate to look
  (`__io_context_poll()`, `IoContext::request_poll`): `runtime::wake`
  returns `Wake::Poll`, and `turn_poll` answers the settled event. Resets
  are rare and a poll of an unsettled event finds it pending, so no event
  records its driver. This covers every event `#untilReset` wraps: fetch,
  RPC, alarms, WebSocket handlers, and an object's call into its facet.
- **A dead critical section.** `ctx.abort()` while another event's
  `blockConcurrencyWhile()` callback still ran left the gate shut until the
  callback ended (up to its 30 s limit), so even fresh stubs waited. workerd
  (probed): a call after the abort reaches a new instance at once, one queued
  behind the block before it fails with the abort's error. An abort now
  releases the reset instance's hold with the abort's error
  (`__releaseResetGate`); the block's own release later finds it gone.
- **Stale stubs** (`js/do_instances.rs`). workerd (probed): a stub binds to
  the instance its first call reaches, by RPC or fetch; once that instance
  resets, by `abort()` or a failed block, every later call and `fetch()` of
  that stub throws the reset's error (type kept), whoever reset it, and no
  instance (no constructor) runs for it; a stub that never called, and a
  fresh one, reach a new instance; a call queued behind a failed block binds
  its stub too. celld: `__do_instance_begin` gives each instance a 16-byte
  token (a per-process nonce and a counter) in a node-wide registry; a stub
  frames each call with the token it is bound to (tag 6, or unbound; a head
  the stub keeps, which `__rpc_call` joins to the payload in the copy it
  makes anyway), the
  object answers with the serving instance's token when they differ (tag 4),
  and a stub bound to a reset instance gets the reset's error envelope (tag
  5), which it keeps and throws from then on, fetch() included, without
  sending. `#markReset` records the reset; a cell given back from a
  condemned isolate records its instance as reset with "Worker has exceeded
  memory limit." (`finish_cell_adoption`), a clean give-back forgets it. A
  call refused behind a failed block carries `__CELLD_ACTOR_RESET__`, which
  breaks its stub as the abort marker does. A stub reads the markers only in
  a host op's rejection, and only at the start of its message; an error
  decoded from the callee's answer never reaches them, so a message a script
  throws cannot break its caller's stub (`rpc/reset-marker-text`, which
  broke the stub through `fetch()` before the review's fix; the abort and
  exit markers had the same gap). The token is no authority: it can only
  fail its own stub's calls. A call bound to the live instance compares
  tokens in the isolate and takes no lock. Bounds: the node keeps the last
  1024 resets of each script, so one script never pushes out another's,
  each error envelope within 8 KiB (`__resetEnvelope` builds it from the
  error's name, as one of V8's error classes, the first 1024 characters of
  its message, with that text as its stack, and its own properties when they
  can be read and cloned within the bound, as workerd keeps them; every read
  of the value is in a `try`, and the host keeps a larger envelope as a reset
  with a plain message), so at
  most 8 MiB a script; a reset that falls out lets its stubs reach the
  current instance, as after a move to another node. A script that leaves
  the node (a generation without it) leaves no resets behind. Entries do
  not expire otherwise: workerd keeps a broken stub broken for as long as
  the stub lives. A registry entry is
  bound to the isolate that made it, and only that isolate's give-back ends
  or condemns it: no path was found where two isolates hold one cell (a
  generation swap gives the cell back before the new isolate takes it in,
  and a condemned cell is stopped before it starts again), but the take-in
  no longer touches the registry. The JS-flavored
  abort (from another object's event, through a handle) no longer refuses
  every later call to the object: workerd reaches a new instance for a fresh
  stub (`rpc/reset-through-handle`). Condemnation is not observable on
  workerd locally; celld treats it as the reset it is.
- **Discarded writes** (`storage.rs`, the implicit transaction). workerd
  (probed, both resets): an object's writes run in an implicit transaction
  that commits when the turn ends; `blockConcurrencyWhile()` commits it
  before its callback runs; `transaction()` commits on its own; a reset
  rolls back the rest. So a write in the reset's turn is gone, even an
  awaited `put()`, a consumed `INSERT … RETURNING` and `kv.put()`, and one
  before a timer, before a block or in a committed `transaction()` stays.
  celld now opens the implicit transaction (`BEGIN IMMEDIATE`) at an
  application write outside a transaction (KV ops, a flushed put, a SQL
  statement that is not read-only), commits it when the isolate turn ends
  (`Installed` drop) and before an output's sample, `storage.sync()`, a
  block, a transaction and an alarm write (its wake-entry gate needs the
  commit), and rolls it back on a reset (`__storage_discard_uncommitted`,
  which also ends the object's cursors) and in a condemned isolate. An
  unfinished write cursor holds it open within the turn, with the old output
  refusal, and refuses an alarm write the same way (its acknowledgement
  waits for a commit); a turn that ends with it still held resets the object
  (below).
- **A commit that fails resets the object**, as workerd's broken output gate
  does (probed with a deferred foreign key the turn violated,
  `storage/reset-failed-commit`): the call that wrote fails, the stub that
  made it stays broken, and a fresh stub reaches a new instance on storage
  that never held the write. The error is workerd's, "Durable Object was
  reset and rolled back to its last known good state because the
  application left the database in a state where constraints were
  violated: …", or "internal error" for a failure that is not a constraint.
  All of it runs on the host, since the turn has ended: the commit rolls
  back and records the error as the cell's critical SQL error (no output,
  sample or `storage.sync()` leaves the cell, and its storage refuses every
  operation); `do_instances::cell_broken` records the instance as reset
  with that error and queues the cell; the actor drains the queue after
  each step (`Event::CellBroken`, beside the condemnation counter), and the
  core moves the cell out of its isolate as it moves a condemned isolate's
  (quiesce, cancel what still runs, stop, start again at the same epoch),
  so the give-back drops the instance and the error, and the next event
  builds a new instance. Every critical SQL error of an application's object
  takes this path (`storage::record_critical_error`): a full disk or an I/O
  error that ends the implicit transaction, a failed rollback, and a turn
  that ends while an `INSERT … RETURNING` cursor still holds its commit,
  which workerd fails with an internal error (`commit_or_reset`). An alarm
  handler's writes commit before its alarm is consumed, so a failed commit
  counts as a failed run and retries with backoff, as on workerd
  (`storage/reset-alarm-write-cursor`; before, the reset rolled back the
  host's deletion of the alarm and it fired again at once, without end); a
  rollback republishes a dirty alarm. The broken cells are queued on the
  isolate (`Slot::mark_broken`), so each host takes only its own, and the
  actor sees them after its next step, as it sees a condemnation. Moves that
  a broken cell or a condemned isolate forces take none of a generation
  swap's room, so one script breaking its objects does not hold off another
  script's swap, and a broken cell that stops some other way leaves the set.
  A facet has no cell of its own to move and stays failed closed until its
  root moves (1.59). Its
  statements run cached under the authorizer (`IMPLICIT_CONTROL`), since
  toggling the authorizer expires every prepared statement. celld's own
  cells (KV, Queue, D1, workflows, cron) keep autocommit. Differences left
  are 1.59's.
- **Transaction view surface.** workerd (probed): DurableObjectStorage and
  DurableObjectTransaction each have their own prototype below
  Object.prototype; the transaction's has get, put, delete, list,
  deleteAll, the alarm methods and rollback, and no transactionSync, sync,
  kv or sql; the storage's has no rollback. celld's classes now expose
  exactly those (a shared base keeps the implementation out of sight), and a
  view no longer builds its own `kv` and `sql`. The storage's missing
  bookmark methods are 1.59's. A script that replaces "the prototype below
  the storage's" now replaces Object.prototype's members, as on workerd, so
  the harness's property descriptors made at request time (and those of
  Headers, the internal streams' read results and readers, CryptoKey and
  DigestStream) are null-prototype: an inherited `get` made them invalid.
  `env/patched-prototypes` patches the storage's own prototype instead.
- **A reset is recorded whatever the script patched.** The envelope is
  built from an Error whose name, message and stack are its own, with the
  captured TypedArray `set` and `length` (`__tagged` uses them too); if even
  that fails, the host keeps a plain reset (no envelope).
- **A reset runs to its end whatever was thrown.** `#markReset` rolls back
  transactions and fails events before it records the reset, and the
  record runs in a `try`: a reset error with a throwing getter, a revoked
  Proxy, or a megabyte stack (`Error.stackTraceLimit` raised) made the
  record throw first and skip the rest. `__rpcErrOut` reads such an error
  inside a `try` too, and sends its message only
  (`storage/reset-hostile-errors`).
- **Frames are checked**: a flag other than 0 or 1, or a frame shorter than
  its header, is refused as malformed.
- **Tests.**
  - Differential: `rpc/reset-caller` (stateless and DO callers, abort and
    failed block, the target waiting on nothing, a timer or a silent call;
    every wait bounded, so a hang reads "hung"), `rpc/reset-waiters` (an
    abort under another event's block, before and after a queued call; a
    call into a facet; an alarm handler), `rpc/reset-stale-stubs`,
    `rpc/reset-through-handle`, `rpc/reset-marker-text`,
    `storage/reset-hostile-errors` (with the builtins patched in an abort),
    `storage/reset-failed-commit`, `storage/reset-alarm-write-cursor`,
    `storage/reset-discards-writes` (28 rows),
    `storage/transaction-surface`; `rpc/reset-stale-stub` is no longer
    xfail. celld-only: `limits/request-memory` gained a write in the turn
    the limit stops (discarded) and a stub bound before it (stale).
  - xfail (1.59): `rpc/reset-stale-stub-fetch`, `rpc/reset-websocket`,
    `rpc/do-fetch-throws`, `rpc/facet-bound-class`,
    `storage/reset-discards-writes-xfail`, `storage/storage-surface`,
    `storage/reset-revoked-error` (with the builtins patched in a block),
    `storage/alarm-under-write-cursor`, `storage/facet-failed-commit`.
  - Unit: `js::do_instances::tests` (5, with per-script quotas, a
    give-back of another isolate and a commit failure),
    `celld_logic::tests` (a broken cell moves alone at the same epoch; broken
    cells leave a generation swap its room; a broken cell that stops leaves
    the set), a script leaving the node, a full disk and a turn ending under
    a write cursor (both reset the object), `storage::implicit_transaction_tests` (7,
    with a turn-end commit failed by a deferred foreign key, and an alarm
    write under a write cursor), `js::io_context_poll_tests` (1).
  - At HEAD: `rpc/reset-caller` hangs on the 8 timer and silent-call rows,
    `rpc/reset-waiters` on its gate and facet rows (and
    `rpc/reset-websocket` on both), `rpc/reset-stale-stub(s)` reach the new
    instance, `rpc/reset-through-handle` refuses the fresh stub, 11 rows of
    `storage/reset-discards-writes` keep their writes, and
    `storage/transaction-surface` and `limits/request-memory` fail.
- **Cost** (lab build, `celld dev`, 20,000 sequential calls to one object
  per request; medians of interleaved process starts against HEAD built
  from `git archive`): a call that touches no storage 1.35 -> 1.40 s
  (+3.5%: the head and the bind check), one `kv.put()` per call 11.18 ->
  11.29 s (+1.0%: the implicit transaction's cached BEGIN and COMMIT), one
  `SELECT` per call 1.58 -> 1.66 s (+4.8%, a read opens no transaction). A
  first version that toggled the authorizer for the implicit statements and
  opened one for reads cost the `SELECT` case 32%; one that framed each call
  in JavaScript, with a copy of the payload, cost the plain call 4.7%.
- **Wire.** Durable Object RPC payloads carry the new frames; the stop-all
  upgrade note says so.

### 1.31 Isolate heap limit during module load (found by 1.15) — security

**Problem.** The isolate heap limit is not enforced while a module loads. An
untrusted Dynamic Worker's top-level code retained 1.5 GB of RSS, despite
the 128 MiB isolate limit. Copying a 1 MiB Loader env that aliases one large
object from many keys into `process.env` reaches about 1.4 GB the same way.
For model-written code (code mode) this is a host memory exhaustion path.

**Design.** Enforce the heap limit (and the CPU limit, if it's missing too)
during module compile, evaluation and env install, failing the load loudly,
as at request time. Check what workerd does on startup and match its error.

**Tests.** A celld-only case: a Dynamic Worker that allocates past the limit at
module scope is refused with a clear error, and the node stays healthy.

**As built (done).**
- Every isolate load (deployed, DO cell, Dynamic Worker, and pools growing
  later) runs under the heap limit and a 1 s startup CPU budget, measured as
  thread CPU.
- At the heap limit the load is terminated. The extension while loading
  covers V8's largest single object (1 GiB), so one huge allocation finishes
  and then the load stops, rather than aborting the node. Peak RSS can
  briefly reach a few GB (measured 2.2 GB for a 1 GB array).
- Errors use Cloudflare's text: "Script startup exceeded memory limits." and
  "Script startup exceeded CPU time limit."
- Cases: `loader/startup-memory` and `loader/startup-cpu`. Cloudflare OS's
  largest load measured 137 ms CPU and 35 MB heap.

### 1.32 Heap limit at request time (found by 1.31) — security, next

**Problem.** `near_heap_limit` only flags the isolate and raises the limit
(max(current+16 MiB, 2×limit)), so nothing ever terminates JS at request
time. A Dynamic Worker whose `fetch` allocates about 1.4 GB crashes the whole
node ("Fatal JavaScript out of memory: Reached heap limit", SIGTRAP). That
takes down every Worker on the node.

**Design.** On the callback, terminate the running event with workerd's text
"Worker has exceeded memory limit." (`io-context.h`) and condemn the isolate,
so no further event runs in it. Its in-flight events fail and the next event
gets a fresh isolate. Reconcile this with the README's documented soft-limit
design for DO cells: a DO condemned this way resets, as on Cloudflare.

**Tests.** celld-only cases: a Dynamic Worker and a stateless Worker that
allocate past the limit in a request get the error; the node keeps serving
other Workers; and a DO that exceeds the limit resets.

**As built (done).**
- At the limit the running event is terminated with "Worker has exceeded
  memory limit.", and the isolate is condemned for good. The single-object
  extension means one big allocation finishes first instead of aborting.
- No JS runs in a condemned isolate again: every turn entry is guarded, its
  in-flight events fail with the same error, captured WebSocket frames are
  discarded, and hung events are woken through `until_condemned`.
- Stateless pools replace the slot. A Dynamic Worker reloads on its next
  call, with backoff (1 s doubling to 60 s). Calls during backoff get a
  distinct message. Transient first-load failures (startup CPU limit,
  JoinError) are retried; deterministic ones stay failed.
- DO cells move to a fresh isolate at the same epoch (a new core event,
  `IsolateCondemned`). Condemned cells are nominated first and quiesce, so
  their requests queue rather than fail.
- Facets recorded in a condemned loaded isolate are released and closed
  host-side, so no dead heap or open SQLite connection is pinned.
- The old soft-limit recovery is removed.
- Measured peak RSS: one 400 MB allocation peaks at about 780 MiB and returns
  to about 60 MiB. Gradual growth stays at about 195 MiB. Repeated facet
  condemnations stay flat.
- Cases: `limits/request-memory` (stateless, Dynamic Worker, DO, concurrent
  in-flight events, facet cycles). celld-logic now has inline unit tests
  (4).

### 1.33 ArrayBuffer and Wasm memory outside every limit (found by 1.31) — security

**Problem.** Backing stores (ArrayBuffer, typed arrays, Wasm memory) aren't
counted by the heap limit. 40 × 64 MiB `Uint8Array`s at module scope loaded
at 2.6 GB RSS, and the same works at request time. Cloudflare's 128 MB
includes this memory.

**Design.** A per-isolate counting array-buffer allocator
(`v8::new_rust_allocator`) that refuses past the isolate's limit, together
with 1.32's termination.

**Tests.** Module-scope and request-time cases that exceed the limit with
backing stores are refused, and the node stays healthy.

**As built (done).**
- Backing stores have a per-isolate budget as large as the heap limit,
  separate from the heap (V8 can't share one safely), so an isolate holds at
  most heap + budget at turn end. A counting allocator returns null past it,
  so V8 throws `RangeError: Array buffer allocation failed`. A standing
  refusal at turn or load end condemns the isolate (1.31/1.32 paths).
- Host-created buffers (bodies, crypto, zlib, SQL blobs, bundle files) are
  charged. A synchronous one past the budget is refused within the turn.
- Whole-body reads are drained on the host, charged chunk by chunk, and
  handed over zero-copy, so about 100 MB fits again. Concurrent reads may
  reach 2× the budget between turns.
- Wasm memory is counted at turn and load end through V8's external-memory
  counter, and each memory is capped at the limit.
- Measured: 40 × 64 MiB buffers went from loading at 2.5 GB to refused at
  about 53 MiB. The zip-bomb loop went from 1.3 GB to refused at about
  140 MiB. Pyodide peaks at about 37 MB external.
- Bench within 1.5% of before. Case `limits/backing-stores`.
### 1.35 Wasm memory per isolate (found by 1.33) — security

**Problem (as narrowed by 1.33).** Wasm memory and resizable ArrayBuffers are
counted only at turn and load end, through V8's external-memory counter. So
within one turn:
- several Wasm memories (each capped at the limit) reached about 1 GB RSS
  before condemnation;
- a resizable ArrayBuffer can grow to its `maxByteLength` (1 GiB measured).

**Design.** Track the total per isolate: a harness wrapper around
`WebAssembly.Memory` and `Instance` that sums exported and imported
memories and their grows, or a V8 API if one exists in this version. Past the
budget, refuse with V8's RangeError and condemn, as 1.33 does.

**Tests.** Many Wasm memories at load and at request time are refused, and the
node stays healthy.

**As built (done).**
- V8 offers no hook, so there are two parts:
  - Strict harness wrappers, with captured originals, admit growth before it
    happens: `resize`, `transfer`, `transferToFixedLength`, growable SAB
    `grow`, `Memory.grow`, `maxByteLength` initial lengths. Memory,
    Instance, instantiate and structuredClone are checked after.
  - A `MemoryWatch` thread interrupts running turns of isolates that made
    WebAssembly every 5 ms, catching growth inside Wasm code.
- The wrappers are native-looking named functions: they match workerd's
  names, lengths, `toString`, descriptors and error texts
  (`limits/growth-fidelity`).
- A Memory descriptor is converted before the construct, so no Worker code
  runs while the watch is paused. A tick during the pause is deferred, not
  dropped.
- **Decision:** a refusal throws V8's RangeError and never condemns on its own,
  so Emscripten's overgrow-then-fallback works. Only memory actually held
  past the budget condemns. This changed 1.33's caught-refusal behaviour.
- read_all uses workerd's two texts ("would be exceeded" and "exceeded
  before EOF").
- Measured: a 3 GiB transfer then fill went from a 3126 MB peak to refused at
  151 MB. Ten Wasm memories went from 1059 MiB to 54 MiB. The descriptor
  bypass went from 1228 MB to 152 MiB. `ab` hello-world is within 1%.
- Remaining (documented): Wasm self-growth can pass the budget by an eighth
  plus 5 ms of writes; a resizable buffer revived by the host is caught at
  turn end.
### 1.34 Isolate limit follow-ups (found by 1.31)

- Deployed Workers and DOs have no per-request CPU limit (only Dynamic
  Workers with `cpuMs`).
- A failed Loader load holds its registry slot until GC finalises the stub.
- Check: `ns.get(...).unwrap()` in `load_realm` may panic if a module
  namespace binding is still in its TDZ while top-level await is pending.
  Done by 1.18: a pending top-level await now fails the start first.
- When 1.18 adds the "Failed to start Worker:" prefix, decide whether the two
  startup-limit errors get it too. Decided in 1.18: they do, as
  `Failed to start Worker:` then `Error: Script startup exceeded …`, from
  workerd's source (its local runtime has no limits to probe).
- `Response`/`Request` have no `bytes()` method in celld; workerd has one.
- celld's own frames show in `error.stack` as `celld:internal`; workerd's
  C++ APIs add none (found by 1.18, which leaves them out of the startup
  report only).
- A `DOMException` subclass's constructor frame is missing from a startup
  report: celld's `DOMException` is a JS class, so the construction frames
  are its own and dropped, where workerd reports the subclass constructor
  (found by 1.18; `loader/startup-errors-dom-subclass` is xfail on it).
- A recorded facet whose host-side close fails (only warned) keeps its
  database open until the isolate drops.
- The facet-of-a-Dynamic-Worker-class path under condemnation is covered only
  through `limits/request-memory`'s supervisor; the 1.31 load tests could
  use the same margin-based allocation as 1.32.
- A DO caller sees "route failed: RuntimeFailed" for any startup failure of
  the callee's cell isolate, because `RequestError::RuntimeFailed` carries no
  text. Carry a startup-failure kind and message through
  `Event::RuntimeStarted`, `RequestError`, the shell and peer errors.

**As built (done).**
- **CPU limit.** workerd's open source enforces none: `server.c++` gives
  every isolate a `NullIsolateLimitEnforcer` and every request a no-op
  `LimitEnforcer`, and Wrangler's `limits` (`UserLimits`: `cpu_ms`,
  `subrequests`) reaches only Cloudflare's upload metadata. Probed: a spin
  never ends on workerd run locally, so the cases are celld-only. On
  Cloudflare an actor has one IoContext, which its limit enforcer aborts when
  an event runs out (`io-context.c++`, `abortWhen(onLimitsExceeded())`),
  resetting the object, and each new event tops the actor up (`topUpActor`).
  Cloudflare documents 30 s by default, 5 min at most, error 1102 ("Worker
  exceeded resource limits") and the outcome `exceededCpu`; no in-Worker
  text, so celld uses "Worker exceeded CPU time limit." (the JS form of
  workerd's "Python Worker exceeded CPU time limit"), now also for a Dynamic
  Worker's `cpuMs` (was "Worker exceeded CPU limit of N ms").
  - `celld deploy` and `celld dev` accept `limits.cpu_ms` (whole ms, 1 to
    300 000) into `Manifest::cpu_ms` and Wrangler's `metadata.limits` (so a
    limit change is a new version), required feature `limits-v1`, and the
    node checks the range again. `limits.subrequests` stops the deploy (no
    subrequest counting for deployed Workers; 1.60).
  - Every Worker's config now carries a limit: the plan's 30 s unless
    `cpu_ms` sets one, and a Dynamic Worker's `cpuMs` within the plan's
    (default 30 s, at most 5 min). Only the runtime cells (no application
    code) have none. Each invocation (request, RPC, queue batch, cron run, a
    Durable Object's request, RPC, alarm or WebSocket message) gets its own
    budget, through the Dynamic Worker machinery (`IoContext` budget, exact
    accounting per turn, the process CPU watchdog for a turn that never
    returns).
  - A Durable Object event past its limit resets the object: the turn's
    implicit transactions and its queued puts roll back before the event
    samples its gate positions, then `record_critical_error` breaks the
    object (`do_instances::cell_broken`), so its other events fail, its
    stub keeps throwing, and the next call reaches a new instance. Any other
    object with a transaction open in the cut turn resets too (its
    continuation was cut). An alarm that runs out is retried in the new
    instance. A stateless invocation only fails; the isolate lives on.
  - User code runs under a watchdog at every turn entry; the host entries
    outside events (adoption, release) run only celld's code, and what they
    queue for a Worker runs at a later watched checkpoint.
  - Hot path: the watchdog wakes its thread only for a watch due sooner than
    its next wake, and not at a watch's end; a turn's watchdog covers its
    settle (one registration per turn, not two); a turn's first sample and
    the end of its first half seed the next (3 thread-CPU reads per turn,
    not 6).
- **Failed Loader loads.** A load that failed for good drops its config (the
  modules) and no longer counts against the 255/256 live limits; a script
  can keep 256 failed loads referenced, past which a load fails with
  "too many failed loads … still referenced".
- **`bytes()`.** On `Response` and `Request`, as workerd's `Body::bytes`
  (probed: a Uint8Array over a buffer of its own, `length` 0, the body
  used). The used-body text is now workerd's ("read it twice").
- **`celld:internal` frames.** A `PrepareStackTraceCallback` drops celld's
  call sites, and a builtin celld's code called (`String`, `JSON.parse`),
  then calls the realm's `Error.prepareStackTrace` with the rest, or formats
  them as V8 does. Probing showed two more differences, both fixed: the
  default export's `fetch` and `scheduled` ran with `this` undefined, and
  through a self-targeted service binding or a cron trigger with `this` the
  harness's `__cell` (now bound to the exported object, as workerd calls
  them; `tracing/otlp-export`'s stack now reads `at Object.fetch`); and
  `Invalid header name: <name>` is workerd's `Invalid header name.`.
- **DOMException subclass frame.** The constructor re-captures its stack
  from itself (`Error.captureStackTrace(this, DOMException)`), so a
  subclass's constructor frame stays; `loader/startup-errors-dom-subclass`
  passes.
- **Facet close.** Already holds: a give-back closes the database before the
  isolate's release can fail (`finish_cell_adoption`), and the facet record
  is taken first. Pinned by a unit test.
- **Facet of a Dynamic Worker class.** `loader/startup-memory` now loads a
  facet whose class's module scope passes the limit, gradually and as one
  400 MB string, and the root's next facet works; its single-allocation
  children use 1.32's margins (480 MB array, 400 MB string).
- **Startup text for a Durable Object caller.** A cell start that fails
  while loading the Worker records the loader-form text
  (`js::startup_failure_text`), kept per cell (at most 4096) until the cell
  next starts, and `RoutedRequestError::for_cell` reports it for
  `RuntimeFailed`, locally and in the peer replies. Other start failures
  keep "route failed: RuntimeFailed". No case: no deterministic way to fail
  only a cell isolate's start (unit tests instead).
- Cases: `limits/request-cpu` (celld-only), `loader/failed-load-slots`
  (celld-only), `fetch/body-bytes`, `builtins/stack-frames`,
  `exports/handler-this`, `loader/startup-memory` (extended),
  `loader/startup-errors-dom-subclass` (flipped). Unit tests for the limits,
  the deploy key, the give-back and the startup text.
- Measured (lab, `ab -n 20000 -c 16`, medians of 9 interleaved rounds):
  plain fetch 19569 → 19353 req/s (−1.1%), Durable Object RPC 16759 →
  16575 (−1.1%); before the hot-path changes above, −2.8% and −3.2%.

**As built, review round.** An independent review found eight things; each
is fixed with a test:
- **User code after the watchdog.** A thrown value was formatted with its
  own `toString` after the turn's watchdog ended (`exc!`), so `throw {
  toString() { for (;;); } }` pinned a thread. Thrown values are now
  described with V8's side-effect-free conversion (`thrown_text`, from
  `Exception::create_message`). Audited: the other conversions of a Worker's
  values run in ops or under the turn's watchdog; startup reports run under
  the startup watchdog. Case step `throw-spinning`.
- **SQL.** Every cell connection has a progress handler (every 10 000
  steps) that interrupts the statement once the watchdog has ended the turn
  (`Cells::cpu_abort`, cleared when the turn takes the termination or the
  watch ends). An interrupted statement resets the object with the CPU
  error. Case step `do-sql` (a recursive CTE without a bound). Cost
  measured against the same build without the handler: within noise
  (+0.6% on a SELECT per call).
- **Builtins.** V8 15.2 drops a termination requested while `JSON.parse`
  (and `JSON.stringify`) works on a large value; reproduced in a bare
  isolate with a 128 MiB heap, where a loop of them ran to its end (8 s and
  38 s). `--interrupt-budget` (8192, 1024) and `--no-sparkplug
  --no-maglev` changed nothing. Both are now native-looking JavaScript
  wrappers (`replaceMethod`), whose entry checks for interrupts: the
  38 s loop stops at about 150 ms. The stack filter keeps the builtin's frame
  when the Worker called the wrapper. Other loops measured (`fill`, `sort`,
  `Array.from`, `split`, a backtracking regex) stopped near the limit on
  the author's machine; the review saw a loop of `new Array(1e6).fill(1)` run
  about 9 s past a 1 s limit (see 1.61). The
  watchdog now asks again every 10 ms (`request_interrupt`, ignored once the
  watch has ended, so a late request stops no later turn), and condemns the
  isolate after `max(100 ms, limit)` past the limit, as the memory limit
  does (`HeapLimitState::cpu_condemned`, `Slot::condemned_text`, the DO
  reset carries the CPU error). Unit test for the escalation; case step
  `stateless-json`.
- **The wrong object charged.** The watchdog's interrupt runs on the isolate's
  thread and reads the running code's context from its continuation data
  (`running_context_id`); that event fails too
  (`IoContext::fail_past_cpu_limit`, at its driver's next poll), with the
  turn's own. Case step `do-cross` (a continuation of one object run in
  another's turn): both fail at once, where the waiter hung before.
- **A stateless turn's writes.** Every CPU failure rolls the turn back,
  whatever its event (`roll_back_stateless_past_cpu_limit`). Unit test.
- **Sizes.** Startup-failure texts and a failed load's error keep at most
  4 KiB (`bounded_failure_text`); failed loads are also capped process-wide
  (1024). Unit tests.
- **Stale or wide startup text.** A cell's entry is cleared at every start
  attempt, and only a failure to load the Worker (`pool::WorkerLoadFailed`)
  is reported as one. Unit test.
- **Nits.** `cpu_ms` accepts an integral float (`100.0`); a Dynamic
  Worker's `cpuMs` over 300 000 is refused, in `WorkerCode.limits` and in
  `getEntrypoint()` (no Cloudflare text found); the docs say `celld dev`
  keeps the limits and `wrangler dev` has none.
- Measured after the round (lab, `ab -n 20000 -c 16`, medians of 11
  interleaved rounds against HEAD, over four runs): plain fetch −0.4% to
  −1.6%, DO RPC −1.0% to −1.6%, a DO call running one SELECT over 1 000
  rows −2.6% to −4.9%. Against the same build without each change, the
  progress handler measured +0.6% and the JSON wrappers +0.5% on that path
  (noise), so the SELECT path's extra cost is not either of them; not yet
  found.

**As built, second round.**
- **D1 query limit.** Cloudflare documents a 30 s "Maximum SQL query
  duration", which covers a whole batch, and lists "D1 DB exceeded its CPU
  time limit and was reset." among D1_ERROR messages (no text for the
  duration limit itself). Each D1 call now runs under a wall-time deadline
  (`with_d1_deadline`, `CELLD_D1_QUERY_LIMIT_MS`, default 30 000); the
  progress handler interrupts a statement past it. The interrupt records
  no critical error, the transaction bracket (BEGIN, COMMIT, ROLLBACK) runs
  outside the deadline, and the call fails with `D1_ERROR: D1 DB exceeded
  its CPU time limit and was reset.`, its writes rolled back. Case
  `storage/d1-query-limit` (celld-only, 300 ms): a prepared statement, a
  batch and an `exec()` with a recursive CTE fail, their writes do not land,
  and the next query succeeds.
- **`storage/reset-alarm-write-cursor`.** The alarm fired 20 ms after
  `arm()`, so a slow `arm()` was cancelled by the reset it caused ("The
  client has disconnected"). The alarm is now set 500 ms out, and `/check`
  waits, bounded, for the second run and then 1 s more, well before the
  third (4 s after). Re-recorded on workerd, unchanged.

**As built, third round.**
- **The builtin loop.** Investigated before 1.61: a bare isolate with a 128 MiB
  or 1 GiB heap stops `new Array(1e6).fill(1)` in a loop at the limit
  exactly (1.000 s for a 1 s limit), and so does celld (1.006 s with
  `cpu_ms: 1000`). 48 such requests 200 ms apart ended in 1.0–1.7 s on 24
  cores and 1.0–6.1 s pinned to 4 (`taskset`), with `/ping` answering in
  2–8 ms throughout; I could not reproduce the review's 45–78 s. A loop
  that allocates large holey arrays (`new Array(1e6)`) ends at about 2.3 s
  wall for a 1 s limit: the limit counts the isolate thread's CPU time, and
  the parallel GC's helper threads make up the rest. No V8 deferral was
  found to fix. The structural hole (turns on the Tokio workers) is 1.61;
  `limitations.md` says so.
- **Stack formatter.** It reads V8's call sites once into a `Vec`, hands a
  Worker's `Error.prepareStackTrace` an array made by
  `Array::new_with_elements` (data properties, which no `Array.prototype`
  setter sees), and formats from the `Vec`. A wrapper is known by where its
  function starts in the harness (`TransparentWrappers`, recorded from
  `__transparentWrappers`), not by its name, so an aliased `JSON.parse`
  keeps its frame; the wrappers pass their own receiver, so the frame
  reads `parse` as workerd's does. Case `builtins/stack-frames` gains
  `parseAliased` and `prototypeSetter`.
- **Spent watches.** A termination records the watch that asked for it,
  and taking it marks the watch spent: the service no longer asks again or
  condemns for it, and its interrupt does nothing. A watch's end clears the
  isolate's `cpu_abort` only when no other live watch of the isolate fired.
  Unit test: after the take, the same turn runs more JavaScript with the
  watch still registered.
- **Fair caps.** At the process-wide caps (1024 failed loads, 256 live
  Workers) only a script holding at least its fair share (the cap over the
  scripts holding entries) is refused, so the process holds at most the cap
  and one entry per script. Unit tests.
- **Condemnations outside the lock.** The watchdog collects the slots to
  condemn and condemns them after releasing its lock, upgrading the slot's
  weak reference only on the turn's runtime. Unit test where the interrupt
  lands in running JavaScript (`running_context_id`). The earlier test
  segfault: the escalation test built its isolate on a blocking-pool thread
  and dropped it from the runtime's thread; on one thread of its own it is
  stable (V8 isolates must be disposed where nothing else is entered). The
  exact fault was not pinned down further.
- **D1.** `with_d1_deadline` disarms the deadline in a drop guard, and the
  limit's error is reported only when the progress handler interrupted a
  statement for the deadline (`D1_INTERRUPTED`), not for any failure after
  it. Unit test.
- **Nits.** `Slot::condemn` keeps the first reason atomically (one `AtomicU8`
  for memory or CPU); `WorkerLoadFailed` displays only the load's error and
  keeps the host's context in its source chain, for the log.
- **SELECT path.** With the DO cells' limits off (`IoContext::tracked`
  without limits) a SELECT per call costs −1.8% against HEAD, and −6.2% with
  them; a DO call without SQL −0.8% and −1.6%. User-space `perf` profiles of
  the two builds are alike (the CPU-limit code under 0.3%, mutex unlock 0.52%
  against 0.61%), so no watchdog contention shows; the difference is in
  kernel time, which `perf_event_paranoid=2` hides: each limited turn makes
  three thread-CPU-clock system calls (about 400 ns each). Not fixed; 1.60.
- Measured after the round (lab, `ab -n 20000 -c 16`, medians of 11
  interleaved rounds against HEAD): plain fetch −0.4%, DO RPC −1.2%, a
  SELECT per DO call −3.9%.

### Phase 1 gate

- All new conformance cases pass on both runtimes.
- W1 (except `ai`/`browser`), W2, W3, W4 and W5 are gone from
  `generate.ts`, and `e2e.sh deploy --router` succeeds.
- The browser shows the home page through the router.
- Smoke S0, S1 and S10 pass. S3-S7 still fail, now only for the Phase 2/3
  reasons (S11 is clean of "Invalid reader mode" and "dropped a frame").
- `celld/integration.sh` passes: the self-test is green, there is no
  regression, and no suite's first error is "Invalid reader mode".

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
- 1.29's stopgap releases a call's params when a call to a foreign target
  settles (transits); importer redemption replaces it. It does not cover a
  stub a foreign callee returns, whose entry stays in the callee.
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

3.1 also: a Durable Object in another isolate that calls `dup()` on a stub
param gets a rejected Promise ("RPC stubs cannot cross isolate boundaries
yet."), where workerd hands it a stub that outlives the call.

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

**Integration (adapter):** move `workshop-lifecycle`, `workshop-agent`,
`workshop-presence`, `observer-exclusion`, `observer-reverification`,
`observer-role-scope` and `observer-scope-promotion` to `passing` in
`status.json`. The observer suites also need Phase 2's account-stub storage.
`workshop-sharing` and `workshop-blueprints` also need 1.8, and
`workshop-blueprints` needs 1.24.

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

`streams/byob-rpc-cross-script` (xfail until 7.1, added by 1.8) loses its
`xfail` here.

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
- **DO `script_name` bindings** (a DO class from another script) are refused.
  Only upstream's fixture gatekeeper uses one. Decide whether to support it
  (it fits 2.4 and Phase 4) or keep refusing it.
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
