// The target's `scheduled` and `queue` are handlers, and so also RPC methods.
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  fetch() {
    return new Response("back");
  }
  scheduled(controller) {
    return { called: "scheduled", controller };
  }
  queue(name, messages) {
    return { called: "queue", name, messages };
  }
}
