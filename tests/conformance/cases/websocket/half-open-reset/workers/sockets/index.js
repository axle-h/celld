// A client sends its Close to a half-open socket (before 2026-04-07 nothing
// replies automatically), shuts down its side, stops reading, and later
// resets the connection. Meanwhile the object sends after the client's
// Close: nothing (`/`) or 48 MiB (`/?big=1`), more than the kernel buffers, so a write
// is under way when the client resets.
// The node must let the connection go once the client resets it (plan 1.22).
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  seen = [];

  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/seen") return Response.json(this.seen);
    const big = url.searchParams.get("big") === "1";
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("close", (event) => {
      this.seen.push(["close", event.code, big]);
      if (big) {
        setTimeout(() => {
          const message = "x".repeat(1 << 20);
          for (let sent = 0; sent < 48; sent++) server.send(message);
          this.seen.push(["sent late"]);
        }, 300);
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    return env.SOCKETS.getByName("sockets").fetch(request);
  },
};
