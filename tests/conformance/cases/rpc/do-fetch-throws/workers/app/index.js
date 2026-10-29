// A Durable Object's fetch() handler that throws rejects the caller's
// stub.fetch() with the thrown error, as workerd delivers it. celld rejects
// with "rejected: " and the error's text and stack folded into the message
// (plan 1.59, found by 1.30).
import { DurableObject } from "cloudflare:workers";

export class Obj extends DurableObject {
  async fetch() {
    throw new RangeError("fetch threw");
  }
}

export default {
  async fetch(request, env) {
    try {
      await env.OBJ.getByName("x").fetch("http://x/");
      return Response.json("resolved");
    } catch (error) {
      return Response.json({ name: error.name, message: error.message });
    }
  },
};
