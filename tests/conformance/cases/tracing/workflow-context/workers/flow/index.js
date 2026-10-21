// A workflow's run() executes in an ExecutionContext, whose `tracing` is a
// data property, as on any other ExecutionContext.
import { WorkflowEntrypoint } from "cloudflare:workers";

export class Flow extends WorkflowEntrypoint {
  async run() {
    const descriptor = Object.getOwnPropertyDescriptor(this.ctx, "tracing");
    return {
      type: typeof this.ctx.tracing,
      descriptor: descriptor === undefined ? "absent" : Object.keys(descriptor),
      span: this.ctx.tracing.enterSpan("in-workflow", (span) => span.isTraced),
    };
  }
}

export default {
  async fetch(request, env) {
    const instance = await env.FLOW.create();
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await instance.status();
      if (status.status === "complete") return Response.json(status.output);
      if (status.status === "errored") return Response.json({ error: status.error });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return new Response("the workflow did not finish", { status: 500 });
  },
};
