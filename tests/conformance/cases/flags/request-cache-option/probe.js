import { WorkerEntrypoint } from "cloudflare:workers";

// The Request `cache` option under cache_option_enabled and
// cache_no_cache_enabled: which modes a Request takes, what it reports,
// what copies keep, and what a subrequest with each mode carries.
const outcome = (make) => {
  try {
    const value = make();
    return { cache: value.cache ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
};

const MODES = [undefined, "no-store", "no-cache", "reload", "default", "force-cache", "No-Store", ""];

async function sent(env, init) {
  try {
    const response = await env.ECHO.fetch("http://echo/", init);
    return await response.json();
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export default {
  async fetch(request, env) {
    const constructed = {};
    for (const mode of MODES) {
      constructed[String(mode)] = outcome(() => new Request("http://x/", { cache: mode }));
    }
    const copies = {};
    for (const mode of ["no-store", "no-cache"]) {
      let original;
      try {
        original = new Request("http://x/", { cache: mode });
      } catch {
        continue;
      }
      copies[mode] = {
        request: outcome(() => new Request(original)),
        withInit: outcome(() => new Request(original, { method: "POST", body: "x" })),
        asInit: outcome(() => new Request("http://y/", original)),
        clone: outcome(() => original.clone()),
      };
    }
    const subrequests = {
      none: await sent(env, {}),
      noStore: await sent(env, { cache: "no-store" }),
      noCache: await sent(env, { cache: "no-cache" }),
      noStoreWithHeaders: await sent(env, {
        cache: "no-store",
        headers: { "cache-control": "max-age=5", pragma: "x" },
      }),
      noStoreWithTtl: await sent(env, { cache: "no-store", cf: { cacheTtl: 5 } }),
      noStoreWithNoCacheTtl: await sent(env, { cache: "no-store", cf: { cacheTtl: -1 } }),
      noCacheWithCacheControl: await sent(env, { cache: "no-cache", cf: { cacheControl: "max-age=5" } }),
      noStoreWithUndefinedTtl: await sent(env, { cache: "no-store", cf: { cacheTtl: undefined } }),
      noStoreWithUndefinedCacheControl: await sent(env, { cache: "no-store", cf: { cacheControl: undefined } }),
      ttl: await sent(env, { cf: { cacheTtl: 30 } }),
      ttlWithCacheControl: await sent(env, { cf: { cacheTtl: 30, cacheControl: "max-age=5" } }),
      request: await sent(env, (() => {
        try {
          return new Request("http://echo/", { cache: "no-store" });
        } catch {
          return {};
        }
      })()),
    };
    let rpc;
    try {
      rpc = await env.ECHO.cacheOf(new Request("http://x/", { cache: "no-store" }));
    } catch (error) {
      rpc = `${error.name}: ${error.message}`;
    }
    return Response.json({
      rpc,
      constructed,
      copies,
      subrequests,
      onPrototype: "cache" in Request.prototype,
      descriptor: (() => {
        const descriptor = Object.getOwnPropertyDescriptor(Request.prototype, "cache");
        if (descriptor === undefined) return null;
        let detached;
        try {
          detached = descriptor.get.call({});
        } catch (error) {
          detached = `${error.name}: ${error.message}`;
        }
        return {
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          set: descriptor.set === undefined ? null : typeof descriptor.set,
          name: descriptor.get.name,
          detached,
        };
      })(),
      unset: "cache" in new Request("http://x/") ? new Request("http://x/").cache ?? null : "absent",
      reported: {
        option: Cloudflare.compatibilityFlags.cache_option_enabled ?? null,
        noCache: Cloudflare.compatibilityFlags.cache_no_cache_enabled ?? null,
      },
    });
  },
};

// What a subrequest arrives with: the headers the cache mode adds, the cf
// properties it sets, and the receiving Request's own cache mode. The
// Worker's own entrypoint, so that cf reaches it on celld too (1.41).
const CF = ["cacheTtl", "cacheLevel", "cacheForceRevalidate", "cacheControl"];

export class Echo extends WorkerEntrypoint {
  fetch(request) {
    const cf = request.cf ?? {};
    return Response.json({
      cacheControl: request.headers.get("cache-control"),
      pragma: request.headers.get("pragma"),
      cf: Object.fromEntries(CF.filter((name) => name in cf).map((name) => [name, cf[name]])),
      cache: request.cache ?? null,
    });
  }

  cacheOf(request) {
    return request.cache ?? null;
  }
}
