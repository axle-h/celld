import { WorkerEntrypoint } from "cloudflare:workers";
import { plainVerdict } from "#marker-shaped";

export default class extends WorkerEntrypoint {
  fetch() {
    return new Response("other");
  }
  probe(arg) {
    return plainVerdict(arg.v);
  }
}
