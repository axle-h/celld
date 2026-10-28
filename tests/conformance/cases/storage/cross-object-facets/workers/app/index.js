// One Durable Object's facets, used during another object's event in the
// same isolate (plan 1.49). The facet manager acts on the object that made
// it, which is not running, so nothing reaches that object's facets. Object
// "a" then uses its own.
import { DurableObject } from "cloudflare:workers";

const leaked = {};

export class Child extends DurableObject {
  fetch() {
    const n = this.ctx.storage.kv.get("n") ?? 0;
    this.ctx.storage.kv.put("n", n + 1);
    return new Response(`child ${n}`);
  }
}

export class Root extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/hold")) {
      leaked.facets = this.ctx.facets;
      const child = this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child }));
      return child.fetch("http://child/");
    }
    const { facets } = leaked;
    const outcome = {};
    for (const [name, use] of Object.entries({
      fetch: () => facets.get("child", () => ({ class: this.ctx.exports.Child }))
        .fetch("http://child/").then((response) => response.text()),
      fresh: () => facets.get("fresh", () => ({ class: this.ctx.exports.Child }))
        .fetch("http://child/").then((response) => response.text()),
    })) {
      try {
        outcome[name] = (await use()) ?? "ok";
      } catch (error) {
        outcome[name] = `${error.name}: ${error.message}`;
      }
    }
    return Response.json(outcome);
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).pathname.split("/")[1];
    return env.ROOT.getByName(name).fetch(request);
  },
};
