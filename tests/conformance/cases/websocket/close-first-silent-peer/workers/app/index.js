// A socket that closes first waits for its peer's reply, and a peer that
// never answers holds the connection only so long (plan 1.22). A stateless
// Worker (`/dial`) or a Durable Object (`/object-dial`) dials a server that
// never sends anything, closes, and returns. The stateless socket ends with
// its request, well within 3 s, so its owner's going ends it, not the bound;
// the object's waits at most 10 s.
import { DurableObject } from "cloudflare:workers";

async function dialAndClose(target) {
  const socket = new WebSocket(target);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  socket.close(1000, "bye");
  return new Response(`closed, readyState ${socket.readyState}`);
}

export class Dialer extends DurableObject {
  fetch(request) {
    return dialAndClose(new URL(request.url).searchParams.get("t"));
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/warm":
        return new Response("warm");
      case "/dial":
        return dialAndClose(url.searchParams.get("t"));
      case "/object-dial":
        return env.DIALER.getByName("dialer").fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
