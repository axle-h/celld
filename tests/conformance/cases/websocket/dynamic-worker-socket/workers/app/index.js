// A Dynamic Worker reaching its parent's sockets (plan 1.21). The parent
// holds a socket; the loaded code can only dial, and can neither hand its
// parent a forged socket nor answer with one.
const CHILD = `
  const refused = (attempt) => {
    try {
      attempt();
      return "allowed";
    } catch (error) {
      return error.name;
    }
  };
  export default {
    fetch(request) {
      if (new URL(request.url).pathname === "/child-response") {
        return new Response(null, { status: 101, webSocket: { accept() {} } });
      }
      return Response.json({
        numericId: refused(() => new WebSocket(1)),
        targetInit: refused(() => new Response(null, {
          status: 101,
          __wsTarget: { id: 1, scope: "" },
        })),
        fakeSocket: refused(() => new Response(null, {
          status: 101,
          webSocket: { accept() {} },
        })),
      });
    },
  };
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/socket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => {
        server.send(`parent:${event.data}`);
        server.close(1000, "done");
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    const child = env.LOADER.get("child", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "child.js",
      modules: { "child.js": CHILD },
    }));
    try {
      const response = await child.getEntrypoint().fetch(request);
      return new Response(`${response.status}:${await response.text()}`);
    } catch (error) {
      return new Response("refused");
    }
  },
};
