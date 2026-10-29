// A genuine Headers, Blob, Request, Response, File or stream given every key
// celld's markers use, after an attempt to delete celld's clone poison. V8
// writes celld's host classes, which are JavaScript classes, as plain objects
// of their own keys, so one left to the clone in a lifted tree revived as a
// marker; workerd serializes each from its own state, or refuses it (plan
// 1.53). `/stamped` sends objects a script had File's and AbortSignal's
// constructors return (`Object.setPrototypeOf(File, () => target)`), which
// workerd leaves plain objects and celld once stamped with those classes'
// brands. Each step reports what arrived, or the error.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  HOST_NAMES, STAMP_NAMES, host, hostVerdict, plainVerdict, stamped, verdictSource,
} from "#marker-shaped";

const STREAMS = ["readable", "writable"];

const each = async (names, fn) => {
  const out = {};
  for (const name of names) {
    try {
      out[name] = await fn(name);
    } catch (error) {
      out[name] = `${error.name}: ${error.message}`;
    }
  }
  return out;
};

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return hostVerdict(arg.v);
  }
  probePlain(arg) {
    return plainVerdict(arg.v);
  }
  give(name) {
    return { v: host(name) };
  }
}

export class Obj extends DurableObject {
  async storage() {
    return each(HOST_NAMES, async (name) => {
      await this.ctx.storage.put(name, host(name));
      return hostVerdict(await this.ctx.storage.get(name));
    });
  }
  async stamped() {
    return each(STAMP_NAMES, async (name) => {
      await this.ctx.storage.put(name, { v: stamped(name) });
      return plainVerdict((await this.ctx.storage.get(name)).v);
    });
  }
}

const load = (env, v, call) => env.LOADER.load({
  compatibilityDate: "2026-01-01",
  mainModule: "main.js",
  modules: {
    "main.js": verdictSource() +
      `export default { async fetch(request, env) { return Response.json(await ${call}(env.v)); } };`,
  },
  env: { v },
}).getEntrypoint().fetch("http://loaded/").then((response) => response.json());

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const echo = ctx.exports.Echo;
    let out;
    if (pathname === "/rpc") {
      out = {
        params: await each(HOST_NAMES, (name) => echo.probe({ v: host(name) })),
        paramsLift: await each(HOST_NAMES, (name) =>
          echo.probe({ lift: new Headers(), v: host(name) })),
        result: await each(HOST_NAMES, async (name) => hostVerdict((await echo.give(name)).v)),
      };
    } else if (pathname === "/service") {
      // A stream across isolates is streams/byob-rpc-cross-script's (7.1).
      out = await each(HOST_NAMES.filter((name) => !STREAMS.includes(name)),
        (name) => env.OTHER.probe({ v: host(name) }));
    } else if (pathname === "/storage") {
      out = await env.OBJ.getByName("storage").storage();
    } else if (pathname === "/loader") {
      out = await each(HOST_NAMES, (name) => load(env, host(name), "hostVerdict"));
    } else {
      out = {
        params: await each(STAMP_NAMES, (name) =>
          echo.probePlain({ lift: new Headers(), v: stamped(name) })),
        service: await each(STAMP_NAMES, (name) => env.OTHER.probePlain({ v: stamped(name) })),
        storage: await env.OBJ.getByName("stamped").stamped(),
        loader: await each(STAMP_NAMES, (name) => load(env, stamped(name), "plainVerdict")),
      };
    }
    return Response.json(out);
  },
};
