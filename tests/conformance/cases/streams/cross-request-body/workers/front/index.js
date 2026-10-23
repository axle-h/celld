// The uses of a stashed body, each on a body of its own. A use that throws
// and one that rejects are told apart.
const USES = `{
  read: (body) => body.getReader().read(),
  closed: (body) => Promise.race([
    body.getReader().closed,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("still waiting")), 300)),
  ]),
  // A refused read leaves the stream errored with the refusal.
  closedAfterRead: async (body) => {
    const reader = body.getReader();
    await reader.read().catch(() => {});
    return reader.closed;
  },
  readByob: (body) => body.getReader({ mode: "byob" }).read(new Uint8Array(8)),
  cancel: (body) => body.cancel("stop"),
  tee: (body) => body.tee(),
  text: (body) => new Response(body).text(),
  sendOn: (body, env) => env.BACK.fetch("http://back/", { method: "POST", body }),
  pipeTo: (body) => body.pipeTo(new WritableStream()),
  iterate: (body) => body[Symbol.asyncIterator]().next(),
}`;

const ATTEMPT = `async (use, body, env) => {
  let result;
  try {
    result = use(body, env);
  } catch (error) {
    return \`threw \${error.name}: \${error.message}\`;
  }
  try {
    await result;
    return "accepted";
  } catch (error) {
    return \`rejected \${error.name}: \${error.message}\`;
  }
}`;

// The loaded Worker stashes a body it fetched through the binding it was
// given, and one it answers with that its parent stashes.
const CHILD = `
  const USES = ${USES};
  const attempt = ${ATTEMPT};
  const stash = {};
  export default {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === "/stash") {
        for (const name of Object.keys(USES))
          stash[name] = (await env.BACK.fetch("http://back/stalled")).body;
        return new Response("stashed");
      }
      if (path === "/use") {
        const out = {};
        for (const [name, use] of Object.entries(USES))
          out[name] = await attempt(use, stash[name], env);
        return Response.json(out);
      }
      return (await env.BACK.fetch("http://back/stalled"));
    },
  };
`;

const USE = new Function(`return ${USES};`)();
const attempt = new Function(`return ${ATTEMPT};`)();

const stash = { fetched: {}, child: {} };

const child = (env) => env.LOADER.get("child", () => ({
  compatibilityDate: "2026-01-01",
  mainModule: "child.js",
  modules: { "child.js": CHILD },
  env: { BACK: env.BACK },
}));

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/stash") {
      for (const name of Object.keys(USE)) {
        stash.fetched[name] = (await env.BACK.fetch("http://back/stalled")).body;
        stash.child[name] = (await child(env).getEntrypoint().fetch("http://child/body")).body;
      }
      return new Response("stashed");
    }
    if (path === "/use") {
      const out = {};
      for (const source of ["fetched", "child"]) {
        out[source] = {};
        for (const [name, use] of Object.entries(USE))
          out[source][name] = await attempt(use, stash[source][name], env);
      }
      return Response.json(out);
    }
    if (path === "/child/stash" || path === "/child/use") {
      const response = await child(env).getEntrypoint()
        .fetch(`http://child${path.slice("/child".length)}`);
      return new Response(await response.text(), {
        headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};
