import { WorkerEntrypoint } from "cloudflare:workers";
import { parts } from "#byob";

export class Source extends WorkerEntrypoint {
  parts() { return parts(); }
}

export default {
  fetch() { return new Response("not found", { status: 404 }); },
};
