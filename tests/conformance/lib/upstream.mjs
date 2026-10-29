// A local HTTP server for cases whose Workers fetch "the network": the
// redirecting server of `service-bindings/redirect-outside` and
// `fetch/redirect-follow`, and the private address the `fetch-public/*` cases
// try to reach. It listens on two loopback ports, so a case can allow one and
// show that the other is still refused, and a third port is a TCP echo server
// for `connect()` from `cloudflare:sockets`.

import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { BINARY, CLOSE, TEXT, acceptKey, closePayload, encodeFrame, frameReader, isFragment, readClose } from "./ws-frames.mjs";

/**
 * Starts the servers and returns `{ ports: [first, second, echo], close() }`.
 * `echo` is a TCP server that writes back every byte it reads and ends its
 * side when the client ends its own.
 *
 * - `/bounce` answers 302 to `/landed?from=bounce`.
 * - `/landed` answers JSON `{"landed": <the query string>}`.
 * - `/redirect?to=<url>&status=<code>` answers that status, 302 by default,
 *   with that URL as its Location.
 * - `/chain?n=<n>` answers 302 to `/chain?n=<n - 1>`, and `/landed?n=0`
 *   when `n` reaches 0. `/loop` answers 302 to itself.
 * - `/big?kib=<n>` answers `n` KiB of `x`, written 16 KiB at a time.
 * - `/echo` answers JSON describing the request it received: its method,
 *   path, body, and the headers in `ECHOED`. A `HEAD` response has no body,
 *   so the same JSON is also the `x-echo` header.
 * - A WebSocket upgrade to `/redirect?to=<url>` answers 302 to that URL, and
 *   one to `/chain?n=<n>` redirects `n` times and lands on
 *   `/ws/close-first?id=chain`.
 * - A WebSocket upgrade to `/ws/close-first?id=<id>&code=<code>&reason=<reason>`
 *   is accepted, and the server sends its Close at once: with that code and
 *   reason, or empty (no status) without `code`. It records the text frames
 *   it receives, the Close that answers its own, and the connection's end.
 * - `/ws/log?id=<id>` answers that record as JSON, `{received, reply,
 *   ended}`, once the connection has ended or after 3 s.
 * - A WebSocket upgrade to `/ws/silent` is accepted, and the server never
 *   sends anything, a reply to a Close included. One to `/ws/stall` is
 *   accepted, and the server never reads either.
 * - Anything else answers `upstream`.
 */
// The request headers `/echo` reports, `null` when absent. The rest depend on
// the HTTP client, which differs between runtimes.
const ECHOED = [
  "host", "authorization", "cookie", "proxy-authorization", "x-custom",
  "content-type", "content-length", "transfer-encoding",
];

async function echo(request, url, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const report = JSON.stringify({
    method: request.method,
    path: url.pathname + url.search,
    headers: Object.fromEntries(ECHOED.map((name) => [name, request.headers[name] ?? null])),
    body: Buffer.concat(chunks).toString(),
  });
  response.writeHead(200, { "content-type": "application/json", "x-echo": report }).end(report);
}

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
        response
          .writeHead(Number(url.searchParams.get("status") ?? 302), { location: url.searchParams.get("to") ?? "/" })
          .end("redirect");
        return;
      case "/chain": {
        const n = Number(url.searchParams.get("n"));
        response.writeHead(302, { location: n > 0 ? `/chain?n=${n - 1}` : "/landed?n=0" }).end("chain");
        return;
      }
      case "/loop":
        response.writeHead(302, { location: "/loop" }).end("loop");
        return;
      case "/echo":
        await echo(request, url, response);
        return;
      case "/big": {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(16 * 1024, "x");
        for (let n = Number(url.searchParams.get("kib")) / 16; n > 0; n--) {
          if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
        }
        response.end();
        return;
      }
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
    const n = Number(url.searchParams.get("n"));
    const location =
      url.pathname === "/redirect"
        ? url.searchParams.get("to") ?? "/"
        : url.pathname === "/chain"
          ? n > 0 ? `/chain?n=${n - 1}` : "/ws/close-first?id=chain"
          : null;
    if (location !== null) {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (url.pathname === "/ws/silent" || url.pathname === "/ws/stall") {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(request.headers["sec-websocket-key"])}\r\n\r\n`,
      );
      if (url.pathname === "/ws/stall") socket.pause();
      else socket.on("data", () => {});
      socket.on("close", () => upgraded.delete(socket));
      return;
    }
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
  const echoed = new Set();
  const echoServer = createTcpServer({ allowHalfOpen: true }, (socket) => {
    echoed.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => echoed.delete(socket));
    socket.pipe(socket);
  });
  const close = (instance) =>
    new Promise((resolve) => {
      if (!instance.listening) return resolve();
      for (const socket of upgraded) socket.destroy();
      instance.closeAllConnections();
      instance.close(() => resolve());
    });
  const closeEcho = () =>
    new Promise((resolve) => {
      if (!echoServer.listening) return resolve();
      for (const socket of echoed) socket.destroy();
      echoServer.close(() => resolve());
    });
  const closeAll = () => Promise.all([close(server), close(second), closeEcho()]);
  try {
    const ports = [await listen(server), await listen(second), await listen(echoServer)];
    return { ports, close: closeAll };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
