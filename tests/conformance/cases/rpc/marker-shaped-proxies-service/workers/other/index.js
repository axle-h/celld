import { WorkerEntrypoint } from "cloudflare:workers";
import { plainVerdict } from "#marker-shaped";

export default class extends WorkerEntrypoint {
  fetch() {
    return new Response("other");
  }
  probe(arg) {
    return typeof arg.v === "function" ? "stub" : plainVerdict(arg.v);
  }
}
