// workerd serializes an AbortSignal over RPC only under the experimental
// enable_abortsignal_rpc flag; celld always does (found by plan 1.53).
import { WorkerEntrypoint } from "cloudflare:workers";

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return arg.signal instanceof AbortSignal;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return Response.json(await ctx.exports.Echo.probe({ signal: new AbortController().signal }));
    } catch (error) {
      return Response.json(`${error.name}: ${error.message}`);
    }
  },
};
