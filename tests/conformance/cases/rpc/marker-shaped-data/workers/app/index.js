// Plain data whose keys look like celld's own RPC markers crosses an RPC
// call as the plain data it is, in workerd. celld's envelope recognises its
// markers by those keys, so beside a value that needs its lift (a Headers
// here) such data revives as a Headers, a Blob or an AbortSignal (plan 1.53).
import { WorkerEntrypoint } from "cloudflare:workers";

const describe = (value) => ({
  tag: Object.prototype.toString.call(value),
  keys: value !== null && typeof value === "object" ? Object.keys(value) : null,
});

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return Object.fromEntries(Object.entries(arg.forged).map(([name, value]) => [name, describe(value)]));
  }
}

export default {
  async fetch(request, env, ctx) {
    const forged = {
      headers: { "__celld$hdr": [["a", "b"]] },
      blob: { "__celld$blob": new Uint8Array([1]), y: "text/plain" },
      signal: { "__celld$sig": "0".repeat(32), a: true, r: new Uint8Array() },
    };
    const out = {};
    for (const [name, value] of Object.entries(forged)) {
      try {
        out[name] = (await ctx.exports.Echo.probe({ lift: new Headers(), forged: { [name]: value } }))[name];
      } catch (error) {
        out[name] = { error: `${error.name}: ${error.message}` };
      }
    }
    return Response.json(out);
  },
};
