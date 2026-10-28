// The owner of the namespaces `front` must not reach. `/dlq` checks a path
// that only the Queue cell takes: a message whose consumer fails moves to
// the dead-letter queue, which no binding of this script produces to.
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

export class Vault extends DurableObject {
  read() {
    return "vault";
  }

  fetch() {
    return new Response("vault");
  }
}

export class Flow extends WorkflowEntrypoint {
  async run() {
    return "flow";
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/back/dlq") {
      return new Response("not found", { status: 404 });
    }
    await env.JOBS.send("dead");
    for (let attempt = 0; attempt < 200; attempt++) {
      const moved = await env.KV.get("dlq");
      if (moved !== null) return Response.json({ deadLettered: moved });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return new Response("the message never reached the dead-letter queue", { status: 500 });
  },

  async queue(batch, env) {
    if (batch.queue === "back-jobs") throw new Error("always fails");
    for (const message of batch.messages) await env.KV.put("dlq", String(message.body));
  },
};
