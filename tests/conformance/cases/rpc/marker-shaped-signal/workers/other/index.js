import { WorkerEntrypoint } from "cloudflare:workers";
import { compare } from "#marker-shaped";

export default class extends WorkerEntrypoint {
  fetch() {
    return new Response("other");
  }
  probe(arg) {
    return { forged: compare(arg.forged), signal: arg.signal instanceof AbortSignal };
  }
}
