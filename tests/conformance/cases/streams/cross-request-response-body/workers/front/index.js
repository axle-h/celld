const CHILD = `
  export default {
    fetch(request, env) { return env.BACK.fetch("http://back/stalled"); },
  };
`;

const stash = {};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/stash") {
      stash.fetched = (await env.BACK.fetch("http://back/stalled")).body;
      const child = env.LOADER.get("child", () => ({
        compatibilityDate: "2026-01-01",
        mainModule: "child.js",
        modules: { "child.js": CHILD },
        env: { BACK: env.BACK },
      }));
      stash.child = (await child.getEntrypoint().fetch("http://child/")).body;
      return new Response("stashed");
    }
    return new Response(stash[path.slice("/respond/".length)]);
  },
};
