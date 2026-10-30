// A module has one namespace: import() of a node builtin that a static
// import already linked gives the same namespace object, and so does a
// second import(). celld links a dynamic import of a node builtin to a
// module of its own (`dyn:` in js/modules.rs), so the namespaces differ,
// though their members are the same values.
import * as events from "node:events";
import * as timers from "node:timers";
import * as util from "node:util";
import * as perfHooks from "node:perf_hooks";

export default {
  async fetch() {
    const check = async (name, namespace) => {
      const dynamic = await import(name);
      return [name, dynamic === namespace, dynamic === await import(name),
        dynamic.default === namespace.default];
    };
    return Response.json([
      await check("node:events", events),
      await check("node:timers", timers),
      await check("node:util", util),
      await check("node:perf_hooks", perfHooks),
    ]);
  },
};
