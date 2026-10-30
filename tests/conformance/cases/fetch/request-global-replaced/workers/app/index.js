// A Worker that replaces the Request, Response and Headers globals sees only
// the constructions its own code makes: workerd's own paths build their
// objects natively, and celld's use the classes it captured before any
// script ran, so neither an incoming request, a subrequest to the Worker's
// own entrypoint nor a Request that RPC delivers goes through the
// replacements, and nothing celld puts in its own inits reaches a script.
// A script's init cannot claim what celld's inits say, either: fields named
// like them change nothing, so its body stays one a redirect can send again.
import { WorkerEntrypoint } from "cloudflare:workers";

const seen = [];
const record = (name) => (target) => new Proxy(target, {
  construct(cls, args, newTarget) {
    const init = args[1];
    seen.push({
      name,
      init: init !== null && typeof init === "object"
        ? { keys: Object.keys(init), symbols: Object.getOwnPropertySymbols(init).length }
        : typeof init,
    });
    return Reflect.construct(cls, args, newTarget);
  },
});
globalThis.Request = record("Request")(globalThis.Request);
globalThis.Response = record("Response")(globalThis.Response);
globalThis.Headers = record("Headers")(globalThis.Headers);

export class Echo extends WorkerEntrypoint {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/redirect")
      return Response.redirect("http://x/landed", 307);
    return Response.json({ path, body: await request.text() });
  }
  give() {
    return new Request("http://x/given", { method: "POST", body: "given" });
  }
}

export default {
  async fetch(request, env) {
    const before = seen.length;
    const viaBinding = await (await env.SELF.fetch("http://x/echo")).json();
    const given = await env.SELF.give();
    const givenBody = await given.text();
    // Fields named like celld's own: none is taken.
    const forged = new Request("http://x/redirect", {
      method: "POST", body: "x", oneTimeBody: true, incomingSignal: true,
      received: true, headersJson: '[["x-forged","1"]]', hasBody: false,
    });
    const redirected = await (await env.SELF.fetch(forged)).json();
    return Response.json({
      atStart: before,
      seen,
      viaBinding,
      givenBody,
      forgedHeader: forged.headers.get("x-forged"),
      redirected,
    });
  },
};
