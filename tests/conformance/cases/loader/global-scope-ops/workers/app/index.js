// What workerd refuses at a Dynamic Worker's module scope, and what it lets
// through there, for timers, random values, bodies, streams and the other
// APIs whose methods ask for the current request (lib/worker/global-scope-ops.js).
import { probe } from "#global-scope-ops";

const compat = ["nodejs_compat"];

const groups = {
  timers: {
    "set-timeout": { op: `setTimeout(() => {}, 0)` },
    "set-timeout-not-a-function": { op: `setTimeout("x", 0)` },
    "set-interval": { op: `setInterval(() => {}, 1000)` },
    "clear-timeout-id": { op: `clearTimeout(1)` },
    "clear-timeout-none": { op: `clearTimeout()` },
    "clear-timeout-undefined": { op: `clearTimeout(undefined)` },
    "clear-timeout-fraction": { op: `clearTimeout(1.5)` },
    "clear-timeout-null": { op: `clearTimeout(null)` },
    "clear-timeout-string": { op: `clearTimeout("1")` },
    "clear-interval-id": { op: `clearInterval(1)` },
    "scheduler-wait": { op: `scheduler.wait(0)` },
    "scheduler-wait-no-argument": { op: `scheduler.wait()` },
    "scheduler-wait-aborted": { op: `scheduler.wait(0, { signal: AbortSignal.abort() })` },
    "abort-signal-timeout": { op: `AbortSignal.timeout(10)` },
    // Replacing the global timers takes nothing from the refusal: the runtime's
    // own timers do not go through them.
    "scheduler-wait-replaced-set-timeout": {
      op: `(globalThis.setTimeout = () => 0, scheduler.wait(0))`,
    },
    "abort-signal-timeout-replaced-set-timeout": {
      op: `(globalThis.setTimeout = () => 0, AbortSignal.timeout(10))`,
    },
    "node-timers-promises-replaced-set-timeout": {
      flags: compat,
      pre: `import { setTimeout as sleep } from "node:timers/promises";`,
      op: `(globalThis.setTimeout = () => 0, sleep(0))`,
    },
    "node-set-timeout": { flags: compat, op: `setTimeout(() => {}, 0)` },
    "node-clear-timeout-id": { flags: compat, op: `clearTimeout(1)` },
    "node-set-immediate": { flags: compat, op: `setImmediate(() => {})` },
    "node-clear-immediate-none": { flags: compat, op: `clearImmediate(undefined)` },
    "node-timers-set-timeout": {
      flags: compat,
      pre: `import timers from "node:timers";`,
      op: `timers.setTimeout(() => {}, 0)`,
    },
    "node-timers-set-immediate": {
      flags: compat,
      pre: `import timers from "node:timers";`,
      op: `timers.setImmediate(() => {})`,
    },
    "node-timers-promises": {
      flags: compat,
      pre: `import { setTimeout as sleep } from "node:timers/promises";`,
      op: `sleep(0)`,
    },
  },
  random: {
    "get-random-values": { op: `crypto.getRandomValues(new Uint8Array(1))` },
    "get-random-values-float": { op: `crypto.getRandomValues(new Float32Array(1))` },
    "get-random-values-too-long": { op: `crypto.getRandomValues(new Uint8Array(65537))` },
    "random-uuid": { op: `crypto.randomUUID()` },
    "math-random": { op: `typeof Math.random()` },
    "generate-aes-gcm": {
      op: `crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"])`,
    },
    "generate-aes-cbc": {
      op: `crypto.subtle.generateKey({ name: "AES-CBC", length: 256 }, true, ["encrypt"])`,
    },
    "generate-hmac-no-usages": {
      op: `crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [])`,
    },
    "generate-hmac": {
      op: `crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"])`,
    },
    // Nor does replacing getRandomValues(), which a secret key is not drawn
    // through.
    "generate-hmac-replaced-get-random-values": {
      op: `(Object.getPrototypeOf(crypto).getRandomValues = (a) => a, ` +
        `crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]))`,
    },
    "generate-aes-gcm-replaced-get-random-values": {
      op: `(Object.getPrototypeOf(crypto).getRandomValues = (a) => a, ` +
        `crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"]))`,
    },
    "generate-ecdsa": {
      op: `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])`,
    },
    "generate-ed25519": { op: `crypto.subtle.generateKey("Ed25519", true, ["sign"])` },
    "generate-x25519": { op: `crypto.subtle.generateKey("X25519", true, ["deriveBits"])` },
    "generate-rsa": {
      op: `crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, ` +
        `publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])`,
    },
    "digest": { op: `crypto.subtle.digest("SHA-256", new Uint8Array(1))` },
    "node-random-bytes": {
      flags: compat,
      pre: `import { randomBytes } from "node:crypto";`,
      op: `randomBytes(4)`,
    },
    "node-random-uuid": {
      flags: compat,
      pre: `import { randomUUID } from "node:crypto";`,
      op: `randomUUID()`,
    },
    "node-random-int": {
      flags: compat,
      pre: `import { randomInt } from "node:crypto";`,
      op: `randomInt(10)`,
    },
    "node-random-fill-sync": {
      flags: compat,
      pre: `import { randomFillSync } from "node:crypto";`,
      op: `randomFillSync(new Uint8Array(4))`,
    },
    "node-webcrypto": {
      flags: compat,
      pre: `import { webcrypto } from "node:crypto";`,
      op: `webcrypto.getRandomValues(new Uint8Array(1))`,
    },
  },
  bodies: {
    "response-string": { op: `new Response("x")` },
    "response-empty-string": { op: `new Response("")` },
    "response-bytes": { op: `new Response(new Uint8Array(1))` },
    "response-number": { op: `new Response(123)` },
    "response-bad-status": { op: `new Response("x", { status: 99 })` },
    "response-bad-encode-body": { op: `new Response("x", { encodeBody: "bad" })` },
    "response-async-iterable": { op: `new Response((async function* () { yield "x"; })())` },
    "response-null": { op: `new Response(null)` },
    "response-no-body": { op: `new Response()` },
    "response-readable-stream": { op: `new Response(new ReadableStream())` },
    "response-transform-stream": { op: `new Response(new TransformStream().readable)` },
    "response-blob": { op: `new Response(new Blob(["x"]))` },
    "response-form-data": { op: `new Response(new FormData())` },
    "response-search-params": { op: `new Response(new URLSearchParams("a=1"))` },
    "response-json": { op: `Response.json({})` },
    "response-redirect": { op: `Response.redirect("http://example.com/")` },
    "response-error": { op: `Response.error()` },
    "response-null-text": { op: `new Response(null).text()` },
    "response-null-array-buffer": { op: `new Response(null).arrayBuffer()` },
    "response-null-clone": { op: `new Response(null).clone()` },
    "response-stream-text": { op: `new Response(new ReadableStream()).text()` },
    "response-stream-array-buffer": { op: `new Response(new ReadableStream()).arrayBuffer()` },
    "response-stream-json": { op: `new Response(new ReadableStream()).json()` },
    "response-stream-bytes": { op: `new Response(new ReadableStream()).bytes()` },
    "response-stream-blob": { op: `new Response(new ReadableStream()).blob()` },
    "response-stream-form-data": { op: `new Response(new ReadableStream()).formData()` },
    "response-stream-body-read": {
      op: `new Response(new ReadableStream()).body.getReader().read()`,
    },
    "response-stream-clone": { op: `new Response(new ReadableStream()).clone()` },
    "request-get": { op: `new Request("http://example.com/")` },
    "request-body": { op: `new Request("http://example.com/", { method: "POST", body: "x" })` },
    "request-get-with-body": { op: `new Request("http://example.com/", { body: "x" })` },
    "request-from-request": {
      op: `new Request(new Request("http://example.com/", { method: "POST", body: new ReadableStream() }))`,
    },
    "request-stream": {
      op: `new Request("http://example.com/", { method: "POST", body: new ReadableStream() })`,
    },
    "request-get-text": { op: `new Request("http://example.com/").text()` },
    "blob-text": { op: `new Blob(["x"]).text()` },
    "blob-array-buffer": { op: `new Blob(["x"]).arrayBuffer()` },
    "blob-stream": { op: `new Blob(["x"]).stream()` },
    "file": { op: `new File(["x"], "f.txt").size` },
  },
  streams: {
    "readable-read": {
      op: `new ReadableStream({ start(c) { c.enqueue(1); c.close(); } }).getReader().read()`,
    },
    "transform-read": {
      op: `(() => { const t = new TransformStream(); t.writable.getWriter().write(1); ` +
        `return t.readable.getReader().read(); })()`,
    },
    "transform-write": { op: `new TransformStream().writable.getWriter().write(1)` },
    "writable": { op: `new WritableStream()` },
    "identity-transform": { op: `new IdentityTransformStream()` },
    "fixed-length": { op: `new FixedLengthStream(1)` },
    "compression": { op: `new CompressionStream("gzip")` },
    "decompression": { op: `new DecompressionStream("gzip")` },
    "text-encoder-stream": { op: `new TextEncoderStream()` },
    "text-decoder-stream": { op: `new TextDecoderStream()` },
    "digest-stream": { op: `new crypto.DigestStream("SHA-256")` },
  },
  other: {
    "event-source": { op: `new EventSource("http://example.com/")` },
    "event-source-bad-url": { op: `new EventSource("not a url")` },
    "event-source-from": { op: `EventSource.from(new ReadableStream())` },
    "html-rewriter": { op: `new HTMLRewriter()` },
    "html-rewriter-transform-stream": {
      op: `new HTMLRewriter().transform(new Response(new ReadableStream()))`,
    },
    "extendable-event-wait-until": {
      op: `new ExtendableEvent("x").waitUntil(Promise.resolve())`,
    },
    "rpc-stub": {
      pre: `import { RpcStub, RpcTarget } from "cloudflare:workers";`,
      op: `typeof new RpcStub(new (class extends RpcTarget {})())`,
    },
    "rpc-stub-call": {
      pre: `import { RpcStub, RpcTarget } from "cloudflare:workers";`,
      op: `new RpcStub(new (class extends RpcTarget { m() { return 1; } })()).m()`,
    },
    "html-rewriter-transform": { op: `new HTMLRewriter().transform(new Response(null))` },
    "websocket-pair": { op: `new WebSocketPair()` },
    "websocket-pair-accept": { op: `new WebSocketPair()[0].accept()` },
    "wait-until": {
      pre: `import { waitUntil } from "cloudflare:workers";`,
      op: `waitUntil(Promise.resolve())`,
    },
    "report-error": { op: `reportError(new Error("reported"))` },
    "abort-listener-throws": {
      op: `(() => { const c = new AbortController(); ` +
        `c.signal.addEventListener("abort", () => { throw new Error("listener"); }); ` +
        `c.abort(); return c.signal.aborted; })()`,
    },
    "send-beacon": { op: `navigator.sendBeacon("http://example.com/")` },
    "structured-clone": { op: `structuredClone({ a: 1 }).a` },
    "performance-now": { op: `typeof performance.now()` },
    "date-now": { op: `typeof Date.now()` },
    "message-channel": { op: `new MessageChannel().port1.postMessage(1)` },
    "diagnostics-publish-unsubscribed": {
      flags: compat,
      pre: `import dc from "node:diagnostics_channel";`,
      op: `dc.channel("x").publish(1)`,
    },
    "diagnostics-publish-order": {
      flags: compat,
      pre: `import dc from "node:diagnostics_channel";`,
      op: `(() => { let called = false; const ch = dc.channel("y"); ` +
        `ch.subscribe(() => { called = true; }); ` +
        `try { ch.publish(1); return "published"; } catch (e) { return "subscriber called: " + called; } })()`,
    },
    "diagnostics-publish": {
      flags: compat,
      pre: `import dc from "node:diagnostics_channel";`,
      op: `(() => { const ch = dc.channel("x"); ch.subscribe(() => {}); ch.publish(1); })()`,
    },
    "async-local-storage": {
      flags: compat,
      pre: `import { AsyncLocalStorage } from "node:async_hooks";`,
      op: `new AsyncLocalStorage().run(1, () => 2)`,
    },
    "process-env": { flags: compat, op: `typeof process.env` },
  },
};

export default probe(groups);
