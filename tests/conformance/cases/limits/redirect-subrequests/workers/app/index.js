// Every hop of a followed redirect is a subrequest, for fetch() and for a
// WebSocket upgrade through fetch(), and so is a `new WebSocket()` dial. A
// loaded Worker with a limit of 3 subrequests can follow /chain?n=1 (three
// requests) but not /chain?n=2 (four), however the redirects are made.
const CODE = `
  const attempt = async (use) => {
    try {
      return await use();
    } catch (error) {
      return error.name + ": " + error.message;
    }
  };
  export default {
    async fetch(request) {
      const url = new URL(request.url);
      const origin = "http://127.0.0.1:" + url.searchParams.get("port");
      const upgrade = { headers: { upgrade: "websocket" } };
      const opened = (response) => {
        response.webSocket?.accept();
        response.webSocket?.close(1000);
        return response.status;
      };
      switch (url.pathname) {
        case "/fetch-within":
          return Response.json(await attempt(async () => (await fetch(origin + "/chain?n=1")).status));
        case "/fetch-beyond":
          return Response.json(await attempt(async () => (await fetch(origin + "/chain?n=2")).status));
        case "/upgrade-within":
          return Response.json(await attempt(async () => opened(await fetch(origin + "/chain?n=1", upgrade))));
        case "/upgrade-beyond":
          return Response.json(await attempt(async () => opened(await fetch(origin + "/chain?n=2", upgrade))));
        case "/websocket-after":
          await fetch(origin + "/chain?n=1");
          return Response.json(await attempt(async () => {
            new WebSocket("ws://127.0.0.1:" + url.searchParams.get("port") + "/ws/close-first?id=after");
            return "dialled";
          }));
      }
    },
  };
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const worker = env.LOADER.get("redirect-subrequests-v1", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "app.js",
      modules: { "app.js": CODE },
    }));
    const entrypoint = worker.getEntrypoint(null, { limits: { subRequests: 3 } });
    return entrypoint.fetch(`http://loaded.test${url.pathname}${url.search}`);
  },
};
