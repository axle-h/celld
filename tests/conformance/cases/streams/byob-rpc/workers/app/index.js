import { WorkerEntrypoint } from "cloudflare:workers";
import { checkAll, parts, payload } from "#byob";

export class Source extends WorkerEntrypoint {
  // A default stream of the payload in parts.
  parts() { return parts(); }
  // A Blob's stream, so a platform stream on the sending side.
  blob() { return new Blob([payload()]).stream(); }
}

export default {
  async fetch(request, env, ctx) {
    return Response.json({
      parts: await checkAll(() => ctx.exports.Source.parts()),
      blob: await checkAll(() => ctx.exports.Source.blob()),
    });
  },
};
