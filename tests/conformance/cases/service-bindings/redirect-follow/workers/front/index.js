// A Fetcher follows a redirect through itself, as workerd's fetchImpl does
// (api/http.c++): a relative Location, and an absolute one to another host,
// both go back to the same target, never to the network. The follow keeps
// global fetch()'s rules: the final URL and `redirected`, the method and body
// each status keeps, Authorization dropped across origins, the limit of 20
// redirects, and a body that can't be sent again. Each target answers with
// `serve`, whose `/echo` reports the request it received.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Not Content-Length: celld doesn't add it to a byte body yet
// (service-bindings/body-length, plan 1.41).
const ECHOED = [
  "host", "authorization", "cookie", "proxy-authorization", "x-custom",
  "content-type", "transfer-encoding",
];

async function serve(request, who) {
  const url = new URL(request.url);
  const query = url.searchParams;
  switch (url.pathname) {
    case "/echo": {
      const report = JSON.stringify({
        who,
        url: request.url,
        method: request.method,
        redirect: request.redirect,
        headers: Object.fromEntries(ECHOED.map((name) => [name, request.headers.get(name)])),
        body: await request.text(),
      });
      return new Response(report, { headers: { "content-type": "application/json", "x-echo": report } });
    }
    case "/redirect": {
      const headers = query.has("to") ? { location: query.get("to") } : {};
      return new Response("redirect", { status: Number(query.get("status") ?? 302), headers });
    }
    case "/chain": {
      const n = Number(query.get("n"));
      return new Response("chain", { status: 302, headers: { location: n > 0 ? `/chain?n=${n - 1}` : "/echo" } });
    }
    case "/loop":
      return new Response("loop", { status: 302, headers: { location: "/loop" } });
    case "/cf":
      return Response.json(request.cf ?? null);
    default:
      return new Response("not found", { status: 404 });
  }
}

const CODE = `
  import { DurableObject } from "cloudflare:workers";
  const ECHOED = ${JSON.stringify(ECHOED)};
  const serve = ${serve.toString()};
  export default { fetch: (request) => serve(request, "loader") };
  export class App extends DurableObject {
    fetch(request) { return serve(request, "facet"); }
  }
`;

const loaded = (env) =>
  env.LOADER.get("redirect-follow-v1", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "app.js",
    modules: { "app.js": CODE },
  }));

const BASE = "http://target.test";
const redirect = (to, status = 302) => `${BASE}/redirect?status=${status}&to=${encodeURIComponent(to)}`;

async function probe(target, url, init) {
  try {
    const response = await target.fetch(url, init);
    const echoed = response.headers.get("x-echo");
    const text = await response.text();
    return {
      status: response.status,
      url: response.url,
      redirected: response.redirected,
      body: echoed !== null ? JSON.parse(echoed) : text,
    };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

function stream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed"));
      controller.close();
    },
  });
}

// What every kind of Fetcher does.
async function basics(target) {
  return {
    relative: await probe(target, redirect("/echo")),
    // Another host: the same target answers it.
    absolute: await probe(target, redirect("http://other.test:8080/echo")),
    manual: await probe(target, redirect("/echo"), { redirect: "manual" }),
    post307: await probe(target, redirect("/echo", 307), {
      method: "POST", headers: { "content-type": "text/plain" }, body: "payload",
    }),
    stream307: await probe(target, redirect("/echo", 307), { method: "POST", body: stream() }),
  };
}

// The rest of the rules, through one service binding.
async function details(target) {
  const methods = {};
  for (const status of [301, 302, 303, 307, 308]) {
    for (const method of ["POST", "PUT", "HEAD"]) {
      methods[`${status} ${method}`] = await probe(target, redirect("/echo", status), {
        method,
        headers: { "content-type": "text/plain" },
        body: method === "HEAD" ? undefined : "payload",
      });
    }
  }
  const credentials = {
    authorization: "Bearer token",
    cookie: "session=1",
    "proxy-authorization": "Basic cHJveHk=",
    "x-custom": "kept",
  };
  return {
    methods,
    sameOrigin: await probe(target, redirect(`${BASE}/echo`), { headers: credentials }),
    crossOrigin: await probe(target, redirect("http://other.test/echo"), { headers: credentials }),
    // The scheme alone makes another origin.
    crossScheme: await probe(target, redirect("https://target.test/echo"), { headers: credentials }),
    fragment: await probe(target, redirect("/echo#fragment")),
    // A request URL with a fragment keeps its byte body replayable.
    fragmentPost307: await probe(target, redirect("/echo", 307) + "#fragment", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "payload",
    }),
    fragmentPut301: await probe(target, redirect("/echo", 301) + "#fragment", {
      method: "PUT", headers: { "content-type": "text/plain" }, body: "payload",
    }),
    requestFragment: await probe(target, `${BASE}/echo#fragment`),
    noLocation: await probe(target, `${BASE}/redirect`),
    twentyRedirects: await probe(target, `${BASE}/chain?n=19`),
    twentyOneRedirects: await probe(target, `${BASE}/chain?n=20`),
    loop: await probe(target, `${BASE}/loop`),
    stream301: await probe(target, redirect("/echo", 301), { method: "POST", body: stream() }),
    stream303: await probe(target, redirect("/echo", 303), { method: "POST", body: stream() }),
    invalidLocation: await probe(target, redirect("http://[bad")),
    errorMode: await probe(target, redirect("/echo"), { redirect: "error" }),
  };
}

export class Obj extends DurableObject {
  facet() {
    return this.ctx.facets.get("app", () => ({
      class: loaded(this.env).getDurableObjectClass("App"),
    }));
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/facet-basics") {
      return Response.json(await basics(this.facet()));
    }
    return serve(request, "object");
  }
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    return serve(request, "loopback");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targets = {
      back: () => env.BACK,
      backNamed: () => env.BACK_NAMED,
      self: () => env.SELF,
      loopback: () => ctx.exports.Local,
      object: () => env.OBJ.getByName("a"),
      loader: () => loaded(env).getEntrypoint(),
    };
    const [, step, name] = url.pathname.split("/");
    switch (step) {
      case "basics":
        if (name === "facet") {
          return env.OBJ.getByName("a").fetch("http://object.test/facet-basics");
        }
        return Response.json(await basics(targets[name]()));
      case "details":
        return Response.json(await details(env.BACK));
      // A Worker that replaces the globals a redirect could use doesn't
      // change how one is followed.
      case "globals": {
        const saved = { Request, URL, get: Headers.prototype.get };
        let response;
        try {
          globalThis.Request = globalThis.URL = function () {
            throw new Error("replaced");
          };
          Headers.prototype.get = () => null;
          response = await env.BACK.fetch(redirect("/echo"));
        } finally {
          globalThis.Request = saved.Request;
          globalThis.URL = saved.URL;
          Headers.prototype.get = saved.get;
        }
        return Response.json({ status: response.status, url: response.url, redirected: response.redirected });
      }
      // `cf` on every hop, through a target in this isolate: celld doesn't
      // deliver it across isolates yet (service-bindings/request-cf).
      case "cf":
        return Response.json(await probe(ctx.exports.Local, redirect("/cf", 307), {
          cf: { colo: "TEST" },
        }));
      // The request this Worker received as the init of another: its body
      // is a stream.
      case "forward-init": {
        const copy = new Request(redirect("/echo", Number(name)), request);
        return Response.json(await probe(env.BACK, new Request(copy, { redirect: "follow" })));
      }
      default:
        // The request this Worker received, sent on: its body is a one-time
        // stream however small it is, so only a 303 can follow.
        if (url.searchParams.has("forward")) {
          return Response.json(await probe(env.BACK, new Request(request, { redirect: "follow" })));
        }
        // SELF's target.
        return serve(request, "self");
    }
  },
};
