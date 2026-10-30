// navigator.sendBeacon(url, body), as workerd's Navigator::sendBeacon
// (api/global-scope.c++): in a request it POSTs the body with the global
// fetch(), whatever the Worker made of globalThis.fetch, as work the request
// waits for, and answers true whatever the fetch does; outside one, at
// module scope, it sends nothing and answers false. The upstream records
// what arrives under each id.
const atModuleScope = navigator.sendBeacon("http://127.0.0.1:1/never");

const attempt = (call) => {
  try {
    return call();
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const base = `http://127.0.0.1:${url.searchParams.get("port")}`;
    if (url.pathname === "/log") {
      // A string body's Content-Type is builtins/body-defaults' (plan 1.43),
      // so only the others' is shown.
      const log = async (id, typed = false) =>
        (await (await fetch(`${base}/beacon/log?id=${id}`)).json()).received
          .map(({ method, headers, body }) =>
            typed ? { method, contentType: headers["content-type"], body } : { method, body });
      return Response.json({
        text: await log("text"),
        none: await log("none", true),
        form: await log("form", true),
        bytes: await log("bytes", true),
        replaced: await log("replaced"),
        object: await log("object"),
      });
    }
    const realFetch = globalThis.fetch;
    let replacedCalls = 0;
    globalThis.fetch = (...args) => {
      replacedCalls++;
      return realFetch(...args);
    };
    const form = new FormData();
    form.set("a", "b");
    const sent = {
      atModuleScope,
      text: navigator.sendBeacon(`${base}/beacon?id=text`, "hello"),
      none: navigator.sendBeacon(`${base}/beacon?id=none`),
      form: navigator.sendBeacon(`${base}/beacon?id=form`, new URLSearchParams("x=1")),
      bytes: navigator.sendBeacon(`${base}/beacon?id=bytes`, new Uint8Array([104, 105])),
      replaced: navigator.sendBeacon(`${base}/beacon?id=replaced`, "via"),
      object: navigator.sendBeacon(`${base}/beacon?id=object`, { toString: () => "converted" }),
      badUrl: attempt(() => navigator.sendBeacon("not a url", "x")),
      badScheme: attempt(() => navigator.sendBeacon("ftp://example.com/", "x")),
      symbol: attempt(() => navigator.sendBeacon(Symbol("x"))),
      noArguments: attempt(() => navigator.sendBeacon()),
      undefinedUrl: attempt(() => navigator.sendBeacon(undefined)),
      nullUrl: attempt(() => navigator.sendBeacon(null)),
      detached: attempt(() => navigator.sendBeacon.call(undefined, `${base}/beacon?id=detached`)),
      replacedCalls,
      keys: Object.keys(navigator).includes("sendBeacon"),
      name: navigator.sendBeacon.name,
      length: navigator.sendBeacon.length,
    };
    globalThis.fetch = realFetch;
    return Response.json(sent);
  },
};
