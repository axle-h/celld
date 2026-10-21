// `ctx.exports.Echo({props})` handed to a Dynamic Worker leaves this isolate,
// as its `globalOutbound` or inside its `env`, so its props ride on a host job
// for every call and are bounded at 1 MiB encoded. A call that stays in this
// isolate carries no host copy and is not bounded.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Echo extends WorkerEntrypoint {
  fetch() {
    return new Response(String(this.ctx.props.s.length));
  }
  length() {
    return this.ctx.props.s.length;
  }
}

const CHILD = `
  export default {
    async fetch(request, env) {
      const response = env.ECHO ? await env.ECHO.fetch("http://echo.test/") : await fetch("http://echo.test/");
      return new Response(await response.text());
    },
  };
`;

async function run(load) {
  try {
    const response = await load().getEntrypoint().fetch("http://child.test/");
    return { ok: true, length: Number(await response.text()) };
  } catch (error) {
    return { ok: false, error: `${error.name}: ${error.message}` };
  }
}

let next = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const size = Number(url.searchParams.get("size"));
    const echo = ctx.exports.Echo({ props: { s: "a".repeat(size) } });
    const code = (extra) => ({ compatibilityDate: "2026-01-01", mainModule: "child.js", modules: { "child.js": CHILD }, ...extra });
    switch (url.pathname) {
      case "/outbound":
        return Response.json(await run(() => env.LOADER.load(code({ globalOutbound: echo }))));
      case "/env":
        return Response.json(await run(() => env.LOADER.get(`env-${next++}`, () => code({ env: { ECHO: echo } }))));
      case "/local":
        return Response.json({ fetch: Number(await (await echo.fetch("http://echo.test/")).text()), rpc: await echo.length() });
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
