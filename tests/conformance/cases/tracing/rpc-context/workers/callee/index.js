// A named entrypoint whose method records a span of its own.
import { WorkerEntrypoint, tracing } from "cloudflare:workers";

export class Work extends WorkerEntrypoint {
  work() {
    return tracing.enterSpan("in-service", (span) => {
      span.setAttribute("side", "service");
      return "worked";
    });
  }
}

export default {
  fetch() {
    return new Response("callee");
  },
};
