import { WorkerEntrypoint } from "cloudflare:workers";
import { compare, forged } from "#marker-shaped";

export default class extends WorkerEntrypoint {
  fetch() {
    return new Response("other");
  }
  probe(arg) {
    return compare(arg.forged);
  }
  give() {
    return { forged: forged() };
  }
}
