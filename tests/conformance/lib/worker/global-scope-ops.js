// What one operation does at a Dynamic Worker's module scope, where workerd
// has no current request: whether it returns (a string result shown), throws
// or gives a promise, and how that promise settles. A refused one is
// workerd's global-scope error (`IoContext::current()`), shown as
// `<global scope>`. Each child catches, so it starts and reports. The
// `loader/global-scope-ops*` cases name their operations in groups, each
// `{ op, pre?, flags? }`: `op` an expression evaluated once at module scope,
// `pre` module code before it (imports), `flags` the child's compatibility
// flags. loader/global-scope-io covers how an uncaught refusal fails the
// start.
const GLOBAL_SCOPE = "Disallowed operation called within global scope. " +
  "Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and " +
  "generating random values are not allowed within global scope. To fix this " +
  "error, perform this operation within a handler. " +
  "https://developers.cloudflare.com/workers/runtime-apis/handlers/";

const describe = (error) => {
  if (error === null || typeof error !== "object") return `non-error ${String(error)}`;
  const message = error.message === GLOBAL_SCOPE ? "<global scope>" : error.message;
  return `${error.name}: ${message}`;
};

const child = ({ pre = "", op }) => `${pre}
let outcome;
try {
  const value = (${op});
  if (value !== null && typeof value === "object" && typeof value.then === "function") {
    outcome = "pending";
    value.then(() => { outcome = "resolved"; }, (error) => { outcome = "rejected " + describe(error); });
  } else {
    outcome = typeof value === "string" ? "returned " + value : "returned";
  }
} catch (error) {
  outcome = "threw " + describe(error);
}
function describe(error) {
  if (error === null || typeof error !== "object") return "non-error " + String(error);
  const message = error.message === ${JSON.stringify(GLOBAL_SCOPE)} ? "<global scope>" : error.message;
  return error.name + ": " + message;
}
export default { fetch() { return new Response(outcome); } };
`;

// The handler of a case's Worker: `/?group=<name>` loads each of that
// group's children and answers with what each reported.
export const probe = (groups) => ({
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("group");
    const group = groups[name];
    if (group === undefined) return new Response("unknown group", { status: 400 });
    const results = {};
    for (const [key, spec] of Object.entries(group)) {
      try {
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-01",
          compatibilityFlags: spec.flags ?? [],
          mainModule: "main.js",
          modules: { "main.js": child(spec) },
        });
        const response = await worker.getEntrypoint().fetch("http://child/");
        results[key] = await response.text();
      } catch (error) {
        results[key] = "start failed " + describe(error);
      }
    }
    return Response.json(results);
  },
});
