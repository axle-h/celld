// A container port is a Fetcher, so a redirect it answers goes back to the
// same port, whatever host the Location names: an absolute Location to
// elsewhere.test:9999 reaches the container again, with that Host, and never
// the network.
import { DurableObject } from "cloudflare:workers";

// The port's answer once the container listens.
const ready = async (port) => {
  for (let tries = 0; ; tries++) {
    try {
      return await port.fetch("http://container/ready");
    } catch (error) {
      if (tries >= 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

const summary = async (response) => ({
  status: response.status,
  url: response.url,
  redirected: response.redirected,
  location: response.headers.get("location"),
  body: await response.text(),
});

export class Box extends DurableObject {
  async fetch() {
    const container = this.ctx.container;
    container.start();
    const port = container.getTcpPort(8080);
    await (await ready(port)).text();
    const result = {
      follow: await summary(await port.fetch("http://container/redirect")),
      manual: await summary(await port.fetch("http://container/redirect", { redirect: "manual" })),
    };
    await container.destroy();
    return Response.json(result);
  }
}

export default {
  fetch(request, env) {
    return env.BOX.getByName("a").fetch(request);
  },
};
