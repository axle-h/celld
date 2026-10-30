import { WorkerEntrypoint } from "cloudflare:workers";

export class Entry extends WorkerEntrypoint {
  getRpcMethodForTestOnly(name) {
    return `Entry: ${name}`;
  }
}

export default {
  fetch() {
    return new Response("back");
  },
  getRpcMethodForTestOnly(name) {
    return `default: ${name}`;
  },
};
