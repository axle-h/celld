# Cloudflare OS on celld: prior art from other forks

Several people have forked celld to run Cloudflare OS. This page records what
each fork did, what we learned from it, and exactly which commits the
[implementation plan](cloudflare-os-fixes.md) takes, reworks, or uses only as
reference. Reviewed 2026-10-21.

## Getting the commits

The fork branches are fetched into this repo as namespaced refs. No remotes are
added. To refresh them, or to fetch them into a new clone:

```sh
f() { git fetch --no-tags "https://github.com/$1/celld" "+refs/heads/$2:refs/forks/$1/$2"; }
f royalcala celld-os/rpc
f royalcala spike/rpc-062
f patcon rpc-targets-cross-isolate
f IlyaGulya agentos/cloudflare-os-phase0-runtime
f cnicolov fix/cross-isolate-rpc-capabilities
f mertdogar fork/v0.6.2
f mohamedalichelbi main
git for-each-ref refs/forks
```

Bringing a commit in follows the **adoption policy** in
[cloudflare-os-fixes.md](cloudflare-os-fixes.md#adoption-policy-for-code-from-other-forks):
- a line-by-line review of the whole diff;
- a failing test first;
- a security checklist;
- a provenance check;
- no unrelated hunks.

The dispositions below come from reviewers' readings of the diffs (2026-10-21).
They are where to start, not approval. Only royalcala `celld-os/rpc` was
compiled; nothing else was built or tested on our base.

- Drop any `Cargo.toml`/`Cargo.lock` version bump. patcon's commits set
  `0.6.1-rpc-targets.N`.
- Add the plan's tests and docs in the same commit or the next one.
- Credit the author with a `Co-authored-by:` trailer.

**Commits marked "reference" must not be cherry-picked.** Read them for
mechanism and reimplement.

The app-side forks were cloned for review into
`/tmp/.../scratchpad/forks/` (temporary). Re-clone as needed:

- `https://github.com/patcon/cloudflare-os-celld`, branch `celld-test`
- `https://github.com/mohamedalichelbi/cloudflare-os`, branch
  `portability/celld-mvp`

## The forks

| Fork | Base | What it reached | Use |
| --- | --- | --- | --- |
| **patcon** `rpc-targets-cross-isolate` + app fork `cloudflare-os-celld@celld-test` | v0.6.1 | Single node, **workshop only** (no router, gatekeepers, admin or stored stubs): workspaces, streaming chat, gadgets, live sync between tabs, agent code mode, `env.GADGET` | `scripts/celld/TODO.md` is the best failure log available. The runtime code is a spike, and its capabilities can be forged. |
| **royalcala** `spike/rpc-062` | v0.6.2 | patcon's patches rebased onto v0.6.2. Merges cleanly with our `main`. | **The cherry-pick source for patcon's work** (same commits, already on our base). |
| **royalcala** `celld-os/rpc` | v0.6.2 | HMAC token codec, cross-isolate capabilities for DO- and stateless-owned targets, streams as capabilities, "durable" restore through a `_cf_RESTORE` table. Builds; 14 unit tests pass. Merges cleanly. | The token codec, key source, and first in-tree tests are worth taking. **Its capability routing has a forgery hole** (below), and its restore is not storable. |
| **IlyaGulya** `agentos/cloudflare-os-phase0-runtime` | v0.5.0 | The widest coverage: migrated namespaces, callable `ctx.exports` classes, cross-script DO classes as facet classes, restore, props, WebSocket handoff, cross-node bridges, fleet soak, and a 43-case `examples/cloudflare-os-compat/` suite | A reference and test corpus. Three releases behind (7 conflicting files), and about a third of it is superseded by v0.6.x. |
| **cnicolov** `fix/cross-isolate-rpc-capabilities` (`fcb1977`) | v0.6.1 | One careful commit: cross-isolate routes with refcounts, dup, remote dispose, ordering and gates, a transactional lift, streams, a no-op tracing stub, a full-binary test and an example | Reference. Its ids can be forged, and it does not release on importer death. Parts are reusable. |
| **mertdogar** `fork/v0.6.2` | v0.6.2 | General Wrangler compatibility: platform keys, `alias`, `process.env`, `node:process`, an offline `celld restore` reader | Several clean cherry-picks for Phase 1 |
| **mohamedalichelbi** `main` and `fix/*` | v0.3.0 | The original DO-owned RPC routing (PR #3, which others built on); WebSocket upgrades across bindings; nested root transactions | One bug fix to port (nested transactions). Everything else is superseded. |

Nobody has run router + gatekeepers + fleet end to end. patcon and royalcala
ran only the workshop Worker. Nobody checks `allow_irrevocable_stub_storage`.

## Security warning: forgeable capabilities in every fork

Every fork's cross-isolate RPC lets code mint a capability it was never given:

- **patcon / royalcala `spike/rpc-062` (`64f8785`, `fd49be1`):**
  - Any plain object carrying `__celld$stub` with a cell scope or heap id and
    a small sequential entry id revives as a live stub.
  - Nothing refuses user data that carries `__celld$*` keys.
  - Separately, after eviction the id can resolve to a different entry.
- **royalcala `celld-os/rpc` (`c6123d0`):**
  - Capability calls are multiplexed over the RPC **method name**
    `__celldStubOp:<handle>:<path>`, which `__dispatchRpc` handles before any
    visibility check.
  - Any code holding a stub to any DO of the script can call or dispose every
    capability in that isolate, bypassing the HMAC. The reviewer reproduced
    this locally.
  - The tokens also carry `generation=0` and `node=""`, so stale tokens alias
    after re-activation.
- **IlyaGulya (`8d6b0a0`, `141db35`):**
  - Bridge ids are sequential, there is no reserved-key refusal, and the
    script field in `__celld$svc{s}` comes straight from the payload or
    storage.
  - Bridged calls into a DO skip the cell's input and output gates.
- **cnicolov (`fcb1977`):** a `Math.random` isolate id plus sequential entry
  ids, both visible in every marker.

Cloudflare OS runs model-written code in Dynamic Workers (code mode) that
receives env stubs, so this is exploitable in practice. The plan's Phase 3
design exists to close it: random 128-bit CapIds, destination-bound
redemption, refusal of reserved `__celld$` keys at lift time, and a dedicated
`CellJob::CapCall`.

**No fork's capability routing may be merged, in any form**, and no build
containing it is used, even locally for tooling.

## Learnings the plan did not have

These are now items in [cloudflare-os-fixes.md](cloudflare-os-fixes.md). The
IDs (N1-N12) are referenced there.

| ID | Learning | Source | Plan item |
| --- | --- | --- | --- |
| N1 | **`rpc_params_dup_stubs`.** Since compat date 2026-01-20, workerd **duplicates** stubs passed as call params instead of transferring them (`compatibility-date.capnp` `rpcParamsDupStubs @152`; disabled by `rpc_params_transfer_stubs`). For an RpcTarget, function, or Proxy with a `dup()` method, workerd calls `dup()` and takes ownership of the result, which must be the same kind (`worker-rpc.c++` ~3010-3155). Cap'n Web depends on this: without it, a stub forwarded as a param dies when the forwarding call returns ("This RpcImportHook was already disposed"). celld transfers (`harness.js:4231`). | patcon TODO, `1f7076f` / royalcala `b02d30e` | 1.13 (in-isolate), 3.2 |
| N2 | **Method lookup on get-only Proxies.** `__stubResolve` (`harness.js:4018`) and `__entrypointResolve` (`4541`) use `prop in target`. A Proxy without a `has` trap answers from its bare target, so forwarded methods fail with "does not implement". workerd uses `[[Get]]`. This is a same-isolate bug. | patcon `fc75e9c`, `27e98e0` / royalcala `ffd1011`, `da57cca` | 1.11 |
| N3 | **Facet and Dynamic Worker calls refuse capability args.** `__rpcOut(args, false)` at `harness.js:2200` (facets) and `3302` (loader), and pipelined paths are refused at `2197`, `3298`. Facet stubs must also lift as capabilities wherever they are passed. | patcon `fdc49fb` / royalcala `280897e` | 3.1 (rows E, F) |
| N4 | **`restore` symbol and `ctx.restore` shape.** workerd exports a native symbol (`src/cloudflare/workers.ts:21`), and `ctx.restore` is **synchronous**. Every fork made it async. Cloudflare OS always `await`s it, which tolerates both. | patcon, IlyaGulya, royalcala | 1.1, 5.1 |
| N5 | **Pinned dispatch to a retiring isolate.** Calls into a *retiring* session isolate must still be accepted, or every browser subscriber drops about 30 s after the pool retires the isolate. Check `is_live()` **after** `affiliate()`, or the call can enter a freed isolate and panic. v0.6.2 already has `runtime::drive(slot, …)` (`runtime.rs:2161`) and `Slot::affiliate` (`pool.rs:307`), so 3.0 is smaller than estimated. | patcon `d8d7c6f`, `90a37b3` / royalcala `713f1a5` | 3.0 |
| N6 | **DO stub methods must return an RpcPromise**, not a plain Promise. `GatekeeperLoopback` returns a get-only Proxy over an un-awaited `startGatekeeperSession()` (`harness.js:5275`). | patcon `333a2c7` / royalcala `38082b4` | 1.12 |
| N7 | **A missing `WORKERS_AI` crashes the agent's `webFetch`** of HTML (`toMarkdown`) on the chat path, not only web search. patcon patched the app (`web-fetch.ts`, `ead1d36`); we must not rely on that. | patcon | 9.2, brought forward to Phase 4 |
| N8 | **Nested transactions on the root storage object.** A real bug in v0.3.0 that **upstream already fixed in v0.6.0**: root `transactionSync`/`transaction()` route into the open view (`harness.js:1759-1780`, `1897-1911`; denoland/celld#226). Cloudflare OS has about 55 `storage.transaction*` call sites, so pin it with a conformance case. | mohamedalichelbi `7221aa7` (superseded) | 1.14 (test only) |
| N9 | **`nodejs_compat_populate_process_env`** (default from 2025-04-01) is accepted without effect. Under `nodejs_compat`, `process.env` should hold the string vars. Also, `node:process` is not mapped to the global `process`. | mertdogar `6d8e461`, `cde80c7` | 1.15 |
| N10 | **DO class names colliding across co-hosted scripts.** v0.6.2 refuses this at generation start (`generation.rs:587-596`). About 14 OAuth gatekeepers export `UserAccount`, and mcp/mcp-portal both export `McpAccount`, so Cloudflare OS hits this as soon as **two OAuth gatekeepers** are installed. IlyaGulya keyed only non-primary scripts' classes as `.svc.<hash>`, which changes cell names when the primary changes (for example, `--no-router`). That loses data. | IlyaGulya `30f2a48` | 2.4 (new) |
| N11 | **Remote route generation retry.** `RemoteRouteRetry::failed` should set `blocked` for `NeverConnected` + redispatch (`main.rs:489-494`). This is an independent fleet fix. | IlyaGulya `6e6af49` | Phase 8 (any time) |
| N12 | **Session isolates do retire mid-session.** patcon confirmed the plan's "WebSocket-session contexts" risk: subscribers drop about 30 s in unless retiring isolates keep serving (N5). | patcon | 3.0 risk, smoke S12 |

Confirmations (the plan already had these, and a fork independently hit them):

- the tracing crash on every agent turn
- the `Blob.stream()` BYOB failure
- RPC-only tails timing out code mode
- `ctx.exports` namespaces for migrated classes (patcon worked around it as we
  did)
- the forwarded Cap'n Web `onRpcBroken`: patcon's native no-op `onRpcBroken`
  shadowed it, so browser disconnects were never seen. That confirms D3.

## Commit disposition

"Adopt" means the commit is a sound starting point: cherry-pick it, then
bring it up to the adoption policy before it lands. "Rework" means cherry-pick as a starting point and change it as noted.
"Reference" means don't cherry-pick.

### Phase 0: test infrastructure

| Commit / asset | Action | Notes |
| --- | --- | --- |
| IlyaGulya `examples/cloudflare-os-compat/` (`test.sh`, 43 cases, fixtures `ws-router`, `ws-service`, `same-class`) | **Mine as the seed list** for `tests/conformance/` | Convert each case to a `/run` transcript with `expect.json` recorded from workerd; substring checks hide differences. Restart cases need a `{"restart": true}` runner step. Expected divergences to pin: async `[restore]`, KV read straight after a tail, a Proxy-returning entrypoint constructor. |
| IlyaGulya `d6e0988` (`celld dev --service`) | Reference for 0.1 | Our `-c a -c b` has the same semantics (services first, primary last). |
| IlyaGulya `fleet-test.sh`, `ha-test.sh`, `soak-test.sh` + `soak-driver.py`, `s3-fault-proxy.py` (`fe8938d`…`b40b607`) | **Import** under `tests/fleet/` | Adapt for Azurite, and add a `/call` capability load (the soak never exercises capabilities). The bars need a `/state` capability counter. |
| IlyaGulya CI commits (`bdf5eac`…`5191eca`) | Reference for 0.6 | A moto S3 stand, port offsets |
| cnicolov `crates/celld/tests/rpc_capabilities.rs`, `examples/rpc-capabilities/` (in `fcb1977`) | Seed the Phase 3 `rpc/` matrix | A full-binary test pattern |
| patcon `scripts/celld/run-local.ts`, `make-config.ts` | Reference for 0.4 | A single-command workshop-only loop on `celld dev` (no podman), and the asset-copy step. Gives `e2e.sh up --dev-store --workshop-only`. |
| patcon's verified-journey list | Add to smoke and the checklist | Two-tab live sync including after isolate retirement, `env.GADGET.getDocument()` from code mode, streaming reply growth, creating a workspace from Home with the first message |
| mohamedalichelbi recipe (`portability/celld-mvp`) | Reference for 0.4 | A cheap S0 smoke (router → binding → backend JSON; router `/` assets) and a `celld deploy --dry-run` check step |
| royalcala's "workspace/invite E2E" | Not available | Mentioned in commit messages but not published anywhere. Ask the author. |

### Phase 1: loud gaps and small fixes

| Commit | Action | Plan item | Notes |
| --- | --- | --- | --- |
| IlyaGulya `30f2a48` hunk `deploy.rs:1299` | **Adopt** that hunk only | 1.3 | Seeds `do_classes` from `new_sqlite_classes` |
| IlyaGulya `2172ce1` | **Rework** | 1.4 | Applies cleanly. Add object/size validation, default-entrypoint and fetch props, and unknown-key and DO `script_name` refusals. |
| IlyaGulya `8376ebc` | Reference | 1.7 | `WorkerWebSocket::repark` is our `park_worker_handoff`. It keeps the id on the Response, not the socket (lost on rebuild), and has no adopt, sweep, loader or broker paths, or refusals. |
| mohamedalichelbi `47b889d` | Reference | 1.7 | Keep one idea: register the target's socket pump as `waitUntil` of the target event. |
| IlyaGulya `d6e0988` | **Rework** pieces | 1.6 | JSON vars (add the 5 KiB cap; no feature flag, as deployments are fresh), `build` (add `--no-build`), `observability`. Drop its `rules` part (superseded). |
| mertdogar `da1ef43` | **Rework** | 1.6 | `IGNORED_PLATFORM_KEYS` with a note. Adjust: keep refusing `routes`/`route`; `workers_dev`/`preview_urls` `false` silent, `true` warned. Its extras (`upload_source_maps`, `placement`, `dev`, `compatibility_domains`, `keep_vars`, `minify`) are fine to accept. |
| royalcala `22b3352` / cnicolov `tracing.js` | Rework (seed) | 1.2 | Both lack `ctx.tracing` on DO state, active-span tracking through ALS, and ending a span when `enterSpan`'s promise settles. |
| royalcala `ef5e87c` (byte-stream half) | Reference | 1.8 | Native `type:"bytes"` for `CelldHttpBodyStream`/`Blob` is the chosen design, but the commit depends on `crates/celld/capability.rs` from the forbidden routing. **It can't be cherry-picked; write the change fresh.** |
| royalcala `60209d3` | Skip | 1.8 | Subsumed by the line above |
| royalcala `ffd1011` or `da57cca` (from patcon) | **Adopt one** after a workerd differential test | 1.11 (N2) | Pick the resolution rule the differential test supports |
| royalcala `38082b4` (from patcon) | **Adopt** | 1.12 (N6) | |
| mohamedalichelbi `7221aa7` | Skip | 1.14 (N8) | Superseded by upstream's v0.6.0 fix. 1.14 only adds a pinning test. |
| mertdogar `6d8e461` | **Rework** | 1.15 (N9) | Build the literal with JSON, not Rust `{:?}`. Decide how JSON vars appear in `process.env` with a differential test. |
| mertdogar `cde80c7` | **Adopt** | 1.15 | Drop the FORK.md hunk. |
| mertdogar `79fa97e` (`alias`), `df3c705` (`celld restore` offline reader) | Optional | after Phase 1 | `celld restore` is handy for inspecting trial DOs. |
| mertdogar `fd4f14d`, `74924d6`, FORK.md commits | Skip | | `fd4f14d` adds a SQL gate on the public listener (attack surface). |

### Phase 2: tokens and storage

| Commit | Action | Notes |
| --- | --- | --- |
| royalcala `d534083` | **Rework** | Use the HMAC codec and its 9 inline tests for D7 storage tokens. Delete the unused `CapabilityRegistry`. Drop or populate `generation`/`node`. |
| royalcala `2bd84cd`: `init_capability_key` (`js.rs:9069`, `main.rs:4142`) | **Adopt that part** | Key = HMAC(peer_secret, "celld-capability-key-v1"): fleet-wide, survives restarts. This is the D7 key source. |
| IlyaGulya `141db35` | Reference | `svc{script}` by value. Its script field is trusted from the payload, which our HMAC'd token fixes. Port its proxy tests. |
| IlyaGulya `30f2a48` | Reference | Callable `ctx.exports` namespaces (2.3) and DurableObjectClass lift/revive/store (2.1 `cls`). Drop `__loader_self` (superseded by `FacetHost::Own`). |
| cnicolov `fcb1977` | Do **not** take its loopback hunk | It turns `ctx.exports` stubs into transient routes, which can never be stored. That is the opposite of Phase 2. |

### Phase 3: cross-isolate RPC

| Commit | Action | Notes |
| --- | --- | --- |
| royalcala `674a9c4` | Reference (lift pieces) | Lift `WorkerJob::StubRpc`/`begin_stub_rpc` and the reserved `__celld$` key refusal (`harness.js:4436`) into 3.0. Its refcounts (no importer key), regex-based breakage and retiring refusal must not be kept. |
| royalcala `713f1a5` (patcon `90a37b3` + `d8d7c6f`) | Reference | 3.0 (N5): affiliate, then `is_live()`; retiring isolates allowed. It patches `op_stub_rpc_call_heap`, which exists only in the forbidden routing, and adds `Slot::is_live`. Implement both ideas ourselves. |
| royalcala `64f8785`, `fd49be1`, `c6123d0`; patcon `8a1acd2`, `c6df64b`; IlyaGulya `8d6b0a0`; mohamedalichelbi `2498103` | Reference only | Plumbing shape. The dedicated `CellJob::StubRpc` (`64f8785`) is the right pattern; method-name multiplexing (`c6123d0`) is not. |
| cnicolov `fcb1977` | Reference (reuse code) | Transactional lift (rolls back transfers, routes and locks on failure), revive-once for aliased markers, disposer snapshot, `CallOrder` + egress gate wiring, `runtime::drive(slot, …)` with `Slot::affiliate()` |
| royalcala `b02d30e` (patcon `1f7076f`) | Reference | N1: apply workerd's `dup()` rule properly (params only, validate the result, workerd's errors) |
| royalcala `280897e` (patcon `fdc49fb`) | **Adopt** once capabilities are sound | 3.1 rows E/F (N3) |
| royalcala `874a2f2` (patcon `a34d8b5`) | Adopt local `dup()` only | Reject the native `onRpcBroken` (D3) |
| IlyaGulya `4594b6c` | **Adopt** (applies cleanly) | 1.12: RpcPromise `Symbol.dispose`, refused after dispose |
| IlyaGulya `779b7c9` | Reference | Importer request-context adoption with implicit release, and a `/state` live-capability counter. Adopt both. |
| royalcala `2bd84cd`: `__facetStubs`, Proxy-RpcTarget wildcard resolution | Reference | 3.1 callable proxies, after differential tests |

### Phases 4-8

| Commit | Action | Plan item | Notes |
| --- | --- | --- | --- |
| IlyaGulya `30f2a48` `service_class_config` (`generation.rs:360`), `op_service_class_loader` (`js.rs:9776`) | Reference | 4 | Proof that a cross-script DurableObjectClass works as a facet class (`returned`/`relayed service DO class` cases). It runs a standalone loader per (script, class) per receiving isolate, cached forever. Our D8 resolves to `FacetHost::Script` on the script's cell pool instead. |
| royalcala `2bd84cd` restore part | **Skip** | 5 | Restored stubs are not storable (no `__storedLift` case), `_cf_RESTORE` rows leak, handles alias after `deleteAll`, and there is no self-token for facets or Dynamic Workers. Our `rst` tokens follow workerd. Reuse only its `__ctxInstance` plumbing and synchronous stateless `[restore]`. |
| IlyaGulya `c79ef09` | Reference | 5 | Restore recipes replay in the current isolate only. The nested-recipe envelope for loaded workers (`__celld$loaderCall`) is a useful idea for 5.1. |
| royalcala `c6a3e55`, `ef0d54d` (patcon `13eb098`, `d72a49c`) | Skip | 5 | Async, live-only. `c6a3e55` references `__tracing` before it exists. |
| royalcala `2f10749` (patcon `d35faa8`) | **Adopt** | 6 | Base for RPC tails. Then add facet fetch/RPC/alarm events and the `streamingTails` refusal. |
| IlyaGulya `f62bf29` | Reference | 6 | Delivers tails before the call answers, unlike workerd. |
| royalcala `ef5e87c` stream-capability path | Reference | 7.1 | A per-chunk baseline; our single-claim `register_body_stream` is the target. |
| IlyaGulya `b22c115`, `2a4a1d6` | Reference | 8 | Adopt: the identity triple (node, process generation from the **signed lease**, id), resolving origins through the lease, `GONE` semantics. Don't adopt: HTTP-per-op transport, sequential ids, the `PROTOCOL_VERSION` bump. |
| IlyaGulya `6e6af49` | **Adopt** (applies cleanly) | 8 / N11 | Independent fleet fix; also worth sending upstream |
| IlyaGulya `876a472`, `914bb60` (upgrade drill) | Skip | — | Out of scope: fresh deployments only, no mixed-version fleets. |
| patcon `ead1d36` (app `web-fetch.ts` without AI) | **Do not copy** | 9.2 | An app-side shortcut that hides N7. The AI shim must provide `toMarkdown`. |

### Not needed

- patcon's CI, Intel macOS, `celld dev --host` and version-bump commits
- the royalcala lockfile chores
- IlyaGulya `f1155ce` (rustfmt)
- mohamedalichelbi `fbebac2`/`a28f695` (already upstream), `47b889d` (superseded
  by `WorkerWebSocket`) and `247fcc0`
