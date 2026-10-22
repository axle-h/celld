# Security

celld v0.6.2 is a beta release. It is not safe for hostile multi-tenant use.
Only the latest release receives security fixes.

## Security boundary

One fleet runs one application. celld trusts the application code, the fleet
nodes, and the operators. Application code can use its configured bindings and
can consume shared node resources. Do not run code from mutually distrusting
tenants in one fleet.

Application code cannot reach the engine's host functions. An internal script
receives them as function parameters, and `globalThis` carries no
`__`-prefixed property. A Worker Loader worker with `globalOutbound: null`
therefore reaches the host only through the capabilities in its `env`.

celld depends on two external boundaries: a trusted private network protects
the internal listener, and object storage credentials control the fleet.

## Separate the listeners

celld opens two HTTP listeners and terminates TLS on neither.

| Listener | Serves | Required protection |
| --- | --- | --- |
| `--listen` (public) | The deployed Worker | Terminate TLS and authenticate users in a proxy or the application. |
| `--internal-listen` (default `127.0.0.1:0`, a free loopback port) | The peer protocol and the operator API | Restrict access to trusted operators and fleet nodes. Never expose it to the public internet. Use an encrypted overlay such as WireGuard or Tailscale when the network does not provide confidentiality. |

`--advertise` gives peers the internal address. celld rejects an explicit
`--advertise` or a non-loopback `--listen` without an explicit
`--internal-listen`. celld cannot verify a hostname or a translated port, so
you must route the advertised address to the internal listener.

The public listener reserves only `/.well-known/celld/health`: 200 with
`{"ok":true}` when healthy, 503 otherwise. The Worker owns every other public
path, including `/health`. The internal listener returns 404 for an unknown
path, so an operator request cannot become an application request. A Worker
cannot reach the internal listener either: the
[egress policy](#the-nodes-internal-listener-is-always-refused) refuses it.

The internal listener has three request groups, and all three require the
trusted private network:

- Most operator routes have no request authentication.
- `/peer/tunnel` opens a tunnel for cell fetch, RPC, and WebSocket calls. The
  establishment request carries the fleet HMAC, a clock limit, and replay
  protection. The calls inside the tunnel are plain, unsigned HTTP.
- The peer-control and reserved-cell routes sign each request with the fleet
  HMAC, a clock limit, and replay protection.

Every path to a runtime class therefore demands the fleet secret. The HMAC
does not authenticate tunnel bytes after establishment and does not encrypt
traffic, so it does not replace the private network.

## Limit Worker egress

On Cloudflare, a Worker's global `fetch()` leaves from the edge onto the
public internet, so it cannot reach a private address. A celld node runs inside
your network, so it enforces the same limit itself. A Worker's global `fetch()`
and `new WebSocket()`, and a `fetch()` with `Upgrade: websocket`, reach only
public addresses. The policy is always on and applies to every Worker on the
node, Dynamic Workers included.

celld refuses these destinations:

- IPv4: the unspecified range `0.0.0.0/8`, loopback `127.0.0.0/8`, the private
  ranges `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`, the shared range
  `100.64.0.0/10` (CGNAT), link-local `169.254.0.0/16` (which holds the cloud
  metadata address `169.254.169.254`), multicast `224.0.0.0/4`, the reserved
  range `240.0.0.0/4` (which holds the broadcast address), and IANA's protocol,
  documentation, 6to4-relay and benchmarking ranges (`192.0.0.0/24`,
  `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24`,
  `203.0.113.0/24`).
- IPv6: `::` and `::1`, the IPv4-compatible range `::/96`, unique local
  `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10`, multicast
  `ff00::/8`, and the IPv4-translated, local-use NAT64, discard, IETF protocol
  (Teredo included), documentation and segment-routing ranges.
- An IPv6 address that embeds an IPv4 address is judged by the IPv4 address:
  IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4
  (`2002::/16`).
- celld recognizes only the well-known NAT64 prefix `64:ff9b::/96` and the
  local-use prefix `64:ff9b:1::/48`, which it refuses whole. A network-specific
  NAT64 prefix that your network routes to private IPv4 addresses looks like a
  public IPv6 address to celld. If your node uses one, block it in the node's
  firewall.

celld checks the address it connects to. It checks an IP literal before the
request and at every redirect hop, in any spelling the URL parser accepts, such
as `http://2130706433/`. It checks a name inside its resolver, and connects
only to the resolved addresses that pass, so a name that resolves differently
on a second lookup (DNS rebinding) cannot pass the check with one address and
connect to another. A name that resolves to no allowed address is refused.
Worker egress ignores `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`,
because a proxy would connect to an address that the check never saw.

A refused `fetch()` rejects with a `TypeError` before anything leaves the
node. The message names the URL's host and port:

```text
celld egress policy: 10.0.0.5:8080 is not a public address, so this node refuses to connect to it. A node operator can allow it by adding 10.0.0.5:8080 to CELLD_FETCH_PRIVATE_ALLOW.
```

`new WebSocket()` reports the same `TypeError` as the `error` of its `error`
event, followed by a `close` event with code 1006.

### Allow an internal service

`CELLD_FETCH_PRIVATE_ALLOW` lets Workers reach specific non-public services,
such as a model server on the node in development or a service on your
private network. It is a comma-separated list of `host:port` entries:

```sh
CELLD_FETCH_PRIVATE_ALLOW=127.0.0.1:11434,[fd00::5]:8080,models.internal:443
```

- An IP entry allows that address on that port, however the URL reached it.
  Write an IPv6 address in brackets.
- A name entry allows a URL whose host is that name, on that port, and every
  address the name resolves to. You trust your DNS for that name.
- Every entry needs a port. celld has no wildcard and no range.
- celld exits at startup on an invalid entry, or an entry for a public address,
  which the policy already allows.

The list is node-wide: every Worker on the node, Dynamic Workers included, can
reach every entry.

### The node's internal listener is always refused

No Worker reaches the node's internal listener or its advertise address, even
when `CELLD_FETCH_PRIVATE_ALLOW` names them, because the operator routes behind
them have no authentication. This holds for `fetch()`, `new WebSocket()` and
`connect()` alike. The refusal reads:

```text
celld egress policy: 127.0.0.1:7000 is this node's internal listener, which no Worker can reach, even when CELLD_FETCH_PRIVATE_ALLOW names it.
```

- celld refuses the bound `--internal-listen` address on its port. For an
  unspecified address, such as `0.0.0.0:7000`, it refuses that port on every
  address of the host's interfaces, loopback included. It reads the
  interfaces at each connection, and refuses the connection if it cannot
  read them.
- celld refuses an `--advertise` address on its port. An advertised name is
  refused as the URL spells it, because celld does not resolve it.
- celld logs a warning at startup for an allowlist entry that names one of
  these addresses.
- A NAT or a proxy that forwards another address to the internal listener is
  outside what celld can see. Keep the internal listener off any address that
  a Worker can reach through the allowlist.

The public listener is not refused. It serves only the Workers and a health
check, which a Worker can already reach through `ctx.exports` or a service
binding, and a Worker on Cloudflare can fetch its own public hostname. On
loopback or a private address, it is refused like any other address unless
the allowlist names it.

### What the policy does not cover

- Service bindings, `ctx.exports`, Durable Object stubs and a Worker Loader's
  `globalOutbound` Fetcher are bindings, not network requests. A Fetcher's own
  `fetch()` is checked.
- A container's `getTcpPort()` reaches the address of that container's port,
  which the host looks up, as that IP address only. A redirect from the
  container is checked, and a name never reaches the container's address.
- `connect()` from `cloudflare:sockets` is restricted only by the
  [internal-listener rule](#the-nodes-internal-listener-is-always-refused). It
  is the API for databases and other services on your network, and it reaches
  every other address the node can. A Dynamic Worker inherits it from its loader unless the loader sets
  `globalOutbound` to `null` or a Fetcher, so give code that you do not trust a
  `globalOutbound` of `null` or a Fetcher.

## Use the internal operator API

The operator API is an alpha interface. A release can change its paths or
response formats. These routes do not authenticate the caller:

- `/state` reports node state.
- `/cell/<SCOPE>` resolves or activates a cell.
- `/evict/<SCOPE>` tries to evict a resident cell and reports the result.
- `/do/<ID>` sends a direct request to an ordinary Durable Object.
- `POST /shutdown` starts a graceful ownership handoff. `handoff=preserve`
  prepares a same-node reload.

`/do/<ID>` refuses every reserved runtime class, such as D1, Workflows, KV,
and Queues, because their protocols can access application data. Use the
HMAC-authenticated `/runtime/<SCOPE>` route for these classes.

`/peer/probe` returns a signed diagnostic response. Do not call the other
reserved peer paths directly.

### Read an eviction result

An accepted eviction waits for the operation to finish, and a refused one
returns at once. Concurrent callers can join one eviction, so the success
count does not equal the stop count.

The Rust method `AppHandle::evict` returns `Result<EvictSuccess, EvictError>`.
`Evicted` confirms a completed runtime stop, and `AlreadyAbsent` confirms
settled local absence. A caller that needs a completed eviction must check for
`Evicted`. Over HTTP, both return 200 with `{"ok":true}`. `kind()` and
`reason()` on the error match the HTTP error body. A later request can
reactivate the cell before the response arrives.

A missing cell or a settled `Inactive`, `Dormant`, or `Remote` cell is locally
absent. A pending activation, stop, or ownership transfer prevents that
result. The request does not evict a remote runtime. A dormant cell keeps its
ownership and its hibernated host sockets. The node refuses during
preservation, reload, or local inventory confirmation, or when it lacks
authority.

An error body has this form:

```json
{"ok":false,"error":{"kind":"refused","reason":"cell_active"}}
```

| Status | Kind | Reason | Cause |
| --- | --- | --- | --- |
| 409 | `refused` | `cell_active` | The cell has active work or a socket that requires a runtime. |
| 409 | `refused` | `cell_transitioning` | The cell has another lifecycle transition. |
| 409 | `refused` | `alarm_imminent` | The alarm residency policy retains the cell. |
| 409 | `refused` | `alarm_uncovered` | The alarm coverage is unconfirmed, or a firing alarm blocks eviction during pressure shedding. |
| 503 | `refused` | `node_unavailable` | The node cannot accept the eviction. |
| 503 | `refused` | `eviction_limit` | The node has reached its eviction concurrency limit. |
| 409 | `cancelled` | `new_activity` | A new request cancels an accepted eviction. |
| 409 | `cancelled` | `alarm_activity` | An alarm observation or firing cancels an accepted eviction. |
| 409 | `cancelled` | `node_fenced` | The node loses its authority during the eviction. |
| 503 | `failed` | `actor_unavailable` | The request cannot reach the Actor. |
| 500 | `failed` | `reply_lost` | A delivered request loses its reply, so its outcome is unknown. |
| 500 | `failed` | `durability_failed` | The durability verification fails. |
| 500 | `failed` | `durability_timeout` | The durability verification exceeds its operation deadline. |
| 500 | `failed` | `runtime_stop_failed` | The runtime stop reports a failure. |

A malformed scope returns 400. An error does not prove that the runtime is
still resident. The runtime stop has no overall timeout, so a stop that never
returns keeps the request pending.

## Set the forwarded-header policy

celld ignores `X-Forwarded-Host` and `X-Forwarded-Proto` by default. Set
`--trust-forwarded-headers` or `CELLD_TRUST_FORWARDED_HEADERS=1` only when a
trusted proxy replaces both headers. celld uses the last value in each header,
so an earlier client value cannot override the proxy value.

celld takes the path and query from the request target and ignores the scheme
and authority of an absolute-form target. Without a trusted proxy, the `Host`
header sets the hostname in `request.url`. celld accepts a hostname, an IPv4
address, or a bracketed IPv6 address, with an optional port. It rejects
malformed and noncanonical values and falls back to `celld.local`.

The hostname is still client-controlled. Do not use an unchecked hostname for
an authorization decision. Use a trusted proxy, or check the hostname against a
list in the Worker.

## Limit request bodies

The public listener and `/do/<ID>` limit a request body to 1 GiB by default.
Set `CELLD_MAX_REQUEST_BODY_BYTES` to a smaller positive value to lower it.
celld returns 413 for a declared oversized body and when a Worker reads past
the limit.

For a method other than `GET` or `HEAD`, `/do/<ID>` streams a body of unknown
length or of at least 1 MiB. It collects a smaller body before dispatch.

## Protect the fleet bucket

The fleet bucket is the root of authority. It stores the deployments, the cell
state, the ownership and node leases, and the shared peer-authentication
secret. A holder of the bucket credentials controls the fleet. Give each
credential access to one fleet bucket only, and rotate it after a suspected
disclosure.

The deployments in the bucket hold each Worker's `vars` in plaintext, and
celld has no other secret store, so a Wrangler secret is such a var. Anyone
who can read the bucket can read them.

## Deploy only configs you trust

`celld deploy` and `celld dev` run a config's `build.command` with `sh -c`, as
the user who runs them and with their environment, the bucket credentials
included. The config is the deployer's own code, like the project's
`package.json` scripts, so celld does not sandbox the command. Treat a
Wrangler config from elsewhere like any other script before you deploy it, or
deploy it with `--no-build` after you build it yourself. A Worker or a Dynamic
Worker cannot reach the command: only the deploy reads the config.

## Cell ownership

Each cell is a SQLite database with one writer. An ownership epoch fences each
cell, so a node that loses its lease cannot modify the current state. This
fencing protects storage consistency. It does not isolate hostile
applications. See [what celld guarantees](guarantees.md) and
[limitations](limitations.md).

## WebSocket ownership

A WebSocket is reachable only from the code that owns it, as in workerd:
the request that opened it, or the Durable Object (or facet) whose event
accepted, opened or bound it. Every event of a Durable Object is the same
owner, so a hibernatable socket still works after the object wakes.

- **Socket objects.** A `WebSocket` keeps its state in private fields, and
  records the owner of the code that made it. Using it from any other
  request or Durable Object, including after its request has ended, throws
  workerd's cross-request (or cross-object) I/O error before anything else
  is checked. A pair's ends are joined inside the isolate only while
  neither has reached the host or left in a response; a client end that
  left in a response cannot be accepted. The constructor only dials: a number is a URL, never a socket
  id. A `Response` takes only a real `WebSocket`, and has no option that
  names a socket.
- **Host ids.** The host allocates a socket id only as it registers the
  socket, and records the owner from the running event, never from a value
  the script passes. Every socket operation checks that owner, and refuses
  another owner's socket with the cross-request error.
- **Durable Object targets.** A subrequest's 101 names the Durable Object
  socket it carries as `{id, scope}`. The host grants that name to the
  caller that received it, and admits it once: to `accept()` the socket, or
  to return it in the caller's own response. A Durable Object may also
  return its own socket. Grants end when their holder's request retires, its
  Durable Object stops, the socket closes, or 30 seconds pass unused. A
  holder has at most 64, and a response that arrives after its caller
  retired grants nothing.
- **Durable Object state.** `getWebSockets()`, `acceptWebSocket()` and the
  auto-response pair act on the running Durable Object, whichever object's
  `ctx` they are called on, as in workerd, and throw a `TypeError` outside a
  Durable Object event.
