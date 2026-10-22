// A request with a byte body reaches the target of a Fetcher with a
// Content-Length, as it would over HTTP, through every kind of Fetcher.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const report = (request) =>
  Response.json({
    contentLength: request.headers.get("content-length"),
    transferEncoding: request.headers.get("transfer-encoding"),
  });

const CODE = `export default { fetch: ${report.toString()} };`;

export class Obj extends DurableObject {
  fetch(request) {
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
    const targets = {
      back: env.BACK,
      loopback: ctx.exports.Local,
      object: env.OBJ.getByName("a"),
      loader: env.LOADER.get("body-length-v1", () => ({
        compatibilityDate: "2026-01-01",
        mainModule: "app.js",
        modules: { "app.js": CODE },
      })).getEntrypoint(),
    };
    const seen = {};
    for (const [name, target] of Object.entries(targets)) {
      seen[name] = {
        bytes: await (await target.fetch("http://target.test/", { method: "POST", body: "payload" })).json(),
        empty: await (await target.fetch("http://target.test/", { method: "POST", body: "" })).json(),
      };
    }
    return Response.json(seen);
  },
};
