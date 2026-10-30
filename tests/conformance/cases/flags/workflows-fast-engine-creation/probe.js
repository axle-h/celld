// The id Workflow create() and createBatch() give an instance created without
// one: with workflows_enable_fast_engine_creation, Cloudflare's engine names
// it with its Durable Object namespace's newUniqueId(), 64 hex digits;
// otherwise with a random UUID.
import { WorkflowEntrypoint } from "cloudflare:workers";

export class Flow extends WorkflowEntrypoint {
  async run() {
    return "done";
  }
}

const shape = (id) => /^[0-9a-f]{64}$/.test(id) ? "unique id"
  : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? "uuid"
  : `other: ${id}`;

export default {
  async fetch(request, env) {
    const created = await env.FLOW.create();
    const batch = await env.FLOW.createBatch([{}, { params: 1 }]);
    const again = await env.FLOW.get(created.id);
    return Response.json({
      created: shape(created.id),
      batch: batch.map((instance) => shape(instance.id)),
      distinct: new Set([created.id, ...batch.map((instance) => instance.id)]).size,
      found: again.id === created.id,
      named: shape((await env.FLOW.create({ id: "named" })).id),
      reported: Cloudflare.compatibilityFlags.workflows_enable_fast_engine_creation ?? null,
    });
  },
};
