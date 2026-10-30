// `env` and `exports` from cloudflare:workers, as workerd gives them
// (cloudflare/workers.ts, api/modules.c++ EnvModule): proxies over the
// Worker's env, which is whole while the main module evaluates, and over
// ctx.exports, which exists once it has. A write through `env` changes the
// env every handler gets; a write to `exports` changes nothing it reads.
import { env, exports, DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const attempt = (call) => {
  try {
    return call();
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};

const atModuleScope = {
  keys: Object.keys(env).sort(),
  greeting: env.GREETING,
  config: env.CONFIG,
  kv: typeof env.KV?.get,
  id: attempt(() => env.OBJ.idFromName("module").toString().length),
  has: "GREETING" in env,
  exportsKeys: Object.keys(exports),
  exportsDefault: typeof exports.default,
  hasDefault: "default" in exports,
};
env.ADDED = "at module scope";

export class Obj extends DurableObject {
  who() {
    return "Obj";
  }
}

export class Named extends WorkerEntrypoint {
  hello() {
    return "named";
  }
}

export default {
  async fetch(request, handlerEnv, ctx) {
    if (new URL(request.url).pathname === "/off") return handlerEnv.OFF.fetch(request);
    exports.Written = "x";
    return Response.json({
      atModuleScope,
      request: {
        same: env === handlerEnv,
        keys: Object.keys(env).sort(),
        handlerKeys: Object.keys(handlerEnv).sort(),
        added: handlerEnv.ADDED,
        sameBinding: env.KV === handlerEnv.KV,
        exportsKeys: Object.keys(exports).filter((name) => !name.startsWith("__")).sort(),
        sameExports: ["default", "Named", "Obj"].map((name) => exports[name] === ctx.exports[name]),
        exportsDefault: typeof exports.default,
        hasDefault: "default" in exports,
        written: exports.Written ?? null,
        named: await exports.Named.hello(),
        object: await exports.Obj.get(exports.Obj.idFromName("x")).who(),
        descriptor: Object.getOwnPropertyDescriptor(env, "GREETING"),
        deleted: delete env.ADDED,
        afterDelete: handlerEnv.ADDED ?? null,
      },
    });
  },
};
