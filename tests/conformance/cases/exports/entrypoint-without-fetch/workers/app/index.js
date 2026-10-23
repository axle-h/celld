import { WorkerEntrypoint } from "cloudflare:workers";

export class Source extends WorkerEntrypoint {
  hello() { return "hello"; }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await ctx.exports.Source.fetch("http://source/");
      return new Response(`${response.status}`);
    } catch (error) {
      return new Response(`${error.name}: ${error.message}`);
    }
  },
};
