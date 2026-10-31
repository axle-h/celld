// A named entrypoint whose method and fetch handler record a span of their
// own.
import { WorkerEntrypoint, tracing } from "cloudflare:workers";

export class Work extends WorkerEntrypoint {
  work() {
    return tracing.enterSpan("in-service", (span) => {
      span.setAttribute("side", "service");
      return "worked";
    });
  }

  fetch() {
    return tracing.enterSpan("in-service-fetch", (span) => new Response(String(span.isTraced)));
  }
}

export default {
  fetch() {
    return new Response("callee");
  },
};
