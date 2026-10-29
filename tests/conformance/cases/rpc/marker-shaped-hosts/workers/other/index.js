import { WorkerEntrypoint } from "cloudflare:workers";
import { hostVerdict, plainVerdict } from "#marker-shaped";

export default class extends WorkerEntrypoint {
  fetch() {
    return new Response("other");
  }
  probe(arg) {
    return hostVerdict(arg.v);
  }
  probePlain(arg) {
    return plainVerdict(arg.v);
  }
}
