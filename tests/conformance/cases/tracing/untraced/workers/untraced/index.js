// The `tracing` API with tracing off (no CELLD_OTEL; workerd without local
// observability), as for an unsampled request on Cloudflare: every span is
// untraced, and the API otherwise behaves as when traced.
import { DurableObject, tracing } from "cloudflare:workers";

function attempt(use) {
  try {
    const value = use();
    return value === undefined ? "undefined" : value;
  } catch (error) {
    return `${error?.name}: ${error?.message}`;
  }
}

export class Untraced extends DurableObject {
  run() {
    const invocation = tracing.getActiveSpan();
    return {
      invocation: typeof invocation,
      isTraced: invocation.isTraced,
      inSpan: tracing.enterSpan("in-object", (span) => span.isTraced),
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/durable-object") {
      return Response.json(await env.OBJECT.getByName("untraced").run());
    }
    const invocation = tracing.getActiveSpan();
    let entered;
    const value = await tracing.enterSpan("untraced", async (span) => {
      entered = span;
      return [span.isTraced, tracing.getActiveSpan() === span];
    });
    const manual = tracing.startActiveSpan("manual", (span) => span);
    const detached = tracing.startSpan("detached");
    return Response.json({
      invocation: {
        type: typeof invocation,
        isTraced: invocation.isTraced,
        stable: invocation === tracing.getActiveSpan() && invocation === ctx.tracing.getActiveSpan(),
        chained: invocation.setAttribute("k", 1) === invocation && invocation.setStatus({ code: "ok" }) === invocation,
      },
      enterSpan: { value, afterwards: entered.isTraced },
      startActiveSpan: [manual.isTraced, (manual.end(), manual.isTraced)],
      startSpan: detached.isTraced,
      // An untraced span still converts what it is given...
      bigintAttribute: attempt(() => detached.setAttribute("k", 1n)),
      badStatus: attempt(() => detached.setStatus({ code: "bad" })),
      // ...except an exception, which workerd reads only for a traced span.
      bigintExceptionCode: attempt(() => String(detached.recordException({ code: 1n }))),
      missingException: attempt(() => detached.recordException()),
    });
  },
};
