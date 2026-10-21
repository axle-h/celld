// A span belongs to the request that made it: from another request, each
// method converts its arguments and then throws workerd's I/O error. A span
// made at module scope belongs to no request.
import { tracing } from "cloudflare:workers";

function attempt(use) {
  try {
    const value = use();
    return value === undefined ? "undefined" : value;
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
}

const moduleSpan = tracing.startSpan("module");
let first;

function useFrom(span) {
  return {
    isTraced: attempt(() => span.isTraced),
    setAttribute: attempt(() => span.setAttribute("k", 1) === span),
    unsetAttribute: attempt(() => span.setAttribute("k") === span),
    badAttribute: attempt(() => span.setAttribute("k", 1n)),
    setAttributes: attempt(() => span.setAttributes({ k: 1 }) === span),
    noAttributes: attempt(() => span.setAttributes({}) === span),
    updateName: attempt(() => span.updateName("x") === span),
    setStatus: attempt(() => span.setStatus({ code: "ok" }) === span),
    badStatus: attempt(() => span.setStatus({ code: "bad" })),
    recordException: attempt(() => span.recordException("x")),
    end: attempt(() => span.end()),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/first") {
      const ended = tracing.startSpan("ended");
      ended.end();
      let entered;
      tracing.enterSpan("entered", (span) => {
        entered = span;
      });
      first = {
        open: tracing.startSpan("open"),
        ended,
        entered,
        invocation: tracing.getActiveSpan(),
        viaContext: ctx.tracing.startSpan("via-context"),
      };
      return Response.json({ sameRequest: useFrom(first.open) });
    }
    const out = { module: useFrom(moduleSpan) };
    for (const [name, span] of Object.entries(first)) out[name] = useFrom(span);
    out.freshInvocation = tracing.getActiveSpan() !== first.invocation;
    return Response.json(out);
  },
};
