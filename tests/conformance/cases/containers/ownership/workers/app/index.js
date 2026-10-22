// Container ownership (plan 1.27). Each object's container answers its own
// name. A Container and a port object are I/O objects of the object that
// made them, as in workerd: used during another object's event ("b", which
// runs a container of its own, or "c", which runs none) they throw workerd's
// cross-object I/O error and reach no container. Object "a" still reaches
// its container from a response body, a waitUntil continuation and an alarm,
// which are its own events.
import { DurableObject } from "cloudflare:workers";

const leaked = {};

const attempt = async (use) => {
  try {
    return await use();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

// The container's answer on port 8080, once it listens.
const answer = async (port) => {
  for (let tries = 0; ; tries++) {
    try {
      return await (await port.fetch("http://container/")).text();
    } catch (error) {
      if (tries >= 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

// Storage key `key` once something of this object writes it.
const awaitKey = async (storage, key) => {
  for (let tries = 0; tries < 100; tries++) {
    const value = await storage.get(key);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "timed out";
};

export class Box extends DurableObject {
  async fetch(request) {
    const [, name, action] = new URL(request.url).pathname.split("/");
    const container = this.ctx.container;
    switch (action) {
      case "start":
        container.start({ env: { NAME: name } });
        return new Response(await answer(container.getTcpPort(8080)));
      case "leak":
        leaked.container = container;
        leaked.port = container.getTcpPort(8080);
        return new Response("leaked");
      case "use":
        return Response.json({
          running: await attempt(() => leaked.container.running),
          port: await attempt(() => leaked.port.fetch("http://container/").then((r) => r.text())),
          exec: await attempt(async () => {
            const process = await leaked.container.exec(["sh", "-c", "printf %s \"$NAME\""]);
            return (await process.output()).exitCode;
          }),
        });
      case "exec": {
        // The body is read after the handler answers.
        const process = await container.exec(["sh", "-c", "printf %s \"$NAME\""]);
        return new Response(process.stdout);
      }
      case "later":
        this.ctx.waitUntil((async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await this.ctx.storage.put("later", await answer(container.getTcpPort(8080)));
        })());
        return new Response(await awaitKey(this.ctx.storage, "later"));
      case "alarm":
        await this.ctx.storage.setAlarm(Date.now());
        return new Response(await awaitKey(this.ctx.storage, "alarm"));
      case "stop":
        await container.destroy();
        return Response.json({ running: container.running });
    }
    return new Response("unknown", { status: 404 });
  }

  async alarm() {
    await this.ctx.storage.put("alarm", await answer(this.ctx.container.getTcpPort(8080)));
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).pathname.split("/")[1];
    return env.BOX.getByName(name).fetch(request);
  },
};
