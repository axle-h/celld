// Reports `process.env` here and in each Worker behind a service binding, and
// in Dynamic Workers given an `env` of their own. `/mutate` checks that
// `process.env` coerces what is stored in it to strings, as in Node.js.
import process from "node:process";
import { report } from "#process-env";

const WORKERS = [
  "BEFORE",
  "ENABLE",
  "DISABLE",
  "NO_COMPAT",
  "NO_COMPAT_ENABLE",
  "V2",
  "V2_ENABLE",
  "DEFAULT_DATE",
  "DEFAULT_DATE_NO_COMPAT",
];

// A loaded Worker's own report: what `process.env` held while its module
// evaluated, and when it handled the request, and the `env` names its module
// could read at module scope.
const LOADED_SOURCE = `
  import { env } from "cloudflare:workers";
  const snapshot = () => ({ ...(globalThis.process?.env ?? {}) });
  const atLoad = snapshot();
  const envAtLoad = Object.keys(env).sort();
  export default {
    fetch() {
      return Response.json({ atLoad, now: snapshot(), envAtLoad });
    },
  };
`;

async function attempt(fn) {
  try {
    const value = await fn();
    return { value: value ?? null };
  } catch (error) {
    return {
      error: `${error.name}: ${error.message}`,
      code: error.code ?? null,
      string: String(error),
    };
  }
}

async function loaded(env, id, code) {
  const worker = env.LOADER.get(id, () => ({
    mainModule: "worker.js",
    modules: { "worker.js": LOADED_SOURCE },
    ...code,
  }));
  return attempt(async () => (await worker.getEntrypoint().fetch("http://loaded/")).json());
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/":
        return Response.json(report());
      case "/workers": {
        const reports = {};
        for (const name of WORKERS) {
          reports[name] = await (await env[name].fetch("http://worker/")).json();
        }
        return Response.json(reports);
      }
      case "/values":
        return Response.json({
          keys: Object.keys(process.env).sort(),
          list: process.env.LIST,
          envListIsArray: Array.isArray(env.LIST),
          object: process.env.OBJECT,
          separators: [...process.env.SEPARATORS].map((c) => c.codePointAt(0)),
          nulDigit: [...env.NUL_DIGIT].map((c) => c.codePointAt(0)),
          nulDigitSame: process.env.NUL_DIGIT === env.NUL_DIGIT,
          number: [typeof process.env.NUMBER, process.env.NUMBER],
          false: process.env.FALSE,
          null: process.env.NULL,
          overridden: process.env.OVERRIDDEN,
          dotenvOnly: process.env.DOTENV_ONLY,
          kv: "KV" in process.env,
          loader: "LOADER" in process.env,
          service: "BEFORE" in process.env,
          sameObject: process.env === globalThis.process.env,
          prototype: Object.getPrototypeOf(process.env) === Object.prototype,
          json: JSON.parse(JSON.stringify(process.env)).TEXT,
        });
      case "/mutate": {
        const e = process.env;
        const out = {};
        e.SET_NUMBER = 5;
        out.setNumber = [typeof e.SET_NUMBER, e.SET_NUMBER];
        e.SET_UNDEFINED = undefined;
        out.setUndefined = e.SET_UNDEFINED;
        e.SET_OBJECT = { a: 1 };
        out.setObject = e.SET_OBJECT;
        e.SET_NULL = null;
        out.setNull = e.SET_NULL;
        out.deleted = delete e.SET_UNDEFINED;
        out.stillThere = "SET_UNDEFINED" in e;
        e.TEXT = "changed";
        out.text = [e.TEXT, env.TEXT];
        e.TEXT = "text";
        out.symbolKey = await attempt(() => {
          e[Symbol("key")] = "x";
        });
        out.symbolValue = await attempt(() => {
          e.SYMBOL_VALUE = Symbol("value");
        });
        out.getter = await attempt(() =>
          Object.defineProperty(e, "GETTER", { get() { return "x"; }, configurable: true, enumerable: true }),
        );
        out.notConfigurable = await attempt(() =>
          Object.defineProperty(e, "NOT_CONFIGURABLE", { value: "x", enumerable: true, writable: true }),
        );
        out.notEnumerable = await attempt(() =>
          Object.defineProperty(e, "NOT_ENUMERABLE", { value: "x", configurable: true, writable: true }),
        );
        out.notWritable = await attempt(() =>
          Object.defineProperty(e, "NOT_WRITABLE", { value: "x", configurable: true, enumerable: true }),
        );
        out.noValue = await attempt(() =>
          Object.defineProperty(e, "NO_VALUE", { configurable: true, enumerable: true, writable: true }),
        );
        out.symbolDefined = await attempt(() =>
          Object.defineProperty(e, "SYMBOL_DEFINED", {
            value: Symbol("v"),
            configurable: true,
            enumerable: true,
            writable: true,
          }),
        );
        await attempt(() =>
          Object.defineProperty(e, "DEFINED", { value: 7, configurable: true, enumerable: true, writable: true }),
        );
        out.defined = [typeof e.DEFINED, e.DEFINED];
        out.leftovers = ["GETTER", "NOT_CONFIGURABLE", "NOT_ENUMERABLE", "NOT_WRITABLE", "NO_VALUE"].filter(
          (name) => name in e,
        );
        for (const name of ["SET_NUMBER", "SET_OBJECT", "SET_NULL", "DEFINED"]) delete e[name];
        return Response.json(out);
      }
      case "/dynamic": {
        const shared = { x: 1 };
        const cycle = { name: "cycle" };
        cycle.self = cycle;
        return Response.json({
          // The parent's vars stay with the parent: a loaded Worker's
          // `process.env` comes from the `env` it is given.
          withoutEnv: await loaded(env, "without-env", {
            compatibilityDate: "2025-04-01",
            compatibilityFlags: ["nodejs_compat"],
          }),
          withEnv: await loaded(env, "with-env", {
            compatibilityDate: "2025-04-01",
            compatibilityFlags: ["nodejs_compat"],
            env: {
              TEXT: "loaded",
              NUMBER: 1,
              OBJECT: { list: [1, null, "x"] },
              SERVICE: env.BEFORE,
              NESTED_SERVICE: { service: env.BEFORE },
              DATE: new Date(0),
              MAP: new Map([["a", 1]]),
              UNDEFINED: undefined,
              // The same object twice in one entry, and an object that
              // contains itself: JSON would lose the sharing, so workerd
              // leaves both entries out.
              ALIASED: { first: shared, second: shared },
              CYCLE: cycle,
            },
          }),
          beforeDate: await loaded(env, "before-date", {
            compatibilityDate: "2025-03-31",
            compatibilityFlags: ["nodejs_compat"],
            env: { TEXT: "loaded" },
          }),
        });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
