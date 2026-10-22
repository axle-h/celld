// The default export, the namespace, named imports, a bare specifier,
// require() and dynamic import() all give the global `process` or its
// fields, and process.getBuiltinModule() an object with the same fields.
import processDefault from "node:process";
import * as processNamespace from "node:process";
import { env, nextTick, versions } from "node:process";
import bareDefault from "process";
import required from "./required.cjs";

export default {
  async fetch() {
    const global = globalThis.process;
    const dynamic = await import("node:process");
    const builtin = global.getBuiltinModule("node:process");
    return Response.json({
      defaultIsGlobal: processDefault === global,
      bareIsGlobal: bareDefault === global,
      namespaceDefaultIsGlobal: processNamespace.default === global,
      namespaceEnv: processNamespace.env === global.env,
      namespaceNextTick: processNamespace.nextTick === global.nextTick,
      namedEnv: env === global.env,
      namedEnvText: env.TEXT,
      namedNextTick: nextTick === global.nextTick,
      versionsNode: typeof versions?.node,
      requireBare: required.bare === global,
      requirePrefixed: required.prefixed === global,
      dynamicDefault: dynamic.default === global,
      dynamicEnv: dynamic.env === global.env,
      // workerd's getBuiltinModule() returns its internal process object,
      // which shares these fields with the global but is not the same object.
      getBuiltin: {
        sameForBothNames: global.getBuiltinModule("process") === builtin,
        env: builtin.env === global.env,
        nextTick: builtin.nextTick === global.nextTick,
        exit: builtin.exit === global.exit,
        getBuiltinModule: builtin.getBuiltinModule === global.getBuiltinModule,
      },
    });
  },
};
