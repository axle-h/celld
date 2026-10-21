// examples/dynamic-worker-tails, with one change: the tail handler appends
// what it receives to a Durable Object instead of logging it, and GET /tails
// reads that back. Tail events arrive after the response, so /tails waits for
// them.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const WORKER_ID = "hello-v1";
const WORKER_MAIN = "worker.js";
const WORKER_SOURCE = `
  export default {
    fetch() {
      console.log("hello from loaded code");
      return new Response("Hello from a Dynamic Worker!\\n");
    }
  };
`;

export class TailLog extends DurableObject {
  append(records) {
    const log = this.ctx.storage.kv.get("log") ?? [];
    this.ctx.storage.kv.put("log", [...log, ...records]);
  }
  read() {
    return this.ctx.storage.kv.get("log") ?? [];
  }
}

export class DynamicWorkerTail extends WorkerEntrypoint {
  async tail(events) {
    const records = [];
    for (const event of events) {
      for (const log of event.logs) {
        records.push({
          workerId: this.ctx.props.workerId,
          outcome: event.outcome,
          level: log.level,
          message: log.message,
        });
      }
    }
    await this.env.TAIL_LOG.getByName("log").append(records);
  }
}

async function waitForTails(env, count) {
  const log = env.TAIL_LOG.getByName("log");
  for (let attempt = 0; attempt < 100; attempt++) {
    const records = await log.read();
    if (records.length >= count) return records;
    await scheduler.wait(50);
  }
  return log.read();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/tails") {
      return Response.json(await waitForTails(env, Number(url.searchParams.get("count"))));
    }
    const worker = env.LOADER.get(WORKER_ID, () => ({
      compatibilityDate: "2025-01-01",
      mainModule: WORKER_MAIN,
      modules: { [WORKER_MAIN]: WORKER_SOURCE },
      tails: [
        ctx.exports.DynamicWorkerTail({
          props: { workerId: WORKER_ID },
        }),
      ],
    }));
    return worker.getEntrypoint().fetch(request);
  },
};
