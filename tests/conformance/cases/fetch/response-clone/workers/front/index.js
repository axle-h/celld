import { DurableObject } from "cloudflare:workers";
import { runBackpressureChecks, runResponseChecks } from "#clone";
import { answer } from "../back/answer.js";

const encoder = new TextEncoder();

const userStream = () => {
  const parts = ["one,", "two,", "three"];
  return new ReadableStream({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
  });
};

export class Store extends DurableObject {
  fetch(request) {
    return answer(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = () => env.STORE.get(env.STORE.idFromName("clone"));
    if (url.pathname === "/responses") {
      await env.BUCKET.put("object", "an R2 object");
      return Response.json(await runResponseChecks({
        constructedString: () =>
          new Response("a string", {
            status: 202,
            statusText: "Took",
            headers: { "x-from": "front", "content-type": "text/plain;charset=UTF-8" },
          }),
        constructedStream: () => new Response(userStream(), { statusText: "OK", headers: { "x-from": "front" } }),
        constructedNull: () => new Response(null, { status: 204, statusText: "No Content" }),
        responseJson: () => Response.json({ a: 1 }, { statusText: "OK" }),
        responseError: () => Response.error(),
        r2Body: async () => new Response((await env.BUCKET.get("object")).body, { statusText: "OK" }),
        serviceBinding: () => env.BACK.fetch("http://back/body"),
        serviceBindingOk: () => env.BACK.fetch("http://back/ok"),
        serviceBindingBytes: () => env.BACK.fetch("http://back/bytes"),
        serviceBindingRedirected: () => env.BACK.fetch("http://back/redirect#frag"),
        serviceBindingManual: () => env.BACK.fetch("http://back/redirect", { redirect: "manual" }),
        durableObject: () => store().fetch("http://store/body"),
        durableObjectRedirected: () => store().fetch("http://store/redirect"),
      }));
    }
    if (url.pathname === "/backpressure") {
      // 64 chunks of 64 KiB: 4 MiB.
      return Response.json(await runBackpressureChecks({
        constructedStream: () => {
          let n = 64;
          const chunk = new Uint8Array(64 * 1024).fill(120);
          return new Response(new ReadableStream({
            pull(controller) {
              if (n-- === 0) controller.close();
              else controller.enqueue(chunk.slice());
            },
          }));
        },
        serviceBinding: () => env.BACK.fetch("http://back/big?n=64"),
        durableObject: () => store().fetch("http://store/big?n=64"),
      }));
    }
    if (url.pathname === "/other") {
      const out = {};
      // Response.redirect()'s headers are immutable, and so are its clone's.
      try {
        Response.redirect("https://example.com/next", 307).clone().headers.set("x-clone", "1");
        out.redirectHeaders = "set";
      } catch (error) {
        out.redirectHeaders = `${error.name}: ${error.message}`;
      }
      for (const [source, make] of Object.entries({
        constructed: () => {
          const [client, server] = Object.values(new WebSocketPair());
          server.accept();
          return new Response(null, { status: 101, webSocket: client });
        },
        serviceBinding: () => env.BACK.fetch("http://back/ws", { headers: { upgrade: "websocket" } }),
      })) {
        const response = await make();
        try {
          response.clone();
          out[source] = "cloned";
        } catch (error) {
          out[source] = `${error.name}: ${error.message}`;
        }
        response.webSocket.accept();
        response.webSocket.close(1000, "done");
      }
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  },
};
