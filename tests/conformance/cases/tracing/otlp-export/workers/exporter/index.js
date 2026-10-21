// What celld exports for custom spans: names, attributes, status and
// exceptions; parents, including the invocation span and the spans of work
// done inside a custom span; log lines attributed to the span that wrote
// them; and the spans a Worker never ends.
import { DurableObject, tracing } from "cloudflare:workers";

export class Exported extends DurableObject {
  async call() {
    return tracing.enterSpan("in-object", (span) => {
      span.setAttribute("side", "object");
      return "called";
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/spans": {
        const invocation = tracing.getActiveSpan();
        invocation.setAttribute("route", "spans");
        invocation.updateName("spans-request");
        console.log("outside any span");
        await tracing.enterSpan("outer", async (outer) => {
          outer.setAttributes({ text: "a", number: 1.5, flag: true, skipped: undefined });
          console.log("in outer");
          await new Promise((resolve) => setTimeout(resolve, 1));
          tracing.enterSpan("inner", (inner) => {
            inner.setAttribute("depth", 2);
            console.log("in inner");
          });
          console.log("in outer again");
        });
        const detached = tracing.startSpan("detached");
        detached.updateName("detached-renamed");
        detached.setStatus({ code: "error", message: "it failed" });
        detached.recordException(new TypeError("boom"));
        detached.recordException({ code: 42, message: "with a code" });
        detached.end();
        tracing.startSpan("n".repeat(100)).end();
        tracing.startSpan("forgotten").setAttribute("ended", false);
        void tracing.enterSpan("never-settles", () => new Promise(() => {}));
        tracing.enterSpan("limited", (span) => {
          span.setAttribute("big", "x".repeat(64 * 1024));
          span.setAttribute("small", "kept");
        });
        tracing.enterSpan("ok", (span) => span.setStatus({ code: "ok" }));
        // celld's own keys are reserved; others, a semantic-convention key
        // included, are the Worker's.
        tracing.enterSpan("reserved", (span) => span.setAttributes({ "celld.cell": "spoofed", "url.full": "chosen" }));
        return new Response("spans");
      }
      case "/fetch":
        return tracing.enterSpan("around-fetch", async () => {
          const response = await fetch(new URL("/leaf", url));
          return new Response(`fetched ${await response.text()}`);
        });
      case "/leaf":
        return new Response("leaf");
      case "/object":
        return tracing.enterSpan("around-call", async () =>
          new Response(await env.OBJECT.getByName("exported").call()),
        );
      case "/after-response":
        ctx.waitUntil(
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            tracing.enterSpan("after-response", (span) => span.setAttribute("late", true));
          })(),
        );
        return new Response("answered");
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
