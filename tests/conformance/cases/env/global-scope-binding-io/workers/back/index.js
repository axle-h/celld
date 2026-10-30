// Counts the calls that reach it, by fetch() and by RPC, so the front can show
// that none it made at module scope ever arrived.
import { WorkerEntrypoint } from "cloudflare:workers";

let fetches = 0;
let calls = 0;

export default class extends WorkerEntrypoint {
  fetch(request) {
    if (new URL(request.url).pathname === "/hit") fetches++;
    return Response.json({ fetches, calls });
  }

  hit() {
    calls++;
    return calls;
  }
}
