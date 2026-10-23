import { DurableObject } from "cloudflare:workers";

export class Keeper extends DurableObject {
  kept = null;
  async fetch(request) {
    if (new URL(request.url).pathname === "/send") {
      this.kept = request.body;
      return new Response("kept");
    }
    try {
      const { done, value } = await this.kept.getReader().read();
      return new Response(`read: ${done} ${value?.byteLength}`);
    } catch (error) {
      return new Response(`${error.name}: ${error.message}`);
    }
  }
}

export default {
  fetch(request, env) {
    return env.OBJ.getByName("keeper").fetch(request);
  },
};
