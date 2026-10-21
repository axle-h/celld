// The surface of `cloudflare:workers`: every name workerd exports, how a
// namespace import and import() see it, the `restore` symbol, and the link
// error for a name the module lacks.
import * as cf from "cloudflare:workers";
import {
  DurableObject,
  RpcPromise,
  RpcProperty,
  RpcStub,
  RpcTarget,
  ServiceStub,
  WorkerEntrypoint,
  WorkflowEntrypoint,
  abortIsolate,
  cache,
  env,
  exports,
  restore,
  tracing,
  waitUntil,
  withEnv,
  withEnvAndExports,
  withExports,
} from "cloudflare:workers";

const named = {
  DurableObject,
  RpcPromise,
  RpcProperty,
  RpcStub,
  RpcTarget,
  ServiceStub,
  WorkerEntrypoint,
  WorkflowEntrypoint,
  abortIsolate,
  cache,
  env,
  exports,
  restore,
  tracing,
  waitUntil,
  withEnv,
  withEnvAndExports,
  withExports,
};

function types(module) {
  return Object.fromEntries(Object.keys(module).sort().map((name) => [name, typeof module[name]]));
}

export class Probe extends DurableObject {
  restoreType() {
    return typeof this.ctx.restore;
  }
}

async function link(env, name) {
  const binding = name === "default" ? "workers" : `{ ${name} }`;
  const worker = env.LOADER.get(`link-${name}`, () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "worker.js",
    modules: {
      "worker.js": `
        import ${binding} from "cloudflare:workers";
        export default { fetch() { return new Response(typeof ${name === "default" ? "workers" : name}); } };
      `,
    },
  }));
  try {
    const response = await worker.getEntrypoint().fetch("http://link.test/");
    return { ok: true, body: await response.text() };
  } catch (error) {
    // Only the link error itself. How a Worker Loader wraps a startup
    // failure differs between the runtimes and is not this case's subject.
    return { ok: false, error: /SyntaxError: [^\n]*/.exec(error.message)?.[0] ?? error.message };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/named":
        return Response.json(types(named));
      case "/namespace":
        return Response.json({
          keys: Object.keys(cf).sort(),
          types: types(cf),
          sameBindings: Object.keys(named).every((name) => cf[name] === named[name]),
          toStringTag: cf[Symbol.toStringTag],
        });
      case "/dynamic-import": {
        const module = await import("cloudflare:workers");
        return Response.json({
          keys: Object.keys(module).sort(),
          sameModule: module === cf,
        });
      }
      case "/restore":
        return Response.json({
          type: typeof restore,
          description: restore.description,
          keyFor: String(Symbol.keyFor(restore)),
          registered: restore === Symbol.for(restore.description),
          string: String(restore),
          stable: restore === cf.restore,
          methodKey: Object.getOwnPropertySymbols({ [restore]() {} }).length,
        });
      case "/ctx":
        return Response.json({
          flag: Cloudflare.compatibilityFlags.allow_irrevocable_stub_storage,
      execution: typeof ctx.restore,
          durableObject: await env.PROBE.getByName("probe").restoreType(),
        });
      case "/flagged/ctx":
        return env.FLAGGED.fetch(request);
      case "/link":
        return Response.json(await link(env, url.searchParams.get("import")));
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
