// How global fetch() follows a redirect, against the runner's upstream
// server (`lib/upstream.mjs`), whose `/echo` reports the request it received:
// the final URL and `redirected`; the method and body each redirect status
// keeps or drops; the headers a hop to another origin drops; the redirect
// limit and a loop; a body that can't be sent again; a Location that can't
// be parsed; and a WebSocket upgrade, which follows too.
async function probe(url, init) {
  try {
    const response = await fetch(url, init);
    const echoed = response.headers.get("x-echo");
    const text = await response.text();
    return {
      status: response.status,
      url: response.url,
      redirected: response.redirected,
      body: echoed !== null ? JSON.parse(echoed) : text,
    };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

async function upgrade(url, init) {
  try {
    const response = await fetch(url, { ...init, headers: { upgrade: "websocket" } });
    const socket = response.webSocket;
    if (socket) {
      socket.accept();
      socket.close(1000);
    }
    return {
      status: response.status,
      url: response.url,
      redirected: response.redirected,
      socket: socket != null,
      location: response.headers.get("location"),
    };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

function stream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed"));
      controller.close();
    },
  });
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const origin = `http://127.0.0.1:${params.get("port")}`;
    const other = `http://127.0.0.1:${params.get("other")}`;
    const redirect = (to, status = 302) =>
      `${origin}/redirect?status=${status}&to=${encodeURIComponent(to)}`;
    // Every redirect status, for each method that can change.
    const methods = {};
    for (const status of [301, 302, 303, 307, 308]) {
      for (const method of ["POST", "PUT", "HEAD"]) {
        methods[`${status} ${method}`] = await probe(redirect("/echo", status), {
          method,
          headers: { "content-type": "text/plain" },
          body: method === "HEAD" ? undefined : "payload",
        });
      }
    }
    const credentials = {
      authorization: "Bearer token",
      cookie: "session=1",
      "proxy-authorization": "Basic cHJveHk=",
      "x-custom": "kept",
    };
    return Response.json({
      relative: await probe(redirect("/echo")),
      fragment: await probe(redirect("/echo#fragment")),
      // A request URL with a fragment keeps its byte body replayable.
      fragmentPost307: await probe(redirect("/echo", 307) + "#fragment", {
        method: "POST", headers: { "content-type": "text/plain" }, body: "payload",
      }),
      fragmentPut301: await probe(redirect("/echo", 301) + "#fragment", {
        method: "PUT", headers: { "content-type": "text/plain" }, body: "payload",
      }),
      requestFragment: await probe(`${origin}/echo#fragment`),
      manual: await probe(redirect("/echo"), { redirect: "manual" }),
      methods,
      sameOrigin: await probe(redirect(`${origin}/echo`), { headers: credentials }),
      crossOrigin: await probe(redirect(`${other}/echo`), { headers: credentials }),
      twentyRedirects: await probe(`${origin}/chain?n=19`),
      twentyOneRedirects: await probe(`${origin}/chain?n=20`),
      loop: await probe(`${origin}/loop`),
      stream301: await probe(redirect("/echo", 301), { method: "POST", body: stream() }),
      stream303: await probe(redirect("/echo", 303), { method: "POST", body: stream() }),
      stream307: await probe(redirect("/echo", 307), { method: "POST", body: stream() }),
      invalidLocation: await probe(redirect("http://[bad")),
      upgrade: await upgrade(`${origin}/redirect?to=/ws/close-first?id=follow`),
      upgradeManual: await upgrade(`${origin}/redirect?to=/ws/close-first?id=manual`, { redirect: "manual" }),
    });
  },
};
