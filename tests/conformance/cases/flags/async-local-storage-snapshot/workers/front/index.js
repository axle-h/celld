import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import probe from "../../probe.js";

// A Durable Object's requests share its IoContext in workerd, so a function
// bound in one of them runs in the next.
const als = new AsyncLocalStorage();
let boundInObject = null;
const attempt = (fn) => {
  try {
    return fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export class Holder extends DurableObject {
  fetch(request) {
    if (new URL(request.url).pathname === "/do/make") {
      boundInObject = als.run("in object", () => AsyncLocalStorage.bind(() => als.getStore() ?? "none"));
      return Response.json({ same: attempt(boundInObject) });
    }
    return Response.json({ later: attempt(boundInObject) });
  }
}

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/do/")) {
      return env.HOLDER.getByName("holder").fetch(request);
    }
    const binding = { before: env.BEFORE, disable: env.DISABLE }[path.split("/")[1]];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
