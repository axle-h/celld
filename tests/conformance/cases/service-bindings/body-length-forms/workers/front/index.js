// The framing headers a request's body gives it at the target of a Fetcher,
// for each kind of body and each kind of Fetcher: a byte body has its
// length, a stream of unknown length is chunked, and no body has neither,
// so its body is null. A framing header the caller set itself is kept, and
// says the request has a body.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// In a header, so a HEAD request's answer carries it too.
const report = async (request) =>
  new Response(null, {
    headers: {
      "x-report": JSON.stringify({
        contentLength: request.headers.get("content-length"),
        transferEncoding: request.headers.get("transfer-encoding"),
        nullBody: request.body === null,
        text: await request.text(),
      }),
    },
  });

// What each body reaches `fetch`'s target as. Self-contained, so a loaded
// Worker runs it too, through its globalOutbound, and with no named inner
// functions, which the bundler would give a helper the loaded Worker lacks.
const run = async (fetch) => {
  const encoder = new TextEncoder();
  // Each body as a fresh init, since a stream can be sent only once.
  const bodies = [
    ["none", () => ({ method: "GET" })],
    ["head", () => ({ method: "HEAD" })],
    ["postNoBody", () => ({ method: "POST" })],
    ["string", () => ({ method: "POST", body: "payload" })],
    ["empty", () => ({ method: "POST", body: "" })],
    ["emptyBytes", () => ({ method: "PUT", body: new Uint8Array(0) })],
    ["arrayBuffer", () => ({ method: "POST", body: encoder.encode("bytes!").buffer })],
    ["view", () => ({ method: "POST", body: new Uint8Array([104, 105]) })],
    ["blob", () => ({ method: "POST", body: new Blob(["blob", "body"]) })],
    ["params", () => ({ method: "POST", body: new URLSearchParams({ a: "1", b: "two" }) })],
    ["stream", () => {
      const chunks = ["str", "eam"];
      return {
        method: "POST",
        body: new ReadableStream({
          pull(controller) {
            if (chunks.length === 0) controller.close();
            else controller.enqueue(encoder.encode(chunks.shift()));
          },
        }),
      };
    }],
    ["fixedStream", () => {
      const { readable, writable } = new FixedLengthStream(5);
      const writer = writable.getWriter();
      writer.write(encoder.encode("fixed"));
      writer.close();
      return { method: "POST", body: readable };
    }],
    ["ownLength", () => ({ method: "POST", body: "payload", headers: { "content-length": "7" } })],
    ["ownWrongLength", () => ({ method: "POST", body: "payload", headers: { "content-length": "3" } })],
    ["ownChunked", () => ({ method: "POST", body: "payload", headers: { "transfer-encoding": "chunked" } })],
    ["lengthOnGet", () => ({ method: "GET", headers: { "content-length": "0" } })],
    ["request", () => new Request("http://target.test/report", { method: "POST", body: "from a Request" })],
  ];
  const seen = {};
  for (const [name, init] of bodies) {
    try {
      const response = await fetch("http://target.test/report", init());
      seen[name] = JSON.parse(response.headers.get("x-report"));
    } catch (error) {
      seen[name] = { error: `${error.name}: ${error.message}` };
    }
  }
  return seen;
};

const CODE = `
  import { DurableObject } from "cloudflare:workers";
  const report = ${report.toString()};
  const run = ${run.toString()};
  export default {
    async fetch(request) {
      if (new URL(request.url).pathname === "/outbound")
        return Response.json(await run(fetch));
      return report(request);
    },
  };
  export class App extends DurableObject {
    fetch(request) {
      return report(request);
    }
  }
`;

const loaded = (env, globalOutbound) =>
  env.LOADER.get(globalOutbound ? "body-length-forms-outbound" : "body-length-forms", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "app.js",
    modules: { "app.js": CODE },
    ...(globalOutbound ? { globalOutbound } : {}),
  }));

export class Obj extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/facet") {
      const facet = this.ctx.facets.get("app", () => ({
        class: loaded(this.env).getDurableObjectClass("App"),
      }));
      return Response.json(await run((url, init) => facet.fetch(url, init)));
    }
    return report(request);
  }
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    return report(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/forward") {
      // The request this Worker received, forwarded as it is: its body is a
      // stream with a known length.
      const response = await env.BACK.fetch(request);
      return Response.json(JSON.parse(response.headers.get("x-report")));
    }
    if (path !== "/") return report(request);
    const object = env.OBJ.getByName("a");
    const targets = {
      back: env.BACK,
      self: env.SELF,
      loopback: ctx.exports.Local,
      object,
      loader: loaded(env).getEntrypoint(),
    };
    const seen = {};
    for (const [name, target] of Object.entries(targets))
      seen[name] = await run((url, init) => target.fetch(url, init));
    seen.facet = await (await object.fetch("http://object.test/facet")).json();
    seen.globalOutbound = await (await loaded(env, ctx.exports.Local({})).getEntrypoint()
      .fetch("http://loader.test/outbound")).json();
    return Response.json(seen);
  },
};
