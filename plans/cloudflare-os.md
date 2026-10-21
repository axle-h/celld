# Running Cloudflare OS on celld

Goal: run [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) on a
celld fleet instead of workerd/Cloudflare, deployed from the fork of
`cloudflare-os-starter` (`~/projects/cloudflare-os-starter`, upstream pinned
as the `cloudflare-os` submodule).

Status: assessment done from source reading against celld v0.6.2. A trial
deployment follows; its failures are recorded in
[cloudflare-os-trial.md](cloudflare-os-trial.md).

## What Cloudflare OS deploys

Six Workers in the starter's default configuration, plus optional
Gatekeepers. Final configs come from `packages/cf-os/src/core/deployment.ts`
(`generateConfigs()`), which extends each upstream `wrangler.jsonc`.

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

## What already works on celld

- Several Workers linked by service bindings, co-hosted on one node
  (`crates/celld/generation.rs`), with named entrypoints.
- SQLite DOs through `ctx.exports`; sync KV, `transactionSync`, alarms,
  `deleteAll`, `sync()`, `blockConcurrencyWhile`, `abort()`.
- Facets; Worker Loader `get`/`load` with `globalOutbound: null` and `tails`.
- KV, R2, static assets with SPA fallback and `run_worker_first`.
- `FixedLengthStream`, `DigestStream`, `timingSafeEqual`, ECDH, HKDF,
  AES-GCM, `AsyncLocalStorage`, `URLPattern`.
- Storing DO stubs and same-script `ctx.exports` loopback stubs in DO storage.

## Gaps

### Runtime blockers (break the core app)

1. **RPC capabilities cannot cross isolates.** Each co-hosted script has its
   own isolate, and `harness.js` rejects a stub, RpcTarget, or stream that
   crosses one ("RPC stubs cannot cross isolate boundaries yet",
   "RPC streams cannot cross isolate boundaries yet"). Cloudflare OS passes
   them between Workers everywhere: gatekeepers return
   `ctx.exports.X({props})` Fetchers and DurableObjectClasses to the
   workshop, the workshop hands `LoginConnectCallbackImpl` stubs to
   gatekeepers, `GitPullTransfer` returns a `ReadableStream`, and
   `gatekeeper-kit/src/observers.ts` relies on promise pipelining.
2. **A cross-script DurableObjectClass as a facet class.** The context,
   scheduler, websearch, and custom gatekeeper DOs run as facets inside the
   workshop's `OverseerDurableObject`, from a class received over RPC from
   their own Worker. celld accepts facet classes only from a Worker Loader or
   the same script's `ctx.exports`.
3. **Durable storage of cross-script capabilities**
   (`allow_irrevocable_stub_storage`). Cloudflare OS stores cross-Worker
   Fetchers, DurableObjectClasses (with props), and RPC stubs in DO storage
   (`workshop-backend/src/storage-schema/overseer-storage.ts`,
   `user-storage.ts`, `gatekeeper-scheduler/src/schedule-driver.ts`,
   `gatekeeper-kit/src/observer-tracker.ts`). celld refuses everything except
   DO stubs and same-script loopback stubs (`harness.js` `__storedLift`).
4. **`ctx.restore()` / `[restore]`** from `cloudflare:workers` are absent.
   The overseer mints persistent stubs for gadgets and facets with them
   (`overseer.ts` around 4537, 10052-10132), including loading a Dynamic
   Worker through `ctx.restore`.
5. **Service-binding `props` are silently dropped.** `deploy.rs` reads only
   `binding`, `service`, and `entrypoint`. The error reporter and
   `GATEKEEPER_CONTEXT` (`sharingDomain`) get `undefined`. This is also a
   defect under celld's own loud-gap rule.

### Smaller runtime gaps

- `tracing` export of `cloudflare:workers` (`tracing.enterSpan`,
  `startActiveSpan` in `cos/observability`).
- `tailStream()` handlers; Dynamic Worker tails send one event per fetch.
- `RpcStub.dup()` on every stub kind (23 call sites).
- `global_fetch_strictly_public` (SSRF guard for web fetch) and `nodejs_als`
  are accepted without effect.
- `Uint8Array.prototype.toHex` / `toBase64` (check whether V8 already ships
  them).

### Deploy configuration

`celld deploy` refuses `ai`, `browser`, `observability`, `build`, `routes`,
`account_id`, `workers_dev`, `preview_urls`, and `secrets`. The starter
needs a celld config generator (or a `cf-os` target) that emits only
supported keys and runs the build step first.

### Cloudflare-network services (out of celld's scope)

- **Workers AI / AI Gateway**: the default model catalog and web search.
  `ai-models.ts` has HTTPS fallbacks, so models could go direct to a provider
  with a patch or a shim binding.
- **Browser Rendering**: optional, the code null-checks `BROWSER`.
- **Cloudflare Access**: switch to the built-in password sign-in method.
- **Artifacts**: opt-in, leave off.

## What it would take, in order of effort

1. Cross-isolate JS RPC carrying stubs, RpcTargets, streams, and promise
   pipelining. The largest item, and the foundation for 2 and 3.
2. Cross-script DurableObjectClass as a facet class, and durable storage of
   cross-script stubs.
3. `ctx.restore` / `[restore]`.
4. Service-binding `props` (small; fixes a silent drop).
5. `tracing` module, `tailStream`, `global_fetch_strictly_public`.
6. A celld config generator for the starter, and non-Access sign-in.
