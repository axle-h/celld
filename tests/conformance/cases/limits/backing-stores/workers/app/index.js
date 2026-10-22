// Dynamic Workers whose module scope or request asks for or holds backing
// stores past the isolate's budget, and a stateless Worker (hog) that does
// in a request. What is refused throws V8's RangeError; what is held past
// the budget fails as the heap limit does. The node keeps serving.
import { buffers } from "../hog/buffers.js";

function source(at, kind) {
  // A method's text, `name() { … }`, is a function declaration's tail.
  const work = `(function ${buffers[kind]})();`;
  const answer = `new Response("ran " + (globalThis.result ?? ""))`;
  return at === "load"
    ? `${work}\nexport default { fetch() { return ${answer}; } };`
    : `export default { fetch() { ${work}\nreturn ${answer}; } };`;
}

async function outcome(call) {
  try {
    const response = await call();
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
  } catch (error) {
    // Without the location lines a failed load's report ends with.
    return { error: error.name, message: error.message.split("\n  at ")[0] };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    switch (url.pathname) {
      case "/other":
        return Response.json(await outcome(() => env.OTHER.fetch("http://other/")));
      case "/r2":
      case "/crypto":
      case "/sync":
      case "/sql-blobs":
      case "/forwarded":
        return Response.json(await outcome(() => env.HOG.fetch(`http://hog${url.pathname}${url.search}`)));
      case "/stateless":
        return Response.json(await outcome(() => env.HOG.fetch(`http://hog/?kind=${kind}`)));
      case "/dynamic": {
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-01",
          mainModule: "main.js",
          modules: { "main.js": source(url.searchParams.get("at"), kind) },
        });
        return Response.json(await outcome(() => worker.getEntrypoint().fetch("http://worker/")));
      }
    }
    return new Response("not found", { status: 404 });
  },
};
