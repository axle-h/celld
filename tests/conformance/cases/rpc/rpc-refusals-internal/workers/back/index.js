// A class entrypoint and a plain-object entrypoint, asked through celld's
// test hook for names a stub would answer locally. Each member it defines
// answers "REACHED".
import { WorkerEntrypoint } from "cloudflare:workers";

const reached = () => "REACHED";

export class Entry extends WorkerEntrypoint {
  fetch() {
    return new Response("REACHED");
  }

  connect() {
    return reached();
  }

  toString() {
    return reached();
  }

  valueOf() {
    return reached();
  }
}

export default {
  fetch() {
    return new Response("back");
  },
  connect: reached,
  constructor: reached,
};
