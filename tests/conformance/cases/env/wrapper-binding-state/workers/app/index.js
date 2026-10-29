// workerd builds the D1 and Workflow bindings as JavaScript wrappers around
// a service binding: their fields are public own properties (`fetcher`,
// `binding`) and their constructors take any argument. celld's keep the
// database and the workflow name private and refuse construction, because
// they name a cell rather than hold a binding (plan 1.49; difference 1.55).
import { WorkflowEntrypoint } from "cloudflare:workers";

export class Flow extends WorkflowEntrypoint {
  async run() {
    return "done";
  }
}

function shape(value) {
  let construct;
  try {
    new value.constructor();
    construct = "constructed";
  } catch (error) {
    construct = `${error.name}: ${error.message}`;
  }
  return { own: Reflect.ownKeys(value).map(String), construct };
}

export default {
  async fetch(request, env) {
    return Response.json({
      database: shape(env.DB),
      statement: shape(env.DB.prepare("SELECT 1")),
      session: shape(env.DB.withSession()),
      workflow: shape(env.FLOW),
      instance: shape(await env.FLOW.create({ id: "wrapper" })),
    });
  },
};
