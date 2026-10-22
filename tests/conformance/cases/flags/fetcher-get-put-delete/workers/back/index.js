import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async fetch(request) {
    return new Response(`back ${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
  }
  get(arg) {
    return `rpc get ${arg}`;
  }
  put(arg, body) {
    return `rpc put ${arg} ${body}`;
  }
  delete(arg) {
    return `rpc delete ${arg}`;
  }
}
