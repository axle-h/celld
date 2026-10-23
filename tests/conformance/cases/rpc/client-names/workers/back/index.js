// An entrypoint whose own Object.prototype names must never be reached.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Back extends WorkerEntrypoint {
  toString() {
    return "back toString reached";
  }

  valueOf() {
    return "back valueOf reached";
  }

  hasOwnProperty() {
    return "back hasOwnProperty reached";
  }
}

export default {
  fetch() {
    return new Response("back");
  },
};
