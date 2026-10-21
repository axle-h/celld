// Both entrypoints send the request they received to the network as it is.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Named extends WorkerEntrypoint {
  fetch(request) {
    return fetch(request);
  }
}

export default {
  fetch(request) {
    return fetch(request);
  },
};
