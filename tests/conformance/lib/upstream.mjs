// A local HTTP server for cases whose Workers fetch "the network": the
// redirecting server of `service-bindings/redirect-outside`, and the private
// address the `fetch-public/*` cases try to reach. It listens on two loopback
// ports, so a case can allow one and show that the other is still refused.

import { createServer } from "node:http";
import { BINARY, CLOSE, TEXT, acceptKey, closePayload, encodeFrame, frameReader, isFragment, readClose } from "./ws-frames.mjs";

/**
 * Starts the server and returns `{ ports: [first, second], close() }`.
 *
 * - `/bounce` answers 302 to `/landed?from=bounce`.
 * - `/landed` answers JSON `{"landed": <the query string>}`.
 * - `/redirect?to=<url>` answers 302 to that URL.
 * - A WebSocket upgrade to `/ws/close-first?id=<id>&code=<code>&reason=<reason>`
 *   is accepted, and the server sends its Close at once: with that code and
 *   reason, or empty (no status) without `code`. It records the text frames
 *   it receives, the Close that answers its own, and the connection's end.
 * - `/ws/log?id=<id>` answers that record as JSON, `{received, reply,
 *   ended}`, once the connection has ended or after 3 s.
 * - Anything else answers `upstream`.
 */
export async function startUpstream() {
  const records = new Map();
  const record = (id) => {
    if (!records.has(id)) {
      let settle;
      const ended = new Promise((resolve) => (settle = resolve));
      records.set(id, { received: [], reply: null, ended: false, whenEnded: ended, settle });
    }
    return records.get(id);
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://upstream");
    switch (url.pathname) {
      case "/ws/log": {
        const entry = record(url.searchParams.get("id") ?? "");
        await Promise.race([entry.whenEnded, new Promise((resolve) => setTimeout(resolve, 3000))]);
        const { received, reply, ended } = entry;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received, reply, ended }));
        return;
      }
      case "/bounce":
        response.writeHead(302, { location: "/landed?from=bounce" }).end("bounce");
        return;
      case "/landed":
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ landed: url.search }));
        return;
      case "/redirect":
        response.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end("redirect");
        return;
      default:
        response.writeHead(200, { "content-type": "text/plain" }).end("upstream");
    }
  });
  // Upgraded connections, which closeAllConnections() does not reach.
  const upgraded = new Set();
  const upgrade = (request, socket) => {
    upgraded.add(socket);
    socket.on("error", () => {});
    const url = new URL(request.url, "http://upstream");
    if (url.pathname !== "/ws/close-first") return socket.destroy();
    const entry = record(url.searchParams.get("id") ?? "");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(request.headers["sec-websocket-key"])}\r\n\r\n`,
    );
    const code = url.searchParams.has("code") ? Number(url.searchParams.get("code")) : undefined;
    socket.write(encodeFrame(CLOSE, closePayload(code, url.searchParams.get("reason") ?? ""), false));
    const reader = frameReader();
    socket.on("data", (chunk) => {
      for (const frame of reader.push(chunk)) {
        // A fragment shows in the record, so a case that meets one fails.
        if (isFragment(frame)) entry.received.push({ fragment: frame.opcode });
        else if (frame.opcode === TEXT) entry.received.push(frame.payload.toString());
        else if (frame.opcode === BINARY) entry.received.push({ binary: frame.payload.toString("base64") });
        else if (frame.opcode === CLOSE && entry.reply === null) {
          entry.reply = readClose(frame.payload);
          // Both Closes are through: the server ends the connection.
          socket.end();
        }
      }
    });
    // The client ending its side ends the connection: the server is done too.
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      upgraded.delete(socket);
      entry.ended = true;
      entry.settle();
    });
  };
  server.on("upgrade", upgrade);
  const second = createServer(server.listeners("request")[0]);
  second.on("upgrade", upgrade);
  const listen = (instance) =>
    new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => resolve(instance.address().port));
    });
  const close = (instance) =>
    new Promise((resolve) => {
      if (!instance.listening) return resolve();
      for (const socket of upgraded) socket.destroy();
      instance.closeAllConnections();
      instance.close(() => resolve());
    });
  try {
    const ports = [await listen(server), await listen(second)];
    return { ports, close: () => Promise.all([close(server), close(second)]) };
  } catch (error) {
    await Promise.all([close(server), close(second)]);
    throw error;
  }
}
