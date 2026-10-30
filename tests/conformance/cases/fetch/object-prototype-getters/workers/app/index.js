// Getters on Object.prototype named like the fields of the options and
// records the runtime builds for itself change nothing it does: an incoming
// request, a service binding's fetch (to the Worker's own entrypoint and to
// another script), an RPC call carrying a Request and a subrequest work as
// without them, and the runtime calls none of them.
// workerd builds those natively; celld's harness builds them as objects of
// its own, which must not reach Object.prototype (plan 1.36).
import { WorkerEntrypoint } from "cloudflare:workers";

const KEYS = [
  "cf", "signal", "redirect", "method", "body", "headers", "headersList",
  "headersJson", "cache", "oneTimeBody", "incomingSignal", "received",
  "hasBody", "status", "statusText", "error", "url", "type", "streamId",
  "bodyStreamId", "bodyBytes", "webSocket", "integrity", "fetcher",
  "encodeResponseBody",
];
const calls = [];
for (const key of KEYS) {
  Object.defineProperty(Object.prototype, key, {
    get() {
      calls.push(key);
      return undefined;
    },
    configurable: true,
  });
}

export class Echo extends WorkerEntrypoint {
  async fetch(request) {
    return new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
  }
  async take(request) {
    return `${request.method} ${request.url} ${await request.text()}`;
  }
}

export default {
  async fetch(request, env) {
    const port = new URL(request.url).searchParams.get("port");
    const atStart = calls.splice(0);
    const binding = await (await env.SELF.fetch(
      new Request("http://x/binding", { method: "POST", body: "payload" }))).text();
    const otherScript = await (await env.OTHER.fetch(
      new Request("http://x/other", { method: "POST", body: "across" }))).text();
    const rpc = await env.SELF.take(new Request("http://x/rpc", { method: "PUT", body: "carried" }));
    const upstream = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", body: "out" });
    const echoed = await upstream.json();
    return new Response(JSON.stringify({
      incoming: `${request.method} ${await request.text()}`,
      atStart,
      binding,
      otherScript,
      rpc,
      upstream: { status: upstream.status, method: echoed.method, body: echoed.body },
      calls: calls.splice(0),
    }), { headers: { "content-type": "application/json" } });
  },
};
