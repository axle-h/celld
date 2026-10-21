# Cloudflare OS on celld: trial run

First attempt to run Cloudflare OS on celld, recorded for planning. See
[cloudflare-os.md](cloudflare-os.md) for the gap analysis.

- Date: 2026-10-21
- celld: v0.6.2 (`126a67e`), release build
- Cloudflare OS: starter fork, upstream submodule `a6794421`
- Fleet: one node, Azurite blob emulator as the bucket (`az://celld`)
- Sign-in: built-in password accounts (no Cloudflare Access)
- Model: a local mock OpenAI-compatible server, added as an Ollama provider

The tooling lives in the starter under `celld/`: `generate.ts` writes a
celld config per Worker (`celld.<worker>.jsonc` at the project root),
`deploy.sh` builds nothing and deploys all seven Workers, `env.sh` holds the
bucket settings. Build the Workers first as `cf-os deploy` does (see the
starter's `celld/README.md`).

## How far it got

| Step | Result |
| --- | --- |
| `celld deploy` of all 7 Workers | Works after config workarounds 1-4 |
| Node start, multi-script co-hosting via service bindings | Works |
| Frontend through the router (static assets, SPA fallback) | Works |
| `/api` WebSocket through the router | **Fails** (failure 5); worked around by serving from the workshop |
| Sign-up, sign-in, user DO, admin settings DO, bundled blueprint install (KV, R2) | Works |
| Onboarding: listing gatekeepers over vendor RPC to every gatekeeper Worker | Works |
| Profile page, AI providers page, adding a model | Works |
| Turning on built-in gatekeepers (context, scheduler, websearch, custom) | **Fails** (failure 7) |
| Live notifications and connected-account subscriptions | **Fail** (failures 6, 8) |
| Starting a conversation / creating a workspace | **Fails** (failure 6) |
| Creating a gadget from a blueprint | **Fails** (failure 9) |
| Agents, facets, Dynamic Workers, scheduler alarms | Not reached |

The app is usable up to the home page. Everything that opens a workspace
(Overseer DO) fails, so none of the facet, Dynamic Worker, or `ctx.restore`
paths were exercised.

## Failures

### Deploy configuration

1. **Unsupported Wrangler keys stop the deploy**: `observability` (all),
   `build` (all built Workers), `ai` (workshop, websearch), `browser`
   (workshop), `workers_dev` and `preview_urls` (error-reporter).
   Workaround: the generator drops them. Expected; see the plan.
2. **`rules[].fallthrough` stops the deploy**: "module rule sets
   `fallthrough`, which celld does not have" (scheduler, websearch). Wrangler
   accepts it. Workaround: dropped.
3. **Non-string `vars` stop the deploy**: "var binding ADMINS must be a
   string". Wrangler supports JSON vars. Workaround: `ADMINS` as a JSON string,
   which upstream also parses.
4. **DO classes only in migrations are not namespaces in `ctx.exports`**:
   `ctx.exports.AdminSettings.getByName is not a function`. Cloudflare OS
   declares no `durable_objects` bindings and reaches every namespace through
   `ctx.exports`; workerd makes every migrated class a namespace. celld builds
   `do_classes` from bindings only (`crates/celld/deploy.rs`,
   `js/bootstrap.rs` `populate_cf_exports`). Workaround: the generator adds a
   `durable_objects` binding per migrated class.

### Runtime

5. **WebSocket response through a service binding is broken.** A Worker that
   returns `env.SVC.fetch(req)` where the target answers `101` with a
   `WebSocketPair` sends the client a `101` without `Upgrade`, `Connection`, or
   `Sec-WebSocket-Accept`; the client closes with 1006 and the node logs
   `dropped a frame for a closed WebSocket`. The same `WebSocketPair` returned
   directly works. Minimal repro: two scripts, `wsfront` forwarding to
   `wsback` (scratch repro, reproduced with and without rebuilding the
   `Request`). Blocks the router, which proxies `/api` to the workshop.
   Workaround: `generate.ts --no-router` makes the workshop the primary Worker
   and serves the frontend from it, which loses the `/gatekeeper/*` routes.
6. **RPC capabilities cannot cross between a Worker and its own Durable
   Objects.** celld runs the stateless handler and each DO in different
   isolates even within one script, so gap 1 of the plan applies to
   *same-script* DO calls too, not only cross-script ones. Probe results
   (one script, stateless handler calling its DO):
   - RpcTarget passed to a DO, method call: "RPC stubs cannot cross isolate
     boundaries yet."
   - Function-with-properties (Cap'n Web stub shape) passed to a DO: same.
   - RpcTarget returned from a DO, method call: same.
   - `stub.dup()` works; `onRpcBroken` is undefined.

   In Cloudflare OS: the workshop passes Cap'n Web client stubs (notification
   and account subscribers) into the user DO, and `overseer.open()` returns an
   RpcTarget session. Errors seen: `subscriber.onRpcBroken is not a function`,
   `subscriber.ready is not a function`, `'newChat' is not a function`.
7. **Storing a stub received over RPC fails**: "function () {} could not be
   cloned." `UserDurableObject.provisionAmbientAccount` stores the account
   stub that the gatekeeper's `createAccount()` returns
   (`ctx.exports.XAccount({props})` from another Worker). Also reproduced
   in one script: a `ctx.exports` loopback stub or an RpcTarget passed into a
   DO and then `storage.kv.put`. This is plan gap 3, compounded by failure 6.
8. **`stub.onRpcBroken()` is missing.** Used by `user.ts:492` and
   `overseer.ts:870` to drop subscribers when the client goes away.
9. **BYOB readers are refused on non-byte streams**: "Invalid reader mode
   'byob'". `git-codec.ts:663` calls `getReader({ mode: "byob" })` on a pack
   stream; in workerd the platform streams (R2 bodies, `DecompressionStream`
   output, `Response` bodies) are byte streams. celld's generic
   `ReadableStream.getReader` rejects any `mode` (`js/streams.js`). Blocks
   creating a gadget from a blueprint.

### Not failures, but noted

- `Flagship binding missing; using default values` (hosted-only, expected).
- The frontend logs `useAuthenticatedApi must be used within an AuthProvider`
  once on load; this looks like upstream, not celld.
- MinIO images are no longer pullable anonymously from Docker Hub or quay.io,
  so the trial used Azurite. Creating the container needed a hand-signed
  SharedKey request; celld does not create it.

## Changes to the plan

- Gap 1 (cross-isolate RPC) is wider than thought: it blocks a Worker
  talking to its **own** Durable Objects with any capability, so it is the
  first thing to fix and it gates nearly every user-visible feature.
- New items, all smaller:
  - WebSocket responses through service bindings (failure 5) — a bug.
  - `ctx.exports` namespaces for migrated classes without bindings (failure 4).
  - JSON `vars` and `rules[].fallthrough` (failures 2, 3).
  - `stub.onRpcBroken()` (failure 8).
  - BYOB readers on platform streams (failure 9).

## Reproducing

```sh
cd ~/projects/cloudflare-os-starter
podman run -d --name celld-azurite -p 10000:10000 \
  mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --loose
# create the `celld` container (SharedKey PUT ?restype=container), then:
celld/build.sh
celld/deploy.sh --no-router
(. celld/env.sh && mkdir -p .celld && cd .celld && \
  "$CELLD" --bucket "$CELLD_BUCKET" --listen 127.0.0.1:8790 > node.log 2>&1 &)
```
