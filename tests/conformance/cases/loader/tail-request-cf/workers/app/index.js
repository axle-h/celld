// A Dynamic Worker's tail event reports the `cf` its fetch carried, however
// deeply nested, and has none when the fetch carried none.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class TailLog extends DurableObject {
  append(records) {
    const log = this.ctx.storage.kv.get("log") ?? [];
    this.ctx.storage.kv.put("log", [...log, ...records]);
  }
  read() {
    return this.ctx.storage.kv.get("log") ?? [];
  }
}

// How deeply `cf.deep` nests, for a `cf` too deep to record whole.
function depth(cf) {
  let levels = 0;
  for (let at = cf?.deep; Array.isArray(at); at = at[0]) levels++;
  return levels;
}

export class Tail extends WorkerEntrypoint {
  async tail(events) {
    const records = events.map((event) => {
      const { url, cf } = event.event.request;
      return {
        url,
        hasCf: "cf" in event.event.request,
        cf: url.endsWith("/c-deep-cf") ? { depth: depth(cf) } : cf ?? "none",
      };
    });
    await this.env.TAIL_LOG.getByName("log").append(records);
  }
}

async function waitForTails(env, count) {
  const log = env.TAIL_LOG.getByName("log");
  for (let attempt = 0; attempt < 100; attempt++) {
    const records = await log.read();
    if (records.length >= count) return records;
    await scheduler.wait(50);
  }
  return log.read();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/tails") {
      const records = await waitForTails(env, Number(url.searchParams.get("count")));
      records.sort((a, b) => a.url.localeCompare(b.url));
      return Response.json(records);
    }
    const worker = env.LOADER.get("tail-request-cf", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "worker.js",
      modules: { "worker.js": "export default { fetch: () => new Response('ok') };" },
      tails: [ctx.exports.Tail({})],
    }));
    const entrypoint = worker.getEntrypoint();
    await (await entrypoint.fetch("http://child.test/a-with-cf", { cf: { colo: "TAIL", n: [1] } })).text();
    await (await entrypoint.fetch("http://child.test/b-without-cf")).text();
    // Past serde_json's recursion limit of 128.
    const deep = JSON.parse(`{"deep":${"[".repeat(200)}${"]".repeat(200)}}`);
    await (await entrypoint.fetch("http://child.test/c-deep-cf", { cf: deep })).text();
    return new Response("sent");
  },
};
