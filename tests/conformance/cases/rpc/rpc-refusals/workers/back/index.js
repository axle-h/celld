// A class entrypoint and a plain-object entrypoint whose members `front`
// calls only in ways workerd refuses. Each member answers "REACHED".
import { WorkerEntrypoint } from "cloudflare:workers";

const reached = () => "REACHED";

export class Entry extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    this.own = reached;
  }

  alarm() {
    return reached();
  }

  webSocketMessage() {
    return reached();
  }

  webSocketClose() {
    return reached();
  }

  webSocketError() {
    return reached();
  }

  dup() {
    return reached();
  }

  get tools() {
    return { alarm: reached, fetch: reached, connect: reached, dup: reached };
  }
}

export default {
  fetch() {
    return new Response("back");
  },
  alarm: reached,
  webSocketMessage: reached,
  webSocketClose: reached,
  webSocketError: reached,
  dup: reached,
  tools: { alarm: reached, fetch: reached, connect: reached, dup: reached },
};
