# Limitations

celld v0.6.2 is a beta release with these operational limits. See
[Cloudflare compatibility](cloudflare-compat.md) for the supported services,
APIs, and Wrangler configuration.

## Fleets

- A fleet runs one application. celld has no account service, multi-tenant
  scheduler, or managed ingress.
- A fleet stores its durable state in an S3-compatible bucket, a Google Cloud
  Storage bucket, or an Azure Blob Storage container. Only `celld dev` can use
  the local SQLite object store.
- Ownership balancing counts cells by node weight, not by CPU or memory use.
  It moves only hibernated cells, so a fleet without idle eviction balances
  only the cells that hibernate on their own.

## Networking and security

- celld does not terminate TLS. Terminate public TLS at an ingress proxy, and
  put the internal listener on a private network or an encrypted overlay.
- Peer traffic is plaintext HTTP. The fleet HMAC authenticates tunnel
  establishment and control requests but does not encrypt data, so the network
  must provide confidentiality.
- The fleet bucket controls the fleet. Give its credentials access to one fleet
  only. See [Security](security.md).

## Object storage credentials

- The credential methods differ by provider. See
  [Configure object storage](README.md#configure-object-storage).
- Azure identity works only in the public Azure cloud. A managed identity from
  Azure App Service or Azure Container Apps does not work. Use a workload
  identity or a storage account key there.

## WebSockets

- An outbound Durable Object WebSocket keeps its cell resident. It closes when
  the cell moves to another node, so the application must store the
  connection intent and reconnect.
- A node limits the resident cells and outbound WebSockets.
- A WebSocket that a stateless Worker holds crosses service bindings, Dynamic
  Worker entrypoints and Durable Object calls only within one node. A Durable
  Object on another node cannot return one.

## Isolate limits

- A Worker must load within the V8 heap limit of its isolate
  (`CELLD_V8_HEAP_LIMIT_MB`, 128 MB by default) and within 1 second of CPU
  time, as on Cloudflare. The load covers compiling and evaluating the modules,
  installing the `env` and `process.env`, and reading the handlers. A load past
  either limit fails with Cloudflare's error, `Script startup exceeded memory
  limits.` or `Script startup exceeded CPU time limit.`, and celld discards the
  isolate.
- Each isolate start is a load, so the limits apply whenever a pool adds an
  isolate under load, or a Durable Object's isolate starts, and not only at a
  deployment. A Worker whose load is close to a limit can fail later, when a
  pool grows. A Durable Object request whose isolate fails to start rejects
  with `route failed: RuntimeFailed`, and the node log names the limit.
- celld stops a load at the memory limit when the operation in progress
  finishes: a JavaScript loop stops at once, but one builtin call, such as a
  single allocation of up to 1 GB (V8's largest object) or a `JSON.parse()`,
  runs to its end first. The node can therefore briefly hold a few GB more
  than the limit; a 1 GB array at module scope peaks at about 2.2 GB of
  resident memory.
- After the load, the heap limit is not a hard limit. An isolate over it
  refuses new hibernatable WebSockets and stops materializing SQL result sets,
  but celld does not stop a request that keeps allocating. V8 then ends the
  node's process when it cannot grow the heap further, so every Worker on the
  node stops.
- `ArrayBuffer` and WebAssembly memory is outside the V8 heap, and no limit
  counts it, during the load or after it.
- A request has a CPU limit only when a Dynamic Worker sets `cpuMs`. See
  [Dynamic Workers](services/dynamic-workers.md#differences-from-cloudflare).

## Platforms

- The installer supplies binaries for Linux x86-64, Linux ARM64, and Apple
  Silicon. Windows is not supported.
