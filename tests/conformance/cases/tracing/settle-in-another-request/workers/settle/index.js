// An enterSpan callback awaits a promise that another request resolves, so
// the span's promise settles in that request's turn. The request still
// completes, as the same code without enterSpan does.
import { tracing } from "cloudflare:workers";

let release;
let isolateTag;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/run": {
        // Each request waits on the other, so a hang is reported, not waited out.
        const span = url.searchParams.get("span");
        const waiting = fetch(new URL(`/wait?span=${span}`, url)).then((response) => response.text());
        await new Promise((resolve) => setTimeout(resolve, 50));
        const releasing = fetch(new URL("/release", url)).then((response) => response.text());
        const timeout = new Promise((resolve) => setTimeout(() => resolve("hung"), 10_000));
        return Response.json({
          wait: await Promise.race([waiting, timeout]),
          release: await Promise.race([releasing, timeout]),
        });
      }
      case "/wait": {
        isolateTag = url.searchParams.get("span");
        const shared = new Promise((resolve) => {
          release = resolve;
        });
        const value =
          url.searchParams.get("span") === "1"
            ? await tracing.enterSpan("waits", async () => `in span: ${await shared}`)
            : await shared;
        return new Response(value);
      }
      case "/release":
        // The same isolate must serve both, or nothing would be shared.
        if (release === undefined) return new Response(`no waiter (${isolateTag})`);
        release("released");
        release = undefined;
        return new Response("released");
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
